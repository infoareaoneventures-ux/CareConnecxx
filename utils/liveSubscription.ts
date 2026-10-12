// ONE rule for "the live subscription record" under customers/{uid}/subscriptions,
// on every door that shows a "Renews on" / "Payment failed" line (founder,
// 2026-10-11): active, trialing, AND Stripe's retry states past_due /
// payment_failed — while Stripe is retrying, THAT record is the one whose date
// and status the member must see, not an older canceled one and not nothing.
// When several qualify (a re-subscribe while an old record is still past_due),
// the most recently created one wins.
//
// Twins: services/stripeService.ts getSubscriptionStatus + listenToSubscriptionStatus
// (site), functions/src/stripe.ts getSubscriptionDetails (v1-getSubscriptionDetails),
// functions/src/caregiverMembershipBilling.ts readCaregiverSubscriptionRecord (Evia's
// caregiver Membership section) and functions/src/agents/membershipPage.ts
// readMembershipPage (Evia's family Membership page). Verbatim twin of
// functions/src/utils/liveSubscription.ts — keep both in sync. Dependency-free.

export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "payment_failed"] as const;

export function isLiveSubscriptionStatus(status: unknown): boolean {
  return typeof status === "string" && (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** Timestamp-like (Firestore Timestamp / {seconds} / {_seconds}), Date, epoch number or ISO string → ms (0 when unreadable). */
function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // epoch seconds vs ms
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : 0; }
  const t = v as { toMillis?: () => number; toDate?: () => Date; seconds?: number; _seconds?: number };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.toDate === "function") return t.toDate().getTime();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  if (typeof t._seconds === "number") return t._seconds * 1000;
  return 0;
}

/** When the record was created: Stripe's `created`, else the current period's start, else its end. */
export function subscriptionRecencyMs(record: Record<string, unknown>): number {
  return toMillis(record.created) || toMillis(record.current_period_start) || toMillis(record.current_period_end) || 0;
}

/** The live record among these (status in LIVE_SUBSCRIPTION_STATUSES), most recent first; null when none is live. */
export function pickLiveSubscription<T extends Record<string, unknown>>(records: readonly T[]): T | null {
  const live = records.filter((r) => isLiveSubscriptionStatus(r?.status));
  if (live.length === 0) return null;
  // Stable: ties keep the query's order.
  return live
    .map((r, i) => ({ r, i, at: subscriptionRecencyMs(r) }))
    .sort((a, b) => (b.at - a.at) || (a.i - b.i))[0].r;
}
