import { describe, it, expect, vi } from "vitest";
vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({}) }, firestore: Object.assign(() => ({}), { FieldValue: {} }) }));
import { fmtDay } from "./reviewShiftHours";

describe("fmtDay — the visit's own day, in the visit's own zone", () => {
  // 02:30 UTC on Sep 19 is still Sep 18 evening on the US west coast and Sep 18 10:30 PM in New York.
  const iso = "2026-09-19T02:30:00.000Z";
  it("defaults to Pacific, as before", () => {
    expect(fmtDay(iso)).toBe("Sep 18");
  });
  it("uses the zone it is given — a Hawaii or Eastern visit names its own day", () => {
    expect(fmtDay(iso, "America/New_York")).toBe("Sep 18");
    expect(fmtDay("2026-09-19T05:00:00.000Z", "America/New_York")).toBe("Sep 19");
    expect(fmtDay("2026-09-19T05:00:00.000Z")).toBe("Sep 18");
    expect(fmtDay("2026-09-19T05:00:00.000Z", "Pacific/Honolulu")).toBe("Sep 18");
  });
  it("is empty for anything that isn't a date", () => {
    expect(fmtDay(undefined)).toBe("");
    expect(fmtDay("nope")).toBe("");
  });
});
