import { describe, it, expect, vi } from "vitest";

// onboardingContract.ts is a pure leaf that MIRRORS constants from the heavy
// onboardingConversation.ts (which it can't import without dragging in the whole
// onboarding graph). This test is the mechanical drift guard: it imports both and
// asserts the mirrors stay in sync. Without it, M-1 drift (the exact class behind
// the schedule-field bug) is invisible until production.
//
// Importing onboardingConversation loads admin.firestore()/storage() at module
// init, so stub firebase-admin enough to survive the import.
vi.mock("firebase-admin", () => {
  const docRef = { get: async () => ({ exists: false, data: () => undefined }), set: async () => {}, update: async () => {}, collection: () => collRef };
  const collRef: any = { doc: () => docRef, where: () => collRef, limit: () => collRef, get: async () => ({ docs: [] }) };
  const firestore: any = () => ({ collection: () => collRef, runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false }), set: () => {}, update: () => {} }) });
  firestore.FieldValue = { delete: () => undefined, serverTimestamp: () => undefined, arrayUnion: (...a: unknown[]) => a };
  firestore.Timestamp = { fromMillis: (m: number) => ({ toMillis: () => m }), now: () => ({ toMillis: () => 0 }) };
  const storage = () => ({ bucket: () => ({ file: () => ({ save: async () => {}, download: async () => [Buffer.from("")], exists: async () => [false] }) }) });
  return { __esModule: true, default: { apps: [{}], initializeApp: () => ({}), firestore, storage }, apps: [{}], initializeApp: () => ({}), firestore, storage };
});

import {
  CLIENT_COLLECTION_STEPS,
  CLIENT_POST_COLLECTION_STEP as CONTRACT_POST_STEP,
  isFieldFilled as contractIsFieldFilled,
} from "../onboardingContract";
import {
  CLIENT_STEP_ORDER,
  CLIENT_POST_COLLECTION_STEP as LEGACY_POST_STEP,
  isFieldFilled as legacyIsFieldFilled,
} from "../onboardingConversation";

describe("onboardingContract <-> onboardingConversation sync (M-1 drift guard)", () => {
  it("CLIENT_COLLECTION_STEPS mirrors the legacy CLIENT_STEP_ORDER", () => {
    expect([...CLIENT_COLLECTION_STEPS]).toEqual([...CLIENT_STEP_ORDER]);
  });

  it("CLIENT_POST_COLLECTION_STEP matches the legacy handoff step", () => {
    expect(CONTRACT_POST_STEP).toBe(LEGACY_POST_STEP);
  });

  it("isFieldFilled behaves identically to the legacy implementation", () => {
    const cases: unknown[] = [undefined, null, "", "  ", "x", 0, 1, -1, [], [1], {}, { a: 1 }, true, false];
    for (const v of cases) {
      expect(contractIsFieldFilled(v)).toBe(legacyIsFieldFilled(v));
    }
  });
});
