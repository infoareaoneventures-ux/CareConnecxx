import { describe, it, expect, vi } from "vitest";
import {
  handleInterviewCounterReply, freshInterviewCounter, classifyInterviewCounterReply, INTERVIEW_COUNTER_TTL_MS,
  type InterviewCounterDeps, type InterviewCounterReply,
} from "../interviewCounterReply";

// The site's declined-with-counter card: "Accept this time" / "Propose another
// time" both create a NEW interview request (PostsPage.tsx handleAcceptProposedTime
// / handleCounterProposeTime → v1-createVideoInterviewRequest). Over text the
// family's reply must land on the same write.

const NOW = Date.parse("2026-09-23T17:00:00.000Z");
const PROPOSED = "2026-09-25T17:00:00.000Z";
const session = (extra: Record<string, unknown> = {}) => ({
  userId: "client-1",
  pendingInterviewCounter: { interviewId: "iv1", caregiverId: "cg1", caregiverName: "Basra Yousuf", proposedTime: PROPOSED, jobId: "job1", jobTitle: "Care for Mom" },
  pendingInterviewCounterSetAt: new Date(NOW - 60_000).toISOString(),
  ...extra,
});

function deps(verdict: InterviewCounterReply, overrides: Partial<InterviewCounterDeps> = {}) {
  const d: InterviewCounterDeps = {
    enforceGate: vi.fn(async () => false),
    requestInterview: vi.fn(async () => ({ interviewId: "iv2" })),
    startInterviewFlow: vi.fn(async () => ({ started: true })),
    sendMessage: vi.fn(async () => undefined),
    clearAnchor: vi.fn(async () => undefined),
    classify: vi.fn(async () => verdict),
    nowMs: () => NOW,
    ...overrides,
  };
  return d;
}

describe("freshInterviewCounter", () => {
  it("returns the counter while fresh and null once the 24h window passed", () => {
    expect(freshInterviewCounter(session(), NOW)?.interviewId).toBe("iv1");
    expect(freshInterviewCounter(session(), NOW + INTERVIEW_COUNTER_TTL_MS + 1)).toBeNull();
    expect(freshInterviewCounter({ userId: "client-1" }, NOW)).toBeNull();
  });
});

describe("classifyInterviewCounterReply", () => {
  it("parses the model's JSON and never invents a date/time", async () => {
    const complete = vi.fn(async () => '```json\n{"action":"other_time","date":"2026-09-26","time":"14:00"}\n```');
    expect(await classifyInterviewCounterReply("how about Saturday at 2", "Friday, Sep 25 at 10:00 AM", "2026-09-23", complete))
      .toEqual({ action: "other_time", date: "2026-09-26", time: "14:00" });
    const bad = vi.fn(async () => '{"action":"other_time","date":"Saturday","time":"2pm"}');
    expect(await classifyInterviewCounterReply("Saturday 2pm", "x", "2026-09-23", bad)).toEqual({ action: "other_time", date: null, time: null });
    const err = vi.fn(async () => { throw new Error("llm down"); });
    expect(await classifyInterviewCounterReply("yes", "x", "2026-09-23", err)).toEqual({ action: "other" });
  });
});

describe("handleInterviewCounterReply", () => {
  it("is not ours when there is no fresh counter or the reply is about something else", async () => {
    const d = deps({ action: "accept" });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "yes", session: { userId: "client-1" } }, d)).toBe(false);
    const d2 = deps({ action: "other" });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "what time is the visit tomorrow?", session: session() }, d2)).toBe(false);
    expect(d2.requestInterview).not.toHaveBeenCalled();
  });

  it("YES = the site's Accept this time: one NEW request at the proposed time, gated like the modal, anchor cleared", async () => {
    const d = deps({ action: "accept" });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "yes that works", session: session() }, d)).toBe(true);
    expect(d.enforceGate).toHaveBeenCalledWith("client-1", "Basra Yousuf");
    expect(d.requestInterview).toHaveBeenCalledWith({ clientId: "client-1", caregiverId: "cg1", scheduledTime: PROPOSED, jobId: "job1", jobTitle: "Care for Mom" });
    expect(d.clearAnchor).toHaveBeenCalledWith("+1");
    expect(String((d.sendMessage as any).mock.calls[0][1])).toContain("I've asked Basra for");
  });

  it("a stated other time = the site's Propose another time: a NEW request at that time", async () => {
    const d = deps({ action: "other_time", date: "2026-09-26", time: "14:00" });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "Saturday at 2 instead", session: session() }, d)).toBe(true);
    const call = (d.requestInterview as any).mock.calls[0][0];
    expect(call.caregiverId).toBe("cg1");
    expect(new Date(call.scheduledTime).toISOString()).toBe(call.scheduledTime);
    expect(d.startInterviewFlow).not.toHaveBeenCalled();
  });

  it("a different time with no usable date/time hands to the Request Interview flow", async () => {
    const d = deps({ action: "other_time", date: null, time: null });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "can we do a different day?", session: session() }, d)).toBe(true);
    expect(d.startInterviewFlow).toHaveBeenCalledWith("cg1");
    expect(d.requestInterview).not.toHaveBeenCalled();
    expect(d.clearAnchor).toHaveBeenCalled();
  });

  it("the paywall blocks the request exactly like the modal's gate, and keeps the anchor", async () => {
    const d = deps({ action: "accept" }, { enforceGate: vi.fn(async () => true) });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "yes", session: session() }, d)).toBe(true);
    expect(d.requestInterview).not.toHaveBeenCalled();
    expect(d.clearAnchor).not.toHaveBeenCalled();
  });

  it("no = leave it, anchor cleared, no request", async () => {
    const d = deps({ action: "decline" });
    expect(await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "no thanks", session: session() }, d)).toBe(true);
    expect(d.requestInterview).not.toHaveBeenCalled();
    expect(d.clearAnchor).toHaveBeenCalled();
  });

  it("a failed write is an honest apology pointing at the Interviews tab, never a false success", async () => {
    const d = deps({ action: "accept" }, { requestInterview: vi.fn(async () => { throw new Error("boom"); }) });
    await handleInterviewCounterReply({ phone: "+1", chatId: "c", text: "yes", session: session() }, d);
    expect(String((d.sendMessage as any).mock.calls[0][1])).toContain("couldn't send");
  });
});
