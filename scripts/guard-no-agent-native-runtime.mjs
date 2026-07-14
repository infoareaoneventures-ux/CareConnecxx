import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FORBIDDEN = new Set(["@agent-native/core", "agentnative"]);

function readJson(relPath) {
  const fullPath = path.join(ROOT, relPath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function collectDeps(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
}

const packageFiles = ["package.json", "functions/package.json"];
const violations = [];

for (const relPath of packageFiles) {
  const deps = collectDeps(readJson(relPath));
  for (const name of Object.keys(deps)) {
    if (FORBIDDEN.has(name)) {
      violations.push(`${relPath}: ${name}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Full Agent-Native runtime dependencies are not allowed in this launch slice:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Agent-Native runtime guard passed.");
