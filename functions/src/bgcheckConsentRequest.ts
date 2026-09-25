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
import { appLink } from "./config/appUrl";

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

  const link = appLink("/caregiver/dashboard");
  const title = reason === "renewal" ? "Renew your background check" : "Authorize your background check";
  const body = reason === "renewal"
    ? "Your annual membership renewed. Authorize this year's background check refresh to stay bookable."
    : "Payment received! Next: authorize your background check — it takes about 2 minutes.";
  await db.collection("users").doc(uid).collection("notifications").add({
    userId: uid, type: "background_check_consent", title, body, isRead: false, createdAt: now,
  }).catch(() => {});

  const phone = String(cg.phone || "").trim();
  if (phone) {
    try {
      await textCaregiver(phone, `${body} ${link}`);
    } catch (err) {
      console.error(`requestBackgroundCheckConsent: text to ${uid} failed:`, err);
    }
  }
  return true;
}
