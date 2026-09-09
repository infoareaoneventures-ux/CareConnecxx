import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-09 (live-caught): the "I'd already sent their info before — want
// me to send their profiles again?" re-offer message has been a standing,
// unfulfillable promise since 2026-09-07 — there was no tool to actually
// resend a caregiver's profile. This is that tool.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
  });
  return {
    docState,
    collection: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: Object.assign(() => ({ collection: hoisted.collection }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendMessage: (...args: unknown[]) => sendMessage(...args) }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const CAREGIVER = "cg1";
const PHONE = "+15551234567";
const baseInput = { clientId: CLIENT, caregiverId: CAREGIVER, phone: PHONE };

describe("resend_caregiver_profile", () => {
  beforeEach(() => {
    hoisted.reset();
    sendMessage.mockClear();
  });

  it("requires clientId and caregiverId", async () => {
    const r = await handleToolCall("resend_caregiver_profile", { phone: PHONE }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("requires phone", async () => {
    const r = await handleToolCall("resend_caregiver_profile", { clientId: CLIENT, caregiverId: CAREGIVER }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("fails NOT_FOUND when there is no active conversation for this phone", async () => {
    const r = await handleToolCall("resend_caregiver_profile", baseInput) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fails NOT_FOUND when the caregiver isn't in publicCaregiverProfiles", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat_1" });
    const r = await handleToolCall("resend_caregiver_profile", baseInput) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends the profile card with the caregiver's name, rate, and tappable /p/{id} link", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat_1" });
    hoisted.docState.set(`publicCaregiverProfiles/${CAREGIVER}`, {
      name: "Basra Yousuf",
      hourlyRate: 28,
      specialties: ["Dementia care", "Mobility assistance"],
    });

    const r = await handleToolCall("resend_caregiver_profile", baseInput) as any;

    expect(r.success).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.caregiverName).toBe("Basra Yousuf");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, message] = sendMessage.mock.calls[0];
    expect(chatId).toBe("chat_1");
    expect(message).toContain("Basra Yousuf");
    expect(message).toContain("$28/hr");
    expect(message).toContain("Dementia care, Mobility assistance");
    expect(message).toContain("https://eviacares.com/p/cg1");
  });

  it("never guesses a name-shaped id — resolves strictly by the given caregiverId", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat_1" });
    // No doc at publicCaregiverProfiles/"Basra Yousuf" — a name is not a real id.
    const r = await handleToolCall("resend_caregiver_profile", { ...baseInput, caregiverId: "Basra Yousuf" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });
});
