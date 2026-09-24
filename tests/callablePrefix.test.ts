import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Static guard: every Firebase callable invoked from the frontend MUST use the
 * deployed "v1-" prefixed name (firebase.json functions config has "prefix": "v1",
 * so an export `foo` is deployed as `v1-foo`). Calling the bare export name fails
 * at runtime with functions/not-found.
 *
 * This test scans frontend source for httpsCallable() calls with string-literal
 * function names and asserts every name starts with "v1-".
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['components', 'services', 'lib', 'hooks', 'utils'];
const EXTENSIONS = ['.ts', '.tsx'];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (
      EXTENSIONS.includes(path.extname(entry.name)) &&
      !/\.test\.|\.spec\./.test(entry.name)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Drop comment-only lines so commented-out legacy snippets don't trip the guard. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

interface CallableUsage {
  file: string;
  name: string;
}

// Two-arg form: httpsCallable(functions, 'name') / httpsCallable(getFunctions(app), 'name')
// — optionally with generic type params, which may span multiple lines.
// Only single/double-quoted literals are matched (no backticks): template
// literals may contain ${...} interpolation, which this static guard cannot
// resolve — callable names must be plain string literals.
const TWO_ARG_RE =
  /httpsCallable\s*(?:<[\s\S]*?>)?\s*\(\s*[\w$.]+(?:\([^)]*\))?\s*,\s*['"]([^'"]+)['"]/g;
// Single-arg form: functions.httpsCallable('name')
const SINGLE_ARG_RE = /httpsCallable\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([^'"]+)['"]/g;

function findCallableUsages(): CallableUsage[] {
  const usages: CallableUsage[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(path.join(ROOT, dir))) {
      const source = stripCommentLines(fs.readFileSync(file, 'utf8'));
      const relPath = path.relative(ROOT, file).split(path.sep).join('/');
      for (const re of [TWO_ARG_RE, SINGLE_ARG_RE]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(source)) !== null) {
          usages.push({ file: relPath, name: match[1] });
        }
      }
    }
  }
  return usages;
}

describe('Firebase callable v1- prefix contract', () => {
  const usages = findCallableUsages();

  it('finds httpsCallable call sites (scanner sanity check)', () => {
    // If this fails the regexes or scan dirs broke — the guard would be useless.
    expect(usages.length).toBeGreaterThan(30);
  });

  it('detects known call sites, including generic and getFunctions() inline forms', () => {
    const byName = (name: string) => usages.some((u) => u.name === name);
    expect(byName('v1-aiProxy')).toBe(true); // multiline generic form (services/ai.ts)
    expect(byName('v1-triggerFamilyEmergency')).toBe(true); // inline getFunctions() (components/client/FamilyEmergency.tsx)
    expect(byName('v1-addFamilyGroupMember')).toBe(true); // components/pages/JoinFamilyPage.tsx
  });

  it('intentionally ignores template-literal names (cannot be statically verified)', () => {
    const sample = [
      'httpsCallable(functions, `v1-${name}`);',
      'functions.httpsCallable(`v1-${name}`);',
      "httpsCallable(getFunctions(app), 'v1-real');",
    ].join('\n');
    const matches: string[] = [];
    for (const re of [TWO_ARG_RE, SINGLE_ARG_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sample)) !== null) matches.push(m[1]);
    }
    expect(matches).toEqual(['v1-real']);
  });

  it('every httpsCallable string-literal function name starts with "v1-"', () => {
    const offenders = usages.filter((u) => !u.name.startsWith('v1-'));
    const message =
      'Callable names missing the "v1-" deploy prefix (firebase.json functions prefix):\n' +
      offenders.map((o) => `  ${o.file} → "${o.name}"`).join('\n');
    expect(offenders, message).toEqual([]);
  });
});
