import { describe, it, expect, vi, beforeEach } from "vitest";

// cancelFlow.ts (2026-09-17): the My Bookings page's cancel buttons as a
// scripted SMS flow — what can be cancelled right now (fresh) → which one →
// the site's own confirm wording → YES → the identical write via
// agents/bookingCancel.ts (shared with manage_booking).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };
  const applyUpdate = (path: string, data: any) => {
    const cur = { ...(docState.get(path) ?? {}) };
    for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
    docState.set(path, cur);
    updates.push({ path, data });
  };
  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id, path,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      update: vi.fn(async (data: any) => applyUpdate(path, data)),
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
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data, ref: makeDocRef(collName, path.slice(prefix.length)) }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where: (f: string, op: string, v: any) => makeQuery(collName, [[f, op, v]]),
  });
  const batch = () => ({
    update: (ref: any, data: any) => applyUpdate(ref.path, data),
    commit: async () => undefined,
  });
  return { docState, updates, collectionMock: vi.fn((p: string) => makeCollRef(p)), batch, reset: () => { docState.clear(); updates.length = 0; } };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock, batch: hoisted.batch }), {
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
vi.mock("../../utils/scheduledTime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../utils/scheduledTime")>();
  return { ...real, businessTodayStr: () => "2026-09-15", businessNowMinutes: () => 8 * 60 };
});
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }) }));
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: async () => { const r = await messagesCreate(); const t = r?.content?.[0]?.text; return typeof t === "string" ? t : "__parse_error__"; },
}));

import { startCancelFlow, handleCancelFlowStep } from "../cancelFlow";

const PHONE = "+15551234567", CHAT = "chat-1", UID = "client-uid";
function session(o: Record<string, unknown> = {}): any { return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...o }; }
function modelReplies(...t: string[]) { for (const x of t) messagesCreate.mockResolvedValueOnce({ content: [{ text: x }] }); }
function lastSent(): string { return String(sendMessage.mock.calls.at(-1)![1]); }
function sess() { return hoisted.docState.get(`agent_sessions/${PHONE}`); }

// The live page: an accepted ongoing booking with Basra (Wed 9/16 scheduled,
// Tue 9/15 needs replacement), a pending schedule-change request, a pending
// replacement request.
function seed() {
  hoisted.docState.set("booking_requests/br-active", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "accepted", schedule: { dayShiftTimes: { Wed: [{ start: "20:00", end: "21:30" }] } } });
  hoisted.docState.set("shifts/sh-wed", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", bookingRequestId: "br-active", status: "scheduled", date: "2026-09-16", startTime: "20:00", endTime: "21:30", reschedulePendingDate: "2026-09-17", rescheduledBy: "caregiver" });
  hoisted.docState.set("shifts/sh-tue", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", bookingRequestId: "br-active", status: "needs_replacement", date: "2026-09-15", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("shifts/sh-done", { clientId: UID, caregiverId: "cg-basra", bookingRequestId: "br-active", status: "completed", date: "2026-09-09", startTime: "11:00", endTime: "13:00" });
  hoisted.docState.set("booking_requests/br-repl", { clientId: UID, caregiverId: "cg-maria", caregiverName: "Maria Santos", status: "pending", isShiftReplacement: true, replacementForShiftId: "sh-tue" });
  hoisted.docState.set("booking_amendments/am-1", { clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", status: "pending", newDays: { Thu: [{ start: "09:00", end: "13:00" }] } });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
}

beforeEach(() => { hoisted.reset(); sendMessage.mockClear(); messagesCreate.mockReset(); });

describe("startCancelFlow", () => {
  it("lists exactly the page's cancel buttons, read fresh — visits, Skip, whole booking, pending requests — and asks which", async () => {
    seed();
    modelReplies(JSON.stringify({ pickIndex: null })); // a bare "cancel" names nothing — the model says so, the list is shown
    const r = await startCancelFlow(PHONE, CHAT, session(), { initialText: "cancel" });
    expect(r.started).toBe(true);
    expect(sess().cancelFlowStep).toBe("cx_pick");
    const text = lastSent();
    expect(text).toContain("Needs-replacement visit — Tuesday, September 15, 2026, 11:00 AM–1:00 PM with Basra Yousuf");
    expect(text).toContain("Visit — Wednesday, September 16, 2026, 8:00 PM–9:30 PM with Basra Yousuf");
    expect(text).toContain("Whole booking with Basra Yousuf (Wed 8:00 PM–9:30 PM) — 2 upcoming visits");
    expect(text).toContain("Replacement request to Maria Santos (awaiting response)");
    expect(text).toContain("Schedule-change request to Basra Yousuf (Thu 9:00 AM–1:00 PM)");
    expect(text).not.toContain("September 9");
  });

  it("the family's own words pick the item when unambiguous → straight to the site's confirm wording", async () => {
    seed();
    modelReplies(JSON.stringify({ pickIndex: 2 })); // the Wed visit
    const r = await startCancelFlow(PHONE, CHAT, session(), { initialText: "cancel Wednesday's visit" });
    expect(r.started).toBe(true);
    expect(sess().cancelFlowStep).toBe("cx_confirm");
    expect(lastSent()).toContain("Cancel only the Wednesday, September 16, 2026, 8:00 PM–9:30 PM visit with Basra Yousuf? The rest of the booking stays active.");
    expect(lastSent()).toContain("Reply YES to cancel it");
  });

  it("nothing cancellable → says so honestly and does not start", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
    const r = await startCancelFlow(PHONE, CHAT, session(), { initialText: "cancel" });
    expect(r.started).toBe(false);
    expect(lastSent()).toContain("don't see anything on your My Bookings page that can be cancelled");
  });
});

describe("cx_pick → cx_confirm → YES", () => {
  async function pick(n: string) {
    await startCancelFlow(PHONE, CHAT, session(), {});
    await handleCancelFlowStep(PHONE, CHAT, n, session({ cancelFlowStep: "cx_pick" }));
    expect(sess().cancelFlowStep).toBe("cx_confirm");
  }

  it("cancelling one visit writes the site's handleCancelShift fields and clears a pending reschedule", async () => {
    seed();
    await pick("2");
    await handleCancelFlowStep(PHONE, CHAT, "yes", session({ cancelFlowStep: "cx_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    const shift = hoisted.docState.get("shifts/sh-wed");
    expect(shift).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    expect(shift.reschedulePendingDate).toBeUndefined();
    expect(shift.rescheduledBy).toBeUndefined();
    expect(hoisted.docState.get("shifts/sh-tue").status).toBe("needs_replacement");
    expect(hoisted.docState.get("booking_requests/br-active").status).toBe("accepted");
    expect(sess().cancelFlowStep).toBeUndefined();
    expect(lastSent()).toContain("Done — the Wednesday, September 16, 2026, 8:00 PM–9:30 PM visit is cancelled. The rest of your booking is unchanged");
  });

  it("Skip on a Needs Replacement visit uses the same in-place cancel write", async () => {
    seed();
    await pick("1");
    expect(lastSent()).toContain("Skip the Tuesday, September 15, 2026, 11:00 AM–1:00 PM visit? No replacement caregiver will be arranged");
    await handleCancelFlowStep(PHONE, CHAT, "yes", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.docState.get("shifts/sh-tue")).toMatchObject({ status: "cancelled", cancelledBy: "client" });
  });

  it("cancelling the whole booking bulk-cancels every scheduled + needs-replacement visit and the booking, like handleCancelBooking", async () => {
    seed();
    await pick("3");
    expect(lastSent()).toContain("Cancel the whole booking with Basra Yousuf and all 2 upcoming visits?");
    await handleCancelFlowStep(PHONE, CHAT, "YES", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed")).toMatchObject({ status: "cancelled", bulkCancelled: true });
    expect(hoisted.docState.get("shifts/sh-tue")).toMatchObject({ status: "cancelled", bulkCancelled: true });
    expect(hoisted.docState.get("shifts/sh-done").status).toBe("completed");
    expect(hoisted.docState.get("booking_requests/br-active").status).toBe("cancelled");
    expect(lastSent()).toContain("the whole booking with Basra Yousuf is cancelled, including every upcoming visit");
  });

  it("withdrawing the replacement request cancels only that request — the visit stays Needs Replacement", async () => {
    seed();
    await pick("4");
    await handleCancelFlowStep(PHONE, CHAT, "yes", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.docState.get("booking_requests/br-repl")).toMatchObject({ status: "cancelled", updatedAt: { __serverTimestamp: true } });
    expect(hoisted.docState.get("shifts/sh-tue").status).toBe("needs_replacement");
    expect(lastSent()).toContain("The visit still shows Needs Replacement");
  });

  it("cancelling the schedule-change request writes the Requests tab's Cancel Request", async () => {
    seed();
    await pick("5");
    await handleCancelFlowStep(PHONE, CHAT, "yes", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.docState.get("booking_amendments/am-1").status).toBe("cancelled");
  });

  it("a bare NO keeps everything — nothing written", async () => {
    seed();
    await pick("2");
    await handleCancelFlowStep(PHONE, CHAT, "no", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.updates.filter((u) => u.path.startsWith("shifts/") || u.path.startsWith("booking_"))).toHaveLength(0);
    expect(sess().cancelFlowStep).toBeUndefined();
    expect(lastSent()).toContain("nothing was cancelled");
  });

  it("refuses to write if the visit changed on the site since the question was asked", async () => {
    seed();
    await pick("2");
    hoisted.docState.set("shifts/sh-wed", { ...hoisted.docState.get("shifts/sh-wed"), status: "completed" });
    await handleCancelFlowStep(PHONE, CHAT, "yes", session({ cancelFlowStep: "cx_confirm" }));
    expect(hoisted.docState.get("shifts/sh-wed").status).toBe("completed");
    expect(lastSent()).toContain("isn't in a state I can cancel anymore");
  });
});
