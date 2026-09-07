import { describe, it, expect, vi, beforeEach } from "vitest";

// Sibling of interviewCompletionNudge.test.ts. Asks the family for a fit
// decision once an interview has sat "completed" with no feedbackSubmitted
// for NUDGE_DELAY_MS — the safety net for complete_interview's "MANDATORY"
// same-reply ask being a prompt-level instruction with no runtime enforcement.

const store = {
  interviews: new Map<string, any>(),
  sessions:   new Map<string, any>(),
  updates:    [] as Array<{ id: string; data: any }>,
};

function makeQueryCollection(map: Map<string, any>, withRef: boolean) {
  return {
    where: (field: string, _op: string, value: any) => ({
      limit: (_n: number) => ({
        get: async () => {
          const matches = [...map.entries()].filter(([, data]) => data[field] === value);
          return {
            empty: matches.length === 0,
            docs: matches.map(([id, data]) => ({
              id,
              data: () => data,
              ...(withRef ? { ref: { update: vi.fn(async (upd: any) => { store.updates.push({ id, data: upd }); }) } } : {}),
            })),
          };
        },
      }),
    }),
  };
}

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "video_interviews") return makeQueryCollection(store.interviews, true);
    if (name === "agent_sessions")   return makeQueryCollection(store.sessions, false);
    return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) };
  };
  const firestore = () => ({ collection });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

const sendSpy = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

import {
  sendInterviewFeedbackNudges,
  shouldNudgeInterviewFeedback,
  NUDGE_DELAY_MS, MAX_NUDGES, RENUDGE_COOLDOWN_MS,
} from "../interviewFeedbackNudge";

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

// 2026-09-07 (live-caught, same root cause as interviewCompletionNudge): a
// suppressed send (shared MAX_PROACTIVE_PER_DAY cap, opt-out, wait-tool) was
// still recorded as a delivered nudge, permanently burning the interview's
// limited MAX_NUDGES attempts on messages that never reached the phone.
describe("sendInterviewFeedbackNudges — only counts a nudge when it actually sends", () => {
  function seedInterview(id: string, data: Record<string, unknown> = {}) {
    store.interviews.set(id, {
      status:              "completed",
      feedbackSubmitted:   false,
      completedAt:         new Date(NOW - NUDGE_DELAY_MS - 1000).toISOString(),
      feedbackNudgeCount:  0,
      feedbackNudgedAt:    null,
      clientId:            "client-1",
      caregiverName:       "Basra Yousuf",
      ...data,
    });
  }

  function seedSession(phone: string, data: Record<string, unknown> = {}) {
    store.sessions.set(phone, {
      userId:         "client-1",
      optedOut:       false,
      onboardingStep: "complete",
      phone,
      ...data,
    });
  }

  beforeEach(() => {
    store.interviews.clear();
    store.sessions.clear();
    store.updates.length = 0;
    sendSpy.mockReset();
  });

  it("does not touch the interview doc when the send is suppressed (cap/opt-out/wait-tool)", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-suppressed");
    seedSession("+15550000001");

    await (sendInterviewFeedbackNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(store.updates).toHaveLength(0);
  });

  it("increments the nudge counter only when the send actually succeeds", async () => {
    sendSpy.mockResolvedValueOnce(true);
    seedInterview("iv-sent");
    seedSession("+15550000002");

    await (sendInterviewFeedbackNudges as any)();

    expect(store.updates).toEqual([
      { id: "iv-sent", data: { feedbackNudgeCount: 1, feedbackNudgedAt: expect.any(String) } },
    ]);
  });

  it("retries next run instead of burning MAX_NUDGES on a suppressed send", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-retry", { feedbackNudgeCount: MAX_NUDGES - 1 });
    seedSession("+15550000003");

    await (sendInterviewFeedbackNudges as any)();

    expect(store.updates).toHaveLength(0);
  });
});
