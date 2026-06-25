import { describe, it, expect, vi, beforeEach } from "vitest";

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
const resolvePrimaryPhone = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("./familyGroupManager", () => ({ resolvePrimaryPhone: (...a: unknown[]) => (resolvePrimaryPhone as Function).apply(null, a as any[]) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../observability/actionLedger", () => ({ logAgentAction: (...a: unknown[]) => (h.logAgentAction as Function).apply(null, a as any[]) }));

import { proposePendingAction, claimPendingAction } from "./pendingActions";

beforeEach(() => { h.reset(); resolvePrimaryPhone.mockReset(); h.logAgentAction.mockClear(); });

describe("proposePendingAction — healthcare approver keying (H-U4)", () => {
  it("keys the doc under the account holder's phone and records the requester", async () => {
    resolvePrimaryPhone.mockResolvedValue("+1approver");
    const action = await proposePendingAction({
      phone: "+1requester", userId: "u1",
      toolName: "perform_web_action", toolInput: { loginAction: "schedule_appointment", doctorName: "Dr. Lee" },
    });
    expect(action.phone).toBe("+1approver");          // getAllPending(approver) will match
    expect(action.approverPhone).toBe("+1approver");
    expect(action.triggeredByPhone).toBe("+1requester");
    await vi.waitFor(() => expect(h.logAgentAction).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "healthcare_action",
      status: "proposed",
      userId: "u1",
      toolName: "perform_web_action",
    })));
  });

  it("fails closed when there is no userId to resolve the account holder", async () => {
    await expect(proposePendingAction({
      phone: "+1requester", toolName: "perform_web_action", toolInput: { loginAction: "pharmacy_refill" },
    })).rejects.toThrow();
  });

  it("fails closed when the account holder phone can't be resolved (no triggering-phone fallback)", async () => {
    resolvePrimaryPhone.mockResolvedValue(undefined);
    await expect(proposePendingAction({
      phone: "+1requester", userId: "u1", toolName: "perform_web_action", toolInput: { loginAction: "schedule_appointment" },
    })).rejects.toThrow();
  });

  it("leaves non-healthcare actions keyed under the requester (no approver hop)", async () => {
    const action = await proposePendingAction({
      phone: "+1requester", userId: "u1", toolName: "cancel_appointment", toolInput: { appointmentId: "a1" },
    });
    expect(action.phone).toBe("+1requester");
    expect(action.approverPhone).toBeUndefined();
    expect(resolvePrimaryPhone).not.toHaveBeenCalled();
  });
});

describe("claimPendingAction — exactly-once (H-U5)", () => {
  it("claims an awaiting action once; a second claim is not claimable", async () => {
    resolvePrimaryPhone.mockResolvedValue("+1approver");
    const action = await proposePendingAction({
      phone: "+1requester", userId: "u1", toolName: "perform_web_action", toolInput: { loginAction: "pharmacy_refill" },
    });
    expect(await claimPendingAction(action.id)).toBe("claimed");
    expect(h.docs.get(action.id)?.status).toBe("executing");
    expect(await claimPendingAction(action.id)).toBe("not_claimable"); // duplicate YES → no second dispatch
  });

  it("is not claimable when missing or expired", async () => {
    expect(await claimPendingAction("nope")).toBe("not_claimable");
  });
});
