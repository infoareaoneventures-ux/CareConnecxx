#!/usr/bin/env node
/**
 * One-off backfill for job_posts.applicantCount.
 *
 * Counts every non-withdrawn doc in job_applications, groups by jobId,
 * and writes applicantCount onto the matching job_posts doc.
 *
 * Usage:
 *   node scripts/backfill-applicant-count.mjs             # dry run (default)
 *   node scripts/backfill-applicant-count.mjs --execute   # actually write
 *
 * Requires admin credentials:
 *   gcloud auth application-default login
 *   # or: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Must match functions/src/triggers/jobApplicationTriggers.ts COUNTED_STATUSES
const COUNTED_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const BATCH_SIZE = 500; // Firestore limit

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const DRY_RUN = !EXECUTE;

function log(...parts) { console.log(...parts); }

async function main() {
  initializeApp({ projectId: 'careconnex-d4c8b' });
  const db = getFirestore();

  log(`\n=== applicantCount backfill ===`);
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'EXECUTE (writes will happen)'}`);
  log('');

  // 1. Read all applications in one shot.
  log('Reading job_applications…');
  const appsSnap = await db.collection('job_applications').get();
  log(`  ${appsSnap.size} application docs total`);

  // 2. Group by jobId, counting only applications with a counted status.
  const countByJobId = new Map();
  let countedApps = 0;
  let withdrawnApps = 0;
  let missingJobId = 0;

  appsSnap.forEach((doc) => {
    const data = doc.data();
    if (!data.jobId) { missingJobId += 1; return; }
    if (!COUNTED_STATUSES.has(data.status)) {
      if (data.status === 'withdrawn') withdrawnApps += 1;
      return;
    }
    countedApps += 1;
    countByJobId.set(data.jobId, (countByJobId.get(data.jobId) || 0) + 1);
  });

  log(`  ${countedApps} counted, ${withdrawnApps} withdrawn, ${missingJobId} missing jobId`);
  log(`  ${countByJobId.size} unique jobIds referenced`);
  log('');

  // 3. Load the referenced job_posts to detect orphans and skip no-ops.
  log('Reading referenced job_posts…');
  const jobIds = Array.from(countByJobId.keys());
  const jobsByDocId = new Map();
  const CHUNK = 30; // Firestore `in` query max is 30 when using documentId()
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const chunk = jobIds.slice(i, i + CHUNK);
    // Use parallel get() calls — simpler than building an `in` query on documentId.
    const docs = await Promise.all(chunk.map((id) => db.collection('job_posts').doc(id).get()));
    docs.forEach((snap, idx) => {
      if (snap.exists) jobsByDocId.set(chunk[idx], snap.data());
    });
  }
  log(`  ${jobsByDocId.size} job_posts found (of ${jobIds.length} referenced)`);

  // 4. Build the write list: only update when count differs from what's already there.
  const plannedWrites = [];
  const orphans = [];
  for (const [jobId, newCount] of countByJobId) {
    const jobData = jobsByDocId.get(jobId);
    if (!jobData) {
      orphans.push(jobId);
      continue;
    }
    const current = typeof jobData.applicantCount === 'number' ? jobData.applicantCount : undefined;
    if (current === newCount) continue; // already correct
    plannedWrites.push({ jobId, from: current, to: newCount });
  }

  log('');
  log(`${plannedWrites.length} job_posts need updating.`);
  log(`${orphans.length} orphan jobIds (applications reference a deleted job_post).`);
  log('');

  if (plannedWrites.length > 0) {
    log('First up to 20 planned writes (jobId: current → new):');
    plannedWrites.slice(0, 20).forEach((w) => {
      const fromLabel = w.from === undefined ? '(unset)' : String(w.from);
      log(`  ${w.jobId}: ${fromLabel} → ${w.to}`);
    });
    if (plannedWrites.length > 20) log(`  …and ${plannedWrites.length - 20} more`);
    log('');
  }
  if (orphans.length > 0) {
    log('First up to 10 orphan jobIds:');
    orphans.slice(0, 10).forEach((id) => log(`  ${id}`));
    if (orphans.length > 10) log(`  …and ${orphans.length - 10} more`);
    log('');
  }

  if (DRY_RUN) {
    log('Dry run complete. Re-run with --execute to apply these writes.');
    return;
  }

  // 5. Commit writes in batches of 500.
  log('Writing…');
  let written = 0;
  for (let i = 0; i < plannedWrites.length; i += BATCH_SIZE) {
    const chunk = plannedWrites.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach((w) => {
      batch.update(db.collection('job_posts').doc(w.jobId), { applicantCount: w.to });
    });
    await batch.commit();
    written += chunk.length;
    log(`  ${written}/${plannedWrites.length}`);
  }

  log('');
  log(`Done. ${written} job_posts updated.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nBackfill failed:', err);
    process.exit(1);
  });
