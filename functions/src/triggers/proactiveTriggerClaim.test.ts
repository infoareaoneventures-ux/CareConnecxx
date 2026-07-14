import { describe, expect, it, vi } from "vitest";
import { claimProactiveTrigger, settleProactiveTriggerDelivery } from "./proactiveTriggerClaim";

function harness(initial: Record<string, unknown>) {
  let state = { ...initial };
  const ref = {
    update: vi.fn(async (data: Record<string, unknown>) => {
      state = { ...state, ...data };
    }),
  };
  const store = {
    runTransaction: async <T>(handler: (transaction: any) => Promise<T>) => handler({
      get: async () => ({ exists: true, data: () => ({ ...state }) }),
      update: (_ref: unknown, data: Record<string, unknown>) => {
        state = { ...state, ...data };
      },
    }),
  };
  return { ref, store, state: () => state };
}

describe("claimProactiveTrigger", () => {
  it("claims once before delivery and rejects a second worker", async () => {
    const h = harness({ firedAt: null, cancelledAt: null });
    expect(await claimProactiveTrigger(h.store, h.ref, "2026-07-13T12:00:00.000Z")).toBe(true);
    expect(h.state()).toMatchObject({ firedAt: "2026-07-13T12:00:00.000Z", deliveryState: "firing" });
    expect(await claimProactiveTrigger(h.store, h.ref, "2026-07-13T12:00:01.000Z")).toBe(false);
  });

  it("retains the claim after an ambiguous send error so the next tick cannot duplicate it", async () => {
    const h = harness({ firedAt: null, cancelledAt: null });
    await claimProactiveTrigger(h.store, h.ref, "2026-07-13T12:00:00.000Z");
    await settleProactiveTriggerDelivery(h.ref, "2026-07-13T12:00:02.000Z", new Error("provider timed out"));

    expect(h.state()).toMatchObject({
      firedAt: "2026-07-13T12:00:00.000Z",
      deliveryState: "failed_ambiguous",
      deliveryError: "provider timed out",
    });
    expect(await claimProactiveTrigger(h.store, h.ref, "2026-07-13T12:05:00.000Z")).toBe(false);
  });
});
