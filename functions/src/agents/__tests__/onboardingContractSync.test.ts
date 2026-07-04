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
  CAREGIVER_COLLECTION_STEPS,
  CAREGIVER_FIRST_GATE_STEP,
  CLIENT_POST_COLLECTION_STEP as CONTRACT_POST_STEP,
  isFieldFilled as contractIsFieldFilled,
} from "../onboardingContract";
import {
  CLIENT_STEP_ORDER,
  CLIENT_POST_COLLECTION_STEP as LEGACY_POST_STEP,
  isFieldFilled as legacyIsFieldFilled,
} from "../onboardingConversation";
import { buildCaregiverSteps } from "../onboardingSteps.caregiver";

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

// Caregiver mirror of the drift guard. The scripted caregiver flow has no
// single exported step-order constant (part lives in the data-driven
// CAREGIVER_STEPS table, part in bespoke handlers), so this walks the table's
// nextStep chain and asserts the contract's CAREGIVER_COLLECTION_STEPS agrees
// with it — every table step id and every conversational nextStep must appear
// in the contract list, in the same relative order, and the chain must
// terminate at the contract's first gate step via the bespoke bio handler.
describe("onboardingContract <-> caregiver scripted flow sync", () => {
  const steps = buildCaregiverSteps({
    generateCaraMessage: async ({ fallback }) => fallback,
    locationPrompt: (base) => base,
  });

  it("every data-driven caregiver step is a contract collection step, in order", () => {
    for (const [id, step] of Object.entries(steps)) {
      expect(CAREGIVER_COLLECTION_STEPS, `table step '${id}' missing from contract`).toContain(id);
      // The caregiver table's transitions are all static step ids (never the
      // dynamic-function form ConversationStep also allows).
      const next = typeof step.nextStep === "string" ? step.nextStep : "";
      expect(next, `step '${id}' has a non-static nextStep`).not.toBe("");
      const from = CAREGIVER_COLLECTION_STEPS.indexOf(id);
      const to   = CAREGIVER_COLLECTION_STEPS.indexOf(next);
      expect(to, `nextStep '${next}' of '${id}' missing from contract`).toBeGreaterThan(-1);
      expect(to, `contract order disagrees with scripted transition ${id} -> ${next}`).toBeGreaterThan(from);
    }
  });

  it("the collection chain starts at caregiver_ask_name and ends at the bio step", () => {
    expect(CAREGIVER_COLLECTION_STEPS[0]).toBe("caregiver_ask_name");
    expect(CAREGIVER_COLLECTION_STEPS[CAREGIVER_COLLECTION_STEPS.length - 1]).toBe("caregiver_ask_bio");
  });

  it("the first gate step matches the scripted bio handoff (handleCaregiverAskBio -> caregiver_send_photo)", () => {
    expect(CAREGIVER_FIRST_GATE_STEP).toBe("caregiver_send_photo");
  });

  it("no gate/awaiting/confirm step leaked into the caregiver collection list", () => {
    for (const s of CAREGIVER_COLLECTION_STEPS) {
      expect(s.startsWith("caregiver_ask_")).toBe(true);
      expect(s).not.toBe("caregiver_ask_mvr"); // MVR consent is a gate-adjacent scripted step
    }
  });
});
