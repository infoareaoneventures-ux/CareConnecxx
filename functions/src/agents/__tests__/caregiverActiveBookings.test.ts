import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Bookings page's Active Bookings tab, texted
// (caregiverActiveBookings.ts): the page's query, grouping, card and rows —
// including each visit's own note (founder 2026-09-28).

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  docs: new Map<string, any>(),
  sessionWrites: [] as Array<{ phone: string; data: any }>,
  session: {} as Record<string, unknown>,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => name === "agent_sessions"
          ? { exists: true, data: () => hoisted.session }
          : { exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) }),
        set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push({ phone: id, data: d }); }),
      }),
      where: (f: string, _op: string, v: any) => ({
        where: (f2: string, op2: string, v2: any) => ({
          orderBy: (field: string) => ({
            get: vi.fn(async () => {
              const match = (d: any) => d[f] === v && (op2 === "in" ? (v2 as any[]).includes(d[f2]) : d[f2] === v2);
              const docs = [...hoisted.docs.entries()]
                .filter(([p, d]) => p.startsWith(`${name}/`) && match(d))
                .sort((a, b) => String(a[1][field]).localeCompare(String(b[1][field])))
                .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
              return { docs, empty: docs.length === 0 };
            }),
          }),
        }),
      }),
    }),
  }), { FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));

import { activeCardLines, groupActiveShifts, baseShift, totalTasksFor, shiftStatusLabel, activeBookingsText, sendCaregiverActiveBookings, EMPTY_TEXT } from "../caregiverActiveBookings";

const booking = {
  clientId: "fam1", clientName: "Basra Yousuf", caregiverId: "cg1", bookingRequestId: "br1", address: "20 Descanso Dr, San Jose, CA 95134",
  lifestylePreferences: ["No pets"], rate: 24, paymentMethod: "credit",
  careRecipients: [{ name: "H M", relationship: "Mother", age: 80, careNeeds: ["Companionship", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist", "Walking"] }, notes: "Likes tea at 3." }],
  emergencyContact: { name: "S M", relationship: "sibling", phone: "(408) 637-0483" },
};
const shift = (id: string, over: Record<string, unknown>) => ({ ...booking, id, status: "scheduled", recurringWeekly: true, tasksCompleted: [], ...over });

beforeEach(() => { hoisted.sent.length = 0; hoisted.docs.clear(); hoisted.sessionWrites.length = 0; hoisted.session = {}; });

describe("grouping and the card's base shift", () => {
  it("groups by bookingRequestId in page order and reads the card off the LATEST-dated shift (its schedule carries every accepted change)", () => {
    const old = shift("a", { date: "2099-09-26", startTime: "19:30", endTime: "21:30", notes: "This is an additional shift", schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }] } } }) as any;
    const newer = shift("b", { date: "2099-10-25", startTime: "19:30", endTime: "19:45", notes: "testing as additional shift", schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }], Sun: [{ start: "19:30", end: "19:45" }] } } }) as any;
    const other = shift("c", { date: "2099-10-01", bookingRequestId: "br2", clientName: "Fam Two" }) as any;
    const groups = groupActiveShifts([old, other, newer]);
    expect(groups.map((g) => g.key)).toEqual(["br1", "br2"]);
    expect(baseShift([old, newer]).id).toBe("b");
    expect(groups[0].base.id).toBe("b");
  });
  it("tasks total = one per need, or one per subtask; status labels are the page's", () => {
    expect(totalTasksFor(booking.careRecipients as any)).toBe(3);
    expect(shiftStatusLabel("in-progress")).toBe("In Progress");
    expect(shiftStatusLabel("needs_replacement")).toBe("Needs Replacement");
  });
});

describe("the card — header, schedule, note, care plan, upcoming visits with their own notes", () => {
  it("renders the page's card and each upcoming visit's note when it differs from the booking's", () => {
    const sat = shift("s1", { date: "2099-10-03", startTime: "19:30", endTime: "21:30", notes: "This is an additional shift",
      schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }], Sat: [{ start: "19:30", end: "21:30" }] } } }) as any;
    const mon = shift("m1", { date: "2099-09-28", startTime: "11:00", endTime: "14:00", notes: "My note will be Always call me when there is an issue.", tasksCompleted: ["Transfer Assist"],
      schedule: sat.schedule }) as any;
    const sun = shift("u1", { date: "2099-10-25", startTime: "19:30", endTime: "19:45", notes: "testing as additional shift",
      schedule: { ...sat.schedule, dayShiftTimes: { ...sat.schedule.dayShiftTimes, Sun: [{ start: "19:30", end: "19:45" }] } } }) as any;
    const overdue = shift("o1", { date: "2000-01-01", startTime: "09:00", endTime: "10:00", notes: "old" }) as any;
    const [g] = groupActiveShifts([overdue, mon, sat, sun]);
    // the booking's own note (booking_requests.notes) is the header; the newest visit's note no longer takes over
    const lines = activeCardLines(g, { schedulePaused: false, bookingNote: "This is an additional shift", allVisits: true });
    expect(lines.slice(0, 9)).toEqual([
      "Basra Yousuf · Ongoing",
      "Starts Sun, Sep 27, 2099",
      "Sun 7:30 PM – 7:45 PM (0h 15m)", // the page's day order (Sun first) and its fmtHours
      "Mon 11:00 AM – 2:00 PM (3h)",
      "Sat 7:30 PM – 9:30 PM (2h)",
      "20 Descanso Dr, San Jose, CA 95134",
      "No pets",
      "$24/hr · Card",
      "Notes: This is an additional shift", // the booking's own note, the same the family's card shows
    ]);
    expect(lines).toContain("Care plan & preferences");
    expect(lines).toContain("Notes: Likes tea at 3."); // the recipient's note, inside the details
    expect(lines).toContain("• Mobility Assistance: Transfer Assist, Walking");
    expect(lines).toContain("S M (sibling) · (408) 637-0483");
    const up = lines.indexOf("Upcoming shifts");
    expect(lines.slice(up, up + 6)).toEqual([
      "Upcoming shifts",
      "Mon, Sep 28, 2099 · 11:00 AM – 2:00 PM · Scheduled · 1/3 tasks",
      "  My note will be Always call me when there is an issue.",
      "Sat, Oct 3, 2099 · 7:30 PM – 9:30 PM · Scheduled · 0/3 tasks", // its note IS the booking note → not repeated (the page's rule)
      "Sun, Oct 25, 2099 · 7:30 PM – 7:45 PM · Scheduled · 0/3 tasks",
      "  testing as additional shift", // the schedule-change note on the visits that request created
    ]);
    expect(lines.join("\n")).not.toContain("old"); // the overdue visit is not an upcoming row
    expect(lines.at(-1)).toBe("  testing as additional shift"); // no "Extra visit requested" rows any more
  });

  it("shows two visits and the page's Show more line by default; VISITS shows them all", () => {
    const sch = { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }] } };
    const a = shift("a", { date: "2099-09-28", schedule: sch }) as any, b = shift("b", { date: "2099-10-05", schedule: sch }) as any, c = shift("c", { date: "2099-10-12", schedule: sch }) as any;
    const two = activeCardLines(groupActiveShifts([a, b, c])[0]);
    expect(two.filter((l) => /^(Mon|Sat|Sun|Tue|Wed|Thu|Fri), /.test(l))).toHaveLength(2);
    expect(two.at(-1)).toBe("+1 more visit — reply VISITS to see them all.");
    const all = activeCardLines(groupActiveShifts([a, b, c])[0], { allVisits: true });
    expect(all.filter((l) => /^(Mon|Sat|Sun|Tue|Wed|Thu|Fri), /.test(l))).toHaveLength(3);
    expect(all.at(-1)).not.toMatch(/more visit/);
  });

  it("shows the running visit notes under a visit in progress (the page's Visit notes block)", () => {
    const s = shift("p1", { date: "2099-10-06", startTime: "12:00", endTime: "15:00", status: "in-progress", startedAt: "2099-10-06T19:02:00.000Z",
      notesLog: [{ at: "2099-10-06T19:30:00.000Z", text: "She ate a full lunch.", by: "caregiver" }],
      schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }] } } }) as any;
    const lines = activeCardLines(groupActiveShifts([s])[0]);
    const i = lines.indexOf("  Visit notes:");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe("    12:30 PM — She ate a full lunch.");
  });

  it("shows the page's reschedule history under the visit", () => {
    const s = shift("h1", { date: "2099-10-06", startTime: "12:00", endTime: "15:00",
      rescheduleHistory: [{ from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" }, to: { date: "2099-10-06", startTime: "12:00", endTime: "15:00" }, proposedBy: "client", proposedAt: "2099-09-20T22:15:00.000Z", acceptedBy: "caregiver", acceptedAt: "2099-09-21T16:02:00.000Z" }],
      schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }] } } }) as any;
    const lines = activeCardLines(groupActiveShifts([s])[0]);
    expect(lines).toContain("  Reschedule history (1):");
    expect(lines.at(-1)).toBe("    Mon, Oct 5, 2099, 11:00 AM–2:00 PM → Tue, Oct 6, 2099, 12:00 PM–3:00 PM (requested by family on Sep 20, 3:15 PM · confirmed by you on Sep 21, 9:02 AM)");
  });

  it("shows a pending reschedule proposal and the Schedule paused chip", () => {
    const s = shift("r1", { date: "2099-10-05", startTime: "11:00", endTime: "14:00", reschedulePendingDate: "2099-10-06", reschedulePendingStartTime: "12:00", reschedulePendingEndTime: "15:00", rescheduledBy: "client",
      schedule: { startDate: "2099-09-27", ongoing: true, dayShiftTimes: { Mon: [{ start: "11:00", end: "14:00" }] } } }) as any;
    const [g] = groupActiveShifts([s]);
    const lines = activeCardLines(g, { schedulePaused: true });
    expect(lines[0]).toBe("Basra Yousuf · Ongoing · Schedule paused — family's membership inactive");
    expect(lines).toContain("  Basra Yousuf proposed moving this visit to Tue, Oct 6, 2099, 12:00 PM – 3:00 PM — reply to accept or decline.");
  });
});

describe("sendCaregiverActiveBookings — 2 cards per text, MORE continues, numbers stored", () => {
  it("texts the first two bookings and stores the number map; MORE sends the next", async () => {
    for (const [i, name] of ["Fam A", "Fam B", "Fam C"].entries()) {
      hoisted.docs.set(`shifts/s${i}`, shift(`s${i}`, { date: `2099-10-0${i + 1}`, startTime: "09:00", endTime: "10:00", bookingRequestId: `br${i}`, clientName: name, schedule: { startDate: "2099-10-01", ongoing: true, dayShiftTimes: { Mon: [{ start: "09:00", end: "10:00" }] } } }));
    }
    hoisted.docs.set("booking_requests/br1", { schedulePausedAt: "2099-01-01", notes: "Ring the bell twice." });
    const r = await sendCaregiverActiveBookings("+1", "chat", "cg1");
    expect(r).toMatchObject({ sent: true, count: 2, total: 3, remaining: 1 });
    expect(hoisted.sent[0]).toMatch(/^Active bookings:\n\n1\. Fam A · Ongoing\n/);
    expect(hoisted.sent[0]).toContain("2. Fam B · Ongoing · Schedule paused — family's membership inactive");
    expect(hoisted.sent[0]).toContain("Notes: Ring the bell twice."); // the booking's own note
    expect(hoisted.sent[0].endsWith("Reply MORE to see more.")).toBe(true);
    expect(hoisted.sessionWrites[0].data.lastActiveBookingList).toMatchObject({ items: [{ number: 1, bookingRequestId: "br0", clientName: "Fam A" }, { number: 2, bookingRequestId: "br1", clientName: "Fam B" }], offset: 2, total: 3 });
    // the visit ids behind the texted rows, for start_shift / update_shift_task / add_visit_note / complete_shift
    expect(r.visits).toEqual([
      { shiftId: "s0", bookingRequestId: "br0", clientName: "Fam A", date: "2099-10-01", startTime: "09:00", endTime: "10:00", status: "scheduled" },
      { shiftId: "s1", bookingRequestId: "br1", clientName: "Fam B", date: "2099-10-02", startTime: "09:00", endTime: "10:00", status: "scheduled" },
    ]);
    hoisted.session = { lastActiveBookingList: hoisted.sessionWrites[0].data.lastActiveBookingList };
    const r2 = await sendCaregiverActiveBookings("+1", "chat", "cg1", { more: true });
    expect(r2).toMatchObject({ count: 1, remaining: 0 });
    expect(hoisted.sent[1]).toMatch(/^More bookings:\n\n3\. Fam C · Ongoing\n/);
    expect(hoisted.sent[1]).not.toContain("Reply MORE");
  });
  it("no active shifts → the page's empty state", async () => {
    const r = await sendCaregiverActiveBookings("+1", "chat", "cg1");
    expect(r).toMatchObject({ sent: true, count: 0, total: 0 });
    expect(hoisted.sent).toEqual([EMPTY_TEXT]);
    expect(activeBookingsText([], new Map()).text).toBe(EMPTY_TEXT);
  });
});
