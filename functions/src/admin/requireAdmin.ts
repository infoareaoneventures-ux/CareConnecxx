import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

/**
 * Shared admin-role gate for admin-only callables.
 *
 * The historical pattern in adminAlerts.ts only checked `context.auth` (i.e.
 * "is someone logged in") — NOT whether that someone is an admin. That is the
 * gap U3 closes: every admin callable must verify the caller actually holds the
 * admin role before mutating verification, payment, support, or ledger state.
 *
 * Admin is defined exactly as firestore.rules `isAdmin()`:
 *   users/{uid}.userType === 'admin'  OR  users/{uid}.isAdmin === true
 *
 * Throws functions.https.HttpsError("permission-denied", ...) when the caller is
 * unauthenticated or not an admin; otherwise resolves to the admin's uid so the
 * callable can attribute audit/ledger writes to a real operator.
 */
export async function requireAdmin(
  context: functions.https.CallableContext,
): Promise<string> {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Admin access required (not authenticated).",
    );
  }

  const uid = context.auth.uid;
  const snap = await admin.firestore().collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() ?? {} : {};

  const isAdmin = data.userType === "admin" || data.isAdmin === true;
  if (!isAdmin) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Admin access required.",
    );
  }

  return uid;
}
