import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// decision/parse functions — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { shouldNudgePendingTimesheets, toMillis, MIN_AGE_MS, COOLDOWN_MS } from "../pendingTimesheetNudge";

// Reminds families to approve caregiver hours (caregivers aren't paid until they
// do). Guards: don't fire before the family's had a day, and never nag more than
// once per COOLDOWN_MS.

const NOW = 1_000_000_000_000;

describe("shouldNudgePendingTimesheets", () => {
  it("does not fire with no pending timesheets", () => {
    expect(shouldNudgePendingTimesheets({ count: 0, oldestSubmittedMs: NOW - MIN_AGE_MS - 1, lastNudgedMs: null, nowMs: NOW })).toBe(false);
  });

  it("waits out the freshness window before the first reminder", () => {
    expect(shouldNudgePendingTimesheets({ count: 1, oldestSubmittedMs: NOW - (MIN_AGE_MS - 1), lastNudgedMs: null, nowMs: NOW })).toBe(false);
  });

  it("fires once the oldest timesheet is past the freshness window", () => {
    expect(shouldNudgePendingTimesheets({ count: 1, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: null, nowMs: NOW })).toBe(true);
  });

  it("respects the cooldown", () => {
    expect(shouldNudgePendingTimesheets({ count: 2, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: NOW - (COOLDOWN_MS - 1), nowMs: NOW })).toBe(false);
  });

  it("fires again after the cooldown elapses", () => {
    expect(shouldNudgePendingTimesheets({ count: 2, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: NOW - (COOLDOWN_MS + 1), nowMs: NOW })).toBe(true);
  });
});

describe("toMillis", () => {
  it("parses ISO strings", () => {
    expect(toMillis("2026-06-23T00:00:00.000Z")).toBe(Date.parse("2026-06-23T00:00:00.000Z"));
  });
  it("passes through epoch ms numbers", () => {
    expect(toMillis(1234567890)).toBe(1234567890);
  });
  it("reads Firestore Timestamp via toMillis() and seconds", () => {
    expect(toMillis({ toMillis: () => 5000 })).toBe(5000);
    expect(toMillis({ seconds: 5 })).toBe(5000);
    expect(toMillis({ _seconds: 7 })).toBe(7000);
  });
  it("returns null for missing or unparseable values", () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis("not a date")).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});
