import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const addMock    = vi.fn().mockResolvedValue({ id: "doc-1" });
  const docGetMock = vi.fn().mockResolvedValue({ exists: false, data: () => null });

  // Stub appointment query results (where().where().where().orderBy().limit().get())
  const appointmentsQueryGetMock = vi.fn().mockResolvedValue({
    empty: false,
    docs: [
      {
        id:   "shift-1",
        data: () => ({
          date:       "2026-06-10",
          time:       "09:00",
          startTime:  "09:00",
          clientName: "Doe",
          clientId:   "client-1",
          seniorName: "Linda Doe",
        }),
      },
      {
        id:   "shift-2",
        data: () => ({
          date:       "2026-06-12",
          time:       "13:00",
          startTime:  "13:00",
          clientName: "Smith",
          clientId:   "client-2",
          seniorName: "John Smith",
        }),
      },
    ],
  });

  const sessionsGetMock = vi.fn().mockResolvedValue({ empty: true, docs: [] });

  // Chainable query mock — used by .where().where().where().orderBy().limit().get()
  const chain: any = {};
  chain.where    = vi.fn(() => chain);
  chain.orderBy  = vi.fn(() => chain);
  chain.limit    = vi.fn(() => chain);
  chain.get      = vi.fn(() => appointmentsQueryGetMock());

  const sessionsChain: any = {};
  sessionsChain.where = vi.fn(() => sessionsChain);
  sessionsChain.limit = vi.fn(() => sessionsChain);
  sessionsChain.get   = vi.fn(() => sessionsGetMock());

  const docFn = vi.fn(() => ({ update: updateMock, get: docGetMock }));

  const collectionMock = vi.fn((name: string) => {
    if (name === "agent_sessions") return { ...sessionsChain, doc: docFn };
    if (name === "appointments")   return { doc: docFn, ...chain };
    return { doc: docFn, add: addMock, ...chain };
  });

  const sendMessage             = vi.fn().mockResolvedValue({ message_id: "x" });
  const sendViaInteractionAgent = vi.fn().mockResolvedValue(undefined);
  const parseWithClaude         = vi.fn();
  const quickComplete           = vi.fn();
  // generateCaraMessage wraps an LLM call but deterministically returns its
  // `fallback` on empty/error output — that fallback is the contract the
  // graceful paths rely on, so the mock mirrors it instead of a constant.
  const generateCaraMessage     = vi.fn(async (...a: any[]) => a[0]?.fallback ?? "ack");
  const runEmergencyReplacement = vi.fn().mockResolvedValue(undefined);

  return {
    updateMock, addMock, docGetMock, appointmentsQueryGetMock, sessionsGetMock,
    sendMessage, sendViaInteractionAgent, parseWithClaude, quickComplete,
    generateCaraMessage, runEmergencyReplacement, collectionMock,
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: vi.fn(() => "__DELETE__"), arrayUnion: vi.fn((...v: unknown[]) => v) },
  }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: unknown[]) => hoisted.sendMessage(...args),
}));

vi.mock("../utils/parseWithClaude", () => ({
  parseWithClaude: (...args: unknown[]) => hoisted.parseWithClaude(...args),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: (...args: unknown[]) => hoisted.generateCaraMessage(...args),
}));

vi.mock("./caraAgent", () => ({
  sendViaInteractionAgent: (...args: unknown[]) => hoisted.sendViaInteractionAgent(...args),
}));

vi.mock("./replacementAgent", () => ({
  runEmergencyReplacement: (...args: unknown[]) => hoisted.runEmergencyReplacement(...args),
}));

const {
  updateMock, sendMessage, sendViaInteractionAgent, parseWithClaude,
  appointmentsQueryGetMock, docGetMock,
} = hoisted;

import { handleCaregiverCancelShift } from "./caregiverCancelShiftHandler";

const PHONE = "+15555550100";
const CHAT  = "chat-1";
const CG_ID = "cg-1";
const CG_NAME = "Maria Garcia";

describe("handleCaregiverCancelShift", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    sendViaInteractionAgent.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
    hoisted.runEmergencyReplacement.mockClear();
    hoisted.sessionsGetMock.mockResolvedValue({ empty: true, docs: [] });
    docGetMock.mockResolvedValue({ exists: true, data: () => ({}) });
    appointmentsQueryGetMock.mockResolvedValue({
      empty: false,
      docs: [
        { id: "shift-1", data: () => ({ date: "2026-06-10", time: "09:00", startTime: "09:00", clientName: "Doe", clientId: "client-1", seniorName: "Linda Doe" }) },
        { id: "shift-2", data: () => ({ date: "2026-06-12", time: "13:00", startTime: "13:00", clientName: "Smith", clientId: "client-2", seniorName: "John Smith" }) },
      ],
    });
  });

  it("identify_shift — lists upcoming shifts and advances state", async () => {
    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "I need to cancel a shift", {}, CHAT);
    // Lists shifts message sent
    expect(sendMessage).toHaveBeenCalled();
    const out = sendMessage.mock.calls[0][1] as string;
    expect(out).toMatch(/1\..*2026-06-10/);
    expect(out).toMatch(/2\..*2026-06-12/);
    // State advanced to confirm_shift with candidates stored
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      cancelStep:       "confirm_shift",
      cancelCandidates: expect.stringContaining("shift-1"),
    }));
  });

  it("identify_shift — no upcoming shifts → graceful message", async () => {
    appointmentsQueryGetMock.mockResolvedValueOnce({ empty: true, docs: [] });
    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "cancel a shift", {}, CHAT);
    expect(sendMessage.mock.calls[0][1]).toMatch(/don't have any upcoming shifts/);
  });

  it("confirm_shift — picks shift number and asks YES/NO", async () => {
    parseWithClaude.mockResolvedValueOnce("NO"); // isQuestionOrOther returns NO

    const session = {
      cancelStep: "confirm_shift",
      cancelCandidates: JSON.stringify([
        { index: 1, id: "shift-1", date: "2026-06-10", time: "09:00", clientName: "Doe", clientId: "client-1", seniorName: "Linda Doe", startTime: "09:00" },
        { index: 2, id: "shift-2", date: "2026-06-12", time: "13:00", clientName: "Smith", clientId: "client-2", seniorName: "John Smith", startTime: "13:00" },
      ]),
    };

    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "1", session, CHAT);
    expect(sendMessage).toHaveBeenCalled();
    const out = sendMessage.mock.calls[0][1] as string;
    expect(out).toMatch(/2026-06-10/);
    expect(out).toMatch(/YES.*cancel.*NO.*keep/i);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      cancelShiftId:   "shift-1",
      cancelShiftDate: "2026-06-10",
    }));
  });

  it("confirm_shift — bail-out keyword CANCEL clears state", async () => {
    const session = {
      cancelStep: "confirm_shift",
      cancelCandidates: JSON.stringify([{ index: 1, id: "s1", date: "d", time: "t", clientName: "c", clientId: "cl", seniorName: "s", startTime: "t" }]),
    };
    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "CANCEL", session, CHAT);
    expect(sendMessage.mock.calls[0][1]).toMatch(/unchanged/);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      cancelStep: "__DELETE__",
    }));
  });

  it("confirm_shift YES → advances to ask_reason", async () => {
    parseWithClaude
      .mockResolvedValueOnce("NO")   // isQuestionOrOther
      .mockResolvedValueOnce("YES"); // decision

    const session = {
      cancelStep:          "confirm_shift",
      cancelShiftId:       "shift-1",
      cancelCandidates:    JSON.stringify([{ index: 1, id: "shift-1", date: "2026-06-10", time: "09:00", clientName: "Doe", clientId: "client-1", seniorName: "Linda", startTime: "09:00" }]),
    };

    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "yes cancel it", session, CHAT);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      cancelStep: "ask_reason",
    }));
    expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/reason/i);
  });

  it("ask_reason — cancels and acknowledges while the appointment trigger owns family fan-out", async () => {
    parseWithClaude
      .mockResolvedValueOnce("NO")   // isQuestionOrOther
      .mockResolvedValueOnce("family emergency"); // reason summary

    docGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ seniorName: "Linda Doe", startTime: "09:00", clientName: "Doe" }),
    });

    const session = {
      cancelStep:          "ask_reason",
      cancelShiftId:       "shift-1",
      cancelShiftDate:     "2026-06-10",
      cancelShiftClientId: "client-1",
    };

    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "I'm sick", session, CHAT);

    // Appointment marked cancelled
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status:             "cancelled",
      cancelledBy:        "caregiver",
      cancellationReason: "family emergency",
    }));
    // State cleared
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      cancelStep:       "__DELETE__",
      cancelCandidates: "__DELETE__",
    }));
    // Caregiver acked
    expect(sendMessage).toHaveBeenCalled();
    // The Firestore appointment trigger is the sole family alert/replacement owner.
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(hoisted.runEmergencyReplacement).not.toHaveBeenCalled();
  });

  it("ask_reason — isQuestionOrOther answers and does NOT cancel", async () => {
    parseWithClaude
      .mockResolvedValueOnce("YES"); // isQuestionOrOther → question
    hoisted.quickComplete.mockResolvedValueOnce("Refunds work like this...");

    const session = {
      cancelStep:          "ask_reason",
      cancelShiftId:       "shift-1",
      cancelShiftDate:     "2026-06-10",
      cancelShiftClientId: "client-1",
    };

    await handleCaregiverCancelShift(CG_ID, CG_NAME, PHONE, "wait — do I get a refund if I cancel?", session, CHAT);

    // Appointment NOT marked cancelled
    expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    // No family alert
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    // No replacement
    expect(hoisted.runEmergencyReplacement).not.toHaveBeenCalled();
    // But the question was answered
    const out = sendMessage.mock.calls[0][1] as string;
    expect(out).toMatch(/Refunds/);
  });
});
