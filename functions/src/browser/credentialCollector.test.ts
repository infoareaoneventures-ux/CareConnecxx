import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({ update: updateMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  const sendViaInteractionAgent = vi.fn().mockResolvedValue(undefined);
  const storeCredential = vi.fn().mockResolvedValue(undefined);
  const quickComplete = vi.fn();
  return { updateMock, docMock, collectionMock, sendViaInteractionAgent, storeCredential, quickComplete };
});

vi.mock("firebase-admin", () => {
  const firestoreFn: any = () => ({ collection: hoisted.collectionMock });
  firestoreFn.FieldValue = { delete: () => "__DELETE__" };
  return { __esModule: true, default: { firestore: firestoreFn }, firestore: firestoreFn };
});

vi.mock("../agents/caraAgent", () => ({
  sendViaInteractionAgent: (...args: unknown[]) => hoisted.sendViaInteractionAgent(...args),
}));

vi.mock("./credentialVault", () => ({
  storeCredential: (...args: unknown[]) => hoisted.storeCredential(...args),
  PortalService: {},
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

const { updateMock, sendViaInteractionAgent, storeCredential, quickComplete } = hoisted;

import { handleCredentialReply } from "./credentialCollector";

describe("handleCredentialReply — never stores a question as a credential", () => {
  beforeEach(() => {
    sendViaInteractionAgent.mockClear();
    storeCredential.mockReset();
    updateMock.mockClear();
    quickComplete.mockReset();
  });

  it.each([
    "is this safe?",
    "why do you need my password",
    "what happens if I share this",
    "How are you protecting this?",
    "Is this encrypted?",
  ])("does NOT store %p as username", async (q) => {
    // No LLM call needed — the heuristic regex catches these.
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    q,
      session: {
        collectingCredential:        true,
        collectingCredentialSetAt:   new Date().toISOString(),
        collectingCredentialService: "mychart",
        collectingCredentialStep:    "username",
      },
    });
    expect(result).toBe(true);
    expect(updateMock).not.toHaveBeenCalled(); // state not advanced
    expect(storeCredential).not.toHaveBeenCalled();
    // 2 outbound messages: answer + re-ask
    expect(sendViaInteractionAgent).toHaveBeenCalledTimes(2);
  });

  it("does NOT store a question as password (security-critical)", async () => {
    // Multi-sentence question — heuristic catches before LLM.
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "Is this really safe? Where will you store it?",
      session: {
        collectingCredential:         true,
        collectingCredentialSetAt:    new Date().toISOString(),
        collectingCredentialService:  "mychart",
        collectingCredentialStep:     "password",
        collectingCredentialUsername: "alice@example.com",
      },
    });
    expect(result).toBe(true);
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it("stores a valid-looking username when LLM confirms it", async () => {
    quickComplete.mockResolvedValueOnce("YES"); // username classifier
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "alice@example.com",
      session: {
        collectingCredential:        true,
        collectingCredentialSetAt:   new Date().toISOString(),
        collectingCredentialService: "mychart",
        collectingCredentialStep:    "username",
      },
    });
    expect(result).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      collectingCredentialUsername: "alice@example.com",
      collectingCredentialStep:     "password",
    }));
  });

  it("fails closed when LLM errors during username classification", async () => {
    quickComplete.mockRejectedValueOnce(new Error("openai down"));
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "alice@example.com",
      session: {
        collectingCredential:        true,
        collectingCredentialSetAt:   new Date().toISOString(),
        collectingCredentialService: "mychart",
        collectingCredentialStep:    "username",
      },
    });
    expect(result).toBe(true);
    // LLM failure → treat as question → don't advance
    expect(updateMock).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).toHaveBeenCalledTimes(2);
  });

  it("returns false when not in credential collection mode", async () => {
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "anything",
      session: {},
    });
    expect(result).toBe(false);
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  it("clears a STALE flow (started 2h ago) and hands the text back to normal routing", async () => {
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "hi, checking on mom's visit tomorrow",
      session: {
        collectingCredential:        true,
        collectingCredentialSetAt:   new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        collectingCredentialService: "mychart",
        collectingCredentialStep:    "username",
      },
    });
    expect(result).toBe(false);                       // not consumed — normal routing continues
    expect(storeCredential).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);      // the clear
    expect(sendViaInteractionAgent).not.toHaveBeenCalled(); // silent expiry
  });

  it("treats an UNSTAMPED legacy flow as stale (never-expires guard)", async () => {
    const result = await handleCredentialReply({
      phone:   "+15555550100",
      userId:  "u1",
      text:    "alice@example.com",
      session: {
        collectingCredential:        true,
        collectingCredentialService: "mychart",
        collectingCredentialStep:    "username",
      },
    });
    expect(result).toBe(false);
    expect(storeCredential).not.toHaveBeenCalled();
  });
});
