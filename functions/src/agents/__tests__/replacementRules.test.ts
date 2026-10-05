import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} }) }, firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} }) }));
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn() }));

import { visitsOverlap, weekdayOf, stretchNote, RADIUS_STRETCH_MILES } from "../shiftReplacement";

// Shift replacement (founder, 2026-10-04): a caregiver already in another visit
// at that hour is never offered the shift; profile availability ranks, it never excludes.
describe("visitsOverlap", () => {
  it("overlapping windows, touching windows, and open-ended visits", () => {
    expect(visitsOverlap("09:00", "12:00", "11:00", "14:00")).toBe(true);
    expect(visitsOverlap("09:00", "12:00", "12:00", "14:00")).toBe(false);
    expect(visitsOverlap("09:00", "12:00", "06:00", "09:00")).toBe(false);
    // no end time → read as one hour
    expect(visitsOverlap("09:00", "", "09:30", "")).toBe(true);
    expect(visitsOverlap("09:00", "", "10:00", "")).toBe(false);
    expect(visitsOverlap("", "", "10:00", "11:00")).toBe(false);
  });
});

describe("weekdayOf", () => {
  it("names the local calendar day the way availabilityOverlap expects", () => {
    expect(weekdayOf("2026-10-05")).toBe("monday");
    expect(weekdayOf("2026-10-04")).toBe("sunday");
    expect(weekdayOf("")).toBeNull();
  });
});

describe("travel radius — a preference up to the stretch cap, then a wall", () => {
  it("the card says when she is beyond her own range; inside it says nothing", () => {
    expect(RADIUS_STRETCH_MILES).toBe(20);
    expect(stretchNote({})).toBe("");
    expect(stretchNote({ milesBeyondRadius: 0 })).toBe("");
    expect(stretchNote({ milesBeyondRadius: 0.6 })).toBe(" · about a mile outside her usual range");
    expect(stretchNote({ milesBeyondRadius: 3.4 })).toBe(" · about 3 miles outside her usual range");
  });
});
