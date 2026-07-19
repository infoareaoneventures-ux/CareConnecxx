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
import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve, relative, sep } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "functions", "src");
const INDEX = join(SRC, "index.ts");
const PROJECT = "careconnex-d4c8b";
const PREFIX = "v1"; // firebase.json → functions[0].prefix

// Modules changed by the memory-grounding hardening waves (U1–U9). Any
// deployed export whose transitive import graph touches one of these must be
// redeployed together.
const CHANGED_MODULES = [
  "memory/zepClient",
  "memory/conversationMemory",
  "memory/memoryOperations",
  "memory/learnedFacts",
  "memory/memoryFiles",
  "memory/fingerprintKey",
  "agents/qaAgent",
  "agents/humanHandoff",
  "agents/groundingClaims",
  "agents/contextManagement",
  "agents/profileBriefing",
  "agents/turnMetrics",
  "data/seniorProfileRepository",
  "observability/caraOpsAlerts",
  "linq/routeIntent",
  "linq/webhooks",
  "linq/webChat",
  "scheduled/nightlyMemory",
  "scheduled/memoryOperationWorker",
  "operations/externalSideEffect",
  "mcp/server",
].map((m) => join(SRC, `${m}.ts`));

for (const f of CHANGED_MODULES) {
  if (!existsSync(f)) {
    console.error(`FATAL: changed module not found on disk: ${relative(ROOT, f)}`);
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

/** Strips // line comments and /* block comments so commented-out imports/exports don't count. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
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
  const src = stripComments(sourceOf(file));
  const specs = new Set();
  const patterns = [
    /(?:import|export)\s+[^"'`;]*?from\s*["']([^"']+)["']/g, // import x from / export {x} from / export * from
    /import\s*["']([^"']+)["']/g,                            // side-effect import
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,                  // dynamic import()
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,                 // CommonJS require()
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.add(m[1]);
  }
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
  const src = stripComments(sourceOf(file));
  const names = new Map(); // name -> declaring file
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.set(m[1], file);
  }
  // `export { A, B as C };` (no `from`) — declared elsewhere in this file.
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*(?!\s*from)/g)) {
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0]).trim();
      if (exported && /^[A-Za-z0-9_$]+$/.test(exported) && !/^type$/.test(parts[0].trim())) {
        names.set(exported, file);
      }
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
  const src = stripComments(sourceOf(key));
  // export { A, B as C } from './m'
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveImport(key, m[2]);
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const original = parts[0].trim().replace(/^type\s+/, "");
      const exported = (parts[1] ?? parts[0]).trim();
      if (!exported || !/^[A-Za-z0-9_$]+$/.test(exported)) continue;
      const inner = moduleExports(target, seen).get(original);
      out.set(exported, {
        declFile: inner?.declFile ?? target,
        depFile: key, // the re-exporting module imports the target, graph-wise
      });
    }
  }
  // export * from './m'
  for (const m of src.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveImport(key, m[1]);
    if (!target) continue;
    for (const [name, info] of moduleExports(target, seen)) {
      if (!out.has(name)) out.set(name, info);
    }
  }
  return out;
}

/** Heuristic: does this exported name's declaration build a Cloud Function? */
function isCloudFunctionDeclaration(file, name) {
  const src = sourceOf(file);
  const declRe = new RegExp(`export\\s+const\\s+${name}\\b`);
  const m = declRe.exec(src);
  if (!m) return false; // helpers exported via function/class or plain export lists
  const rest = src.slice(m.index);
  const next = rest.slice(1).search(/\nexport\s/);
  const snippet = next === -1 ? rest : rest.slice(0, next + 1);
  return (
    /\bfunctions\s*(?:\r?\n\s*)?\.\s*(?:https|pubsub|firestore|auth|storage|runWith|region)\b/.test(snippet) ||
    /\.\s*(?:onCall|onRequest|onRun|onWrite|onCreate|onUpdate|onDelete|schedule)\s*\(/.test(snippet)
  );
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
console.log(`Changed shared modules: ${CHANGED_MODULES.length}; deployed exports scanned: ${manifest.length + unaffected.length}`);
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
