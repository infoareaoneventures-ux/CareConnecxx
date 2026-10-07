// The caregiver Account Settings › "Membership & verification" section, texted
// (components/caregiver/AccountStandingSection.tsx — moved there from the
// Payments › Membership tab on 2026-10-04: membership with its next charge, the
// background check with its last clear and next check, the driving record).
//
// Same reads as the section: membershipStatus off the merged profile (the
// caregiver doc wins over the user doc), the subscription record under
// customers/{uid} (live first, else whatever exists —
// caregiverMembershipBilling.readCaregiverSubscriptionRecord, the page's
// getSubscriptionStatus), the background-check and driver fields on the
// caregiver doc with the dashboard card's own rules. Same buttons through the
// same server paths: Activate Membership = the membership checkout
// (send_onboarding_link caregiver_membership → createCaregiverMembershipCheckout),
// Manage = the Stripe Billing Portal (createCaregiverBillingPortalUrl), Authorize
// = the texted FCRA consent page (send_onboarding_link caregiver_background_check,
// the same consent function the site's modal calls). Refresh has no twin: every
// text already reads live.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { isCaregiverMembershipActive } from "./caregiverAccessGate";
import { caregiverAnnualDisplay } from "../config/pricing";
import { DEFAULT_TZ } from "../utils/scheduledTime";

const db = admin.firestore();

export type DriverCard =
  | "approved"             // isApprovedDriver — Transportation live (no documents behind it, 2026-10-06)
  | "not_approved"         // the admin's final decision after a review (2026-10-04)
  | "review"               // MVR came back consider / suspended — the team is alerted (2026-10-04)
  | "pending"              // MVR running
  | "included"             // offers Transportation, MVR not started
  | "offer";               // does not offer Transportation

/** The section's background-check card states — the dashboard card's rules (CaregiverOnboardingDashboard). */
export type BgCard =
  | { kind: "consent"; renewal: boolean }
  | { kind: "cleared"; clearedOn: string | null }
  | { kind: "in_progress"; detail: "under_review" | "on_hold" | "running" }
  | { kind: "not_approved" }
  | { kind: "not_started" };

export interface MembershipTab {
  status: string | null;          // the badge key (active / trialing / past_due / payment_failed / canceled …)
  isActive: boolean;              // active || trialing — the page's rule
  periodEnd: Date | null;         // customers/{uid}/subscriptions current_period_end
  cancelAtPeriodEnd: boolean;
  bg: BgCard;
  driver: DriverCard;
  mvrClearedOn: string | null;
}

/** The page's STATUS_BADGE labels. */
export const STATUS_LABEL: Record<string, string> = {
  active: "Active", trialing: "Trial", past_due: "Payment due", payment_failed: "Payment failed", canceled: "Canceled",
};

export const WHATS_INCLUDED = [
  "Keep 100% of your rate on every booking — families pay the service fee",
  "Access all job postings and apply instantly",
  "Background check shown on your profile",
  "Messaging",
];

/** The driver card's states, title + body as the page prints them. */
export const DRIVER_CARD_TEXT: Record<DriverCard, string> = {
  // AccountStandingSection.DRIVER_CARD_TEXT, "title — body". States what happened, never an approval (founder, 2026-10-04).
  approved: "Driving record check cleared. Families who need a driver can see Transportation on your profile.",
  not_approved: "Driving record not approved. Your driving record check didn't meet the requirement for Transportation jobs. Non-driving jobs aren't affected.",
  review: "Driving record under review. Your driving record check came back needing a review. Transportation is off your profile for now. Non-driving jobs aren't affected.",
  pending: "Driving record check in progress. Finish the short form in the email you received. Transportation shows on your profile once it clears.",
  included: "Driving record check included. Watch your email for a short form to complete.",
  offer: "Offer transportation? Add Transportation to your services. Your membership already covers the driving record check. Reply SERVICES to add it.",
};

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date; seconds?: number; _seconds?: number };
  if (typeof t.toDate === "function") return t.toDate();
  if (typeof t.seconds === "number") return new Date(t.seconds * 1000);
  if (typeof t._seconds === "number") return new Date(t._seconds * 1000);
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** The page's date: toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }). */
export const longDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: DEFAULT_TZ }).format(d);
/** The page's toLocaleDateString() for cleared dates (en-US numeric). */
export const shortDate = (v: unknown): string | null => {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: DEFAULT_TZ }).format(d) : null;
};

/** The driver card's branch for this record (page conditions, in the page's order). */
export function driverCardFor(cg: Record<string, unknown>, badgeLive: boolean): DriverCard {
  const isApprovedDriver = cg.isApprovedDriver === true;
  if (isApprovedDriver) return "approved"; // Transportation live — no documents behind it (2026-10-06)
  void badgeLive;
  if (cg.mvrStatus === "not_approved") return "not_approved";
  if (cg.mvrStatus === "consider" || cg.mvrStatus === "suspended") return "review";
  const mvrPending = cg.mvrStatus === "pending" || (cg.mvrPaid === true && !isApprovedDriver);
  if (mvrPending) return "pending";
  const services = (Array.isArray(cg.services) ? cg.services : Array.isArray(cg.skills) ? cg.skills : []) as string[];
  if (services.includes("Transportation")) return "included";
  return "offer";
}

/** The background-check card's branch — AccountStandingSection.backgroundCheckState, verbatim rules. */
export function bgCardFor(cg: Record<string, unknown>): BgCard {
  const bg = (cg.backgroundCheckData ?? {}) as Record<string, unknown>;
  const needsConsent = bg.consentRequired === true || bg.invitationStatus === "awaiting_consent";
  if (needsConsent) return { kind: "consent", renewal: bg.consentReason === "renewal" };
  if (cg.verificationStatus === "rejected") return { kind: "not_approved" };
  const cleared = cg.verified === true || cg.backgroundCheckStatus === "clear" || cg.backgroundCheckComplete === true;
  if (cleared) return { kind: "cleared", clearedOn: shortDate(bg.checkrClearedAt ?? bg.completedAt ?? cg.approvedAt) };
  if (bg.checkrCandidateId) {
    return { kind: "in_progress", detail: bg.status === "consider" ? "under_review" : bg.status === "suspended" ? "on_hold" : "running" };
  }
  // Membership active and nothing started → the Start button (AUTHORIZE), as the
  // page and the dashboard's step rule (2026-10-04).
  if (isCaregiverMembershipActive(cg)) return { kind: "consent", renewal: false };
  return { kind: "not_started" };
}

export async function loadMembershipTab(caregiverId: string): Promise<MembershipTab> {
  const [cgSnap, userSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverId).get(),
    db.collection("users").doc(caregiverId).get(),
  ]);
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const user = (userSnap.data() ?? {}) as Record<string, unknown>;
  // dbService.getUser spreads users then caregivers — the caregiver doc wins.
  const status = (typeof cg.membershipStatus === "string" && cg.membershipStatus)
    ? cg.membershipStatus
    : (typeof user.membershipStatus === "string" && user.membershipStatus) ? user.membershipStatus : null;
  const { readCaregiverSubscriptionRecord } = await import("../caregiverMembershipBilling");
  const sub = await readCaregiverSubscriptionRecord(caregiverId).catch(() => null);
  const { hasValidTransportDocs } = await import("./caregiverMatchScoring");
  return {
    status,
    isActive: status === "active" || status === "trialing",
    periodEnd: toDate(sub?.current_period_end),
    cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
    bg: bgCardFor(cg),
    driver: driverCardFor(cg, hasValidTransportDocs(cg)),
    mvrClearedOn: shortDate(cg.mvrClearedAt),
  };
}

/** The background-check card, one line: the page's title + body (+ dates). */
export function bgCardText(tab: MembershipTab): string {
  const b = tab.bg;
  const renewal = tab.isActive && tab.periodEnd ? ` · Next check with your renewal on ${longDate(tab.periodEnd)}` : "";
  switch (b.kind) {
    case "consent":
      return b.renewal
        ? "Background check: Renew your background check. Your annual membership renewed. Authorize this year's background check refresh to stay bookable. Reply AUTHORIZE for the link."
        : "Background check: Start your background check. Authorize your background check, it takes about 2 minutes. Your SSN and date of birth go directly to Checkr, never to Evia. Reply AUTHORIZE for the link.";
    case "cleared":
      return `Background check: Cleared${b.clearedOn ? ` ${b.clearedOn}` : ""}${renewal}`;
    case "in_progress":
      return b.detail === "under_review"
        ? "Background check: Under review. This is normal, our team will follow up if anything is needed."
        : b.detail === "on_hold"
          ? "Background check: On hold. Checkr is gathering additional information. Check your email from Checkr for next steps."
          : "Background check: In progress. Checkr emailed you a secure link, it usually takes about 5 minutes.";
    case "not_approved":
      return "Background check: Not approved. Contact support if you have questions.";
    default:
      return "Background check: Starts right after your membership is active, it's included in the annual fee.";
  }
}

/** The driver card, one line, with the cleared date the page adds. */
export function driverCardText(tab: MembershipTab): string {
  const base = DRIVER_CARD_TEXT[tab.driver];
  if (tab.mvrClearedOn && tab.driver === "approved") {
    return base.replace("Driving record check cleared. ", `Driving record check cleared on ${tab.mvrClearedOn}. `);
  }
  return base;
}

/** The whole section as the page shows it (no header) — reused by the Account Settings twin. */
export function membershipSectionLines(tab: MembershipTab): string[] {
  const lines: string[] = [];
  if (!tab.isActive) {
    lines.push(
      "No active membership",
      tab.status === "canceled"
        ? "Your membership was canceled. Renew to access jobs and platform features."
        : "Activate your membership to start accepting bookings and applying for jobs.",
      `Reply ACTIVATE for your membership link (${caregiverAnnualDisplay()}).`,
    );
  } else {
    const label = STATUS_LABEL[tab.status ?? ""] ?? tab.status ?? "";
    lines.push(`${label} · Evia Membership: Annual plan`);
    if (tab.cancelAtPeriodEnd) lines.push(`⚠ Cancels on ${tab.periodEnd ? longDate(tab.periodEnd) : "the end of your term"}`);
    else if (tab.periodEnd) lines.push(`Renews ${longDate(tab.periodEnd)}`);
    lines.push("What's included:", ...WHATS_INCLUDED.map((l) => `✓ ${l}`));
    lines.push("Manage membership: update payment method, cancel, or view invoices via Stripe, reply MANAGE MEMBERSHIP for your link.");
  }
  lines.push("", bgCardText(tab), "", driverCardText(tab));
  return lines;
}

export function membershipTabText(tab: MembershipTab): string {
  return ["Settings · Membership & verification", "", ...membershipSectionLines(tab)].join("\n");
}

export async function sendCaregiverMembership(chatId: string, caregiverId: string) {
  const tab = await loadMembershipTab(caregiverId);
  await sendMessage(chatId, membershipTabText(tab));
  return { sent: true, isActive: tab.isActive, status: tab.status, backgroundCheck: tab.bg.kind, driver: tab.driver };
}

/** The Manage button: a Stripe Billing Portal link (same server path as the site's v1-createCaregiverBillingPortalSession). */
export async function sendMembershipPortalLink(chatId: string, caregiverId: string): Promise<boolean> {
  try {
    const [{ createCaregiverBillingPortalUrl, NoBillingAccountError }, { getStripeClient }, { appLink }] = await Promise.all([
      import("../caregiverMembershipBilling"), import("../stripe"), import("../config/appUrl"),
    ]);
    try {
      const url = await createCaregiverBillingPortalUrl(getStripeClient(), caregiverId, appLink("/caregiver/settings"));
      await sendMessage(chatId, `Manage your membership (update payment method, cancel, or view invoices) — this link signs you in to Stripe: ${url}`);
      return true;
    } catch (err) {
      if (err instanceof NoBillingAccountError) {
        await sendMessage(chatId, "No billing account found. Please purchase a membership first — reply ACTIVATE for your membership link.");
        return false;
      }
      throw err;
    }
  } catch (err) {
    console.error("[caregiverMembership] portal link failed:", err);
    await sendMessage(chatId, "Billing portal unavailable right now. Please try again later.");
    return false;
  }
}

/** The Activate Membership button: the membership checkout link, texted (send_onboarding_link caregiver_membership). */
export async function sendMembershipActivateLink(phone: string, chatId: string, caregiverId: string): Promise<boolean> {
  const tab = await loadMembershipTab(caregiverId);
  if (tab.isActive) {
    await sendMessage(chatId, "Your membership is already active — reply MANAGE MEMBERSHIP to update your card, cancel, or see invoices.");
    return false;
  }
  try {
    const { runSendOnboardingLinkAction } = await import("./actions/sendOnboardingLinkAction");
    const r = await runSendOnboardingLinkAction({ phone, linkType: "caregiver_membership" }, { caller: "sms_agent", role: "caregiver", phone });
    if (r.sent) return true;
    if (r.throttled) { await sendMessage(chatId, `Your membership link went out about ${r.minutesSinceLastSend ?? "a few"} minutes ago — tap that one, or reply LINK and I'll resend it.`); return false; }
  } catch (err) { console.error("[caregiverMembership] activate link failed:", err); }
  await sendMessage(chatId, "I couldn't generate your membership link right now — reply ACTIVATE again in a moment.");
  return false;
}

/** The background-check card's Authorize button: the texted FCRA consent page (the same consent function the site's modal calls). */
export async function sendAuthorizeLink(phone: string, chatId: string, caregiverId: string): Promise<boolean> {
  const tab = await loadMembershipTab(caregiverId);
  if (tab.bg.kind !== "consent") {
    await sendMessage(chatId, `Nothing to authorize right now — ${bgCardText(tab).replace(/^Background check: /, "your background check is: ")}`);
    return false;
  }
  try {
    const { runSendOnboardingLinkAction } = await import("./actions/sendOnboardingLinkAction");
    const r = await runSendOnboardingLinkAction({ phone, linkType: "caregiver_background_check" }, { caller: "sms_agent", role: "caregiver", phone });
    if (r.sent) return true;
    if (r.throttled) { await sendMessage(chatId, `Your authorization link went out about ${r.minutesSinceLastSend ?? "a few"} minutes ago — tap that one, or reply LINK and I'll resend it.`); return false; }
  } catch (err) { console.error("[caregiverMembership] authorize link failed:", err); }
  await sendMessage(chatId, "I couldn't generate your authorization link right now — reply AUTHORIZE again in a moment.");
  return false;
}

// ── Keywords (routeCaregiver): MEMBERSHIP · MANAGE MEMBERSHIP · ACTIVATE · AUTHORIZE ──
export async function handleMembershipKeyword(phone: string, chatId: string, caregiverId: string, text: string): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (["MEMBERSHIP", "MY MEMBERSHIP", "VERIFICATION", "MY BACKGROUND CHECK", "BACKGROUND CHECK"].includes(upper)) { await sendCaregiverMembership(chatId, caregiverId); return "handled"; }
  if (["MANAGE MEMBERSHIP", "BILLING", "INVOICES", "MY INVOICES"].includes(upper)) { await sendMembershipPortalLink(chatId, caregiverId); return "handled"; }
  if (["ACTIVATE", "ACTIVATE MEMBERSHIP", "RENEW", "RENEW MEMBERSHIP"].includes(upper)) { await sendMembershipActivateLink(phone, chatId, caregiverId); return "handled"; }
  if (["AUTHORIZE", "AUTHORIZE BACKGROUND CHECK", "AUTHORIZE CHECK"].includes(upper)) { await sendAuthorizeLink(phone, chatId, caregiverId); return "handled"; }
  return "passthrough";
}
