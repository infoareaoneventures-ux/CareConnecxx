import { describe, it, expect, vi, beforeEach } from "vitest";

// Founders 2026-11-25: "if a visit starts at 9, remind them at 9:01 if they forgot to clock in".
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const visits: any[] = [];
  const sends: any[] = [];
  const bells: any[] = [];
  const updates: any[] = [];
  return { docs, visits, sends, bells, updates, reset: () => { docs.clear(); visits.length = 0; sends.length = 0; bells.length = 0; updates.length = 0; } };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: (name: string) => ({ doc: (id: string) => ({ get: async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) }) }) }) }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) } }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); return true; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }) }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: async () => "+1408" }));
vi.mock("../../utils/visitQuery", () => ({
  queryVisits: vi.fn(async () => hoisted.visits.map((v) => ({ id: v.id, data: () => v, ref: { update: async (d: any) => hoisted.updates.push({ id: v.id, d }) } }))),
  visitSeniorName: (v: any, fb: string) => v.careRecipients?.[0]?.name ?? fb,
}));
vi.mock("../../agents/inShift", () => ({ visitPageLink: (id: string) => `https://eviacares.com/care-provider/bookings?visit=${id}` }));

import { runMissedClockInReminders, shouldRemindClockIn, scheduledStartMs } from "../missedClockInReminder";

const START = Date.parse("2099-02-10T17:00:00.000Z"); // 9:00 AM Pacific
const visit = (over: Record<string, unknown> = {}) => ({ id: "v1", caregiverId: "cg1", date: "2099-02-10", startTime: "09:00", endTime: "10:00", careRecipients: [{ name: "Henry" }], ...over });

beforeEach(() => { hoisted.reset(); hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); });

describe("missed clock-in reminder", () => {
  it("reads the start in the visit's own zone", () => {
    expect(scheduledStartMs({ date: "2099-02-10", startTime: "09:00" })).toBe(START);
    expect(scheduledStartMs({ date: "2099-02-10", startTime: "09:00", careTimeZone: "America/New_York" })).toBe(Date.parse("2099-02-10T14:00:00.000Z"));
  });
  it("is due from one minute after the start for an hour, once", () => {
    expect(shouldRemindClockIn(START, START + 30_000, false)).toBe(false);
    expect(shouldRemindClockIn(START, START + 60_000, false)).toBe(true);
    expect(shouldRemindClockIn(START, START + 61 * 60_000, false)).toBe(false);
    expect(shouldRemindClockIn(START, START + 5 * 60_000, true)).toBe(false);
    expect(shouldRemindClockIn(null, START + 5 * 60_000, false)).toBe(false);
  });
  it("texts a visit not started at 9:01, writes the bell in the page's words, and stamps it so it never repeats", async () => {
    hoisted.visits.push(visit());
    const r = await runMissedClockInReminders(START + 60_000);
    expect(r.sent).toBe(1);
    expect(hoisted.sends[0].out).toMatchObject({ fixedString: true, canDrop: false, sourceAgent: "shift_clock_in_reminder" });
    expect(hoisted.sends[0].out.content).toContain("Henry's visit was set to start at 9:00 AM and I haven't seen you clock in.");
    expect(hoisted.bells[0].body).toBe("Henry's visit was set to start at 9:00 AM and hasn't been started. Start it from your Bookings page.");
    expect(hoisted.updates[0].d.caraClockInReminderSentAt).toBeTruthy();
  });
  it("says nothing at 8:59 or for a visit already reminded", async () => {
    hoisted.visits.push(visit());
    expect((await runMissedClockInReminders(START - 60_000)).sent).toBe(0);
    hoisted.reset(); hoisted.docs.set("agent_sessions/+1408", {});
    hoisted.visits.push(visit({ caraClockInReminderSentAt: "x" }));
    expect((await runMissedClockInReminders(START + 120_000)).sent).toBe(0);
  });
});
