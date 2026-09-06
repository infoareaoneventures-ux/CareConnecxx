import { describe, it, expect, vi, beforeEach } from "vitest";

// The interview-promise net: when the model narrates "I'm lining up an
// interview with X" without actually calling schedule_interview, nothing is
// ever created and (unlike onboarding gate steps) ordinary post-onboarding
// chat has no other safety net watching for it (2026-09-06 live bug —
// confirmed via Firestore that no video_interviews doc existed for the
// promised interview). This records a tracked `interview` commitment so the
// sweep asks for date/time instead of leaving the promise dropped.

const hoisted = vi.hoisted(() => {
  const quickComplete = vi.fn(async (..._a: unknown[]) => "YES");
  const recordCommitment = vi.fn(async (..._a: unknown[]) => "id-1");
  return { quickComplete, recordCommitment };
});

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...a: unknown[]) => hoisted.quickComplete(...a),
}));
vi.mock("./commitmentTracker", () => ({
  recordCommitment: (...a: unknown[]) => hoisted.recordCommitment(...a),
}));

import { fulfillNarratedInterviewPromise } from "./interviewPromiseNet";

const BASE = { phone: "+15551112222", chatId: "chat-1", userType: "client" as const };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.quickComplete.mockResolvedValue("YES");
});

describe("fulfillNarratedInterviewPromise", () => {
  it("records a tracked interview commitment when the reply narrates scheduling with no tool call", async () => {
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "Got it, I'm lining up an interview with Basra." });

    expect(hoisted.recordCommitment).toHaveBeenCalledWith(expect.objectContaining({
      kind:  "interview",
      phone: "+15551112222",
    }));
  });

  it("does nothing when the reply never mentions interviewing/scheduling/meeting (prescreen, no LLM call)", async () => {
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "Sure, what's your budget per hour?" });

    expect(hoisted.quickComplete).not.toHaveBeenCalled();
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("does nothing when the classifier says this isn't an unaddressed promise (e.g. it already asked for date/time)", async () => {
    hoisted.quickComplete.mockResolvedValue("NO");
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "Great — what day and time works for the interview with Basra?" });

    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("does nothing when the reply just references an interview already scheduled/confirmed", async () => {
    hoisted.quickComplete.mockResolvedValue("NO");
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "Your interview with Basra is confirmed for 9am tomorrow." });

    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("fails closed to NO when the classifier throws (no commitment recorded)", async () => {
    hoisted.quickComplete.mockRejectedValue(new Error("provider down"));
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "I'm scheduling that interview now." });

    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("passes userId through to the commitment when provided", async () => {
    await fulfillNarratedInterviewPromise({ ...BASE, reply: "Let me set up a meeting with her.", userId: "uid-1" });

    expect(hoisted.recordCommitment).toHaveBeenCalledWith(expect.objectContaining({ userId: "uid-1" }));
  });
});
