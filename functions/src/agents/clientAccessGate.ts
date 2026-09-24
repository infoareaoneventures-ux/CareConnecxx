// The website's paywall for families, exactly — hooks/useAccessGates.tsx
// `gate(action, caregiverName, onPass)`:
//   1. identity verification first (users.identityCheckStatus === "verified"),
//   2. then an active membership (subscriptionActive, or membershipStatus
//      active / trialing),
// for the SAME three action types the site gates: message, booking, interview.
// Viewing pages is never gated on the site, so read-only tools never call this.
//
// On the site a blocked click opens IdentityGateModal / PlanSelectModal. Over
// SMS the "modal" is one text with the modal's copy followed by the same CTA
// the modal offers — the Stripe Identity link, or the membership checkout link
// (sendOnboardingLink "client_identity" / "client_payment", the links Evia
// already mints during onboarding). A membership block also records the site's
// paywall-view signal (lastPaywallViewedAt + paywallContext) for the win-back job.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { appLink } from "../config/appUrl";

const db = admin.firestore();

export type ClientGateAction = "message" | "booking" | "interview";
export type ClientGateBlock = "identity" | "membership";
export type ClientGateResult = { ok: true } | { ok: false; block: ClientGateBlock };

// useAccessGates.tsx: `!!data.subscriptionActive || membershipStatus === 'active' || membershipStatus === 'trialing'`
export function isClientMembershipActive(u: Record<string, unknown> | undefined | null): boolean {
  if (!u) return false;
  return u.subscriptionActive === true || u.membershipStatus === "active" || u.membershipStatus === "trialing";
}

export async function checkClientAccess(
  clientId: string,
  action: ClientGateAction,
  caregiverName?: string,
): Promise<ClientGateResult> {
  const snap = await db.collection("users").doc(clientId).get();
  const u = (snap.exists ? snap.data() : undefined) ?? {};
  if (u.identityCheckStatus !== "verified") return { ok: false, block: "identity" };
  if (!isClientMembershipActive(u)) {
    // The site's paywall-view signal (useAccessGates.tsx) — same fields, merge write.
    // Best-effort, like the site's own `.catch(() => {})` — never blocks the gate itself.
    try {
      await db.collection("users").doc(clientId).set({
        lastPaywallViewedAt: new Date().toISOString(),
        paywallContext: { caregiverName: caregiverName ?? null, action },
      }, { merge: true });
    } catch { /* signal only */ }
    return { ok: false, block: "membership" };
  }
  return { ok: true };
}

// IdentityGateModal.tsx copy (the modal says "contact" for every action).
function identityGateText(caregiverName?: string): string {
  const lead = caregiverName
    ? `To contact ${caregiverName}, you need to complete a quick identity check. Pick up where you left off!`
    : "To contact caregivers, you need to complete a quick identity check. Pick up where you left off!";
  return `${lead} It's a secure check with our safety partner Stripe Identity — you'll take a photo of your government ID and a quick selfie. Here's your link to continue:`;
}

// PlanSelectModal.tsx header: "Select a plan to book/interview/contact {name}".
function membershipGateText(action: ClientGateAction, caregiverName?: string): string {
  const verb = action === "booking" ? "book" : action === "interview" ? "interview" : "contact";
  const header = caregiverName ? `Select a plan to ${verb} ${caregiverName}` : "Select a plan to continue";
  return `${header} — your membership isn't active right now. Here's where to pick your plan:`;
}

export function clientGateText(block: ClientGateBlock, action: ClientGateAction, caregiverName?: string): string {
  return block === "identity" ? identityGateText(caregiverName) : membershipGateText(action, caregiverName);
}

// The modal, over SMS: its copy, then its CTA link.
export async function textClientGateBlock(
  phone: string, chatId: string, block: ClientGateBlock, action: ClientGateAction, caregiverName?: string,
): Promise<void> {
  await sendMessage(chatId, clientGateText(block, action, caregiverName));
  try {
    const { sendOnboardingLink } = await import("./onboardingConversation");
    const sent = await sendOnboardingLink(phone, block === "identity" ? "client_identity" : "client_payment");
    if (sent.success) return;
  } catch (err) {
    console.error("clientAccessGate: link mint failed, falling back to the site page", err);
  }
  // Fallback: the site page where the same modal's CTA lives.
  await sendMessage(chatId, { parts: [{ type: "link", value: appLink(block === "identity" ? "/client/dashboard" : "/client/membership") }] });
}

// Flow entry/commit helper: true = blocked (and the family has already been texted).
export async function enforceClientGate(
  phone: string, chatId: string, clientId: string, action: ClientGateAction, caregiverName?: string,
): Promise<boolean> {
  const res = await checkClientAccess(clientId, action, caregiverName);
  if (res.ok) return false;
  await textClientGateBlock(phone, chatId, res.block, action, caregiverName);
  return true;
}

// Tool-path helper: find the family's Evia conversation so the block can be
// texted from a tool that only knows the clientId.
export async function findClientSession(clientId: string, phone?: unknown): Promise<{ phone: string; chatId: string } | null> {
  if (typeof phone === "string" && phone) {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    const chatId = snap.data()?.chatId as string | undefined;
    if (chatId) return { phone, chatId };
  }
  const q = await db.collection("agent_sessions").where("userId", "==", clientId).limit(1).get();
  const doc = q.docs[0];
  const chatId = doc?.data()?.chatId as string | undefined;
  return doc && chatId ? { phone: doc.id, chatId } : null;
}

