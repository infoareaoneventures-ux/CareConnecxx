import { describe, expect, it } from "vitest";
import {
  CARA_TRAINING_DATASET_VERSION,
  STARTER_CARA_TRAINING_EXAMPLES,
  assertTrainingExampleCaptureAllowed,
  exportCaraTrainingJsonl,
  toCaraEvalCases,
  type CaraTrainingExample,
} from "./caraTrainingDataset";

describe("Evia training dataset", () => {
  it("keeps stable unique ids and launch-critical coverage", () => {
    const ids = new Set(STARTER_CARA_TRAINING_EXAMPLES.map((example) => example.id));
    expect(ids.size).toBe(STARTER_CARA_TRAINING_EXAMPLES.length);
    expect(STARTER_CARA_TRAINING_EXAMPLES.length).toBeGreaterThanOrEqual(20);

    const intents = new Set(STARTER_CARA_TRAINING_EXAMPLES.map((example) => example.labels.intent));
    for (const intent of [
      "family_member_add",
      "recipe_discovery_context",
      "visit_confirmation",
      "share_latest_update",
      "caregiver_shift_closeout",
      "safety_emergency",
      "medical_boundary",
      "shift_hours_approve",
      "shift_hours_dispute",
      "caregiver_approval_status",
      "caregiver_referral",
      "caregiver_safety_report",
      "memory_forget_or_correction",
    ]) {
      expect(intents.has(intent), `missing intent coverage: ${intent}`).toBe(true);
    }
  });

  it("covers the initial care recipe tool surface", () => {
    const allTools = new Set(
      STARTER_CARA_TRAINING_EXAMPLES.flatMap((example) => example.labels.expectedTools),
    );
    for (const tool of [
      "get_upcoming_appointments",
      "send_caregiver_message",
      "find_replacement_caregivers",
      "get_care_journal_client",
      "add_family_member",
      "review_shift_hours",
      "complete_shift",
      "submit_shift_hours",
      "get_payout_history",
      "create_caregiver_referral",
      "update_memory_file",
    ]) {
      expect(allTools.has(tool), `missing recipe tool coverage: ${tool}`).toBe(true);
    }
  });

  it("requires risk, forbidden behavior, and ideal response for every example", () => {
    for (const example of STARTER_CARA_TRAINING_EXAMPLES) {
      expect(example.message.trim(), example.id).not.toBe("");
      expect(example.context.trim(), example.id).not.toBe("");
      expect(example.idealResponse.trim(), example.id).not.toBe("");
      expect(example.labels.intent.trim(), example.id).not.toBe("");
      expect(example.labels.forbidden.length, example.id).toBeGreaterThan(0);
      expect(example.reviewer.pii, example.id).toMatch(/^(synthetic|redacted)$/);
    }
  });

  it("keeps high-risk and critical examples out of unsafe medical/action advice", () => {
    const risky = STARTER_CARA_TRAINING_EXAMPLES.filter((example) =>
      example.labels.risk === "high" || example.labels.risk === "critical");

    expect(risky.length).toBeGreaterThanOrEqual(8);
    for (const example of risky) {
      const response = example.idealResponse.toLowerCase();
      expect(response, example.id).not.toContain("give another pill");
      expect(response, example.id).not.toContain("go back");
      expect(response, example.id).not.toContain("wait until tomorrow");
    }

    const critical = STARTER_CARA_TRAINING_EXAMPLES.filter((example) => example.labels.risk === "critical");
    expect(critical.every((example) => example.idealResponse.includes("911"))).toBe(true);
  });

  it("exports parseable JSONL for future fine-tune or labeling pipelines", () => {
    const lines = exportCaraTrainingJsonl().split("\n");
    expect(lines.length).toBe(STARTER_CARA_TRAINING_EXAMPLES.length);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first.version).toBe(CARA_TRAINING_DATASET_VERSION);
    expect(first).toHaveProperty("labels");
    expect(first).toHaveProperty("idealResponse");
  });

  it("projects dataset examples into the existing eval case shape", () => {
    const evalCases = toCaraEvalCases();
    expect(evalCases).toHaveLength(STARTER_CARA_TRAINING_EXAMPLES.length);
    expect(evalCases.every((testCase) => testCase.category.startsWith("cara_dataset_"))).toBe(true);
    expect(evalCases.some((testCase) => testCase.mustContain?.includes("911"))).toBe(true);
    expect(evalCases.some((testCase) => testCase.mustNotContain?.includes("contact support"))).toBe(true);
  });

  // ── Childcare U10 (R50/KTD17): real childcare turns never enter the dataset ─
  describe("childcare capture denial", () => {
    const base: CaraTrainingExample = {
      id: "cc-fixture",
      split: "eval",
      source: "synthetic_seed",
      userRole: "client",
      channel: "web_chat",
      message: "synthetic childcare fixture",
      context: "synthetic",
      labels: {
        intent: "childcare_status", risk: "low", missingInfo: [], expectedTools: [],
        expectedCollections: [], expectedPageVisibility: [], forbidden: [], humanReviewRequired: false,
      },
      idealResponse: "synthetic",
      reviewer: { status: "approved_seed", pii: "synthetic" },
      careVertical: "child",
    };

    it("the shipped starter dataset contains ZERO childcare-vertical examples", () => {
      expect(STARTER_CARA_TRAINING_EXAMPLES.filter((e) => e.careVertical === "child")).toEqual([]);
    });

    it("admits a fully synthetic childcare seed fixture", () => {
      expect(() => assertTrainingExampleCaptureAllowed(base)).not.toThrow();
    });

    it("rejects a childcare example sourced from production review (a real turn)", () => {
      expect(() => assertTrainingExampleCaptureAllowed({
        ...base, source: "production_review", reviewer: { status: "approved_production", pii: "redacted" },
      })).toThrow(/never captured/);
      expect(() => assertTrainingExampleCaptureAllowed({
        ...base, source: "failed_turn_review",
      })).toThrow(/never captured/);
    });

    it("rejects a childcare example whose PII is merely redacted (not synthetic)", () => {
      expect(() => assertTrainingExampleCaptureAllowed({
        ...base, reviewer: { status: "approved_seed", pii: "redacted" },
      })).toThrow(/never captured/);
    });

    it("senior examples are unaffected regardless of source", () => {
      expect(() => assertTrainingExampleCaptureAllowed({
        ...base, careVertical: undefined, source: "production_review",
      })).not.toThrow();
    });
  });
});
