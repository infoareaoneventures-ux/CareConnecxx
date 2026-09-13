import { describe, it, expect, vi, beforeEach } from "vitest";

// Asks the family whether a scheduled interview happened once its time has
// passed and it's still "accepted" (never marked completed). Guards: only
// "accepted" interviews, wait NUDGE_DELAY_MS past scheduledTime, space
// repeats by RENUDGE_COOLDOWN_MS — no hard cap on total sends (2026-09-08:
// removed so an unresolved hiring decision doesn't go silent forever after a
// couple of misses, matching shouldNudgeStaleApplicants/pendingTimesheets).

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
  sendInterviewCompletionNudges,
  shouldNudgeInterviewCompletion,
  formatPacificDateTime,
  NUDGE_DELAY_MS, RENUDGE_COOLDOWN_MS,
} from "../interviewCompletionNudge";

const NOW = 1_000_000_000_000;

// 2026-09-08 (live-caught): the nudge message interpolated the raw UTC ISO
// scheduledTime straight into the prompt — a 2026-09-08T00:00:00.000Z
// interview (5pm Pacific on September 7th) got told back to the family as
// "on September 8th", reading the UTC calendar date literally instead of
// the family's actual local day.
describe("formatPacificDateTime", () => {
  it("renders a UTC midnight timestamp on its correct Pacific calendar day, not the UTC day", () => {
    expect(formatPacificDateTime("2026-09-08T00:00:00.000Z")).toBe("Monday, September 7 at 5:00 PM");
  });

  it("falls back gracefully for missing or unparseable input", () => {
    expect(formatPacificDateTime(undefined)).toBe("the scheduled time");
    expect(formatPacificDateTime("not-a-date")).toBe("the scheduled time");
  });
});

describe("shouldNudgeInterviewCompletion", () => {
  it("does not fire for a non-accepted status", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "requested", scheduledMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewCompletion({
      status: "completed", scheduledMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not fire before the scheduled time has passed by NUDGE_DELAY_MS", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS - 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("fires once the delay has elapsed on an accepted interview", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("does not fire with no parseable scheduledTime", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: null, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("respects the repeat cooldown", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS - 1), nowMs: NOW,
    })).toBe(false);
  });

  it("fires the repeat once the cooldown elapses", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  // 2026-09-08: no hard cap — keeps firing every ~48h no matter how many
  // times it's already nudged, as long as the cooldown has elapsed.
  it("still fires after many prior nudges, once the cooldown has elapsed", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  // 2026-09-13 (live-caught): a reschedule proposed but not yet accepted
  // means both parties already know the original time isn't happening —
  // firing "did your interview happen?" about it is confusing/redundant.
  it("does not fire while a reschedule is pending, even past the original scheduled time", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: null, nowMs: NOW, hasPendingReschedule: true,
    })).toBe(false);
  });

  it("fires normally once nothing is absent for hasPendingReschedule (default false)", () => {
    expect(shouldNudgeInterviewCompletion({
      status: "accepted", scheduledMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });
});

// 2026-09-07 (live-caught): a completed-yet-undelivered nudge. The interview
// had a completionNudgeCount and a completionNudgedAt timestamp, but the
// family's phone never got either text — both attempts had been silently
// suppressed by the shared proactive daily cap (MAX_PROACTIVE_PER_DAY), and
// the handler recorded them as sent anyway because it never checked
// sendViaInteractionAgent's return value. Locks in the fix: only count an
// attempt when the send actually goes out.
describe("sendInterviewCompletionNudges — only counts a nudge when it actually sends", () => {
  function seedInterview(id: string, data: Record<string, unknown> = {}) {
    store.interviews.set(id, {
      status:               "accepted",
      scheduledTime:        new Date(NOW - NUDGE_DELAY_MS - 1000).toISOString(),
      completionNudgeCount: 0,
      completionNudgedAt:   null,
      clientId:             "client-1",
      caregiverName:        "Basra Yousuf",
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

    await (sendInterviewCompletionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(store.updates).toHaveLength(0);
  });

  it("increments the nudge counter only when the send actually succeeds", async () => {
    sendSpy.mockResolvedValueOnce(true);
    seedInterview("iv-sent");
    seedSession("+15550000002");

    await (sendInterviewCompletionNudges as any)();

    expect(store.updates).toEqual([
      { id: "iv-sent", data: { completionNudgeCount: 1, completionNudgedAt: expect.any(String) } },
    ]);
  });

  it("retries next run instead of advancing the counter on a suppressed send", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-retry", { completionNudgeCount: 5 });
    seedSession("+15550000003");

    await (sendInterviewCompletionNudges as any)();

    // Counter untouched — a later real run can still try again.
    expect(store.updates).toHaveLength(0);
  });

  // 2026-09-13 (live-caught): the scheduled job itself must pass the pending-
  // reschedule flag through, not just the pure function in isolation.
  it("skips an interview with a pending reschedule entirely — no send, no update", async () => {
    seedInterview("iv-rescheduling", { reschedulePendingTime: new Date(NOW + 100_000).toISOString() });
    seedSession("+15550000004");

    await (sendInterviewCompletionNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toHaveLength(0);
  });
});
