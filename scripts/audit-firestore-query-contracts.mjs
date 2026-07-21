#!/usr/bin/env node
/**
 * Firestore query-contract auditor.
 *
 * Two modes:
 *
 *   node scripts/audit-firestore-query-contracts.mjs            (default: --check)
 *     Local, no cloud credentials. Validates that firestore.query-contracts.json
 *     and firestore.indexes.json agree: every "composite" contract has a
 *     matching local index, and no duplicate composites exist. Exit 0/1.
 *
 *   node scripts/audit-firestore-query-contracts.mjs --live --project <id>
 *     Read-only production planner probe. Executes each contract as a limit(1)
 *     query with placeholder filter values, discards all returned data, and
 *     prints ONLY contract id, collection, and PASS/FAIL(failed-precondition).
 *     Requires firebase-admin + application-default credentials. Founder-run at
 *     the deployment gate (R4). Never prints document contents (R28).
 *
 * Privacy: --live prints contract ids, collection names, query scope, and the
 * Firebase error CODE only. It never serializes returned documents, field
 * values, or ids.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const projectIdx = args.indexOf('--project');
const PROJECT = projectIdx >= 0 ? args[projectIdx + 1] : process.env.GCLOUD_PROJECT;
// Synthetic parent doc id used for subcollection (COLLECTION-scope on a nested
// group) planner probes so we never touch a real user's data.
const SYNTHETIC_PARENT = 'codex-index-audit';

const contractsDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firestore.query-contracts.json'), 'utf8')
);
const indexesDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')
);

const signature = (d) =>
  `${d.collectionGroup}|${d.queryScope ?? 'COLLECTION'}|` +
  d.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? 'ASCENDING'}`).join(',');

function runCheck() {
  const indexSigs = indexesDoc.indexes.map(signature);
  const indexSet = new Set(indexSigs);

  const missing = [];
  for (const c of contractsDoc.contracts) {
    if (c.disposition !== 'composite') continue;
    if (!indexSet.has(signature(c))) {
      missing.push(
        `${c.id}: no local index for ${c.collectionGroup} [${c.fields
          .map((f) => `${f.fieldPath} ${f.order ?? 'ASCENDING'}`)
          .join(', ')}]`
      );
    }
  }

  const seen = new Set();
  const dupes = [];
  for (const sig of indexSigs) {
    if (seen.has(sig)) dupes.push(sig);
    seen.add(sig);
  }

  const composites = contractsDoc.contracts.filter((c) => c.disposition === 'composite');
  console.log(`[check] ${composites.length} composite contracts, ${indexesDoc.indexes.length} local composites`);
  if (missing.length) {
    console.error(`[check] FAIL — ${missing.length} contract(s) lack a local index:`);
    missing.forEach((m) => console.error('  ' + m));
  }
  if (dupes.length) {
    console.error(`[check] FAIL — ${dupes.length} duplicate composite(s):`);
    dupes.forEach((d) => console.error('  ' + d));
  }
  if (!missing.length && !dupes.length) {
    console.log('[check] PASS — every composite contract has exactly one local index.');
    return 0;
  }
  return 1;
}

async function runLive() {
  if (!PROJECT) {
    console.error('[live] --project <id> (or GCLOUD_PROJECT) is required.');
    return 2;
  }
  let admin;
  try {
    // firebase-admin is CJS; a bare ESM namespace import exposes only { default }
    // (cjs-module-lexer cannot hoist its exports), so unwrap the default.
    const adminMod = await import('firebase-admin');
    admin = adminMod.default ?? adminMod;
  } catch {
    console.error('[live] firebase-admin is not installed at repo root. Run from functions/ or install it.');
    return 2;
  }
  if (typeof admin.initializeApp !== 'function' || typeof admin.firestore !== 'function') {
    console.error('[live] firebase-admin loaded but has an unexpected shape (no initializeApp/firestore).');
    return 2;
  }
  if (!admin.apps?.length) {
    admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore();

  // Placeholder equality value by field name. Values are never stored or read
  // back; they exist only so the planner can resolve an index. limit(1) keeps
  // the probe cheap; we discard the snapshot without touching .data().
  const placeholder = (fieldPath) => {
    if (/(^|[A-Z])(isRead|optedOut)/.test(fieldPath) || fieldPath === 'isRead' || fieldPath === 'optedOut') return false;
    return '__codex_index_audit__';
  };

  let pass = 0;
  let fail = 0;
  for (const c of contractsDoc.contracts) {
    if (c.disposition !== 'composite') continue;
    try {
      let ref;
      if (c.collectionGroup === 'notifications') {
        // Subcollection under users/{uid}; synthetic parent avoids real data.
        ref = db.collection('users').doc(SYNTHETIC_PARENT).collection('notifications');
      } else {
        ref = db.collection(c.collectionGroup);
      }
      let q = ref;
      const last = c.fields[c.fields.length - 1];
      for (const f of c.fields) {
        if (f === last && f.order) {
          // Final field: orderBy alone — equality wheres + an orderBy on the
          // last field demand exactly the same composite the runtime query does
          // (an added range operand would not change the required index).
          q = q.orderBy(f.fieldPath, f.order === 'DESCENDING' ? 'desc' : 'asc');
        } else {
          q = q.where(f.fieldPath, '==', placeholder(f.fieldPath));
        }
      }
      await q.limit(1).get(); // snapshot discarded — never read .data()
      console.log(`  PASS ${c.id} ${c.collectionGroup} (${c.queryScope})`);
      pass++;
    } catch (e) {
      const code = e?.code ?? e?.status ?? 'unknown';
      console.error(`  FAIL ${c.id} ${c.collectionGroup} (${c.queryScope}) code=${code}`);
      fail++;
    }
  }
  console.log(`\n[live] ${pass} passed, ${fail} failed against project ${PROJECT}`);
  return fail === 0 ? 0 : 1;
}

const code = LIVE ? await runLive() : runCheck();
process.exit(code);
