import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

/**
 * Resolve a referrer's user id from their referralCode, server-side.
 *
 * The client used to run `users.where('referralCode','==',code)` directly, which
 * required the world-open `users` list rule (a full-directory enumeration leak).
 * With that rule tightened to admin-only, the lookup moves here: the Admin SDK
 * bypasses rules, so referral crediting keeps working while clients can no
 * longer enumerate the users collection. Returns { referrerId: null } when no
 * match (same "silently skip" semantics the client catch had).
 */
export const resolveReferrerByCode = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const code = typeof data?.code === "string" ? data.code.trim() : "";
  if (!code) return { referrerId: null };

  const snap = await admin.firestore()
    .collection("users")
    .where("referralCode", "==", code)
    .limit(1)
    .get();
  if (snap.empty) return { referrerId: null };

  const referrerId = snap.docs[0].id;
  // Never let someone credit themselves as their own referrer.
  if (referrerId === context.auth.uid) return { referrerId: null };
  return { referrerId };
});
