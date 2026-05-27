import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const addMock    = vi.fn().mockResolvedValue({ id: "doc-1" });
  const docGetMock = vi.fn().mockResolvedValue({ exists: false, data: () => null });

  const docFn = vi.fn(() => ({
    update: updateMock,
    get:    docGetMock,
  }));
  const collectionMock = vi.fn(() => ({
    doc: docFn,
    add: addMock,
  }));

  const sendMessage = vi.fn().mockResolvedValue({ message_id: "x" });
  const sendViaInteractionAgent = vi.fn().mockResolvedValue(undefined);
  const quickComplete = vi.fn();

  return { updateMock, addMock, docGetMock, collectionMock, sendMessage, sendViaInteractionAgent, quickComplete };
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
}));

vi.mock("./caraAgent", () => ({
  sendViaInteractionAgent: (...args: unknown[]) => hoisted.sendViaInteractionAgent(...args),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

const { updateMock, addMock, sendMessage, sendViaInteractionAgent, quickComplete, docGetMock } = hoisted;

import { handleClientShiftConfirm } from "./clientShiftConfirmHandler";

const pending = {
  appointmentId: "appt-123",
  appointmentDate: "2026-05-24",
  appointmentDisplay: "Sunday, May 24",
  caregiverId: "cg-1",
  caregiverName: "Alice Martinez",
  seniorName: "Linda",
  startTime: "9:00 AM",
  sentAt: new Date().toISOString(),
};

describe("handleClientShiftConfirm", () => {
  beforeEach(() => {
    sendMessage.mockClear();
    sendViaInteractionAgent.mockClear();
    updateMock.mockClear();
    addMock.mockClear();
    quickComplete.mockReset();
    docGetMock.mockResolvedValue({ exists: false, data: () => null });
  });

  it("returns silently when no pendingClientShiftConfirm present", async () => {
    await handleClientShiftConfirm("+15555550100", "chat-1", "anything", {});
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("CONFIRM clears state and acks", async () => {
    quickComplete.mockResolvedValue("CONFIRM");
    await handleClientShiftConfirm("+15555550100", "chat-1", "yes we'll be here",
      { pendingClientShiftConfirm: pending });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/Alice/);
    expect(updateMock).toHaveBeenCalled();
  });

  it("CANCEL writes client_cancel_requests + alerts ops + notifies caregiver", async () => {
    quickComplete.mockResolvedValue("CANCEL");
    docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ phone: "+15555550200" }) });
    await handleClientShiftConfirm("+15555550100", "chat-1", "cancel please",
      { pendingClientShiftConfirm: pending });

    // client_cancel_requests doc was added
    expect(addMock).toHaveBeenCalled();
    // Caregiver was notified
    expect(sendViaInteractionAgent).toHaveBeenCalled();
    // Final confirmation message to family
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/cancelled/i);
  });

  it("QUESTION generates an answer then re-prompts (in that order)", async () => {
    quickComplete.mockResolvedValueOnce("QUESTION");                  // verdict
    quickComplete.mockResolvedValueOnce("Yes, Alice has been with us for 6 months."); // answer
    await handleClientShiftConfirm("+15555550100", "chat-1", "how long has Alice been with you?",
      { pendingClientShiftConfirm: pending });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][1]).toMatch(/Alice/);
    expect(sendMessage.mock.calls[1][1]).toMatch(/reply CANCEL/i);
    // State NOT cleared on question
    expect(addMock).not.toHaveBeenCalled();
  });

  it("unrecognized verdict (not CONFIRM/CANCEL) falls through to QUESTION", async () => {
    quickComplete.mockResolvedValueOnce("MAYBE");                     // unrecognized verdict
    quickComplete.mockResolvedValueOnce("fallback answer");
    await handleClientShiftConfirm("+15555550100", "chat-1", "ambiguous reply",
      { pendingClientShiftConfirm: pending });
    // 2 messages sent (answer + re-prompt), state NOT cleared
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(addMock).not.toHaveBeenCalled();
  });
});
