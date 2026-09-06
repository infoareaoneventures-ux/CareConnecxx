import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// decision function — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { shouldNudgeInterviewCompletion, NUDGE_DELAY_MS, MAX_NUDGES, RENUDGE_COOLDOWN_MS } from "../interviewCompletionNudge";

// Asks the family whether a scheduled interview happened once its time has
// passed and it's still "accepted" (never marked completed). Guards: only
// "accepted" interviews, wait NUDGE_DELAY_MS past scheduledTime, cap total
// sends at MAX_NUDGES, space repeats by RENUDGE_COOLDOWN_MS.

const NOW = 1_000_000_000_000;

describe("shouldNudgeInterviewCompletion", () => {
  it("does not fire for a non-accepted status", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "requested", scheduledMs: NOW - NUDGE_DELAY_MS - 1, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewCompletion({
      status: "completed", scheduledMs: NOW - NUDGE_DELAY_MS - 1, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not fire before the scheduled time has passed by NUDGE_DELAY_MS", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS - 1), nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("fires once the delay has elapsed on an accepted interview", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("does not fire with no parseable scheduledTime", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: null, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("respects the repeat cooldown", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 1,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS - 1), nowMs: NOW,
    })).toBe(false);
  });

  it("fires the repeat once the cooldown elapses", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 1,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  it("never sends more than MAX_NUDGES total", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: MAX_NUDGES,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(false);
  });
});
