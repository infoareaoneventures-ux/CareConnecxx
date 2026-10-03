// Consent-first background checks (founder, 2026-09-25: "the consent should be
// fixed", "the renewal would have to happen yearly").
//
// Order on the site path used to be pay → Checkr invitation → consent form.
// Now, both after the first membership payment and at every annual renewal,
// the account is parked on "awaiting consent": the caregiver is told (bell +
// text) to authorize the check on their dashboard, and ONLY the FCRA consent
// form (`initiateCheckrCandidate`) creates the Checkr invitation — mirroring
// Evia's SMS order (/bgcheck page → confirmBgcheckConsent), which was already
// consent-first. A renewal also resets the verified state so the yearly
// refresh is not optional.
import * as admin from "firebase-admin";

export type ConsentReason = "initial" | "renewal";

/** Best-effort caregiver text: interaction agent when a session exists, else a fresh chat. */
export async function textCaregiver(phone: string, content: string): Promise<void> {
  const db = admin.firestore();
  const sessSnap = await db.collection("agent_sessions").doc(phone).get();
  if (sessSnap.exists) {
    const { sendViaInteractionAgent } = await import("./agents/caraAgent");
    await sendViaInteractionAgent(phone, { content, urgency: "immediate", sourceAgent: "checkr_status", canDrop: false });
    return;
  }
  const { sendToPhone } = await import("./linq/client");
  await sendToPhone(phone, content);
}

/**
 * Park the account on "authorize your background check" and tell the caregiver.
 * Idempotent: an initial request on an account whose check is already under way
 * (live invitation) is a no-op; a renewal always re-asks.
 */
export async function requestBackgroundCheckConsent(uid: string, reason: ConsentReason): Promise<boolean> {
  const db = admin.firestore();
  const ref = db.collection("caregivers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const cg = (snap.data() || {}) as Record<string, any>;
  const bg = (cg.backgroundCheckData || {}) as Record<string, any>;

  if (reason === "initial") {
    const liveInvitation = !!bg.checkrCandidateId
      && bg.invitationStatus !== "expired" && bg.invitationStatus !== "canceled" && bg.invitationStatus !== "awaiting_consent";
    if (liveInvitation) return false;
    if (bg.consentRequired === true && bg.consentReason === "initial") return false; // already asked
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    verificationStatus: "submitted",
    backgroundCheckData: {
      ...bg,
      consentRequired: true,
      consentRequestedAt: now,
      consentReason: reason,
      invitationStatus: "awaiting_consent",
      status: "pending",
      ...(reason === "renewal" ? { checkrClearedAt: null, invitationUrl: null } : {}),
    },
    ...(reason === "renewal" ? { verified: false, backgroundCheckStatus: "pending", backgroundCheckComplete: false } : {}),
  };
  await ref.set(patch, { merge: true });
  await db.collection("users").doc(uid).set({ verificationStatus: "submitted" }, { merge: true }).catch(() => {});
  // Evia's text session caches the last Checkr invitation link (bgcheckInviteUrl) so
  // "send me the link again" re-sends it. A fresh consent ask makes that link stale —
  // clear it so the resend mints the /bgcheck consent page instead (2026-10-03).
  const phone = typeof cg.phone === "string" ? cg.phone : undefined;
  if (phone) {
    await db.collection("agent_sessions").doc(phone)
      .update({ bgcheckInviteUrl: null, bgcheckInviteSentAt: null })
      .catch(() => { /* no text session for this caregiver */ });
  }

  // The caregiver is told ONCE through notifications/caregiverAccountEvents.ts:
  // a first payment by the record change (membership_paid: "Next: authorize
  // your background check"), a renewal by its invoice (membership_renewed).
  // Nothing is sent from here (2026-09-27).
  return true;
}
