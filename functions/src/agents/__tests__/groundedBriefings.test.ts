import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * U7 (hallucination hardening 2026-07-17, R12/R14) — source-scan guards in the
 * style of qaAgentPromptRules.test.ts / pricingLiterals.test.ts.
 *
 * onboardingConversation.ts is too heavy to drive end-to-end for two prompt
 * strings, so these tests pin the SOURCE of the two briefings the audit flagged:
 *
 *  1. Match-pitch (handleClientPresentPlan): when the live Stripe price lookup
 *     fails (priceLabel === ""), the briefing must forbid stating a specific
 *     dollar amount — "state the price" may exist ONLY in the priceLabel-guarded
 *     truthy branch of the ternary.
 *  2. MVR classifier (handleCaregiverAskMvr): soft declines ("not at the
 *     moment", "not right now", "maybe later") must be decline exemplars so
 *     they classify as "no" instead of "unclear" (whose re-ask loop is what
 *     hallucinated Marcus). The strict YES/NO fast path stays untouched.
 *
 * Behavior coverage for the other U7 sites lives in
 * routeIntent.characterization.test.ts; a count backstop for the routeIntent
 * cancellation briefings is included here.
 */

const onboardingSrc = readFileSync(resolve(__dirname, "../onboardingConversation.ts"), "utf8");

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("match-pitch briefing — no ungrounded 'state the price' ask (R12)", () => {
  const pitch = sliceBetween(
    onboardingSrc,
    "async function handleClientPresentPlan",
    "async function handleClientPlanReply",
  );

  it("the empty-priceLabel branch forbids stating a specific dollar amount", () => {
    expect(pitch).toContain(
      "Do NOT state a specific dollar amount — say 'a simple monthly membership'.",
    );
  });

  it("'state the price' exists only as the priceLabel-guarded truthy branch", () => {
    // The instruction is the ternary's truthy arm (real label available) …
    expect(pitch).toContain("? `Now state the price in one warm, simple message: Evia is ${priceLabel}");
    // … and appears nowhere else in the module (so the falsy branch can never
    // silently regain an ungrounded "state the price" ask).
    expect(onboardingSrc.split("state the price").length - 1).toBe(1);
  });
});

// (The MVR opt-in classifier block was removed 2026-09-25 with the caregiver_ask_mvr step —
//  the flat membership covers the driving-record check whenever Transportation is offered.)
