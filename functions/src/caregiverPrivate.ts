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
