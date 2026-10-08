import { describe, it, expect, vi, beforeEach } from "vitest";

// visitMode.ts (2026-10-07): free text during an in-progress visit is read
// against THAT visit — tasks, notes, finish, questions — before any other
// handler, flow or the intent classifier can claim it. Every write is the
// page's own button (inShift.ts). Nothing here is guessed from the words:
// the quick model classifies against the visit's task list.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionWrites: [] as any[],
  sent: [] as string[],
  quick: vi.fn(async (_system: string, _text: string) => "{}"),
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

import { handleVisitModeMessage, classifyVisitMessage, visitRecordText } from "../visitMode";
import { taskItems, END_PROMPT } from "../inShift";

const RECIPIENTS = [
  { name: "Hamse", relationship: "Father", notes: "Likes prune juice.", careNeeds: ["Companionship", "Meal Preparation"] },
  { name: "Mai", relationship: "Mother", careNeeds: ["Mobility Assistance"] },
];
const EC = { name: "Basra Yousuf", relationship: "Daughter", phone: "+15551234567" };
const open = (over: Record<string, unknown> = {}) => hoisted.docs.set("shifts/v1", {
  caregiverId: "cg1", clientId: "c1", clientName: "Basra Yousuf", status: "in-progress", date: "2099-09-28", startTime: "17:45", endTime: "18:00",
  address: "20 Descending Dr, San Jose, CA", careRecipients: RECIPIENTS, emergencyContact: EC, tasksCompleted: [], notes: "feel free to reach out anytime.",
  bookingRequestId: "br1", startedAt: "2099-09-28T17:46:00.000Z", ...over,
});
const session = () => ({ caregiverId: "cg1" });
const reply = (j: Record<string, unknown>) => hoisted.quick.mockResolvedValueOnce(JSON.stringify(j));

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionWrites.length = 0; hoisted.sent.length = 0; hoisted.quick.mockReset(); hoisted.quick.mockResolvedValue("{}"); });

describe("visit mode — free text while a visit is in progress", () => {
  it("with no visit in progress and nothing startable, passes through without a model call", async () => {
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "I'm done with the visit", session())).toBe("passthrough");
    expect(hoisted.quick).not.toHaveBeenCalled();
    expect(hoisted.sent).toEqual([]);
  });

  it("'I'm done with the visit' → the FINISH question, not the cancel flow (live 2026-10-07)", async () => {
    open();
    reply({ kind: "finish" });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "I'm done with the visit", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe(END_PROMPT);
    expect(hoisted.sessionWrites.at(-1)).toMatchObject({ pendingShiftEnd: { shiftId: "v1" } });
  });

  it("a task said in their own words → the page's task toggle, by number; an observation riding along is noted too", async () => {
    open();
    reply({ kind: "task_done", tasks: [2], note: "he ate well" });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "fed him, he ate well", session())).toBe("handled");
    const shift = hoisted.docs.get("shifts/v1");
    expect(shift.tasksCompleted).toEqual(["0_Meal Preparation"]);
    expect(shift.notesLog).toEqual({ __arrayUnion: expect.objectContaining({ text: "he ate well", by: "caregiver" }) });
    expect(hoisted.sent.at(-1)).toBe("Checked off: Meal Preparation (Hamse) (1/3 done). Noted for the family too.");
  });

  it("an observation → the notes box on THIS visit; with two recipients the named one leads the line", async () => {
    open();
    reply({ kind: "note", note: "finished the shower", recipient: "Hamse" });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "Hamse finished the shower", session())).toBe("handled");
    expect(hoisted.docs.get("shifts/v1").notesLog).toEqual({ __arrayUnion: expect.objectContaining({ text: "Hamse: finished the shower" }) });
    expect(hoisted.sent.at(-1)).toBe("Noted — the family can see it on the visit.");
  });

  it("could be a task or a note → ONE question, nothing written", async () => {
    open();
    reply({ kind: "ambiguous", tasks: [2] });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "dinner", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Is that a note for the family, or a task you finished?");
    expect(hoisted.sent.at(-1)).toContain("DONE 2");
    expect(hoisted.updates.filter((u) => u.path === "shifts/v1")).toEqual([]);
  });

  it("a question about the visit is answered from the visit's own record — the emergency contact is in it", async () => {
    open();
    hoisted.docs.set("booking_requests/br1", { notes: "Gate code 1234." });
    reply({ kind: "question", scope: "visit" });
    hoisted.quick.mockResolvedValueOnce("The emergency contact is Basra Yousuf (Daughter), +15551234567.");
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "who is the emergency contact", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("The emergency contact is Basra Yousuf (Daughter), +15551234567.");
    const answerCall = hoisted.quick.mock.calls[1];
    expect(answerCall[0]).toContain("Emergency contact: Basra Yousuf (Daughter) · +15551234567");
    expect(answerCall[0]).toContain("Gate code 1234.");
    expect(answerCall[0]).toContain("Likes prune juice.");
    expect(answerCall[0]).toContain("Tasks still open: 1. Companionship, 2. Meal Preparation, 3. Mobility Assistance");
  });

  it("a question outside the visit (pay, other days) passes through to the agent", async () => {
    open();
    reply({ kind: "question", scope: "outside" });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "when do I get paid", session())).toBe("passthrough");
    expect(hoisted.sent).toEqual([]);
  });

  it("anything else passes through; a model failure fails closed to passthrough (never a wrong write)", async () => {
    open();
    reply({ kind: "other" });
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "hey evia", session())).toBe("passthrough");
    hoisted.quick.mockRejectedValueOnce(new Error("boom"));
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "the client wants the bathroom", session())).toBe("passthrough");
    expect(hoisted.updates.filter((u) => u.path === "shifts/v1")).toEqual([]);
  });

  it("no visit in progress: an arrival never starts the visit — inside the window it points at START, before it says when Start opens", async () => {
    const la = (d: Date) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
    const soon = la(new Date(Date.now() + 5 * 60_000));
    hoisted.docs.set("shifts/s1", { caregiverId: "cg1", clientId: "c1", clientName: "Basra Yousuf", status: "scheduled", date: soon.date, startTime: soon.time, endTime: "23:59", careRecipients: RECIPIENTS, tasksCompleted: [] });
    hoisted.quick.mockResolvedValueOnce("ARRIVED");
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "I'm here at the house", session())).toBe("handled");
    expect(hoisted.docs.get("shifts/s1").status).toBe("scheduled"); // START is the clock-in — nothing starts on an arrival
    expect(hoisted.sent.at(-1)).toMatch(/^Start is open for your .* visit with Basra Yousuf\. Text START to begin it\.$/);
    // Early: Start opens 15 minutes before.
    const later = la(new Date(Date.now() + 40 * 60_000));
    hoisted.docs.set("shifts/s1", { ...hoisted.docs.get("shifts/s1"), date: later.date, startTime: later.time });
    hoisted.quick.mockResolvedValueOnce("ARRIVED");
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "I'm here", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^You're early — Start opens at .* for the .* visit\. Text START then\.$/);
    expect(hoisted.docs.get("shifts/s1").status).toBe("scheduled");
    // Not an arrival → passthrough.
    hoisted.quick.mockResolvedValueOnce("OTHER");
    expect(await handleVisitModeMessage("+1", "chat", "cg1", "what time is my next shift", session())).toBe("passthrough");
    expect(hoisted.docs.get("shifts/s1").status).toBe("scheduled");
  });

  it("the record in words carries address, contact, people, notes, tasks and times", () => {
    open();
    const shift = hoisted.docs.get("shifts/v1");
    const text = visitRecordText(shift, taskItems(shift), "Gate code 1234.", Date.parse("2099-09-28T17:50:00.000Z"));
    expect(text).toContain("Address: 20 Descending Dr, San Jose, CA");
    expect(text).toContain("Emergency contact: Basra Yousuf (Daughter) · +15551234567");
    expect(text).toContain("Care recipient: Hamse (Father) — care needs: Companionship, Meal Preparation — notes: Likes prune juice.");
    expect(text).toContain("Booking note from the family: Gate code 1234.");
    expect(text).toContain("Tasks done: none yet");
    expect(text).toContain("Scheduled to end at 6:00 PM");
  });

  it("classification validates the model's JSON against the real task list and recipients", async () => {
    open();
    const shift = hoisted.docs.get("shifts/v1");
    hoisted.quick.mockResolvedValueOnce('{"kind":"task_done","tasks":[9, 1],"note":"","recipient":"Nobody"}');
    const c = await classifyVisitMessage("did companionship", shift, taskItems(shift));
    expect(c).toMatchObject({ kind: "task_done", tasks: [1], note: null, recipient: null });
    hoisted.quick.mockResolvedValueOnce("not json at all");
    expect(await classifyVisitMessage("??", shift, taskItems(shift))).toEqual({ kind: "other" });
  });
});
