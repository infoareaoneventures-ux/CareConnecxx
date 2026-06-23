import { describe, it, expect } from "vitest";
import { shouldNudgeFirstVisit, MIN_ACCOUNT_AGE_MS, MAX_ACCOUNT_AGE_MS } from "../firstVisitActivation";

// One-time "book your first visit" nudge for families who finished onboarding
// but never booked. Guards: must be onboarded, must not have booked, only once,
// and only inside the activation window (a few days to a month old).

const base = {
  onboardingComplete: true,
  hasBooked: false,
  alreadyNudged: false,
  accountAgeMs: MIN_ACCOUNT_AGE_MS + 1,
};

describe("shouldNudgeFirstVisit", () => {
  it("nudges an onboarded, never-booked family inside the activation window", () => {
    expect(shouldNudgeFirstVisit(base)).toBe(true);
  });

  it("skips families who haven't completed onboarding", () => {
    expect(shouldNudgeFirstVisit({ ...base, onboardingComplete: false })).toBe(false);
  });

  it("skips families who have already booked", () => {
    expect(shouldNudgeFirstVisit({ ...base, hasBooked: true })).toBe(false);
  });

  it("never nudges twice", () => {
    expect(shouldNudgeFirstVisit({ ...base, alreadyNudged: true })).toBe(false);
  });

  it("waits out the grace window", () => {
    expect(shouldNudgeFirstVisit({ ...base, accountAgeMs: MIN_ACCOUNT_AGE_MS - 1 })).toBe(false);
  });

  it("does not cold-nudge accounts past the activation window", () => {
    expect(shouldNudgeFirstVisit({ ...base, accountAgeMs: MAX_ACCOUNT_AGE_MS + 1 })).toBe(false);
  });

  it("skips when account age is unknown", () => {
    expect(shouldNudgeFirstVisit({ ...base, accountAgeMs: null })).toBe(false);
  });
});
