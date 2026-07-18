/**
 * Activity backfill for nightly memory selection (memory-grounding plan
 * 2026-07-17-002, U2 / R3 / Backfill Gate).
 *
 * For each agent_sessions doc MISSING lastMessageAt, derive it from the latest
 * agent_conversations/{phone}/messages row with role == "user" (its `timestamp`
 * field) — never from message text — and write it as a Firestore Timestamp only
 * when the evidence is sane (within the last 7 days, not in the future). A
 * missing session userType is repaired ONLY from an explicit canonical role on
 * users/{userId}; ambiguous sessions stay excluded and are counted.
 *
 * Decision policy lives in functions/src/memory/conversationMemory.ts
 * (decideActivityBackfill) and is imported from the compiled output, so run
 * `npm --prefix functions run build` before this script.
 *
 * Output is AGGREGATE COUNTS ONLY (no phones, no IDs, no content).
 * Idempotent: after --apply, a re-run in dry-run mode must report
 * "would update = 0".
 *
 * Usage:
 *   node scripts/backfill-agent-session-last-message-at.mjs           # dry run
 *   node scripts/backfill-agent-session-last-message-at.mjs --apply   # write
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const admin = require(join(root, 'functions/node_modules/firebase-admin'));

const decisionModulePath = join(root, 'functions/lib/memory/conversationMemory.js');
if (!existsSync(decisionModulePath)) {
  console.error('Missing compiled decision module. Run: npm --prefix functions run build');
  process.exit(1);
}
const { decideActivityBackfill } = require(decisionModulePath);

const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

const PAGE_SIZE = 300;

// Message `timestamp` rows are numeric epoch ms in current writers, but tolerate
// Firestore Timestamps and ISO strings from older rows. Anything else is "no
// usable evidence" — never inferred from text.
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

async function latestUserMessageMs(phone) {
  // Uses the existing `messages` composite index (role ASC, timestamp DESC).
  const snap = await db
    .collection('agent_conversations').doc(phone).collection('messages')
    .where('role', '==', 'user')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return toMillis(snap.docs[0].data().timestamp);
}

async function canonicalUserType(userId) {
  if (!userId) return null;
  const snap = await db.collection('users').doc(userId).get();
  return snap.exists ? (snap.data().userType ?? null) : null;
}

const counts = {
  scanned: 0,
  completed: 0,
  explicitClients: 0,
  caregiversExcluded: 0,
  ambiguousRole: 0,
  alreadyPopulated: 0,
  recentHistory: 0,
  staleHistory: 0,
  noHistory: 0,
  wouldUpdate: 0,
  updated: 0,
};

let cursor = null;
for (;;) {
  let query = db.collection('agent_sessions')
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(PAGE_SIZE);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  if (page.empty) break;

  for (const doc of page.docs) {
    const data = doc.data();
    counts.scanned++;
    if (data.onboardingStep === 'complete') counts.completed++;

    const hasLastMessageAt = data.lastMessageAt != null;
    // Canonical role lookup only when the session is missing an explicit role
    // (the only case R3 allows repairing) — keeps reads bounded.
    const sessionRoleExplicit = data.userType === 'client' || data.userType === 'caregiver';
    const canonicalRole = sessionRoleExplicit ? null : await canonicalUserType(data.userId);
    // History evidence is only needed when the field is missing.
    const latestMs = hasLastMessageAt ? null : await latestUserMessageMs(doc.id);

    const decision = decideActivityBackfill({
      hasLastMessageAt,
      sessionUserType: data.userType ?? null,
      canonicalUserType: canonicalRole,
      latestUserMessageTimestampMs: latestMs,
      nowMs: Date.now(),
    });

    if (decision.role === 'client') counts.explicitClients++;
    else if (decision.role === 'caregiver') counts.caregiversExcluded++;
    else counts.ambiguousRole++;

    if (decision.history === 'already_populated') counts.alreadyPopulated++;
    else if (decision.history === 'recent_history') counts.recentHistory++;
    else if (decision.history === 'stale_history') counts.staleHistory++;
    else counts.noHistory++;

    if (decision.writeLastMessageAtMs == null) continue;

    counts.wouldUpdate++;
    if (APPLY) {
      const patch = {
        lastMessageAt: admin.firestore.Timestamp.fromMillis(decision.writeLastMessageAtMs),
        // Role repair rides along only when the write makes the session
        // selectable — explicit canonical role only, never inferred (R3).
        ...(decision.repairUserType ? { userType: decision.repairUserType } : {}),
      };
      await doc.ref.update(patch);
      counts.updated++;
    }
  }

  if (page.docs.length < PAGE_SIZE) break;
  cursor = page.docs[page.docs.length - 1];
}

console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — backfill-agent-session-last-message-at`);
console.log(`  scanned:             ${counts.scanned}`);
console.log(`  completed:           ${counts.completed}`);
console.log(`  explicit clients:    ${counts.explicitClients}`);
console.log(`  caregivers excluded: ${counts.caregiversExcluded}`);
console.log(`  ambiguous role:      ${counts.ambiguousRole}`);
console.log(`  already populated:   ${counts.alreadyPopulated}`);
console.log(`  recent history:      ${counts.recentHistory}`);
console.log(`  stale history:       ${counts.staleHistory}`);
console.log(`  no history:          ${counts.noHistory}`);
console.log(`  would update:        ${counts.wouldUpdate}`);
if (APPLY) console.log(`  updated:             ${counts.updated}`);
else console.log('  Pass --apply to write. Re-run dry-run after apply: would update must be 0.');
process.exit(0);
