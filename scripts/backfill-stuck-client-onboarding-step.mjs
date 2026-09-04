/**
 * One-time repair for agent_sessions stuck on an early client onboarding step
 * (2026-09-03 root-cause fix).
 *
 * agent_sessions.onboardingStep only ever advanced to "complete" via
 * advanceOnboardingStep('payment', ...), which fires from Stripe's
 * checkout.session.completed ONLY when the checkout was created by Evia's own
 * SMS flow (session.metadata.task === 'client_payment_setup'). A client who
 * finished membership through the WEBSITE's own checkout instead never
 * triggered that call, so their session stayed parked on an early client_*
 * step forever — even though the real account is fully active — and any
 * later text they sent kept re-firing that step's scripted handler against
 * stale onboarding-time data (wrong caregiver shown, wrong location used).
 *
 * functions/src/stripe.ts's handleSubscriptionUpdated now repairs this going
 * forward on the next customer.subscription.updated event (a renewal, a plan
 * change, etc.) for each affected account — but that could be weeks away for
 * an account that isn't due to renew soon. This script applies the identical
 * repair immediately, once, across every existing stuck session, using the
 * exact same safety condition: only touches a session when membership is
 * genuinely active/trialing AND identity is genuinely verified. A client
 * still legitimately mid-onboarding (missing either) is never touched.
 *
 * Output is AGGREGATE COUNTS ONLY (no phones, no IDs, no content).
 * Idempotent: after --apply, a re-run in dry-run mode must report
 * "would update = 0".
 *
 * Usage:
 *   node scripts/backfill-stuck-client-onboarding-step.mjs           # dry run
 *   node scripts/backfill-stuck-client-onboarding-step.mjs --apply   # write
 */
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
const APPLY = process.argv.includes('--apply');

const PAGE_SIZE = 300;

// Mirrors functions/src/stripe.ts's handleSubscriptionUpdated resync list —
// keep both in sync if that list ever changes.
const STUCK_PRE_PAYMENT_CLIENT_STEPS = new Set([
  'client_confirm_intake', 'client_ask_plan', 'client_payment', 'client_identity',
]);

function isMembershipActive(userData) {
  return userData?.subscriptionActive === true
    || userData?.membershipStatus === 'active'
    || userData?.membershipStatus === 'trialing';
}

const counts = {
  scanned: 0,
  notClient: 0,
  notOnStuckStep: 0,
  noUserId: 0,
  userDocMissing: 0,
  identityNotVerified: 0,
  membershipNotActive: 0,
  wouldUpdate: 0,
  updated: 0,
  updateFailed: 0,
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

    if (data.userType !== 'client') { counts.notClient++; continue; }
    if (!STUCK_PRE_PAYMENT_CLIENT_STEPS.has(data.onboardingStep)) { counts.notOnStuckStep++; continue; }
    if (!data.userId) { counts.noUserId++; continue; }

    const userSnap = await db.collection('users').doc(data.userId).get();
    if (!userSnap.exists) { counts.userDocMissing++; continue; }
    const userData = userSnap.data();

    if (userData.identityCheckStatus !== 'verified') { counts.identityNotVerified++; continue; }
    if (!isMembershipActive(userData)) { counts.membershipNotActive++; continue; }

    counts.wouldUpdate++;
    if (APPLY) {
      try {
        await doc.ref.update({ onboardingStep: 'complete' });
        counts.updated++;
      } catch {
        counts.updateFailed++;
      }
    }
  }

  cursor = page.docs[page.docs.length - 1].id;
  if (page.docs.length < PAGE_SIZE) break;
}

console.log(`Mode: ${APPLY ? 'APPLY (wrote changes)' : 'DRY RUN (no changes written)'}`);
console.log(JSON.stringify(counts, null, 2));
process.exit(0);
