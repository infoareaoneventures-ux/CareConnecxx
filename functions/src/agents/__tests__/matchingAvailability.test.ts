import { describe, it, expect } from "vitest";
import { isTemporarilyUnavailable } from "../matchingAgent";

// U7 — paused / opted-out caregivers must not be presented as available. The
// SMS match flow matches on weekly pattern (not specific dates), so this is the
// real availability gate at presentation time; date conflicts resolve later.

const NOW = "2026-06-22T12:00:00.000Z";

describe("isTemporarilyUnavailable (U7)", () => {
  it("treats a caregiver on a future pause as unavailable", () => {
    expect(isTemporarilyUnavailable({ pausedUntil: "2026-07-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("treats an expired pause as available again", () => {
    expect(isTemporarilyUnavailable({ pausedUntil: "2026-06-01T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("treats an opted-out caregiver as unavailable regardless of pause", () => {
    expect(isTemporarilyUnavailable({ optedOut: true }, NOW)).toBe(true);
  });

  it("treats a normal active caregiver as available", () => {
    expect(isTemporarilyUnavailable({}, NOW)).toBe(false);
    expect(isTemporarilyUnavailable({ optedOut: false }, NOW)).toBe(false);
  });

  it("treats a pause ending exactly now as no longer paused", () => {
    expect(isTemporarilyUnavailable({ pausedUntil: NOW }, NOW)).toBe(false);
  });
});
