/**
 * Delete-by-phone reset script
 *
 * Wipes EVERY record tied to a single phone number so that phone can re-run
 * Evia's onboarding from a clean slate. Targets:
 *   - phone-keyed docs:  agent_sessions, agent_conversations (+ messages subcollection),
 *     agent_prefetch, agent_rate, agent_inbound_locks, agent_tasks_active,
 *     linq_phone_health, web_onboarding_sessions
 *   - caregivers docs where `phone` matches
 *   - the Firebase Auth user whose phoneNumber matches
 *
 * Evia stores the phone as the raw Linq handle, which is E.164 (+1XXXXXXXXXX).
 * We try a few format variants so a mismatch can't leave orphans behind.
 *
 * SAFETY: dry-run by default. Nothing is deleted unless you pass --confirm.
 *
 * PREREQUISITE: functions/serviceAccountKey.json (same key the other cleanup
 * scripts use). Get one from:
 *   https://console.firebase.google.com/project/careconnex-d4c8b/settings/serviceaccounts/adminsdk
 *   → "Generate new private key" → save as functions/serviceAccountKey.json
 *
 * Usage:
 *   node scripts/delete-phone.mjs 4087261330            # dry run (default)
 *   node scripts/delete-phone.mjs 4087261330 --confirm  # actually delete
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = join(__dirname, '../functions/serviceAccountKey.json');

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const rawArg = args.find((a) => !a.startsWith('--'));

if (!rawArg) {
  console.error('Usage: node scripts/delete-phone.mjs <phone> [--confirm]');
  process.exit(1);
}

// Build the format variants we'll look for. Evia uses E.164 (+1...), but we also
// check the bare 10-digit and 11-digit forms in case anything was stored raw.
const digits = rawArg.replace(/\D/g, '');
const ten = digits.length > 10 ? digits.slice(-10) : digits;
const phoneVariants = Array.from(new Set([
  rawArg,
  ten,
  `1${ten}`,
  `+1${ten}`,
])).filter(Boolean);

// Collections whose document ID IS the phone string.
const PHONE_KEYED = [
  'agent_sessions',
  'agent_conversations', // has a `messages` subcollection → recursiveDelete
  'agent_prefetch',
  'agent_rate',
  'agent_inbound_locks',
  'agent_tasks_active',
  'linq_phone_health',
  'web_onboarding_sessions',
];

// Collections that store the phone as a `phone` field (random/uid-keyed docs).
const PHONE_FIELD = ['caregivers'];

if (!existsSync(serviceAccountPath)) {
  console.error('\n❌ functions/serviceAccountKey.json not found.\n');
  console.error('Generate one at:');
  console.error('  https://console.firebase.google.com/project/careconnex-d4c8b/settings/serviceaccounts/adminsdk');
  console.error('Save it as functions/serviceAccountKey.json, then re-run.\n');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8'))) });
const db = getFirestore();
const auth = getAuth();

const tag = confirm ? '🗑️  DELETE' : '🔍 would delete';

async function run() {
  console.log(`\n${confirm ? '🗑️  LIVE DELETE' : '🔍 DRY RUN (no changes — pass --confirm to delete)'}`);
  console.log(`Phone variants checked: ${phoneVariants.join(', ')}\n`);

  let hits = 0;

  // 1) Phone-keyed documents
  for (const col of PHONE_KEYED) {
    for (const variant of phoneVariants) {
      const ref = db.collection(col).doc(variant);
      const snap = await ref.get();
      if (!snap.exists) continue;
      hits++;
      console.log(`  ${tag}: ${col}/${variant}`);
      if (confirm) {
        // recursiveDelete handles the doc + any subcollections (e.g. messages)
        await db.recursiveDelete(ref);
      }
    }
  }

  // 2) Phone-field documents (caregivers)
  for (const col of PHONE_FIELD) {
    for (const variant of phoneVariants) {
      const qs = await db.collection(col).where('phone', '==', variant).get();
      for (const doc of qs.docs) {
        hits++;
        const d = doc.data();
        console.log(`  ${tag}: ${col}/${doc.id} (${d.name || d.email || 'no name'}, status=${d.status || '?'})`);
        if (confirm) await db.recursiveDelete(doc.ref);
      }
    }
  }

  // 3) Firebase Auth user (phoneNumber is E.164)
  for (const variant of phoneVariants) {
    if (!variant.startsWith('+')) continue; // auth phoneNumber is always E.164
    try {
      const user = await auth.getUserByPhoneNumber(variant);
      hits++;
      console.log(`  ${tag}: auth user ${user.uid} (phone ${variant})`);
      if (confirm) await auth.deleteUser(user.uid);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        console.warn(`  ⚠️  auth lookup for ${variant}: ${e.message}`);
      }
    }
  }

  console.log(`\n${hits === 0 ? '✅ Nothing found for that number — already clean.' :
    confirm ? `✅ Done. ${hits} record(s) deleted.` :
    `Found ${hits} record(s). Re-run with --confirm to delete them.`}\n`);
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('💥 Error:', err);
  process.exit(1);
});
