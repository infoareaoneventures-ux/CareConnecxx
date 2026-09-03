import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { cancelSubscriptionForUser } from "./stripe";

// Client-side account deletion used to be just `auth.currentUser.delete()`
// (services/api.ts) — it removed the login but left every Firestore document
// and any active Stripe subscription untouched, so billing kept running
// against a customer record with no linked account. This is the real
// deletion: stop billing, remove the account's data, then remove the login,
// all server-side (client code can't safely do any of this).
export interface DeleteAccountResult { deleted: true }

export async function deleteAccountForUser(userId: string): Promise<DeleteAccountResult> {
  const db = admin.firestore();

  // Stop billing first. "No active subscription" just means there was
  // nothing to cancel — fine. Anything else should surface.
  try {
    await cancelSubscriptionForUser(userId);
  } catch (err: any) {
    if (!/no active subscription/i.test(err?.message ?? "")) throw err;
  }

  const [userSnap, caregiverSnap, customerSnap, seniorByIdSnap, seniorByFieldSnap] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("caregivers").doc(userId).get(),
    db.collection("customers").doc(userId).get(),
    db.collection("senior_profiles").doc(userId).get(),
    db.collection("senior_profiles").where("userId", "==", userId).get(),
  ]);

  const phone = (userSnap.data()?.phone as string | undefined)
    ?? (caregiverSnap.data()?.phone as string | undefined);

  const batch = db.batch();
  if (userSnap.exists) batch.delete(userSnap.ref);
  if (caregiverSnap.exists) batch.delete(caregiverSnap.ref);
  if (customerSnap.exists) batch.delete(customerSnap.ref);
  if (seniorByIdSnap.exists) batch.delete(seniorByIdSnap.ref);
  for (const doc of seniorByFieldSnap.docs) {
    if (doc.id !== seniorByIdSnap.id || !seniorByIdSnap.exists) batch.delete(doc.ref);
  }
  await batch.commit();

  // agent_sessions is keyed by phone, not uid — clear it so a deleted
  // account's Evia conversation can't linger for whoever gets the number.
  if (phone) {
    await db.collection("agent_sessions").doc(phone).delete().catch(() => {});
  }

  await admin.auth().deleteUser(userId).catch((err: any) => {
    if (err?.code !== "auth/user-not-found") throw err;
  });

  return { deleted: true };
}

export const deleteAccount = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }
  try {
    return await deleteAccountForUser(context.auth.uid);
  } catch (error: any) {
    throw new functions.https.HttpsError("internal", error?.message ?? "Failed to delete account");
  }
});
