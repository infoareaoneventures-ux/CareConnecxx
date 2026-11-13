import * as admin from "firebase-admin";
import { cancelSubscriptionForUser } from "./stripe";
import { releaseAccountTies } from "./accountDeletionTies";

// Client-side account deletion used to be just `auth.currentUser.delete()`
// (services/api.ts) — it removed the login but left every Firestore document
// and any active Stripe subscription untouched, so billing kept running
// against a customer record with no linked account. This is the real
// deletion: stop billing, remove the account's data, then remove the login,
// all server-side (client code can't safely do any of this).
//
// This is a plain function, not a Cloud Function itself — the website reaches
// it via the account_action_requests Firestore-trigger queue
// (functions/src/triggers/accountActionQueue.ts), and Evia's delete_account
// MCP tool calls it directly, in-process. See accountRecovery.ts's header
// comment for why (a brand-new public onCall function can't get its invoker
// IAM set on this project).
export interface DeleteAccountResult { deleted: true }

export async function deleteAccountForUser(
  userId: string,
  opts: { beforeLoginRemoved?: () => Promise<void> } = {},
): Promise<DeleteAccountResult> {
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

  // Release what the account leaves on the other side (visits, applications, job posts, public profile,
  // conversations) BEFORE the records go, so the normal notices carry the right names. Best-effort per step.
  await releaseAccountTies(db, userId, caregiverSnap.exists);

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

  // Tell the caller the deletion is done BEFORE the login goes (2026-11-09): the page watches its request
  // document with the very login that is about to be removed, so a result written afterwards was never seen
  // and the page stayed on "Deleting…" until it was reloaded.
  await opts.beforeLoginRemoved?.().catch((err) => console.error("[deleteAccountForUser] beforeLoginRemoved failed:", err instanceof Error ? err.message : err));

  await admin.auth().deleteUser(userId).catch((err: any) => {
    if (err?.code !== "auth/user-not-found") throw err;
  });

  return { deleted: true };
}
