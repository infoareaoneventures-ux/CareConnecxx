import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: Object.assign(() => ({ collection: vi.fn() }), {
    FieldValue: {
      arrayUnion: vi.fn(),
      arrayRemove: vi.fn(),
      delete: vi.fn(),
    },
  }),
}));

vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  default: {
    https: {
      onCall: (fn: any) => fn,
      HttpsError: class HttpsError extends Error {
        code: string;
        constructor(code: string, message: string) {
          super(message);
          this.code = code;
        }
      },
    },
  },
  https: {
    onCall: (fn: any) => fn,
    HttpsError: class HttpsError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  },
}));

vi.mock("../../linq/client", () => ({
  createChat: vi.fn(),
  sendMessage: vi.fn(),
  sendToPhone: vi.fn(),
  addParticipant: vi.fn(),
  updateChatName: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn() }));

beforeEach(() => {
  process.env.JWT_SECRET = "test-secret";
});

import { createFamilyJoinToken, verifyFamilyJoinToken } from "../familyGroupManager";

describe("family join tokens", () => {
  it("accepts signed family_join tokens", () => {
    const token = createFamilyJoinToken("+15550001111", "Maria");
    expect(verifyFamilyJoinToken(token)).toEqual({
      primaryPhone: "+15550001111",
      seniorName: "Maria",
    });
  });

  it("rejects unsigned legacy base64 payloads", () => {
    const legacy = Buffer.from(JSON.stringify({
      primaryPhone: "+15550001111",
      seniorName: "Maria",
    })).toString("base64");
    expect(verifyFamilyJoinToken(legacy)).toBeNull();
  });
});
