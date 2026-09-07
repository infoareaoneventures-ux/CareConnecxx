import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// decision function — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { shouldNudgeInterviewFeedback, NUDGE_DELAY_MS, MAX_NUDGES, RENUDGE_COOLDOWN_MS } from "../interviewFeedbackNudge";

// Sibling of interviewCompletionNudge.test.ts. Asks the family for a fit
// decision once an interview has sat "completed" with no feedbackSubmitted
// for NUDGE_DELAY_MS — the safety net for complete_interview's "MANDATORY"
// same-reply ask being a prompt-level instruction with no runtime enforcement.

const NOW = 1_000_000_000_000;

describe("shouldNudgeInterviewFeedback", () => {
  it("does not fire for a non-completed status", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "accepted", feedbackSubmitted: false, completedMs: NOW - NUDGE_DELAY_MS - 1, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewFeedback({
      status: "declined", feedbackSubmitted: false, completedMs: NOW - NUDGE_DELAY_MS - 1, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not fire once feedback has already been submitted", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: true, completedMs: NOW - NUDGE_DELAY_MS - 1, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not fire before completedAt has passed by NUDGE_DELAY_MS", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: NOW - (NUDGE_DELAY_MS - 1), nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("fires once the delay has elapsed on a completed, undecided interview", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("does not fire with no parseable completedAt", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: null, nudgeCount: 0, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("respects the repeat cooldown", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 1,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS - 1), nowMs: NOW,
    })).toBe(false);
  });

  it("fires the repeat once the cooldown elapses", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: 1,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  it("never sends more than MAX_NUDGES total", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", feedbackSubmitted: false, completedMs: NOW - (NUDGE_DELAY_MS + 1), nudgeCount: MAX_NUDGES,
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(false);
  });
});
