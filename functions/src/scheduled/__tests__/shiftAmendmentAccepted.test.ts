import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep follow-up (2026-10-11): an accepted schedule change
// (booking_amendments status → 'accepted', from the page's Accept or Evia's
// "accept") generates its visits SERVER-SIDE through the ONE shift generator —
// the page's rules, verbatim: generate from max(startDate, today) for 28 days
// (today = the family's business day, Pacific), an ongoing change merges into
// booking_requests.schedule.dayShiftTimes (a dated one does not), a dated
// change ends on its own end date, the request's note travels onto the visits
// (else the booking's), the page's shift document, cap 490, behind the C17 gate.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const batchSets: any[] = [];
  const updates: Array<{ path: string; data: any }> = [];
  const logs: string[] = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (d: any) => docState.set(path, d),
    update: async (d: any) => { updates.push({ path, data: d }); docState.set(path, { ...(docState.get(path) ?? {}), ...d }); },
  });
  const makeCollRef = (path: string, filters: Array<[string, string, any]> = []): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto${batchSets.length}`}`),
    where: (f: string, op: string, v: any) => makeCollRef(path, [...filters, [f, op, v]]),
    orderBy: () => makeCollRef(path, filters),
    limit: () => makeCollRef(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...docState.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter(([, d]) => filters.every(([f, op, v]) => (op === "==" ? d?.[f] === v : op === "in" ? v.includes(d?.[f]) : true)))
        .map(([k, d]) => ({ id: k.slice(prefix.length), data: () => d, ref: makeDocRef(k) }));
      return { empty: docs.length === 0, docs };
    },
  });
  const dbMock = {
    collection: (p: string) => makeCollRef(p),
    batch: () => ({ set: (ref: any, d: any) => batchSets.push({ path: ref.path, data: d }), delete: () => {}, commit: async () => {} }),
  };
  return { docState, batchSets, updates, logs, dbMock, makeDocRef, reset: () => { docState.clear(); batchSets.length = 0; updates.length = 0; logs.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, { FieldValue: { serverTimestamp: () => "__ts__", delete: () => ({ __delete: true }) }, Timestamp: { fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000) }) } }),
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h }) }, pubsub: { schedule: () => ({ onRun: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../billing/membershipLapse", () => ({ applyMembershipLapse: vi.fn(async () => "ok") }));

import { onBookingAmendmentAccepted, applyAcceptedAmendment, AMENDMENT_WINDOW_DAYS, AMENDMENT_MAX_SHIFTS } from "../shiftGenerator";

const ACTIVE = { membershipStatus: "active", backgroundCheckStatus: "clear", profilePhoto: "https://p/cg.jpg" };
const amendment = (over: Record<string, unknown> = {}) => ({
  bookingRequestId: "br1", clientId: "fam1", clientName: "The Nguyen Family", caregiverId: "cg1", caregiverName: "Maria",
  status: "accepted", type: "add_recurring_days", newDays: { Fri: [{ start: "09:00", end: "11:00" }] },
  notes: "Extra help on Fridays", startDate: "2099-01-05", endDate: null, ongoing: true, respondedAt: "__ts__", ...over,
});
const booking = (over: Record<string, unknown> = {}) => ({
  status: "accepted", clientId: "fam1", clientName: "The Nguyen Family", clientPhotoURL: null, caregiverId: "cg1", caregiverName: "Maria",
  address: "20 Descanso Dr", careNeeds: ["Companionship"], lifestylePreferences: ["No pets"], rate: 25, paymentMethod: "credit", notes: "general note",
  careRecipients: [{ name: "Mai" }], emergencyContact: { name: "Linh" }, jobId: "job1",
  schedule: { ongoing: true, startDate: "2099-01-01", dayShiftTimes: { Mon: [{ start: "09:00", end: "13:00" }] } }, ...over,
});
const change = (before: any, after: any, id = "am1") => ({
  before: { exists: before !== null, data: () => before },
  after: { exists: after !== null, data: () => after, ref: hoisted.makeDocRef(`booking_amendments/${id}`) },
});
const run = (before: any, after: any, id = "am1") => (onBookingAmendmentAccepted as any)(change(before, after, id), { params: { amendmentId: id } });
const shifts = () => hoisted.batchSets.filter((s) => s.path.startsWith("shifts/"));

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set("caregivers/cg1", ACTIVE);
  vi.spyOn(console, "info").mockImplementation((...a: any[]) => { hoisted.logs.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("onBookingAmendmentAccepted — the page's Accept, server-side, once", () => {
  it("pending → accepted (ongoing): merges the new day into the booking's schedule, creates the page's visits for 28 days, stamps the amendment", async () => {
    hoisted.docState.set("booking_requests/br1", booking());
    hoisted.docState.set("booking_amendments/am1", amendment());
    await run({ ...amendment(), status: "pending" }, amendment());
    // the booking's permanent schedule gains the new day (the page's merge — ongoing only)
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")!.data).toEqual({
      "schedule.dayShiftTimes": { Mon: [{ start: "09:00", end: "13:00" }], Fri: [{ start: "09:00", end: "11:00" }] }, updatedAt: "__ts__",
    });
    // every Friday from the start date, 28 days inclusive (generateFrom + 27) — the page's window
    expect(AMENDMENT_WINDOW_DAYS).toBe(27);
    expect(shifts().map((s) => s.data.date)).toEqual(["2099-01-09", "2099-01-16", "2099-01-23", "2099-01-30"]);
    // the page's exact shift document (the ONE generator's shape: + jobId, photo from the caregiver record)
    expect(shifts()[0].data).toEqual({
      clientId: "fam1", clientName: "The Nguyen Family", clientPhotoURL: null, caregiverId: "cg1", caregiverName: "Maria", caregiverPhotoURL: "https://p/cg.jpg",
      status: "scheduled", address: "20 Descanso Dr", careNeeds: ["Companionship"], lifestylePreferences: ["No pets"], rate: 25, paymentMethod: "credit",
      notes: "Extra help on Fridays", careRecipients: [{ name: "Mai" }], emergencyContact: { name: "Linh" },
      schedule: { ongoing: true, startDate: "2099-01-01", dayShiftTimes: { Mon: [{ start: "09:00", end: "13:00" }], Fri: [{ start: "09:00", end: "11:00" }] } },
      bookingRequestId: "br1", jobId: "job1", recurringWeekly: true, tasksCompleted: [], createdAt: "__ts__",
      date: "2099-01-09", startTime: "09:00", endTime: "11:00",
    });
    // only the amendment's days — never the booking's Monday
    expect(shifts().every((s) => s.data.startTime === "09:00" && s.data.endTime === "11:00")).toBe(true);
    // the stamp that makes a redelivery a no-op
    expect(hoisted.updates.find((u) => u.path === "booking_amendments/am1")!.data).toEqual({ shiftsGeneratedAt: "__ts__", shiftsCreated: 4 });
  });

  it("dated change: no schedule merge, visits weekly until its own end date, the booking's general note when the request has none", async () => {
    hoisted.docState.set("booking_requests/br1", booking());
    const a = amendment({ ongoing: false, endDate: "2099-01-16", notes: "" });
    hoisted.docState.set("booking_amendments/am1", a);
    await run({ ...a, status: "pending" }, a);
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")).toBeUndefined();
    expect(shifts().map((s) => s.data.date)).toEqual(["2099-01-09", "2099-01-16"]);
    expect(shifts()[0].data.notes).toBe("general note");
    expect(shifts()[0].data.schedule.dayShiftTimes).toEqual({ Mon: [{ start: "09:00", end: "13:00" }] }); // unmerged
    expect(hoisted.updates.find((u) => u.path === "booking_amendments/am1")!.data).toMatchObject({ shiftsCreated: 2 });
  });

  it("a dated change with no end date of its own ends with a dated booking; an ongoing change never ends", async () => {
    hoisted.docState.set("booking_requests/br1", booking({ schedule: { ongoing: false, startDate: "2099-01-01", endDate: "2099-01-10", dayShiftTimes: {} } }));
    const a = amendment({ ongoing: false, endDate: null });
    await run({ ...a, status: "pending" }, a);
    expect(shifts().map((s) => s.data.date)).toEqual(["2099-01-09"]);
    hoisted.reset(); hoisted.docState.set("caregivers/cg1", ACTIVE);
    hoisted.docState.set("booking_requests/br1", booking({ schedule: { ongoing: false, startDate: "2099-01-01", endDate: "2099-01-10", dayShiftTimes: {} } }));
    const b = amendment({ ongoing: true });
    await run({ ...b, status: "pending" }, b);
    expect(shifts().map((s) => s.data.date)).toEqual(["2099-01-09", "2099-01-16", "2099-01-23", "2099-01-30"]);
  });

  it("today is the family's business day (Pacific): an accept at 6 PM Wednesday (01:00Z Thursday) still starts on that Wednesday — live 2026-10-07", async () => {
    hoisted.docState.set("booking_requests/br1", booking({ schedule: { ongoing: true, startDate: "2026-10-07", dayShiftTimes: { Wed: [{ start: "17:45", end: "18:00" }] } } }));
    const a = amendment({ startDate: "2026-10-07", newDays: { Wed: [{ start: "18:15", end: "18:30" }] } });
    const r = await applyAcceptedAmendment("am1", a, new Date("2026-10-08T01:02:00Z"));
    expect(r).toEqual({ created: 4 });
    expect(shifts().map((s) => s.data.date)[0]).toBe("2026-10-07");
    // a one-day request for today creates its visit (it used to create nothing)
    hoisted.reset(); hoisted.docState.set("caregivers/cg1", ACTIVE);
    hoisted.docState.set("booking_requests/br1", booking());
    const one = amendment({ startDate: "2026-10-07", ongoing: false, endDate: "2026-10-07", newDays: { Wed: [{ start: "19:00", end: "19:15" }] } });
    expect(await applyAcceptedAmendment("am2", one, new Date("2026-10-08T01:02:00Z"))).toEqual({ created: 1 });
    expect(shifts()[0].data.date).toBe("2026-10-07");
    // a start date in the past generates from today
    hoisted.reset(); hoisted.docState.set("caregivers/cg1", ACTIVE);
    hoisted.docState.set("booking_requests/br1", booking());
    await applyAcceptedAmendment("am3", amendment({ startDate: "2020-01-01", newDays: { Wed: [{ start: "19:00", end: "19:15" }] } }), new Date("2026-10-08T01:02:00Z"));
    expect(shifts().map((s) => s.data.date)).toEqual(["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"]);
  });

  it("the page's cap (490) and the request's own names when the booking lacks them", async () => {
    expect(AMENDMENT_MAX_SHIFTS).toBe(490);
    hoisted.docState.set("booking_requests/br1", booking({ clientName: "", caregiverName: "", clientId: "" }));
    const a = amendment({ clientName: "From the request", caregiverName: "Maria R." });
    await applyAcceptedAmendment("am1", a);
    expect(shifts()[0].data).toMatchObject({ clientId: "fam1", clientName: "From the request", caregiverName: "Maria R." });
  });

  it("C17: a locked caregiver gets no new visits — the merge still lands, nothing is created, the reason is stamped and logged", async () => {
    hoisted.docState.set("caregivers/cg1", { membershipStatus: "canceled", backgroundCheckStatus: "clear" });
    hoisted.docState.set("booking_requests/br1", booking());
    const a = amendment();
    hoisted.docState.set("booking_amendments/am1", a);
    await run({ ...a, status: "pending" }, a);
    expect(shifts()).toHaveLength(0);
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")).toBeDefined();
    expect(hoisted.updates.find((u) => u.path === "booking_amendments/am1")!.data).toEqual({ shiftsGeneratedAt: "__ts__", shiftsCreated: 0, shiftsSkippedReason: "caregiver_not_eligible" });
    expect(hoisted.logs.some((l) => l.includes("caregiver cg1 is not eligible") && l.includes("am1"))).toBe(true);
  });

  it("runs ONCE: not on a decline, not on a non-status edit, not when already accepted, not on a redelivery after the stamp; a missing booking stamps 'no_booking'", async () => {
    hoisted.docState.set("booking_requests/br1", booking());
    const a = amendment();
    await run({ ...a, status: "pending" }, { ...a, status: "declined" });
    await run({ ...a, status: "pending" }, { ...a, status: "pending", notes: "edited" });
    await run(a, { ...a, respondedAt: "later" }); // accepted → accepted
    await run({ ...a, status: "pending" }, { ...a, shiftsGeneratedAt: "__ts__", shiftsCreated: 4 }); // redelivered after the stamp
    expect(shifts()).toHaveLength(0);
    expect(hoisted.updates).toHaveLength(0);
    // the booking is gone → nothing created, stamped so it never retries
    const orphan = amendment({ bookingRequestId: "nope" });
    hoisted.docState.set("booking_amendments/am9", orphan);
    await run({ ...orphan, status: "pending" }, orphan, "am9");
    expect(shifts()).toHaveLength(0);
    expect(hoisted.updates.find((u) => u.path === "booking_amendments/am9")!.data).toEqual({ shiftsGeneratedAt: "__ts__", shiftsCreated: 0, shiftsSkippedReason: "no_booking" });
  });
});
