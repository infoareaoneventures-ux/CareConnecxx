import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const adds: Array<{ path: string; data: any }> = [];
  return {
    adds,
    collectionMock: vi.fn((path: string) => ({
      add: vi.fn(async (data: any) => { adds.push({ path, data }); return { id: "auto" }; }),
    })),
    reset: () => { adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: {} }),
}));

import { projectEndState, endStatesAgree, maybeShadow, captureShadowComparison, type ShadowRun } from "./routingShadow";

const SHADOW: ShadowRun = { outcome: {}, latencyMs: 1200, reply: "Done", toolNames: ["create_reminder"], iterations: 2 };

describe("routingShadow harness (U6)", () => {
  beforeEach(() => { hoisted.reset(); delete process.env.ROUTING_CONVERGENCE_SHADOW; });
  afterEach(() => { delete process.env.ROUTING_CONVERGENCE_SHADOW; });

  it("projects reminder end-state to action/text/time only (ignores incidental fields)", () => {
    const p = projectEndState("reminder_management", { action: "created", text: "meds", time: "08:00", _internalId: "x", createdAt: "t" });
    expect(p).toEqual({ action: "created", text: "meds", time: "08:00" });
  });

  it("agrees when projected fields match despite incidental differences", () => {
    const live = { action: "created", text: "meds", time: "08:00", id: "L" };
    const shadow = { action: "created", text: "meds", time: "08:00", id: "S" };
    expect(endStatesAgree("reminder_management", live, shadow)).toBe(true);
  });

  it("disagrees when a projected field differs", () => {
    expect(endStatesAgree("reminder_management", { action: "created", time: "08:00" }, { action: "created", time: "09:00" })).toBe(false);
  });

  it("is a no-op (no shadow run, no write) when the flow flag is off", async () => {
    const runShadow = vi.fn(async () => SHADOW);
    await maybeShadow({ flow: "reminder_management", phone: "+1", liveOutcome: {}, liveLatencyMs: 100, runShadow });
    expect(runShadow).not.toHaveBeenCalled();
    expect(hoisted.adds.length).toBe(0);
  });

  it("runs the shadow and captures to routing_shadow when the flow is enabled", async () => {
    process.env.ROUTING_CONVERGENCE_SHADOW = "reminder_management";
    const runShadow = vi.fn(async () => SHADOW);
    await maybeShadow({ flow: "reminder_management", phone: "+1", liveOutcome: {}, liveLatencyMs: 100, runShadow });
    expect(runShadow).toHaveBeenCalledOnce();
    expect(hoisted.adds.length).toBe(1);
    expect(hoisted.adds[0].path).toBe("routing_shadow");
    expect(hoisted.adds[0].data.flow).toBe("reminder_management");
  });

  it("only shadows the enabled flow, not others", async () => {
    process.env.ROUTING_CONVERGENCE_SHADOW = "reminder_management";
    const runShadow = vi.fn(async () => SHADOW);
    await maybeShadow({ flow: "modify_schedule", phone: "+1", liveOutcome: {}, liveLatencyMs: 100, runShadow });
    expect(runShadow).not.toHaveBeenCalled();
  });

  it("captureShadowComparison records the agreement verdict", async () => {
    const agree = await captureShadowComparison({
      flow: "reminder_management", phone: "+1",
      live: { outcome: { action: "created", text: "a", time: "08:00" }, latencyMs: 50 },
      shadow: { ...SHADOW, outcome: { action: "created", text: "a", time: "08:00" } },
    });
    expect(agree).toBe(true);
    expect(hoisted.adds[0].data.agree).toBe(true);
  });
});
