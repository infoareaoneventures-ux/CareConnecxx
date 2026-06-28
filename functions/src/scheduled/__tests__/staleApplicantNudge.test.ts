import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// decision function — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { shouldNudgeStaleApplicants, MIN_AGE_MS, COOLDOWN_MS } from "../staleApplicantNudge";

// The stale-applicant nudge follows up with families who haven't reviewed
// caregivers waiting on their job post. These guard the two boundaries that keep
// it from being annoying: don't fire before the initial alert had its window
// (MIN_AGE_MS), and never nag more than once per COOLDOWN_MS.

const NOW = 1_000_000_000_000; // fixed clock for deterministic tests

describe("shouldNudgeStaleApplicants", () => {
  it("does not nudge when there are no pending applicants", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 0, oldestPendingMs: NOW - MIN_AGE_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not nudge while the applicant is still fresh (initial alert owns that window)", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: NOW - (MIN_AGE_MS - 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("nudges once the oldest pending applicant is past the freshness window", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("respects the cooldown — no second nudge within COOLDOWN_MS", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 3,
      oldestPendingMs: NOW - (MIN_AGE_MS + 1),
      lastNudgedMs: NOW - (COOLDOWN_MS - 1),
      nowMs: NOW,
    })).toBe(false);
  });

  it("nudges again once the cooldown has elapsed", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 3,
      oldestPendingMs: NOW - (MIN_AGE_MS + 1),
      lastNudgedMs: NOW - (COOLDOWN_MS + 1),
      nowMs: NOW,
    })).toBe(true);
  });

  it("does not nudge when the oldest-pending timestamp is unknown", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: null, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });
});
