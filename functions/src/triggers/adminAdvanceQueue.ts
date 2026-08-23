import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();

const TASK_MAP: Record<string, string> = {
  advance_client_identity:        "admin_identity_override",
  advance_client_payment:         "admin_payment_override",
  advance_caregiver_membership:   "admin_caregiver_membership_override",
  advance_caregiver_bgcheck:      "admin_caregiver_bgcheck_override",
  // Reuses the real "stripe_connect" task literal (see below) rather than a
  // new admin_*_override case — it's already idempotent/step-guarded, and the
  // real Stripe webhook (stripeConnectWebhook.ts) calls it the exact same way
  // once it finishes writing payoutsEnabled/chargesEnabled itself.
  advance_caregiver_stripe_connect: "stripe_connect",
};

export const processAdminAdvanceQueue = functions.firestore
  .document("adminAdvanceQueue/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() as { type: string; uid: string };
    const { type, uid } = data;

    const task = TASK_MAP[type];
    if (!task) {
      await snap.ref.update({
        error: `Unknown type: ${type}`,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    let phone: string | undefined;

    const userDoc = await db.collection("users").doc(uid).get();
    phone = userDoc.data()?.phone;

    if (!phone) {
      const cgDoc = await db.collection("caregivers").doc(uid).get();
      phone = cgDoc.data()?.phone;
    }

    if (!phone) {
      const authUser = await admin.auth().getUser(uid).catch(() => null);
      phone = authUser?.phoneNumber ?? undefined;
    }

    if (!phone) {
      await snap.ref.update({
        error: `No phone number found for uid=${uid}`,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    try {
      // Admin manually approved Stripe Connect payout setup — mirror the same
      // dual-write (parent + private/payout) stripeConnectWebhook.ts does for
      // a real account.updated event, so the caregiver dashboard's "Payout
      // Setup" checklist step reflects it before calling the same
      // stripe_connect finalize task the real webhook calls.
      if (type === "advance_caregiver_stripe_connect") {
        const { writeCaregiverPayoutPrivate } = await import("../caregiverPrivate");
        const payoutUpdate = {
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          stripeOnboardingComplete: true,
          stripeOnboardingCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("caregivers").doc(uid).update(payoutUpdate).catch(() => {});
        await writeCaregiverPayoutPrivate(uid, payoutUpdate);
      }

      const { advanceOnboardingStep } = await import("../agents/onboardingConversation");
      await advanceOnboardingStep(phone, task, "");
      await snap.ref.update({
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: null,
      });
    } catch (err) {
      await snap.ref.update({
        error: err instanceof Error ? err.message : String(err),
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      throw err;
    }
  });
