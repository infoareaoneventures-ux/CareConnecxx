// activeBookings.ts — the My Bookings > Active Bookings tab as one read
// (2026-09-17). Pins the page's own grouping, card fields, per-row status
// pill and the exact button conditions from ClientVisitsPage.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeQuery = (coll: string, conds: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...conds, [f, op, v]]),
    get: async () => {
      const prefix = `${coll}/`;
      const docs = [...docState.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .filter(([, d]) => conds.every(([f, op, v]) => op === "in" ? (v as any[]).includes(d?.[f]) : d?.[f] === v))
        .map(([p, d]) => ({ id: p.slice(prefix.length), data: () => d }));
      return { empty: docs.length === 0, docs };
    },
  });
  return {
    docState,
    collectionMock: vi.fn((c: string) => ({
      where: (f: string, op: string, v: any) => makeQuery(c, [[f, op, v]]),
      // doc().get() — the booking_requests read for the membership-pause flag.
      doc: (id: string) => ({ get: async () => ({ exists: docState.has(`${c}/${id}`), data: () => docState.get(`${c}/${id}`) }) }),
    })),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: {} });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import { listActiveBookings, fmtHours } from "../activeBookings";

const SCHEDULE = {
  ongoing: true, startDate: "2026-09-16", endDate: null,
  dayShiftTimes: { Mon: [{ start: "00:00", end: "00:15" }], Tue: [{ start: "14:00", end: "15:00" }], Wed: [{ start: "20:00", end: "21:30" }] },
};
const BASE = {
  clientId: "c1", bookingRequestId: "br1", caregiverId: "cg1", caregiverName: "Basra Yousuf", caregiverPhotoURL: "https://cdn/b.jpg",
  address: "4746 campbell ave, San Jose, CA, 95130", rate: 5, paymentMethod: "credit", notes: "testing",
  careRecipients: [{ name: "Samira", relationship: "Mother", age: 82, careNeeds: ["Companionship"], careNeedDetails: { Companionship: ["Conversation"] }, lifestyle: { favoriteActivities: ["Reading"] } }],
  emergencyContact: { name: "Jane Doe", phone: "+15551234567", relationship: "Daughter" },
  schedule: SCHEDULE, recurringWeekly: true,
};
const shift = (id: string, over: Record<string, unknown>) => hoisted.docState.set(`shifts/${id}`, { ...BASE, status: "scheduled", ...over });

beforeEach(() => hoisted.reset());

describe("fmtHours (page's formatter)", () => {
  it("matches ClientVisitsPage.tsx", () => {
    expect(fmtHours(0)).toBe("");
    expect(fmtHours(15)).toBe("0h 15m");
    expect(fmtHours(60)).toBe("1h");
    expect(fmtHours(165)).toBe("2h 45m");
  });
});

describe("listActiveBookings", () => {
  it("builds the card exactly: Ongoing, Starts, weekly blocks with per-day hours and hours/week, address, rate + Card, note, recipients, emergency contact", async () => {
    shift("s1", { date: "2099-09-22", startTime: "14:00", endTime: "15:00" });
    shift("s2", { date: "2099-09-23", startTime: "20:00", endTime: "21:30" });
    shift("s3", { date: "2099-09-28", startTime: "00:00", endTime: "00:15" });
    // Not on the tab: completed / cancelled, and another client's shift.
    hoisted.docState.set("shifts/done", { ...BASE, status: "completed", date: "2026-09-01" });
    hoisted.docState.set("shifts/other", { ...BASE, clientId: "c2", status: "scheduled", date: "2099-09-22" });

    const [b, ...rest] = await listActiveBookings("c1");
    expect(rest).toEqual([]);
    expect(b).toMatchObject({
      bookingRequestId: "br1", caregiverId: "cg1", caregiverName: "Basra Yousuf", caregiverPhotoURL: "https://cdn/b.jpg",
      ongoing: true, endDate: null, startDate: "2026-09-16",
      weeklySchedule: [
        { day: "Mon", blocks: [{ start: "00:00", end: "00:15" }], hours: "0h 15m" },
        { day: "Tue", blocks: [{ start: "14:00", end: "15:00" }], hours: "1h" },
        { day: "Wed", blocks: [{ start: "20:00", end: "21:30" }], hours: "1h 30m" },
      ],
      weeklyHours: "2h 45m",
      address: "4746 campbell ave, San Jose, CA, 95130", rate: 5, paymentMethod: "credit", paymentLabel: "Card", notes: "testing",
      emergencyContact: { name: "Jane Doe", phone: "+15551234567", relationship: "Daughter" },
      actions: ["message", "cancel_booking"],
    });
    expect(b.careRecipients[0]).toMatchObject({ name: "Samira", careNeedDetails: { Companionship: ["Conversation"] } });
    // UPCOMING SHIFTS: date/start ascending, with the page's pill and buttons.
    expect(b.upcomingShifts.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(b.upcomingShifts[0]).toMatchObject({ date: "2099-09-22", dayOfWeek: "Tuesday", startTime: "14:00", endTime: "15:00", displayStatus: "scheduled", actions: ["cancel_visit", "propose_reschedule"] });
    expect(b.upcomingShifts[0].notes).toBeUndefined();
  });

  it("groups by booking (bookingRequestId, else the shift's own id) and orders groups by their latest shift like the page", async () => {
    shift("a1", { bookingRequestId: "brA", date: "2099-09-20" });
    shift("b1", { bookingRequestId: "brB", caregiverName: "Other", date: "2099-10-01" });
    shift("lone", { bookingRequestId: undefined, caregiverName: "Solo", date: "2099-09-25" });
    const groups = await listActiveBookings("c1");
    expect(groups.map((g) => [g.bookingRequestId, g.caregiverName])).toEqual([["brB", "Other"], [null, "Solo"], ["brA", "Basra Yousuf"]]);
  });

  it("an Overdue visit keeps its ✕ but loses the Reschedule button; in-progress and needs_replacement rows get their own actions", async () => {
    shift("past", { date: "2026-01-05", startTime: "09:00", endTime: "10:00" }); // long past → overdue
    shift("live", { date: "2099-09-22", status: "in-progress" });
    shift("nr", { date: "2099-09-23", status: "needs_replacement" });
    shift("nr2", { date: "2099-09-24", status: "needs_replacement", replacementRequestId: "br-repl", replacementCaregiverName: "Maya" });
    shift("nrPast", { date: "2026-01-06", startTime: "09:00", endTime: "10:00", status: "needs_replacement" }); // window passed → Overdue, Skip only
    const [b] = await listActiveBookings("c1");
    const byId = Object.fromEntries(b.upcomingShifts.map((s) => [s.id, s]));
    expect(byId.past).toMatchObject({ displayStatus: "overdue", actions: ["cancel_visit"] });
    expect(byId.live).toMatchObject({ displayStatus: "in-progress", actions: [] });
    expect(byId.nr).toMatchObject({ displayStatus: "needs_replacement", actions: ["find_replacement", "skip"], replacement: { status: "needs_choice" } });
    expect(byId.nrPast).toMatchObject({ displayStatus: "overdue", actions: ["skip"] });
    expect(byId.nr2).toMatchObject({ actions: ["choose_someone_else"], replacement: { status: "waiting_on_caregiver", requestId: "br-repl", caregiverName: "Maya" } });
  });

  it("a pending reschedule proposal: the caregiver's offers Accept/Decline (and a counter-proposal), the family's own offers only Withdraw", async () => {
    shift("theirs", { date: "2099-09-22", reschedulePendingDate: "2099-09-23", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "12:00", reschedulePendingAt: "2026-09-17T01:00:00.000Z", rescheduledBy: "caregiver",
      rescheduleHistory: [{ from: { date: "2099-09-20" }, to: { date: "2099-09-22" } }] });
    shift("mine", { date: "2099-09-29", reschedulePendingDate: "2099-09-30", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "12:00", rescheduledBy: "client" });
    const [b] = await listActiveBookings("c1");
    const byId = Object.fromEntries(b.upcomingShifts.map((s) => [s.id, s]));
    expect(byId.theirs).toMatchObject({
      actions: ["cancel_visit", "propose_reschedule", "accept_reschedule", "decline_reschedule"],
      reschedulePending: { date: "2099-09-23", startTime: "10:00", endTime: "12:00", proposedBy: "caregiver", proposedAt: "2026-09-17T01:00:00.000Z", waitingOn: "you" },
    });
    expect(byId.theirs.rescheduleHistory).toHaveLength(1);
    expect(byId.mine).toMatchObject({ actions: ["cancel_visit", "withdraw_reschedule"], reschedulePending: { proposedBy: "client", waitingOn: "caregiver" } });
  });

  it("header note = the booking's own note; a visit shows its note only when it differs (a schedule-change note); 'Until <date>' for a non-ongoing booking", async () => {
    hoisted.docState.set("booking_requests/br1", { notes: "testing" });
    shift("s1", { date: "2099-09-22", notes: "testing" });
    shift("s2", { date: "2099-09-23", notes: "this is adding a shift", schedule: { ...SCHEDULE, ongoing: false, endDate: "2099-10-31" }, recurringWeekly: false });
    const [b] = await listActiveBookings("c1");
    // base = latest shift (s2) → its schedule drives the card; the note is the booking's (2026-09-28)
    expect(b).toMatchObject({ ongoing: false, endDate: "2099-10-31", notes: "testing" });
    const byId = Object.fromEntries(b.upcomingShifts.map((s) => [s.id, s]));
    expect(byId.s1.notes).toBeUndefined();
    expect(byId.s2.notes).toBe("this is adding a shift");
  });

  it("returns an empty tab when nothing is active", async () => {
    hoisted.docState.set("shifts/done", { ...BASE, status: "completed", date: "2026-09-01" });
    expect(await listActiveBookings("c1")).toEqual([]);
  });

  it("carries the membership-pause flag the generator writes on the booking (schedulePaused + the page's note)", async () => {
    hoisted.docState.set("shifts/s1", { ...BASE, date: "2099-01-05", startTime: "20:00", endTime: "21:30", status: "scheduled" });
    hoisted.docState.set("booking_requests/br1", { clientId: "c1", status: "accepted", schedulePausedAt: "2099-01-01T00:00:00.000Z", schedulePausedReason: "membership_lapsed" });
    const [b] = await listActiveBookings("c1");
    expect(b.schedulePaused).toBe(true);
    expect(b.schedulePausedNote).toMatch(/membership is inactive/);
    hoisted.docState.set("booking_requests/br1", { clientId: "c1", status: "accepted" });
    const [b2] = await listActiveBookings("c1");
    expect(b2.schedulePaused).toBe(false);
    expect(b2.schedulePausedNote).toBeNull();
  });
});
