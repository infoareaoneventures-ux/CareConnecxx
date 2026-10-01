import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver's two Timesheets reminders (caregiverTimesheetReminders.ts):
// unsubmitted hours a day after the visit ended → SUBMIT; a family correction
// 3 hours before it auto-accepts → REVIEW. One text + bell each, once.

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

import {
  runCaregiverTimesheetReminders, shouldRemindUnsubmitted, correctionReminderDue, hoursLeftLabel,
  UNSUBMITTED_AFTER_MS, UNSUBMITTED_MAX_AGE_MS, CORRECTION_WARN_MS,
} from "../caregiverTimesheetReminders";

// 2099-02-10 is PST. A visit ended 2099-02-10 at 5:10 PM Pacific.
const ENDED = Date.parse("2099-02-11T01:10:00.000Z");
const NOW = ENDED + UNSUBMITTED_AFTER_MS + 60_000; // a day and a minute later
const shift = (id: string, over: Record<string, unknown> = {}) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientName: "Basra Yousuf", date: "2099-02-10", startTime: "14:00", endTime: "17:00", status: "completed", completedAt: new Date(ENDED).toISOString(), ...over });

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.bells.length = 0; hoisted.sends.length = 0; hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); });

describe("the decisions", () => {
  it("unsubmitted: a day after the end, within a week, once", () => {
    expect(shouldRemindUnsubmitted(ENDED, ENDED + UNSUBMITTED_AFTER_MS - 1000, false)).toBe(false);
    expect(shouldRemindUnsubmitted(ENDED, ENDED + UNSUBMITTED_AFTER_MS, false)).toBe(true);
    expect(shouldRemindUnsubmitted(ENDED, ENDED + UNSUBMITTED_MAX_AGE_MS + 1000, false)).toBe(false);
    expect(shouldRemindUnsubmitted(ENDED, NOW, true)).toBe(false);
    expect(shouldRemindUnsubmitted(null, NOW, false)).toBe(false);
  });
  it("correction: inside the last 3 hours before the auto-accept, once; hours left rounds up", () => {
    const by = NOW + 2 * 3_600_000;
    expect(correctionReminderDue(by, NOW, false)).toBe(true);
    expect(correctionReminderDue(NOW + CORRECTION_WARN_MS + 1000, NOW, false)).toBe(false);
    expect(correctionReminderDue(NOW - 1000, NOW, false)).toBe(false); // already auto-accepted — the job for that texts the outcome
    expect(correctionReminderDue(by, NOW, true)).toBe(false);
    expect(hoursLeftLabel(NOW + 2 * 3_600_000 + 1, NOW)).toBe("3 hours");
    expect(hoursLeftLabel(NOW + 30 * 60_000, NOW)).toBe("1 hour");
  });
});

describe("the run", () => {
  it("texts + bells an unsubmitted visit once, skips one that has hours, stamps the shift", async () => {
    shift("s1");
    shift("s2"); hoisted.docs.set("shiftHours/s2", { status: "pending_client_review" });
    shift("s3", { caraSubmitReminderSentAt: "x" });
    const r = await runCaregiverTimesheetReminders(NOW);
    expect(r.unsubmitted).toBe(1); expect(r.skipped).toBe(2);
    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.sends[0].out.content).toBe("Your Feb 10 visit with Basra Yousuf still has no hours submitted. Reply SUBMIT to submit them.");
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "shifts/s1", eventId: "submit-reminder", type: "shift_hours_unsubmitted", title: "Hours not submitted", body: "Your Feb 10 visit with Basra Yousuf still has no hours submitted. Submit them on your Timesheets page." });
    expect(hoisted.updates.find((u) => u.path === "shifts/s1")?.data.caraSubmitReminderSentAt).toBe(new Date(NOW).toISOString());
    // Second run: nothing new.
    const again = await runCaregiverTimesheetReminders(NOW + 3_600_000);
    expect(again.unsubmitted).toBe(0); expect(hoisted.sends).toHaveLength(1);
  });
  it("texts + bells a correction 3 hours before it auto-accepts, once; not earlier, not after", async () => {
    const by = new Date(NOW + 2 * 3_600_000 + 1).toISOString();
    hoisted.docs.set("shiftHours/a1", { caregiverId: "cg1", clientName: "Basra Yousuf", status: "correction_proposed", correctionRespondByAt: by, submittedStartTime: "2099-02-10T22:05:00.000Z" });
    hoisted.docs.set("shiftHours/a2", { caregiverId: "cg1", clientName: "B", status: "correction_proposed", correctionRespondByAt: new Date(NOW + 10 * 3_600_000).toISOString() });
    const r = await runCaregiverTimesheetReminders(NOW);
    expect(r.corrections).toBe(1);
    expect(hoisted.sends[0].out.content).toBe("Basra Yousuf's correction to your Feb 10 hours auto-accepts in 3 hours. Reply REVIEW to accept it or send a counter.");
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "shiftHours/a1", type: "shift_hours_correction_reminder", title: "Correction awaiting your answer", body: "Basra Yousuf's correction to your Feb 10 hours auto-accepts in 3 hours. Review it on your Timesheets page." });
    expect(hoisted.docs.get("shiftHours/a1").caraCorrectionReminderSentAt).toBe(new Date(NOW).toISOString());
    const again = await runCaregiverTimesheetReminders(NOW + 3_600_000);
    expect(again.corrections).toBe(0);
  });
  it("writes the bell but sends no text when the caregiver has no Evia session or opted out", async () => {
    shift("s1", { caregiverId: "cg2" });
    const r = await runCaregiverTimesheetReminders(NOW);
    expect(r.unsubmitted).toBe(1);
    expect(hoisted.bells).toHaveLength(1); expect(hoisted.sends).toHaveLength(0);
  });
});
