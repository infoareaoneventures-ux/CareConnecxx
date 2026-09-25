import { describe, it, expect, vi, beforeEach } from "vitest";

// Flat membership (2026-09-25): Transportation added after the criminal check
// cleared → the MVR-only check starts from this trigger, with no charge.

vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onUpdate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

const hoisted = vi.hoisted(() => {
  const adds: any[] = [];
  const initiate = vi.fn(async () => {});
  return { adds, initiate };
});
vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({
    collection: () => ({ add: async (d: any) => { hoisted.adds.push(d); return { id: "a" }; } }),
  }), { FieldValue: {} });
  return { __esModule: true, firestore, default: { firestore } };
});
vi.mock("../../checkr", () => ({ initiateMvrOnlyCheck: (...a: unknown[]) => hoisted.initiate(...(a as [])) }));

import { needsMvrOnlyCheck, startMvrOnTransportationAdded } from "../transportationMvr";

const run = startMvrOnTransportationAdded as unknown as (change: any, ctx: any) => Promise<void>;
const change = (before: any, after: any) => ({ before: { data: () => before }, after: { data: () => after } });
const ctx = { params: { uid: "cg1" } };

const cleared = {
  services: ["Companionship"], membershipPaid: true,
  backgroundCheckData: { status: "clear" },
};

beforeEach(() => { hoisted.adds.length = 0; hoisted.initiate.mockClear(); });

describe("needsMvrOnlyCheck", () => {
  it("is true only for a paid, criminal-cleared caregiver who offers Transportation with no MVR yet", () => {
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"] })).toBe(true);
    expect(needsMvrOnlyCheck({ ...cleared, services: [], skills: ["Transportation"] })).toBe(true);
    expect(needsMvrOnlyCheck(cleared)).toBe(false);
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], membershipPaid: false })).toBe(false);
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], backgroundCheckData: { status: "pending" } })).toBe(false);
  });
  it("is false when the MVR is already covered: bundled report, badge granted, check initiated, or pending", () => {
    const t = { ...cleared, services: ["Transportation"] };
    expect(needsMvrOnlyCheck({ ...t, backgroundCheckData: { status: "clear", mvrIncluded: true } })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, isApprovedDriver: true })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, mvrCheckInitiated: true })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, mvrStatus: "pending" })).toBe(false);
  });
});

describe("startMvrOnTransportationAdded", () => {
  it("starts the MVR-only check when Transportation is added to a cleared caregiver", async () => {
    await run(change(cleared, { ...cleared, services: ["Companionship", "Transportation"] }), ctx);
    expect(hoisted.initiate).toHaveBeenCalledWith("cg1");
  });
  it("starts it when the criminal check clears for someone who already listed Transportation", async () => {
    const t = { ...cleared, services: ["Transportation"] };
    await run(change({ ...t, backgroundCheckData: { status: "pending" } }, t), ctx);
    expect(hoisted.initiate).toHaveBeenCalledTimes(1);
  });
  it("does nothing on an unrelated update once the need already existed", async () => {
    const t = { ...cleared, services: ["Transportation"] };
    await run(change(t, { ...t, bio: "edited" }), ctx);
    expect(hoisted.initiate).not.toHaveBeenCalled();
  });
  it("does nothing for a caregiver who never offered Transportation", async () => {
    await run(change(cleared, { ...cleared, bio: "edited" }), ctx);
    expect(hoisted.initiate).not.toHaveBeenCalled();
  });
  it("raises an admin alert instead of throwing when Checkr fails", async () => {
    hoisted.initiate.mockRejectedValueOnce(new Error("checkr down"));
    await run(change(cleared, { ...cleared, services: ["Transportation"] }), ctx);
    expect(hoisted.adds[0]).toMatchObject({ type: "mvr_init_failed", caregiverId: "cg1", severity: "high" });
  });
});
