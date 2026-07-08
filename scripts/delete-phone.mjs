/**
 * Delete-by-phone reset script — FULL wipe across every store Evia touches.
 *
 * Wipes EVERY record tied to a single phone number so that phone can re-run
 * Evia's onboarding from a truly clean slate. Targets:
 *   - phone-keyed docs:  agent_sessions, agent_conversations (+ messages subcollection),
 *     agent_prefetch, agent_rate, agent_inbound_locks, agent_tasks_active,
 *     linq_phone_health, web_onboarding_sessions
 *   - caregivers docs where `phone` matches
 *   - the Firebase Auth user whose phoneNumber matches
 *   - uid-keyed webapp profiles: users/{uid}, caregivers/{uid} (keyed by the auth
 *     uid, NOT the phone — so a plain phone sweep misses them)
 *   - LONG-TERM MEMORY (this is what made Evia "still know" a supposedly-cleared
 *     caregiver — $25/hr, care-approach statement, etc.):
 *       • Zep external knowledge graph — user.delete cascades threads + graph.
 *         Zep userId = phone digits only (getZepUserId in memory/zepClient.ts).
 *       • Firestore: learned_facts/{key}(+facts), user_preferences/{key},
 *         memory_embeddings/{key}(+blocks) — keyed by uid in the qaAgent path but
 *         by PHONE in caraAgent.getPreferences(phone), so we sweep both.
 *
 * Evia stores the phone as the raw Linq handle, which is E.164 (+1XXXXXXXXXX).
 * We try a few format variants so a mismatch can't leave orphans behind.
 *
 * SAFETY: dry-run by default. Nothing is deleted unless you pass --confirm.
 *
 * PREREQUISITES:
 *   - functions/serviceAccountKey.json (Firebase Admin key; same one the other
 *     cleanup scripts use). Get one from:
 *     https://console.firebase.google.com/project/careconnex-d4c8b/settings/serviceaccounts/adminsdk
 *   - functions/.env with ZEP_API_KEY (for the Zep wipe). If absent, the Zep step
 *     is skipped with a loud warning — the number will still "remember" until Zep
 *     is cleared, so don't ignore that warning.
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
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const serviceAccountPath = join(root, 'functions/serviceAccountKey.json');

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

// Zep userId = phone digits only (see getZepUserId in memory/zepClient.ts).
const zepUserIds = Array.from(new Set([`1${ten}`, ten]));

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

// Collections that store the phone as a field (random/uid-keyed docs). We sweep
// BOTH `phone` and `phoneNumber`. `users` is included because the inbound webhook
// re-hydrates a returning person via `users.where("phone","==",…)` (webhooks.ts
// ~:1572) REGARDLESS of the auth uid — so an orphaned users doc (auth already
// deleted, doc left behind) would make Evia "remember" the person on retest.
const PHONE_FIELD = ['caregivers', 'users', 'senior_profiles', 'clientIntakes'];
const PHONE_FIELD_KEYS = ['phone', 'phoneNumber'];

// Long-term-memory collections. Keyed by uid in the agent path but by phone in
// caraAgent.getPreferences(phone) — so we sweep phone variants AND discovered uids.
// learned_facts/{key} has a `facts` subcol; memory_embeddings/{key} has `blocks`.
const MEMORY_COLLECTIONS = ['learned_facts', 'user_preferences', 'memory_embeddings'];

// uid-keyed profile docs discovered from the Auth lookup.
const UID_KEYED = ['users', 'caregivers'];

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

// Read a single value out of functions/.env (for ZEP_API_KEY).
function envVal(key) {
  try {
    const txt = readFileSync(join(root, 'functions/.env'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

// Delete a doc + all its subcollections if it (or any subcollection) exists.
async function deleteDocIfPresent(ref, label) {
  const snap = await ref.get();
  const subs = await ref.listCollections();
  if (!snap.exists && subs.length === 0) return 0;
  console.log(`  ${tag}: ${label}${subs.length ? ` (+${subs.map((c) => c.id).join(',')})` : ''}`);
  if (confirm) await db.recursiveDelete(ref);
  return 1;
}

async function run() {
  console.log(`\n${confirm ? '🗑️  LIVE DELETE' : '🔍 DRY RUN (no changes — pass --confirm to delete)'}`);
  console.log(`Phone variants checked: ${phoneVariants.join(', ')}`);
  console.log(`Zep userIds checked:    ${zepUserIds.join(', ')}\n`);

  let hits = 0;

  // 0) Discover Auth uids FIRST (before deleting the auth user) so we can also
  //    wipe uid-keyed profile + memory docs. auth phoneNumber is always E.164.
  const uids = [];
  for (const variant of phoneVariants) {
    if (!variant.startsWith('+')) continue;
    try {
      const user = await auth.getUserByPhoneNumber(variant);
      if (!uids.includes(user.uid)) uids.push(user.uid);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.warn(`  ⚠️  auth lookup for ${variant}: ${e.message}`);
    }
  }

  // 1) Phone-keyed documents
  for (const col of PHONE_KEYED) {
    for (const variant of phoneVariants) {
      hits += await deleteDocIfPresent(db.collection(col).doc(variant), `${col}/${variant}`);
    }
  }

  // 2) Phone-field documents (by `phone` or `phoneNumber`) — catches orphans
  //    regardless of auth state. Dedup by ref path so a doc matched twice counts once.
  const seenFieldRefs = new Set();
  for (const col of PHONE_FIELD) {
    for (const field of PHONE_FIELD_KEYS) {
      for (const variant of phoneVariants) {
        const qs = await db.collection(col).where(field, '==', variant).get();
        for (const doc of qs.docs) {
          if (seenFieldRefs.has(doc.ref.path)) continue;
          seenFieldRefs.add(doc.ref.path);
          hits++;
          const d = doc.data();
          console.log(`  ${tag}: ${col}/${doc.id} (${d.name || d.firstName || d.email || 'no name'}, ${field}=${variant})`);
          if (confirm) await db.recursiveDelete(doc.ref);
        }
      }
    }
  }

  // 3) uid-keyed profile docs (users/{uid}, caregivers/{uid}) — missed by a
  //    phone-only sweep because the doc id is the auth uid.
  for (const uid of uids) {
    for (const col of UID_KEYED) {
      hits += await deleteDocIfPresent(db.collection(col).doc(uid), `${col}/${uid}`);
    }
  }

  // 4) Long-term memory in Firestore (phone variants + discovered uids)
  const memoryKeys = Array.from(new Set([...phoneVariants, ...uids]));
  for (const col of MEMORY_COLLECTIONS) {
    for (const key of memoryKeys) {
      hits += await deleteDocIfPresent(db.collection(col).doc(key), `${col}/${key}`);
    }
  }

  // 5) Zep external memory (user.delete cascades that user's threads + graph).
  //    THIS is what makes Evia "still know" a caregiver after a Firestore-only wipe.
  const zepKey = envVal('ZEP_API_KEY');
  if (!zepKey) {
    console.warn('\n  ⚠️  ZEP_API_KEY not in functions/.env — SKIPPING Zep wipe.');
    console.warn('     Evia will still REMEMBER this number until Zep is cleared. Add the key and re-run.');
  } else {
    try {
      const zepEntry = pathToFileURL(join(root, 'functions/node_modules/@getzep/zep-cloud/dist/esm/index.mjs')).href;
      const { ZepClient } = await import(zepEntry);
      const zep = new ZepClient({ apiKey: zepKey });
      for (const uid of zepUserIds) {
        try {
          const user = await zep.user.get(uid);
          hits++;
          console.log(`  ${tag}: Zep user ${uid} (${user?.email || 'exists'})`);
          if (confirm) await zep.user.delete(uid);
        } catch (e) {
          const status = e?.status ?? e?.statusCode;
          if (status !== 404) console.warn(`  ⚠️  Zep lookup ${uid}: ${e?.message || e}`);
        }
      }
    } catch (e) {
      console.warn(`  ⚠️  Zep wipe skipped (SDK load failed): ${e?.message || e}`);
    }
  }

  // 6) Firebase Auth user LAST (uid already captured above)
  for (const uid of uids) {
    hits++;
    console.log(`  ${tag}: auth user ${uid}`);
    if (confirm) await auth.deleteUser(uid).catch((e) => console.warn(`  ⚠️  auth delete ${uid}: ${e.message}`));
  }

  console.log(`\n${hits === 0 ? '✅ Nothing found for that number — already clean.' :
    confirm ? `✅ Done. ${hits} record(s) deleted.` :
    `Found ${hits} record(s). Re-run with --confirm to delete them.`}\n`);
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('💥 Error:', err);
  process.exit(1);
});
