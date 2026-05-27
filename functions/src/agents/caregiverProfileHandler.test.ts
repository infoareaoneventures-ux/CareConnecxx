import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docGetMock = vi.fn().mockResolvedValue({ exists: true, data: () => ({ specialties: ["companionship"] }) });

  const docFn = vi.fn(() => ({ update: updateMock, get: docGetMock }));
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  const sendMessage         = vi.fn().mockResolvedValue({ message_id: "x" });
  const parseWithClaude     = vi.fn();
  const quickComplete       = vi.fn();
  const generateCaraMessage = vi.fn().mockResolvedValue("ack");
  const generateToken       = vi.fn(() => "token-abc");

  return { updateMock, docGetMock, collectionMock, sendMessage, parseWithClaude, quickComplete, generateCaraMessage, generateToken };
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

vi.mock("../utils/parseWithClaude", () => ({
  parseWithClaude: (...args: unknown[]) => hoisted.parseWithClaude(...args),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: (...args: unknown[]) => hoisted.generateCaraMessage(...args),
}));

vi.mock("./tokenService", () => ({
  generateToken: (...args: unknown[]) => hoisted.generateToken(...args),
}));

const { updateMock, sendMessage, parseWithClaude, docGetMock } = hoisted;

import { handleCaregiverProfileUpdate, profileFieldFromIntent } from "./caregiverProfileHandler";

const CG_ID = "cg-1";
const PHONE = "+15555550100";
const CHAT  = "chat-1";

describe("caregiverProfileHandler", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
    docGetMock.mockResolvedValue({ exists: true, data: () => ({ specialties: ["companionship"] }) });
  });

  describe("profileFieldFromIntent", () => {
    it("maps each profile-update intent to a field", () => {
      expect(profileFieldFromIntent("UPDATE_RATE")).toBe("rate");
      expect(profileFieldFromIntent("UPDATE_SKILLS")).toBe("skills");
      expect(profileFieldFromIntent("UPDATE_BIO")).toBe("bio");
      expect(profileFieldFromIntent("UPDATE_PHOTO")).toBe("photo");
      expect(profileFieldFromIntent("PAUSE_ACCOUNT")).toBe("pause");
      expect(profileFieldFromIntent("REACTIVATE")).toBe("reactivate");
      expect(profileFieldFromIntent("SOMETHING_ELSE")).toBeUndefined();
    });
  });

  describe("RATE flow", () => {
    it("collect step — parses rate, advances to confirm", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("28"); // rate value

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "change my rate to $28", {}, CHAT, "rate");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "rate",
        profileUpdateValue: "28",
      }));
      expect(sendMessage.mock.calls[0][1]).toMatch(/\$28\/hr.*YES.*NO/i);
    });

    it("collect step — rejects out-of-range rate", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("500"); // rate

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "raise to $500", {}, CHAT, "rate");

      expect(sendMessage.mock.calls[0][1]).toMatch(/between \$15 and \$150/);
      // State NOT advanced
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
    });

    it("confirm step YES saves rate to Firestore", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes save it",
        { profileUpdateStep: "confirm", profileUpdateField: "rate", profileUpdateValue: "28" },
        CHAT, "rate",
      );

      // Caregiver doc updated
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        hourlyRate: 28,
      }));
      // Flow state cleared
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep: "__DELETE__",
      }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/\$28\/hr/);
    });

    it("confirm step NO does NOT save", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("NO"); // decision

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "never mind",
        { profileUpdateStep: "confirm", profileUpdateField: "rate", profileUpdateValue: "28" },
        CHAT, "rate",
      );

      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 28 }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/wasn't changed/);
    });
  });

  describe("SKILLS flow", () => {
    it("collect step — parses add action and shows proposed skills", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce('{"action":"add","skills":["dementia","hospice"]}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add dementia and hospice", {}, CHAT, "skills");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "skills",
      }));
      const proposedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const proposed = JSON.parse(proposedJson);
      expect(proposed).toContain("companionship"); // existing kept
      expect(proposed).toContain("dementia");
      expect(proposed).toContain("hospice");
    });

    it("collect step — remove action", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"remove","skills":["companionship"]}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "remove companionship", {}, CHAT, "skills");

      const proposedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const proposed = JSON.parse(proposedJson);
      expect(proposed).not.toContain("companionship");
    });
  });

  describe("BIO flow", () => {
    it("collect step — accepts text >= 15 chars and advances to confirm", async () => {
      parseWithClaude.mockResolvedValueOnce("NO"); // isQuestionOrOther

      const newBio = "Compassionate CNA with 8 years of dementia experience.";
      await handleCaregiverProfileUpdate(CG_ID, PHONE, newBio, {}, CHAT, "bio");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "bio",
        profileUpdateValue: newBio,
      }));
    });

    it("collect step — rejects too-short bio", async () => {
      parseWithClaude.mockResolvedValueOnce("NO");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "hi", {}, CHAT, "bio");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
    });
  });

  describe("PAUSE flow", () => {
    it("collect step — parses until date and advances to confirm", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO") // isQuestionOrOther
        .mockResolvedValueOnce('{"until":"2026-07-12"}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "going on vacation until July 12", {}, CHAT, "pause");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "pause",
        profileUpdateValue: "2026-07-12",
      }));
      expect(sendMessage.mock.calls[0][1]).toMatch(/until 2026-07-12/);
    });

    it("confirm YES writes pausedUntil to caregiver doc", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes",
        { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "2026-07-12" },
        CHAT, "pause",
      );

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "2026-07-12",
      }));
    });

    it("indefinite pause writes a far-future date", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes",
        { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "indefinite" },
        CHAT, "pause",
      );

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "2099-12-31",
      }));
    });
  });

  describe("REACTIVATE flow", () => {
    it("clears pausedUntil and acknowledges", async () => {
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "reactivate", {}, CHAT, "reactivate");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "__DELETE__",
      }));
    });
  });

  describe("PHOTO flow", () => {
    it("sends a web upload link", async () => {
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "change my photo", {}, CHAT, "photo");

      // First call is the intro text, second is the link
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      const linkMsg = sendMessage.mock.calls.at(-1)?.[1];
      expect(linkMsg).toEqual(expect.objectContaining({
        parts: expect.arrayContaining([expect.objectContaining({ type: "link" })]),
      }));
    });
  });
});
