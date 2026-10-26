// Caregiver account events — ONE notification path (founder, 2026-09-27):
// for every change the dashboard's "Your progress" bar would show (membership,
// background check, transport documents / driving record / badge, payouts,
// admin approvals and revokes, lapses) and for the Settings page's Pause card
// (account paused / reactivated, B7 2026-10-11), the caregiver gets exactly one
// website bell entry and one text with the same words, never twice.
//
// Idempotency: the bell is written through writeUserNotification, keyed on
// (sourcePath, eventId, recipient, event kind); the text goes out ONLY when
// that write created a new entry. A webhook retry, a duplicate Checkr event or
// a second trigger invocation for the same change therefore sends nothing.
//
// Wording: the dashboard card's / bell's own words. No "Reply YES", no reasons,
// no extra pitch — the site says none of that.
import * as admin from "firebase-admin";
import { caregiverAnnualDisplay } from "../config/pricing";
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
  | "mvr_clear" | "mvr_review" | "mvr_not_approved" | "mvr_consent_requested" | "mvr_check_started" | "transport_badge_earned" | "transport_badge_lost"
  | "membership_renewal_upcoming" | "renewal_refresh_reminder" | "renewal_refresh_locked"
  | "payouts_enabled" | "payouts_disabled"
  | "now_bookable"
  | "account_paused" | "account_reactivated";

export interface CaregiverAccountEventContext {
  /** bgcheck_revoked: no consent link — the membership is not active, and the check is part of it (2026-10-04). */
  membershipInactive?: boolean;
  amount?: string;          // "69.99"
  date?: string;            // a formatted day ("Monday, October 5"); account_paused: the pause end date as the page shows it ("2026-11-01")
  /** account_paused: an open-ended pause (until she reactivates). */
  indefinite?: boolean;
  /**
   * membership_renewed: false when this year's background check refresh is NOT part of the
   * renewal (a legacy monthly plan, or an annual renewal whose refresh was already asked) —
   * the text is then the renewal charge alone (B8, 2026-10-11). Default (annual) = the refresh ask.
   */
  checkRefresh?: boolean;
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
    const name = String(cg.name ?? "A care provider").trim() || "A care provider";
    const status = String(cg.mvrStatus ?? "consider");
    await db.collection("admin_alerts").add({
      type: "mvr_review",
      severity: "high",
      resolved: false,
      caregiverId: uid,
      caregiverName: name,
      mvrStatus: status,
      message: `${name}'s driving record check came back "${status}". Transportation is off their profile until you decide — Admin › Care Providers › ${name} › Verification.`,
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
  const dash = appLink("/care-provider/dashboard");
  const membership = appLink("/care-provider/settings"); // Membership & verification lives on Account Settings (2026-10-04)
  switch (kind) {
    case "membership_paid":
      return {
        title: "Membership active",
        body: `Your membership is active. Next: authorize your background check — it takes about 2 minutes. ${dash}`,
        text: `Your membership is active. Next: authorize your background check — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    case "membership_renewed": {
      const charged = ctx.amount ? ` — $${ctx.amount} was charged` : "";
      if (ctx.checkRefresh === false) {
        // The renewal charge alone — the family's own renewal sentence (stripe.ts), the
        // amount from the invoice, never a hard-coded price. Caregivers are annual-only
        // since 2026-09-25; legacy monthly subscriptions still bill, and were told nothing (B8).
        const next = ctx.date ? ` Next billing date: ${ctx.date}.` : "";
        const line = `Your Evia membership renewed${ctx.amount ? ` — $${ctx.amount} was charged to your card on file` : ""}.${next}`;
        return { title: "Membership renewed", body: `${line} ${membership}`, text: line };
      }
      return {
        title: "Membership renewed",
        // Founder, 2026-10-06: paid first, still cleared, 7 days to authorize (the daily sweep reminds on day 5, locks on day 7).
        body: `Your annual membership renewed${charged}. Authorize this year's background check within 7 days to stay bookable. ${dash}`,
        text: `Your annual membership renewed${charged}. Authorize this year's background check within 7 days to stay bookable — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    }
    case "membership_payment_failed": {
      const manage = "say manage membership and I'll send your Stripe billing link";
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
        text: `Your Evia membership is set to end on ${ctx.date ?? "your renewal date"}. You keep everything until then, and you can reactivate anytime. Say manage membership and I'll send your Stripe billing link.`,
      };
    case "membership_reactivated":
      return { title: "Membership reactivated", body: `Your Evia membership is active again.${ctx.date ? ` Next billing date: ${ctx.date}.` : ""}` };
    case "membership_cancelled":
      return {
        title: "Membership cancelled",
        body: `Your Evia membership has been cancelled. You can reactivate anytime from the Membership page: ${membership}`,
        text: "Your Evia membership has been cancelled. You can reactivate anytime. Say activate and I'll send your membership link.",
      };
    case "membership_revoked":
      return {
        title: "Membership inactive",
        body: `Your membership is no longer active. Activate your membership to apply to jobs and get booked: ${membership}`,
        text: "Your membership is no longer active. Activate it to apply to jobs and get booked. Say activate and I'll send your membership link.",
      };

    case "bgcheck_consent_received":
      return {
        title: ctx.renewal ? "Background check refresh started" : "Background check started",
        body: ctx.renewal
          ? `Thanks — here's this year's background check refresh. It usually takes about 5 minutes, and your SSN and date of birth go directly to Checkr, never to Evia: ${ctx.url ?? dash}`
          : `Thanks for authorizing! Here's your background check link — it usually takes about 5 minutes, and your SSN and date of birth go directly to Checkr, never to Evia: ${ctx.url ?? dash}`,
      };
    case "bgcheck_clear":
      return { title: "Background check complete", body: "Great news — your background check came back clear." };
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
    case "membership_renewal_upcoming":
      // 7 days before the anniversary — caregivers only (founder, 2026-10-06). Nothing to click if the card is fine.
      return {
        title: "Your membership renews soon",
        body: `Your Evia membership renews on ${ctx.date ?? "your renewal date"} for ${ctx.amount ?? caregiverAnnualDisplay()}. If your card has changed, update it under Manage. ${membership}`,
        text: `Your Evia membership renews on ${ctx.date ?? "your renewal date"} for ${ctx.amount ?? caregiverAnnualDisplay()}. If your card has changed, say manage membership and I'll send your Stripe billing link.`,
      };
    case "renewal_refresh_reminder":
      return {
        title: "Two days left to authorize this year's background check",
        body: `Authorize this year's background check within two days to stay bookable. ${dash}`,
        text: `Two days left to authorize this year's background check — it takes about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };
    case "renewal_refresh_locked":
      return {
        title: "Background check refresh not authorized",
        body: `This year's background check wasn't authorized in time, so you're paused until it clears. Authorize it now. ${dash}`,
        text: `This year's background check wasn't authorized in time, so you're paused until it clears. Authorize it now — about 2 minutes: ${ctx.consentUrl ?? dash}`,
      };

    case "mvr_consent_requested":
      // Later MVR, consent-first (2026-10-06): Transportation added after the criminal check cleared.
      // Bell → the Settings card's Authorize button; text → the consent page itself (same words as the cards).
      return {
        title: "Authorize your driving record check",
        body: `Transportation is on your profile. Authorize the driving record check to start it — included in your membership. ${membership}`,
        text: `Transportation is on your profile. Authorize the driving record check to start it — included in your membership. It takes about 2 minutes: ${ctx.consentUrl ?? membership}`,
      };

    case "mvr_check_started":
      // The MVR-only check is created on the caregiver's authorization; this texts the completion link (2026-10-07).
      return {
        title: "Your driving record check is ready",
        body: `Complete the short form to run your driving record check. ${membership}`,
        text: `Your driving record check is ready. Complete the short form here (about 5 minutes): ${ctx.url ?? membership}`,
      };

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
        body: `Your payout account is set up — earnings land in your bank automatically after each paid visit. ${appLink("/care-provider/payments")}`,
        text: "Your payout account is set up. Earnings land in your bank automatically after each paid visit. Say payouts anytime to see your balance.",
      };
    case "payouts_disabled":
      return {
        title: "Payouts need attention",
        body: `Your payout account needs attention — open Payout Setup on your dashboard to finish: ${dash}`,
        text: "Your payout account needs attention. Say setup and I'll send your Stripe link to finish it.",
      };

    case "now_bookable":
      return { title: "You're all set", body: "You're all set — families can now find and book you." };

    case "account_paused": {
      // The Settings page's Pause card, as the record of the event (B7, 2026-10-11): until the
      // date it shows (or until she reactivates); nothing that exists is touched (PAUSE_FACTS).
      // Bell → the page (Reactivate button); text → the keyword that IS that button.
      const until = ctx.indefinite || !ctx.date ? "until you reactivate" : `until ${ctx.date}`;
      const back = ctx.indefinite || !ctx.date ? "Reactivate anytime" : "Reactivate sooner anytime";
      const line = `Your account is paused ${until}. You won't show up for new matches; existing visits, bookings and interviews are unchanged.`;
      return { title: "Your account is paused", body: `${line} ${back}: ${membership}`, text: `${line} ${back}, just say reactivate.` };
    }
    case "account_reactivated":
      return { title: "You're active again", body: "You're active again — you'll show up for new matches." };
  }
}

/**
 * The bell's `type`: `caregiver_<kind>` — except the account-standing kinds, typed
 * `account_<…>` so both bell maps (utils/notificationRoutes.ts, agents/notificationsPage.ts:
 * `startsWith("account")`) land them on Settings, where the Pause card lives (B7).
 */
export function caregiverAccountEventBellType(kind: CaregiverAccountEventKind): string {
  return kind.startsWith("account_") ? kind : `caregiver_${kind}`;
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
 *  - account_paused / account_reactivated when an Evia door (the confirm flow,
 *    the REACTIVATE keyword, the MCP tools) just wrote the pause and texts its
 *    own confirmation line: pauseAccount.ts stamps `accountNoticeTexted`
 *    {kind, at} on the session right before the record flips (B7, 2026-10-11).
 *    The site's queue action never stamps it, so that caregiver gets this text.
 */
export const ACCOUNT_NOTICE_OWNED_WINDOW_MS = 2 * 60 * 1000;

export function lifecycleTextOwnedByGate(
  kind: CaregiverAccountEventKind,
  session: { onboardingStep?: unknown; membershipRecordedAt?: unknown; accountNoticeTexted?: unknown } | undefined,
  now: number = Date.now(),
): boolean {
  if (!session) return false;
  if (kind === "membership_paid") {
    const at = Date.parse(String(session.membershipRecordedAt ?? ""));
    return Number.isFinite(at) && now - at < 10 * 60 * 1000;
  }
  if (kind === "account_paused" || kind === "account_reactivated") {
    const stamp = (session.accountNoticeTexted ?? {}) as { kind?: unknown; at?: unknown };
    if (stamp.kind !== kind) return false;
    const at = Date.parse(String(stamp.at ?? ""));
    return Number.isFinite(at) && now - at < ACCOUNT_NOTICE_OWNED_WINDOW_MS;
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
  const renewalWithoutRefresh = kind === "membership_renewed" && ctx.checkRefresh === false; // the charge alone carries no consent link (B8)
  if ((kind === "membership_paid" || kind === "membership_renewed" || kind === "bgcheck_link_expired" || kind === "bgcheck_revoked" || kind === "mvr_consent_requested" || kind === "renewal_refresh_reminder" || kind === "renewal_refresh_locked") && !ctx.consentUrl && !renewalWithoutRefresh) {
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
  const bellKey = { sourcePath: opts.sourcePath ?? `caregivers/${uid}`, eventId: opts.eventId, recipientId: uid, transitionType: kind };
  const created = await writeUserNotification({
    ...bellKey,
    type: caregiverAccountEventBellType(kind),
    title,
    body,
    data: { kind },
  }).catch((err) => { console.error(`[caregiverAccountEvents] bell failed (${kind}) for ${uid}:`, err); return false; });
  if (!created) return { bell: false, text: false };
  if (kind === "mvr_review") await alertTeamDrivingRecordReview(uid, opts.eventId);
  if (!textWanted) return { bell: true, text: false };

  // Bell ⇄ text in lockstep (C11, 2026-10-11): the bell above is the idempotency
  // claim; when the text does not actually go, the claim is taken back so the
  // site never shows an event the caregiver was never told. Kept as bell-only:
  // a text the gate step is about to send itself (it DOES go, through the step),
  // and a caregiver who texted STOP (the site is then her only channel).
  const takeBellBack = async (why: string) => {
    try {
      const m = await import("./userNotification");
      await m.deleteUserNotification(bellKey.sourcePath, bellKey.eventId, bellKey.recipientId, bellKey.transitionType);
    } catch (err) { console.error(`[caregiverAccountEvents] bell rollback failed (${kind}, ${why}) for ${uid}:`, err); }
    return { bell: false, text: false };
  };

  const phone = phoneForLink ?? await resolveCaregiverPhone(uid).catch(() => undefined);
  if (!phone) return takeBellBack("no_phone");
  try {
    const sessSnap = await db.collection("agent_sessions").doc(phone).get();
    if (sessSnap.exists && lifecycleTextOwnedByGate(kind, sessSnap.data() as { onboardingStep?: unknown; membershipRecordedAt?: unknown; accountNoticeTexted?: unknown })) {
      return { bell: true, text: false }; // the gate step is about to say it, with its link
    }
    if (sessSnap.exists && sessSnap.data()?.optedOut !== true) {
      const { sendViaInteractionAgent } = await import("../agents/caraAgent");
      const sent = await sendViaInteractionAgent(phone, {
        content: smsBody,
        urgency: "immediate",
        sourceAgent: "caregiver_account_event",
        canDrop: false,
        fixedString: true, // the founder's words: reviewed for a block, never rephrased (C12)
        ...(BILLING_KINDS.has(kind) ? { preferredService: "SMS" as const } : {}),
      });
      if (sent === false) return takeBellBack("send_suppressed");
      return { bell: true, text: true };
    }
    if (sessSnap.exists) return { bell: true, text: false }; // opted out (STOP): bell only, the site is her channel
    const { sendToPhone } = await import("../linq/client");
    const outcome = await sendToPhone(phone, smsBody);
    if (outcome === "dropped" || outcome === "skipped_opt_out") return takeBellBack(String(outcome));
    return { bell: true, text: true };
  } catch (err) {
    console.error(`[caregiverAccountEvents] text failed (${kind}) for ${uid}:`, err);
    return takeBellBack("send_failed");
  }
}
