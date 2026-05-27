import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted shared mocks — vi.mock factories run before the file body so any
// closed-over references need to be declared via vi.hoisted.
const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({
    update: updateMock,
    get:    vi.fn().mockResolvedValue({ exists: false }),
  }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  const sendMessage = vi.fn().mockResolvedValue({ message_id: "x" });
  const quickComplete = vi.fn();
  return { updateMock, docMock, collectionMock, sendMessage, quickComplete };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: vi.fn(() => "__DELETE__") },
  }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: unknown[]) => hoisted.sendMessage(...args),
  AgentSession: class {},
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

vi.mock("./bookingExecutor", () => ({
  createBookingTask: vi.fn(),
  executeBookings: vi.fn(),
}));

const { updateMock, sendMessage, quickComplete } = hoisted;

import { handleTaskApproval } from "./taskApprovalHandler";

function makeTaskDoc(options: Array<{ name: string; caregiverId?: string }>) {
  return {
    id: "task-123",
    ref: {
      update: vi.fn().mockResolvedValue(undefined),
      path:   "agent_tasks/task-123",
    },
    data: () => ({ options, time: "Tuesday at 9am", type: "booking" }),
  } as any;
}

describe("handleTaskApproval question guard", () => {
  beforeEach(() => {
    sendMessage.mockClear();
    quickComplete.mockReset();
    updateMock.mockClear();
  });

  it("routes questions to the question-answer flow, not parseInt", async () => {
    // First call: isQuestionOrOther → YES
    // Second call: answerQuestionMidFlow → the answer
    quickComplete.mockResolvedValueOnce("YES");
    quickComplete.mockResolvedValueOnce("They're all background-checked and vetted.");

    const taskDoc = makeTaskDoc([
      { name: "Alice", caregiverId: "c1" },
      { name: "Bob",   caregiverId: "c2" },
    ]);
    await handleTaskApproval(taskDoc, "are they background checked?", {} as any, "chat-1");

    // Should send TWO messages: the answer, then a re-ask
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const calls = sendMessage.mock.calls;
    expect(calls[0][1]).toMatch(/background-checked|vetted/);
    expect(calls[1][1]).toMatch(/1, 2, or 3/);

    // Crucially, task selection NOT advanced
    expect(taskDoc.ref.update).not.toHaveBeenCalled();
  });

  it("parses a numeric pick when LLM classifies as NOT a question", async () => {
    // isQuestionOrOther → NO
    quickComplete.mockResolvedValueOnce("NO");

    const taskDoc = makeTaskDoc([
      { name: "Alice", caregiverId: "c1" },
      { name: "Bob",   caregiverId: "c2" },
    ]);
    await handleTaskApproval(taskDoc, "1", {} as any, "chat-1");

    // The task should advance (update was called with pending_confirm)
    // Note: the actual call also depends on the caregiver doc lookup, which we
    // mocked to return exists:false → flow falls through to update + sendMessage("Got it...")
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/Alice/);
  });

  it("rejects out-of-range numeric pick", async () => {
    quickComplete.mockResolvedValueOnce("NO");

    const taskDoc = makeTaskDoc([{ name: "Alice" }, { name: "Bob" }]);
    await handleTaskApproval(taskDoc, "9", {} as any, "chat-1");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/Please reply 1, 2, or 3/);
  });
});
