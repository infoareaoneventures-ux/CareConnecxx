import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));
vi.mock("../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));

import { maybeSendWowMoment } from "./wowMomentsJob";
import type { WowContext, FireRecord } from "../agents/wowMoments";

const now = new Date("2026-06-17T17:00:00.000Z");

// A context that makes the "first_booking_confirmed" moment eligible.
function firstBookingCtx(): WowContext {
  return {
    seniorName: "Mom",
    completedVisits: 0,
    recentEvents: [{ type: "booking_confirmed", timestamp: new Date(now.getTime() - 3600_000).toISOString() }],
    now,
  };
}

// Typed as vi.fn() to allow .mock.calls assertions; cast at call sites to satisfy
// maybeSendWowMoment's typed send/record parameters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let send: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let record: any;
beforeEach(() => { send = vi.fn(async () => {}); record = vi.fn(async () => {}); });

describe("maybeSendWowMoment", () => {
  it("sends and records an eligible moment with no prior fires", async () => {
    const fired = await maybeSendWowMoment({ ctx: firstBookingCtx(), recentFires: [], send, record });
    expect(fired).toBe("first_booking_confirmed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][0])).toContain("Mom");
    expect(record).toHaveBeenCalledWith("first_booking_confirmed", now.toISOString());
  });

  it("does not re-send a moment still in cooldown", async () => {
    const recentFires: FireRecord[] = [{ name: "first_booking_confirmed", firedAt: now.toISOString() }];
    const fired = await maybeSendWowMoment({ ctx: firstBookingCtx(), recentFires, send, record });
    expect(fired).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is eligible", async () => {
    const emptyCtx: WowContext = { completedVisits: 0, recentEvents: [], now };
    const fired = await maybeSendWowMoment({ ctx: emptyCtx, recentFires: [], send, record });
    expect(fired).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
