import { describe, it, expect, vi, beforeEach } from "vitest";

// visitRequestFlow.ts (2026-09-16): the website's Calendar "+ Request Visit"
// modal as a scripted SMS flow — caregiver → booking → days → per-day times
// (with the modal's availability checks) → start → ongoing/end → note →
// recap → YES → the same booking_amendments write handleAddShift makes.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any }> = [];
  let autoId = 0;

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };
  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id, path,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any) => { docState.set(path, { ...data }); sets.push({ path, data }); }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
      }),
    };
  };
  const cmp = (a: any, op: string, b: any) => {
    switch (op) {
      case "==": return a === b;
      case "in": return Array.isArray(b) && b.includes(a);
      case ">=": return String(a) >= String(b);
      case "<=": return String(a) <= String(b);
      default: return false;
    }
  };
  const makeQuery = (collName: string, conditions: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(collName, [...conditions, [f, op, v]]),
    orderBy: () => makeQuery(collName, conditions),
    limit: () => makeQuery(collName, conditions),
    get: async () => {
      const prefix = `${collName}/`;
      const docs = [...docState.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => conditions.every(([f, op, v]) => cmp((data as any)?.[f], op, v)))
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  const makeCollRef = (collName: string): any => ({
    doc: (id?: string) => makeDocRef(collName, id ?? `auto-${++autoId}`),
    where: (f: string, op: string, v: any) => makeQuery(collName, [[f, op, v]]),
  });
  return {
    docState, sets,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; autoId = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../safety/outputGuard", () => ({ guardModelOutput: () => ({ ok: true }), ANTI_INVENTION_CLAUSE: "ANTI_INVENTION" }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => true }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../onboardingConversation", () => ({ sendOnboardingLink: vi.fn(async () => ({ success: true })) }));
vi.mock("../../utils/scheduledTime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../utils/scheduledTime")>();
  return { ...real, businessTodayStr: () => "2026-09-15", businessNowMinutes: () => 8 * 60 };
});
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: async () => {
    const r = await messagesCreate();
    const t = r?.content?.[0]?.text;
    return typeof t === "string" ? t : "__parse_error__";
  },
}));

import { startVisitRequestFlow, handleVisitRequestFlowStep, buildVisitRequestRecap } from "../visitRequestFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...overrides };
}
function modelReplies(...texts: string[]) { for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] }); }
function lastSent(): string { return String(sendMessage.mock.calls.at(-1)![1]); }
function sess() { return hoisted.docState.get(`agent_sessions/${PHONE}`); }
function amendmentSets() { return hoisted.sets.filter((s) => s.path.startsWith("booking_amendments/")); }

// Basra: one accepted booking (Tue/Wed 11–1) with scheduled visits; weekly
// availability Mon–Fri 9–5; booked with someone else Thu 2–4.
function seed() {
  hoisted.docState.set("booking_requests/br-basra", {
    clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "accepted", jobTitle: "Senior care in San Jose",
    address: "4746 Campbell Ave", schedule: { dayShiftTimes: { Tue: [{ start: "11:00", end: "13:00" }], Wed: [{ start: "11:00", end: "13:00" }] } },
  });
  hoisted.docState.set("shifts/sh-1", { clientId: UID, caregiverId: "cg-basra", bookingRequestId: "br-basra", status: "scheduled", date: "2026-09-16", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("publicCaregiverProfiles/cg-basra", { weeklyAvailability: {
    monday: [{ start: "09:00", end: "17:00" }], tuesday: [{ start: "09:00", end: "17:00" }], wednesday: [{ start: "09:00", end: "17:00" }],
    thursday: [{ start: "09:00", end: "17:00" }], friday: [{ start: "09:00", end: "17:00" }],
  } });
  hoisted.docState.set("caregiver_booked_slots/cg-basra", { slots: { Thu: [{ s: 14 * 60, e: 16 * 60 }], Tue: [{ s: 11 * 60, e: 13 * 60 }], Wed: [{ s: 11 * 60, e: 13 * 60 }] } });
  hoisted.docState.set("users/client-uid", { firstName: "Hamse", lastName: "M", identityCheckStatus: "verified", membershipStatus: "active" });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
}

const CAREGIVERS = [{ id: "cg-basra", name: "Basra Yousuf", bookings: [{ bookingId: "br-basra", jobTitle: "Senior care in San Jose", address: "4746 Campbell Ave", schedule: { Tue: [{ start: "11:00", end: "13:00" }], Wed: [{ start: "11:00", end: "13:00" }] } }] }];
const PICKED = { caregivers: CAREGIVERS, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", bookingId: "br-basra", jobTitle: "Senior care in San Jose" };
const READY = { ...PICKED, days: ["Thu"], dayTimes: { Thu: [{ start: "09:00", end: "13:00" }] }, startDate: "2026-09-22", ongoing: true, notes: "please use the side door" };

beforeEach(() => { hoisted.reset(); hoisted.docState.set("users/client-uid", { identityCheckStatus: "verified", membershipStatus: "active" }); sendMessage.mockClear(); messagesCreate.mockReset(); });

describe("startVisitRequestFlow", () => {
  it("is gated like the Calendar's + Request Visit button: a lapsed membership gets the plan text and no flow starts", async () => {
    hoisted.docState.set("users/client-uid", { identityCheckStatus: "verified", membershipStatus: "past_due" });
    const r = await startVisitRequestFlow(PHONE, CHAT, session(), {});
    expect(r).toEqual({ started: false, reason: "gated" });
    expect(sendMessage.mock.calls.map((c: any[]) => (typeof c[1] === "string" ? c[1] : JSON.stringify(c[1]))).join(" ")).toMatch(/Select a plan/);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.visitRequestFlowStep).toBeUndefined();
  });

  it("one caregiver, one booking, and the family's words carry the day + time → straight to the start-date question", async () => {
    seed();
    modelReplies(JSON.stringify({ days: ["Thu"], dayTimes: { Thu: [{ start: "09:00", end: "13:00" }] }, allDays: null }));
    const r = await startVisitRequestFlow(PHONE, CHAT, session(), { initialText: "add Thursdays 9am to 1pm with Basra" });
    expect(r.started).toBe(true);
    expect(sess().visitRequestFlowStep).toBe("vr_ask_start");
    expect(sess().visitRequestFlowData).toMatchObject({ caregiverId: "cg-basra", bookingId: "br-basra", days: ["Thu"], dayTimes: { Thu: [{ start: "09:00", end: "13:00" }] } });
    expect(lastSent()).toContain("Thursday, got it. When should this start?");
    expect(amendmentSets()).toHaveLength(0);
  });

  it("with no day given, asks which days and shows the caregiver's current schedule like the modal", async () => {
    seed();
    const r = await startVisitRequestFlow(PHONE, CHAT, session(), {});
    expect(r.started).toBe(true);
    expect(sess().visitRequestFlowStep).toBe("vr_ask_days");
    expect(lastSent()).toContain("Which day or days would you like to add?");
    expect(lastSent()).toContain("Tuesday 11:00 AM–1:00 PM");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("no active booking → says so honestly and does not start (the modal has nothing to pick)", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
    const r = await startVisitRequestFlow(PHONE, CHAT, session(), {});
    expect(r.started).toBe(false);
    expect(r.reason).toBe("no_active_booking");
    expect(lastSent()).toContain("don't see an active booking");
  });

  it("an accepted booking with no scheduled visits left is not offered (the modal hides it too)", async () => {
    seed();
    hoisted.docState.set("shifts/sh-1", { ...hoisted.docState.get("shifts/sh-1"), status: "completed" });
    const r = await startVisitRequestFlow(PHONE, CHAT, session(), {});
    expect(r.started).toBe(false);
  });
});

describe("vr_ask_times — the modal's availability checks", () => {
  function atTimes(days: string[]) {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_ask_times", visitRequestFlowData: { ...PICKED, days } });
  }

  it("refuses a time that overlaps a visit the family already has with the caregiver", async () => {
    seed(); atTimes(["Tue"]);
    modelReplies("NO", "NO", JSON.stringify({ dayTimes: { Tue: [{ start: "12:00", end: "14:00" }] }, allDays: null }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "12 to 2", session({ visitRequestFlowStep: "vr_ask_times" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_times");
    expect(lastSent()).toContain("Tuesday 12:00 PM–2:00 PM overlaps a visit you already have with Basra Yousuf (11:00 AM–1:00 PM)");
  });

  it("refuses a time the caregiver is booked elsewhere (the modal's greyed-out slots)", async () => {
    seed(); atTimes(["Thu"]);
    modelReplies("NO", "NO", JSON.stringify({ dayTimes: { Thu: [{ start: "15:00", end: "17:00" }] }, allDays: null }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "3 to 5", session({ visitRequestFlowStep: "vr_ask_times" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_times");
    expect(lastSent()).toContain("Basra Yousuf is already booked Thursday 2:00 PM–4:00 PM");
  });

  it("a time outside the caregiver's usual availability is allowed with a warning carried into the recap", async () => {
    seed(); atTimes(["Sat"]);
    modelReplies("NO", "NO", JSON.stringify({ dayTimes: { Sat: [{ start: "10:00", end: "12:00" }] }, allDays: null }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "10 to 12", session({ visitRequestFlowStep: "vr_ask_times" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_start");
    expect(sess().visitRequestFlowData.warnings[0]).toContain("Saturday 10:00 AM–12:00 PM is outside Basra Yousuf's usual availability");
  });

  it("one time for several days applies to each, and two blocks on one day are kept", async () => {
    seed(); atTimes(["Mon", "Fri"]);
    modelReplies("NO", "NO", JSON.stringify({ dayTimes: { Fri: [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }] }, allDays: { start: "09:00", end: "13:00" } }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "9-1, but Friday 9-11 and 2-4", session({ visitRequestFlowStep: "vr_ask_times" }));
    expect(sess().visitRequestFlowData.dayTimes).toEqual({ Mon: [{ start: "09:00", end: "13:00" }], Fri: [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }] });
    expect(sess().visitRequestFlowStep).toBe("vr_ask_start");
  });
});

describe("vr_ask_start / vr_ask_end / vr_ask_notes", () => {
  it("start date in the past is refused; a valid one moves to the end question", async () => {
    seed();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_ask_start", visitRequestFlowData: { ...PICKED, days: ["Thu"], dayTimes: READY.dayTimes } });
    modelReplies("NO", "NO", JSON.stringify({ date: "2026-09-01" }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "Sept 1", session({ visitRequestFlowStep: "vr_ask_start" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_start");
    expect(lastSent()).toContain("has already passed");
    modelReplies("NO", "NO", JSON.stringify({ date: "2026-09-22" }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "the 22nd", session({ visitRequestFlowStep: "vr_ask_start" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_end");
    expect(lastSent()).toContain("Starting Tuesday, September 22, 2026. Is this ongoing");
  });

  it("'ongoing' then a bare NO to notes lands on the recap with the modal's fields", async () => {
    seed();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_ask_end", visitRequestFlowData: { ...READY, ongoing: undefined, notes: undefined } });
    modelReplies("NO", "NO", JSON.stringify({ ongoing: true, endDate: null }));
    await handleVisitRequestFlowStep(PHONE, CHAT, "ongoing", session({ visitRequestFlowStep: "vr_ask_end" }));
    expect(sess().visitRequestFlowStep).toBe("vr_ask_notes");
    await handleVisitRequestFlowStep(PHONE, CHAT, "no", session({ visitRequestFlowStep: "vr_ask_notes" }));
    expect(sess().visitRequestFlowStep).toBe("vr_confirm");
    const recap = lastSent();
    expect(recap).toContain("Caregiver: Basra Yousuf");
    expect(recap).toContain("Booking: Senior care in San Jose");
    expect(recap).toContain("Days & times: Thursday 9:00 AM–1:00 PM (4h)");
    expect(recap).toContain("Starting: Tuesday, September 22, 2026 (ongoing)");
    expect(recap).toContain("Notes: None");
    expect(recap).toContain("Reply YES to send it");
  });
});

describe("vr_ask_notes — the modal's free-text Notes box", () => {
  function atNotes() {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_ask_notes", visitRequestFlowData: { ...READY, notes: undefined } });
  }
  // 2026-09-17 (live-caught): "this adding a shift" was dropped as a skip.
  it("a real sentence is stored verbatim as the note — only the back-out check runs, no skip/keep judgement", async () => {
    seed(); atNotes();
    modelReplies("NO"); // isBackOutRequest
    await handleVisitRequestFlowStep(PHONE, CHAT, "this is adding a shift", session({ visitRequestFlowStep: "vr_ask_notes" }));
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(sess().visitRequestFlowData.notes).toBe("this is adding a shift");
    expect(lastSent()).toContain('Notes: "this is adding a shift"');
  });

  it("a short reply is only a skip when the model says it is purely a decline", async () => {
    seed(); atNotes();
    modelReplies("NO", "DECLINE"); // back-out check, then the decline judgement
    await handleVisitRequestFlowStep(PHONE, CHAT, "nothing thanks", session({ visitRequestFlowStep: "vr_ask_notes" }));
    expect(sess().visitRequestFlowData.notes).toBeUndefined();
    expect(lastSent()).toContain("Notes: None");

    atNotes();
    modelReplies("NO", "NOTE");
    await handleVisitRequestFlowStep(PHONE, CHAT, "side door", session({ visitRequestFlowStep: "vr_ask_notes" }));
    expect(sess().visitRequestFlowData.notes).toBe("side door");
  });
});

describe("vr_confirm", () => {
  it("YES writes exactly the modal's booking_amendments doc — no model call", async () => {
    seed();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_confirm", visitRequestFlowData: READY });
    await handleVisitRequestFlowStep(PHONE, CHAT, "yes", session({ visitRequestFlowStep: "vr_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    const [am] = amendmentSets();
    expect(am.data).toMatchObject({
      bookingRequestId: "br-basra", clientId: UID, clientName: "Hamse M", caregiverId: "cg-basra", caregiverName: "Basra Yousuf",
      status: "pending", type: "add_recurring_days",
      newDays: { Thu: [{ start: "09:00", end: "13:00" }] },
      notes: "please use the side door", startDate: "2026-09-22", endDate: null, ongoing: true,
      createdAt: { __serverTimestamp: true },
    });
    expect(sess().visitRequestFlowStep).toBeUndefined();
    const sent = lastSent();
    expect(sent).toContain("Sent — I asked Basra Yousuf to add Thursday 9:00 AM–1:00 PM (4h) starting Tuesday, September 22, 2026");
    expect(sent).toContain("Nothing is added to the calendar until they accept");
  });

  it("an end date is written when not ongoing", async () => {
    seed();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_confirm", visitRequestFlowData: { ...READY, ongoing: false, endDate: "2026-10-30" } });
    await handleVisitRequestFlowStep(PHONE, CHAT, "YES", session({ visitRequestFlowStep: "vr_confirm" }));
    expect(amendmentSets()[0].data).toMatchObject({ ongoing: false, endDate: "2026-10-30" });
  });

  it("a bare NO cancels without writing anything", async () => {
    seed();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_confirm", visitRequestFlowData: READY });
    await handleVisitRequestFlowStep(PHONE, CHAT, "no", session({ visitRequestFlowStep: "vr_confirm" }));
    expect(amendmentSets()).toHaveLength(0);
    expect(sess().visitRequestFlowStep).toBeUndefined();
    expect(lastSent()).toContain("haven't sent anything");
  });

  it("re-checks availability at commit — a visit added on the site since the recap blocks the write", async () => {
    seed();
    hoisted.docState.set("shifts/sh-new", { clientId: UID, caregiverId: "cg-basra", bookingRequestId: "br-basra", status: "scheduled", date: "2026-09-17", startTime: "10:00", endTime: "12:00" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, visitRequestFlowStep: "vr_confirm", visitRequestFlowData: READY });
    await handleVisitRequestFlowStep(PHONE, CHAT, "yes", session({ visitRequestFlowStep: "vr_confirm" }));
    expect(amendmentSets()).toHaveLength(0);
    expect(sess().visitRequestFlowStep).toBe("vr_ask_times");
    expect(lastSent()).toContain("overlaps a visit you already have with Basra Yousuf");
  });

  it("recap builder shows warnings under the summary", () => {
    const recap = buildVisitRequestRecap({ ...READY, warnings: ["Saturday is outside Basra Yousuf's usual availability"] } as any);
    expect(recap).toContain("Note: Saturday is outside Basra Yousuf's usual availability");
  });
});
