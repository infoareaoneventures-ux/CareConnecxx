import fs from "node:fs";
import path from "node:path";

// Pre-deploy secrets-presence check (U5/R9): reads functions/.env and reports
// PRESENT/EMPTY per required key. Never prints values — only presence — so
// this is safe to run and paste into a chat or CI log.
//
// The first six keys are launch-required: Evia's agent-loop and Zep memory
// depend on them, and a silently-empty one is exactly the failure mode this
// plan is closing (Anthropic credit exhaustion nobody was alerted to).
// ADMIN_PHONE is the SMS alert destination for U5 — required for loud
// alerting to actually page anyone, but launch does not block on it today,
// so it only warns.
const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LINQ_API_KEY",
  "LINQ_WEBHOOK_SECRET",
  "ZEP_API_KEY",
  "STRIPE_SECRET_KEY",
];
const WARN_ONLY_KEYS = ["ADMIN_PHONE"];

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, "functions", ".env");

function parseEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""); // strip BOM
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    values[key] = value;
  }
  return values;
}

let values;
try {
  values = parseEnvFile(ENV_PATH);
} catch (err) {
  console.error(`check-live-env: could not read ${ENV_PATH}: ${err.message}`);
  process.exit(1);
}

function isEmpty(key) {
  return !values[key] || values[key].length === 0;
}

console.log(`check-live-env: ${ENV_PATH}`);
console.log("");

let hasRequiredMissing = false;
for (const key of REQUIRED_KEYS) {
  const empty = isEmpty(key);
  if (empty) hasRequiredMissing = true;
  console.log(`${empty ? "EMPTY  " : "PRESENT"}  ${key}`);
}

for (const key of WARN_ONLY_KEYS) {
  const empty = isEmpty(key);
  console.log(`${empty ? "EMPTY  " : "PRESENT"}  ${key}${empty ? "  (warn only — not launch-blocking)" : ""}`);
}

console.log("");

const missingWarnOnly = WARN_ONLY_KEYS.filter(isEmpty);
if (missingWarnOnly.length > 0) {
  console.warn(`check-live-env: warning — ${missingWarnOnly.join(", ")} empty; loud alerting cannot SMS the founder until set.`);
}

if (hasRequiredMissing) {
  console.error("check-live-env: FAIL — one or more required keys are empty.");
  process.exit(1);
}

console.log("check-live-env: OK — all required keys present.");
