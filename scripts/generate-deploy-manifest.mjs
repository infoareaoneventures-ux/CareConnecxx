/**
 * Deployment manifest generator (memory-grounding hardening plan
 * 2026-07-17-002, U9 / R22 / Deployment Gate step 5).
 *
 * Problem it solves: the wave changed SHARED modules (zepClient, qaAgent,
 * conversationMemory, ...). A targeted deploy that updates only the "obvious"
 * functions leaves other live functions running the OLD copy of the shared
 * code baked into their archives — the exact partial-deployment risk the plan
 * calls out. This script statically walks the functions/src import graph
 * (static imports, `export ... from`, `require(...)`, dynamic `import(...)`)
 * and lists EVERY deployed function export whose module graph transitively
 * includes one of the changed modules.
 *
 * Zero new dependencies: node built-ins only. Run from the repo root:
 *
 *   node scripts/generate-deploy-manifest.mjs
 *
 * Output: the function list plus the exact
 *   firebase deploy --only functions:v1.NAME,... --project careconnex-d4c8b
 * command (the firebase.json functions prefix is "v1").
 *
 * Exits non-zero if any of the five plan-required functions (linqWebhook,
 * chatWithCara, consolidateMemoryNightly, memoryOperationWorker,
 * runTriggerEngine) is missing from the manifest — that would mean the graph
 * walk broke, not that the functions are unaffected.
 */
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve, relative, sep } from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "functions", "src");
const INDEX = join(SRC, "index.ts");
const PROJECT = "careconnex-d4c8b";
const PREFIX = "v1"; // firebase.json → functions[0].prefix

const baseArgIndex = process.argv.indexOf("--base");
const DIFF_BASE = baseArgIndex >= 0 ? process.argv[baseArgIndex + 1] : (process.env.DEPLOY_DIFF_BASE ?? "origin/main");
if (!DIFF_BASE || (baseArgIndex >= 0 && !process.argv[baseArgIndex + 1])) {
  console.error("FATAL: --base requires a Git ref.");
  process.exit(1);
}

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

try {
  git(["rev-parse", "--verify", DIFF_BASE]);
} catch {
  console.error(`FATAL: deploy diff base is not available: ${DIFF_BASE}`);
  process.exit(1);
}

function isRuntimeSource(repoPath) {
  const normalized = repoPath.replace(/\\/g, "/");
  return normalized.startsWith("functions/src/") &&
    normalized.endsWith(".ts") &&
    !normalized.endsWith(".test.ts") &&
    !normalized.endsWith(".d.ts") &&
    !normalized.includes("/__tests__/");
}

function lines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

// Deploys ship the working tree. Include committed branch changes plus staged,
// unstaged, and untracked runtime sources so the manifest cannot silently omit
// code that Firebase will package.
const changedRepoPaths = new Set([
  ...lines(git(["diff", "--name-only", "--diff-filter=ACMRTUXB", `${DIFF_BASE}...HEAD`, "--", "functions/src"])),
  ...lines(git(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--", "functions/src"])),
  ...lines(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "--", "functions/src"])),
  ...lines(git(["ls-files", "--others", "--exclude-standard", "--", "functions/src"])),
]);
const CHANGED_MODULES = [...changedRepoPaths]
  .filter(isRuntimeSource)
  .map((repoPath) => resolve(ROOT, repoPath));

if (CHANGED_MODULES.length === 0) {
  console.error(`FATAL: no changed Functions runtime modules found against ${DIFF_BASE}.`);
  process.exit(1);
}

for (const file of CHANGED_MODULES) {
  if (!existsSync(file)) {
    console.error(`FATAL: changed module not found on disk: ${relative(ROOT, file)}`);
    process.exit(1);
  }
}
const CHANGED_SET = new Set(CHANGED_MODULES.map((f) => resolve(f)));

// Functions the plan's Deployment Gate names explicitly — the manifest MUST
// contain them or the walk is broken.
const REQUIRED = [
  "linqWebhook",
  "chatWithCara",
  "consolidateMemoryNightly",
  "memoryOperationWorker",
  "runTriggerEngine",
];

const FINGERPRINT_BOUND_EXPORTS = [
  { name: "chatWithCara", file: INDEX },
  { name: "linqWebhook", file: join(SRC, "linq", "webhooks.ts") },
];

// ── Source helpers ────────────────────────────────────────────────────────────

const sourceCache = new Map();
function sourceOf(file) {
  let src = sourceCache.get(file);
  if (src === undefined) {
    src = readFileSync(file, "utf8");
    sourceCache.set(file, src);
  }
  return src;
}

const astCache = new Map();
function astOf(file) {
  let sourceFile = astCache.get(file);
  if (!sourceFile) {
    sourceFile = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    astCache.set(file, sourceFile);
  }
  return sourceFile;
}

function exportBindsFingerprintSecret(file, exportName) {
  let bindsSecret = false;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exportName) {
      const initializer = node.initializer;
      if (initializer && /MEMORY_FINGERPRINT_KEY_(?:SECRET|NAME)/.test(initializer.getText(astOf(file)))) {
        bindsSecret = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(astOf(file));
  return bindsSecret;
}

for (const { name, file } of FINGERPRINT_BOUND_EXPORTS) {
  if (!exportBindsFingerprintSecret(file, name)) {
    console.error(`FATAL: ${relative(ROOT, file)} export ${name} must bind MEMORY_FINGERPRINT_KEY.`);
    process.exit(1);
  }
}

/** Resolves a relative import specifier from a file to an on-disk .ts module. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // package import — not part of the src graph
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.endsWith(".ts") ? base : null,
    `${base}.ts`,
    base.replace(/\.js$/, ".ts"),
    join(base, "index.ts"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

const importsCache = new Map();
/** All resolved relative-module dependencies of a file (static + export-from + require + dynamic import). */
function importsOf(file) {
  let deps = importsCache.get(file);
  if (deps) return deps;
  const specs = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) &&
               ts.isExternalModuleReference(node.moduleReference) &&
               node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specs.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) &&
               (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg)) {
        throw new Error(`non-literal import/require in ${relative(ROOT, file)}:${astOf(file).getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      specs.add(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(astOf(file));
  deps = new Set();
  for (const spec of specs) {
    const r = resolveImport(file, spec);
    if (r) deps.add(r);
  }
  importsCache.set(file, deps);
  return deps;
}

const touchesCache = new Map();
/** Whether a module's transitive graph (including itself) reaches a changed module. */
function touchesChanged(entry) {
  const key = resolve(entry);
  if (touchesCache.has(key)) return touchesCache.get(key);
  const visited = new Set();
  const stack = [key];
  let hit = false;
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (CHANGED_SET.has(file)) { hit = true; break; }
    for (const dep of importsOf(file)) stack.push(dep);
  }
  touchesCache.set(key, hit);
  return hit;
}

// ── Export enumeration ────────────────────────────────────────────────────────

/**
 * Enumerates exported VALUE names declared in a module (not re-exports):
 * `export const/function/class NAME` plus local `export { A, B }` lists.
 */
function localExportNames(file) {
  const names = new Map(); // name -> declaring file
  const hasExport = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of astOf(file).statements) {
    if (hasExport(statement) && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, file);
      }
    } else if (hasExport(statement) &&
               (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.set(statement.name.text, file);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
               statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.set(element.name.text, file);
    }
  }
  return names;
}

/**
 * Full export surface of a module including re-exports. Returns Map of
 * exported name -> { declFile (where the declaration text lives), depFile
 * (module whose graph carries the dependency) }.
 */
function moduleExports(file, seen = new Set()) {
  const key = resolve(file);
  if (seen.has(key)) return new Map();
  seen.add(key);
  const out = new Map();
  for (const [name, decl] of localExportNames(key)) {
    out.set(name, { declFile: decl, depFile: key });
  }
  for (const statement of astOf(key).statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const target = resolveImport(key, statement.moduleSpecifier.text);
    if (!target) continue;
    const targetExports = moduleExports(target, new Set(seen));
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const original = (element.propertyName ?? element.name).text;
        const inner = targetExports.get(original);
        out.set(element.name.text, { declFile: inner?.declFile ?? target, depFile: key });
      }
    } else if (!statement.exportClause) {
      for (const [name, info] of targetExports) if (!out.has(name)) out.set(name, info);
    }
  }
  return out;
}

/** Heuristic: does this exported name's declaration build a Cloud Function? */
function isCloudFunctionDeclaration(file, name) {
  for (const statement of astOf(file).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (!declaration?.initializer) continue;
    const snippet = declaration.initializer.getText(astOf(file));
    return /\bfunctions\s*\.\s*(?:https|pubsub|firestore|auth|storage|runWith|region)\b/.test(snippet) ||
      /\.\s*(?:onCall|onRequest|onRun|onWrite|onCreate|onUpdate|onDelete|schedule)\s*\(/.test(snippet);
  }
  return false;
}

// ── Walk the deploy entrypoint ────────────────────────────────────────────────

const allExports = moduleExports(INDEX);
const manifest = [];
const unaffected = [];

for (const [name, { declFile, depFile }] of [...allExports.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!isCloudFunctionDeclaration(declFile, name)) continue; // helper/type/constant export
  const affected = touchesChanged(depFile) || touchesChanged(declFile);
  if (affected) {
    manifest.push({ name, via: relative(ROOT, declFile).split(sep).join("/") });
  } else {
    unaffected.push(name);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log("Deployment manifest — memory-grounding hardening (plan 2026-07-17-002)");
console.log(`Diff base: ${DIFF_BASE}; changed runtime modules: ${CHANGED_MODULES.length}; deployed exports scanned: ${manifest.length + unaffected.length}`);
console.log("");
console.log(`AFFECTED functions (${manifest.length}) — deploy ALL of these together:`);
for (const { name, via } of manifest) {
  console.log(`  ${PREFIX}.${name}  (${via})`);
}
console.log("");
console.log(`Unaffected deployed exports (${unaffected.length}): ${unaffected.join(", ") || "(none)"}`);
console.log("");

const missing = REQUIRED.filter((r) => !manifest.some((m) => m.name === r));
if (missing.length) {
  console.error(`FATAL: required function(s) missing from manifest: ${missing.join(", ")}`);
  console.error("The import-graph walk is broken — do NOT deploy from this manifest.");
  process.exit(1);
}

const targets = manifest.map((m) => `functions:${PREFIX}.${m.name}`).join(",");
console.log("Deploy command (from the repo root — the sole deploy folder):");
console.log("");
console.log(`  node_modules/.bin/firebase deploy --only "${targets}" --project ${PROJECT}`);
console.log("");
console.log("Reminder: set FUNCTIONS_DISCOVERY_TIMEOUT (plain seconds, e.g. 120) — see docs/runbooks/evia-memory-rollout.md.");
