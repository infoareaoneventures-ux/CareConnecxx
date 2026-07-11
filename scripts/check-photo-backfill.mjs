/**
 * READ-ONLY: list caregivers docs that have profilePhoto/photoURL but no `photo`
 * field (the webapp-canonical name) — candidates for the one-time backfill in
 * docs/plans/2026-07-09-001-fix-caregiver-photo-webapp-parity-spec.md.
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

const snap = await db.collection('caregivers').get();
let total = 0, withAny = 0, missingPhoto = 0;
for (const doc of snap.docs) {
  total++;
  const d = doc.data();
  const src = d.profilePhoto || d.photoURL;
  if (typeof src === 'string' && src.startsWith('http')) {
    withAny++;
    if (!d.photo) {
      missingPhoto++;
      console.log(`MISSING photo: caregivers/${doc.id} (${d.name || 'no name'}, status=${d.status || '?'})`);
    }
  }
}
console.log(`\n${total} caregiver docs; ${withAny} have profilePhoto/photoURL; ${missingPhoto} missing the canonical \`photo\` field.`);
process.exit(0);
