import { describe, it, expect, vi, beforeEach } from "vitest";

// The healthcare-approver-keying mechanism this file used to test (H-U4:
// routing a real-world healthcare action's approval to the account holder's
// phone rather than whoever triggered it) was removed 2026-09-05 along with
// perform_web_action itself — no site equivalent existed for that capability.
// This file now keeps only the generic claimPendingAction exactly-once
// coverage (H-U5), which applies to every pending action, not just
// healthcare ones.

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const logAgentAction = vi.fn(async () => {});
  let autoId = 0;
  const tx = {
    get: async (ref: { id: string }) => ({ exists: docs.has(ref.id), data: () => docs.get(ref.id) }),
    update: (ref: { id: string }, data: Record<string, unknown>) => { docs.set(ref.id, { ...docs.get(ref.id), ...data }); },
  };
  const collection = () => ({
    add: async (data: Record<string, unknown>) => { const id = `pa${++autoId}`; docs.set(id, data); return { id }; },
    doc: (id: string) => ({ id, get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }) }),
  });
  const db = { collection, runTransaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { docs, db, logAgentAction, reset: () => { docs.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    firestore: Object.assign(() => h.db, {
      Timestamp: { fromMillis: (ms: number) => ({ __timestampMs: ms }) },
    }),
  },
  firestore: Object.assign(() => h.db, {
    Timestamp: { fromMillis: (ms: number) => ({ __timestampMs: ms }) },
  }),
}));
vi.mock("../observability/actionLedger", () => ({
  logAgentAction: (...a: unknown[]) => (h.logAgentAction as (...args: unknown[]) => unknown)(...a),
}));

import { proposePendingAction, claimPendingAction } from "./pendingActions";

beforeEach(() => { h.reset(); h.logAgentAction.mockClear(); });

describe("claimPendingAction — exactly-once (H-U5)", () => {
  it("claims an awaiting action once; a second claim is not claimable", async () => {
    const action = await proposePendingAction({
      phone: "+1requester", userId: "u1", toolName: "cancel_job_post", toolInput: { jobId: "a1" },
    });
    expect(await claimPendingAction(action.id)).toBe("claimed");
    expect(h.docs.get(action.id)?.status).toBe("executing");
    expect(await claimPendingAction(action.id)).toBe("not_claimable"); // duplicate YES → no second dispatch
  });

  it("is not claimable when missing or expired", async () => {
    expect(await claimPendingAction("nope")).toBe("not_claimable");
  });
});
