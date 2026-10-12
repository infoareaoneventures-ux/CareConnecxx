// B1 + B4 + B6 (caregiver sweep, 2026-10-11) at the router level:
//   · WITHDRAW reaches the Active Bookings strip's Withdraw (agents/
//     caregiverShiftProposal.ts) before any page keyword;
//   · a parked withdraw pick ("Which visit?") owns the next reply;
//   · an EXPIRED decision marker (a replacement request that died) still routes
//     the reply through decisionNotices, so a late ACCEPT is refused there.
//
// Mock style mirrors routeCaregiver.parkedFlows.test.ts (in-memory Firestore,
// collaborators stubbed; assert on routing).

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const collDocs = (collPath: string) => {
    const prefix = collPath + "/";
    const out: Array<{ id: string; data: any }> = [];
    for (const [path, data] of docState) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes("/")) out.push({ id: rest, data });
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), id: path.split("/").pop(), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    },
    delete: async () => { docState.delete(path); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; op: string; val: any }> = [];
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
      }
      return {
        empty: items.length === 0,
        docs: items.map((it) => ({ id: it.id, data: () => it.data, ref: makeDocRef(`${collPath}/${it.id}`) })),
      };
    };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: { fromMillis: (ms: number) => ({ __timestampMs: ms }) },
  });

  return { docState, firestoreFn, reset: () => { docState.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: vi.fn(async () => ({ message_id: "m2" })),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "NONE");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));

const handleCaregiverCancelShift = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: (...a: any[]) => handleCaregiverCancelShift(...a) }));
const handleCaregiverProfileUpdate = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: (...a: any[]) => handleCaregiverProfileUpdate(...a) }));
const handleAvailabilityUpdate = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: (...a: any[]) => handleAvailabilityUpdate(...a) }));
const handleInstantPayoutConfirm = vi.fn(async (..._a: any[]) => {});
const startInstantPayout = vi.fn(async (..._a: any[]) => ({ started: true }));
vi.mock("../../agents/instantPayoutHandler", () => ({
  handleInstantPayoutConfirm: (...a: any[]) => handleInstantPayoutConfirm(...a),
  startInstantPayout: (...a: any[]) => startInstantPayout(...a),
}));
// The Payouts tab keywords (PAYOUTS · CASH OUT · SETUP …) — the handler that used
// to swallow CASH OUT before the parked confirm. Real behavior kept for CASH OUT so
// the ordering is what the tests prove, not the stub.
const handlePayoutsKeyword = vi.fn(async (_phone: string, _chatId: string, caregiverId: string, text: string) => {
  if (text.trim().toUpperCase() === "CASH OUT") { await startInstantPayout(caregiverId, _phone, _chatId); return "handled"; }
  return "passthrough";
});
vi.mock("../../agents/caregiverPayouts", () => ({ handlePayoutsKeyword: (...a: any[]) => (handlePayoutsKeyword as any)(...a) }));
// Pages that sit between the parked block and the Payouts keywords — stubbed to
// passthrough so a reply reaches the Payouts keyword when nothing is parked.
const passthrough = () => vi.fn(async () => "passthrough");
const handlePendingDecisionReply = vi.fn(async (..._a: any[]) => "passthrough" as "passthrough" | "handled");
vi.mock("../../agents/decisionNotices", () => ({ handlePendingDecisionReply: (...a: any[]) => (handlePendingDecisionReply as any)(...a) }));
const handleWithdrawKeyword = vi.fn(async (_p: string, _c: string, _cg: string, text: string, session: any) => (text.trim().toUpperCase() === "WITHDRAW" || session.pendingWithdrawChoice ? "handled" : "passthrough"));
vi.mock("../../agents/caregiverShiftProposal", () => ({ handleWithdrawKeyword: (...a: any[]) => (handleWithdrawKeyword as any)(...a) }));
vi.mock("../../agents/inShift", () => ({ handleInShiftKeyword: passthrough() }));
vi.mock("../../agents/visitMode", () => ({ handleVisitModeMessage: passthrough() }));
vi.mock("../../agents/caregiverFamilies", () => ({ handleFamiliesKeyword: passthrough() }));
vi.mock("../../agents/caregiverCalendar", () => ({ handleCalendarKeyword: passthrough() }));
vi.mock("../../agents/caregiverPastBookings", () => ({ handlePastBookingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMyProfile", () => ({ handleMyProfileKeyword: passthrough() }));
vi.mock("../../agents/caregiverSettings", () => ({ handleSettingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMembership", () => ({ handleMembershipKeyword: passthrough() }));

import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane", hourlyRate: 25 });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", phone: CG_PHONE, service: "SMS", userType: "caregiver", caregiverId: CAREGIVER_ID, userId: CAREGIVER_ID,
    onboardingStep: "complete",
    ...sessionPatch,
  });
}
const session = () => hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as Record<string, unknown>;
const ctx = (text: string) => ({ phone: CG_PHONE, chatId: "cg-chat", text, norm: text.toUpperCase().trim().replace(/\s+/g, " "), session: session() as any });
const inTenMinutes = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockResolvedValue("NONE");
});

describe("WITHDRAW — the strip's Withdraw on a proposal you sent (B4)", () => {
  it("WITHDRAW is handled by the shift-proposal handler, before any page keyword or the cancel flow", async () => {
    seed();
    const r = await routeCaregiverMessage(ctx("WITHDRAW"));
    expect(r).toBe("handled");
    expect(handleWithdrawKeyword).toHaveBeenCalledTimes(1);
    expect(handleWithdrawKeyword.mock.calls[0].slice(0, 4)).toEqual([CG_PHONE, "cg-chat", CAREGIVER_ID, "WITHDRAW"]);
    expect(handleCaregiverCancelShift).not.toHaveBeenCalled();
    expect(handlePayoutsKeyword).not.toHaveBeenCalled();
  });

  it("a parked \"Which visit?\" pick owns the next reply (a bare number goes to the handler, not to a page)", async () => {
    seed({ pendingWithdrawChoice: { candidates: [{ shiftId: "s1", line: "x" }, { shiftId: "s2", line: "y" }], at: new Date().toISOString(), expiresAt: inTenMinutes() } });
    const r = await routeCaregiverMessage(ctx("2"));
    expect(r).toBe("handled");
    expect(handleWithdrawKeyword).toHaveBeenCalledTimes(1);
    expect(handleWithdrawKeyword.mock.calls[0][3]).toBe("2");
  });

  it("any other text passes the handler by (it answers passthrough) and routes on", async () => {
    seed();
    const r = await routeCaregiverMessage(ctx("what jobs are near me?"));
    expect(r).toBe("fallthrough");
    expect(handleWithdrawKeyword).toHaveBeenCalledTimes(1);
  });
});

describe("an expired decision marker still routes through decisionNotices (B6)", () => {
  it("expiredDecision on the session (no pendingDecision) → handlePendingDecisionReply sees the reply", async () => {
    handlePendingDecisionReply.mockResolvedValueOnce("handled" as any);
    seed({ expiredDecision: { kind: "booking_request", recordId: "rep1", options: ["ACCEPT", "DECLINE", "DETAILS"], line: "Fam's replacement request has expired — nothing was sent.", expiredAt: new Date().toISOString(), until: inTenMinutes() } });
    const r = await routeCaregiverMessage(ctx("ACCEPT"));
    expect(r).toBe("handled");
    expect(handlePendingDecisionReply).toHaveBeenCalledTimes(1);
    expect(handlePendingDecisionReply.mock.calls[0][2]).toBe("ACCEPT");
    expect(handleWithdrawKeyword).not.toHaveBeenCalled(); // the decision block runs first
  });

  it("nothing parked and no marker → decisionNotices is never consulted", async () => {
    seed();
    await routeCaregiverMessage(ctx("ACCEPT"));
    expect(handlePendingDecisionReply).not.toHaveBeenCalled();
  });
});
