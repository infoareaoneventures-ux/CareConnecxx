// B3 (caregiver sweep, 2026-10-11) at the router level — the Jobs page's
// sidebar over text:
//   · JOBS / JOBS <words> reach agents/jobBoardText.handleJobsKeyword with the
//     page keywords (before FAMILIES), so "JOBS" opens the page as it opens and
//     "JOBS mornings over $25" sets the sidebar;
//   · a bare JOBS that answers the agent's own parked question goes to the
//     agent, like every other page word (PAGE_KEYWORDS);
//   · a free-text follow-up ("only weekends") reaches handleJobsFilterFollowUp
//     only AFTER every page keyword and the KEYWORDS table — a page word still
//     opens its page, PAYOUT still opens Cash Out.
//
// Mock style mirrors routeCaregiver.shiftProposal.test.ts (in-memory
// Firestore, collaborators stubbed; assert on routing).

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

vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
const startInstantPayout = vi.fn(async (..._a: any[]) => ({ started: true }));
vi.mock("../../agents/instantPayoutHandler", () => ({
  handleInstantPayoutConfirm: vi.fn(async () => {}),
  startInstantPayout: (...a: any[]) => startInstantPayout(...a),
}));

// The Jobs page over text (B3) — the two router entry points, stubbed so the
// tests prove WHERE they sit, not what they text.
const handleJobsKeyword = vi.fn(async (_p: string, _c: string, _cg: string, text: string) => {
  const upper = text.trim().toUpperCase();
  return upper === "JOBS" || upper.startsWith("JOBS ") ? "handled" : "passthrough";
});
const handleJobsFilterFollowUp = vi.fn(async (_p: string, _c: string, _cg: string, text: string, _session: Record<string, unknown>) => (text.trim().toLowerCase() === "only weekends" ? "handled" : "passthrough"));
vi.mock("../../agents/jobBoardText", () => ({
  handleJobsKeyword: (...a: any[]) => (handleJobsKeyword as any)(...a),
  handleJobsFilterFollowUp: (...a: any[]) => (handleJobsFilterFollowUp as any)(...a),
}));

// Every other page keyword handler: CALENDAR opens the calendar (handled), everything else passes through.
const passthrough = () => vi.fn(async () => "passthrough");
const handleCalendarKeyword = vi.fn(async (_p: string, _c: string, _cg: string, text: string) => (text.trim().toUpperCase() === "CALENDAR" ? "handled" : "passthrough"));
vi.mock("../../agents/decisionNotices", () => ({ handlePendingDecisionReply: passthrough() }));
vi.mock("../../agents/caregiverShiftProposal", () => ({ handleWithdrawKeyword: passthrough() }));
vi.mock("../../agents/inShift", () => ({ handleInShiftKeyword: passthrough() }));
vi.mock("../../agents/visitMode", () => ({ handleVisitModeMessage: passthrough() }));
const handleFamiliesKeyword = passthrough();
vi.mock("../../agents/caregiverFamilies", () => ({ handleFamiliesKeyword: (...a: any[]) => (handleFamiliesKeyword as any)(...a) }));
vi.mock("../../agents/caregiverCalendar", () => ({ handleCalendarKeyword: (...a: any[]) => (handleCalendarKeyword as any)(...a) }));
vi.mock("../../agents/caregiverPastBookings", () => ({ handlePastBookingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMyProfile", () => ({ handleMyProfileKeyword: passthrough() }));
vi.mock("../../agents/caregiverSettings", () => ({ handleSettingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMembership", () => ({ handleMembershipKeyword: passthrough() }));
vi.mock("../../agents/caregiverPayouts", () => ({ handlePayoutsKeyword: passthrough() }));
vi.mock("../../agents/caregiverTimesheets", () => ({ handleTimesheetsKeyword: passthrough() }));
vi.mock("../../agents/familyRelay", () => ({
  handleLateKeyword: passthrough(),
  caregiverHasVisitSoon: vi.fn(async () => false),
  relayLateSentence: vi.fn(async () => {}),
}));

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

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockResolvedValue("NONE");
});

describe("JOBS — the Jobs page keyword sits with the page keywords", () => {
  it("JOBS is handled by the Jobs handler before the My Families page and the rest", async () => {
    seed();
    expect(await routeCaregiverMessage(ctx("JOBS"))).toBe("handled");
    expect(handleJobsKeyword).toHaveBeenCalledTimes(1);
    expect(handleJobsKeyword.mock.calls[0].slice(0, 4)).toEqual([CG_PHONE, "cg-chat", CAREGIVER_ID, "JOBS"]);
    expect(handleFamiliesKeyword).not.toHaveBeenCalled();
    expect(handleJobsFilterFollowUp).not.toHaveBeenCalled();
  });

  it("JOBS <words> goes to the same handler with the words intact (the sidebar set comes from the quick model inside it)", async () => {
    seed();
    expect(await routeCaregiverMessage(ctx("jobs morning shifts over $25 on weekends"))).toBe("handled");
    expect(handleJobsKeyword.mock.calls[0][3]).toBe("jobs morning shifts over $25 on weekends");
  });

  it("a bare JOBS that answers the agent's own parked question goes to the agent (PAGE_KEYWORDS), not to the page", async () => {
    seed();
    hoisted.docState.set(`agent_conversations/${CG_PHONE}/messages/m1`, { role: "assistant", content: "Do you want to see your bookings or the open jobs?", timestamp: Date.now() - 60_000 });
    quickComplete.mockResolvedValueOnce("YES");
    expect(await routeCaregiverMessage(ctx("jobs"))).toBe("fallthrough");
    expect(handleJobsKeyword).not.toHaveBeenCalled();
    // The same word with no parked question → the page.
    hoisted.docState.delete(`agent_conversations/${CG_PHONE}/messages/m1`);
    expect(await routeCaregiverMessage(ctx("jobs"))).toBe("handled");
    expect(handleJobsKeyword).toHaveBeenCalledTimes(1);
  });
});

describe("the filter follow-up runs after every page keyword and the KEYWORDS table", () => {
  it("\"only weekends\" reaches the follow-up handler (after the Jobs handler passed it by) and is handled", async () => {
    seed({ lastJobList: { at: new Date().toISOString(), items: [{ number: 1, jobId: "j1", title: "Job 1" }], offset: 1, total: 1, filters: { timeOfDay: ["morning"] } } });
    expect(await routeCaregiverMessage(ctx("only weekends"))).toBe("handled");
    expect(handleJobsKeyword).toHaveBeenCalledTimes(1);
    expect(handleJobsFilterFollowUp).toHaveBeenCalledTimes(1);
    expect(handleJobsFilterFollowUp.mock.calls[0].slice(0, 4)).toEqual([CG_PHONE, "cg-chat", CAREGIVER_ID, "only weekends"]);
    expect(handleJobsFilterFollowUp.mock.calls[0][4]).toMatchObject({ lastJobList: expect.objectContaining({ filters: { timeOfDay: ["morning"] } }) });
  });

  it("a page keyword still opens its page — CALENDAR never reaches the follow-up", async () => {
    seed({ lastJobList: { at: new Date().toISOString(), items: [], offset: 0, total: 0 } });
    expect(await routeCaregiverMessage(ctx("CALENDAR"))).toBe("handled");
    expect(handleCalendarKeyword).toHaveBeenCalledTimes(1);
    expect(handleJobsFilterFollowUp).not.toHaveBeenCalled();
  });

  it("a KEYWORDS-table word (PAYOUT) is answered before the follow-up", async () => {
    seed({ lastJobList: { at: new Date().toISOString(), items: [], offset: 0, total: 0 } });
    expect(await routeCaregiverMessage(ctx("PAYOUT"))).toBe("handled");
    expect(startInstantPayout).toHaveBeenCalledTimes(1);
    expect(handleJobsFilterFollowUp).not.toHaveBeenCalled();
  });

  it("anything the follow-up passes by routes on to the agent", async () => {
    seed();
    expect(await routeCaregiverMessage(ctx("can I apply to both?"))).toBe("fallthrough");
    expect(handleJobsFilterFollowUp).toHaveBeenCalledTimes(1);
  });
});
