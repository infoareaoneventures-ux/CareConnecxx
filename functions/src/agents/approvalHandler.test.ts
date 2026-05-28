import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  quickCompleteMock:    vi.fn(),
  sendMessageMock:      vi.fn(async () => undefined),
  handleToolCallMock:   vi.fn(async (_n: string, _i: Record<string, unknown>): Promise<Record<string, unknown>> => ({ success: true })),
  handleToolCallForCaregiverMock: vi.fn(async (_n: string, _i: Record<string, unknown>): Promise<Record<string, unknown>> => ({ success: true })),
  resolvePendingMock:   vi.fn(async () => undefined),
}));

vi.mock("../utils/openaiClient", () => ({ quickComplete: hoisted.quickCompleteMock }));
vi.mock("../linq/client", () => ({ sendMessage: hoisted.sendMessageMock }));
vi.mock("../mcp/server", () => ({
  handleToolCall: hoisted.handleToolCallMock,
  handleToolCallForCaregiver: hoisted.handleToolCallForCaregiverMock,
}));
vi.mock("./pendingActions", () => ({
  resolvePendingAction: hoisted.resolvePendingMock,
}));

import { classifyApproval, handlePendingApproval } from "./approvalHandler";

const makePending = (overrides: Record<string, unknown> = {}) => ({
  id:         "pa_42",
  phone:      "+15550001111",
  toolName:   "cancel_appointment",
  toolInput:  { appointmentId: "appt_123" },
  preview:    "Cancel appointment appt_123",
  proposedAt: new Date().toISOString(),
  expiresAt:  new Date(Date.now() + 15 * 60_000).toISOString(),
  status:     "awaiting" as const,
  ...overrides,
});

beforeEach(() => {
  hoisted.quickCompleteMock.mockReset();
  hoisted.sendMessageMock.mockClear();
  hoisted.handleToolCallMock.mockReset();
  hoisted.handleToolCallMock.mockResolvedValue({ success: true });
  hoisted.handleToolCallForCaregiverMock.mockReset();
  hoisted.handleToolCallForCaregiverMock.mockResolvedValue({ success: true });
  hoisted.resolvePendingMock.mockClear();
});

describe("classifyApproval", () => {
  it("classifies trivial YES words without an LLM call", async () => {
    for (const w of ["yes", "Y", "yeah", "go ahead", "do it", "confirm"]) {
      const got = await classifyApproval(w, "Cancel appointment");
      expect(got).toBe("YES");
    }
    expect(hoisted.quickCompleteMock).not.toHaveBeenCalled();
  });

  it("classifies trivial NO words without an LLM call", async () => {
    for (const w of ["no", "nope", "wait", "actually no", "never mind"]) {
      const got = await classifyApproval(w, "Cancel appointment");
      expect(got).toBe("NO");
    }
    expect(hoisted.quickCompleteMock).not.toHaveBeenCalled();
  });

  it("falls through to LLM for ambiguous replies and respects its decision", async () => {
    hoisted.quickCompleteMock.mockResolvedValueOnce("YES");
    expect(await classifyApproval("sounds right, let's do it", "Cancel appointment")).toBe("YES");

    hoisted.quickCompleteMock.mockResolvedValueOnce("NO");
    expect(await classifyApproval("actually I changed my mind", "Cancel appointment")).toBe("NO");

    hoisted.quickCompleteMock.mockResolvedValueOnce("QUESTION");
    expect(await classifyApproval("what time was that again?", "Cancel appointment")).toBe("QUESTION");
  });

  it("defaults to QUESTION on classifier failure (fail-safe — never auto-execute)", async () => {
    hoisted.quickCompleteMock.mockRejectedValueOnce(new Error("openai down"));
    expect(await classifyApproval("something ambiguous", "Cancel appointment")).toBe("QUESTION");
  });

  it("defaults to QUESTION on malformed LLM output", async () => {
    hoisted.quickCompleteMock.mockResolvedValueOnce("MAYBE_PROBABLY");
    expect(await classifyApproval("hmm", "Cancel appointment")).toBe("QUESTION");
  });
});

describe("handlePendingApproval", () => {
  it("YES path: executes the tool with _confirmedActionId, marks executed, and ACKs", async () => {
    hoisted.handleToolCallMock.mockResolvedValueOnce({ success: true, results: "ok" });
    const result = await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "yes",
      userId:  "user-1",
      pending: makePending(),
    });

    expect(result).toEqual({ outcome: "handled" });
    expect(hoisted.handleToolCallMock).toHaveBeenCalledTimes(1);
    const [toolName, calledInput] = hoisted.handleToolCallMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(toolName).toBe("cancel_appointment");
    expect(calledInput._confirmedActionId).toBe("pa_42");
    expect(calledInput.phone).toBe("+15550001111");
    expect(calledInput.userId).toBe("user-1");
    expect(calledInput.appointmentId).toBe("appt_123");

    expect(hoisted.resolvePendingMock).toHaveBeenCalledWith("pa_42", "executed", expect.objectContaining({
      executionPreview: expect.any(String),
    }));
    expect(hoisted.sendMessageMock).toHaveBeenCalledWith("chat_1", "Done.");
  });

  it("YES path: marks failed and sends recovery ACK when the tool errors", async () => {
    hoisted.handleToolCallMock.mockResolvedValueOnce({ _toolError: true, message: "boom" });
    await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "go ahead",
      pending: makePending(),
    });
    expect(hoisted.resolvePendingMock).toHaveBeenCalledWith("pa_42", "failed", expect.any(Object));
    expect(hoisted.sendMessageMock).toHaveBeenCalledWith("chat_1", expect.stringContaining("ran into a problem"));
  });

  it("NO path (trivial fast match): marks rejected, sends reassurance, does NOT execute", async () => {
    // "nevermind" is in the trivial fast-match set — no LLM call needed.
    const result = await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "nevermind",
      pending: makePending(),
    });
    expect(result).toEqual({ outcome: "handled" });
    expect(hoisted.handleToolCallMock).not.toHaveBeenCalled();
    expect(hoisted.resolvePendingMock).toHaveBeenCalledWith("pa_42", "rejected");
    expect(hoisted.sendMessageMock).toHaveBeenCalledWith("chat_1", expect.stringContaining("Got it"));
    expect(hoisted.quickCompleteMock).not.toHaveBeenCalled();
  });

  it("NO path (LLM-classified natural language): marks rejected without executing", async () => {
    // Compound phrases like "actually never mind" intentionally fall through
    // to the LLM rather than expanding the trivial set into ambiguous territory
    // (e.g. "never gonna give up", "no way you can find a caregiver" should NOT
    // match). The LLM is the safer arbiter for anything beyond bare keywords.
    hoisted.quickCompleteMock.mockResolvedValueOnce("NO");
    const result = await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "actually never mind, I changed my mind",
      pending: makePending(),
    });
    expect(result).toEqual({ outcome: "handled" });
    expect(hoisted.handleToolCallMock).not.toHaveBeenCalled();
    expect(hoisted.resolvePendingMock).toHaveBeenCalledWith("pa_42", "rejected");
  });

  it("QUESTION path: falls through without resolving or executing", async () => {
    hoisted.quickCompleteMock.mockResolvedValueOnce("QUESTION");
    const result = await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "wait, what time was the original appointment?",
      pending: makePending(),
    });
    expect(result).toEqual({ outcome: "fallthrough", reason: "question" });
    expect(hoisted.handleToolCallMock).not.toHaveBeenCalled();
    expect(hoisted.resolvePendingMock).not.toHaveBeenCalled();
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it("routes caregiver pendings through the caregiver dispatcher", async () => {
    await handlePendingApproval({
      phone:    "+15550001111",
      chatId:   "chat_1",
      text:     "yes",
      userType: "caregiver",
      pending:  makePending({ toolName: "delete_reminder", toolInput: { reminderId: "r1" } }),
    });
    expect(hoisted.handleToolCallForCaregiverMock).toHaveBeenCalledTimes(1);
    expect(hoisted.handleToolCallMock).not.toHaveBeenCalled();
  });

  it("treats a tool throw as a failed execution rather than crashing", async () => {
    hoisted.handleToolCallMock.mockRejectedValueOnce(new Error("network"));
    const result = await handlePendingApproval({
      phone:   "+15550001111",
      chatId:  "chat_1",
      text:    "yes",
      pending: makePending(),
    });
    expect(result).toEqual({ outcome: "handled" });
    expect(hoisted.resolvePendingMock).toHaveBeenCalledWith("pa_42", "failed", expect.any(Object));
  });
});
