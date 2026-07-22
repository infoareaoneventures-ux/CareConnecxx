import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    firestore: () => ({
      collection: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                get: async () => ({ docs: hoisted.rows.map((d) => ({ data: () => d })) }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

import { loadUnifiedWorkInProgress } from "./unifiedWorkInProgress";

const now = new Date("2026-07-21T12:00:00Z");
const base = { userId: "u1", phone: "+14085550100", role: "client" as const, channel: "linq" as const, now };

const ledgerObjective = (id: string, updatedAt: string) => ({
  objectiveId: id, userId: "u1", role: "client", channel: "linq",
  intent: "schedule.reschedule_visit", status: "active", steps: [],
  missingInputs: [], version: 1, createdAt: updatedAt, updatedAt,
});

const liveGoal = {
  type: "booking" as const,
  description: "Book Tuesday visit",
  startedAt: "2026-07-21T10:00:00.000Z",
  turnsRemaining: 2,
  context: {},
};

describe("loadUnifiedWorkInProgress (U3/R15 — one WIP contract)", () => {
  it("unions a live legacy goal with ledger objectives and marks one foreground", async () => {
    hoisted.rows.length = 0;
    hoisted.rows.push(ledgerObjective("obj-1", "2026-07-21T11:30:00.000Z"));
    const wip = await loadUnifiedWorkInProgress({ ...base, session: { activeGoal: liveGoal } });
    expect(wip.items).toHaveLength(2);
    expect(wip.foregroundId).toBe("obj-1"); // more recently updated wins
    expect(wip.sources).toEqual({ ledger: 1, legacyGoal: "live" });
  });

  it("excludes a stale legacy goal exactly as resumeActiveGoal would (parity)", async () => {
    hoisted.rows.length = 0;
    const wip = await loadUnifiedWorkInProgress({
      ...base,
      session: { activeGoal: { ...liveGoal, turnsRemaining: 0 } },
    });
    expect(wip.items).toHaveLength(0);
    expect(wip.foregroundId).toBeNull();
    expect(wip.sources.legacyGoal).toBe("stale");
  });

  it("empty everything → empty aggregate, no foreground", async () => {
    hoisted.rows.length = 0;
    const wip = await loadUnifiedWorkInProgress({ ...base, session: null });
    expect(wip.items).toHaveLength(0);
    expect(wip.foregroundId).toBeNull();
    expect(wip.sources).toEqual({ ledger: 0, legacyGoal: "none" });
  });

  it("legacy-only WIP makes the projection foreground", async () => {
    hoisted.rows.length = 0;
    const wip = await loadUnifiedWorkInProgress({ ...base, session: { activeGoal: liveGoal } });
    expect(wip.foregroundId).toBe("legacy-activegoal:+14085550100");
  });
});
