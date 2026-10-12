import { describe, it, expect, vi } from "vitest";

// The renewal timeline (founder, 2026-10-06): card reminder 7 days before the anniversary;
// after the renewal payment the caregiver stays cleared and has 7 days to authorize — a
// reminder on day 5, the lock on day 7. Pure decisions pinned here; the sweep itself is a
// thin loop over them.

vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }) }) },
    firestore: { document: () => ({ onUpdate: (h: any) => h, onWrite: (h: any) => h, onCreate: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} });
  return { __esModule: true, firestore, default: { firestore } };
});

import { renewalRefreshDecision, cardReminderDue, toMs } from "../renewalRefresh";
import { canWork, lockedNow } from "../../triggers/caregiverAccountEvents";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-10-06T12:00:00Z");

describe("renewalRefreshDecision — day 5 reminder, day 7 lock", () => {
  const asked = new Date(T0).toISOString();
  it("does nothing before day 5, reminds once on day 5–6, locks from day 7", () => {
    expect(renewalRefreshDecision({ status: "awaiting_consent", requestedAt: asked }, T0 + 4.9 * DAY)).toBe("none");
    expect(renewalRefreshDecision({ status: "awaiting_consent", requestedAt: asked }, T0 + 5 * DAY)).toBe("remind");
    expect(renewalRefreshDecision({ status: "awaiting_consent", requestedAt: asked, remindedAt: "x" }, T0 + 6 * DAY)).toBe("none");
    expect(renewalRefreshDecision({ status: "awaiting_consent", requestedAt: asked }, T0 + 7 * DAY)).toBe("lock");
    expect(renewalRefreshDecision({ status: "awaiting_consent", requestedAt: asked, remindedAt: "x" }, T0 + 9 * DAY)).toBe("lock");
  });
  it("never acts on a refresh that is running, cleared, locked or absent", () => {
    for (const status of ["running", "cleared", "locked", "review"]) {
      expect(renewalRefreshDecision({ status, requestedAt: asked }, T0 + 30 * DAY)).toBe("none");
    }
    expect(renewalRefreshDecision(undefined, T0)).toBe("none");
    expect(renewalRefreshDecision({ status: "awaiting_consent" }, T0)).toBe("none"); // no requestedAt → nothing to measure
  });
});

describe("cardReminderDue — exactly 7 days before the anniversary, once", () => {
  it("is true only inside the (6, 7] day window", () => {
    expect(cardReminderDue(T0 + 7 * DAY, T0)).toBe(true);
    expect(cardReminderDue(T0 + 6.5 * DAY, T0)).toBe(true);
    expect(cardReminderDue(T0 + 6 * DAY, T0)).toBe(false);
    expect(cardReminderDue(T0 + 8 * DAY, T0)).toBe(false);
    expect(cardReminderDue(T0 - DAY, T0)).toBe(false);
    expect(cardReminderDue(null, T0)).toBe(false);
  });
  it("reads Stripe's period end in seconds, ms, Date or Timestamp shapes", () => {
    expect(toMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(toMs(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(toMs(new Date(T0))).toBe(T0);
    expect(toMs({ seconds: 1_800_000_000 })).toBe(1_800_000_000_000);
    expect(toMs({ toDate: () => new Date(T0) })).toBe(T0);
    expect(toMs(undefined)).toBeNull();
  });
});

describe("lockedNow — the one signal that releases upcoming visits to the families", () => {
  const working = { membershipStatus: "active", verified: true, backgroundCheckStatus: "clear" };
  it("a working care provider: active (or in Stripe's retry state) AND cleared", () => {
    expect(canWork(working)).toBe(true);
    expect(canWork({ ...working, membershipStatus: "past_due" })).toBe(true);     // no lock while Stripe retries
    expect(canWork({ ...working, membershipStatus: "payment_failed" })).toBe(true);
    expect(canWork({ ...working, membershipStatus: "canceled" })).toBe(false);     // Stripe gave up
    expect(canWork({ ...working, verified: false, backgroundCheckStatus: "pending" })).toBe(false); // refresh not authorized in time / came back for review
    expect(canWork(undefined)).toBe(false);
  });
  it("fires once, on the working → not working edge only", () => {
    expect(lockedNow(working, { ...working, membershipStatus: "canceled" })).toBe(true);
    expect(lockedNow(working, { ...working, membershipStatus: "past_due" })).toBe(false);
    expect(lockedNow({ ...working, membershipStatus: "canceled" }, { ...working, membershipStatus: "canceled", bio: "x" })).toBe(false);
    expect(lockedNow({ ...working, membershipStatus: "canceled" }, working)).toBe(false); // unlocking never releases visits
    expect(lockedNow(working, { ...working, verified: false, backgroundCheckStatus: "consider", backgroundCheckComplete: false })).toBe(true);
  });
});
