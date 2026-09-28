import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Bookings page's Requests tab, texted (caregiverBookingRequests.ts):
// the page's query, its card, its "View full details", its two buttons' writes.

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sets: [] as Array<{ path: string; data: any }>,
  sessionWrites: [] as Array<{ phone: string; data: any }>,
  session: {} as Record<string, unknown>,
  autoId: 0,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id?: string) => {
        const docId = id ?? `auto-${++hoisted.autoId}`;
        const path = `${name}/${docId}`;
        return {
          path,
          get: vi.fn(async () => name === "agent_sessions"
            ? { exists: true, data: () => hoisted.session }
            : { exists: hoisted.docs.has(path), id: docId, data: () => hoisted.docs.get(path) }),
          update: vi.fn(async (d: any) => { hoisted.updates.push({ path, data: d }); hoisted.docs.set(path, { ...hoisted.docs.get(path), ...d }); }),
          set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push({ phone: docId, data: d }); else hoisted.docs.set(path, d); }),
        };
      },
      where: (f: string, _op: string, v: any) => {
        const run = (filters: Array<[string, any]>, sorted: boolean) => vi.fn(async () => {
          let entries = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([ff, vv]) => d[ff] === vv));
          if (sorted) entries = entries.sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)));
          const docs = entries.map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, empty: docs.length === 0 };
        });
        return {
          orderBy: () => ({ get: run([[f, v]], true) }),
          where: (f2: string, _o2: string, v2: any) => ({ get: run([[f, v], [f2, v2]], false) }),
          get: run([[f, v]], false),
        };
      },
    }),
    batch: () => ({
      set: (ref: any, d: any) => { hoisted.sets.push({ path: ref.path, data: d }); hoisted.docs.set(ref.path, d); },
      update: (ref: any, d: any) => { hoisted.updates.push({ path: ref.path, data: d }); },
      commit: vi.fn(async () => {}),
    }),
  }), { FieldValue: { serverTimestamp: () => "__serverTimestamp__", delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));

import {
  fmtDate, fmtTime, fmtHours, requestCardLines, requestDetailsLines, requestListText,
  loadPendingBookingRequests, sendBookingRequestList, respondToBookingRequest, resolveBookingRequestRef, EMPTY_TEXT,
  amendmentCardLines, loadPendingAmendments, acceptAmendment, declineAmendment, requestsTabItems,
} from "../caregiverBookingRequests";

const req = (over: Record<string, unknown> = {}) => ({
  id: "br1", clientId: "fam1", clientName: "The Nguyen Family", clientRating: 4.8, status: "pending",
  schedule: { startDate: "2026-09-28", ongoing: true, dayShiftTimes: { Wed: [{ start: "13:00", end: "17:00" }], Mon: [{ start: "09:00", end: "13:00" }] } },
  address: "20 Descanso Dr, San Jose, CA 95134", lifestylePreferences: ["No pets", "Non-smoker"], rate: 25,
  careRecipients: [{ name: "Mai Nguyen", relationship: "Mother", age: 82, careNeeds: ["Mobility Assistance", "Companionship"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist", "Walking"] },
    lifestyle: { favoriteActivities: ["Gardening"], favoriteActivitiesOther: "crosswords", helpActivities: ["Bathing"], entertainment: [], enjoysConversation: true, prefersQuiet: false, familyInArea: true, familyVisitFreq: "Weekly", friendsVisitors: null, hasAppointments: true, appointmentsDetails: "PT on Fridays" } }],
  emergencyContact: { name: "Linh Nguyen", relationship: "Daughter", phone: "(408) 555-0100" },
  notes: "Mom likes her tea at 3.",
  createdAt: "2026-09-27T10:00:00.000Z",
  ...over,
});

beforeEach(() => { hoisted.sent.length = 0; hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sets.length = 0; hoisted.sessionWrites.length = 0; hoisted.session = {}; hoisted.autoId = 0; });

describe("the page's helpers", () => {
  it("formats date, time and hours the way the page does", () => {
    expect(fmtDate("2026-09-28")).toBe("Mon, Sep 28, 2026");
    expect(fmtTime("09:00")).toBe("9:00 AM");
    expect(fmtTime("13:30")).toBe("1:30 PM");
    expect(fmtTime("~00:30")).toBe("12:30 AM (next day)");
    expect(fmtHours(240)).toBe("4h");
    expect(fmtHours(90)).toBe("1h 30m");
  });
});

describe("the collapsed card", () => {
  it("name + rating + status, Starts/Ongoing, days in Sun..Sat order with hours and the weekly total, address + lifestyle chips, rate · Card (agreed rate)", () => {
    expect(requestCardLines(req())).toEqual([
      "The Nguyen Family · 4.8 client rating · Pending",
      "Starts Mon, Sep 28, 2026",
      "Ongoing",
      "Mon 9:00 AM – 1:00 PM (4h)",
      "Wed 1:00 PM – 5:00 PM (4h)",
      "8h / week",
      "20 Descanso Dr, San Jose, CA 95134",
      "No pets · Non-smoker",
      "$25/hr · Card (agreed rate)",
    ]);
  });
  it("a one-day request (start === end, not ongoing) says One visit and skips the weekly total", () => {
    const lines = requestCardLines(req({ schedule: { startDate: "2026-09-28", endDate: "2026-09-28", ongoing: false, dayShiftTimes: { Mon: [{ start: "09:00", end: "13:00" }] } } }));
    expect(lines[1]).toBe("One visit · Mon, Sep 28, 2026");
    expect(lines).not.toContain("4h / week");
    expect(lines).not.toContain("Ongoing");
  });
  it("Ends {date} when not ongoing; days fallback when there are no shift times", () => {
    const lines = requestCardLines(req({ schedule: { startDate: "2026-09-28", endDate: "2026-10-28", ongoing: false, days: ["Mon", "Wed"] } }));
    expect(lines).toContain("Ends Wed, Oct 28, 2026");
    expect(lines).toContain("Mon, Wed");
  });
});

describe("View full details", () => {
  it("care recipient with relationship · age, Care Plan with subtasks, Lifestyle sections and Yes/No rows, emergency contact, notes", () => {
    const t = requestDetailsLines(req()).join("\n");
    expect(t).toContain("Care Recipient\nMai Nguyen — Mother · Age 82");
    // 2026-09-27: the family's per-recipient note, under the header like the page now shows it.
    expect(requestDetailsLines(req({ careRecipients: [{ name: "Mai", notes: "Anxious after 4 PM" }] })).join("\n")).toContain("Mai\nNotes: Anxious after 4 PM");
    expect(t).toContain("Care Plan\n• Mobility Assistance: Transfer Assist, Walking\n• Companionship");
    expect(t).toContain("Enjoys: Gardening · Other: crosswords");
    expect(t).toContain("Needs help with: Bathing");
    expect(t).not.toContain("Entertainment:");
    expect(t).toContain("Enjoys conversation: Yes\nPrefers quiet: No\nFamily in area: Yes\nFamily visit frequency: Weekly\nHas appointments: Yes");
    expect(t).not.toContain("Friends or visitors"); // null → the page hides the row
    expect(t).toContain("Appointments: PT on Fridays");
    expect(t).toContain("Emergency Contact\nLinh Nguyen (Daughter) · (408) 555-0100");
    expect(t).toContain("Notes\nMom likes her tea at 3.");
  });
  it("the list footer is the buttons: accept/decline, or the gate button with decline still available", () => {
    expect(requestListText([req()]).text.endsWith("Reply ACCEPT or DECLINE.")).toBe(true);
    expect(requestListText([req(), req({ id: "br2" })]).text.endsWith('Reply ACCEPT or DECLINE with the number, e.g. "accept 1".')).toBe(true);
    expect(requestListText([req()], { gate: "membership" }).text.endsWith("To accept you'll need to: Activate Membership. You can still reply DECLINE.")).toBe(true);
    expect(requestListText([req()], { gate: "background" }).text).toContain("Complete Verification");
  });
});

describe("the list", () => {
  it("empty state is the page's", () => {
    expect(requestListText([]).text).toBe(EMPTY_TEXT);
    expect(EMPTY_TEXT).toBe("No pending requests. When a family sends you a booking request, it will appear here. Accepted bookings move to Active Bookings.");
  });
  it("numbers each request WHOLE (card + full details), two at a time, MORE for the rest", () => {
    const reqs = [1, 2, 3].map((n) => req({ id: `br${n}`, clientName: `Family ${n}` }));
    const p1 = requestListText(reqs);
    expect(p1.text.startsWith("Booking requests:\n\n1. Family 1 · 4.8 client rating · Pending\n")).toBe(true);
    expect(p1.text).toContain("$25/hr · Card (agreed rate)\n\nCare Recipient\nMai Nguyen — Mother · Age 82"); // the card, then what View full details shows
    expect(p1.text).toContain("Emergency Contact\nLinh Nguyen (Daughter) · (408) 555-0100");
    expect(p1.text).toContain("\n\n2. Family 2");
    expect(p1.text).not.toContain("3. Family 3");
    expect(p1.text.endsWith('Reply ACCEPT or DECLINE with the number, e.g. "accept 1". Reply MORE to see more.')).toBe(true);
    const p2 = requestListText(reqs, { from: 2 });
    expect(p2.text.startsWith("More requests:\n\n3. Family 3")).toBe(true);
  });
  it("the query is the page's: caregiverId ==, newest first, then status === pending", async () => {
    hoisted.docs.set("booking_requests/old", { ...req(), caregiverId: "cg1", createdAt: "2026-09-01T00:00:00Z" });
    hoisted.docs.set("booking_requests/new", { ...req(), caregiverId: "cg1", createdAt: "2026-09-27T00:00:00Z" });
    hoisted.docs.set("booking_requests/done", { ...req(), caregiverId: "cg1", status: "accepted", createdAt: "2026-09-28T00:00:00Z" });
    hoisted.docs.set("booking_requests/other", { ...req(), caregiverId: "cg2", createdAt: "2026-09-29T00:00:00Z" });
    const list = await loadPendingBookingRequests("cg1");
    expect(list.map((r) => r.id)).toEqual(["new", "old"]);
  });
  it("sendBookingRequestList texts and stores the number → id map", async () => {
    hoisted.docs.set("booking_requests/br1", { ...req(), caregiverId: "cg1" });
    const r = await sendBookingRequestList("+1555", "chat", "cg1");
    expect(r).toMatchObject({ sent: true, count: 1, total: 1, remaining: 0 });
    expect(hoisted.sent[0]).toContain("1. The Nguyen Family");
    expect(hoisted.sessionWrites[0].data.lastBookingRequestList.items).toEqual([{ number: 1, kind: "request", bookingRequestId: "br1", clientName: "The Nguyen Family" }]);
    // the only request is parked, so a plain "accept" runs the page's button
    expect(hoisted.sessionWrites[0].data.pendingDecision).toMatchObject({ kind: "booking_request", recordId: "br1", options: ["ACCEPT", "DECLINE", "DETAILS"], party: "The Nguyen Family" });
  });
});

describe("Accept / Decline — the page's exact writes", () => {
  it("accept writes {status:'accepted', updatedAt} and nothing else; toast is the page's", async () => {
    hoisted.docs.set("booking_requests/br1", { ...req(), caregiverId: "cg1" });
    const r = await respondToBookingRequest("cg1", "br1", "accept");
    expect(r).toMatchObject({ ok: true, status: "accepted", toast: "Booking request from The Nguyen Family accepted!" });
    expect(hoisted.updates).toEqual([{ path: "booking_requests/br1", data: { status: "accepted", updatedAt: "__serverTimestamp__" } }]);
  });
  it("decline writes {status:'declined', updatedAt}; toast 'Request declined'", async () => {
    hoisted.docs.set("booking_requests/br1", { ...req(), caregiverId: "cg1" });
    const r = await respondToBookingRequest("cg1", "br1", "decline");
    expect(r).toMatchObject({ ok: true, status: "declined", toast: "Request from The Nguyen Family declined" });
    expect(hoisted.updates[0].data).toEqual({ status: "declined", updatedAt: "__serverTimestamp__" });
  });
  it("refuses another caregiver's request, a missing one, or one no longer pending", async () => {
    hoisted.docs.set("booking_requests/br1", { ...req(), caregiverId: "OTHER" });
    expect(await respondToBookingRequest("cg1", "br1", "accept")).toEqual({ ok: false, reason: "not_yours" });
    expect(await respondToBookingRequest("cg1", "nope", "accept")).toEqual({ ok: false, reason: "not_found" });
    hoisted.docs.set("booking_requests/br2", { ...req(), caregiverId: "cg1", status: "accepted" });
    expect(await respondToBookingRequest("cg1", "br2", "decline")).toEqual({ ok: false, reason: "not_pending", status: "accepted" });
    expect(hoisted.updates).toHaveLength(0);
  });
  it("'accept' with no number resolves only through a number or a one-request list", () => {
    expect(resolveBookingRequestRef({ lastBookingRequestList: { at: "x", items: [{ number: 1, bookingRequestId: "a", clientName: "A" }, { number: 2, kind: "amendment", bookingRequestId: "b", clientName: "B" }] } }, { number: 2 })).toEqual({ kind: "amendment", id: "b" });
    expect(resolveBookingRequestRef({ lastBookingRequestList: { at: "x", items: [{ number: 1, bookingRequestId: "only", clientName: "A" }] } }, {})).toEqual({ kind: "request", id: "only" });
    expect(resolveBookingRequestRef({ lastBookingRequestList: { at: "x", items: [{ number: 1, bookingRequestId: "a", clientName: "A" }, { number: 2, bookingRequestId: "b", clientName: "B" }] } }, {})).toBeNull();
    expect(resolveBookingRequestRef({}, {})).toBeNull();
  });
});

// ── The tab's second card: schedule-change requests (booking_amendments) ──────
describe("schedule-change cards — the page's card and its Accept/Decline, verbatim", () => {
  const amendment = (over: Record<string, unknown> = {}) => ({
    id: "am1", bookingRequestId: "br1", clientId: "fam1", clientName: "The Nguyen Family", caregiverId: "cg1", caregiverName: "Maria",
    status: "pending", type: "add_recurring_days", newDays: { Fri: [{ start: "09:00", end: "11:00" }], Mon: [{ start: "14:00", end: "16:00" }] },
    notes: "Extra help on Fridays", startDate: "2099-01-05", endDate: null, ongoing: true, createdAt: "2026-09-27T00:00:00Z", ...over,
  });

  it("the card: name · Schedule change request, days in Sun..Sat order, Starts + Ongoing / → end, notes", () => {
    expect(amendmentCardLines(amendment() as any)).toEqual([
      "The Nguyen Family · Schedule change request",
      "Mon · 2:00 PM – 4:00 PM",
      "Fri · 9:00 AM – 11:00 AM",
      "Starts Mon, Jan 5, 2099 · Ongoing",
      "Extra help on Fridays",
    ]);
    expect(amendmentCardLines(amendment({ startDate: undefined, ongoing: false, endDate: "2099-01-30", notes: "" }) as any)).toEqual([
      "The Nguyen Family · Schedule change request", "Mon · 2:00 PM – 4:00 PM", "Fri · 9:00 AM – 11:00 AM", "Starts immediately → Fri, Jan 30, 2099",
    ]);
  });

  it("the list puts schedule changes after the booking requests, numbered on, and the session remembers the kind", async () => {
    hoisted.docs.set("booking_requests/br1", { ...req(), caregiverId: "cg1" });
    hoisted.docs.set("booking_amendments/am1", amendment());
    hoisted.docs.set("booking_amendments/am2", amendment({ status: "accepted" }));
    expect((await loadPendingAmendments("cg1")).map((a) => a.id)).toEqual(["am1"]);
    const r = await sendBookingRequestList("+1555", "chat", "cg1");
    expect(r.total).toBe(2);
    expect(hoisted.sent[0]).toContain("\n\n2. The Nguyen Family · Schedule change request\nMon · 2:00 PM – 4:00 PM");
    expect(hoisted.sessionWrites[0].data.lastBookingRequestList.items).toEqual([
      { number: 1, kind: "request", bookingRequestId: "br1", clientName: "The Nguyen Family" },
      { number: 2, kind: "amendment", bookingRequestId: "am1", clientName: "The Nguyen Family" },
    ]);
    expect(requestsTabItems([], []).length).toBe(0);
  });

  it("Decline writes {status:'declined', respondedAt} and nothing else", async () => {
    hoisted.docs.set("booking_amendments/am1", amendment());
    const r = await declineAmendment("cg1", "am1");
    expect(r).toMatchObject({ ok: true, status: "declined" });
    expect(hoisted.updates).toEqual([{ path: "booking_amendments/am1", data: { status: "declined", respondedAt: "__serverTimestamp__" } }]);
    expect(hoisted.sets).toHaveLength(0);
  });

  it("Accept (ongoing): merges the new days into the booking's schedule, creates weekly visits for the next 4 weeks with the page's shift shape, marks accepted", async () => {
    hoisted.docs.set("booking_amendments/am1", amendment({ newDays: { Fri: [{ start: "09:00", end: "11:00" }] } }));
    hoisted.docs.set("booking_requests/br1", { clientId: "fam1", clientName: "The Nguyen Family", caregiverName: "Maria", caregiverPhotoURL: "https://p/1.jpg", address: "20 Descanso Dr",
      careNeeds: ["Companionship"], lifestylePreferences: ["No pets"], rate: 25, paymentMethod: "credit", notes: "general note",
      careRecipients: [{ name: "Mai" }], emergencyContact: { name: "Linh" }, schedule: { ongoing: true, startDate: "2099-01-01", dayShiftTimes: { Mon: [{ start: "09:00", end: "13:00" }] } } });
    const r = await acceptAmendment("cg1", "am1");
    expect(r).toMatchObject({ ok: true, status: "accepted", shiftsCreated: 4, toast: "Schedule updated for The Nguyen Family — new visits added." });
    // the booking's permanent schedule gains the new day
    const bookingUpdate = hoisted.updates.find((u) => u.path === "booking_requests/br1")!;
    expect(bookingUpdate.data).toEqual({ "schedule.dayShiftTimes": { Mon: [{ start: "09:00", end: "13:00" }], Fri: [{ start: "09:00", end: "11:00" }] }, updatedAt: "__serverTimestamp__" });
    // the visits: every Friday from the start date for 27 days, the page's exact shift document
    const shifts = hoisted.sets.filter((x) => x.path.startsWith("shifts/"));
    expect(shifts.map((x) => x.data.date)).toEqual(["2099-01-09", "2099-01-16", "2099-01-23", "2099-01-30"]);
    expect(shifts[0].data).toMatchObject({
      clientId: "fam1", clientName: "The Nguyen Family", clientPhotoURL: null, caregiverId: "cg1", caregiverName: "Maria", caregiverPhotoURL: "https://p/1.jpg",
      status: "scheduled", address: "20 Descanso Dr", careNeeds: ["Companionship"], lifestylePreferences: ["No pets"], rate: 25, paymentMethod: "credit",
      notes: "Extra help on Fridays", careRecipients: [{ name: "Mai" }], emergencyContact: { name: "Linh" },
      schedule: { ongoing: true, startDate: "2099-01-01", dayShiftTimes: { Mon: [{ start: "09:00", end: "13:00" }], Fri: [{ start: "09:00", end: "11:00" }] } },
      bookingRequestId: "br1", recurringWeekly: true, tasksCompleted: [], createdAt: "__serverTimestamp__", startTime: "09:00", endTime: "11:00",
    });
    expect(hoisted.updates.find((u) => u.path === "booking_amendments/am1")!.data).toEqual({ status: "accepted", respondedAt: "__serverTimestamp__" });
  });

  it("Accept (dated): no schedule merge; visits weekly until the end date; the booking's general note when the request has none", async () => {
    hoisted.docs.set("booking_amendments/am1", amendment({ newDays: { Fri: [{ start: "09:00", end: "11:00" }] }, ongoing: false, endDate: "2099-01-16", notes: "" }));
    hoisted.docs.set("booking_requests/br1", { clientId: "fam1", notes: "general note", schedule: { ongoing: true, dayShiftTimes: {} } });
    const r = await acceptAmendment("cg1", "am1");
    expect(r).toMatchObject({ ok: true, shiftsCreated: 2 });
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")).toBeUndefined();
    const shifts = hoisted.sets.filter((x) => x.path.startsWith("shifts/"));
    expect(shifts.map((x) => x.data.date)).toEqual(["2099-01-09", "2099-01-16"]);
    expect(shifts[0].data.notes).toBe("general note");
  });

  it("refuses another caregiver's change, a missing one, or one already answered", async () => {
    hoisted.docs.set("booking_amendments/am1", amendment({ caregiverId: "OTHER" }));
    expect(await acceptAmendment("cg1", "am1")).toEqual({ ok: false, reason: "not_yours" });
    expect(await declineAmendment("cg1", "nope")).toEqual({ ok: false, reason: "not_found" });
    hoisted.docs.set("booking_amendments/am2", amendment({ status: "declined" }));
    expect(await acceptAmendment("cg1", "am2")).toEqual({ ok: false, reason: "not_pending", status: "declined" });
    expect(hoisted.sets).toHaveLength(0);
  });
});
