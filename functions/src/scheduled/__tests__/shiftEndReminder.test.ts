import { describe, it, expect, vi, beforeEach } from "vitest";

// "Did you forget to finish?" (shiftEndReminder.ts): one text + bell 15 minutes
// after a visit's scheduled end — still in progress → FINISH; never started → LOG.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  bells: [] as any[],
  sends: [] as any[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, op, v]) =>
            op === "in" ? (v as any[]).includes(d[f]) : op === ">=" ? String(d[f]) >= String(v) : op === "<=" ? String(d[f]) <= String(v) : d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d, ref: { update: async (x: any) => { hoisted.updates.push({ path: p, data: x }); hoisted.docs.set(p, { ...hoisted.docs.get(p), ...x }); } } }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, op: string, v: any) => q([[f, op, v]]),
        doc: (id: string) => ({ get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })) }),
      };
    },
  }), { FieldValue: { serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) } }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); return true; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }) }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async (id: string) => (id === "cg1" ? "+1408" : undefined)) }));
vi.mock("../../agents/inShift", () => ({ visitPageLink: (id: string) => `https://eviacares.com/caregiver/bookings?tab=active&visit=${id}` }));

import { runShiftEndReminders, scheduledEndMs, shouldRemind, GRACE_MS, MAX_AGE_MS } from "../shiftEndReminder";

// 2099-02-10 is PST (UTC-8, no DST). A visit 19:30–19:45 Pacific ends 2099-02-11T03:45:00Z.
const END = Date.parse("2099-02-11T03:45:00.000Z");
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientName: "Basra Yousuf", careRecipients: [{ name: "H M" }], date: "2099-02-10", startTime: "19:30", endTime: "19:45", ...over });

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.bells.length = 0; hoisted.sends.length = 0; hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); });

describe("the decision", () => {
  it("scheduled end honours a visit that crosses midnight; remind only 15 min after the end and within a day", () => {
    expect(scheduledEndMs({ date: "2099-02-10", startTime: "19:30", endTime: "19:45" })).toBe(END);
    expect(scheduledEndMs({ date: "2099-02-10", startTime: "22:00", endTime: "02:00" })).toBe(Date.parse("2099-02-11T10:00:00.000Z"));
    expect(scheduledEndMs({ date: "", startTime: "19:30", endTime: "19:45" })).toBeNull();
    expect(shouldRemind(END, END + GRACE_MS - 1000, false)).toBe(false);
    expect(shouldRemind(END, END + GRACE_MS, false)).toBe(true);
    expect(shouldRemind(END, END + MAX_AGE_MS + 1000, false)).toBe(false);
    expect(shouldRemind(END, END + GRACE_MS, true)).toBe(false);
    expect(shouldRemind(null, END + GRACE_MS, false)).toBe(false);
  });
});

describe("the run", () => {
  it("still in progress → FINISH text + bell, once; never started → LOG text + bell, once; finished visits untouched", async () => {
    shift("running", { status: "in-progress", startedAt: "x" });
    shift("missed", { status: "scheduled" });
    shift("done", { status: "completed" });
    shift("notYet", { status: "in-progress", endTime: "23:00" });
    const now = END + GRACE_MS + 60_000;
    expect(await runShiftEndReminders(now)).toEqual({ running: 1, missed: 1, skipped: 1 });
    expect(hoisted.sends.map((s) => s.out.content)).toEqual([
      "H M's visit was scheduled to end at 7:45 PM and is still in progress. Text FINISH when you're done, or open it here: https://eviacares.com/caregiver/bookings?tab=active&visit=running",
      "Your 7:30 PM visit with Basra Yousuf wasn't started. If you did the visit, reply LOG to log the hours. If not, no action needed.",
    ]);
    expect(hoisted.sends.every((s) => s.out.canDrop === false)).toBe(true);
    expect(hoisted.bells.map((b) => [b.type, b.recipientId, b.sourcePath, b.data.shiftId])).toEqual([
      ["shift_end_reminder", "cg1", "shifts/running", "running"], ["shift_missed", "cg1", "shifts/missed", "missed"],
    ]);
    expect(hoisted.bells[0].body).toBe("H M's visit was scheduled to end at 7:45 PM and is still in progress. Finish it from your Bookings page.");
    expect(hoisted.updates.map((u) => [u.path, Object.keys(u.data)[0]])).toEqual([["shifts/running", "caraEndReminderSentAt"], ["shifts/missed", "caraMissedReminderSentAt"]]);
    // A second sweep sends nothing.
    hoisted.sends.length = 0; hoisted.bells.length = 0;
    expect(await runShiftEndReminders(now + 15 * 60_000)).toEqual({ running: 0, missed: 0, skipped: 3 });
    expect(hoisted.sends).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(0);
  });

  it("an opted-out caregiver gets the bell only; a visit whose end passed more than a day ago is left alone", async () => {
    hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1", optedOut: true });
    shift("running", { status: "in-progress" });
    shift("old", { status: "in-progress", date: "2099-02-01" });
    const r = await runShiftEndReminders(END + GRACE_MS);
    expect(r).toEqual({ running: 1, missed: 0, skipped: 1 });
    expect(hoisted.sends).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(1);
    expect(hoisted.updates.map((u) => u.path)).toEqual(["shifts/running"]);
  });
});
