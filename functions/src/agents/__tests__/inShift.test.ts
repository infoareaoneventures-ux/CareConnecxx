import { describe, it, expect, vi, beforeEach } from "vitest";

// The Bookings page's per-visit buttons over text (inShift.ts): Start Shift,
// the Tasks checklist, the visit-notes box, End — and the START / DONE n /
// NOTE … / END keyword protocol the start text announces.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionWrites: [] as any[],
  sent: [] as string[],
  quick: vi.fn(async () => "NOTE"),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`), ref: { update: async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d }); } } })),
        update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
        set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
      }),
      where: (f: string, _o: string, v: any) => ({ where: (f2: string, _o2: string, v2: any) => ({
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && d[f] === v && d[f2] === v2)
            .map(([p, d]) => { const id = p.split("/")[1]; return { id, data: () => d, ref: { update: async (x: any) => { hoisted.updates.push({ path: p, data: x }); hoisted.docs.set(p, { ...hoisted.docs.get(p), ...x }); } } }; });
          return { docs, empty: docs.length === 0 };
        }),
      }) }),
    }),
  }), { FieldValue: { serverTimestamp: () => "__ts__", arrayUnion: (v: any) => ({ __arrayUnion: v }), delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));

import { taskItems, startVisit, checkTasks, addVisitNote, endVisit, resolveVisit, handleInShiftKeyword, END_PROMPT } from "../inShift";
import { businessTodayStr } from "../../utils/scheduledTime";

const la = (d: Date) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
const RECIPIENTS = [{ name: "Mai", relationship: "Mother", notes: "Likes her tea at 3.", careNeeds: ["Companionship", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist", "Walking"] } }];
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientId: "c1", clientName: "Basra Yousuf", status: "scheduled", date: "2099-09-28", startTime: "11:00", endTime: "14:00", careRecipients: RECIPIENTS, tasksCompleted: [], ...over });

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionWrites.length = 0; hoisted.sent.length = 0; hoisted.quick.mockReset(); hoisted.quick.mockResolvedValue("NOTE"); });

describe("two care recipients — one block each, numbers run across (DONE n stays unambiguous)", () => {
  it("groups tasks under each recipient with their note; a check-off names the recipient", async () => {
    const two = [
      { name: "Mai", relationship: "Mother", notes: "Likes her tea at 3.", careNeeds: ["Companionship"] },
      { name: "Bao", relationship: "Father", careNeeds: ["Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Walking"] } },
    ];
    const { date, time } = la(new Date(Date.now() + 5 * 60 * 1000));
    shift("s1", { date, startTime: time, endTime: "23:59", careRecipients: two });
    const r = await startVisit("cg1", "s1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("\nMai (Mother)\nNote: Likes her tea at 3.\nTasks:\n1. Companionship\n\nBao (Father)\nTasks:\n2. Mobility Assistance — Walking\n");
    hoisted.docs.set("shifts/s1", { ...hoisted.docs.get("shifts/s1"), date: businessTodayStr() });
    const t = await checkTasks("cg1", undefined, { numbers: [2] });
    expect(t.ok && t.text).toBe("Checked off: Mobility Assistance — Walking (Bao) (1/2 done).");
  });
});

describe("taskItems — the page's keys and labels", () => {
  it("one task per need, or per subtask; keys are recipientIndex_need[_subtask]", () => {
    expect(taskItems({ careRecipients: RECIPIENTS, tasksCompleted: ["0_Mobility Assistance_Walking"] })).toEqual([
      { number: 1, key: "0_Companionship", label: "Companionship", done: false, recipientIndex: 0, recipientName: "Mai" },
      { number: 2, key: "0_Mobility Assistance_Transfer Assist", label: "Mobility Assistance — Transfer Assist", done: false, recipientIndex: 0, recipientName: "Mai" },
      { number: 3, key: "0_Mobility Assistance_Walking", label: "Mobility Assistance — Walking", done: true, recipientIndex: 0, recipientName: "Mai" },
    ]);
  });
});

describe("startVisit — the Start Shift button", () => {
  it("inside the window: the page's write, and the start text with the visit note, the recipient note, the numbered tasks and the keyword line", async () => {
    const { date, time } = la(new Date(Date.now() + 5 * 60 * 1000));
    hoisted.docs.set("booking_requests/br1", { notes: "This is an additional shift" });
    shift("s1", { date, startTime: time, endTime: "23:59", bookingRequestId: "br1", notes: "testing as additional shift" });
    const r = await startVisit("cg1", "s1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hoisted.updates[0]).toEqual({ path: "shifts/s1", data: { status: "in-progress", startedAt: "__ts__", updatedAt: "__ts__" } });
    expect(r.text).toMatch(/^Started \d{1,2}:\d{2} [AP]M — .+ with Basra Yousuf\.\nBooking note: This is an additional shift\nVisit note: testing as additional shift\n\nMai \(Mother\)\nNote: Likes her tea at 3\.\nTasks:\n1\. Companionship\n2\. Mobility Assistance — Transfer Assist\n3\. Mobility Assistance — Walking\n\nReply DONE 1 \(or DONE 1, 3\) as you finish, NOTE followed by anything the family should see, and FINISH when the visit is over\.\nPrefer the page\? Open this visit: https?:\/\/\S+\/caregiver\/bookings\?tab=active&visit=s1$/);
  });
  it("too early → told when Start opens; nothing written", async () => {
    const soon = la(new Date(Date.now() + 90 * 60 * 1000));
    shift("s1", { date: soon.date, startTime: soon.time, endTime: "23:59" });
    const r = await startVisit("cg1", "s1"); // by id — "today" lookups near midnight Pacific would cross the date line
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_early");
    expect(r.message).toMatch(/Start opens 15 minutes before the visit/);
    expect(hoisted.updates).toHaveLength(0);
  });
});

describe("checkTasks / addVisitNote / endVisit — in progress only, the page's writes", () => {
  it("DONE by numbers writes the full tasksCompleted array; a note appends to notesLog; END writes completed + the closing note", async () => {
    shift("s1", { status: "in-progress", date: businessTodayStr() });
    const t = await checkTasks("cg1", undefined, { numbers: [1, 3] });
    expect(t.ok).toBe(true);
    expect(hoisted.updates.at(-1)).toEqual({ path: "shifts/s1", data: { tasksCompleted: ["0_Companionship", "0_Mobility Assistance_Walking"] } });
    if (t.ok) expect(t.text).toBe("Checked off: Companionship, Mobility Assistance — Walking (2/3 done).");
    const n = await addVisitNote("cg1", undefined, "She ate a full lunch.");
    expect(n.ok).toBe(true);
    expect(hoisted.updates.at(-1)!.data.notesLog).toEqual({ __arrayUnion: expect.objectContaining({ text: "She ate a full lunch.", by: "caregiver" }) });
    const e = await endVisit("cg1", undefined, "Good visit.");
    expect(e.ok).toBe(true);
    expect(hoisted.updates.at(-1)).toEqual({ path: "shifts/s1", data: { status: "completed", completedAt: "__ts__", updatedAt: "__ts__", completionNotes: "Good visit." } });
    if (e.ok) expect(e.text).toMatch(/^Ended \d{1,2}:\d{2} [AP]M — .+\. Tasks 2\/3\. Your closing note is on the visit\. Thank you\.$/);
  });
  it("nothing in progress → each refuses without writing", async () => {
    shift("s1", { status: "scheduled", date: businessTodayStr() });
    expect((await checkTasks("cg1", undefined, { numbers: [1] })).ok).toBe(false);
    expect((await addVisitNote("cg1", undefined, "x")).ok).toBe(false);
    expect((await endVisit("cg1", undefined, "")).ok).toBe(false);
    expect(hoisted.updates).toHaveLength(0);
    const v = await resolveVisit("cg1", "nope", "start");
    expect(v.ok).toBe(false);
  });
});

describe("handleInShiftKeyword — START · DONE n · NOTE … · END · SKIP", () => {
  it("START starts today's visit; DONE 2 checks a task; NOTE adds a line; END asks for the closing note, the next text is the note", async () => {
    const { date, time } = la(new Date(Date.now() + 5 * 60 * 1000));
    shift("s1", { date, startTime: time, endTime: "23:59" });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "start", {})).toBe("handled");
    expect(hoisted.sent[0]).toMatch(/^Started /);
    hoisted.docs.set("shifts/s1", { ...hoisted.docs.get("shifts/s1"), date: businessTodayStr() });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "DONE 2", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Checked off: Mobility Assistance — Transfer Assist (1/3 done).");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "Note: she walked twice", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Noted — the family can see it on the visit.");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "done", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Done with a task\?/);
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "FINISH", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe(END_PROMPT);
    expect(hoisted.sessionWrites.at(-1).pendingShiftEnd).toMatchObject({ shiftId: "s1" });
    // a question while the END prompt is parked goes to the agent, the prompt stays parked
    hoisted.quick.mockResolvedValueOnce("QUESTION");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "does the family see this?", { pendingShiftEnd: { shiftId: "s1" } })).toBe("passthrough");
    expect(hoisted.docs.get("shifts/s1").status).toBe("in-progress");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "Mai was in great spirits today.", { pendingShiftEnd: { shiftId: "s1" } })).toBe("handled");
    expect(hoisted.docs.get("shifts/s1")).toMatchObject({ status: "completed", completionNotes: "Mai was in great spirits today." });
    expect(hoisted.sent.at(-1)).toMatch(/^Ended /);
  });
  it("two visits today and no id → START asks WHICH (numbered, by shift id); the number starts that one, never the earlier by default", async () => {
    const { date, time } = la(new Date(Date.now() + 5 * 60 * 1000));
    shift("s1", { date, startTime: time, endTime: "23:59", clientName: "Basra Yousuf" });
    shift("s2", { date, startTime: time, endTime: "23:59", clientName: "Tom Nguyen" });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "START", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Which visit\? Reply 1 for .*Basra Yousuf.*, Reply 2 for .*Tom Nguyen/);
    const choice = hoisted.sessionWrites.at(-1).pendingVisitChoice;
    expect(choice.candidates.map((c: any) => c.shiftId)).toEqual(["s1", "s2"]);
    expect(hoisted.docs.get("shifts/s1").status).toBe("scheduled");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "2", { pendingVisitChoice: choice })).toBe("handled");
    expect(hoisted.docs.get("shifts/s2").status).toBe("in-progress");
    expect(hoisted.docs.get("shifts/s1").status).toBe("scheduled");
    expect(hoisted.sent.at(-1)).toMatch(/^Started .*Tom Nguyen/);
    // an unknown answer re-asks; a family name picks too
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "9", { pendingVisitChoice: choice })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Which visit\?/);
  });
  it("a repeated DONE never un-checks; UNDO n does (and END alone is left to the opt-out handler)", async () => {
    shift("s1", { status: "in-progress", date: businessTodayStr(), tasksCompleted: ["0_Companionship"] });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "DONE 1", {})).toBe("handled");
    expect(hoisted.docs.get("shifts/s1").tasksCompleted).toEqual(["0_Companionship"]);
    expect(hoisted.sent.at(-1)).toBe("Checked off: Companionship (1/3 done).");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "undo 1", {})).toBe("handled");
    expect(hoisted.docs.get("shifts/s1").tasksCompleted).toEqual([]);
    expect(hoisted.sent.at(-1)).toBe("Unchecked: Companionship (0/3 done).");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "END", {})).toBe("passthrough");
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "end shift", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe(END_PROMPT);
  });
  it("TASKS re-lists the checklist mid-visit with what is done", async () => {
    shift("s1", { status: "in-progress", date: businessTodayStr(), tasksCompleted: ["0_Companionship"] });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "tasks", {})).toBe("handled");
    expect(hoisted.sent[0]).toBe("Tasks (1/3 done):\n\nMai (Mother)\nTasks:\n1. Companionship — done\n2. Mobility Assistance — Transfer Assist\n3. Mobility Assistance — Walking\n\nReply DONE with a number to check one off.");
  });
  it("SKIP ends without a note; anything else falls through", async () => {
    shift("s1", { status: "in-progress", date: businessTodayStr() });
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "skip", { pendingShiftEnd: { shiftId: "s1" } })).toBe("handled");
    expect(hoisted.docs.get("shifts/s1").status).toBe("completed");
    expect(hoisted.docs.get("shifts/s1").completionNotes).toBeUndefined();
    expect(await handleInShiftKeyword("+1", "chat", "cg1", "what's my schedule tomorrow?", {})).toBe("passthrough");
  });
});
