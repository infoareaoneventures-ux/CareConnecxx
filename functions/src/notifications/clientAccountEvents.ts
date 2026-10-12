// users/{uid} changes a FAMILY would see on their dashboard tracker (Identity →
// Membership) → the family hears about each once, bell + text, with the way to
// finish by text (client-notified rule; founder live test 2026-10-04: the admin's
// Approved / Revoked on identity and membership sent the family nothing).
//
// Who changes the record is irrelevant — Stripe webhooks, the admin panel's
// overrides, Evia's own steps — the change lands in onClientAccountChange ONCE.
// Events that already have their own sender stay there: the FIRST membership
// activation (membershipNotify.notifyClientMembershipActivatedOnce, keyed by
// its marker), payment failures and cancellations (stripe.ts dunning texts).
//
// The bell links to the site page; the text finishes by text — the identity
// check link or the membership checkout link, minted and sent by the same
// action Evia uses mid-onboarding (send_onboarding_link client_identity /
// client_payment), so a family with an Evia session never gets "open the app".
import * as admin from "firebase-admin";
import { appLink } from "../config/appUrl";
import { writeUserNotification } from "./userNotification";

type Doc = Record<string, unknown>;

export type ClientAccountEventKind =
  | "identity_verified"
  | "identity_revoked"
  | "membership_reactivated"
  | "membership_revoked";

/** hooks/useAccessGates.tsx: subscriptionActive, or membershipStatus active / trialing. */
export function clientMembershipActive(u: Doc | undefined): boolean {
  if (!u) return false;
  return u.subscriptionActive === true || u.membershipStatus === "active" || u.membershipStatus === "trialing";
}

const identityVerified = (u: Doc | undefined): boolean => u?.identityCheckStatus === "verified";

/**
 * Pure: which events this before→after change represents. The FIRST membership
 * activation is deliberately NOT here (membershipNotify owns it, by marker) — the
 * trigger calls that sender and reports "membership_reactivated" only when the
 * marker says the family already heard the first one.
 */
export function clientAccountTransitions(before: Doc | undefined, after: Doc | undefined): ClientAccountEventKind[] {
  const out: ClientAccountEventKind[] = [];
  if (!after || after.userType === "caregiver") return out;
  const b = before ?? {};
  if (!identityVerified(b) && identityVerified(after)) out.push("identity_verified");
  if (identityVerified(b) && !identityVerified(after)) out.push("identity_revoked");
  const mB = clientMembershipActive(b);
  const mA = clientMembershipActive(after);
  if (!mB && mA && typeof after.membershipActivatedNotifiedAt === "string" && typeof b.membershipActivatedNotifiedAt === "string") {
    out.push("membership_reactivated");
  }
  // A lapse Stripe reports (canceled / payment_failed / past_due) is announced by
  // its Stripe handler with the billing facts; an admin Revoked lands here.
  if (mB && !mA && !["canceled", "payment_failed", "past_due"].includes(String(after.membershipStatus ?? ""))) {
    out.push("membership_revoked");
  }
  return out;
}

export interface ClientEventContext { needsMembership?: boolean }

/** Bell body (links to the page) + text (finishes by text). `linkType` is the link the text promises "right below". */
export function clientAccountEventCopy(kind: ClientAccountEventKind, ctx: ClientEventContext = {}): {
  title: string; body: string; text: string; linkType?: "client_identity" | "client_payment"; fallbackPath: string;
} {
  switch (kind) {
    case "identity_verified":
      return ctx.needsMembership
        ? {
            title: "Identity verified",
            body: `Your identity check is verified. Next: activate your membership to message and book care providers. ${appLink("/client/membership")}`,
            text: "Evia: your identity check is verified ✅ Next: activate your membership to message, interview and book the care providers you've seen — the link is right below.",
            linkType: "client_payment",
            fallbackPath: "/client/membership",
          }
        : {
            title: "Identity verified",
            body: "Your identity check is verified. You're all set to message and book care providers.",
            text: "Evia: your identity check is verified ✅ You're all set to message, interview and book the care providers you've seen.",
            fallbackPath: "/client/dashboard",
          };
    case "identity_revoked":
      return {
        title: "Identity check needed",
        body: `Your identity verification was reset. Redo the quick ID check to message and book care providers: ${appLink("/client/dashboard")}`,
        text: "Evia: your identity verification was reset. Redo the quick ID check to message and book care providers — the link is right below.",
        linkType: "client_identity",
        fallbackPath: "/client/dashboard",
      };
    case "membership_revoked":
      return {
        title: "Membership inactive",
        body: `Your membership is inactive. Activate it to message, interview and book care providers: ${appLink("/client/membership")}`,
        text: "Evia: your membership is inactive. Activate it to message, interview and book care providers — the link is right below.",
        linkType: "client_payment",
        fallbackPath: "/client/membership",
      };
    case "membership_reactivated":
      return {
        title: "Membership active",
        body: "Your membership is active again. You can message and book care providers.",
        text: "Evia: your membership is active again — you're all set to message, interview and book care providers.",
        fallbackPath: "/client/dashboard",
      };
  }
}

/**
 * Texts the Evia step machine is about to send itself — bell only (one message per
 * event, same rule as the caregiver side): a family parked at the identity or
 * payment gate hears "you're verified" + the price from the step handler
 * (advanceOnboardingStep identity / admin_identity_override).
 */
export function clientLifecycleTextOwnedByGate(kind: ClientAccountEventKind, step: unknown): boolean {
  const s = String(step ?? "");
  if (kind === "identity_verified") return ["client_awaiting_identity", "client_ask_plan", "client_send_payment", "client_awaiting_payment"].includes(s);
  if (kind === "membership_reactivated") return ["client_send_payment", "client_awaiting_payment"].includes(s);
  return false;
}

export interface NotifyClientOptions { eventId: string; ctx?: ClientEventContext }

/** Bell + text, once. Returns what actually went out. */
export async function notifyClientAccountEvent(uid: string, kind: ClientAccountEventKind, opts: NotifyClientOptions): Promise<{ bell: boolean; text: boolean }> {
  const db = admin.firestore();
  const copy = clientAccountEventCopy(kind, opts.ctx ?? {});
  const created = await writeUserNotification({
    sourcePath: `users/${uid}`,
    eventId: opts.eventId,
    recipientId: uid,
    transitionType: kind,
    type: `client_${kind}`,
    title: copy.title,
    body: copy.body,
    data: { kind },
  }).catch((err) => { console.error(`[clientAccountEvents] bell failed (${kind}) for ${uid}:`, err); return false; });
  if (!created) return { bell: false, text: false };

  const userSnap = await db.collection("users").doc(uid).get().catch(() => null);
  const phone = (userSnap?.data()?.phone as string | undefined) || undefined;
  if (!phone) return { bell: true, text: false };
  try {
    const sessSnap = await db.collection("agent_sessions").doc(phone).get();
    const sess = (sessSnap.exists ? sessSnap.data() : undefined) as Doc | undefined;
    if (sess && clientLifecycleTextOwnedByGate(kind, sess.onboardingStep)) return { bell: true, text: false };
    if (sess && sess.optedOut !== true) {
      const { sendViaInteractionAgent } = await import("../agents/caraAgent");
      await sendViaInteractionAgent(phone, { content: copy.text, urgency: "immediate", sourceAgent: "client_account_event", canDrop: false });
      if (copy.linkType) {
        // The same link Evia mints mid-onboarding (texts the tappable card itself).
        const { runSendOnboardingLinkAction } = await import("../agents/actions/sendOnboardingLinkAction");
        await runSendOnboardingLinkAction({ phone, linkType: copy.linkType }, { caller: "system", role: "client", phone })
          .catch((err) => console.error(`[clientAccountEvents] link (${copy.linkType}) failed for ${uid}:`, err));
      }
      return { bell: true, text: true };
    }
    if (sess) return { bell: true, text: false }; // opted out: bell only
    // No Evia conversation yet (site-only family): plain text with the page link.
    const { sendToPhone } = await import("../linq/client");
    await sendToPhone(phone, `${copy.text.replace(" — the link is right below.", ".")} ${appLink(copy.fallbackPath)}`);
    return { bell: true, text: true };
  } catch (err) {
    console.error(`[clientAccountEvents] text failed (${kind}) for ${uid}:`, err);
    return { bell: true, text: false };
  }
}
