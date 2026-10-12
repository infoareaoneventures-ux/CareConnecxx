// Page keywords yield to a parked question (caregiver sweep C20, 2026-10-11)
// and the LATE classifier runs only when a visit is near (C21).
//
// Live before this: the agent asked "Which day works — today or tomorrow?" and
// the caregiver's "today" printed today's calendar (TODAY is a Calendar page
// keyword); every caregiver text that fell through paid an LLM call to ask
// whether it meant "running late". SCHEDULE opened the availability editor
// instead of the schedule, and a REACTIVATE entry in KEYWORDS was unreachable.
//
// Mock style mirrors routeCaregiver.parkedFlows.test.ts (in-memory Firestore,
// collaborators stubbed; assert on calls + outbound messages).

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
    let order: { field: string; dir: string } | null = null;
    let limitN: number | null = null;
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (field: string, dir = "asc") => { order = { field, dir }; return ref; };
    ref.limit = (n: number) => { limitN = n; return ref; };
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
        if (f.op === "in") items = items.filter((it) => (f.val as any[]).includes(it.data?.[f.field]));
      }
      if (order) {
        const { field, dir } = order;
        items.sort((a, b) => (a.data?.[field] > b.data?.[field] ? 1 : a.data?.[field] < b.data?.[field] ? -1 : 0) * (dir === "desc" ? -1 : 1));
      }
      if (limitN !== null) items = items.slice(0, limitN);
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
vi.mock("../../utils/chatThread", () => ({ relayIntoSharedChatThread: vi.fn(async () => {}) }));

vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/instantPayoutHandler", () => ({ handleInstantPayoutConfirm: vi.fn(async () => {}), startInstantPayout: vi.fn(async () => ({ started: true })) }));

// Pages stubbed to passthrough; the Calendar handler is a spy so C20 / SCHEDULE can assert on it.
const passthrough = () => vi.fn(async () => "passthrough");
const handleCalendarKeyword = vi.fn(async (..._a: any[]) => "passthrough");
vi.mock("../../agents/decisionNotices", () => ({ handlePendingDecisionReply: passthrough() }));
vi.mock("../../agents/inShift", () => ({ handleInShiftKeyword: passthrough() }));
vi.mock("../../agents/visitMode", () => ({ handleVisitModeMessage: passthrough() }));
vi.mock("../../agents/caregiverFamilies", () => ({ handleFamiliesKeyword: passthrough() }));
vi.mock("../../agents/caregiverCalendar", () => ({ handleCalendarKeyword: (...a: any[]) => handleCalendarKeyword(...a) }));
vi.mock("../../agents/caregiverPastBookings", () => ({ handlePastBookingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMyProfile", () => ({ handleMyProfileKeyword: passthrough() }));
vi.mock("../../agents/caregiverSettings", () => ({ handleSettingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMembership", () => ({ handleMembershipKeyword: passthrough() }));
vi.mock("../../agents/caregiverPayouts", () => ({ handlePayoutsKeyword: passthrough() }));
vi.mock("../../agents/caregiverTimesheets", () => ({ handleTimesheetsKeyword: passthrough() }));

import { routeCaregiverMessage, lastParkedAgentQuestion, PARKED_QUESTION_WINDOW_MS } from "../routeCaregiver";
import { businessTodayStr } from "../../utils/scheduledTime";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane", hourlyRate: 25, membershipStatus: "active" });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", phone: CG_PHONE, service: "SMS", userType: "caregiver", caregiverId: CAREGIVER_ID, userId: CAREGIVER_ID,
    onboardingStep: "complete",
    ...sessionPatch,
  });
}
const session = () => hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as Record<string, unknown>;
const ctx = (text: string) => ({ phone: CG_PHONE, chatId: "cg-chat", text, norm: text.toUpperCase().trim().replace(/\s+/g, " "), session: session() as any });
const askedAgo = (content: string, msAgo: number) => {
  hoisted.docState.set(`agent_conversations/${CG_PHONE}/messages/m1`, { role: "user", content: "hi", timestamp: Date.now() - msAgo - 1 });
  hoisted.docState.set(`agent_conversations/${CG_PHONE}/messages/m2`, { role: "assistant", content, timestamp: Date.now() - msAgo });
};
const lateClassifierCalls = () => quickComplete.mock.calls.filter((c) => /Classify this care provider message: LATE/.test(String(c[0])));
const parkedCheckCalls = () => quickComplete.mock.calls.filter((c) => /also a command that opens a page/.test(String(c[0])));

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockResolvedValue("NONE");
  handleCalendarKeyword.mockResolvedValue("passthrough");
});

describe("page keywords yield to a parked question (C20)", () => {
  it("'today' answering 'Which day works — today or tomorrow?' goes to the agent, not the Calendar page", async () => {
    seed();
    askedAgo("Which day works for you — today or tomorrow?", 60_000);
    quickComplete.mockImplementation(async (sys: string) => (/also a command that opens a page/.test(sys) ? "YES" : "NONE"));
    const r = await routeCaregiverMessage(ctx("today"));
    expect(r).toBe("fallthrough");
    expect(handleCalendarKeyword).not.toHaveBeenCalled();
    expect(parkedCheckCalls()).toHaveLength(1);
    expect(String(parkedCheckCalls()[0][1])).toContain("Which day works for you");
  });

  it("the same word judged a page command (NO) still opens the page", async () => {
    seed();
    askedAgo("Anything else I can do for you today?", 60_000);
    quickComplete.mockImplementation(async (sys: string) => (/also a command that opens a page/.test(sys) ? "NO" : "NONE"));
    handleCalendarKeyword.mockResolvedValueOnce("handled");
    const r = await routeCaregiverMessage(ctx("TODAY"));
    expect(r).toBe("handled");
    expect(handleCalendarKeyword).toHaveBeenCalledTimes(1);
    expect(handleCalendarKeyword.mock.calls[0][3]).toBe("TODAY");
  });

  it("no parked question (last outbound not a question, or outside the window) → no model call, the keyword fires", async () => {
    seed();
    askedAgo("Got it — your Tuesday visit is confirmed.", 60_000);
    await routeCaregiverMessage(ctx("TODAY"));
    expect(parkedCheckCalls()).toHaveLength(0);
    expect(handleCalendarKeyword).toHaveBeenCalledTimes(1);

    vi.clearAllMocks(); quickComplete.mockResolvedValue("NONE"); handleCalendarKeyword.mockResolvedValue("passthrough");
    askedAgo("Which day works for you — today or tomorrow?", PARKED_QUESTION_WINDOW_MS + 1000);
    await routeCaregiverMessage(ctx("TODAY"));
    expect(parkedCheckCalls()).toHaveLength(0);
    expect(handleCalendarKeyword).toHaveBeenCalledTimes(1);
  });

  it("a multi-word reply or a non-keyword never triggers the check", async () => {
    seed();
    askedAgo("Which day works for you — today or tomorrow?", 60_000);
    await routeCaregiverMessage(ctx("today works"));
    await routeCaregiverMessage(ctx("yes"));
    expect(parkedCheckCalls()).toHaveLength(0);
  });

  it("lastParkedAgentQuestion: only an assistant turn ending in '?' inside the window", async () => {
    askedAgo("Which day works for you — today or tomorrow?", 60_000);
    expect(await lastParkedAgentQuestion(CG_PHONE)).toBe("Which day works for you — today or tomorrow?");
    askedAgo("Sounds good.", 60_000);
    expect(await lastParkedAgentQuestion(CG_PHONE)).toBeNull();
    expect(await lastParkedAgentQuestion("+10000000000")).toBeNull();
  });

  it("SCHEDULE / MY SCHEDULE show the Calendar (the page's schedule view), not the availability editor", async () => {
    seed();
    handleCalendarKeyword.mockResolvedValue("handled");
    await routeCaregiverMessage(ctx("SCHEDULE"));
    await routeCaregiverMessage(ctx("my schedule"));
    expect(handleCalendarKeyword).toHaveBeenCalledTimes(2);
    expect(handleCalendarKeyword.mock.calls[0][3]).toBe("CALENDAR");
    expect(handleCalendarKeyword.mock.calls[1][3]).toBe("CALENDAR");
    // AVAILABILITY is untouched: it passes the calendar as itself (the My Profile editor owns it).
    handleCalendarKeyword.mockResolvedValue("passthrough");
    await routeCaregiverMessage(ctx("AVAILABILITY"));
    expect(handleCalendarKeyword.mock.calls[2][3]).toBe("AVAILABILITY");
  });

  it("the dead REACTIVATE keyword entry is gone — with the Settings handler stubbed, nothing else claims the word", async () => {
    seed();
    const r = await routeCaregiverMessage(ctx("REACTIVATE"));
    expect(r).toBe("fallthrough");
  });
});

describe("the LATE classifier runs only when a visit is near (C21)", () => {
  it("no visit today or soon → no classifier call, straight to the agent", async () => {
    seed();
    const r = await routeCaregiverMessage(ctx("can you show me my earnings for last month"));
    expect(r).toBe("fallthrough");
    expect(lateClassifierCalls()).toHaveLength(0);
  });

  it("a visit today → the classifier runs (and a LATE verdict parks the relay confirm)", async () => {
    seed();
    hoisted.docState.set("shifts/s1", { caregiverId: CAREGIVER_ID, clientId: "fam1", clientName: "Basra Yousuf", status: "scheduled", date: businessTodayStr(), startTime: "14:00" });
    quickComplete.mockImplementation(async (sys: string) => (/Classify this care provider message: LATE/.test(sys) ? "LATE" : "NONE"));
    const r = await routeCaregiverMessage(ctx("running about 10 min late, traffic"));
    expect(r).toBe("handled");
    expect(lateClassifierCalls()).toHaveLength(1);
    expect(sendMessage.mock.calls.some((c) => /Send to Basra Yousuf as your message/.test(String(c[1])))).toBe(true);
  });

  it("a completed visit today does not count", async () => {
    seed();
    hoisted.docState.set("shifts/s1", { caregiverId: CAREGIVER_ID, clientId: "fam1", status: "completed", date: businessTodayStr(), startTime: "08:00" });
    await routeCaregiverMessage(ctx("stuck in traffic"));
    expect(lateClassifierCalls()).toHaveLength(0);
  });
});
