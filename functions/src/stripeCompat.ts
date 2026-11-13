// Stripe API-version compatibility for webhook payloads (2026-11-09).
//
// The server's own Stripe client is pinned to API 2023-10-16, but a webhook endpoint delivers events in
// ITS API version — the sandbox endpoints only offer 2025-09-30.clover and newer, and a live account that
// is upgraded later will do the same. Two things moved between those versions and the handlers read both:
//   • an invoice's subscription id: `invoice.subscription` (old) → `invoice.parent.subscription_details.subscription` (new);
//   • a subscription's billing period: `current_period_start/end` on the subscription (old) → on each item
//     (`items.data[0].current_period_*`, new).
// These readers accept either place, so a payment activates the membership and the dates are real in
// both formats. Pure — no Stripe calls.
import type Stripe from "stripe";

type Maybe<T> = T | null | undefined;

const idOf = (v: unknown): string | undefined => {
  if (typeof v === "string" && v) return v;
  const id = (v as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
};

/** The subscription an invoice belongs to, from the old or the new payload shape; undefined for a one-off invoice. */
export function invoiceSubscriptionId(invoice: Maybe<Stripe.Invoice>): string | undefined {
  if (!invoice) return undefined;
  const legacy = idOf((invoice as unknown as { subscription?: unknown }).subscription);
  if (legacy) return legacy;
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: unknown } } }).parent;
  return idOf(parent?.subscription_details?.subscription);
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The billing period (unix seconds) from the old (top-level) or new (first item) shape. */
export function subscriptionPeriod(sub: Maybe<Stripe.Subscription>): { start?: number; end?: number } {
  if (!sub) return {};
  const top = sub as unknown as { current_period_start?: unknown; current_period_end?: unknown; items?: { data?: Array<{ current_period_start?: unknown; current_period_end?: unknown }> } };
  const item = top.items?.data?.[0];
  return {
    start: num(top.current_period_start) ?? num(item?.current_period_start),
    end: num(top.current_period_end) ?? num(item?.current_period_end),
  };
}

/**
 * The same subscription with `current_period_start/end` filled in at the top level whatever shape it arrived in,
 * so every existing handler that reads them keeps working unchanged. Returns the input untouched when both are
 * already there or cannot be found.
 */
export function withTopLevelPeriod<T extends Stripe.Subscription>(sub: T): T {
  const { start, end } = subscriptionPeriod(sub);
  const top = sub as unknown as { current_period_start?: unknown; current_period_end?: unknown };
  if ((start === undefined && end === undefined) || (top.current_period_start === start && top.current_period_end === end)) return sub;
  return { ...sub, current_period_start: start, current_period_end: end } as T;
}
