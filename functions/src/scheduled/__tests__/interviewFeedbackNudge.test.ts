import { describe, it, expect, vi, beforeEach } from "vitest";

// Sibling of interviewCompletionNudge.test.ts. Asks the family for a fit
// decision once an interview has sat "completed" with no feedbackSubmitted
// for NUDGE_DELAY_MS — the safety net for complete_interview's "MANDATORY"
// same-reply ask being a prompt-level instruction with no runtime enforcement.

const store = {
  interviews:     new Map<string, any>(),
  sessions:       new Map<string, any>(),
  bookings:       new Map<string, any>(),
  updates:        [] as Array<{ id: string; data: any }>,
  sessionUpdates: [] as Array<{ id: string; data: any }>,
};

function makeQueryCollection(map: Map<string, any>, updatesSink: Array<{ id: string; data: any }> | null) {
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
              ...(updatesSink ? { ref: { update: vi.fn(async (upd: any) => { updatesSink.push({ id, data: upd }); }) } } : {}),
            })),
          };
        },
      }),
    }),
  };
}

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "video_interviews") return makeQueryCollection(store.interviews, store.updates);
    // agent_sessions now needs a ref too — interviewFeedbackNudge.ts stamps
    // pendingFeedbackNudgeInterviewId there so the next turn knows which
    // interview a fit-decision reply concerns (2026-09-13, same fix as
    // interviewCompletionNudge.ts's pendingCompletionNudgeInterviewId).
    if (name === "agent_sessions")   return makeQueryCollection(store.sessions, store.sessionUpdates);
    if (name === "booking_requests") return makeQueryCollection(store.bookings, null);
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
  interviewHasBooking,
  completedAtMs,
  NUDGE_DELAY_MS, RENUDGE_COOLDOWN_MS, NUDGE_WINDOW_MS,
} from "../interviewFeedbackNudge";

const NOW = 1_000_000_000_000;

describe("shouldNudgeInterviewFeedback", () => {
  it("does not fire for a non-completed status", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "accepted", fitLevel: undefined, completedMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewFeedback({
      status: "declined", fitLevel: undefined, completedMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not fire once a final decision (strong or no) has been recorded", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: "strong", completedMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: "no", completedMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  // 2026-09-13 (Hamse's call): "maybe" is not a final answer — it keeps the
  // same re-ask cycle going instead of silently stopping like strong/no do.
  it("still fires when the family answered 'maybe' — not a final decision", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: "maybe", completedMs: NOW - (NUDGE_DELAY_MS + 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("does not fire before completedAt has passed by NUDGE_DELAY_MS", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_DELAY_MS - 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("fires once the delay has elapsed on a completed, undecided interview", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_DELAY_MS + 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  // 2026-09-27 (founder): a month on, nobody is still deciding.
  it("stops after the 30-day window even with the cooldown elapsed", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_WINDOW_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(false);
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_WINDOW_MS - 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  it("reads completedAt however it was written: the site's server timestamp, Evia's old ISO string, or nothing", () => {
    const ms = NOW - 5000;
    expect(completedAtMs({ toMillis: () => ms })).toBe(ms);                 // admin SDK Timestamp
    expect(completedAtMs({ seconds: Math.floor(ms / 1000), nanoseconds: 0 })).toBe(Math.floor(ms / 1000) * 1000);
    expect(completedAtMs({ _seconds: 12, _nanoseconds: 0 })).toBe(12000);   // serialized form
    expect(completedAtMs(new Date(ms).toISOString())).toBe(ms);
    expect(completedAtMs(undefined)).toBeNull();
    expect(completedAtMs("not a date")).toBeNull();
  });

  it("does not fire with no parseable completedAt", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: null, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("respects the repeat cooldown", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS - 1), nowMs: NOW,
    })).toBe(false);
  });

  it("fires the repeat once the cooldown elapses", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });

  // 2026-09-08: no hard cap — keeps firing every ~48h no matter how many
  // times it's already nudged, as long as the cooldown has elapsed.
  it("still fires after many prior nudges, once the cooldown has elapsed", () => {
    expect(shouldNudgeInterviewFeedback({
      status: "completed", fitLevel: undefined, completedMs: NOW - (NUDGE_DELAY_MS + 1),
      lastNudgedMs: NOW - (RENUDGE_COOLDOWN_MS + 1), nowMs: NOW,
    })).toBe(true);
  });
});

// 2026-09-07 (live-caught, same root cause as interviewCompletionNudge): a
// suppressed send (shared MAX_PROACTIVE_PER_DAY cap, opt-out, wait-tool) was
// still recorded as a delivered nudge, even though the message never reached
// the phone.
describe("sendInterviewFeedbackNudges — only counts a nudge when it actually sends", () => {
  function seedInterview(id: string, data: Record<string, unknown> = {}) {
    store.interviews.set(id, {
      status:              "completed",
      feedbackSubmitted:   false,
      completedAt:         new Date(Date.now() - NUDGE_DELAY_MS - 1000).toISOString(), // real clock: the job uses Date.now() and the 30-day window
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
    store.bookings.clear();
    store.updates.length = 0;
    store.sessionUpdates.length = 0;
    sendSpy.mockReset();
  });

  // 2026-09-27 live: booking sent AND accepted, family still nudged every 48h.
  // Before 2026-09-27 the job parsed completedAt as text, so an interview the
  // family completed on the SITE (server timestamp) was never nudged at all.
  it("nudges an interview completed on the site (timestamp completedAt), not only one completed through Evia", async () => {
    seedInterview("iv-site", { completedAt: { toMillis: () => Date.now() - NUDGE_DELAY_MS - 1000 } });
    seedSession("+15550000012");
    await (sendInterviewFeedbackNudges as any)();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("never nudges once a booking exists under the interview's key — the site's card no longer shows Send Booking", async () => {
    seedInterview("iv-booked", { caregiverId: "cg-1", jobId: "job-1" });
    seedSession("+15550000010");
    for (const status of ["pending", "accepted", "declined", "cancelled"]) {
      store.bookings.clear();
      store.bookings.set("bk", { clientId: "client-1", caregiverId: "cg-1", jobId: "job-1", interviewId: "iv-booked", status });
      await (sendInterviewFeedbackNudges as any)();
    }
    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toHaveLength(0);
  });

  it("a booking for a different caregiver or job does not count; keys fall back to the interview id when there is no job", async () => {
    seedInterview("iv-open", { caregiverId: "cg-1", jobId: null });
    seedSession("+15550000011");
    store.bookings.set("other-cg",  { clientId: "client-1", caregiverId: "cg-2", jobId: null, interviewId: "iv-open" });
    store.bookings.set("other-job", { clientId: "client-1", caregiverId: "cg-1", jobId: "job-9", interviewId: null });
    store.bookings.set("replacement", { clientId: "client-1", caregiverId: "cg-1", replacementForShiftId: "s1" });
    await (sendInterviewFeedbackNudges as any)();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    expect(interviewHasBooking({ id: "iv-open", caregiverId: "cg-1", jobId: null },
      [{ caregiverId: "cg-1", jobId: null, interviewId: "iv-open" }])).toBe(true);
    expect(interviewHasBooking({ id: "iv-open", caregiverId: "cg-1", jobId: "job-1" },
      [{ caregiverId: "cg-1", jobId: "job-1", interviewId: null }])).toBe(true);
    expect(interviewHasBooking({ id: "iv-open", caregiverId: "cg-1", jobId: "job-1" },
      [{ caregiverId: "cg-1", jobId: null, interviewId: "iv-open" }])).toBe(false); // the site keys by job when the interview has one
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

  // 2026-09-13: same anchor as interviewCompletionNudge.ts — a reply like
  // "not a fit" needs to know which interview it concerns.
  it("stamps the session with which interview this feedback nudge concerns, only on an actual send", async () => {
    sendSpy.mockResolvedValueOnce(true);
    seedInterview("iv-breadcrumb");
    seedSession("+15550000005");

    await (sendInterviewFeedbackNudges as any)();

    expect(store.sessionUpdates).toEqual([
      {
        id: "+15550000005",
        data: {
          pendingFeedbackNudgeInterviewId: "iv-breadcrumb",
          pendingFeedbackNudgeSetAt: expect.any(String),
        },
      },
    ]);
  });

  it("does not stamp the session breadcrumb when the send is suppressed", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-breadcrumb-suppressed");
    seedSession("+15550000006");

    await (sendInterviewFeedbackNudges as any)();

    expect(store.sessionUpdates).toHaveLength(0);
  });

  it("retries next run instead of advancing the counter on a suppressed send", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-retry", { feedbackNudgeCount: 5 });
    seedSession("+15550000003");

    await (sendInterviewFeedbackNudges as any)();

    expect(store.updates).toHaveLength(0);
  });
});
