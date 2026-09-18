// The family's grouped visit texts and the completion recap = the booking cards in words.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updates: Array<{ path: string; data: any }> = [];
  const makeDoc = (path: string): any => ({
    path,
    update: vi.fn(async (data: any) => { updates.push({ path, data }); }),
  });
  const coll = (path: string): any => ({
    doc: (id: string) => makeDoc(`${path}/${id}`),
    where: () => ({ limit: () => ({ get: vi.fn(async () => ({ docs: [] })) }) }),
  });
  return { updates, coll, makeDoc, reset: () => { updates.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  firestore: Object.assign(() => ({ collection: hoisted.coll }), {
    FieldValue: { delete: () => ({ __delete: true }), arrayUnion: (...v: any[]) => ({ __arrayUnion: v }) },
  }),
}));
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (h: any) => h }) } }));

import {
  taskLabel, diffVisitProgress, buildFamilyUpdateText, buildVisitCompletionText, recordVisitProgress, fmtDuration,
} from "../familyVisitUpdates";

const shift = {
  clientId: "c1",
  caregiverName: "Basra Yousuf",
  date: "2026-09-17",
  startedAt: "2026-09-18T02:05:54.000Z", // 7:05:54 PM Pacific
  completedAt: "2026-09-18T02:06:40.000Z",
  careRecipients: [
    { name: "Samira M", careNeeds: ["Meal Preparation", "Personal Care", "Medication Reminders"], careNeedDetails: { "Meal Preparation": ["Breakfast"] } },
    { name: "Imran Mohammed", careNeeds: ["bathing", "Mobility Assistance"], careNeedDetails: {} },
  ],
  tasksCompleted: ["0_Personal Care", "0_Medication Reminders", "1_bathing"],
  notesLog: [{ at: "2026-09-18T02:06:00.000Z", text: "Samira ate half her breakfast", by: "caregiver" }],
  completionNotes: "just ended the shift for testing purpose",
};

beforeEach(() => hoisted.reset());

describe("taskLabel — the checkbox keys the caregiver pages write", () => {
  it("maps `${ri}_${category}` and `${ri}_${category}_${sub}` to the card's labels and recipient", () => {
    expect(taskLabel("0_Personal Care", shift)).toEqual({ recipient: "Samira M", label: "Personal Care" });
    expect(taskLabel("0_Meal Preparation_Breakfast", shift)).toEqual({ recipient: "Samira M", label: "Breakfast (Meal Preparation)" });
    expect(taskLabel("1_bathing", shift)).toEqual({ recipient: "Imran Mohammed", label: "bathing" });
    expect(taskLabel("Companionship", { careNeeds: ["Companionship"] })).toEqual({ recipient: null, label: "Companionship" });
  });
});

describe("diffVisitProgress + buildFamilyUpdateText — one grouped text per burst", () => {
  it("texts only what changed, grouped by recipient, with notes and their time", () => {
    const before = { ...shift, tasksCompleted: ["0_Personal Care"], notesLog: [] };
    const items = diffVisitProgress(before, shift);
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["task", "Medication Reminders"], ["task", "bathing"], ["note", "Samira ate half her breakfast"],
    ]);
    const text = buildFamilyUpdateText(shift.caregiverName, items);
    expect(text).toBe('Basra checked off Medication Reminders for Samira; bathing for Imran.\nNote from Basra: "Samira ate half her breakfast"');
  });

  it("nothing new → nothing to send", () => {
    expect(diffVisitProgress(shift, shift)).toEqual([]);
  });

  it("an uncheck is a change too — told as 'unchecked' so the trail matches the record", () => {
    const after = { ...shift, tasksCompleted: ["0_Medication Reminders", "1_bathing"] };
    const items = diffVisitProgress(shift, after);
    expect(items.map((i) => [i.kind, i.text, i.recipient])).toEqual([["undo", "Personal Care", "Samira M"]]);
    expect(buildFamilyUpdateText(shift.caregiverName, items)).toBe("Basra unchecked Personal Care for Samira — not done after all.");
  });
});

describe("recordVisitProgress — the 2-minute window", () => {
  it("sends at once when nothing went out recently and stamps the shift", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    const before = { ...shift, tasksCompleted: [], notesLog: [] };
    const handled = await recordVisitProgress(ref, before, shift, send);
    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledWith("c1", expect.stringContaining("Basra checked off"));
    expect(hoisted.updates[0].data.familyUpdateLastTextAt).toBeTruthy();
  });

  it("queues task check-offs instead of texting when a text went out seconds ago", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    const recent = { ...shift, familyUpdateLastTextAt: new Date().toISOString() };
    const before = { ...recent, tasksCompleted: ["0_Personal Care", "0_Medication Reminders"] };
    const handled = await recordVisitProgress(ref, before, recent, send);
    expect(handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(hoisted.updates[0].data.familyUpdateQueue.map((i: any) => i.text)).toEqual(["bathing"]);
    expect(hoisted.updates[0].data.familyUpdateQueuedAt).toBeTruthy();
  });

  it("a note goes out at once, even inside the window, and carries the queued check-offs with it", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    const recent = {
      ...shift,
      familyUpdateLastTextAt: new Date().toISOString(),
      familyUpdateQueue: [{ kind: "task", text: "Meal Preparation", at: "2026-09-17T22:10:00.000Z", recipient: "Imran" }],
      familyUpdateQueuedAt: "2026-09-17T22:10:00.000Z",
    };
    const before = { ...recent, notesLog: [] };
    expect(await recordVisitProgress(ref, before, recent, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const text = String((send.mock.calls[0] as unknown as [string, string])[1]);
    expect(text).toContain("Samira ate half her breakfast");
    expect(text).toContain("Meal Preparation");
    expect(hoisted.updates[0].data.familyUpdateQueue).toEqual({ __delete: true });
    expect(hoisted.updates[0].data.familyUpdateLastTextAt).toBeTruthy();
  });

  it("an uncheck inside the window cancels the queued check-off — the family never hears about the stray tap", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    const queuedCheck = { kind: "task", text: "Personal Care", at: "2026-09-17T22:10:00.000Z", recipient: "Samira M" };
    const recent = { ...shift, tasksCompleted: ["0_Medication Reminders", "1_bathing"], familyUpdateLastTextAt: new Date().toISOString(), familyUpdateQueue: [queuedCheck], familyUpdateQueuedAt: "2026-09-17T22:10:00.000Z" };
    const before = { ...recent, tasksCompleted: ["0_Personal Care", "0_Medication Reminders", "1_bathing"] };
    expect(await recordVisitProgress(ref, before, recent, send)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(hoisted.updates[0].data.familyUpdateQueue).toEqual({ __delete: true });
    expect(hoisted.updates[0].data.familyUpdateQueuedAt).toEqual({ __delete: true });
  });

  it("an uncheck after the family was already told is told too", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    const after = { ...shift, tasksCompleted: ["0_Medication Reminders", "1_bathing"] }; // no recent text → goes at once
    expect(await recordVisitProgress(ref, shift, after, send)).toBe(true);
    expect(send).toHaveBeenCalledWith("c1", "Basra unchecked Personal Care for Samira — not done after all.");
  });

  it("ignores writes with no task or note change (e.g. the queue write itself)", async () => {
    const send = vi.fn(async () => undefined);
    const ref = hoisted.makeDoc("shifts/s1");
    expect(await recordVisitProgress(ref, shift, { ...shift, familyUpdateQueuedAt: "x" }, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(hoisted.updates).toHaveLength(0);
  });
});

describe("buildVisitCompletionText — the Past Booking card in words", () => {
  it("lists tasks done / not done per recipient, the count, the visit log, the closing note, and what happens next", () => {
    const t = buildVisitCompletionText(shift);
    expect(t).toContain("Basra Yousuf's visit on Thursday, September 17, 2026 is complete (7:05 PM–7:06 PM, 0:00:46).");
    expect(t).toContain("Samira M: Personal Care, Medication Reminders ✓ · Breakfast (Meal Preparation) not done");
    expect(t).toContain("Imran Mohammed: bathing ✓ · Mobility Assistance not done");
    expect(t).toContain("3 of 5 tasks checked off.");
    // Sections separated by blank lines; the log bulleted without clock times;
    // the closing note under the Past Bookings card's "Caregiver note" label.
    expect(t).toContain("3 of 5 tasks checked off.\n\nVisit notes\n· Samira ate half her breakfast\n\nCaregiver note\njust ended the shift for testing purpose\n\nBasra will submit");
    expect(t).not.toContain("7:06 PM — ");
    expect(t).toMatch(/is complete \(7:05 PM–7:06 PM, 0:00:46\)\.\n\nSamira M:/);
    expect(t).toContain("Basra will submit the hours next; you'll get them here to review.");
    expect(t).not.toContain("care journal");
  });

  it("degrades for a visit with no recipient task list and no notes", () => {
    const t = buildVisitCompletionText({ caregiverName: "Imran", careNeeds: ["Companionship"], tasksCompleted: [] });
    expect(t).toContain("Imran's visit is complete.");
    expect(t).toContain("Tasks: nothing checked off · Companionship not done");
    expect(t).not.toContain("Visit notes");
  });

  it("fmtDuration is the card's h:mm:ss", () => {
    expect(fmtDuration(1.5)).toBe("1:30:00");
  });
});
