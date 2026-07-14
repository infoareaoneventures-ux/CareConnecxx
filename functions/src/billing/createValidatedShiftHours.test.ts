import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({});
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import { bookedWindowMillis } from "./createValidatedShiftHours";

describe("bookedWindowMillis", () => {
  it("resolves same-day appointment windows", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", startTime: "09:00", endTime: "13:00" });
    expect(result).not.toBeNull();
    expect((result!.end - result!.start) / 3_600_000).toBe(4);
  });

  it("resolves overnight appointment windows", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", startTime: "22:00", endTime: "06:00" });
    expect(result).not.toBeNull();
    expect((result!.end - result!.start) / 3_600_000).toBe(8);
  });

  it("uses duration when no end time is present and rejects incomplete records", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", time: "09:00", durationHours: 3 });
    expect((result!.end - result!.start) / 3_600_000).toBe(3);
    expect(bookedWindowMillis({ date: "2026-07-12" })).toBeNull();
  });
});
