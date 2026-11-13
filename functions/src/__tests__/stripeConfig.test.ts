import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const legacy = vi.hoisted(() => ({ cfg: {} as Record<string, unknown> }));
vi.mock("firebase-functions/v1", () => ({ config: () => legacy.cfg }));

import { getStripeSecretKey, getConnectWebhookSecret, stripeKeyMode } from "../stripeConfig";

const saved = { ...process.env };
beforeEach(() => { legacy.cfg = {}; delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET; });
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe("stripeKeyMode", () => {
  it("reads the mode from the key prefix", () => {
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode("whatever")).toBe("unknown");
    expect(stripeKeyMode(undefined)).toBe("unknown");
  });
});

describe("getStripeSecretKey — one answer for every Stripe client", () => {
  it("the environment key wins over the legacy functions config (a live legacy key can no longer override a test env key)", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_env";
    legacy.cfg = { stripe: { secret: "sk_live_legacy" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(getStripeSecretKey()).toBe("sk_test_env");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("STRIPE KEY MODE MISMATCH"));
  });

  it("falls back to the legacy config only when the environment value is empty", () => {
    legacy.cfg = { stripe: { secret: "sk_live_legacy" } };
    expect(getStripeSecretKey()).toBe("sk_live_legacy");
  });

  it("returns an empty string when nothing is configured, and survives a missing functions.config()", () => {
    expect(getStripeSecretKey()).toBe("");
    legacy.cfg = undefined as unknown as Record<string, unknown>;
    expect(getStripeSecretKey()).toBe("");
  });
});

describe("getConnectWebhookSecret", () => {
  it("environment first, legacy fallback", () => {
    legacy.cfg = { stripe: { connect_webhook_secret: "whsec_legacy" } };
    expect(getConnectWebhookSecret()).toBe("whsec_legacy");
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_env";
    expect(getConnectWebhookSecret()).toBe("whsec_env");
  });
});
