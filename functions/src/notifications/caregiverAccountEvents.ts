// Caregiver account events — ONE notification path (founder, 2026-09-27):
// for every change the dashboard's "Your progress" bar would show (membership,
// background check, transport documents / driving record / badge, payouts,
// admin approvals and revokes, lapses), the caregiver gets exactly one website
// bell entry and one text with the same words, never twice.
//
// Idempotency: the bell is written through writeUserNotification, keyed on
// (sourcePath, eventId, recipient, event kind); the text goes out ONLY when
// that write created a new entry. A webhook retry, a duplicate Checkr event or
// a second trigger invocation for the same change therefore sends nothing.
//
// Wording: the dashboard card's / bell's own words. No "Reply YES", no reasons,
// no extra pitch — the site says none of that.
import * as admin from "firebase-admin";
import { writeUserNotification } from "./userNotification";
import { appLink } from "../config/appUrl";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";

const db = admin.firestore();

export type CaregiverAccountEventKind =
  | "membership_paid" | "membership_renewed" | "membership_payment_failed"
  | "membership_cancel_scheduled" | "membership_reactivated" | "membership_cancelled" | "membership_revoked"
  | "bgcheck_consent_received" | "bgcheck_clear" | "bgcheck_review" | "bgcheck_on_hold" | "bgcheck_disputed"
  | "bgcheck_canceled" | "bgcheck_action_required" | "bgcheck_not_approved" | "bgcheck_document_required"
  | "bgcheck_link_expired" | "bgcheck_revoked"
  | "mvr_clear" | "mvr_review" | "mvr_not_approved" | "transport_badge_earned" | "transport_badge_lost"
  | "payouts_enabled" | "payouts_disabled"
  | "now_bookable";

export interface CaregiverAccountEventContext {
  /** bgcheck_revoked: no consent link — the membership is not active, and the check is part of it (2026-10-04). */
  membershipInactive?: boolean;
  amount?: string;          // "69.99"
  date?: string;            // a formatted day ("Monday, October 5")
  attempt?: number;         // payment-failed attempt number
  finalAttempt?: boolean;
  nextRetry?: string;       // "Oct 5"
  url?: string;             // the Checkr link on consent
  consentUrl?: string;      // the texted /bgcheck consent page (membership paid / renewed texts)
  renewal?: boolean;
  reason?: "mvr" | "services"; // Transportation came off: driving record, or she removed the service
}

const BILLING_KINDS = new Set<CaregiverAccountEventKind>([
  "membership_paid", "membership_renewed", "membership_payment_failed", "membership_cancel_scheduled",
  "membership_reactivated", "membership_cancelled", "membership_revoked",
]);

// A driving record that came back for review has nothing behind it unless the team
// hears about it (founder, 2026-10-04): one admin alert per event, texted to the
// team by adminAlertNotifier (type listed in its SMS_NOTIFY_TYPES).
async function alertTeamDrivingRecordReview(uid: string, eventId: string): Promise<void> {
  try {
    const snap = await db.collection("caregivers").doc(uid).get();
    const cg = (snap.data() ?? {}) as Record<string, unknown>;
    const name = String(cg.name ?? "A caregiver").trim() || "A caregiver";
    const status = String(cg.mvrStatus ?? "consider");
    await db.collection("admin_alerts").add({
      type: "mvr_review",
      severity: "high",
      resolved: false,
      caregiverId: uid,
      caregiverName: name,
      mvrStatus: status,
      message: `${name}'s driving record check came back "${status}". Transportation is off their profile until you decide — Admin › Caregivers › ${name} › Verification.`,
      dedupeKey: `mvr_review:${uid}:${eventId}`,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[caregiverAccountEvents] admin alert (mvr_review) failed for ${uid}:`, err);
  }
}



/**
 * The bell title + body for each event, plus `text` when the texted wording differs:
 * the bell lives on the site, so it links to the page; the text is Evia's channel,
 * so it finishes by text — the consent page link itself, or the keyword that does
 * the page's button (MANAGE MEMBERSHIP = the Stripe portal, ACTIVATE = the checkout).
 */
export function caregiverAccountEventCopy(kind: CaregiverAccountEventKind, ctx: CaregiverAccountEventContext = {}): { title: string; body: string; text?: string } {
  const dash = appLink("/caregiver/dashboard");
  const membership = appLink("/caregiver/settings"); // Membership & verification lives on Account Settings (2026-10-04)
  switch (kind) {
    case "membership_paid":
      return {
        title: "Membership active",
        body: `Your membership is active. Next: authorize your background check — it takes about 2 minutes. ${dash}`,
        text: `Your membership is active. Next: authorize your background check — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    case "membership_renewed": {
      const charged = ctx.amount ? ` — $${ctx.amount} was charged` : "";
      return {
        title: "Membership renewed",
        body: `Your annual membership renewed${charged}. Authorize this year's background check refresh to stay bookable. ${dash}`,
        text: `Your annual membership renewed${charged}. Authorize this year's background check refresh to stay bookable — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    }
    case "membership_payment_failed": {
      const manage = "reply MANAGE MEMBERSHIP for your Stripe billing link";
      if (ctx.finalAttempt) {
        return {
          title: "Membership payment failed",
          body: `We weren't able to process your Evia membership payment after several tries, so your membership is now at risk of being canceled. To keep your access, please update your payment method at ${membership} today.`,
          text: `We weren't able to process your Evia membership payment after several tries, so your membership is now at risk of being canceled. To keep your access, update your payment method today — ${manage}.`,
        };
      }
      const retry = ctx.nextRetry ? ` We'll retry on ${ctx.nextRetry}.` : "";
      if ((ctx.attempt ?? 1) <= 1) {
        return {
          title: "Membership payment failed",
          body: `Heads up — we couldn't process your Evia membership payment. No action needed if your card just needs a moment, but you can update billing anytime at ${membership}.${retry}`,
          text: `Heads up — we couldn't process your Evia membership payment. No action needed if your card just needs a moment; to update your card, ${manage}.${retry}`,
        };
      }
      const next = ctx.nextRetry ? ` Next retry: ${ctx.nextRetry}.` : "";
      return {
        title: "Membership payment failed",
        body: `We still haven't been able to process your Evia membership payment. Please update your payment method at ${membership} to avoid an interruption.${next}`,
        text: `We still haven't been able to process your Evia membership payment. To avoid an interruption, update your payment method — ${manage}.${next}`,
      };
    }
    case "membership_cancel_scheduled":
      return {
        title: "Membership ending",
        body: `Your Evia membership is set to end on ${ctx.date ?? "your renewal date"}. You keep everything until then, and you can reactivate anytime from the Membership page: ${membership}`,
        text: `Your Evia membership is set to end on ${ctx.date ?? "your renewal date"}. You keep everything until then, and you can reactivate anytime — reply MANAGE MEMBERSHIP for your Stripe billing link.`,
      };
    case "membership_reactivated":
      return { title: "Membership reactivated", body: `Your Evia membership is active again.${ctx.date ? ` Next billing date: ${ctx.date}.` : ""}` };
    case "membership_cancelled":
      return {
        title: "Membership cancelled",
        body: `Your Evia membership has been cancelled. You can reactivate anytime from the Membership page: ${membership}`,
        text: "Your Evia membership has been cancelled. You can reactivate anytime — reply ACTIVATE for your membership link.",
      };
    case "membership_revoked":
      return {
        title: "Membership inactive",
        body: `Your membership is no longer active. Activate your membership to apply to jobs and get booked: ${membership}`,
        text: "Your membership is no longer active. Activate your membership to apply to jobs and get booked — reply ACTIVATE for your membership link.",
      };

    case "bgcheck_consent_received":
      return {
        title: ctx.renewal ? "Background check refresh started" : "Background check started",
        body: ctx.renewal
          ? `Thanks — here's this year's background check refresh. It usually takes about 5 minutes, and your SSN and date of birth go directly to Checkr, never to Evia: ${ctx.url ?? dash}`
          : `Thanks for authorizing! Here's your background check link — it usually takes about 5 minutes, and your SSN and date of birth go directly to Checkr, never to Evia: ${ctx.url ?? dash}`,
      };
    case "bgcheck_clear":
      return { title: "Background check approved", body: "Great news — your background check came back clear." };
    case "bgcheck_review":
      return { title: "Background check needs review", body: "Your background check is under review. This is normal — our team will follow up if anything is needed." };
    case "bgcheck_on_hold":
      return { title: "Background check on hold", body: "Your background check is on hold while Checkr gathers additional information. Check your email from Checkr for next steps." };
    case "bgcheck_disputed":
      return { title: "Background check under dispute", body: "Your background check result is being reviewed following your dispute. We'll update you when it's resolved." };
    case "bgcheck_canceled":
      return { title: "Background check canceled", body: "Your background check was canceled. Please contact support or resubmit." };
    case "bgcheck_action_required":
      return { title: "Background check — action required", body: "A preliminary decision has been made on your background check. Check your email for next steps from Checkr." };
    case "bgcheck_not_approved":
      return { title: "Background check not approved", body: "Unfortunately your background check was not approved. Contact support if you have questions." };
    case "bgcheck_document_required":
      return { title: "Document upload required", body: "Your background check is on hold. Check your email from Checkr — they need you to upload a document to continue." };
    case "bgcheck_link_expired":
      return {
        title: "Verification link expired",
        body: `Your background check link expired. Get a new one from your dashboard — or reply here and Evia will text you a fresh one. ${dash}`,
        text: `Your background check link expired. Authorize again and a fresh one comes right back — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    case "bgcheck_revoked":
      return {
        title: "Background check pending",
        body: `Your background check approval was removed. Complete verification on your dashboard to get booked again: ${dash}`,
        text: ctx.membershipInactive
          ? "Your background check approval was removed. Once your membership is active, I'll text you the link to authorize a new check — it takes about 2 minutes."
          : `Your background check approval was removed. Authorize a new check to get booked again — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };

    case "mvr_clear":
      return { title: "Driving record cleared", body: "Your driving record check came back clear." };
    case "mvr_review":
      // ONE text for the review: what happened and what it affects — no follow-up
      // promise (founder, 2026-10-04); the TEAM is alerted instead (admin_alerts
      // mvr_review, texted to ADMIN_PHONE). transport_badge_lost (reason mvr) stays
      // bell-only so she is not told twice.
      return {
        title: "Driving record under review",
        body: "Your driving record check came back needing a review. Transportation is off your profile for now. Non-driving jobs aren't affected.",
        text: "Your driving record check came back needing a review. Transportation is off your profile for now. Non-driving jobs aren't affected.",
      };
    case "mvr_not_approved":
      // The admin's final decision (2026-10-04): said once, plainly; transport_badge_lost stays bell-only.
      return { title: "Driving record not approved", body: "Your driving record check didn't meet the requirement for Transportation jobs. Non-driving jobs aren't affected.", text: "Your driving record check didn't meet the requirement for Transportation jobs. Non-driving jobs aren't affected." };
    case "transport_badge_earned":
      return { title: "Transportation is live", body: "Families can now see you for Transportation jobs." };
    case "transport_badge_lost":
      // Bell only: the driving-record text (mvr_review / mvr_not_approved) already said it,
      // and removing the service was her own change.
      return {
        title: "Transportation removed from your profile",
        body: ctx.reason === "services"
          ? "You removed Transportation from your services, so families no longer see it on your profile."
          : "Transportation is off your profile while your driving record isn't cleared. Check Settings › Membership & verification.",
        text: "",
      };

    case "payouts_enabled":
      return {
        title: "Payouts set up",
        body: `Your payout account is set up — earnings land in your bank automatically after each paid visit. ${appLink("/caregiver/payments")}`,
        text: "Your payout account is set up — earnings land in your bank automatically after each paid visit. Reply PAYOUTS anytime to see your balance.",
      };
    case "payouts_disabled":
      return {
        title: "Payouts need attention",
        body: `Your payout account needs attention — open Payout Setup on your dashboard to finish: ${dash}`,
        text: "Your payout account needs attention — reply SETUP for your Stripe link to finish.",
      };

    case "now_bookable":
      return { title: "You're approved", body: "You're approved — families can now find and book you." };
  }
}

export interface NotifyOptions {
  /** Stable id for this occurrence (trigger context.eventId, Stripe/Checkr event id, invoice id…). */
  eventId: string;
  ctx?: CaregiverAccountEventContext;
  /** Defaults to caregivers/{uid}. */
  sourcePath?: string;
}

/**
 * Bell + text, once. Returns what actually went out.
 */
/**
 * Texts the Evia step machine is about to send ITSELF — the bell still fires, the
 * lifecycle text stands down so the caregiver gets one message per gate (2026-10-04):
 *  - membership_paid after an Evia-checkout payment (stripe.ts stamps
 *    membershipRecordedAt on the session right before the record flips; the
 *    step then sends the consent page with its explanation). A SITE payment
 *    never stamps it, so that caregiver still gets this text.
 *  - bgcheck_clear while the session waits at a background-check or payout step
 *    (advanceOnboardingStep moves it to payouts and sends that link with
 *    "your check cleared").
 */
export function lifecycleTextOwnedByGate(
  kind: CaregiverAccountEventKind,
  session: { onboardingStep?: unknown; membershipRecordedAt?: unknown } | undefined,
  now: number = Date.now(),
): boolean {
  if (!session) return false;
  if (kind === "membership_paid") {
    const at = Date.parse(String(session.membershipRecordedAt ?? ""));
    return Number.isFinite(at) && now - at < 10 * 60 * 1000;
  }
  if (kind === "bgcheck_clear") {
    return ["caregiver_awaiting_bgcheck", "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent", "caregiver_send_stripe_connect", "caregiver_awaiting_stripe"]
      .includes(String(session.onboardingStep ?? ""));
  }
  return false;
}

export async function notifyCaregiverAccountEvent(
  uid: string,
  kind: CaregiverAccountEventKind,
  opts: NotifyOptions,
): Promise<{ bell: boolean; text: boolean }> {
  // The paid / renewed texts carry the consent page itself (the page's Authorize
  // button, by text). Token TTL 14 days — the caregiver may act on it days later.
  const ctx: CaregiverAccountEventContext = { ...(opts.ctx ?? {}) };
  let phoneForLink: string | undefined;
  if ((kind === "membership_paid" || kind === "membership_renewed" || kind === "bgcheck_link_expired" || kind === "bgcheck_revoked") && !ctx.consentUrl) {
    // The check is part of the membership: no consent link while it is inactive
    // (the consent function refuses it anyway — backgroundCheckConsent.ts, 2026-10-04).
    let membershipActive = true;
    try {
      const cgSnap = await db.collection("caregivers").doc(uid).get();
      const { isCaregiverMembershipActive } = await import("../agents/caregiverAccessGate");
      membershipActive = !cgSnap.exists || isCaregiverMembershipActive((cgSnap.data() ?? {}) as Record<string, unknown>);
    } catch { /* decide on the link as before */ }
    if (!membershipActive) ctx.membershipInactive = true;
    phoneForLink = membershipActive ? await resolveCaregiverPhone(uid).catch(() => undefined) : undefined;
    if (phoneForLink) {
      try {
        const { generateToken } = await import("../agents/tokenService");
        ctx.consentUrl = appLink(`/bgcheck?t=${generateToken({ phone: phoneForLink, task: "bgcheck_consent" }, 14 * 24 * 3600)}`);
      } catch (err) { console.warn(`[caregiverAccountEvents] consent link failed (${kind}) for ${uid}:`, err); }
    }
  }
  const { title, body, text } = caregiverAccountEventCopy(kind, ctx);
  const smsBody = text ?? body;
  const textWanted = smsBody.trim().length > 0; // "" = bell only
  const created = await writeUserNotification({
    sourcePath: opts.sourcePath ?? `caregivers/${uid}`,
    eventId: opts.eventId,
    recipientId: uid,
    transitionType: kind,
    type: `caregiver_${kind}`,
    title,
    body,
    data: { kind },
  }).catch((err) => { console.error(`[caregiverAccountEvents] bell failed (${kind}) for ${uid}:`, err); return false; });
  if (!created) return { bell: false, text: false };
  if (kind === "mvr_review") await alertTeamDrivingRecordReview(uid, opts.eventId);
  if (!textWanted) return { bell: true, text: false };
  const phone = phoneForLink ?? await resolveCaregiverPhone(uid).catch(() => undefined);
  if (!phone) return { bell: true, text: false };
  try {
    const sessSnap = await db.collection("agent_sessions").doc(phone).get();
    if (sessSnap.exists && lifecycleTextOwnedByGate(kind, sessSnap.data() as { onboardingStep?: unknown; membershipRecordedAt?: unknown })) {
      return { bell: true, text: false }; // the gate step is about to say it, with its link
    }
    if (sessSnap.exists && sessSnap.data()?.optedOut !== true) {
      const { sendViaInteractionAgent } = await import("../agents/caraAgent");
      await sendViaInteractionAgent(phone, {
        content: smsBody,
        urgency: "immediate",
        sourceAgent: "caregiver_account_event",
        canDrop: false,
        ...(BILLING_KINDS.has(kind) ? { preferredService: "SMS" as const } : {}),
      });
      return { bell: true, text: true };
    }
    if (sessSnap.exists) return { bell: true, text: false }; // opted out: bell only
    const { sendToPhone } = await import("../linq/client");
    await sendToPhone(phone, smsBody);
    return { bell: true, text: true };
  } catch (err) {
    console.error(`[caregiverAccountEvents] text failed (${kind}) for ${uid}:`, err);
    return { bell: true, text: false };
  }
}
