// READ-ONLY: audit latitude/longitude coverage across caregivers and job posts.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const admin = require(join(root, 'functions/node_modules/firebase-admin'));
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const coordsOf = (d) => {
  const lat = d.latitude ?? d.lat ?? d.location?.latitude ?? d.location?.lat;
  const lng = d.longitude ?? d.lng ?? d.location?.longitude ?? d.location?.lng;
  return (typeof lat === 'number' && typeof lng === 'number') ? { lat, lng } : null;
};

console.log('=== CAREGIVERS ===');
const cgs = await db.collection('caregivers').get();
let cgHave = 0; const cgMissing = [];
for (const c of cgs.docs) {
  const d = c.data();
  if (coordsOf(d)) cgHave++;
  else cgMissing.push(`  ${c.id.slice(0,8)}… name=${d.name ?? d.firstName ?? '?'} status=${d.status ?? '?'} city=${d.city ?? d.location?.city ?? '—'} zip=${d.zipCode ?? d.zip ?? '—'}`);
}
console.log(`total=${cgs.size} withCoords=${cgHave} missing=${cgMissing.length}`);
cgMissing.forEach(l => console.log(l));

console.log('\n=== JOB_POSTS ===');
const jps = await db.collection('job_posts').get();
let jpHave = 0; const jpMissing = [];
for (const j of jps.docs) {
  const d = j.data();
  if (coordsOf(d)) jpHave++;
  else jpMissing.push(`  ${j.id.slice(0,8)}… status=${d.status ?? '?'} city=${d.city ?? '—'} title=${(d.title ?? '').slice(0,30)} notified=${d.notifiedCount ?? 0}`);
}
console.log(`total=${jps.size} withCoords=${jpHave} missing=${jpMissing.length}`);
jpMissing.forEach(l => console.log(l));

console.log('\n=== USERS (clients) with a city but relying on job coords ===');
const users = await db.collection('users').where('userType', '==', 'client').get().catch(() => null);
if (users) console.log(`client users total=${users.size} (coords live on job_posts/carePlans, not users — informational)`);
process.exit(0);
