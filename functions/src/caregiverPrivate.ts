import * as admin from "firebase-admin";

/**
 * Caregiver identity PII lived on the world-readable `caregivers/{id}` doc
 * (firestore.rules: `allow read: if isAuthenticated()`), which clients read
 * directly for browsing/booking — so any signed-in user could read every
 * caregiver's legal name / DOB / SSN-last-4 / ZIP by a raw SDK query.
 *
 * These fields move to `caregivers/{id}/private/background`, readable only by
 * the owner or an admin (firestore.rules), written only by the Admin SDK here
 * (client writes denied). The OPERATIONAL bg-check fields (status,
 * checkrCandidateId, invitationStatus, submittedAt, …) intentionally STAY on
 * the parent doc: the agent loop and the admin verification query read them for
 * gating and they are not disclosure-sensitive. Only true identity PII moves.
 *
 * All current writers of these fields are server-side (v1-initiateCheckrCandidate,
 * the SMS confirmBgcheckConsent path, the Stripe membership/renewal webhook), so
 * routing them here does not break any client write path.
 */
export const CAREGIVER_PII_BACKGROUND_FIELDS = [
  "legalFirstName",
  "legalLastName",
  "dob",
  "ssnLastFour",
  "zip",
] as const;

export type CaregiverBackgroundPII = Partial<
  Record<(typeof CAREGIVER_PII_BACKGROUND_FIELDS)[number], unknown>
>;

// Lazy — never touch admin at module load, so importing this leaf helper
// doesn't require callers/tests to fully mock firebase-admin.
const privateBackgroundRef = (caregiverId: string) =>
  admin.firestore().collection("caregivers").doc(caregiverId).collection("private").doc("background");

/** Keep only the known PII keys with a defined value. */
export function pickBackgroundPII(source: Record<string, unknown> | undefined | null): CaregiverBackgroundPII {
  const out: CaregiverBackgroundPII = {};
  if (!source) return out;
  for (const k of CAREGIVER_PII_BACKGROUND_FIELDS) {
    if (source[k] !== undefined && source[k] !== null) out[k] = source[k];
  }
  return out;
}

/**
 * Write caregiver identity PII to the private subcollection (merge). No-op when
 * there is nothing to write, so callers can pass a partial blob unconditionally.
 */
export async function writeCaregiverBackgroundPII(
  caregiverId: string,
  pii: CaregiverBackgroundPII,
): Promise<void> {
  const clean = pickBackgroundPII(pii as Record<string, unknown>);
  if (Object.keys(clean).length === 0) return;
  await privateBackgroundRef(caregiverId).set(clean, { merge: true });
}

/** Read caregiver identity PII from the private subcollection (Admin SDK). */
export async function readCaregiverBackgroundPII(caregiverId: string): Promise<CaregiverBackgroundPII> {
  const snap = await privateBackgroundRef(caregiverId).get();
  return snap.exists ? (snap.data() as CaregiverBackgroundPII) : {};
}

// ── Payout fields (2026-07-11 follow-up wave) ────────────────────────────────
//
// stripeAccountId + the Connect gating booleans also lived on the
// world-readable caregivers/{id} parent. They move to
// caregivers/{id}/private/payout (covered by the same owner||admin
// `match /private/{docId}` rule, client write denied). Server writers
// DUAL-WRITE parent + private until the backfill's deleteParent phase runs;
// server readers go private-first with a parent fallback, so payouts can
// never break on a doc the backfill hasn't reached. The Stripe webhooks look
// caregivers up BY accountId (a collection query the subcollection can't
// serve), so account creation also maintains a stripe_accounts/{accountId}
// → { caregiverId } reverse map.

export const CAREGIVER_PAYOUT_PRIVATE_FIELDS = [
  "stripeAccountId",
  "chargesEnabled",
  "payoutsEnabled",
  "detailsSubmitted",
  "stripeOnboardingComplete",
  "stripeOnboardingCompletedAt",
  "stripeAccountCreatedAt",
] as const;

export type CaregiverPayoutPrivate = Partial<
  Record<(typeof CAREGIVER_PAYOUT_PRIVATE_FIELDS)[number], unknown>
>;

const privatePayoutRef = (caregiverId: string) =>
  admin.firestore().collection("caregivers").doc(caregiverId).collection("private").doc("payout");

const stripeAccountMapRef = (accountId: string) =>
  admin.firestore().collection("stripe_accounts").doc(accountId);

/** Keep only the known payout keys with a defined value. */
export function pickPayoutPrivate(source: Record<string, unknown> | undefined | null): CaregiverPayoutPrivate {
  const out: CaregiverPayoutPrivate = {};
  if (!source) return out;
  for (const k of CAREGIVER_PAYOUT_PRIVATE_FIELDS) {
    if (source[k] !== undefined && source[k] !== null) out[k] = source[k];
  }
  return out;
}

/**
 * Merge payout fields into caregivers/{id}/private/payout, and maintain the
 * stripe_accounts reverse map when a stripeAccountId is present. Best-effort
 * by design: the parent write (still the read-fallback) has already happened,
 * so a transient failure here must never fail the caller's money path.
 */
export async function writeCaregiverPayoutPrivate(
  caregiverId: string,
  fields: CaregiverPayoutPrivate,
): Promise<void> {
  const clean = pickPayoutPrivate(fields as Record<string, unknown>);
  if (Object.keys(clean).length === 0) return;
  try {
    await privatePayoutRef(caregiverId).set(clean, { merge: true });
    if (typeof clean.stripeAccountId === "string" && clean.stripeAccountId) {
      await stripeAccountMapRef(clean.stripeAccountId).set(
        { caregiverId, updatedAt: new Date().toISOString() },
        { merge: true },
      );
    }
  } catch (err) {
    console.error(`writeCaregiverPayoutPrivate(${caregiverId}) failed (parent copy still authoritative):`, err);
  }
}

/**
 * Read the payout fields for a caregiver: private/payout first, parent-doc
 * fallback for docs the backfill hasn't reached (or if the private read
 * errors — post-deletion that direction fails toward "no account", which
 * aborts a payout instead of misrouting it). Pass `parentData` when the
 * caller already loaded the caregiver doc to save a read.
 */
export async function getCaregiverPayoutFields(
  caregiverId: string,
  parentData?: Record<string, unknown> | null,
): Promise<CaregiverPayoutPrivate> {
  let priv: Record<string, unknown> = {};
  try {
    const snap = await privatePayoutRef(caregiverId).get();
    if (snap.exists) priv = snap.data() ?? {};
  } catch (err) {
    console.error(`getCaregiverPayoutFields(${caregiverId}) private read failed, using parent fallback:`, err);
  }
  let parent: Record<string, unknown> = {};
  if (parentData !== undefined) {
    parent = parentData ?? {};
  } else {
    try {
      const snap = await admin.firestore().collection("caregivers").doc(caregiverId).get();
      parent = snap.exists ? (snap.data() ?? {}) : {};
    } catch {
      parent = {};
    }
  }
  const out: CaregiverPayoutPrivate = {};
  for (const k of CAREGIVER_PAYOUT_PRIVATE_FIELDS) {
    const v = priv[k] !== undefined ? priv[k] : parent[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Resolve a caregiverId from a Stripe account id — reverse map first, then
 * the legacy parent-field query (needed until the backfill has run; harmless
 * after). Returns null when unknown.
 */
export async function resolveCaregiverByStripeAccount(accountId: string): Promise<string | null> {
  if (!accountId) return null;
  try {
    const mapSnap = await stripeAccountMapRef(accountId).get();
    const mapped = mapSnap.exists ? (mapSnap.data()?.caregiverId as string | undefined) : undefined;
    if (mapped) return mapped;
  } catch (err) {
    console.error(`resolveCaregiverByStripeAccount(${accountId}) map read failed:`, err);
  }
  try {
    const q = await admin.firestore().collection("caregivers")
      .where("stripeAccountId", "==", accountId)
      .limit(1)
      .get();
    if (!q.empty) return q.docs[0].id;
  } catch (err) {
    console.error(`resolveCaregiverByStripeAccount(${accountId}) query fallback failed:`, err);
  }
  return null;
}
