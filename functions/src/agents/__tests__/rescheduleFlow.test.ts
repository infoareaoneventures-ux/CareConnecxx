import { describe, it, expect, vi, beforeEach } from "vitest";

// rescheduleFlow.ts (2026-09-15): the website's Reschedule button on an
// upcoming shift as a scripted SMS flow — the family's REAL scheduled visits
// (fresh) → pick → new day/time → own-visit conflict check → recap → YES →
// the same reschedulePending* write the button makes. Exercises the step
// machine directly, the same way replacementFlow.test.ts does.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id, path,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
        updates.push({ path, data });
      }),
    };
  };

  const cmp = (a: any, op: string, b: any) => {
    switch (op) {
      case "==": return a === b;
      case "in": return Array.isArray(b) && b.includes(a);
      case ">=": return String(a) >= String(b);
      default: return false;
    }
  };
  const makeQuery = (collName: string, conditions: Array<[string, string, any]>, orderField?: string): any => ({
    where: (f: string, op: string, v: any) => makeQuery(collName, [...conditions, [f, op, v]], orderField),
    orderBy: (f: string) => makeQuery(collName, conditions, f),
    limit: () => makeQuery(collName, conditions, orderField),
    get: async () => {
      const prefix = `${collName}/`;
      const docs = [...docState.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => conditions.every(([f, op, v]) => cmp((data as any)?.[f], op, v)))
        .sort(([, a], [, b]) => orderField ? String(a[orderField]).localeCompare(String(b[orderField])) : 0)
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });

  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where: (f: string, op: string, v: any) => makeQuery(collName, [[f, op, v]]),
  });

  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), arrayUnion: (...v: any[]) => ({ __arrayUnion: v }) },
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
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("../../utils/knownNames", () => ({ addKnownNames: vi.fn().mockResolvedValue(undefined) }));
// Pin "today" so date >= today filtering and past-date validation are stable.
vi.mock("../../utils/scheduledTime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../utils/scheduledTime")>();
  // 2026-09-15, 11:30 AM Pacific — so a 9/15 visit ending by 11:30 is Overdue.
  return { ...real, businessTodayStr: () => "2026-09-15", businessNowMinutes: () => 11 * 60 + 30 };
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

import { startRescheduleFlow, handleRescheduleFlowStep } from "../rescheduleFlow";
import { isShiftOverdue } from "../shiftReschedule";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...overrides };
}
function modelReplies(...texts: string[]) {
  for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] });
}
function lastSent(): string { return String(sendMessage.mock.calls.at(-1)![1]); }
function sess() { return hoisted.docState.get(`agent_sessions/${PHONE}`); }

// The live scenario: Tue 9/15 needs a replacement (NOT reschedulable), Wed
// 9/16 and Wed 9/23 are scheduled with Basra.
function seedBookings() {
  hoisted.docState.set("shifts/sh-tue", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "needs_replacement", date: "2026-09-15", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("shifts/sh-wed", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "scheduled", date: "2026-09-16", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("shifts/sh-wed2", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "scheduled", date: "2026-09-23", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("shifts/sh-old", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "completed", date: "2026-09-09", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
}

const VISITS = [
  { id: "sh-wed", date: "2026-09-16", startTime: "11:00", endTime: "13:00", caregiverId: "cg-basra", caregiverName: "Basra Yousuf" },
  { id: "sh-wed2", date: "2026-09-23", startTime: "11:00", endTime: "13:00", caregiverId: "cg-basra", caregiverName: "Basra Yousuf" },
];
const PICKED = { visits: VISITS, shiftId: "sh-wed", caregiverName: "Basra Yousuf", visitDate: "2026-09-16", visitStart: "11:00", visitEnd: "13:00" };
const PROPOSED = { ...PICKED, newDate: "2026-09-17", newStart: "10:00", newEnd: "15:00" };

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
});

// The site hides Reschedule on an Overdue visit (scheduled, but its end time
// has passed) — utils/shiftUtils.ts shiftDisplayStatus. Same rule server-side.
describe("isShiftOverdue — the site's Overdue rule", () => {
  const TODAY = "2026-09-15", NOW = 11 * 60 + 30;
  it("a past-day scheduled visit is overdue", () => {
    expect(isShiftOverdue({ status: "scheduled", date: "2026-09-14", startTime: "11:00", endTime: "13:00" }, TODAY, NOW)).toBe(true);
  });
  it("today's visit is overdue only once its end time has passed", () => {
    expect(isShiftOverdue({ status: "scheduled", date: TODAY, startTime: "08:00", endTime: "10:00" }, TODAY, NOW)).toBe(true);
    expect(isShiftOverdue({ status: "scheduled", date: TODAY, startTime: "11:00", endTime: "13:00" }, TODAY, NOW)).toBe(false);
  });
  it("a midnight-crossing visit is not falsely overdue", () => {
    expect(isShiftOverdue({ status: "scheduled", date: TODAY, startTime: "23:00", endTime: "01:00" }, TODAY, NOW)).toBe(false);
  });
  it("only 'scheduled' visits can be overdue", () => {
    expect(isShiftOverdue({ status: "needs_replacement", date: "2026-09-01", startTime: "11:00", endTime: "13:00" }, TODAY, NOW)).toBe(false);
  });
});

describe("startRescheduleFlow", () => {
  it("leaves an Overdue visit off the list, like the site hides its Reschedule button", async () => {
    seedBookings();
    hoisted.docState.set("shifts/sh-overdue", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "scheduled", date: "2026-09-15", startTime: "08:00", endTime: "10:00" });
    await startRescheduleFlow(PHONE, CHAT, session());
    expect(sess().rescheduleFlowData.visits.map((v: any) => v.id)).toEqual(["sh-wed", "sh-wed2"]);
    expect(lastSent()).not.toContain("8:00 AM");
  });

  it("lists ONLY real scheduled visits (never the needs_replacement or past ones) and asks which to move", async () => {
    seedBookings();
    const r = await startRescheduleFlow(PHONE, CHAT, session());
    expect(r.started).toBe(true);
    const text = lastSent();
    expect(text).toContain("1. Wednesday, September 16, 2026, 11:00 AM–1:00 PM with Basra Yousuf");
    expect(text).toContain("2. Wednesday, September 23, 2026, 11:00 AM–1:00 PM with Basra Yousuf");
    expect(text).not.toContain("September 15");
    expect(text).not.toContain("September 9");
    expect(sess().rescheduleFlowStep).toBe("rs_pick");
    expect(sess().rescheduleFlowData.visits.map((v: any) => v.id)).toEqual(["sh-wed", "sh-wed2"]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("reads the family's own words against the real list — '9/16 visit to 9/17 10am to 3pm' lands on the recap for the RIGHT visit", async () => {
    seedBookings();
    modelReplies(JSON.stringify({ pickIndex: null, pickDate: "2026-09-16", newDate: "2026-09-17", newStart: "10:00", newEnd: "15:00" }));
    const r = await startRescheduleFlow(PHONE, CHAT, session(), { initialText: "move the 9/16 visit to 9/17 10am to 3pm" });
    expect(r.started).toBe(true);
    expect(sess().rescheduleFlowStep).toBe("rs_confirm");
    expect(sess().rescheduleFlowData).toMatchObject({ shiftId: "sh-wed", newDate: "2026-09-17", newStart: "10:00", newEnd: "15:00" });
    const recap = lastSent();
    expect(recap).toContain("Move the Wednesday, September 16, 2026, 11:00 AM–1:00 PM visit with Basra Yousuf to Thursday, September 17, 2026, 10:00 AM–3:00 PM?");
    expect(recap).toContain("Reply YES");
    // Nothing written yet.
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
  });

  it("a single scheduled visit needs no pick — asks the new day/time straight away", async () => {
    seedBookings();
    hoisted.docState.delete("shifts/sh-wed2");
    const r = await startRescheduleFlow(PHONE, CHAT, session());
    expect(r.started).toBe(true);
    expect(sess().rescheduleFlowStep).toBe("rs_ask_time");
    expect(sess().rescheduleFlowData.shiftId).toBe("sh-wed");
    expect(lastSent()).toContain("What day and time should the Wednesday, September 16, 2026, 11:00 AM–1:00 PM visit move to?");
  });

  it("says plainly when there is nothing scheduled to move, and does not start", async () => {
    hoisted.docState.set("shifts/sh-tue", { clientId: UID, caregiverId: "cg-basra", status: "needs_replacement", date: "2026-09-15", startTime: "11:00", endTime: "13:00" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
    const r = await startRescheduleFlow(PHONE, CHAT, session(), { initialText: "move it to 9/17" });
    expect(r.started).toBe(false);
    expect(r.reason).toBe("no_visits");
    expect(lastSent()).toContain("don't see any upcoming scheduled visits to move");
    expect(sess().rescheduleFlowStep).toBeUndefined();
  });

  it("an agent-supplied shiftId that is NOT a scheduled visit is ignored, not trusted", async () => {
    seedBookings();
    hoisted.docState.delete("shifts/sh-wed2");
    const r = await startRescheduleFlow(PHONE, CHAT, session(), { shiftId: "sh-tue", date: "2026-09-17", startTime: "10:00", endTime: "15:00" });
    expect(r.started).toBe(true);
    // Only one real scheduled visit → that one, with the supplied time → recap.
    expect(sess().rescheduleFlowData.shiftId).toBe("sh-wed");
    expect(sess().rescheduleFlowStep).toBe("rs_confirm");
  });
});

describe("rs_pick", () => {
  it("a bare number picks the visit and asks the new time — no model call", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_pick", rescheduleFlowData: { visits: VISITS } });
    await handleRescheduleFlowStep(PHONE, CHAT, "2", session({ rescheduleFlowStep: "rs_pick" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(sess().rescheduleFlowStep).toBe("rs_ask_time");
    expect(sess().rescheduleFlowData.shiftId).toBe("sh-wed2");
    expect(lastSent()).toContain("September 23, 2026");
  });
});

describe("rs_ask_time", () => {
  it("'9/17 10am to 3pm' goes to the recap", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_ask_time", rescheduleFlowData: PICKED });
    modelReplies("NO", "NO", JSON.stringify({ date: "2026-09-17", start: "10:00", end: "15:00" }));
    await handleRescheduleFlowStep(PHONE, CHAT, "9/17 10am to 3pm", session({ rescheduleFlowStep: "rs_ask_time" }));
    expect(sess().rescheduleFlowStep).toBe("rs_confirm");
    expect(sess().rescheduleFlowData).toMatchObject({ newDate: "2026-09-17", newStart: "10:00", newEnd: "15:00" });
    expect(lastSent()).toContain("Thursday, September 17, 2026, 10:00 AM–3:00 PM");
  });

  it("a new time with no new day keeps the visit's own day", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_ask_time", rescheduleFlowData: PICKED });
    modelReplies("NO", "NO", JSON.stringify({ date: null, start: "14:00", end: "16:00" }));
    await handleRescheduleFlowStep(PHONE, CHAT, "2 to 4 instead", session({ rescheduleFlowStep: "rs_ask_time" }));
    expect(sess().rescheduleFlowData).toMatchObject({ newDate: "2026-09-16", newStart: "14:00", newEnd: "16:00" });
  });

  it("a day that already passed is refused and re-asked, not accepted", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_ask_time", rescheduleFlowData: PICKED });
    modelReplies("NO", "NO", JSON.stringify({ date: "2026-09-10", start: "10:00", end: "15:00" }));
    await handleRescheduleFlowStep(PHONE, CHAT, "9/10 10 to 3", session({ rescheduleFlowStep: "rs_ask_time" }));
    expect(sess().rescheduleFlowStep).toBe("rs_ask_time");
    expect(lastSent()).toContain("has already passed");
  });

  it("'never mind' backs out and changes nothing", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_ask_time", rescheduleFlowData: PICKED });
    modelReplies("YES"); // isBackOutRequest
    await handleRescheduleFlowStep(PHONE, CHAT, "never mind", session({ rescheduleFlowStep: "rs_ask_time" }));
    expect(sess().rescheduleFlowStep).toBeUndefined();
    expect(hoisted.updates.find((u) => u.path === "shifts/sh-wed")).toBeUndefined();
    expect(lastSent()).toContain("haven't changed anything");
  });
});

describe("rs_confirm", () => {
  it("a bare 'yes' writes exactly the site's reschedulePending* proposal — real date/time untouched, no model call", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "yes", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    const shift = hoisted.docState.get("shifts/sh-wed");
    expect(shift).toMatchObject({
      date: "2026-09-16", startTime: "11:00", endTime: "13:00", status: "scheduled",
      reschedulePendingDate: "2026-09-17", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "15:00", rescheduledBy: "client",
    });
    expect(typeof shift.reschedulePendingAt).toBe("string");
    // The needs_replacement visit next to it was never touched.
    expect(hoisted.docState.get("shifts/sh-tue").reschedulePendingDate).toBeUndefined();
    expect(sess().rescheduleFlowStep).toBeUndefined();
    const sent = lastSent();
    expect(sent).toContain("Sent — I asked Basra Yousuf to move the Wednesday, September 16, 2026, 11:00 AM–1:00 PM visit to Thursday, September 17, 2026, 10:00 AM–3:00 PM");
    expect(sent).toContain("stays as scheduled until they accept");
  });

  it("refuses a time that overlaps another visit with the same caregiver that day — the site's own conflict check — and re-asks", async () => {
    seedBookings();
    hoisted.docState.set("shifts/sh-thu", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "scheduled", date: "2026-09-17", startTime: "14:00", endTime: "16:00" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "yes", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
    expect(sess().rescheduleFlowStep).toBe("rs_ask_time");
    const sent = lastSent();
    expect(sent).toContain("overlaps another visit you already have with Basra Yousuf at 2:00 PM–4:00 PM on Thursday");
    expect(sent).toContain("What day and time");
  });

  it("a DIFFERENT caregiver at the same time is not a conflict (two-person care team), same as the site", async () => {
    seedBookings();
    hoisted.docState.set("shifts/sh-thu", { clientId: UID, caregiverId: "cg-maria", caregiverName: "Maria", status: "scheduled", date: "2026-09-17", startTime: "10:00", endTime: "12:00" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "YES", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBe("2026-09-17");
  });

  it("does not write if the visit became Overdue since the recap", async () => {
    seedBookings();
    hoisted.docState.set("shifts/sh-wed", { ...hoisted.docState.get("shifts/sh-wed"), date: "2026-09-14" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "yes", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
    expect(sess().rescheduleFlowStep).toBeUndefined();
  });

  it("does not write if the visit stopped being scheduled since the recap (changed on the site)", async () => {
    seedBookings();
    hoisted.docState.set("shifts/sh-wed", { ...hoisted.docState.get("shifts/sh-wed"), status: "cancelled" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "yes", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
    expect(lastSent()).toContain("isn't a scheduled visit anymore");
    expect(sess().rescheduleFlowStep).toBeUndefined();
  });

  it("a bare 'no' leaves the visit as is — no model call", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    await handleRescheduleFlowStep(PHONE, CHAT, "no", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
    expect(sess().rescheduleFlowStep).toBeUndefined();
  });

  it("'make it 11 to 1 instead' changes the proposal and re-shows the recap", async () => {
    seedBookings();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, rescheduleFlowStep: "rs_confirm", rescheduleFlowData: PROPOSED });
    modelReplies("NO", JSON.stringify({ action: "change_time", pickIndex: null, newDate: null, newStart: "11:00", newEnd: "13:00" }));
    await handleRescheduleFlowStep(PHONE, CHAT, "make it 11 to 1 instead", session({ rescheduleFlowStep: "rs_confirm" }));
    expect(sess().rescheduleFlowStep).toBe("rs_confirm");
    expect(sess().rescheduleFlowData).toMatchObject({ newDate: "2026-09-17", newStart: "11:00", newEnd: "13:00" });
    expect(lastSent()).toContain("Thursday, September 17, 2026, 11:00 AM–1:00 PM");
    expect(hoisted.docState.get("shifts/sh-wed").reschedulePendingDate).toBeUndefined();
  });
});
