/**
 * READ-ONLY inspection of everything tied to a phone number — the diagnostic
 * counterpart of delete-phone.mjs. Dumps Auth, agent_sessions (+onboardingData),
 * users/{uid}, caregivers/{uid}, phone-field orphans, Storage uploads, and the
 * last few conversation messages. Changes nothing.
 *
 * Usage: node scripts/inspect-phone.mjs 4087261330
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
initializeApp({ credential: cert(sa), storageBucket: `${sa.project_id}.appspot.com` });
const db = getFirestore();
const auth = getAuth();

const raw = process.argv[2];
if (!raw) { console.error('Usage: node scripts/inspect-phone.mjs <phone>'); process.exit(1); }
const digits = raw.replace(/\D/g, '');
const ten = digits.length > 10 ? digits.slice(-10) : digits;
const e164 = `+1${ten}`;
const variants = [e164, ten, `1${ten}`];

const trunc = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 300 ? s.slice(0, 300) + '…[truncated]' : s;
};

function dumpDoc(label, data, keys = null) {
  console.log(`\n=== ${label} ===`);
  if (!data) { console.log('  (missing)'); return; }
  const entries = Object.entries(data)
    .filter(([k]) => !keys || keys.includes(k))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    if (v && typeof v === 'object' && typeof v.toDate === 'function') {
      console.log(`  ${k}: [ts] ${v.toDate().toISOString()}`);
    } else {
      console.log(`  ${k}: ${trunc(v)}`);
    }
  }
}

async function run() {
  console.log(`Inspecting ${e164} (read-only)\n`);

  let authUser = null;
  try { authUser = await auth.getUserByPhoneNumber(e164); } catch {}
  if (authUser) {
    console.log('=== Firebase Auth ===');
    console.log(`  uid: ${authUser.uid}`);
    console.log(`  displayName: ${authUser.displayName}`);
    console.log(`  email: ${authUser.email}`);
    console.log(`  photoURL: ${authUser.photoURL}`);
    console.log(`  created: ${authUser.metadata.creationTime}`);
    console.log(`  lastSignIn: ${authUser.metadata.lastSignInTime}`);
    console.log(`  providers: ${authUser.providerData.map(p => p.providerId).join(', ')}`);
  } else {
    console.log(`=== Firebase Auth === (no user for ${e164})`);
  }
  const uid = authUser?.uid;

  const sessSnap = await db.collection('agent_sessions').doc(e164).get();
  const sess = sessSnap.exists ? sessSnap.data() : null;
  dumpDoc(`agent_sessions/${e164}`, sess, [
    'userType', 'onboardingStep', 'caregiverId', 'userId', 'uid', 'firstName',
    'processedWebhookTasks', 'membershipPaid', 'bgcheckInviteUrl', 'stripeAccountId',
    'createdAt', 'updatedAt', 'lastMessageAt', 'preferredLanguage',
  ]);
  if (sess?.onboardingData) dumpDoc('  onboardingData', sess.onboardingData);

  if (uid) {
    const uSnap = await db.collection('users').doc(uid).get();
    dumpDoc(`users/${uid}`, uSnap.exists ? uSnap.data() : null);
    const cSnap = await db.collection('caregivers').doc(uid).get();
    dumpDoc(`caregivers/${uid}`, cSnap.exists ? cSnap.data() : null);
  }

  for (const col of ['users', 'caregivers', 'senior_profiles', 'clientIntakes']) {
    for (const field of ['phone', 'phoneNumber']) {
      for (const v of variants) {
        const qs = await db.collection(col).where(field, '==', v).get();
        for (const doc of qs.docs) {
          if (doc.id === uid) continue;
          dumpDoc(`[phone-field] ${col}/${doc.id} (${field}=${v})`, doc.data());
        }
      }
    }
  }

  const webSnap = await db.collection('web_onboarding_sessions').doc(e164).get();
  dumpDoc(`web_onboarding_sessions/${e164}`, webSnap.exists ? webSnap.data() : null);

  console.log('\n=== Storage files ===');
  const bucket = getStorage().bucket();
  const prefixes = [
    `profile_photos/onboarding/${ten}`, `profile_photos/onboarding/1${ten}`,
    `caregiver_docs/onboarding/${ten}`, `caregiver_docs/onboarding/1${ten}`,
    uid ? `profile_photos/${uid}` : null, uid ? `profilePictures/${uid}` : null,
    uid ? `users/${uid}` : null,
  ].filter(Boolean);
  for (const prefix of prefixes) {
    try {
      const [files] = await bucket.getFiles({ prefix });
      for (const f of files) {
        console.log(`  ${f.name} (${f.metadata.size} bytes, ${f.metadata.contentType}, created ${f.metadata.timeCreated})`);
      }
      if (!files.length) console.log(`  (none under ${prefix})`);
    } catch (e) {
      console.log(`  ! ${prefix}: ${e.message}`);
    }
  }

  const convSnap = await db.collection('agent_conversations').doc(e164)
    .collection('messages').orderBy('createdAt', 'desc').limit(12).get().catch(() => null);
  if (convSnap && !convSnap.empty) {
    console.log('\n=== Last messages (newest first) ===');
    for (const m of convSnap.docs) {
      const d = m.data();
      const when = d.createdAt?.toDate?.()?.toISOString?.() ?? '?';
      console.log(`  [${when}] ${d.role || d.direction || '?'}: ${trunc(d.text || d.content || d.body || '')}`);
    }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e); process.exit(1); });
