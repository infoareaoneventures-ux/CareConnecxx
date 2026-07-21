#!/usr/bin/env node
/**
 * Additive-only Firestore composite index deployer (KTD14 / R32).
 *
 * Reads the Q1-Q26 composite contracts from firestore.query-contracts.json and
 * creates ONLY the composites that production is missing. It has NO code path
 * that deletes an index or modifies a field override — stale-composite removal
 * and field overrides are a separate, evidence-gated `firebase deploy
 * --only firestore:indexes` step against the full firestore.indexes.json.
 *
 *   node scripts/deploy-firestore-additive-indexes.mjs --project <id>
 *     Dry run (default). Lists live composites via gcloud, diffs against the
 *     contract, and prints the exact `gcloud ... create` commands it WOULD run.
 *
 *   node scripts/deploy-firestore-additive-indexes.mjs --project <id> --apply
 *     Executes those create commands. Already-existing composites are skipped.
 *
 * Requires the gcloud CLI authenticated to the project. Founder-run at the
 * index rollout gate; dependent Functions must wait for every created index to
 * report READY (verify with `gcloud firestore indexes composite list`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// On Windows the Cloud SDK ships gcloud.cmd (no .exe); Node >=18.20/20.12/22
// refuses to spawn .cmd files without shell (CVE-2024-27980 hardening). Args
// here contain no spaces/quotes, so shell interpolation is safe.
const GCLOUD = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
function runGcloud(args, { echo = false } = {}) {
  const res = spawnSync(GCLOUD, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (echo) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  if (res.error) throw res.error;
  return res; // { status, stdout, stderr }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectIdx = args.indexOf('--project');
const PROJECT = projectIdx >= 0 ? args[projectIdx + 1] : process.env.GCLOUD_PROJECT;

if (!PROJECT) {
  console.error('ERROR: --project <id> (or GCLOUD_PROJECT) is required.');
  process.exit(2);
}

const contractsDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firestore.query-contracts.json'), 'utf8')
);

// Only composite contracts are eligible. This script structurally cannot act on
// anything but a "composite" contract create — there is no delete branch.
const composites = contractsDoc.contracts.filter((c) => c.disposition === 'composite');

const signature = (d) =>
  `${d.collectionGroup}|${d.queryScope ?? 'COLLECTION'}|` +
  d.fields
    .map((f) => `${f.fieldPath}:${(f.order ?? 'ASCENDING').toUpperCase()}`)
    .join(',');

// Normalize a gcloud-listed composite into the same signature space. An
// arrayConfig (CONTAINS) field is a different index kind than any ORDER field —
// encode it verbatim so a live CONTAINS index can never alias to (and silently
// satisfy) an ORDER-field contract.
function liveSignature(idx) {
  const scope = idx.queryScope || 'COLLECTION';
  // gcloud's JSON has no top-level collectionGroup property — the collection
  // is embedded in the resource name (projects/.../collectionGroups/{cg}/
  // indexes/{id}). Falling back to undefined made every live signature
  // unmatchable, so the diff reported ALL contracts missing (found 2026-07-21
  // during U3's Q28 deploy; fail closed if neither source yields a name).
  const collectionGroup = idx.collectionGroup
    ?? idx.name?.match(/collectionGroups\/([^/]+)\/indexes\//)?.[1];
  if (!collectionGroup) {
    throw new Error(`Cannot determine collectionGroup for live index: ${idx.name ?? JSON.stringify(idx).slice(0, 200)}`);
  }
  const fields = (idx.fields || [])
    .filter((f) => f.fieldPath !== '__name__')
    .map((f) => `${f.fieldPath}:${(f.order || f.arrayConfig || 'ASCENDING').toUpperCase()}`)
    .join(',');
  return `${collectionGroup}|${scope}|${fields}`;
}

function listLive() {
  try {
    const res = runGcloud(['firestore', 'indexes', 'composite', 'list', `--project=${PROJECT}`, '--format=json']);
    if (res.status !== 0) throw new Error(res.stderr?.trim() || `gcloud exited ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    return new Set(parsed.map(liveSignature));
  } catch (e) {
    console.warn('[warn] Could not list live indexes via gcloud (' + (e?.message ?? e) + ').');
    console.warn('[warn] Proceeding without a live diff; create calls will skip already-existing indexes.');
    return null;
  }
}

function createArgs(c) {
  const a = [
    'firestore', 'indexes', 'composite', 'create',
    `--collection-group=${c.collectionGroup}`,
    `--query-scope=${c.queryScope}`,
    `--project=${PROJECT}`,
  ];
  for (const f of c.fields) {
    if (f.arrayConfig) {
      // No Q1-Q26 contract uses arrayConfig; refuse rather than silently
      // creating a wrong ORDER index for a CONTAINS field.
      throw new Error(`${c.id}: arrayConfig fields are not supported by this script (${f.fieldPath})`);
    }
    const order = (f.order ?? 'ASCENDING').toLowerCase();
    a.push(`--field-config=field-path=${f.fieldPath},order=${order}`);
  }
  return a;
}

const live = listLive();
const toCreate = composites.filter((c) => (live ? !live.has(signature(c)) : true));

console.log(`Project: ${PROJECT}`);
console.log(`Contract composites: ${composites.length}`);
if (live) console.log(`Live composites: ${live.size}`);
console.log(`Missing (to create): ${toCreate.length}`);
console.log(APPLY ? '\nMODE: APPLY\n' : '\nMODE: DRY RUN (pass --apply to execute)\n');

for (const c of toCreate) {
  const a = createArgs(c);
  console.log(`${c.id}  gcloud ${a.join(' ')}`);
  if (APPLY) {
    // stderr is captured (not inherited) so the ALREADY_EXISTS text from gcloud
    // is inspectable — with inherited stdio the skip branch could never fire.
    const res = runGcloud(a, { echo: true });
    if (res.status === 0) {
      console.log(`  created ${c.id}`);
    } else {
      const msg = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
      if (/already.?exists|ALREADY_EXISTS/i.test(msg)) console.log(`  skip ${c.id} (already exists)`);
      else { console.error(`  FAILED ${c.id} (exit ${res.status})`); process.exitCode = 1; }
    }
  }
}

if (!toCreate.length) console.log('Nothing to create — all contract composites already exist live.');
if (!APPLY) console.log('\nDry run complete. Re-run with --apply to create the listed indexes.');
