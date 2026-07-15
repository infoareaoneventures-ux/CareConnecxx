/**
 * Repair object-shaped location fields that crash the webapp (React #31,
 * found live 2026-07-15 on /caregiver/jobs).
 *
 *   - job_applications.jobLocation: object -> "city, state, zip" string
 *   - job_posts.location:           object -> "city, state, zip" string (web contract)
 *   - caregivers.location:          object -> city string (or delete when no city)
 *
 * Coords are untouched — they live in top-level lat/lng/latitude/longitude.
 * Dry run by default; pass --confirm to apply. Prints BEFORE values for every doc.
 *
 * Usage:
 *   node scripts/repair-object-locations.mjs            # dry run
 *   node scripts/repair-object-locations.mjs --confirm  # apply
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(join(root, 'functions', 'package.json'));
const admin = require('firebase-admin');
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const CONFIRM = process.argv.includes('--confirm');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = (loc, fallbackCity) => {
  const s = [loc.city ?? fallbackCity, loc.state, loc.zipCode]
    .filter(p => typeof p === 'string' && p.length > 0).join(', ');
  return s || (typeof fallbackCity === 'string' && fallbackCity) || null;
};

let planned = 0;
async function sweep(coll, field, makeValue) {
  const snap = await db.collection(coll).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!isObj(d[field])) continue;
    const next = makeValue(d);
    console.log(`${CONFIRM ? 'PATCH' : 'WOULD PATCH'} ${coll}/${doc.id}`);
    console.log(`  BEFORE ${field}: ${JSON.stringify(d[field])}`);
    console.log(`  AFTER  ${field}: ${JSON.stringify(next)}`);
    planned++;
    if (CONFIRM) {
      await doc.ref.update({ [field]: next === null ? admin.firestore.FieldValue.delete() : next });
    }
  }
}

await sweep('job_applications', 'jobLocation', d => label(d.jobLocation, d.jobCity));
await sweep('job_posts', 'location', d => label(d.location, d.city));
await sweep('caregivers', 'location', d => {
  const city = d.location.city ?? d.city;
  return (typeof city === 'string' && city) ? city : null; // null -> delete field
});

console.log(`\n${CONFIRM ? 'Applied' : 'Dry run'} — ${planned} doc(s) ${CONFIRM ? 'patched' : 'would be patched'}.${CONFIRM ? '' : ' Pass --confirm to apply.'}`);
process.exit(0);
