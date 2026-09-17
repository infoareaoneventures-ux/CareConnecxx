// U11 — routeClientStateMachines direct unit coverage. The handleInbound
// characterization suite mocks this module out entirely, so its branches were
// untested. Focus: the shift-hours APPROVE / DISPUTE money-path branches and
// the secondary-member guard (highest-risk client state machine).

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const adds: Array<{ path: string; data: any; id: string }> = [];
  let autoId = 0;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`),
    add: vi.fn(async (data: any) => {
      const id = `auto-${autoId++}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    }),
  });
  const firestoreFn: any = Object.assign(() => ({ collection: (p: string) => makeCollRef(p) }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __ts: true }) },
  });

  const sendMessage = vi.fn(async () => ({ message_id: "m1" }));
  const approveShiftHoursForClient = vi.fn(async () => {});
  const logAgentAction = vi.fn(async () => {});

  return {
    docState, updates, adds, firestoreFn, sendMessage, approveShiftHoursForClient, logAgentAction,
    reset: () => { docState.clear(); updates.length = 0; adds.length = 0; autoId = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

vi.mock("../client", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: (...a: any[]) => (hoisted.sendMessage as Function).apply(null, a),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
}));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "") }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../agents/jobPostingFlow", () => ({ handleJobPostingStep: vi.fn(async () => {}) }));
vi.mock("../../agents/refundHandler", () => ({ handleRefundRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/timesheetHandler", () => ({ handleTimesheetApproval: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/clientSwapRequestHandler", () => ({ handleClientSwapRequest: vi.fn(async () => {}) }));
// Dynamically-imported modules in the APPROVE/DISPUTE branch:
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../../shiftHours", () => ({ approveShiftHoursForClient: (...a: any[]) => (hoisted.approveShiftHoursForClient as Function).apply(null, a) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: (...a: any[]) => (hoisted.logAgentAction as Function).apply(null, a) }));

import { routeClientStateMachines } from "../routeClient";

const PHONE = "+15553334444";
const recentApproval = { appointmentId: "appt1", amount: "120.00", caregiverName: "Bob" };

function ctx(norm: string, sessionPatch: Record<string, unknown> = {}) {
  const session = {
    userId: "client1",
    phone: PHONE,
    pendingShiftApproval: recentApproval,
    pendingShiftApprovalSetAt: new Date().toISOString(),
    ...sessionPatch,
  };
  return { phone: PHONE, chatId: "chat1", text: norm, norm, session: session as any };
}

describe("U11 — routeClientStateMachines shift-hours approval", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

  it("APPROVE pays the caregiver, writes the action ledger, and confirms", async () => {
    const outcome = await routeClientStateMachines(ctx("APPROVE"));
    expect(outcome).toBe("handled");
    expect(hoisted.approveShiftHoursForClient).toHaveBeenCalledWith("appt1");
    expect(hoisted.logAgentAction).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "shift_hours_approved", status: "executed", targetDocId: "appt1",
    }));
    expect(hoisted.sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("Approved"));
  });

  it("DISPUTE files an admin alert and arms the dispute-detail follow-up", async () => {
    const outcome = await routeClientStateMachines(ctx("DISPUTE"));
    expect(outcome).toBe("handled");
    const alert = hoisted.adds.find(a => a.path === "admin_alerts");
    expect(alert?.data).toMatchObject({ type: "shift_hours_disputed", appointmentId: "appt1", resolved: false });
    // It must NOT pay the caregiver.
    expect(hoisted.approveShiftHoursForClient).not.toHaveBeenCalled();
    expect(hoisted.logAgentAction).toHaveBeenCalledWith(expect.objectContaining({ actionType: "shift_hours_disputed" }));
  });

  it("blocks a secondary member from approving/disputing payment", async () => {
    const outcome = await routeClientStateMachines(ctx("APPROVE", { isSecondaryMember: true }));
    expect(outcome).toBe("handled");
    expect(hoisted.approveShiftHoursForClient).not.toHaveBeenCalled();
    expect(hoisted.sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("primary account holder"));
  });

  it("clears a stale (>72h) pending approval instead of acting on it", async () => {
    const stale = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();
    const outcome = await routeClientStateMachines(ctx("APPROVE", { pendingShiftApprovalSetAt: stale }));
    // Stale approval is dropped; the APPROVE does not pay anyone.
    expect(hoisted.approveShiftHoursForClient).not.toHaveBeenCalled();
    expect(hoisted.updates.some(u => u.path === `agent_sessions/${PHONE}` && "pendingShiftApproval" in u.data)).toBe(true);
    expect(outcome).toBe("fallthrough");
  });
});

// U8 (hallucination hardening 2026-07-17, R11) — representative behavior test
// for the transactional route-reply group: the pre-shift task check-in
// confirmations interpolate the SENIOR's name, so their briefing context must
// carry describeWhoIsWho grounding (care belongs to the recipient, never to
// the account holder replying).
