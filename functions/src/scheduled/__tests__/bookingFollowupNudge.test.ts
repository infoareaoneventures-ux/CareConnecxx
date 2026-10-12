import { describe, it, expect, vi, beforeEach } from "vitest";

// Third sibling of interviewCompletionNudge / interviewFeedbackNudge: a
// 'strong' fit decision with no booking behind it gets a follow-up. Guards and
// the bell ⇄ text rule (C11, 2026-10-11): the text goes first; the family's
// website bell is written only when it actually went.

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

const order: string[] = [];
const sendSpy = vi.fn(async (..._a: unknown[]) => { order.push("text"); return true; });
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

const bells: any[] = [];
vi.mock("../../notifications/userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { bells.push(n); order.push("bell"); return true; }),
}));

import { sendBookingFollowupNudges, shouldNudgeBookingFollowup, NUDGE_DELAY_MS, RENUDGE_COOLDOWN_MS } from "../bookingFollowupNudge";

const NOW = 1_000_000_000_000;

describe("shouldNudgeBookingFollowup", () => {
  it("fires only for a 'strong' decision with no booking, 1h after the decision, then every ~48h", () => {
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: false, feedbackMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW })).toBe(true);
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: false, feedbackMs: NOW - NUDGE_DELAY_MS + 1, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgeBookingFollowup({ fitLevel: "maybe", hasBookingRequest: false, feedbackMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: true, feedbackMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: false, feedbackMs: null, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: false, feedbackMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS + 1, nowMs: NOW })).toBe(false);
    expect(shouldNudgeBookingFollowup({ fitLevel: "strong", hasBookingRequest: false, feedbackMs: NOW - NUDGE_DELAY_MS - 1, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1, nowMs: NOW })).toBe(true);
  });
});

describe("sendBookingFollowupNudges — bell ⇄ text", () => {
  function seedInterview(id: string, data: Record<string, unknown> = {}) {
    store.interviews.set(id, {
      status: "completed", fitLevel: "strong",
      feedbackAt: new Date(Date.now() - NUDGE_DELAY_MS - 1000).toISOString(),
      bookingNudgeCount: 0, bookingNudgedAt: null,
      clientId: "client-1", caregiverName: "Basra Yousuf",
      ...data,
    });
  }
  function seedSession(phone: string, data: Record<string, unknown> = {}) {
    store.sessions.set(phone, { userId: "client-1", optedOut: false, onboardingStep: "complete", phone, ...data });
  }

  beforeEach(() => {
    store.interviews.clear();
    store.sessions.clear();
    store.bookings.clear();
    store.updates.length = 0;
    store.sessionUpdates.length = 0;
    bells.length = 0;
    order.length = 0;
    sendSpy.mockReset();
    sendSpy.mockImplementation(async () => { order.push("text"); return true; });
  });

  it("text dropped → no bell, nothing stamped, retried next run", async () => {
    sendSpy.mockResolvedValueOnce(false);
    seedInterview("iv-dropped");
    seedSession("+15550000001");

    await (sendBookingFollowupNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(bells).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(store.sessionUpdates).toHaveLength(0);
  });

  it("text sent → the counter, the session anchor and then the bell (Interviews tab words), keyed per nudge number", async () => {
    seedInterview("iv-sent", { bookingNudgeCount: 1 });
    seedSession("+15550000002");

    await (sendBookingFollowupNudges as any)();

    expect(order).toEqual(["text", "bell"]);
    expect(store.updates).toEqual([{ id: "iv-sent", data: { bookingNudgeCount: 2, bookingNudgedAt: expect.any(String) } }]);
    expect(store.sessionUpdates).toEqual([{ id: "+15550000002", data: { pendingBookingNudgeInterviewId: "iv-sent", pendingBookingNudgeSetAt: expect.any(String) } }]);
    expect(bells).toEqual([expect.objectContaining({
      sourcePath: "video_interviews/iv-sent", eventId: "booking-followup-nudge-2", recipientId: "client-1",
      transitionType: "booking_followup_nudge", type: "interview_booking_followup", title: "Finish setting up your booking",
      body: "You marked Basra a strong fit, but the booking was never sent. Send Booking from your Interviews tab to lock in the schedule and rate.",
      data: { interviewId: "iv-sent" },
    })]);
  });

  it("a booking already started for the interview → nothing (no text, no bell)", async () => {
    seedInterview("iv-booked");
    seedSession("+15550000003");
    store.bookings.set("br-1", { interviewId: "iv-booked", clientId: "client-1" });

    await (sendBookingFollowupNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(bells).toHaveLength(0);
  });
});
