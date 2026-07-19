import { describe, it, expect } from "vitest";
import {
  classifyGroundingClaims,
  detectGroundingClaim,
  highestGroundingRisk,
  claimCategories,
  riskForCategory,
  groundingTelemetryHash,
  type GroundingClaimCategory,
} from "./groundingClaims";
import { GROUNDING_NEUTRAL_COPY, HUMAN_HANDOFF_COPY } from "./humanHandoff";

function categoriesOf(draft: string): GroundingClaimCategory[] {
  return classifyGroundingClaims(draft).map((c) => c.category);
}

describe("classifyGroundingClaims — plan false-negative fixtures (R18)", () => {
  // Each of these slipped past the legacy detectConfidenceClaim because it has
  // no proper name / "I …" in the sentence. They MUST classify now.
  it.each([
    ["She has Parkinson's.",                     "medical_condition", "high"],
    ["He has kidney disease.",                   "medical_condition", "high"],
    ["Your dad has type 2 diabetes.",            "medical_condition", "high"],
    ["She is allergic to penicillin.",           "allergy",           "high"],
    ["She had a stroke last year.",              "medical_event",     "high"],
    ["He was hospitalized in March.",            "medical_event",     "high"],
    ["She fell last Tuesday.",                   "medical_event",     "high"],
    ["She is 82.",                               "age",               "low"],
    ["Your mom is 82 years old.",                "age",               "low"],
    ["She lives in Sacramento.",                 "location",          "low"],
    ["He is her son.",                           "relationship_identity", "high"],
    ["Her primary physician is Dr. Chen.",       "relationship_identity", "high"],
    ["She is available tomorrow afternoon.",     "caregiver_availability", "low"],
    ["The payment went through this morning.",   "money_payment",     "high"],
    ["Your refund was processed yesterday.",     "money_payment",     "high"],
    ["I've cancelled Thursday's visit for you.", "action_authorization", "high"],
    ["I authorized the charge on your card.",    "action_authorization", "high"],
    ["Your booking has been confirmed.",         "action_authorization", "high"],
  ] as const)("%p → %s (%s risk)", (draft, category, risk) => {
    const claims = classifyGroundingClaims(draft);
    expect(claimCategories(claims)).toContain(category);
    expect(claims.find((c) => c.category === category)?.risk).toBe(risk);
  });
});

describe("classifyGroundingClaims — absorbs every legacy detectConfidenceClaim fixture", () => {
  // Nothing the pre-U7 detector caught may be lost (U7 exit criterion). These
  // are the exact positive fixtures from qaAgent.test.ts detectConfidenceClaim.
  it.each([
    "Maria is free Wednesday.",
    "Alice is sick today.",
    "Sarah is coming at 9.",
    "I confirmed the appointment.",
    "Maria will arrive at 3pm.",
    "Dr. Chen is her primary physician.",
    "Your invoice was $340.",
    "Your mom has an appointment Tuesday at 2.",
    "She was diagnosed with diabetes.",
  ])("still catches %p", (draft) => {
    expect(detectGroundingClaim(draft)).toBe(true);
  });

  it("maps legacy fixtures to sensible categories", () => {
    expect(categoriesOf("Maria is free Wednesday.")).toContain("caregiver_availability");
    expect(categoriesOf("I confirmed the appointment.")).toContain("action_authorization");
    expect(categoriesOf("Your invoice was $340.")).toContain("money_payment");
    expect(categoriesOf("Your mom has an appointment Tuesday at 2.")).toContain("schedule_appointment");
    expect(categoriesOf("She was diagnosed with diabetes.")).toContain("medical_condition");
    expect(categoriesOf("Dr. Chen is her primary physician.")).toContain("relationship_identity");
  });
});

describe("classifyGroundingClaims — negative controls (no claims)", () => {
  it.each([
    ["Maria's notes mention smaller meals.",       "proper-name + ordinary verb"],
    ["I'll ask Alice about Wednesday.",            "future-tense ask, no assertion"],
    ["Let me check her schedule.",                 "promise without assertion"],
    ["Thanks so much! That means a lot.",          "pure pleasantry"],
    ["Hey! How's everything going?",               "fallback greeting"],
    ["It might be worth asking her doctor about that.", "hedged, no flat assertion"],
    ["",                                           "empty"],
  ])("does NOT classify %p (%s)", (draft) => {
    expect(classifyGroundingClaims(draft)).toEqual([]);
    expect(detectGroundingClaim(draft)).toBe(false);
  });

  it("a visit duration is not an age claim", () => {
    expect(categoriesOf("The visit is 30 minutes long.")).not.toContain("age");
  });

  it("deterministic safety copy never classifies — the gate cannot loop on its own output", () => {
    // If any of these matched, a neutralized/handed-off turn would re-enter the
    // gate as a fresh candidate on the next self-repeat/rewrite pass.
    expect(classifyGroundingClaims(HUMAN_HANDOFF_COPY)).toEqual([]);
    for (const copy of Object.values(GROUNDING_NEUTRAL_COPY)) {
      expect(classifyGroundingClaims(copy)).toEqual([]);
    }
  });
});

describe("risk tiers (R18/R19)", () => {
  it.each([
    ["medical_condition", "high"],
    ["allergy", "high"],
    ["medical_event", "high"],
    ["relationship_identity", "high"],
    ["action_authorization", "high"],
    ["money_payment", "high"],
    ["age", "low"],
    ["location", "low"],
    ["schedule_appointment", "low"],
    ["caregiver_availability", "low"],
  ] as const)("%s is %s risk", (category, risk) => {
    expect(riskForCategory(category)).toBe(risk);
  });

  it("highestGroundingRisk: any high-risk claim dominates", () => {
    const mixed = classifyGroundingClaims("She is 82 and she has Parkinson's.");
    expect(highestGroundingRisk(mixed)).toBe("high");
  });

  it("highestGroundingRisk: low-only set stays low; empty is null", () => {
    const low = classifyGroundingClaims("She lives in Sacramento.");
    expect(highestGroundingRisk(low)).toBe("low");
    expect(highestGroundingRisk([])).toBeNull();
  });
});

describe("classification output shape", () => {
  it("dedupes to one claim per category", () => {
    const claims = classifyGroundingClaims(
      "She has Parkinson's. She was also diagnosed with dementia and is taking Sinemet.",
    );
    const medical = claims.filter((c) => c.category === "medical_condition");
    expect(medical).toHaveLength(1);
  });

  it("serialized claims carry categories/risk only — never the draft text (R21)", () => {
    const draft = "She is allergic to penicillin and your invoice was $340.";
    const json = JSON.stringify(classifyGroundingClaims(draft));
    expect(json).not.toContain("penicillin");
    expect(json).not.toContain("$340");
    expect(json).toContain("allergy");
    expect(json).toContain("money_payment");
  });
});

describe("groundingTelemetryHash (R21)", () => {
  it("is deterministic, short hex, and reveals nothing of the input", () => {
    const h1 = groundingTelemetryHash("She has Parkinson's.");
    const h2 = groundingTelemetryHash("She has Parkinson's.");
    const h3 = groundingTelemetryHash("Something else entirely.");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(h1).not.toContain("Parkinson");
  });
});
