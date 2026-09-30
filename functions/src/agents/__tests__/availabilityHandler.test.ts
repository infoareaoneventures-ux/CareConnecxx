import { describe, it, expect, vi, beforeEach } from "vitest";

// The Update Availability modal as a flow (availabilityHandler.ts): days →
// blocks → the whole grid for confirmation → SAVE writes exactly the modal's field.

const hoisted = vi.hoisted(() => ({
  caregiver: {} as Record<string, unknown>,
  cgUpdates: [] as any[],
  sessionUpdates: [] as any[],
  sent: [] as string[],
  parse: vi.fn(async () => "ANSWER"),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: () => ({
        get: vi.fn(async () => ({ exists: true, data: () => (name === "caregivers" ? hoisted.caregiver : {}) })),
        update: vi.fn(async (d: any) => { (name === "caregivers" ? hoisted.cgUpdates : hoisted.sessionUpdates).push(d); }),
      }),
    }),
  }), { FieldValue: { delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: (...a: any[]) => (hoisted.parse as any)(...a) }));

import { handleAvailabilityUpdate, CONFIRM_LINE, WHICH_DAYS_Q } from "../availabilityHandler";

const send = async (m: string) => { hoisted.sent.push(m); };
beforeEach(() => { hoisted.caregiver = { weeklyAvailability: { monday: [{ start: "06:00", end: "12:00" }] } }; hoisted.cgUpdates.length = 0; hoisted.sessionUpdates.length = 0; hoisted.sent.length = 0; hoisted.parse.mockReset(); hoisted.parse.mockResolvedValue("ANSWER"); });

describe("start", () => {
  it("days + blocks in one message → straight to the grid confirmation", async () => {
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('{"action":"add","days":["tuesday","thursday"],"blocks":["afternoon"]}');
    await handleAvailabilityUpdate("cg1", "+1", "add Tuesday and Thursday afternoons", {}, send);
    expect(hoisted.sent.at(-1)).toBe(`Your availability would be:\nSun: —\nMon: Morning\nTue: Afternoon\nWed: —\nThu: Afternoon\nFri: —\nSat: —\n\n${CONFIRM_LINE}`);
    expect(hoisted.sessionUpdates.at(-1)).toMatchObject({ availabilityStep: "confirm" });
    expect(JSON.parse(hoisted.sessionUpdates.at(-1).pendingAvailability)).toEqual({ add: { tuesday: ["afternoon"], thursday: ["afternoon"] } }); // the taps, not the grid
  });
  it("days only → asks the modal's four blocks; remove → confirmation with the day cleared; nothing named → asks which day", async () => {
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('{"action":"replace","days":["monday"]}');
    await handleAvailabilityUpdate("cg1", "+1", "change my Monday", {}, send);
    expect(hoisted.sent.at(-1)).toMatch(/^Which time blocks are you available on Monday — Morning \(6am – 12pm\), Afternoon \(12pm – 6pm\), Evening \(6pm – 12am\), Overnight \(12am – 6am\)\? Reply the names, ALL, or NONE to clear that day\.$/);
    expect(hoisted.sessionUpdates.at(-1)).toMatchObject({ availabilityStep: "awaiting_blocks", pendingDays: '["monday"]', pendingAction: "replace" });
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('{"action":"remove","days":["monday"]}');
    await handleAvailabilityUpdate("cg1", "+1", "take Mondays off", {}, send);
    expect(hoisted.sent.at(-1)).toMatch(/^Your availability would be:\nSun: —\nMon: —\n/);
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('{"action":"unclear","days":[]}');
    await handleAvailabilityUpdate("cg1", "+1", "update my availability", {}, send);
    expect(hoisted.sent.at(-1)).toBe(WHICH_DAYS_Q);
  });
  it("a change that matches what is already set is said, not re-asked", async () => {
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('{"action":"replace","days":["monday"],"blocks":["morning"]}');
    await handleAvailabilityUpdate("cg1", "+1", "Monday mornings", {}, send);
    expect(hoisted.sent.at(-1)).toMatch(/^That's already how your availability is set:/);
    expect(hoisted.sessionUpdates.at(-1)).toMatchObject({ availabilityStep: "__delete__" });
  });
});

describe("blocks → confirm → SAVE", () => {
  const session = { availabilityStep: "awaiting_blocks", pendingDays: '["monday","wednesday"]', pendingAction: "replace" };
  it("ALL / NONE are fixed words; a spoken answer is parsed; SAVE writes only weeklyAvailability, the whole map", async () => {
    await handleAvailabilityUpdate("cg1", "+1", "all", session, send);
    expect(hoisted.sent.at(-1)).toContain("Mon: Morning, Afternoon, Evening, Overnight\nTue: —\nWed: Morning, Afternoon, Evening, Overnight");
    hoisted.parse.mockResolvedValueOnce("ANSWER").mockResolvedValueOnce('["morning","evening"]');
    await handleAvailabilityUpdate("cg1", "+1", "mornings and evenings", session, send);
    expect(hoisted.sent.at(-1)).toContain("Mon: Morning, Evening\nTue: —\nWed: Morning, Evening");
    const proposed = hoisted.sessionUpdates.at(-1).pendingAvailability;
    // Goal 4: the site added Friday mornings while the caregiver was texting — SAVE keeps it and applies only the taps.
    hoisted.caregiver = { weeklyAvailability: { monday: [{ start: "06:00", end: "12:00" }], friday: [{ start: "06:00", end: "12:00" }] } };
    await handleAvailabilityUpdate("cg1", "+1", "save", { availabilityStep: "confirm", pendingAvailability: proposed }, send);
    expect(hoisted.cgUpdates).toEqual([{ weeklyAvailability: {
      sunday: [], monday: [{ start: "06:00", end: "12:00" }, { start: "18:00", end: "23:00" }], tuesday: [], wednesday: [{ start: "06:00", end: "12:00" }, { start: "18:00", end: "23:00" }], thursday: [], friday: [{ start: "06:00", end: "12:00" }], saturday: [],
    } }]);
    expect(hoisted.sent.at(-1)).toMatch(/^Saved\. Your availability:\n/);
  });
  it("CANCEL at either step leaves the record alone; a question re-shows the grid", async () => {
    await handleAvailabilityUpdate("cg1", "+1", "cancel", session, send);
    expect(hoisted.sent.at(-1)).toBe("Okay — your availability wasn't changed.");
    hoisted.parse.mockResolvedValueOnce("OTHER");
    await handleAvailabilityUpdate("cg1", "+1", "does this affect my bookings?", { availabilityStep: "confirm", pendingAvailability: JSON.stringify({ set: { monday: ["morning"] } }) }, send);
    expect(hoisted.sent.at(-1)).toMatch(/^Your availability would be:\nSun: —\nMon: Morning/);
    expect(hoisted.cgUpdates).toHaveLength(0);
  });
});
