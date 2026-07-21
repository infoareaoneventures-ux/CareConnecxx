import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    reset: () => docs.clear(),
    firestore: () => ({
      collection: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                get: async () => ({
                  docs: [...docs.entries()]
                    .filter(([, d]) =>
                      ["active", "waiting_user", "waiting_external", "blocked", "paused"].includes(String(d.status))
                      && typeof d.expiresAt === "string")
                    // queriedVersion simulates a snapshot that went stale
                    // between the query and the transaction (see conflict test).
                    .map(([id, d]) => ({ id, data: () => ({ ...d, version: d.queriedVersion ?? d.version }) })),
                }),
              }),
            }),
          }),
        }),
        doc: (id: string) => ({ __id: id }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        let capturedRef: { __id: string } | null = null;
        return fn({
          get: async (ref: { __id: string }) => {
            capturedRef = ref;
            const d = docs.get(ref.__id);
            return { exists: !!d, data: () => d };
          },
          set: (_ref: unknown, doc: Record<string, unknown>) => {
            if (capturedRef) docs.set(capturedRef.__id, doc);
          },
        });
      },
    }),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));
vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return { __esModule: true, pubsub: chain, https: { onCall: (fn: any) => fn, HttpsError: class extends Error {} } };
});

import { runObjectiveExpirySweep } from "./objectiveExpirySweeper";

const now = new Date("2026-07-21T12:00:00Z");
const objective = (id: string, over: Record<string, unknown> = {}) => ({
  objectiveId: id,
  userId: "u1", role: "client", channel: "linq", intent: "x",
  status: "waiting_user", steps: [], missingInputs: [], version: 1,
  createdAt: "2026-07-20T12:00:00.000Z", updatedAt: "2026-07-20T12:00:00.000Z",
  expiresAt: "2026-07-21T11:00:00.000Z",
  ...over,
});

describe("runObjectiveExpirySweep (U3 — transition, never delete)", () => {
  it("expires past-due nonterminal objectives through the ledger transition", async () => {
    hoisted.reset();
    hoisted.docs.set("a", objective("a"));
    const stats = await runObjectiveExpirySweep(now);
    expect(stats).toMatchObject({ scanned: 1, expired: 1, conflicts: 0, errors: 0 });
    const after = hoisted.docs.get("a")!;
    expect(after.status).toBe("expired");
    expect(after.version).toBe(2);
    expect(after.terminalReason).toBe("expiry_sweep");
  });

  it("skips not-yet-expired objectives via the pure eligibility check", async () => {
    hoisted.reset();
    hoisted.docs.set("future", objective("future", { expiresAt: "2026-07-22T11:00:00.000Z" }));
    const stats = await runObjectiveExpirySweep(now);
    expect(stats.expired).toBe(0);
    expect(hoisted.docs.get("future")!.status).toBe("waiting_user");
  });

  it("counts a mid-sweep version conflict as a conflict, not an error, and leaves the doc alone", async () => {
    hoisted.reset();
    // The queried snapshot reports version 1, but by transaction time the
    // stored doc has moved to version 2 (someone advanced it mid-sweep).
    hoisted.docs.set("raced", objective("raced", { version: 2, queriedVersion: 1 }));
    const stats = await runObjectiveExpirySweep(now);
    expect(stats.conflicts).toBe(1);
    expect(stats.expired).toBe(0);
    expect(stats.errors).toBe(0);
    const after = hoisted.docs.get("raced")!;
    expect(after.status).toBe("waiting_user");
    expect(after.version).toBe(2);
  });

  it("empty collection is a clean no-op", async () => {
    hoisted.reset();
    const stats = await runObjectiveExpirySweep(now);
    expect(stats).toEqual({ scanned: 0, expired: 0, conflicts: 0, errors: 0 });
  });
});
