#!/usr/bin/env node
/**
 * memory_operations.expiresAt ISO-string → Firestore Timestamp migration (U6).
 *
 * Completed memory operations written BEFORE the 2026-07-20 hardening carry
 * expiresAt as an ISO string. Firestore TTL only expires Timestamp fields, and
 * the manual cleanup sweep was removed in the same wave, so unmigrated docs
 * would be retained forever — breaking the 30-day retention contract.
 *
 *   node scripts/migrate-memory-operation-expiry.mjs --project <id>            (dry run)
 *   node scripts/migrate-memory-operation-expiry.mjs --project <id> --apply
 *
 * Scope: ONLY docs with status == "completed" AND a string expiresAt. Failed/
 * unresolved operations keep expiresAt null and must never become expiry-
 * eligible (plan R18) — they are counted but never touched. Idempotent: docs
 * already carrying a Timestamp are classified and skipped.
 *
 * Privacy (R28): output is counts and type-classes only — never doc IDs,
 * fields, or contents.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectIdx = args.indexOf('--project');
const PROJECT = projectIdx >= 0 ? args[projectIdx + 1] : process.env.GCLOUD_PROJECT;

if (!PROJECT) {
  console.error('ERROR: --project <id> (or GCLOUD_PROJECT) is required.');
  process.exit(2);
}

// firebase-admin is CJS — unwrap the ESM default (see audit script).
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
if (!admin.apps?.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const BATCH = 200;

const counts = {
  scanned: 0,
  completedString: 0,   // eligible: completed + ISO string expiresAt
  completedTimestamp: 0, // already migrated
  completedOther: 0,     // completed but null/missing/unexpected type
  notCompleted: 0,       // never touched (R18)
  expiredAlready: 0,     // eligible docs whose horizon already passed
  migrated: 0,
  failed: 0,
};

let cursor = null;
for (;;) {
  let q = db.collection('memory_operations').orderBy('__name__').limit(BATCH);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  if (snap.empty) break;
  cursor = snap.docs[snap.docs.length - 1];

  for (const doc of snap.docs) {
    counts.scanned++;
    const data = doc.data();
    if (data.status !== 'completed') { counts.notCompleted++; continue; }

    const v = data.expiresAt;
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) { counts.completedOther++; continue; }
      counts.completedString++;
      if (ms <= Date.now()) counts.expiredAlready++;
      if (APPLY) {
        try {
          await doc.ref.update({ expiresAt: admin.firestore.Timestamp.fromMillis(ms) });
          counts.migrated++;
        } catch {
          counts.failed++;
        }
      }
    } else if (v && typeof v.toMillis === 'function') {
      counts.completedTimestamp++;
    } else {
      counts.completedOther++;
    }
  }
  if (snap.docs.length < BATCH) break;
}

console.log(`Project: ${PROJECT}`);
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (pass --apply to migrate)');
console.log(JSON.stringify(counts, null, 2));
if (!APPLY && counts.completedString > 0) {
  console.log(`\n${counts.completedString} completed doc(s) need migration (${counts.expiredAlready} already past their horizon — they will be TTL-deleted shortly after migration + policy enablement).`);
}
if (APPLY && counts.failed > 0) process.exitCode = 1;
