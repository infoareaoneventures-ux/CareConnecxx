import { describe, it, expect } from "vitest";
import { shouldRemindInterview, MIN_AGE_MS } from "../interviewResponseReminder";

// One pre-expiry reminder for a caregiver who hasn't responded to an interview
// request. Guards: give them time first, never double-remind, never remind after
// the request has expired.

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("shouldRemindInterview", () => {
  it("reminds once the request has aged past the grace window and isn't expired", () => {
    expect(shouldRemindInterview({
      createdMs: NOW - (MIN_AGE_MS + 1), expiresMs: NOW + DAY, alreadyReminded: false, nowMs: NOW,
    })).toBe(true);
  });

  it("does not remind during the grace window", () => {
    expect(shouldRemindInterview({
      createdMs: NOW - (MIN_AGE_MS - 1), expiresMs: NOW + DAY, alreadyReminded: false, nowMs: NOW,
    })).toBe(false);
  });

  it("never sends a second reminder", () => {
    expect(shouldRemindInterview({
      createdMs: NOW - (MIN_AGE_MS + 1), expiresMs: NOW + DAY, alreadyReminded: true, nowMs: NOW,
    })).toBe(false);
  });

  it("does not remind after the request has expired (expiry job owns it)", () => {
    expect(shouldRemindInterview({
      createdMs: NOW - (MIN_AGE_MS + 1), expiresMs: NOW - 1, alreadyReminded: false, nowMs: NOW,
    })).toBe(false);
  });

  it("does not remind when creation time is unknown", () => {
    expect(shouldRemindInterview({
      createdMs: null, expiresMs: NOW + DAY, alreadyReminded: false, nowMs: NOW,
    })).toBe(false);
  });

  it("reminds when there's no expiry set, as long as it's past the grace window", () => {
    expect(shouldRemindInterview({
      createdMs: NOW - (MIN_AGE_MS + 1), expiresMs: null, alreadyReminded: false, nowMs: NOW,
    })).toBe(true);
  });
});
