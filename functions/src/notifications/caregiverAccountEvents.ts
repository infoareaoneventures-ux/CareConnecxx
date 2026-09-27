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
  | "transport_doc_approved" | "transport_doc_rejected" | "transport_docs_all_approved" | "transport_doc_expiring"
  | "mvr_clear" | "mvr_review" | "transport_badge_earned" | "transport_badge_lost"
  | "payouts_enabled" | "payouts_disabled"
  | "now_bookable";

export interface CaregiverAccountEventContext {
  amount?: string;          // "69.99"
  date?: string;            // a formatted day ("Monday, October 5")
  attempt?: number;         // payment-failed attempt number
  finalAttempt?: boolean;
  nextRetry?: string;       // "Oct 5"
  url?: string;             // the Checkr link on consent
  renewal?: boolean;
  docLabel?: string;        // "Driver's License"
  docNotes?: string;        // admin's rejection note
  docs?: string[];          // expiring document labels
  reason?: "expired" | "documents" | "mvr" | "services";
}

export const TRANSPORT_DOC_LABELS: Record<string, string> = {
  driversLicense: "Driver's License",
  insurance: "Vehicle Insurance",
  registration: "Vehicle Registration",
};

const BILLING_KINDS = new Set<CaregiverAccountEventKind>([
  "membership_paid", "membership_renewed", "membership_payment_failed", "membership_cancel_scheduled",
  "membership_reactivated", "membership_cancelled", "membership_revoked",
]);

/** The bell title + body (and the text, which is the same body) for each event. */
export function caregiverAccountEventCopy(kind: CaregiverAccountEventKind, ctx: CaregiverAccountEventContext = {}): { title: string; body: string } {
  const dash = appLink("/caregiver/dashboard");
  const membership = appLink("/caregiver/membership");
  switch (kind) {
    case "membership_paid":
      return { title: "Membership active", body: `Your membership is active. Next: authorize your background check — it takes about 2 minutes. ${dash}` };
    case "membership_renewed":
      return { title: "Membership renewed", body: `Your annual membership renewed${ctx.amount ? ` — $${ctx.amount} was charged` : ""}. Authorize this year's background check refresh to stay bookable. ${dash}` };
    case "membership_payment_failed":
      if (ctx.finalAttempt) {
        return { title: "Membership payment failed", body: `We weren't able to process your Evia membership payment after several tries, so your membership is now at risk of being canceled. To keep your access, please update your payment method at ${membership} today.` };
      }
      if ((ctx.attempt ?? 1) <= 1) {
        return { title: "Membership payment failed", body: `Heads up — we couldn't process your Evia membership payment. No action needed if your card just needs a moment, but you can update billing anytime at ${membership}.${ctx.nextRetry ? ` We'll retry on ${ctx.nextRetry}.` : ""}` };
      }
      return { title: "Membership payment failed", body: `We still haven't been able to process your Evia membership payment. Please update your payment method at ${membership} to avoid an interruption.${ctx.nextRetry ? ` Next retry: ${ctx.nextRetry}.` : ""}` };
    case "membership_cancel_scheduled":
      return { title: "Membership ending", body: `Your Evia membership is set to end on ${ctx.date ?? "your renewal date"}. You keep everything until then, and you can reactivate anytime from the Membership page: ${membership}` };
    case "membership_reactivated":
      return { title: "Membership reactivated", body: `Your Evia membership is active again.${ctx.date ? ` Next billing date: ${ctx.date}.` : ""}` };
    case "membership_cancelled":
      return { title: "Membership cancelled", body: `Your Evia membership has been cancelled. You can reactivate anytime from the Membership page: ${membership}` };
    case "membership_revoked":
      return { title: "Membership inactive", body: `Your membership is no longer active. Activate your membership to apply to jobs and get booked: ${membership}` };

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
      return { title: "Verification link expired", body: `Your background check link expired. Get a new one from your dashboard — or reply here and Evia will text you a fresh one. ${dash}` };
    case "bgcheck_revoked":
      return { title: "Background check pending", body: `Your background check approval was removed. Complete verification on your dashboard to get booked again: ${dash}` };

    case "transport_doc_approved":
      return { title: "Document approved", body: `Your ${ctx.docLabel ?? "transport document"} was approved.` };
    case "transport_doc_rejected":
      return { title: "Document rejected", body: `Your ${ctx.docLabel ?? "transport document"} was rejected${ctx.docNotes ? `: ${ctx.docNotes}` : ""}. Please re-upload to continue: ${appLink("/caregiver/settings")}` };
    case "transport_docs_all_approved":
      return { title: "Documents approved", body: "Your transportation documents are approved. Your transportation badge turns on as soon as your driving record (MVR) check clears." };
    case "transport_doc_expiring":
      return { title: "Document expiring soon", body: `${(ctx.docs ?? []).join(", ") || "A transport document"} will expire within 30 days. Upload a renewal to keep your transportation badge active: ${appLink("/caregiver/settings")}` };
    case "mvr_clear":
      return { title: "Driving record cleared", body: "Your driving record check came back clear." };
    case "mvr_review":
      return { title: "Driving record needs review", body: "Your driving record check needs a closer look. This only affects your transportation badge — your caregiver approval is unchanged." };
    case "transport_badge_earned":
      return { title: "Transportation badge active", body: "Your transportation badge is active — families can now see you for Transportation jobs." };
    case "transport_badge_lost":
      return {
        title: "Transportation badge removed",
        body: ctx.reason === "expired"
          ? `One or more of your transportation documents has expired. Upload updated documents to restore your badge: ${appLink("/caregiver/settings")}`
          : `Your transportation badge was removed. Check your transport documents and driving record on your dashboard to restore it: ${dash}`,
      };

    case "payouts_enabled":
      return { title: "Payouts set up", body: `Your payout account is set up — earnings land in your bank automatically after each paid visit. ${appLink("/caregiver/payments")}` };
    case "payouts_disabled":
      return { title: "Payouts need attention", body: `Your payout account needs attention — open Payout Setup on your dashboard to finish: ${dash}` };

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
export async function notifyCaregiverAccountEvent(
  uid: string,
  kind: CaregiverAccountEventKind,
  opts: NotifyOptions,
): Promise<{ bell: boolean; text: boolean }> {
  const { title, body } = caregiverAccountEventCopy(kind, opts.ctx);
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

  const phone = await resolveCaregiverPhone(uid).catch(() => undefined);
  if (!phone) return { bell: true, text: false };
  try {
    const sessSnap = await db.collection("agent_sessions").doc(phone).get();
    if (sessSnap.exists && sessSnap.data()?.optedOut !== true) {
      const { sendViaInteractionAgent } = await import("../agents/caraAgent");
      await sendViaInteractionAgent(phone, {
        content: body,
        urgency: "immediate",
        sourceAgent: "caregiver_account_event",
        canDrop: false,
        ...(BILLING_KINDS.has(kind) ? { preferredService: "SMS" as const } : {}),
      });
      return { bell: true, text: true };
    }
    if (sessSnap.exists) return { bell: true, text: false }; // opted out: bell only
    const { sendToPhone } = await import("../linq/client");
    await sendToPhone(phone, body);
    return { bell: true, text: true };
  } catch (err) {
    console.error(`[caregiverAccountEvents] text failed (${kind}) for ${uid}:`, err);
    return { bell: true, text: false };
  }
}
