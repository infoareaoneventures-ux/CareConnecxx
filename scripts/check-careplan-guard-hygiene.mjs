/**
 * READ-ONLY: care-plan follow-up guard hygiene check (plan
 * docs/plans/2026-07-15-001-care-plan-interview-review-fixes-plan.md, U1 step 4).
 *
 * Looks for STRAY MARKER DOCS in job_notifications: docs carrying
 * carePlanUpdateSentAt but missing sentAt — the shape the pre-fix code could
 * mint for application-only caregivers, which wedges notifyFamilyIfAllDeclined.
 * Expected count: ZERO (no interview completion had fired before the fix).
 * Also reports legitimate guard stamps on both collections for visibility.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sa = JSON.parse(readFileSync(join(__dirname, '../functions/serviceAccountKey.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const notifSnap = await db.collection('job_notifications').get();
let strayMarkers = 0, legitGuards = 0, totalNotifs = 0, missingSentAt = 0;
for (const doc of notifSnap.docs) {
  totalNotifs++;
  const d = doc.data();
  if (!d.sentAt) {
    missingSentAt++;
    if (d.carePlanUpdateSentAt) {
      strayMarkers++;
      console.log(`STRAY MARKER: job_notifications/${doc.id} (jobId=${d.jobId ?? '?'}, phone=${d.phone ?? '?'})`);
    } else {
      console.log(`NOTE — no sentAt (not a care-plan marker): job_notifications/${doc.id} keys=[${Object.keys(d).join(', ')}]`);
    }
  } else if (d.carePlanUpdateSentAt) {
    legitGuards++;
  }
}

const appSnap = await db.collection('job_applications').get();
let appGuards = 0;
for (const doc of appSnap.docs) {
  if (doc.data().carePlanUpdateSentAt) appGuards++;
}

console.log('---');
console.log(`job_notifications scanned: ${totalNotifs}`);
console.log(`  stray care-plan markers (carePlanUpdateSentAt, no sentAt): ${strayMarkers} ${strayMarkers === 0 ? '(expected — clean)' : '(UNEXPECTED — needs founder-consented cleanup)'}`);
console.log(`  docs missing sentAt for other reasons: ${missingSentAt - strayMarkers}`);
console.log(`  legitimate follow-up guards on notification docs: ${legitGuards}`);
console.log(`job_applications scanned: ${appSnap.size}; follow-up guards on application docs: ${appGuards}`);
