/**
 * READ/WRITE recovery for Anahi's (uid mmKc9RLJ…) job post for Rosy.
 * The job posted with no coordinates (city-only, no ZIP) and rate flexible/$0,
 * so notifyAreaCaregivers notified nobody. This backfills Santa Clara coords +
 * a real rate, then re-runs the notifier so nearby caregivers finally get it.
 *
 * Usage:
 *   node scripts/recover-anahi-job.mjs           # dry run (prints plan, no writes)
 *   node scripts/recover-anahi-job.mjs --confirm  # apply + notify
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Load functions/.env so the live re-notify path has Linq/SMS creds (the
// deployed functions get these injected; a standalone script does not).
try {
  const envRaw = readFileSync(join(root, 'functions/.env'), 'utf8');
  for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* dry run doesn't need env */ }

// Use the FUNCTIONS workspace's firebase-admin, not the root one: the notify
// step imports functions/lib, whose module graph resolves firebase-admin from
// functions/node_modules — a separate instance. Initializing the default app
// on the root instance leaves the functions instance app-less ("app/no-app"
// at supervisor.js module load). One instance for everything fixes it.
const require = createRequire(import.meta.url);
const admin = require(join(root, 'functions/node_modules/firebase-admin'));
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CONFIRM = process.argv.includes('--confirm');
const uid = 'mmKc9RLJCuYspsztJUAsBrFmWFq1';
// Santa Clara, CA city centroid.
const SC = { lat: 37.3541, lng: -121.9552 };
const RATE = 26; // founder-chosen competitive default

async function run() {
  const ref = db.collection('job_posts').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) { console.log('job_posts/' + uid + ' missing — nothing to recover'); return; }
  const d = snap.data();
  console.log('BEFORE:', JSON.stringify({ lat: d.lat, lng: d.lng, rate: d.rate, rateFlexible: d.rateFlexible, hourlyRate: d.hourlyRate, notifiedCount: d.notifiedCount, city: d.city, status: d.status }, null, 1));

  // job_posts.location is a STRING in the web contract (jobPostContract.ts) —
  // writing an object here crashed the caregiver Job Board via the application
  // snapshot (React #31, 2026-07-15). Coords live in top-level lat/lng only.
  const patch = {
    lat: SC.lat, lng: SC.lng,
    location: 'Santa Clara',
    rate: RATE, rateFlexible: false, hourlyRate: RATE,
  };
  console.log('PATCH:', JSON.stringify(patch));

  if (!CONFIRM) { console.log('\nDRY RUN — pass --confirm to apply + notify.'); return; }

  await ref.set(patch, { merge: true });
  // Mirror rate/coords onto job_postings for web parity (job_posts is the
  // notifier's source; job_postings is the web read model). Read-merge the
  // existing location object so a real zipCode isn't clobbered with '' — we
  // only have city/coords to contribute here.
  // Mirror is best-effort: a failure here must never abort the recovery (the
  // primary patch is already applied; the notify below is the point). If we
  // can't READ the existing location we skip the mirror rather than risk
  // clobbering it with a partial object.
  try {
    const jpRef = db.collection('job_postings').doc(uid);
    const jpSnap = await jpRef.get();
    const existingLoc = (jpSnap.exists ? jpSnap.data().location : null) || {};
    await jpRef.set({
      hourlyRate: RATE,
      location: { ...existingLoc, city: 'Santa Clara', lat: SC.lat, lng: SC.lng },
    }, { merge: true });
  } catch (e) {
    console.warn('job_postings mirror skipped:', e.message);
  }
  console.log('job_posts patched.');

  const fresh = (await ref.get()).data();
  const { notifyAreaCaregivers } = await import('../functions/lib/triggers/jobNotifications.js');
  const count = await notifyAreaCaregivers(uid, fresh, uid);
  console.log(`notifyAreaCaregivers → ${count} caregiver(s) notified.`);
}
run().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
