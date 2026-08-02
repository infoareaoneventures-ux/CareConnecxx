// U14 (childcare marketplace plan 2026-07-22-002): amended-R2 interim backfill
// trigger — dark by default, stamps senior ONLY when the vertical is absent,
// never overwrites, never infers "child".

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  shouldInterimBackfillSenior,
  isInterimBackfillEnabled,
  INTERIM_BACKFILL_COLLECTIONS,
} from "./careVerticalBackfillTrigger";

describe("careVerticalBackfillTrigger (U14, amended R2)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("covers exactly the four browser-writable shared collections", () => {
    expect([...INTERIM_BACKFILL_COLLECTIONS]).toEqual(["appointments", "chatRooms", "reviews", "booking_requests"]);
  });

  it("is DARK by default (off unless the env flag is exactly 'true')", () => {
    delete process.env.CARE_VERTICAL_INTERIM_BACKFILL_ENABLED;
    expect(isInterimBackfillEnabled()).toBe(false);
    process.env.CARE_VERTICAL_INTERIM_BACKFILL_ENABLED = "1";
    expect(isInterimBackfillEnabled()).toBe(false);
    process.env.CARE_VERTICAL_INTERIM_BACKFILL_ENABLED = "true";
    expect(isInterimBackfillEnabled()).toBe(true);
  });

  it("stamps senior ONLY when careVertical is absent", () => {
    expect(shouldInterimBackfillSenior({})).toBe(true);
    expect(shouldInterimBackfillSenior({ careVertical: undefined })).toBe(true);
    expect(shouldInterimBackfillSenior({ careVertical: null })).toBe(true);
  });

  it("never overwrites an existing vertical and never infers child", () => {
    expect(shouldInterimBackfillSenior({ careVertical: "senior" })).toBe(false);
    expect(shouldInterimBackfillSenior({ careVertical: "child" })).toBe(false);
    // Even child-looking content does not flip an absent vertical to child —
    // the helper only ever authorizes a "senior" stamp.
    expect(shouldInterimBackfillSenior({ childName: "Max", ageBand: "3-5" })).toBe(true);
  });

  it("returns false for null/undefined data", () => {
    expect(shouldInterimBackfillSenior(null)).toBe(false);
    expect(shouldInterimBackfillSenior(undefined)).toBe(false);
  });
});
