import { describe, it, expect, vi, beforeEach } from "vitest";

// shifts/visitActions.ts (2026-10-11): the caregiver's Start / End / Cancel /
// Log Hours, ONCE, server-side — the site's queue and Evia's keywords both end
// here. These tests pin every refusal reason and each happy path's exact write.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  batchCommits: 0,
}));
vi.mock("firebase-admin", () => {
  const ref = (name: string, id: string) => ({
    path: `${name}/${id}`,
    get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
    update: vi.fn(async (d: any) => {
      hoisted.updates.push({ path: `${name}/${id}`, data: d });
      if (hoisted.docs.has(`${name}/${id}`)) hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d });
    }),
  });
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()]
            .filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, op, v]) => op === "in" ? (v as any[]).includes(d[f]) : d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d, ref: ref(name, p.split("/")[1]) }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return { doc: (id: string) => ref(name, id), where: (f: string, op: string, v: any) => q([[f, op, v]]) };
    },
    batch: () => ({
      update: (r: any, d: any) => { hoisted.updates.push({ path: r.path, data: d }); const cur = hoisted.docs.get(r.path); if (cur) hoisted.docs.set(r.path, { ...cur, ...d }); },
      commit: vi.fn(async () => { hoisted.batchCommits += 1; }),
    }),
  }), {
    FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__delete__" },
    Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async () => ({ message_id: "m" })) }));

import {
  startVisit, endVisit, cancelVisit, cancelBooking, logHours,
  startRefusal, endRefusal, cancelRefusal, logHoursRefusal, isUrgentCancel, isMissedVisit, startsInMinutes, finishFirstText,
  START_WINDOW_MINUTES, CANCEL_URGENT_HOURS,
} from "../visitActions";

const la = (d: Date) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
const inMinutes = (m: number) => la(new Date(Date.now() + m * 60 * 1000));
const CG = "cg1";
const shift = (id: string, over: Record<string, unknown> = {}) => hoisted.docs.set(`shifts/${id}`, { caregiverId: CG, clientId: "fam1", clientName: "Basra Yousuf", bookingRequestId: "br1", status: "scheduled", date: "2099-09-28", startTime: "11:00", endTime: "14:00", tasksCompleted: [], ...over });
const cleared = (over: Record<string, unknown> = {}) => hoisted.docs.set(`caregivers/${CG}`, { membershipStatus: "active", verified: true, ...over });
const shiftWrites = (id: string) => hoisted.updates.filter((u) => u.path === `shifts/${id}`);

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.batchCommits = 0; cleared(); });

describe("pure rules", () => {
  it("constants: Start opens 15 minutes early; a cancel inside 24 hours is urgent", () => {
    expect(START_WINDOW_MINUTES).toBe(15);
    expect(CANCEL_URGENT_HOURS).toBe(24);
  });
  it("isUrgentCancel — within 24h (or already started) → needs_replacement; further out → cancelled", () => {
    const soon = inMinutes(2 * 60), far = inMinutes(30 * 60), past = inMinutes(-60);
    expect(isUrgentCancel({ date: soon.date, startTime: soon.time })).toBe(true);
    expect(isUrgentCancel({ date: far.date, startTime: far.time })).toBe(false);
    expect(isUrgentCancel({ date: past.date, startTime: past.time })).toBe(true);
    expect(isUrgentCancel({})).toBe(false);
  });
  it("isMissedVisit — scheduled AND its window has passed (the Past tab's Overdue)", () => {
    expect(isMissedVisit({ status: "scheduled", date: "2000-01-01", startTime: "19:30", endTime: "19:45" })).toBe(true);
    expect(isMissedVisit({ status: "scheduled", date: "2099-01-01", startTime: "19:30", endTime: "19:45" })).toBe(false);
    expect(isMissedVisit({ status: "completed", date: "2000-01-01" })).toBe(false);
  });
  it("finishFirstText — the site's words (utils/shiftStart.ts)", () => {
    expect(finishFirstText({ clientName: "Basra Yousuf" })).toBe("Finish your visit with Basra Yousuf first.");
    expect(finishFirstText({})).toBe("Finish your current visit first.");
    expect(finishFirstText(null)).toBe("Finish your current visit first.");
  });
  it("startsInMinutes — null without a usable time", () => {
    expect(startsInMinutes({})).toBeNull();
    const m = startsInMinutes({ date: "2099-09-28", startTime: "11:00" });
    expect(m).not.toBeNull(); expect(m!).toBeGreaterThan(0);
  });
});

describe("startRefusal — the Start Shift button's conditions, in order", () => {
  const base = () => { const w = inMinutes(5); return { date: w.date, startTime: w.time, endTime: "23:59", status: "scheduled", caregiverId: CG, clientName: "Basra Yousuf" }; };
  const ok = { caregiverId: CG, gateBlock: null, caregiver: {}, otherOpen: null };
  it("not the shift's caregiver → not_yours", () => {
    expect(startRefusal({ ...ok, shift: { ...base(), caregiverId: "someone" } })).toMatchObject({ reason: "not_yours" });
  });
  it("not scheduled → not_scheduled (with the status)", () => {
    expect(startRefusal({ ...ok, shift: { ...base(), status: "cancelled" } })).toMatchObject({ reason: "not_scheduled", status: "cancelled", message: "That visit is cancelled, so it can't be started." });
  });
  it("the gate: membership, then background — the site's modal copy", () => {
    expect(startRefusal({ ...ok, shift: base(), gateBlock: "membership" })).toMatchObject({ reason: "membership", message: expect.stringMatching(/^Membership required/) });
    expect(startRefusal({ ...ok, shift: base(), gateBlock: "background" })).toMatchObject({ reason: "background", message: expect.stringMatching(/^Background check required/) });
  });
  it("one visit at a time → another_in_progress, named, with the other visit attached", () => {
    const other = { id: "open", shift: { clientName: "Ali Hassan", date: "2099-09-28", startTime: "09:00", endTime: "10:00" } };
    expect(startRefusal({ ...ok, shift: base(), otherOpen: other })).toMatchObject({ reason: "another_in_progress", message: "Finish your visit with Ali Hassan first.", other });
  });
  it("overdue (the visit's window has passed) → overdue", () => {
    expect(startRefusal({ ...ok, shift: { ...base(), date: "2000-01-01", startTime: "11:00", endTime: "14:00" } })).toMatchObject({ reason: "overdue", message: expect.stringMatching(/time has passed/) });
  });
  it("more than 15 minutes before the start → too_early; inside the window (and late but not ended) → null", () => {
    const early = inMinutes(90);
    expect(startRefusal({ ...ok, shift: { ...base(), date: early.date, startTime: early.time } })).toMatchObject({ reason: "too_early", message: expect.stringMatching(/Start opens 15 minutes before the visit/) });
    expect(startRefusal({ ...ok, shift: base() })).toBeNull();
    const late = inMinutes(-30);
    expect(startRefusal({ ...ok, shift: { ...base(), date: late.date, startTime: late.time, endTime: "23:59" } })).toBeNull();
  });
  it("the gate is checked before the one-visit rule and the window (the page swaps the button for the gate first)", () => {
    const early = inMinutes(90);
    expect(startRefusal({ ...ok, shift: { ...base(), date: early.date, startTime: early.time }, gateBlock: "membership", otherOpen: { id: "o", shift: {} } })).toMatchObject({ reason: "membership" });
  });
});

describe("endRefusal / cancelRefusal / logHoursRefusal", () => {
  it("end: owner, then in progress only", () => {
    expect(endRefusal({ shift: { caregiverId: "x", status: "in-progress" }, caregiverId: CG })).toMatchObject({ reason: "not_yours" });
    expect(endRefusal({ shift: { caregiverId: CG, status: "scheduled" }, caregiverId: CG })).toMatchObject({ reason: "not_in_progress", status: "scheduled" });
    expect(endRefusal({ shift: { caregiverId: CG, status: "in-progress" }, caregiverId: CG })).toBeNull();
  });
  it("cancel: owner (skipped for the system), then scheduled only", () => {
    expect(cancelRefusal({ shift: { caregiverId: "x", status: "scheduled" }, caregiverId: CG })).toMatchObject({ reason: "not_yours" });
    expect(cancelRefusal({ shift: { caregiverId: "x", status: "scheduled" }, caregiverId: null })).toBeNull();
    expect(cancelRefusal({ shift: { caregiverId: CG, status: "in-progress" }, caregiverId: CG })).toMatchObject({ reason: "not_scheduled", status: "in-progress", message: "That shift is already in-progress — nothing to cancel." });
  });
  it("log hours: owner → scheduled → missed (overdue) → gate → end after start", () => {
    const ok = { caregiverId: CG, gateBlock: null, caregiver: {}, startedAtMs: 1000, completedAtMs: 2000 };
    const missed = { caregiverId: CG, status: "scheduled", date: "2000-01-01", startTime: "19:30", endTime: "19:45" };
    expect(logHoursRefusal({ ...ok, shift: { ...missed, caregiverId: "x" } })).toMatchObject({ reason: "not_yours" });
    expect(logHoursRefusal({ ...ok, shift: { ...missed, status: "completed" } })).toMatchObject({ reason: "not_scheduled", message: "That visit is already completed — nothing to log." });
    expect(logHoursRefusal({ ...ok, shift: { ...missed, date: "2099-01-01" } })).toMatchObject({ reason: "not_missed" });
    expect(logHoursRefusal({ ...ok, shift: missed, gateBlock: "background" })).toMatchObject({ reason: "background" });
    expect(logHoursRefusal({ ...ok, shift: missed, completedAtMs: 1000 })).toMatchObject({ reason: "bad_times" });
    expect(logHoursRefusal({ ...ok, shift: missed, startedAtMs: NaN })).toMatchObject({ reason: "bad_times" });
    expect(logHoursRefusal({ ...ok, shift: missed })).toBeNull();
  });
});

describe("startVisit — load, check, write", () => {
  it("inside the window, cleared, nothing else open → the page's exact write", async () => {
    const w = inMinutes(5);
    shift("s1", { date: w.date, startTime: w.time, endTime: "23:59" });
    const r = await startVisit({ caregiverId: CG, shiftId: "s1" });
    expect(r).toMatchObject({ ok: true, shiftId: "s1", alreadyStarted: false });
    expect(shiftWrites("s1")).toEqual([{ path: "shifts/s1", data: { status: "in-progress", startedAt: "__ts__", updatedAt: "__ts__" } }]);
    expect(hoisted.docs.get("shifts/s1").status).toBe("in-progress");
  });
  it("not found / not yours", async () => {
    expect(await startVisit({ caregiverId: CG, shiftId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });
    shift("s1", { caregiverId: "other" });
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: false, reason: "not_yours" });
    expect(hoisted.updates).toHaveLength(0);
  });
  it("already in progress → ok, alreadyStarted, nothing written", async () => {
    shift("s1", { status: "in-progress", startedAt: "2026-09-28T18:04:38.000Z" });
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: true, alreadyStarted: true, startedAt: "2026-09-28T18:04:38.000Z" });
    expect(hoisted.updates).toHaveLength(0);
  });
  it("membership not active → membership; background not cleared → background (legacy membershipPaid counts; past_due still active)", async () => {
    const w = inMinutes(5);
    shift("s1", { date: w.date, startTime: w.time, endTime: "23:59" });
    cleared({ membershipStatus: "canceled" });
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: false, reason: "membership", caregiver: { membershipStatus: "canceled" } });
    cleared({ membershipStatus: "past_due", verified: false, backgroundCheckStatus: "pending" });
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: false, reason: "background" });
    hoisted.docs.set(`caregivers/${CG}`, { membershipPaid: true, backgroundCheckStatus: "clear" });
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: true });
    expect(shiftWrites("s1")).toHaveLength(1);
  });
  it("another visit of theirs in progress (any date) → another_in_progress; someone else's open visit does not count", async () => {
    const w = inMinutes(5);
    shift("s1", { date: w.date, startTime: w.time, endTime: "23:59" });
    shift("open", { status: "in-progress", clientName: "Ali Hassan", date: "2026-01-01" });
    shift("theirs", { status: "in-progress", caregiverId: "cg2" });
    const r = await startVisit({ caregiverId: CG, shiftId: "s1" });
    expect(r).toMatchObject({ ok: false, reason: "another_in_progress", message: "Finish your visit with Ali Hassan first.", other: { id: "open" } });
    hoisted.docs.delete("shifts/open");
    expect(await startVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: true });
  });
  it("overdue / too early → refused, nothing written", async () => {
    shift("old", { date: "2000-01-01" });
    expect(await startVisit({ caregiverId: CG, shiftId: "old" })).toMatchObject({ ok: false, reason: "overdue" });
    const early = inMinutes(90);
    shift("soon", { date: early.date, startTime: early.time, endTime: "23:59" });
    expect(await startVisit({ caregiverId: CG, shiftId: "soon" })).toMatchObject({ ok: false, reason: "too_early" });
    expect(hoisted.updates).toHaveLength(0);
  });
});

describe("endVisit", () => {
  it("in progress → completed with the closing note; without a note no completionNotes key", async () => {
    shift("s1", { status: "in-progress" });
    expect(await endVisit({ caregiverId: CG, shiftId: "s1", closingNote: "  Good visit. " })).toMatchObject({ ok: true, alreadyCompleted: false });
    expect(shiftWrites("s1")).toEqual([{ path: "shifts/s1", data: { status: "completed", completedAt: "__ts__", updatedAt: "__ts__", completionNotes: "Good visit." } }]);
    shift("s2", { status: "in-progress" });
    await endVisit({ caregiverId: CG, shiftId: "s2" });
    expect(shiftWrites("s2")[0].data).toEqual({ status: "completed", completedAt: "__ts__", updatedAt: "__ts__" });
  });
  it("already completed → ok, alreadyCompleted; scheduled → not_in_progress; not yours; not found", async () => {
    shift("done", { status: "completed", completedAt: "2026-09-28T18:18:25.000Z" });
    expect(await endVisit({ caregiverId: CG, shiftId: "done" })).toMatchObject({ ok: true, alreadyCompleted: true, completedAt: "2026-09-28T18:18:25.000Z" });
    shift("s1");
    expect(await endVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: false, reason: "not_in_progress" });
    shift("x", { status: "in-progress", caregiverId: "cg2" });
    expect(await endVisit({ caregiverId: CG, shiftId: "x" })).toMatchObject({ ok: false, reason: "not_yours" });
    expect(await endVisit({ caregiverId: CG, shiftId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(hoisted.updates).toHaveLength(0);
  });
  it("End is NOT gated (the page shows End on any in-progress visit)", async () => {
    cleared({ membershipStatus: "canceled", verified: false });
    shift("s1", { status: "in-progress" });
    expect(await endVisit({ caregiverId: CG, shiftId: "s1" })).toMatchObject({ ok: true });
  });
});

describe("cancelVisit — the ✕", () => {
  it("within 24h → needs_replacement; further out → cancelled; cancelledBy caregiver; updatedAt", async () => {
    const soon = inMinutes(2 * 60), far = inMinutes(30 * 60);
    shift("a", { date: soon.date, startTime: soon.time, endTime: "23:59" });
    shift("b", { date: far.date, startTime: far.time, endTime: "23:59" });
    expect(await cancelVisit({ caregiverId: CG, shiftId: "a" })).toMatchObject({ ok: true, status: "needs_replacement" });
    expect(await cancelVisit({ caregiverId: CG, shiftId: "b" })).toMatchObject({ ok: true, status: "cancelled" });
    expect(shiftWrites("a")).toEqual([{ path: "shifts/a", data: { status: "needs_replacement", cancelledBy: "caregiver", updatedAt: "__ts__" } }]);
    expect(shiftWrites("b")).toEqual([{ path: "shifts/b", data: { status: "cancelled", cancelledBy: "caregiver", updatedAt: "__ts__" } }]);
  });
  it("not scheduled / not yours / not found → refused, nothing written; the system path skips the owner check", async () => {
    shift("live", { status: "in-progress" });
    expect(await cancelVisit({ caregiverId: CG, shiftId: "live" })).toMatchObject({ ok: false, reason: "not_scheduled", status: "in-progress" });
    shift("x", { caregiverId: "cg2" });
    expect(await cancelVisit({ caregiverId: CG, shiftId: "x" })).toMatchObject({ ok: false, reason: "not_yours" });
    expect(await cancelVisit({ caregiverId: CG, shiftId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(hoisted.updates).toHaveLength(0);
    expect(await cancelVisit({ caregiverId: null, shiftId: "x", cancelledBy: "system" })).toMatchObject({ ok: true, status: "cancelled" });
    expect(shiftWrites("x")[0].data.cancelledBy).toBe("system");
  });
  it("Cancel is NOT gated", async () => {
    cleared({ membershipStatus: "canceled", verified: false });
    shift("b");
    expect(await cancelVisit({ caregiverId: CG, shiftId: "b" })).toMatchObject({ ok: true });
  });
});

describe("cancelBooking — the Cancel Booking button", () => {
  it("this visit + every future scheduled visit of the booking (mine only), batched; booking closed when none was urgent", async () => {
    shift("a", { date: "2099-09-28" });
    shift("b", { date: "2099-10-03" });
    shift("done", { date: "2026-09-01", status: "completed" });
    shift("other", { bookingRequestId: "br2" });
    shift("notmine", { caregiverId: "cg2" });
    hoisted.docs.set("booking_requests/br1", { status: "accepted" });
    const r = await cancelBooking({ caregiverId: CG, shiftId: "a" });
    expect(r).toEqual({ ok: true, shiftId: "a", anyUrgent: false, count: 2 });
    const patch = { status: "cancelled", cancelledBy: "caregiver", updatedAt: "__ts__" };
    expect(hoisted.docs.get("shifts/a")).toMatchObject(patch);
    expect(hoisted.docs.get("shifts/b")).toMatchObject(patch);
    expect(hoisted.docs.get("shifts/done").status).toBe("completed");
    expect(hoisted.docs.get("shifts/other").status).toBe("scheduled");
    expect(hoisted.docs.get("shifts/notmine").status).toBe("scheduled");
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")!.data).toEqual({ status: "cancelled", updatedAt: "__ts__" });
    expect(hoisted.batchCommits).toBe(1);
  });
  it("a visit inside 24h → needs_replacement and the booking record is left alone", async () => {
    const soon = inMinutes(2 * 60);
    shift("a", { date: soon.date, startTime: soon.time, endTime: "23:59" });
    shift("b", { date: "2099-10-03" });
    hoisted.docs.set("booking_requests/br1", { status: "accepted" });
    expect(await cancelBooking({ caregiverId: CG, shiftId: "a" })).toMatchObject({ ok: true, anyUrgent: true, count: 2 });
    expect(hoisted.docs.get("shifts/a").status).toBe("needs_replacement");
    expect(hoisted.docs.get("shifts/b").status).toBe("cancelled");
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")).toBeUndefined();
  });
  it("no booking id → just this visit; refusals as for the ✕", async () => {
    shift("solo", { bookingRequestId: undefined });
    expect(await cancelBooking({ caregiverId: CG, shiftId: "solo" })).toMatchObject({ ok: true, count: 1 });
    shift("x", { caregiverId: "cg2" });
    expect(await cancelBooking({ caregiverId: CG, shiftId: "x" })).toMatchObject({ ok: false, reason: "not_yours" });
    shift("live", { status: "in-progress" });
    expect(await cancelBooking({ caregiverId: CG, shiftId: "live" })).toMatchObject({ ok: false, reason: "not_scheduled" });
  });
});

describe("logHours — the Past tab's modal", () => {
  const start = Date.parse("2000-01-01T19:30:00-08:00"), end = Date.parse("2000-01-01T20:05:00-08:00");
  it("a missed visit, cleared → the modal's write field for field", async () => {
    shift("miss", { date: "2000-01-01", startTime: "19:30", endTime: "19:45" });
    const r = await logHours({ caregiverId: CG, shiftId: "miss", startedAtMs: start, completedAtMs: end, tasksCompleted: ["0_a", 7 as unknown as string], completionNotes: " She was tired but fine. " });
    expect(r).toMatchObject({ ok: true, shiftId: "miss" });
    expect(shiftWrites("miss")).toEqual([{ path: "shifts/miss", data: {
      status: "completed", startedAt: { __ms: start }, completedAt: { __ms: end }, loggedManually: true, tasksCompleted: ["0_a"], completionNotes: "She was tired but fine.", updatedAt: "__ts__",
    } }]);
  });
  it("no note → no completionNotes key", async () => {
    shift("miss", { date: "2000-01-01", startTime: "19:30", endTime: "19:45" });
    await logHours({ caregiverId: CG, shiftId: "miss", startedAtMs: start, completedAtMs: end, tasksCompleted: [] });
    expect(shiftWrites("miss")[0].data).not.toHaveProperty("completionNotes");
  });
  it("refusals: not found, not yours, already completed, not yet missed, the gate, end before start — nothing written", async () => {
    const args = { caregiverId: CG, startedAtMs: start, completedAtMs: end, tasksCompleted: [] };
    expect(await logHours({ ...args, shiftId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });
    shift("x", { date: "2000-01-01", caregiverId: "cg2" });
    expect(await logHours({ ...args, shiftId: "x" })).toMatchObject({ ok: false, reason: "not_yours" });
    shift("done", { date: "2000-01-01", status: "completed" });
    expect(await logHours({ ...args, shiftId: "done" })).toMatchObject({ ok: false, reason: "not_scheduled", message: "That visit is already completed — nothing to log." });
    shift("future", { date: "2099-01-01" });
    expect(await logHours({ ...args, shiftId: "future" })).toMatchObject({ ok: false, reason: "not_missed" });
    shift("miss", { date: "2000-01-01", startTime: "19:30", endTime: "19:45" });
    cleared({ membershipStatus: "canceled" });
    expect(await logHours({ ...args, shiftId: "miss" })).toMatchObject({ ok: false, reason: "membership" });
    cleared();
    expect(await logHours({ ...args, shiftId: "miss", completedAtMs: start })).toMatchObject({ ok: false, reason: "bad_times" });
    expect(hoisted.updates).toHaveLength(0);
  });
});
