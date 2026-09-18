import { describe, it, expect, vi } from "vitest";

// shiftHours.ts pulls in firebase-admin + firebase-functions at import time.
// Stub them so the module loads in the test environment; we only exercise the
// pure sanitizeShiftLineItems helper.
vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: () => ({}) });
  firestore.FieldValue = { serverTimestamp: () => ({}), arrayUnion: (...a: any[]) => ({ a }) };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});
vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error { constructor(public code: string, msg: string) { super(msg); } }
  return { https: { HttpsError, onCall: (f: any) => f }, firestore: { document: () => ({ onWrite: (f: any) => f, onUpdate: (f: any) => f }) }, pubsub: { schedule: () => ({ onRun: (f: any) => f }) }, config: () => ({}) };
});

vi.mock("./sms", () => ({ sendSMSToUser: vi.fn(async () => ({ success: true })) }));

import { sanitizeShiftLineItems } from "./shiftHours";

describe("sanitizeShiftLineItems — clamp/whitelist for charged amounts", () => {
  it("drops negative amounts (the correction/counter under-charge exploit)", () => {
    const out = sanitizeShiftLineItems([{ type: "bonus", amount: -500 }]);
    expect(out).toEqual([]);
  });

  it("drops zero and non-numeric amounts", () => {
    const out = sanitizeShiftLineItems([
      { type: "bonus", amount: 0 },
      { type: "bonus", amount: "abc" },
      { type: "bonus", amount: NaN },
    ]);
    expect(out).toEqual([]);
  });

  it("keeps positive amounts and rounds to cents", () => {
    const out = sanitizeShiftLineItems([{ type: "mileage", amount: 12.345 }]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(12.35);
    expect(out[0].type).toBe("mileage");
  });

  it("coerces unknown types to 'custom'", () => {
    const out = sanitizeShiftLineItems([{ type: "hackerfee", amount: 10 }]);
    expect(out[0].type).toBe("custom");
  });

  it("truncates over-long label/note", () => {
    const out = sanitizeShiftLineItems([{ type: "custom", amount: 5, label: "x".repeat(500), note: "y".repeat(1000) }]);
    expect(out[0].label.length).toBe(100);
    expect(out[0].note.length).toBe(500);
  });

  it("returns [] for non-array / garbage input", () => {
    expect(sanitizeShiftLineItems(undefined)).toEqual([]);
    expect(sanitizeShiftLineItems(null)).toEqual([]);
    expect(sanitizeShiftLineItems("nope")).toEqual([]);
    expect(sanitizeShiftLineItems([null, 42, "x"])).toEqual([]);
  });
});
