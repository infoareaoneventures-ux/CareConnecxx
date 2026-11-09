// ONE place that decides which Stripe secret key the server uses (Wave 0, 2026-11-09).
//
// Before: stripe.ts read STRIPE_SECRET_KEY from the environment only, while stripeConnect.ts,
// stripeConnectWebhook.ts and shiftHours.ts read Firebase's legacy runtime config
// (functions.config().stripe.secret) FIRST and the env second. If the legacy config still held a live
// key, switching the environment to a test key would have switched checkout only — a test membership
// next to live visit payments and payouts. Now every Stripe client asks this module:
//   • the environment value wins (it is the value stripe.ts and Evia's text checkout already use);
//   • the legacy config is only a fallback when the environment value is empty;
//   • if both are set and in different modes (test vs live) it says so loudly, once, in the logs.
import * as functions from "firebase-functions/v1";

export type StripeMode = "test" | "live" | "unknown";

/** "sk_test_…" / "rk_test_…" → test, "sk_live_…" / "rk_live_…" → live, anything else → unknown. */
export function stripeKeyMode(key: string | undefined | null): StripeMode {
  if (!key) return "unknown";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "unknown";
}

type LegacyStripeConfig = { secret?: string; connect_webhook_secret?: string };

// functions.config() throws or is absent outside a deployed function (tests, local scripts).
function legacyStripeConfig(): LegacyStripeConfig {
  try {
    const cfg = (functions as unknown as { config?: () => { stripe?: LegacyStripeConfig } }).config?.();
    return cfg?.stripe ?? {};
  } catch {
    return {};
  }
}

let warnedMismatch = false;

/** The Stripe secret key for every server-side Stripe client. Empty string when none is configured. */
export function getStripeSecretKey(): string {
  const fromEnv = process.env.STRIPE_SECRET_KEY || "";
  const legacy = legacyStripeConfig().secret || "";
  if (fromEnv && legacy && fromEnv !== legacy && stripeKeyMode(fromEnv) !== stripeKeyMode(legacy) && !warnedMismatch) {
    warnedMismatch = true;
    console.error(
      `[stripeConfig] STRIPE KEY MODE MISMATCH: the environment key is ${stripeKeyMode(fromEnv)} but the legacy functions config key is ${stripeKeyMode(legacy)}. ` +
      "Using the environment key everywhere. Remove or update functions.config().stripe.secret.",
    );
  }
  return fromEnv || legacy;
}

/** The Stripe Connect webhook signing secret — environment first, legacy config as a fallback. */
export function getConnectWebhookSecret(): string {
  return process.env.STRIPE_CONNECT_WEBHOOK_SECRET || legacyStripeConfig().connect_webhook_secret || "";
}
