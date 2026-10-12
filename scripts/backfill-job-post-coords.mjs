/**
 * Street-level backfill for job_posts coordinates (2026-10-11).
 *
 * Before 2026-10-11 both doors geocoded a job post at ZIP/city level (the site
 * sent only city/state/zip to createJobPost; Evia's buildJobPost used the ZIP).
 * Both now resolve the point from the family's Care Plan location
 * (carePlans/{clientId}.locationPool entry matching the post's address) —
 * street-level — and stamp `geoPrecision`. The public post still never
 * carries the street. This script re-derives EXISTING posts the same way:
 *
 *   - target: posts whose geoPrecision !== 'street' (open posts by default,
 *     --all for every status);
 *   - source: the client's locationPool entries with the post's zipCode (then
 *     city as a tiebreak). Exactly ONE match is required — a family with two
 *     addresses in the same ZIP is listed for a manual pick, never guessed;
 *   - point: the entry's own street-level coords when it has them, else the
 *     entry's street geocoded now (same Nominatim query as the server) and
 *     written back onto the pool entry too (so the next post reuses it);
 *   - writes lat/lng/geoPrecision on the post; a legacy `streetAddress` field
 *     on a post (the old WhatsNext auto-post stored it) is deleted — the
 *     public post must not carry the street.
 *
 * Nominatim's usage policy is 1 request/second — the loop sleeps between calls.
 *
 * Usage:
 *   node scripts/backfill-job-post-coords.mjs             # dry run, open posts
 *   node scripts/backfill-job-post-coords.mjs --all       # dry run, every status
 *   node scripts/backfill-job-post-coords.mjs --confirm   # apply
 *   node scripts/backfill-job-post-coords.mjs --post <id> # one post
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
const ALL = args.includes('--all');
const ONLY_POST = args.includes('--post') ? args[args.indexOf('--post') + 1] : null;

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

const numericPoint = (e) => {
  const lat = e?.lat ?? e?.latitude, lng = e?.lng ?? e?.longitude;
  return (typeof lat === 'number' && typeof lng === 'number') ? { lat, lng } : null;
};
const norm = (s) => String(s ?? '').trim().toLowerCase();

let postsSnap;
if (ONLY_POST) {
  const one = await db.collection('job_posts').doc(ONLY_POST).get();
  postsSnap = { docs: one.exists ? [one] : [] };
} else {
  postsSnap = ALL
    ? await db.collection('job_posts').get()
    : await db.collection('job_posts').where('status', '==', 'open').get();
}

// Cache each family's pool so a client with several posts is read once.
const poolCache = new Map();
async function poolFor(clientId) {
  if (!clientId) return [];
  if (!poolCache.has(clientId)) {
    const cp = await db.collection('carePlans').doc(clientId).get().catch(() => null);
    poolCache.set(clientId, Array.isArray(cp?.data()?.locationPool) ? cp.data().locationPool : []);
  }
  return poolCache.get(clientId);
}

let candidates = 0, patched = 0, alreadyStreet = 0, ambiguous = 0, noMatch = 0, failed = 0;
for (const doc of postsSnap.docs) {
  const p = doc.data();
  const id = doc.id.slice(0, 10);
  if (p.geoPrecision === 'street' && numericPoint(p)) { alreadyStreet++; continue; }
  candidates++;

  const pool = await poolFor(p.clientId);
  let matches = pool.filter((e) => e?.street && norm(e.zipCode) === norm(p.zipCode));
  if (matches.length > 1 && p.city) {
    const byCity = matches.filter((e) => norm(e.city) === norm(p.city));
    if (byCity.length >= 1) matches = byCity;
  }
  if (matches.length === 0) {
    noMatch++;
    console.log(`SKIP  ${id}… client=${String(p.clientId ?? '?').slice(0, 8)} — no Care Plan location in zip "${p.zipCode ?? ''}" (${pool.length} on file)`);
    continue;
  }
  if (matches.length > 1) {
    ambiguous++;
    console.log(`PICK  ${id}… client=${String(p.clientId ?? '?').slice(0, 8)} — ${matches.length} Care Plan locations in zip "${p.zipCode ?? ''}": ${matches.map((e) => e.street).join(' | ')} (manual)`);
    continue;
  }

  const entry = matches[0];
  const entryIdx = pool.indexOf(entry);
  let point = entry.geoPrecision === 'street' ? numericPoint(entry) : null;
  let poolPatch = null;
  if (!point) {
    point = await nominatimStreet(entry.street, entry.city ?? p.city, entry.state ?? p.state, entry.zipCode);
    await sleep(1100);
    if (point) poolPatch = { ...entry, lat: point.lat, lng: point.lng, geoPrecision: 'street' };
  }
  if (!point) {
    failed++;
    console.log(`SKIP  ${id}… — street geocode failed for the Care Plan location`);
    continue;
  }

  const have = numericPoint(p);
  const from = have ? `${have.lat.toFixed(4)},${have.lng.toFixed(4)} (${p.geoPrecision ?? 'unmarked'})` : 'none';
  const dropStreet = typeof p.streetAddress === 'string';
  console.log(`${CONFIRM ? 'PATCH' : 'WOULD PATCH'} ${id}… client=${String(p.clientId ?? '?').slice(0, 8)}: ${from} → ${point.lat.toFixed(4)},${point.lng.toFixed(4)} (street)${poolPatch ? ' + pool entry' : ''}${dropStreet ? ' + delete streetAddress' : ''}`);
  if (CONFIRM) {
    await doc.ref.set({
      lat: point.lat, lng: point.lng, geoPrecision: 'street',
      ...(dropStreet ? { streetAddress: admin.firestore.FieldValue.delete() } : {}),
    }, { merge: true });
    if (poolPatch && entryIdx >= 0) {
      const nextPool = pool.map((e, i) => (i === entryIdx ? poolPatch : e));
      await db.collection('carePlans').doc(p.clientId).set({ locationPool: nextPool }, { merge: true });
      poolCache.set(p.clientId, nextPool);
    }
    patched++;
  }
}
console.log(`\n${CONFIRM ? `Patched ${patched}` : `Dry run — ${candidates} candidate(s)`}; ${alreadyStreet} already street-level; ${noMatch} with no matching Care Plan location; ${ambiguous} need a manual pick; ${failed} failed.${CONFIRM ? '' : ' Pass --confirm to apply.'}`);
process.exit(0);
