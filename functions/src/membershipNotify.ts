import * as admin from "firebase-admin";

// "Your membership is active" — once per account, on the FIRST activation,
// whichever path paid (Evia's texted checkout link, the site's plan modal) and
// whichever Stripe event lands first (checkout.session.completed and
// invoice.payment_succeeded both fire for a new subscription). The site shows
// the active plan on the Membership page the moment the doc flips, so the
// family hears it over text and in the bell at the same moment (client-notified
// rule). Live 2026-09-20: the founder paid and got no notice of any kind.
//
// Renewals are deliberately excluded (billing_reason subscription_cycle) — the
// invoice handler already emails those.

const MARKER = "membershipActivatedNotifiedAt";

export const MEMBERSHIP_ACTIVE_TEXT =
  "Evia: your membership is active — you're all set to message and book the caregivers you've seen. I'll keep you posted on every visit.";

export async function notifyClientMembershipActivatedOnce(uid: string): Promise<boolean> {
  if (!uid) return false;
  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);

  // Claim the marker atomically so two webhook events can't both notify.
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = (snap.data() ?? {}) as Record<string, unknown>;
      if (d[MARKER]) return false;
      if (d.userType === "caregiver") return false;
      tx.set(ref, { [MARKER]: new Date().toISOString() }, { merge: true });
      return true;
    });
  } catch {
    // Test doubles / rare transaction failures: fall back to a plain check-then-set.
    const snap = await ref.get();
    const d = (snap.data() ?? {}) as Record<string, unknown>;
    if (d[MARKER] || d.userType === "caregiver") return false;
    await ref.set({ [MARKER]: new Date().toISOString() }, { merge: true });
    claimed = true;
  }
  if (!claimed) return false;

  await ref.collection("notifications").add({
    userId: uid,
    type: "membership_activated",
    title: "Membership active",
    body: "Your Evia membership is active. You can message and book the caregivers you've seen — Evia will keep you posted on every visit.",
    data: {},
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch((err) => console.warn("membership bell failed", err instanceof Error ? err.message : err));

  try {
    const { sendSMSToUser } = await import("./sms");
    await sendSMSToUser(uid, MEMBERSHIP_ACTIVE_TEXT);
  } catch (err) {
    console.warn("membership text failed", err instanceof Error ? err.message : err);
  }
  return true;
}
