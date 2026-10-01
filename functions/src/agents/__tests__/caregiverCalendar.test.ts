import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The caregiver My Calendar page, texted (caregiverCalendar.ts): the page's reads,
// its Day / Week / Month / List views, the shift and interview detail panels,
// and the keywords.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  sessionWrites: [] as any[],
  interviews: [] as any[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        orderBy: () => q(filters), limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, op, v]) =>
            op === "in" ? (v as any[]).includes(d[f]) : op === ">=" ? String(d[f]) >= String(v) : op === "<=" ? String(d[f]) <= String(v) : d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, op: string, v: any) => q([[f, op, v]]),
        doc: (id: string) => ({
          get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
          set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
        }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../caregiverInterviewsTab", () => ({ listCaregiverInterviews: vi.fn(async () => ({ interviews: hoisted.interviews, count: hoisted.interviews.length, chip: "all" })) }));
vi.mock("../../utils/scheduledTime", async (orig) => ({ ...(await orig<any>()), businessTodayStr: () => "2026-09-30" }));

import { weekStart, weekLabel, interviewLocalParts, dayText, weekText, monthText, listText, shiftDetailText, interviewDetailText, sendCaregiverCalendar, handleCalendarKeyword, loadCalendarShifts, loadCalendarInterviews } from "../caregiverCalendar";
import { emptyGrid } from "../caregiverAvailabilityGrid";

const TODAY = "2026-09-30"; // Wednesday
const RECIPIENTS = [{ name: "H M", relationship: "parent", notes: "Likes tea at 3.", careNeeds: ["occasional help", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist"] } }];
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", bookingRequestId: "br1", startTime: "19:30", endTime: "19:45", address: "12 Elm St", rate: 25, careRecipients: RECIPIENTS, tasksCompleted: [], ...over });
const ivRow = (id: string, iso: string, status = "pending", rawStatus = "requested", extra: Record<string, unknown> = {}): any => ({
  interviewId: id, jobId: "job1", jobTitle: "Weekday help for Mom", jobLocation: "Seattle, WA", clientId: "fam1", clientName: "Basra Yousuf", rate: "$26/hr", status, rawStatus,
  scheduledTime: iso, scheduledTimeLocal: null, interviewType: "Video", joinVideoCall: null, notes: null, proposal: null, actions: status === "pending" ? ["Accept", "Decline", "Propose different time"] : ["Cancel"], ...extra,
});
const grid = () => ({ ...emptyGrid(), monday: ["morning", "afternoon"] as any, wednesday: ["evening"] as any });

// Pin the clock as well as the business day: shiftDisplayStatus reads Date.now(), so the
// 7:30 PM fixture visit would read Overdue when the suite runs after 7:45 PM Pacific.
beforeEach(() => { vi.useFakeTimers({ now: Date.parse("2026-09-30T19:00:00.000Z"), toFake: ["Date"] }); hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.sessionWrites.length = 0; hoisted.interviews = []; });
afterEach(() => { vi.useRealTimers(); });

describe("dates", () => {
  it("week starts Sunday like the page; labels match weekLabel; an interview's UTC instant lands on its Pacific day and clock", () => {
    expect(weekStart("2026-09-30")).toBe("2026-09-27");
    expect(weekStart("2026-09-30", 1)).toBe("2026-10-04");
    expect(weekLabel("2026-09-27", "2026-10-03")).toBe("Sep 27 – Oct 3");
    expect(weekLabel("2026-10-04", "2026-10-10")).toBe("October 4 – 10, 2026");
    expect(interviewLocalParts("2026-09-28T16:00:00.000Z")).toEqual({ date: "2026-09-28", time: "09:00" }); // 9 AM PDT
    expect(interviewLocalParts(null)).toBeNull();
  });
});

describe("views", () => {
  const shifts = () => [
    { id: "a", caregiverId: "cg1", date: "2026-09-30", startTime: "19:30", endTime: "19:45", status: "scheduled", clientName: "Basra Yousuf" },
    { id: "b", caregiverId: "cg1", date: "2026-09-30", startTime: "09:00", endTime: "10:00", status: "cancelled", clientName: "Basra Yousuf" },
    { id: "c", caregiverId: "cg1", date: "2026-09-28", startTime: "11:00", endTime: "12:00", status: "completed", clientName: "Basra Yousuf" },
    { id: "d", caregiverId: "cg1", date: "2026-10-06", startTime: "08:00", endTime: "09:00", status: "scheduled", clientName: "Fam Two" },
  ] as any[];
  const ivs = (): any[] => [{ id: "iv1", date: "2026-09-28", startTime: "09:00", row: ivRow("iv1", "2026-09-28T16:00:00.000Z") }];

  it("Day: the day's Available blocks, events by time, cancelled hidden, numbered", () => {
    const d = dayText(TODAY, shifts(), ivs(), grid(), TODAY);
    expect(d.text).toBe("Wed, Sep 30, 2026 (today)\nAvailable: Evening\n\n1. 7:30 PM – 7:45 PM · Basra Yousuf · Scheduled\n\nReply VISIT n or INTERVIEW n for details. TODAY, TOMORROW, WEEK, NEXT WEEK or MONTH for another view.");
    expect(d.items).toEqual([{ number: 1, kind: "shift", id: "a", status: "scheduled", clientName: "Basra Yousuf", date: TODAY }]);
    expect(dayText("2026-10-01", shifts(), ivs(), grid(), TODAY).text).toContain("Not marked available this day.\n\nNothing scheduled.");
  });
  it("Week: Sun → Sat with Available shading, interviews and visits, numbers run across the week", () => {
    const w = weekText("2026-09-27", shifts(), ivs(), grid(), TODAY);
    expect(w.text).toContain("Week of Sep 27 – Oct 3\n\nSun 27\n—\n\nMon 28 · Available: Morning, Afternoon\n1. 9:00 AM · Interview · Basra Yousuf · Weekday help for Mom · Pending\n2. 11:00 AM – 12:00 PM · Basra Yousuf · Completed\n\nTue 29\n—\n\nWed 30 (today) · Available: Evening\n3. 7:30 PM – 7:45 PM · Basra Yousuf · Scheduled\n\nThu 1\n—");
    expect(w.items.map((i) => `${i.number}:${i.kind}:${i.id}`)).toEqual(["1:interview:iv1", "2:shift:c", "3:shift:a"]);
  });
  it("Month: counts per day incl. cancelled (the page's dots) + the Upcoming panel (4 shifts, 2 interviews)", () => {
    const m = monthText("2026-09", shifts(), ivs(), TODAY);
    expect(m.text).toContain("September 2026\n\nMon 28: 1 interview, 1 completed\nWed 30 (today): 1 cancelled, 1 scheduled\n\nUpcoming\n1. Wed, Sep 30, 2026 · 7:30 PM – 7:45 PM · Basra Yousuf · Scheduled\n2. Tue, Oct 6, 2026 · 8:00 AM – 9:00 AM · Fam Two · Scheduled");
    expect(m.items.map((i) => i.id)).toEqual(["a", "d"]);
  });
  it("List: filters, grouped by day, two per day + Show more, numbers cover hidden rows; MORE pages the days", () => {
    const l = listText("upcoming", shifts(), ivs(), TODAY);
    expect(l.text).toContain("Calendar · Upcoming\n\nWed, Sep 30, 2026 (today)\n1. 9:00 AM – 10:00 AM · Basra Yousuf · Cancelled\n2. 7:30 PM – 7:45 PM · Basra Yousuf · Scheduled\n\nTue, Oct 6, 2026\n3. 8:00 AM – 9:00 AM · Fam Two · Scheduled");
    expect(listText("last-30", shifts(), ivs(), TODAY).text).toContain("Mon, Sep 28, 2026\n1. 9:00 AM · Interview");
    expect(listText("this-week", shifts(), ivs(), TODAY).items).toHaveLength(4);
    const paged = listText("all", [...shifts(), ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, caregiverId: "cg1", date: `2026-11-0${i + 1}`, startTime: "08:00", status: "scheduled", clientName: "Z" }))] as any[], ivs(), TODAY, { perPage: 5 });
    expect(paged.remaining).toBe(4);
    expect(paged.text).toMatch(/Reply MORE for more days\.$/);
  });
});

describe("detail panels", () => {
  it("a scheduled visit: header, address, rate, booking + visit notes, tasks per recipient, the page's action words, emergency contact", () => {
    const text = shiftDetailText(
      { id: "a", caregiverId: "cg1", date: "2099-01-05", startTime: "19:30", endTime: "19:45", status: "scheduled", clientName: "Basra Yousuf", address: "12 Elm St", rate: 25, lifestylePreferences: ["No pets"], notes: "Use the side door", careRecipients: RECIPIENTS, tasksCompleted: [] } as any,
      { notes: "Always call me if anything's off", emergencyContact: { name: "Ali", relationship: "son", phone: "555-1212" } },
      { nowMs: Date.parse("2099-01-01T00:00:00Z") },
    );
    expect(text).toBe([
      "Scheduled · Basra Yousuf", "Mon, Jan 5, 2099 · 7:30 PM – 7:45 PM", "$25/hr", "12 Elm St", "No pets",
      "Booking note: Always call me if anything's off", "Visit note: Use the side door",
      "", "Tasks 0/2", "H M (parent)", "Note: Likes tea at 3.", "Tasks:", "1. occasional help", "2. Mobility Assistance — Transfer Assist",
      "", "Start available 15 min before the shift.", "Reply CANCEL SHIFT to cancel it.", "To message Basra Yousuf, just tell me what to send.",
      "", "Emergency contact: Ali · son · 555-1212",
    ].join("\n"));
  });
  it("in progress / completed / missed / gated read like the panel's states", () => {
    const base = { id: "a", caregiverId: "cg1", date: "2026-09-30", startTime: "19:30", endTime: "19:45", clientName: "B", careRecipients: [], tasksCompleted: [] } as any;
    expect(shiftDetailText({ ...base, status: "in-progress", startedAt: "2026-10-01T02:31:00.000Z" }, null)).toContain("Started Sep 30, 7:31:00 PM\n\nIn progress — reply DONE n to check off a task, NOTE followed by anything the family should see, TASKS to re-list, or FINISH when the visit is over.");
    expect(shiftDetailText({ ...base, status: "completed", startedAt: "2026-10-01T02:31:00.000Z", completedAt: "2026-10-01T02:45:00.000Z", completionNotes: "All good.", notesLog: [{ at: "2026-10-01T02:40:00.000Z", text: "Ate well." }] }, null)).toContain("Shift Completed\nVisit notes\n• 7:40 PM — Ate well.\nCaregiver note\nAll good.");
    expect(shiftDetailText({ ...base, status: "scheduled", date: "2000-01-01" }, null)).toContain("This visit was missed — reply LOG to log the hours.");
    const soon = new Date(Date.now() + 5 * 60_000);
    const la = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(soon).reduce((o: any, p) => ({ ...o, [p.type]: p.value }), {});
    const startable = { ...base, status: "scheduled", date: `${la.year}-${la.month}-${la.day}`, startTime: `${la.hour === "24" ? "00" : la.hour}:${la.minute}`, endTime: "23:59" };
    expect(shiftDetailText(startable, null)).toContain("Reply START to start this shift.");
    expect(shiftDetailText(startable, null, { gate: "membership" })).toContain("Membership required");
  });
  it("an interview: status, time, type, job details, the Jobs-tab actions as reply words", () => {
    const text = interviewDetailText(ivRow("iv1", "2026-09-28T16:00:00.000Z", "pending", "requested", { notes: "Bring references" }), { careTypes: ["Companionship"], daysOfWeek: ["Mon", "Wed"], timeOfDay: ["morning"], jobFrequency: "part-time", rate: 26, city: "Seattle", state: "WA" });
    expect(text).toBe("Interview · Pending · Basra Yousuf\nMon, Sep 28 · 9:00 AM\nVideo Call\nSeattle, WA\nCompanionship\nDays: Mon, Wed\nTime: Morning\npart time · $26/hr\nNotes: Bring references\n\nReply ACCEPT to accept. DECLINE to decline. or tell me a different time to propose.\nTo message Basra Yousuf, just tell me what to send.");
    const acc = interviewDetailText(ivRow("iv2", "2026-09-28T16:00:00.000Z", "accepted", "accepted", { joinVideoCall: "https://meet.google.com/abc", actions: ["Join video call", "Cancel"] }), null);
    expect(acc).toContain("Join: https://meet.google.com/abc. Tell me if you need to cancel this interview.");
  });
});

describe("send + keywords", () => {
  it("loads the page's reads (shifts in range, the tab's interviews, the grid), texts the view and stores the numbered list", async () => {
    hoisted.docs.set("caregivers/cg1", { weeklyAvailability: { wednesday: [{ start: "18:00", end: "23:00" }] } });
    shift("a", { date: TODAY, status: "scheduled" });
    shift("old", { date: "2026-01-01", status: "completed" });
    hoisted.interviews = [ivRow("iv1", "2026-10-01T16:00:00.000Z"), ivRow("gone", "2026-10-01T17:00:00.000Z", "declined", "declined")];
    expect((await loadCalendarShifts("cg1", "2026-09-27", "2026-10-03")).map((s) => s.id)).toEqual(["a"]);
    expect((await loadCalendarInterviews("cg1")).map((i) => i.id)).toEqual(["iv1"]); // the page's status filter drops declined
    const r = await sendCaregiverCalendar("+1", "chat", "cg1", { view: "week" });
    expect(hoisted.sent[0]).toContain("Wed 30 (today) · Available: Evening\n1. 7:30 PM – 7:45 PM · Basra Yousuf · Scheduled\n\nThu 1\n2. 9:00 AM · Interview · Basra Yousuf · Weekday help for Mom · Pending");
    expect(r.items).toHaveLength(2);
    expect(hoisted.sessionWrites.at(-1).lastCalendarList.items[1]).toMatchObject({ number: 2, kind: "interview", id: "iv1" });
  });
  it("CALENDAR / TODAY / TOMORROW / NEXT WEEK / MONTH text a view; VISIT n and INTERVIEW n open the panels when the calendar was the last list", async () => {
    hoisted.docs.set("caregivers/cg1", {});
    hoisted.docs.set("booking_requests/br1", { notes: "Booking note here" });
    shift("a", { date: TODAY, status: "scheduled" });
    hoisted.interviews = [ivRow("iv1", "2026-10-01T16:00:00.000Z")];
    for (const k of ["CALENDAR", "today", "Tomorrow", "next week", "MONTH"]) expect(await handleCalendarKeyword("+1", "chat", "cg1", k, {})).toBe("handled");
    expect(hoisted.sent[1]).toMatch(/^Wed, Sep 30, 2026 \(today\)/);
    expect(hoisted.sent[2]).toMatch(/^Thu, Oct 1, 2026\n/);
    expect(hoisted.sent[3]).toMatch(/^Week of October 4 – 10, 2026/);
    expect(hoisted.sent[4]).toMatch(/^September 2026\n/);
    const session = { lastCalendarList: { at: "2026-09-30T10:00:00.000Z", items: [{ number: 1, kind: "shift", id: "a", status: "scheduled", clientName: "Basra Yousuf", date: TODAY }, { number: 2, kind: "interview", id: "iv1", status: "pending", clientName: "Basra Yousuf", date: "2026-10-01" }] }, lastPastBookingList: { at: "2026-09-30T09:00:00.000Z", items: [] } };
    expect(await handleCalendarKeyword("+1", "chat", "cg1", "VISIT 1", session)).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Scheduled · Basra Yousuf\nWed, Sep 30, 2026 · 7:30 PM – 7:45 PM\n$25/hr\n12 Elm St\nBooking note: Booking note here");
    expect(await handleCalendarKeyword("+1", "chat", "cg1", "interview 2", session)).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Interview · Pending · Basra Yousuf\nThu, Oct 1 · 9:00 AM\nVideo Call/);
    // The Past tab was texted more recently → VISIT n is its numbering, not the calendar's.
    expect(await handleCalendarKeyword("+1", "chat", "cg1", "VISIT 1", { ...session, lastPastBookingList: { at: "2026-09-30T11:00:00.000Z", items: [] } })).toBe("passthrough");
    expect(await handleCalendarKeyword("+1", "chat", "cg1", "what's my week", {})).toBe("passthrough");
  });
});
