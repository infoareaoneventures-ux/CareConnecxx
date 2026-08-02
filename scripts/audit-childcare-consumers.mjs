#!/usr/bin/env node
/**
 * Childcare consumer-manifest auditor (plan 2026-07-22-002, U0).
 *
 *   node scripts/audit-childcare-consumers.mjs        (npm run audit:childcare-consumers)
 *
 * Local, no cloud credentials. Scans functions/src, services, components, and
 * hooks for string-literal references to the shared collections (e.g.
 * collection('appointments'), db.collection("chatRooms"), doc(db, 'users', id))
 * and FAILS with a listed diff when a consuming file is not registered in
 * functions/src/data/childcareConsumerManifest.ts. This is the mechanical half
 * of the System-Wide Consumer Rule: zero UNCLASSIFIED consumers of shared
 * collections before childcare enablement.
 *
 * Both the shared-collection list (SHARED_VERTICAL_COLLECTIONS) and the
 * registered files (sourceFile: "...") are parsed out of the manifest module
 * itself, so the scanner can never drift from the manifest.
 *
 * The matcher is deliberately pragmatic:
 *   • Only collection()/collectionGroup()/doc() call sites with a literal
 *     collection name count — firestore.rules paths, type files, docs, and
 *     plain strings elsewhere do not.
 *   • Tests (*.test.*, __tests__/, __stubs__/, *.d.ts) are excluded: they are
 *     characterization fixtures, not production consumers.
 *   • ALLOWLIST below documents accepted false positives.
 *
 * Exit 0 = clean, exit 1 = unregistered consumers listed, exit 2 = setup error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MANIFEST_PATH = path.join(ROOT, 'functions', 'src', 'data', 'childcareConsumerManifest.ts');

// Directories scanned for consumers (repo-relative).
const SCAN_DIRS = ['functions/src', 'services', 'components', 'hooks'];

// WELL-COMMENTED allowlist for scanner false positives. Add a file here ONLY
// when it matches the literal pattern but is genuinely not a shared-collection
// consumer (and say why). Registered consumers belong in the manifest, not here.
const ALLOWLIST = new Set([
  // (empty at U0 — tests/type files/docs are already excluded by the walker,
  //  and every real consumer found by the scan is registered in the manifest.
  //  Example entry:
  //  'functions/src/foo/bar.ts', // string constant only; never queries Firestore
]);

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

if (!fs.existsSync(MANIFEST_PATH)) fail(`[audit] manifest not found: ${MANIFEST_PATH}`);
const manifestSrc = fs.readFileSync(MANIFEST_PATH, 'utf8');

// Parse SHARED_VERTICAL_COLLECTIONS out of the manifest module.
const collBlock = manifestSrc.match(/SHARED_VERTICAL_COLLECTIONS[^=]*=\s*\[([\s\S]*?)\]/);
if (!collBlock) fail('[audit] could not parse SHARED_VERTICAL_COLLECTIONS from the manifest.');
const collections = [...collBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (collections.length === 0) fail('[audit] SHARED_VERTICAL_COLLECTIONS parsed empty.');

// Parse registered sourceFile entries out of the manifest module.
const registered = new Set(
  [...manifestSrc.matchAll(/sourceFile:\s*"([^"]+)"/g)].map((m) => m[1])
);
if (registered.size === 0) fail('[audit] no sourceFile entries parsed from the manifest.');

// collection('name') | collectionGroup("name") | doc(db, 'name', ...) —
// optional leading receiver argument covers both the Admin SDK
// (db.collection("users")) and the modular web SDK (collection(db, "users")).
const nameAlt = collections.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const QUOTE = '[\'"`]'; // single, double, or backtick quote around the literal
const CONSUMER_RE = new RegExp(
  '\\b(?:collection|collectionGroup|doc)\\s*\\(\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?' +
    QUOTE + '(' + nameAlt + ')' + QUOTE,
  'g'
);

const SKIP_DIR = new Set(['node_modules', 'lib', 'dist', '__tests__', '__stubs__', '__mocks__', 'e2e']);
const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.endsWith('.d.ts');
const isSource = (f) => /\.[cm]?[jt]sx?$/.test(f);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      yield* walk(p);
    } else if (entry.isFile() && isSource(entry.name) && !isTestFile(entry.name)) {
      yield p;
    }
  }
}

const violations = [];
const conversationPartitionViolations = [];
let scanned = 0;
let consumers = 0;

for (const dirRel of SCAN_DIRS) {
  const dir = path.join(ROOT, dirRel);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    scanned++;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const hits = new Set();
    let m;
    CONSUMER_RE.lastIndex = 0;
    while ((m = CONSUMER_RE.exec(src)) !== null) hits.add(m[1]);
    if (hits.size === 0) continue;
    consumers++;
    if (
      hits.has('agent_conversations')
      && !/deriveConversationPartitionId|conversationPartitionIdsForRead|careVerticalFromConversationPartitionId/.test(src)
    ) {
      conversationPartitionViolations.push(rel);
    }
    if (registered.has(rel) || ALLOWLIST.has(rel)) continue;
    violations.push({ file: rel, collections: [...hits].sort() });
  }
}

console.log(
  `[audit] scanned ${scanned} files across ${SCAN_DIRS.join(', ')} — ` +
  `${consumers} shared-collection consumers, ${registered.size} manifest registrations, ` +
  `${collections.length} watched collections`
);

if (violations.length || conversationPartitionViolations.length) {
  if (conversationPartitionViolations.length) {
    console.error(
      `[audit] FAIL — ${conversationPartitionViolations.length} direct agent_conversations consumer(s) ` +
      'do not use the versioned vertical partition helpers:'
    );
    for (const file of conversationPartitionViolations) console.error(`  ${file}`);
  }
  if (!violations.length) process.exit(1);
  console.error(`[audit] FAIL — ${violations.length} consumer(s) touch shared collections but are NOT in the manifest:`);
  for (const v of violations) {
    console.error(`  ${v.file}  →  ${v.collections.join(', ')}`);
  }
  console.error(
    '[audit] Register each file in functions/src/data/childcareConsumerManifest.ts with a\n' +
    '        disposition + owner unit (or, for a genuine false positive, add it to the\n' +
    '        ALLOWLIST in this script with a comment).'
  );
  process.exit(1);
}

console.log('[audit] PASS — every shared-collection consumer is registered in the manifest.');
process.exit(0);
