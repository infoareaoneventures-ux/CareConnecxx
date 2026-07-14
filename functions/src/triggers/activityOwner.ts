import * as admin from "firebase-admin";

// Owner-resolution for the Evia Activity feed projection, split out of the
// trigger so it is unit-testable without loading firebase-functions (the trigger
// calls functions.firestore.document() at import, which can't run under vitest).

// The convenience feed is a UI surface, not the compliance record (raw
// agent_audit_log keeps the 6-year HIPAA retention). Expire projected entries
// after 1 year. NOTE: a Firestore TTL policy must be enabled on the `ttl` field
// of user_activity_feed (console / gcloud) for these to be auto-deleted.
export const FEED_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Auth-call deadline so a slow (not-down) Auth backend can't exhaust the trigger. */
export const AUTH_CALL_TIMEOUT_MS = 8_000;

/** A transient (retryable) Auth error vs. the expected "not found" skip case. */
export function isNotFound(e: any): boolean {
  return e?.code === "auth/user-not-found" || e?.code === "auth/invalid-phone-number";
}

/** Reject with a retryable error if `p` doesn't settle within the deadline. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout`)), ms)),
  ]);
}

/**
 * Resolve the OWNING FAMILY's Firebase Auth uid for an audit event, then confirm
 * it actually belongs to a family/client (not a caregiver). Returns null when no
 * family owner can be resolved or the resolved user is a caregiver — the event is
 * then skipped, never written under a caregiver/unknown key. This ENFORCES the
 * family-only invariant at the projection boundary rather than assuming the
 * allow-list events are always family-keyed (some, like phone-keyed message_sent
 * to a caregiver, are not).
 *
 * Throws on transient Auth/Firestore errors (network, 5xx, timeout) so the
 * trigger retries rather than silently dropping the event forever.
 */
export async function resolveFamilyOwnerUid(
  db: admin.firestore.Firestore,
  auth: admin.auth.Auth,
  plan: { phone?: string; uidCandidate?: string },
): Promise<string | null> {
  let uid: string | null = null;

  if (plan.phone) {
    const e164 = plan.phone.startsWith("+") ? plan.phone : `+${plan.phone}`;
    try {
      uid = (await withTimeout(auth.getUserByPhoneNumber(e164), AUTH_CALL_TIMEOUT_MS, "getUserByPhoneNumber")).uid;
    } catch (e) {
      if (!isNotFound(e)) throw e; // transient / timeout — let the trigger retry
      // not a known phone — fall through to the uid candidate
    }
  }
  if (!uid && plan.uidCandidate) {
    try {
      await withTimeout(auth.getUser(plan.uidCandidate), AUTH_CALL_TIMEOUT_MS, "getUser");
      uid = plan.uidCandidate;
    } catch (e) {
      if (!isNotFound(e)) throw e; // transient / timeout — let the trigger retry
    }
  }
  if (!uid) return null;

  // Family-only gate: the feed is for families. Skip if the resolved user is a
  // caregiver (e.g. a message Evia sent TO a caregiver, keyed by their phone).
  const userSnap = await db.collection("users").doc(uid).get();
  if (userSnap.exists && (userSnap.data() as any)?.userType === "caregiver") return null;
  return uid;
}
