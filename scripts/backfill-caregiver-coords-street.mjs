/**
 * Street-level backfill for caregiver coordinates (2026-10-11).
 *
 * Before 2026-10-11 Evia's text onboarding geocoded a caregiver's ZIP (and
 * the site only sometimes the street), so many caregivers/{uid} docs carry a
 * ZIP/city centroid. The trigger (functions/src/triggers/caregiverGeocode.ts)
 * now owns coords and geocodes the street on every address change, stamping
 * `geoPrecision`. This script brings the EXISTING records up to that rule:
 *
 *   - target: every caregiver with a street whose geoPrecision !== 'street'
 *     (missing marker = legacy ZIP-level or unknown), plus any doc with NO
 *     coords at all (ZIP fallback, marked 'zip');
 *   - geocoder: the same Nominatim query the server builds
 *     ("street, city, state, zip", countrycodes=us) — one geocoder;
 *   - writes lat/lng + latitude/longitude + geoPrecision (merge). The trigger
 *     sees no address change and coords present → no re-geocode, no loop.
 *
 * Nominatim's usage policy is 1 request/second — the loop sleeps between calls.
 *
 * Usage:
 *   node scripts/backfill-caregiver-coords-street.mjs                # dry run
 *   node scripts/backfill-caregiver-coords-street.mjs --confirm      # apply
 *   node scripts/backfill-caregiver-coords-street.mjs --limit 20     # first N candidates only
 *   node scripts/backfill-caregiver-coords-street.mjs --uid <uid>    # one record
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const admin = require(join(root, 'functions/node_modules/firebase-admin'));
const axios = require(join(root, 'functions/node_modules/axios'));
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const ONLY_UID = args.includes('--uid') ? args[args.indexOf('--uid') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same query/headers as functions/src/utils/geocode.ts geocodeStreetAddress.
async function nominatimStreet(street, city, state, zip) {
  const q = [street, city, state, zip].filter(Boolean).join(', ');
  if (!q) return null;
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 1, countrycodes: 'us' },
      headers: { 'Accept-Language': 'en', 'User-Agent': 'Evia/1.0 (eviacares.com)' },
      timeout: 6000,
    });
    const p = r.data?.[0];
    if (p?.lat && p?.lon) return { lat: parseFloat(p.lat), lng: parseFloat(p.lon) };
  } catch {}
  return null;
}
async function zipCentroid(zip) {
  if (!zip || String(zip).length < 5) return null;
  try {
    const r = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 5000 });
    const p = r.data?.places?.[0];
    if (p?.latitude && p?.longitude) return { lat: parseFloat(p.latitude), lng: parseFloat(p.longitude) };
  } catch {}
  return null;
}

const coordsOf = (d) => {
  const lat = d.latitude ?? d.lat;
  const lng = d.longitude ?? d.lng;
  return (typeof lat === 'number' && typeof lng === 'number') ? { lat, lng } : null;
};

const snap = ONLY_UID
  ? { docs: [await db.collection('caregivers').doc(ONLY_UID).get()].filter((d) => d.exists) }
  : await db.collection('caregivers').get();

let candidates = 0, patched = 0, skippedStreet = 0, skippedNoAddress = 0, failed = 0;
for (const doc of snap.docs) {
  if (candidates >= LIMIT) break;
  const d = doc.data();
  const street = String(d.street ?? '').trim();
  const city   = String(d.city ?? '').trim();
  const state  = String(d.state ?? '').trim();
  const zip    = String(d.zipCode ?? d.zip ?? '').trim();
  const have   = coordsOf(d);

  if (d.geoPrecision === 'street' && have) { skippedStreet++; continue; }
  if (!street && have) { skippedNoAddress++; continue; }          // nothing better to derive from
  if (!street && !city && !zip) { skippedNoAddress++; continue; }
  candidates++;

  let geo = null, precision = null;
  if (street) {
    geo = await nominatimStreet(street, city, state, zip);
    if (geo) precision = 'street';
    await sleep(1100);
  }
  if (!geo && !have) {
    geo = await zipCentroid(zip);
    if (geo) precision = 'zip';
  }
  if (!geo) {
    failed++;
    console.log(`SKIP  ${doc.id.slice(0, 8)}… (${d.name ?? '?'}) — geocode failed (street=${street ? 'yes' : 'no'} zip="${zip}")`);
    continue;
  }
  const patch = { lat: geo.lat, lng: geo.lng, latitude: geo.lat, longitude: geo.lng, geoPrecision: precision };
  const from = have ? `${have.lat.toFixed(4)},${have.lng.toFixed(4)} (${d.geoPrecision ?? 'unmarked'})` : 'none';
  console.log(`${CONFIRM ? 'PATCH' : 'WOULD PATCH'} ${doc.id.slice(0, 8)}… (${d.name ?? '?'}): ${from} → ${geo.lat.toFixed(4)},${geo.lng.toFixed(4)} (${precision})`);
  if (CONFIRM) { await doc.ref.set(patch, { merge: true }); patched++; }
}
console.log(`\n${CONFIRM ? `Patched ${patched}` : `Dry run — ${candidates} candidate(s)`}; ${skippedStreet} already street-level; ${skippedNoAddress} without a street to improve on; ${failed} failed.${CONFIRM ? '' : ' Pass --confirm to apply.'}`);
process.exit(0);
