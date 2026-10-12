import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { LIVE_SUBSCRIPTION_STATUSES, isLiveSubscriptionStatus, pickLiveSubscription, subscriptionRecencyMs } from "./liveSubscription";

// The ONE "live subscription record" rule (founder, 2026-10-11): active, trialing
// AND Stripe's retry states past_due / payment_failed; most recent wins. Read by
// v1-getSubscriptionDetails, Evia's caregiver Membership section and family
// Membership page here, and by the site's getSubscriptionStatus /
// listenToSubscriptionStatus through the verbatim twin at utils/liveSubscription.ts.

describe("LIVE_SUBSCRIPTION_STATUSES / isLiveSubscriptionStatus", () => {
  it("active, trialing, past_due and payment_failed are live; canceled / unpaid / incomplete / missing are not", () => {
    expect([...LIVE_SUBSCRIPTION_STATUSES]).toEqual(["active", "trialing", "past_due", "payment_failed"]);
    for (const s of LIVE_SUBSCRIPTION_STATUSES) expect(isLiveSubscriptionStatus(s)).toBe(true);
    for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "", undefined, null, 3]) expect(isLiveSubscriptionStatus(s)).toBe(false);
  });
});

describe("pickLiveSubscription", () => {
  it("null when nothing is live; the one live record otherwise — a retrying record counts", () => {
    expect(pickLiveSubscription([])).toBeNull();
    expect(pickLiveSubscription([{ status: "canceled" }, { status: "unpaid" }])).toBeNull();
    expect(pickLiveSubscription([{ status: "canceled", id: "old" }, { status: "past_due", id: "retry" }])?.id).toBe("retry");
    expect(pickLiveSubscription([{ status: "payment_failed", id: "failed" }])?.id).toBe("failed");
  });

  it("several live records → the most recently created (Stripe `created`, else current_period_start, else current_period_end), any timestamp shape", () => {
    const ts = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000) });
    expect(pickLiveSubscription([
      { status: "past_due", id: "older", created: ts("2026-01-01T00:00:00Z") },
      { status: "active", id: "newer", created: ts("2026-06-01T00:00:00Z") },
    ])?.id).toBe("newer");
    expect(pickLiveSubscription([
      { status: "active", id: "a", created: new Date("2026-06-01T00:00:00Z") },
      { status: "trialing", id: "b", created: { toMillis: () => Date.parse("2026-07-01T00:00:00Z") } },
      { status: "past_due", id: "c", created: { _seconds: Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000) } },
    ])?.id).toBe("b");
    // No `created` (an SMS-created record only mirrored by the updated handler) → the period start decides.
    expect(pickLiveSubscription([
      { status: "active", id: "x", current_period_start: ts("2026-03-01T00:00:00Z") },
      { status: "active", id: "y", current_period_start: ts("2026-04-01T00:00:00Z") },
    ])?.id).toBe("y");
    expect(subscriptionRecencyMs({ current_period_end: "2026-04-01T00:00:00Z" })).toBe(Date.parse("2026-04-01T00:00:00Z"));
    expect(subscriptionRecencyMs({})).toBe(0);
  });

  it("ties keep the query's order (stable)", () => {
    expect(pickLiveSubscription([{ status: "active", id: "first" }, { status: "active", id: "second" }])?.id).toBe("first");
  });
});

describe("the site's twin is verbatim", () => {
  it("utils/liveSubscription.ts (repo root) and functions/src/utils/liveSubscription.ts carry the same code below the header", () => {
    const here = fs.readFileSync(path.join(__dirname, "liveSubscription.ts"), "utf8");
    const site = fs.readFileSync(path.resolve(__dirname, "../../../utils/liveSubscription.ts"), "utf8");
    const body = (src: string) => src.slice(src.indexOf("export const LIVE_SUBSCRIPTION_STATUSES"));
    expect(body(site)).toBe(body(here));
  });
});
