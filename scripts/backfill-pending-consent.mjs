/**
 * One-off backfill for agent_sessions stuck at optedIn:false (2026-07-12).
 *
 * Before the pending-consent fix (handlePendingConsentReply in webhooks.ts),
 * the onUserCreated auth trigger created sessions with optedIn:false and NO
 * code ever recorded the user's YES reply — so users who consented were still
 * skipped by every proactive sender. This script finds those sessions, checks
 * the conversation history for a clear affirmative reply sent AFTER the
 * consent ask, and flips exactly those sessions to the same shape
 * handlePendingConsentReply writes (optedIn/optedInAt/userType/onboardingStep,
 * seniorId corrected). Sessions with no reply, or a non-YES reply, are left
 * pending — the deployed webhook branch now handles their next text.
 *
 * The YES match is a deterministic allowlist ON PURPOSE: this is a one-off,
 * human-reviewed migration over historical data (dry-run prints every match),
 * not runtime intent parsing.
 *
 * Usage:
 *   node scripts/backfill-pending-consent.mjs            # dry run (default)
 *   node scripts/backfill-pending-consent.mjs --confirm  # apply writes
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const CONFIRM = process.argv.includes('--confirm');

const YES_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'yes please', 'yes!',
  'si', 'sí', 'sí!', 'si!', 'y',
]);
const normalize = (t) =>
  String(t ?? '').trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');

const tsToIso = (v) => {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  return null;
};

async function userHasRealProgress(userId, userData) {
  const seniorIds = userData?.seniorIds ?? [];
  if (userData?.seniorId || seniorIds.length > 0) return true;
  const cg = await db.collection('caregivers').doc(userId).get().catch(() => null);
  return !!cg?.exists;
}

async function run() {
  console.log(`backfill-pending-consent — ${CONFIRM ? 'APPLYING WRITES' : 'DRY RUN (no writes)'}\n`);

  const snap = await db.collection('agent_sessions').where('optedIn', '==', false).get();
  console.log(`agent_sessions with optedIn:false — ${snap.size}\n`);

  let flipped = 0, noReply = 0, nonYes = 0, skippedOptedOut = 0;

  for (const doc of snap.docs) {
    const phone = doc.id;
    const session = doc.data();

    if (session.optedOut === true) {
      skippedOptedOut++;
      console.log(`SKIP  ${phone}  — optedOut:true (respect the opt-out)`);
      continue;
    }

    const consentAskAt = session.createdAt ?? null; // trigger writes ISO string
    const msgs = await db.collection('agent_conversations').doc(phone)
      .collection('messages').orderBy('createdAt', 'asc').limit(100).get()
      .catch(() => null);

    // First clear affirmative INBOUND reply after the consent ask.
    let yesAt = null;
    const inboundTexts = [];
    if (msgs && !msgs.empty) {
      for (const m of msgs.docs) {
        const d = m.data();
        const role = String(d.role ?? d.direction ?? '').toLowerCase();
        if (role !== 'user' && role !== 'inbound') continue;
        const when = tsToIso(d.createdAt);
        if (consentAskAt && when && when < consentAskAt) continue;
        const text = d.text ?? d.content ?? d.body ?? '';
        inboundTexts.push(`[${when ?? '?'}] ${String(text).slice(0, 80)}`);
        if (!yesAt && YES_WORDS.has(normalize(text))) yesAt = when ?? new Date().toISOString();
      }
    }

    if (inboundTexts.length === 0) {
      noReply++;
      console.log(`PEND  ${phone}  — no inbound reply yet (deployed webhook branch covers their next text)`);
      continue;
    }
    if (!yesAt) {
      nonYes++;
      console.log(`PEND  ${phone}  — replied but never a clear YES; leaving pending. Inbound:`);
      inboundTexts.slice(-3).forEach((l) => console.log(`        ${l}`));
      continue;
    }

    // Mirror handlePendingConsentReply's YES handoff (data only — no message).
    const userSnap = session.userId
      ? await db.collection('users').doc(session.userId).get().catch(() => null)
      : null;
    const userData = userSnap?.exists ? userSnap.data() : {};
    const isReturning = session.userId ? await userHasRealProgress(session.userId, userData) : false;
    const firstName = String(userData.firstName ?? userData.name ?? '').trim().split(/\s+/)[0] || '';
    const seniorId = userData.seniorId ?? (userData.seniorIds ?? [])[0] ?? '';

    const update = {
      optedIn: true,
      optedInAt: yesAt,
      optedOut: false,
      userType: userData.userType ?? 'client',
      onboardingStep: isReturning
        ? 'complete'
        : (firstName ? 'client_confirm_name' : 'client_ask_name'),
      ...(isReturning
        ? { seniorId }
        : { seniorId: FieldValue.delete() }),
      ...(!isReturning && firstName ? { onboardingData: { firstName } } : {}),
    };

    flipped++;
    console.log(`FLIP  ${phone}  — YES at ${yesAt}  (${isReturning ? 'returning → complete' : `fresh → ${update.onboardingStep}`}${firstName ? `, firstName=${firstName}` : ''})`);
    if (CONFIRM) {
      await doc.ref.update(update);
      console.log('        ...written');
    }
  }

  console.log(`\nSummary: ${flipped} flipped${CONFIRM ? '' : ' (dry run — nothing written)'}, ${noReply} no-reply pending, ${nonYes} non-YES pending, ${skippedOptedOut} opted-out skipped.`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
