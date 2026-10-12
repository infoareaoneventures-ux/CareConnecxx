import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C11 (2026-10-11): the 30-minute and day-before visit reminders
// had no bell. They are fixed strings (C12) and write their bell — in the page's
// words, no text keywords — only when the text actually went.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const visits: any[] = [];
  const sends: any[] = [];
  const bells: any[] = [];
  const updates: any[] = [];
  return { docs, visits, sends, bells, updates, sendResult: { value: true as boolean }, reset: () => { docs.clear(); visits.length = 0; sends.length = 0; bells.length = 0; updates.length = 0; } };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: (name: string) => ({ doc: (id: string) => ({ get: async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) }) }) }) }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (fn: any) => fn, timeZone: () => ({ onRun: (fn: any) => fn }) }) } }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); return hoisted.sendResult.value; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }) }));
vi.mock("../../utils/visitQuery", () => ({
  queryVisits: vi.fn(async () => hoisted.visits.map((v) => ({ id: v.id, data: () => v, ref: { update: async (d: any) => hoisted.updates.push({ id: v.id, d }) } }))),
  visitSeniorName: (v: any, fb: string) => v.careRecipients?.[0]?.name ?? fb,
}));
vi.mock("../../agents/inShift", () => ({ visitPageLink: (id: string) => `https://eviacares.com/caregiver/bookings?tab=active&visit=${id}` }));
vi.mock("../../utils/scheduledTime", async (orig) => {
  const real = await (orig as any)();
  return { ...real, businessTodayStr: () => "2099-02-10", businessTomorrowStr: () => "2099-02-11" };
});

import { sendThirtyMinShiftReminders } from "../thirtyMinShiftReminder";
import { sendDayBeforeShiftReminders } from "../dayBeforeShiftReminder";

const seedCaregiver = () => { hoisted.docs.set("caregivers/cg1", { phone: "+1408" }); hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); };

beforeEach(() => { hoisted.reset(); hoisted.sendResult.value = true; seedCaregiver(); });

describe("the 30-minute reminder", () => {
  // The job compares the visit's wall-clock start (on the business "today") to now + 25..40 min;
  // with today pinned to 2099-02-10 the window is reached by the fake clock below.
  const START = Date.parse("2099-02-10T17:00:00.000Z"); // 09:00 Pacific (PST)
  it("fixed string → text, then a bell in the page's words (no START / LATE keywords), only when the text went", async () => {
    vi.useFakeTimers({ now: START - 30 * 60_000 });
    try {
      hoisted.visits.push({ id: "v1", caregiverId: "cg1", startTime: "09:00", endTime: "12:00", address: "12 Elm St", careRecipients: [{ name: "H M" }] });
      await (sendThirtyMinShiftReminders as any)();
      expect(hoisted.sends).toHaveLength(1);
      expect(hoisted.sends[0].out).toMatchObject({ fixedString: true, canDrop: false, sourceAgent: "thirty_min_shift_reminder" });
      expect(hoisted.sends[0].out.content).toContain("Text START when your shift starts.");
      expect(hoisted.bells).toHaveLength(1);
      expect(hoisted.bells[0]).toMatchObject({ sourcePath: "shifts/v1", eventId: "thirty-min-reminder", recipientId: "cg1", type: "shift_starting_soon", title: "Visit starting soon", data: { shiftId: "v1" } });
      expect(hoisted.bells[0].body).toBe("H M's visit starts at 9:00 AM – 12:00 PM at 12 Elm St. Start it from your Bookings page.");
      expect(hoisted.updates[0]).toEqual({ id: "v1", d: { caraThirtyMinReminderSent: true } });

      // Dropped text → no bell, still stamped.
      hoisted.reset(); seedCaregiver();
      hoisted.sendResult.value = false;
      hoisted.visits.push({ id: "v2", caregiverId: "cg1", startTime: "09:00", careRecipients: [{ name: "H M" }] });
      await (sendThirtyMinShiftReminders as any)();
      expect(hoisted.sends).toHaveLength(1);
      expect(hoisted.bells).toHaveLength(0);
      expect(hoisted.updates[0]).toEqual({ id: "v2", d: { caraThirtyMinReminderSent: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the day-before reminder", () => {
  it("fixed string → text, then the same sentence as the bell, only when the text went", async () => {
    hoisted.visits.push({ id: "v3", caregiverId: "cg1", clientId: "fam1", startTime: "09:00", endTime: "12:00", address: "12 Elm St", careRecipients: [{ name: "H M" }] });
    await (sendDayBeforeShiftReminders as any)();
    expect(hoisted.sends[0].out).toMatchObject({ fixedString: true, canDrop: false, sourceAgent: "day_before_shift_reminder" });
    expect(hoisted.sends[0].out.content).toBe("Reminder: H M's visit tomorrow, Wednesday, February 11, 9:00 AM – 12:00 PM at 12 Elm St.");
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "shifts/v3", eventId: "day-before-reminder", recipientId: "cg1", type: "shift_tomorrow", title: "Visit tomorrow", body: hoisted.sends[0].out.content, data: { shiftId: "v3" } });
    expect(hoisted.updates[0]).toEqual({ id: "v3", d: { dayBeforeConfirmSent: true } });
    hoisted.sends.length = 0; hoisted.bells.length = 0; hoisted.visits.length = 0;
    hoisted.sendResult.value = false;
    hoisted.visits.push({ id: "v4", caregiverId: "cg1", clientId: "fam1", startTime: "09:00", careRecipients: [{ name: "H M" }] });
    await (sendDayBeforeShiftReminders as any)();
    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.bells).toHaveLength(0);
  });
});
