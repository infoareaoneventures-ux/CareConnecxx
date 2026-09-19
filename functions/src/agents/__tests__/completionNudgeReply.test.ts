// A bare yes/no to the "did your interview happen?" check-in lands on the
// interview card's buttons — YES = Mark as Completed (same write), NO = offer
// Reschedule / Cancel — never on the no-tools quick-reply path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  freshCompletionNudgeInterviewId, classifyCompletionNudgeReply, handleCompletionNudgeReply, COMPLETION_NUDGE_TTL_MS,
} from "../completionNudgeReply";

const NOW = Date.parse("2026-09-19T03:59:00.000Z");
const session = (over: Record<string, unknown> = {}) => ({
  userId: "client-uid", pendingCompletionNudgeInterviewId: "iv-1", pendingCompletionNudgeSetAt: "2026-09-19T01:00:00.000Z", ...over,
});
const deps = {
  completeInterview: vi.fn(async (_id: string, _cid: string) => ({ success: true, caregiverName: "Basra Yousuf" })),
  sendMessage: vi.fn(async () => undefined),
  clearAnchor: vi.fn(async () => undefined),
};
beforeEach(() => { deps.completeInterview.mockClear(); deps.sendMessage.mockClear(); deps.clearAnchor.mockClear(); });

describe("freshCompletionNudgeInterviewId", () => {
  it("returns the anchored interview while the check-in is under 24h old, else null", () => {
    expect(freshCompletionNudgeInterviewId(session(), NOW)).toBe("iv-1");
    expect(freshCompletionNudgeInterviewId(session({ pendingCompletionNudgeSetAt: new Date(NOW - COMPLETION_NUDGE_TTL_MS - 1000).toISOString() }), NOW)).toBeNull();
    expect(freshCompletionNudgeInterviewId({}, NOW)).toBeNull();
  });
});

describe("classifyCompletionNudgeReply — the stated yes/no protocol only", () => {
  it("yes-words → happened, no-words → not_happened, anything else → null (the agent takes it)", () => {
    expect(classifyCompletionNudgeReply("yes")).toBe("happened");
    expect(classifyCompletionNudgeReply("Yes.")).toBe("happened");
    expect(classifyCompletionNudgeReply("it did")).toBe("happened");
    expect(classifyCompletionNudgeReply("no")).toBe("not_happened");
    expect(classifyCompletionNudgeReply("not yet")).toBe("not_happened");
    expect(classifyCompletionNudgeReply("yes but she was late, can we redo it")).toBeNull();
    expect(classifyCompletionNudgeReply("reschedule it")).toBeNull();
  });
});

describe("handleCompletionNudgeReply", () => {
  it("YES → the site's Mark as Completed write, anchor cleared, confirmation sent", async () => {
    const reply = await handleCompletionNudgeReply({ phone: "+1555", chatId: "c1", text: "yes", session: session(), nowMs: NOW }, deps);
    expect(deps.completeInterview).toHaveBeenCalledWith("iv-1", "client-uid");
    expect(deps.clearAnchor).toHaveBeenCalledWith("+1555");
    expect(reply).toContain("Done — your interview with Basra is marked completed");
    expect(reply).toContain("Completed on your Care Requests page");
    expect(deps.sendMessage).toHaveBeenCalledWith("c1", reply);
  });

  it("NO → offers the card's other two buttons and keeps the anchor for the follow-up", async () => {
    const reply = await handleCompletionNudgeReply({ phone: "+1555", chatId: "c1", text: "no", session: session(), nowMs: NOW }, deps);
    expect(deps.completeInterview).not.toHaveBeenCalled();
    expect(deps.clearAnchor).not.toHaveBeenCalled();
    expect(reply).toBe("No problem — would you like to reschedule it, or cancel it?");
  });

  it("the write's own guard message is passed through (e.g. the interview hasn't happened yet)", async () => {
    deps.completeInterview.mockResolvedValueOnce({ _toolError: true, code: "INVALID_INPUT", message: "That interview hasn't happened yet (Sunday 7:00 PM)" } as any);
    const reply = await handleCompletionNudgeReply({ phone: "+1555", chatId: "c1", text: "yes", session: session(), nowMs: NOW }, deps);
    expect(reply).toContain("I couldn't mark that interview completed — That interview hasn't happened yet");
    expect(deps.clearAnchor).toHaveBeenCalled();
  });

  it("not our turn: no fresh anchor, or a reply that isn't a bare yes/no", async () => {
    expect(await handleCompletionNudgeReply({ phone: "+1555", chatId: "c1", text: "yes", session: { userId: "client-uid" }, nowMs: NOW }, deps)).toBeNull();
    expect(await handleCompletionNudgeReply({ phone: "+1555", chatId: "c1", text: "can we reschedule to friday", session: session(), nowMs: NOW }, deps)).toBeNull();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
