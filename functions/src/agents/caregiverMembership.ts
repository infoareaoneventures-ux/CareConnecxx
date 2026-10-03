// The caregiver Payments page › Membership tab, texted
// (components/caregiver/CaregiverPaymentsPage.tsx `tab === 'membership'`:
// MembershipCard + ApprovedDriverCard).
//
// Same reads as the page: membershipStatus off the merged profile (the caregiver
// doc wins over the user doc), the subscription record under customers/{uid}
// (live first, else whatever exists — caregiverMembershipBilling.readCaregiverSubscriptionRecord,
// the page's getSubscriptionStatus), and the driver fields on the caregiver doc.
// Same buttons through the same server paths: Activate Membership = the
// membership checkout (send_onboarding_link caregiver_membership →
// createCaregiverMembershipCheckout), Manage = the Stripe Billing Portal
// (createCaregiverBillingPortalUrl). The page's Refresh button has no twin:
// every text already reads live.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { caregiverAnnualDisplay } from "../config/pricing";
import { DEFAULT_TZ } from "../utils/scheduledTime";

const db = admin.firestore();

export interface MembershipTab {
  status: string | null;          // the page's badge key (active / trialing / past_due / payment_failed / canceled …)
  isActive: boolean;              // active || trialing — the page's rule
  periodEnd: Date | null;         // customers/{uid}/subscriptions current_period_end
  cancelAtPeriodEnd: boolean;
  driver: DriverCard;
}

export type DriverCard =
  | "approved"            // isApprovedDriver AND the badge is live (documents approved too)
  | "cleared_docs_pending" // isApprovedDriver but a document is still missing / unapproved
  | "pending"             // MVR running
  | "included"            // offers Transportation, MVR not started
  | "offer";              // does not offer Transportation

/** The page's STATUS_BADGE labels. */
export const STATUS_LABEL: Record<string, string> = {
  active: "Active", trialing: "Trial", past_due: "Payment due", payment_failed: "Payment failed", canceled: "Canceled",
};

export const WHATS_INCLUDED = [
  "Keep 100% of your rate on every booking — families pay the service fee",
  "Access all job postings and apply instantly",
  "Background check badge on your profile",
  "Messaging",
];

/** The ApprovedDriverCard's four states, title + body as the page prints them. */
export const DRIVER_CARD_TEXT: Record<DriverCard, string> = {
  approved: "Approved Driver ✓ — Families who need a driver can see your verified-driver badge.",
  cleared_docs_pending: "Driving record cleared — your transportation badge turns on once your driver's license, insurance and registration are approved.",
  pending: "Driver check in progress — Your Motor Vehicle Report is being reviewed. We'll activate your Approved Driver badge once it clears.",
  included: "Driving record check included — Your membership covers the Motor Vehicle Report. It starts automatically once your background check clears — no extra charge.",
  offer: "Offer transportation? Add Transportation to your services and upload your driver's license, insurance, and registration. Your membership already covers the driving record check.",
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

/** The ApprovedDriverCard's branch for this record (page conditions, in the page's order). */
export function driverCardFor(cg: Record<string, unknown>, badgeLive: boolean): DriverCard {
  const isApprovedDriver = cg.isApprovedDriver === true;
  if (isApprovedDriver) return badgeLive ? "approved" : "cleared_docs_pending";
  const mvrPending = cg.mvrStatus === "pending" || (cg.mvrPaid === true && !isApprovedDriver);
  if (mvrPending) return "pending";
  const services = (Array.isArray(cg.services) ? cg.services : Array.isArray(cg.skills) ? cg.skills : []) as string[];
  if (services.includes("Transportation")) return "included";
  return "offer";
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
    driver: driverCardFor(cg, hasValidTransportDocs(cg)),
  };
}

export function membershipTabText(tab: MembershipTab): string {
  const lines: string[] = ["Payments · Membership", ""];
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
    lines.push(`${label} · Evia Membership — Annual plan`);
    if (tab.cancelAtPeriodEnd) lines.push(`⚠ Cancels on ${tab.periodEnd ? longDate(tab.periodEnd) : "—"}`);
    else if (tab.periodEnd) lines.push(`Renews ${longDate(tab.periodEnd)}`);
    lines.push("", "What's included:", ...WHATS_INCLUDED.map((l) => `✓ ${l}`));
    lines.push("", "Manage membership — update payment method, cancel, or view invoices via Stripe: reply MANAGE MEMBERSHIP for your link.");
  }
  lines.push("", DRIVER_CARD_TEXT[tab.driver]);
  return lines.join("\n");
}

export async function sendCaregiverMembership(chatId: string, caregiverId: string) {
  const tab = await loadMembershipTab(caregiverId);
  await sendMessage(chatId, membershipTabText(tab));
  return { sent: true, isActive: tab.isActive, status: tab.status, driver: tab.driver };
}

/** The Manage button: a Stripe Billing Portal link (same server path as the site's v1-createCaregiverBillingPortalSession). */
export async function sendMembershipPortalLink(chatId: string, caregiverId: string): Promise<boolean> {
  try {
    const [{ createCaregiverBillingPortalUrl, NoBillingAccountError }, { getStripeClient }, { appLink }] = await Promise.all([
      import("../caregiverMembershipBilling"), import("../stripe"), import("../config/appUrl"),
    ]);
    try {
      const url = await createCaregiverBillingPortalUrl(getStripeClient(), caregiverId, appLink("/caregiver/payments"));
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

// ── Keywords (routeCaregiver): MEMBERSHIP · MANAGE MEMBERSHIP · ACTIVATE ──
export async function handleMembershipKeyword(phone: string, chatId: string, caregiverId: string, text: string): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase();
  if (upper === "MEMBERSHIP" || upper === "MY MEMBERSHIP") { await sendCaregiverMembership(chatId, caregiverId); return "handled"; }
  if (upper === "MANAGE MEMBERSHIP" || upper === "BILLING" || upper === "INVOICES" || upper === "MY INVOICES") { await sendMembershipPortalLink(chatId, caregiverId); return "handled"; }
  if (upper === "ACTIVATE" || upper === "ACTIVATE MEMBERSHIP" || upper === "RENEW" || upper === "RENEW MEMBERSHIP") { await sendMembershipActivateLink(phone, chatId, caregiverId); return "handled"; }
  return "passthrough";
}
