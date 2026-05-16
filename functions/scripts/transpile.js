// File-by-file transpile using TypeScript's transpileModule API.
// Processes one .ts file at a time — no cross-file analysis, minimal RAM.
// Types are verified separately via tsc --noEmit in CI.
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.resolve(__dirname, "../src");
const LIB_DIR = path.resolve(__dirname, "../lib");

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2017,
  sourceMap: true,
  strict: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  declaration: false,
};

function walkTs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, results);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

const files = walkTs(SRC_DIR);
let ok = 0;
let errors = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(SRC_DIR, file);
  const outJs = path.join(LIB_DIR, rel.replace(/\.ts$/, ".js"));
  const outMap = outJs + ".map";
  const mapFileName = path.basename(outJs) + ".map";

  try {
    const result = ts.transpileModule(source, {
      compilerOptions: { ...compilerOptions, sourceMap: true },
      fileName: file,
    });

    fs.mkdirSync(path.dirname(outJs), { recursive: true });
    fs.writeFileSync(outJs, result.outputText);
    if (result.sourceMapText) {
      fs.writeFileSync(outMap, result.sourceMapText);
    }
    ok++;
  } catch (err) {
    console.error(`FAIL: ${rel} — ${err.message}`);
    errors++;
  }
}

console.log(`Transpiled ${ok} files, ${errors} errors.`);
if (errors > 0) process.exit(1);
