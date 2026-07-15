/**
 * Backfill latitude/longitude on caregiver docs that predate the onboarding
 * geocoding (2026-07-14). Targets ONLY docs missing coords; geocodes from ZIP
 * first, then city. Also repairs a corrupted city field when the doc's "city"
 * is not a real place but a ZIP lookup gives one (seen live: city="Adrian" —
 * the caregiver's NAME — with zip 95050).
 *
 * Usage:
 *   node scripts/backfill-caregiver-coords.mjs            # dry run
 *   node scripts/backfill-caregiver-coords.mjs --confirm  # apply
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
const CONFIRM = process.argv.includes('--confirm');

async function zipLookup(zip) {
  if (!zip || String(zip).length < 5) return null;
  try {
    const r = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 5000 });
    const p = r.data?.places?.[0];
    if (p?.latitude && p?.longitude) {
      return { lat: parseFloat(p.latitude), lng: parseFloat(p.longitude), city: p['place name'] };
    }
  } catch {}
  return null;
}
async function cityLookup(city) {
  if (!city || !city.trim()) return null;
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { format: 'json', country: 'USA', state: 'California', city: city.trim(), limit: 1 },
      headers: { 'User-Agent': 'EviaCares/1.0 (support@eviacares.com)' },
      timeout: 5000,
    });
    const p = r.data?.[0];
    if (p?.lat && p?.lon) return { lat: parseFloat(p.lat), lng: parseFloat(p.lon), city: city.trim() };
  } catch {}
  return null;
}

const coordsOf = (d) => {
  const lat = d.latitude ?? d.lat ?? d.location?.latitude ?? d.location?.lat;
  const lng = d.longitude ?? d.lng ?? d.location?.longitude ?? d.location?.lng;
  return (typeof lat === 'number' && typeof lng === 'number') ? { lat, lng } : null;
};

const snap = await db.collection('caregivers').get();
let patched = 0, skipped = 0;
for (const doc of snap.docs) {
  const d = doc.data();
  if (coordsOf(d)) { skipped++; continue; }
  const zip  = (d.zipCode ?? d.zip ?? '').toString();
  const city = (d.city ?? d.location?.city ?? '').toString();

  // ZIP first (also yields an authoritative city name), then city string.
  const geo = (await zipLookup(zip)) ?? (await cityLookup(city));
  if (!geo) {
    console.log(`SKIP ${doc.id.slice(0,8)}… (${d.name ?? '?'}) — no geocodable city/zip (city="${city}" zip="${zip}")`);
    continue;
  }
  // Repair the city field only when the ZIP lookup returned a real place name
  // that differs from the stored value (e.g. stored "Adrian", zip → "Santa Clara").
  const cityFix = geo.city && geo.city.toLowerCase() !== city.toLowerCase() ? geo.city : null;

  // NEVER write `location` as an object — the webapp renders caregiver
  // `location` as a display string and an object crashes the page (React #31).
  // Top-level latitude/longitude + lat/lng are what all server readers use.
  const patch = {
    latitude: geo.lat, longitude: geo.lng,
    lat: geo.lat, lng: geo.lng,
    ...(cityFix ? { city: cityFix } : {}),
  };
  console.log(`${CONFIRM ? 'PATCH' : 'WOULD PATCH'} ${doc.id.slice(0,8)}… (${d.name ?? '?'}): ${JSON.stringify(patch)}`);
  if (CONFIRM) { await doc.ref.set(patch, { merge: true }); patched++; }
}
console.log(`\n${CONFIRM ? 'Patched' : 'Dry run —'} ${CONFIRM ? patched : 'see above'}; ${skipped} already had coords.${CONFIRM ? '' : ' Pass --confirm to apply.'}`);
process.exit(0);
