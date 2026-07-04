import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: vi.fn() });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  default: { pubsub: { schedule: () => ({ onRun: (fn: unknown) => fn }) } },
  pubsub: { schedule: () => ({ onRun: (fn: unknown) => fn }) },
}));

import { inferQuietWindow, MIN_QUIET_RUN_HOURS } from "./inferActiveHours";

const histogram = (activeHours: number[]): number[] => {
  const h = new Array<number>(24).fill(0);
  for (const a of activeHours) h[a]++;
  return h;
};

describe("inferQuietWindow", () => {
  it("finds an overnight quiet window that wraps midnight", () => {
    // Active 8am–22pm; quiet 22:00–08:00 (10h, wraps midnight)
    const active = Array.from({ length: 14 }, (_, i) => i + 8); // 8..21
    const w = inferQuietWindow(histogram(active));
    expect(w).toEqual({ start: "22:00", end: "08:00" });
  });

  it("finds a daytime quiet window without wrapping", () => {
    // Active only 0..7 and 20..23 → quiet 08:00–20:00 (12h)
    const active = [0, 1, 2, 3, 4, 5, 6, 7, 20, 21, 22, 23];
    const w = inferQuietWindow(histogram(active));
    expect(w).toEqual({ start: "08:00", end: "20:00" });
  });

  it("returns null when the longest quiet run is under the minimum", () => {
    // Activity every 4th hour → max quiet run of 3h < MIN_QUIET_RUN_HOURS
    const active = [0, 4, 8, 12, 16, 20];
    expect(MIN_QUIET_RUN_HOURS).toBeGreaterThan(3);
    expect(inferQuietWindow(histogram(active))).toBeNull();
  });

  it("returns null for an all-quiet histogram (no signal, not a 24h window)", () => {
    expect(inferQuietWindow(new Array(24).fill(0))).toBeNull();
  });

  it("returns null for a malformed histogram", () => {
    expect(inferQuietWindow([])).toBeNull();
  });
});
