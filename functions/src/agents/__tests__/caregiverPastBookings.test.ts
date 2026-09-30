import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Bookings page's Past Bookings tab, texted (caregiverPastBookings.ts):
// the page's two queries, its grouping and badges, its rows, a completed visit's
// detail, and the Log Hours modal as a flow with the page's exact write.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionWrites: [] as any[],
  sent: [] as string[],
  quick: vi.fn(async () => "NONE"),
  access: { ok: true, caregiver: {} } as any,
  gateTexts: [] as string[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        orderBy: () => q(filters), limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, op, v]) =>
            op === "in" ? (v as any[]).includes(d[f]) : op === "<=" ? String(d[f]) <= String(v) : d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, op: string, v: any) => q([[f, op, v]]),
        doc: (id: string) => ({
          get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
          update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); if (name === "agent_sessions") hoisted.sessionWrites.push(d); else if (hoisted.docs.has(`${name}/${id}`)) hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d }); }),
          set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
        }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" }, Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("../stepHandler", () => ({ isBackOutRequest: vi.fn(async () => false), isQuestionOrOther: vi.fn(async () => false), answerMidFlow: vi.fn(async (_t: string, q: string) => `Answer. ${q}`) }));
vi.mock("../caregiverAccessGate", () => ({
  checkCaregiverAccess: vi.fn(async () => hoisted.access),
  textCaregiverGateBlock: vi.fn(async (_p: string, _c: string, reason: string) => { hoisted.gateTexts.push(reason); }),
}));

import { loadPastTab, pastTabText, visitDetailText, handleLogHoursFlowStep, handlePastBookingsKeyword, sendCaregiverPastBookings, EMPTY_TEXT } from "../caregiverPastBookings";

const RECIPIENTS = [{ name: "H M", relationship: "parent", notes: "testing for additional notes specific to the care recipient", careNeeds: ["occasional help", "Dementia / Memory Care", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist"] } }];
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", bookingRequestId: "br1", startTime: "19:30", endTime: "19:45", careRecipients: RECIPIENTS, tasksCompleted: [], ...over });

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionWrites.length = 0; hoisted.sent.length = 0; hoisted.quick.mockReset(); hoisted.quick.mockResolvedValue("NONE"); hoisted.access = { ok: true, caregiver: {} }; hoisted.gateTexts.length = 0; });

describe("the tab — the page's queries, grouping, badges and rows", () => {
  it("groups missed (overdue scheduled) + completed + cancelled per booking, missed first; badges and rows read like the card", async () => {
    shift("done", { date: "2026-09-28", status: "completed", startTime: "11:00", endTime: "14:00", startedAt: "2026-09-28T18:04:38.000Z", completedAt: "2026-09-28T18:18:25.000Z", tasksCompleted: ["0_occasional help"] });
    shift("cx", { date: "2026-10-04", status: "cancelled" });
    shift("miss", { date: "2000-01-01", status: "scheduled" });      // long past, never started → Missed
    shift("future", { date: "2099-01-01", status: "scheduled" });    // not on this tab
    shift("other", { date: "2026-09-20", status: "completed", bookingRequestId: "br2", clientName: "Fam Two", startedAt: null, completedAt: null });
    const groups = await loadPastTab("cg1");
    expect(groups.map((g) => g.key)).toEqual(["br1", "br2"]);
    expect(groups[0].shifts.map((s) => s.id)).toEqual(["miss", "cx", "done"]); // missed first, then date desc
    const { text, items } = pastTabText(groups, { allVisits: true });
    expect(text).toContain("Basra Yousuf · 1 completed · 1 missed · 1 cancelled");
    expect(text).toContain("1. Sat, Jan 1, 2000 · 7:30 PM – 7:45 PM · Missed — reply LOG 1 to log hours");
    expect(text).toContain("2. Sun, Oct 4, 2026 · 7:30 PM – 7:45 PM · Cancelled");
    expect(text).toContain("3. Mon, Sep 28, 2026 · Sep 28, 11:04:38 AM – Sep 28, 11:18:25 AM · 0:13:47 · Completed");
    expect(text).toContain("Fam Two · 1 completed\n4. Sun, Sep 20, 2026 · 7:30 PM – 7:45 PM · Completed"); // no stamps → scheduled times
    expect(items.map((i) => `${i.number}:${i.status}`)).toEqual(["1:missed", "2:cancelled", "3:completed", "4:completed"]);
    const two = pastTabText(groups).text;
    expect(two).toContain("+1 more visit — reply PAST VISITS to see them all.");
    expect(two.endsWith("Reply VISIT n for a completed visit's tasks and notes.")).toBe(true);
  });
  it("empty tab → the page's empty state; the send stores the number map", async () => {
    const r = await sendCaregiverPastBookings("+1", "chat", "cg1");
    expect(hoisted.sent).toEqual([EMPTY_TEXT]);
    expect(r.total).toBe(0);
  });
});

describe("a completed visit's detail — the page's click-through", () => {
  it("scheduled + actual times, tasks per recipient done / not done, visit notes, closing note", () => {
    const text = visitDetailText({
      id: "d", date: "2026-09-28", status: "completed", startTime: "11:00", endTime: "14:00", clientName: "Basra Yousuf",
      startedAt: "2026-09-28T18:04:38.000Z", completedAt: "2026-09-28T18:18:25.000Z", careRecipients: RECIPIENTS, tasksCompleted: ["0_occasional help", "0_Mobility Assistance_Transfer Assist"],
      notesLog: [{ at: "2026-09-28T18:08:00.000Z", text: "H M is doing well." }], completionNotes: "Good visit.",
    } as any);
    expect(text).toBe([
      "Mon, Sep 28, 2026 · Scheduled 11:00 AM – 2:00 PM",
      "Started Sep 28, 11:04:38 AM · Ended Sep 28, 11:18:25 AM · 0:13:47",
      "", "Tasks (2/3 done)", "H M (parent)",
      "• occasional help — done", "• Dementia / Memory Care — not done", "• Mobility Assistance — Transfer Assist — done",
      "", "Visit notes", "• 11:08 AM — H M is doing well.",
      "", "Caregiver note", "Good visit.",
    ].join("\n"));
  });
});

describe("Log Hours — the modal as a flow, ending in the page's write", () => {
  const session = (over: Record<string, unknown>) => ({ caregiverId: "cg1", chatId: "chat", ...over }) as any;
  it("LOG n opens the flow only for a missed visit and is gated like the page", async () => {
    shift("miss", { date: "2000-01-01", status: "scheduled" });
    shift("done", { date: "2026-09-28", status: "completed" });
    const list = { items: [{ number: 1, shiftId: "miss", status: "missed", clientName: "Basra Yousuf" }, { number: 2, shiftId: "done", status: "completed", clientName: "Basra Yousuf" }] };
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "LOG 2", { lastPastBookingList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/already completed — Log Hours is only for a missed visit/);
    hoisted.access = { ok: false, block: "membership", caregiver: {} };
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "log 1", { lastPastBookingList: list })).toBe("handled");
    expect(hoisted.gateTexts).toEqual(["membership"]);
    hoisted.access = { ok: true, caregiver: {} };
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "LOG 1", { lastPastBookingList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Log hours for Basra Yousuf, Sat, Jan 1, 2000. What time did you actually start? Reply a time like 7:30 PM, or KEEP for the scheduled 7:30 PM.");
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ logHoursFlowStep: "lh_start", logHoursFlowData: { shiftId: "miss", taskList: expect.any(Array) } });
    expect(hoisted.sessionWrites.at(-1).logHoursFlowData.taskList.map((t: any) => t.label)).toEqual(["occasional help", "Dementia / Memory Care", "Mobility Assistance — Transfer Assist"]);
  });

  it("start → end → tasks → note → LOG writes exactly the modal's patch and texts its toast", async () => {
    shift("miss", { date: "2000-01-01", status: "scheduled" });
    const taskList = [{ number: 1, key: "0_occasional help", label: "occasional help", recipientName: "H M" }, { number: 2, key: "0_Dementia / Memory Care", label: "Dementia / Memory Care", recipientName: "H M" }, { number: 3, key: "0_Mobility Assistance_Transfer Assist", label: "Mobility Assistance — Transfer Assist", recipientName: "H M" }];
    const base = { shiftId: "miss", clientName: "Basra Yousuf", date: "2000-01-01", startTime: "19:30", endTime: "19:45", taskList };
    // start: KEEP is deterministic
    await handleLogHoursFlowStep("+1", "chat", "keep", session({ logHoursFlowStep: "lh_start", logHoursFlowData: base }));
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ logHoursFlowStep: "lh_end", logHoursFlowData: { startDate: "2000-01-01", startAt: "19:30" } });
    expect(hoisted.sent.at(-1)).toBe("And what time did you finish? Reply a time, or KEEP for the scheduled 7:45 PM.");
    // end: a spoken time → the classifier returns HH:MM
    hoisted.quick.mockResolvedValueOnce("20:05");
    await handleLogHoursFlowStep("+1", "chat", "about 8:05 pm", session({ logHoursFlowStep: "lh_end", logHoursFlowData: { ...base, startDate: "2000-01-01", startAt: "19:30" } }));
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ logHoursFlowStep: "lh_tasks", logHoursFlowData: { endDate: "2000-01-01", endAt: "20:05" } });
    // The recipient note sits under the name like the modal's Tasks Completed section (founder 2026-09-29).
    expect(hoisted.sent.at(-1)).toMatch(/^Which tasks were done\?\nH M \(parent\)\nNote: testing for additional notes specific to the care recipient\nTasks:\n1\. occasional help\n2\. Dementia \/ Memory Care\n3\. Mobility Assistance — Transfer Assist\n\nReply the numbers/);
    // tasks by number
    const withTimes = { ...base, startDate: "2000-01-01", startAt: "19:30", endDate: "2000-01-01", endAt: "20:05" };
    await handleLogHoursFlowStep("+1", "chat", "1, 3", session({ logHoursFlowStep: "lh_tasks", logHoursFlowData: withTimes }));
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ logHoursFlowStep: "lh_note", logHoursFlowData: { tasks: ["0_occasional help", "0_Mobility Assistance_Transfer Assist"] } });
    // note → confirm
    hoisted.quick.mockResolvedValueOnce("NOTE");
    await handleLogHoursFlowStep("+1", "chat", "She was tired but fine.", session({ logHoursFlowStep: "lh_note", logHoursFlowData: { ...withTimes, tasks: ["0_occasional help", "0_Mobility Assistance_Transfer Assist"] } }));
    expect(hoisted.sent.at(-1)).toBe("Log hours for Basra Yousuf, Sat, Jan 1, 2000:\nStarted Sat, Jan 1, 2000 7:30 PM · Ended Sat, Jan 1, 2000 8:05 PM · 0h 35m\nTasks done: 2/3\nNote: She was tired but fine.\n\nReply LOG to save, or CANCEL.");
    // LOG → the modal's write
    const full = { ...withTimes, tasks: ["0_occasional help", "0_Mobility Assistance_Transfer Assist"], note: "She was tired but fine." };
    await handleLogHoursFlowStep("+1", "chat", "Confirm", session({ logHoursFlowStep: "lh_confirm", logHoursFlowData: full })); // the page's word saves too, no classifier
    expect(hoisted.quick).not.toHaveBeenCalledWith(expect.stringContaining("LOG to save"), expect.anything(), expect.anything());
    const w = hoisted.updates.find((u) => u.path === "shifts/miss")!.data;
    expect(w).toMatchObject({ status: "completed", loggedManually: true, tasksCompleted: ["0_occasional help", "0_Mobility Assistance_Transfer Assist"], completionNotes: "She was tired but fine.", updatedAt: "__ts__" });
    expect(w.startedAt).toEqual({ __ms: Date.parse("2000-01-01T19:30:00-08:00") });
    expect(w.completedAt).toEqual({ __ms: Date.parse("2000-01-01T20:05:00-08:00") });
    expect(hoisted.sent.at(-1)).toBe("Hours logged successfully");
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ logHoursFlowStep: "__delete__" });
  });

  it("an end before the start is refused; CANCEL backs out; a visit already completed by then is not re-written", async () => {
    shift("miss", { date: "2000-01-01", status: "scheduled" });
    const base = { shiftId: "miss", clientName: "Basra Yousuf", date: "2000-01-01", startTime: "19:30", endTime: "19:45", taskList: [], startDate: "2000-01-01", startAt: "19:30" };
    hoisted.quick.mockResolvedValueOnce("19:00");
    await handleLogHoursFlowStep("+1", "chat", "7pm", session({ logHoursFlowStep: "lh_end", logHoursFlowData: base }));
    expect(hoisted.sent.at(-1)).toMatch(/^The end has to be after the start \(7:30 PM\)\./);
    await handleLogHoursFlowStep("+1", "chat", "CANCEL", session({ logHoursFlowStep: "lh_confirm", logHoursFlowData: { ...base, endDate: "2000-01-01", endAt: "20:00", tasks: [], note: "" } }));
    expect(hoisted.sent.at(-1)).toBe("Okay — nothing was logged. The visit still shows as missed.");
    hoisted.docs.set("shifts/miss", { ...hoisted.docs.get("shifts/miss"), status: "completed" });
    await handleLogHoursFlowStep("+1", "chat", "LOG", session({ logHoursFlowStep: "lh_confirm", logHoursFlowData: { ...base, endDate: "2000-01-01", endAt: "20:00", tasks: [], note: "" } }));
    expect(hoisted.sent.at(-1)).toBe("That visit is already completed — nothing to log.");
    expect(hoisted.updates.filter((u) => u.path === "shifts/miss")).toHaveLength(0);
  });
});

describe("keywords", () => {
  it("PAST texts the tab; VISIT n texts a completed visit's detail; unknown numbers are explained", async () => {
    shift("done", { date: "2026-09-28", status: "completed", startTime: "11:00", endTime: "14:00", startedAt: "2026-09-28T18:04:38.000Z", completedAt: "2026-09-28T18:18:25.000Z" });
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "past", {})).toBe("handled");
    expect(hoisted.sent[0]).toMatch(/^Past bookings:\n\nBasra Yousuf · 1 completed\n1\. Mon, Sep 28, 2026/);
    const list = hoisted.sessionWrites.at(-1).lastPastBookingList;
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "VISIT 1", { lastPastBookingList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Mon, Sep 28, 2026 · Scheduled 11:00 AM – 2:00 PM\nStarted /);
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "visit 9", { lastPastBookingList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/don't have a visit 9/);
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "what's my schedule", {})).toBe("passthrough");
  });
  it("bare LOG (the missed-visit reminder's word): one missed visit → its flow; none → told; several → the tab + which one", async () => {
    shift("done", { date: "2026-09-28", status: "completed" });
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "LOG", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^You have no missed visits to log/);
    shift("miss", { date: "2000-01-01", status: "scheduled" });
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "log", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Log hours for Basra Yousuf, Sat, Jan 1, 2000\./);
    shift("miss2", { date: "2000-01-02", status: "scheduled" });
    expect(await handlePastBookingsKeyword("+1", "chat", "cg1", "LOG HOURS", { logHoursFlowStep: undefined })).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Which one? Reply LOG with the visit's number.");
    expect(hoisted.sent.at(-2)).toMatch(/Missed — reply LOG 1 to log hours[\s\S]*Missed — reply LOG 2 to log hours/);
  });
});
