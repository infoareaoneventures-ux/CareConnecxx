// The website's Membership page (components/Membership.tsx) as data — exactly
// what the card shows, nothing more: the plan, its price, the status, the next
// billing date (or the end date once a cancel is scheduled), and the buttons
// the family sees in that state. Same source as the page: the Stripe
// webhook-written customers/{uid}/subscriptions record (services/
// stripeService.ts getSubscriptionStatus / listenToSubscriptionStatus).
// Built 2026-09-18 (Membership page parity); replaced get_billing_summary,
// which dumped the raw Stripe record plus invoice/payment collections the page
// never shows.
import * as admin from "firebase-admin";
import { businessTodayStr, DEFAULT_TZ, formatDateWithWeekday } from "../utils/scheduledTime";
import { clientMonthlyDisplay, caregiverAnnualDisplay } from "../config/pricing";

const db = admin.firestore();

export type MembershipAction = "select_plan" | "cancel" | "reactivate" | "manage";

export interface MembershipPage {
  hasMembership: boolean;
  /** The card's plan block (the site has one client plan). */
  plan: { name: string; price: string; billing: string };
  /** Stripe status of the record the page shows (active / trialing / past_due / canceled …), or null with no record. */
  status: string | null;
  isActive: boolean;
  cancelScheduled: boolean;
  /** YYYY-MM-DD + label: "Next billing date" while active; "Your membership ends on" once a cancel is scheduled. */
  periodEnd: string | null;
  periodEndLabel: string | null;
  priceId: string | null;
  /** The page's buttons in this state. "manage" = the Stripe portal (card, invoices), via get_payment_update_link. */
  actions: MembershipAction[];
  /** The one-line status the card shows. */
  summary: string;
}

const CLIENT_PLAN = { name: "Standard Plan", price: clientMonthlyDisplay(), billing: "Billed monthly. Cancel anytime." };
const CAREGIVER_PLAN = { name: "Caregiver membership", price: caregiverAnnualDisplay(), billing: "Billed yearly. Covers the annual background check." };

const toMs = (v: unknown): number => {
  if (!v) return NaN;
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  if (typeof t._seconds === "number") return t._seconds * 1000;
  return Date.parse(String(v));
};

export function shapeMembershipPage(sub: Record<string, unknown> | null, role: "client" | "caregiver" = "client"): MembershipPage {
  const plan = role === "caregiver" ? CAREGIVER_PLAN : CLIENT_PLAN;
  const status = sub ? String(sub.status ?? "") || null : null;
  const isActive = status === "active" || status === "trialing";
  const cancelScheduled = isActive && sub?.cancel_at_period_end === true;
  const endMs = toMs(sub?.current_period_end);
  const periodEnd = Number.isFinite(endMs) ? businessTodayStr(DEFAULT_TZ, new Date(endMs)) : null;
  const endLabel = periodEnd ? formatDateWithWeekday(periodEnd) : null;
  const actions: MembershipAction[] = !isActive ? ["select_plan"] : cancelScheduled ? ["reactivate", "manage"] : ["cancel", "manage"];
  const summary = !isActive
    ? (status === "past_due" ? `Membership past due — the last payment didn't go through.` : `No active membership — the page shows the ${plan.name} (${plan.price}) with "Select a plan".`)
    : cancelScheduled
      ? `${plan.name} (${plan.price}) — set to cancel; your membership ends on ${endLabel ?? "the end of the billing period"}.`
      : `${plan.name} (${plan.price}) — active${endLabel ? `, next billing date ${endLabel}` : ""}.`;
  return {
    hasMembership: !!sub,
    plan,
    status,
    isActive,
    cancelScheduled,
    periodEnd,
    periodEndLabel: endLabel ? (cancelScheduled ? `Your membership ends on ${endLabel}` : `Next billing date: ${endLabel}`) : null,
    priceId: (sub?.price_id as string | undefined) ?? null,
    actions,
    summary,
  };
}

/** Same lookup as the page: the live (active/trialing) record first, else whatever record exists. */
export async function readMembershipPage(userId: string, role: "client" | "caregiver" = "client"): Promise<MembershipPage> {
  const coll = db.collection("customers").doc(userId).collection("subscriptions");
  const live = await coll.where("status", "in", ["active", "trialing"]).limit(1).get();
  let sub: Record<string, unknown> | null = live.empty ? null : (live.docs[0].data() as Record<string, unknown>);
  if (!sub) {
    const any = await coll.limit(1).get();
    sub = any.empty ? null : (any.docs[0].data() as Record<string, unknown>);
  }
  return shapeMembershipPage(sub, role);
}
