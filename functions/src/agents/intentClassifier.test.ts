import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  quickComplete: vi.fn(),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

import { classifyIntent, classifyIntentDetailed, isCaregiverSearchMisroutedAsProviderSearch } from "./intentClassifier";

describe("classifyIntent — fast paths (no LLM)", () => {
  beforeEach(() => {
    hoisted.quickComplete.mockReset();
  });

  it.each([
    ["STOP",        "STOP"],
    ["unsubscribe", "STOP"],
    ["Quit",        "STOP"],
  ])("routes carrier opt-out keyword %p to STOP without calling the LLM", async (input, expected) => {
    const out = await classifyIntent(input, false);
    expect(out).toBe(expected);
    expect(hoisted.quickComplete).not.toHaveBeenCalled();
  });

  it("routes bare 'CANCEL' to CANCEL_REQUEST without calling the LLM", async () => {
    const out = await classifyIntent("cancel", false);
    expect(out).toBe("CANCEL_REQUEST");
    expect(hoisted.quickComplete).not.toHaveBeenCalled();
  });

  it("routes '1' to TASK_REPLY when a task is pending", async () => {
    const out = await classifyIntent("1", true);
    expect(out).toBe("TASK_REPLY");
    expect(hoisted.quickComplete).not.toHaveBeenCalled();
  });

  it.each([
    "help",
    "Help",
    "/help",
    "capabilities",
    "/capabilities",
  ])("routes exact command %p to HELP without calling the LLM", async (input) => {
    const out = await classifyIntent(input, false);
    expect(out).toBe("HELP");
    expect(hoisted.quickComplete).not.toHaveBeenCalled();
  });

  it("does NOT treat 'help me find a caregiver' as the HELP command (routes to the LLM)", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("FIND_CAREGIVER");
    const out = await classifyIntent("help me find a caregiver", false);
    expect(out).toBe("FIND_CAREGIVER");
    expect(hoisted.quickComplete).toHaveBeenCalledTimes(1);
  });

  it("routes 'help' to HELP even when a task is pending (not TASK_REPLY)", async () => {
    const out = await classifyIntent("help", true);
    expect(out).toBe("HELP");
    expect(hoisted.quickComplete).not.toHaveBeenCalled();
  });
});

describe("classifyIntent — UPDATE_ONBOARDING routing", () => {
  beforeEach(() => {
    hoisted.quickComplete.mockReset();
  });

  // The classifier delegates to gpt-4o-mini for free-form text. These tests
  // mock that decision to verify (a) UPDATE_ONBOARDING is accepted as a valid
  // intent and round-trips through VALID_INTENTS gating, and (b) common phrase
  // variants the prompt mentions all flow through. They do not assert that the
  // LIVE classifier picks the right label for each phrase — that requires a
  // real LLM and belongs in evals.
  it.each([
    "redo my onboarding",
    "fix what's on file",
    "that never happened, can you help me onboard",
    "the onboarding never finished",
    "start over with my info",
    "my info is wrong",
    "update what you know about mom",
    "walk me through onboarding again",
  ])("accepts UPDATE_ONBOARDING for phrase %p when classifier returns it", async (phrase) => {
    hoisted.quickComplete.mockResolvedValueOnce("UPDATE_ONBOARDING");
    const out = await classifyIntent(phrase, false);
    expect(out).toBe("UPDATE_ONBOARDING");
  });

  it("falls back to QUESTION when the classifier returns garbage", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("MAYBE_ONBOARDING?");
    const out = await classifyIntent("redo my onboarding", false);
    expect(out).toBe("QUESTION");
  });

  it("falls back to QUESTION when the classifier throws", async () => {
    hoisted.quickComplete.mockRejectedValueOnce(new Error("network"));
    const out = await classifyIntent("redo my onboarding", false);
    expect(out).toBe("QUESTION");
  });
});

describe("classifyIntentDetailed — degradation signal", () => {
  beforeEach(() => {
    hoisted.quickComplete.mockReset();
  });

  // The webhook only takes the runQuickReply fast path when
  // intent === "QUESTION" && !degraded && isTrivialQuickReply(text).
  // A degraded QUESTION is a guess, not a decision — it must route to the
  // full QA agent (which runs the complete supervisor pipeline) instead.
  it("marks the result degraded when the classifier throws, blocking the quick-reply fast path", async () => {
    hoisted.quickComplete.mockRejectedValueOnce(new Error("openai down"));
    const out = await classifyIntentDetailed("hey", false);
    expect(out).toEqual({ intent: "QUESTION", degraded: true });
  });

  it("marks the result degraded when the classifier returns an unrecognized label", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("DEFINITELY_NOT_AN_INTENT");
    const out = await classifyIntentDetailed("hey", false);
    expect(out).toEqual({ intent: "QUESTION", degraded: true });
  });

  it("is NOT degraded when the LLM genuinely classifies QUESTION", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("QUESTION");
    const out = await classifyIntentDetailed("how does billing work?", false);
    expect(out).toEqual({ intent: "QUESTION", degraded: false });
  });

  it("is NOT degraded for non-QUESTION labels or no-LLM fast paths", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("FIND_CAREGIVER");
    expect(await classifyIntentDetailed("I need a caregiver", false)).toEqual({ intent: "FIND_CAREGIVER", degraded: false });

    expect(await classifyIntentDetailed("STOP", false)).toEqual({ intent: "STOP", degraded: false });
    expect(await classifyIntentDetailed("1", true)).toEqual({ intent: "TASK_REPLY", degraded: false });
  });

  it("keeps the plain classifyIntent wrapper behavior identical for existing callers", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("FIND_CAREGIVER");
    expect(await classifyIntent("I need a caregiver", false)).toBe("FIND_CAREGIVER");
  });
});

describe("classifyIntentDetailed — retry on transient failure (U4)", () => {
  beforeEach(() => {
    hoisted.quickComplete.mockReset();
  });

  it("recovers when the first attempt throws and the retry succeeds", async () => {
    hoisted.quickComplete
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("FIND_CAREGIVER");
    const out = await classifyIntentDetailed("I need a caregiver", false);
    expect(out).toEqual({ intent: "FIND_CAREGIVER", degraded: false });
    expect(hoisted.quickComplete).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first attempt returns garbage and the retry is valid", async () => {
    hoisted.quickComplete
      .mockResolvedValueOnce("NOT_AN_INTENT")
      .mockResolvedValueOnce("CANCEL_REQUEST");
    const out = await classifyIntentDetailed("cancel my Tuesday visit", false);
    expect(out).toEqual({ intent: "CANCEL_REQUEST", degraded: false });
    expect(hoisted.quickComplete).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry when the first attempt is already valid", async () => {
    hoisted.quickComplete.mockResolvedValueOnce("FIND_CAREGIVER");
    const out = await classifyIntentDetailed("I need a caregiver", false);
    expect(out).toEqual({ intent: "FIND_CAREGIVER", degraded: false });
    expect(hoisted.quickComplete).toHaveBeenCalledTimes(1);
  });

  it("degrades to QUESTION only after both attempts fail", async () => {
    hoisted.quickComplete
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout again"));
    const out = await classifyIntentDetailed("hey", false);
    expect(out).toEqual({ intent: "QUESTION", degraded: true });
    expect(hoisted.quickComplete).toHaveBeenCalledTimes(2);
  });
});

// 2026-08-31 fix — real production bug: "find me a caregiver near me" and
// "any more caregivers nearby" have the same "find X near me" shape as a
// medical-provider search, and the classifier occasionally mislabeled them
// FIND_NEARBY_PROVIDER — which hard-deflects with "Evia cannot search for
// providers", never reaching the real caregiver-matching tools that are
// Evia's actual core job. This is the safety net: a literal "caregiver"
// mention always wins over that specific misclassification.
describe("isCaregiverSearchMisroutedAsProviderSearch (safety net)", () => {
  it.each([
    "find me a caregiver near me",
    "Can you find me caregiver near me",
    "I mean caregiver around me that's not imran",
    "any more caregivers nearby",
    "CAREGIVER near me please",
  ])("overrides a FIND_NEARBY_PROVIDER misclassification when the text says caregiver: %p", (text) => {
    expect(isCaregiverSearchMisroutedAsProviderSearch("FIND_NEARBY_PROVIDER", text)).toBe(true);
  });

  it("does not override a genuine medical-provider search with no mention of caregiver", () => {
    expect(isCaregiverSearchMisroutedAsProviderSearch("FIND_NEARBY_PROVIDER", "find a cardiologist near me")).toBe(false);
    expect(isCaregiverSearchMisroutedAsProviderSearch("FIND_NEARBY_PROVIDER", "closest pharmacy to mom")).toBe(false);
  });

  it("only applies to FIND_NEARBY_PROVIDER — never overrides a different intent", () => {
    expect(isCaregiverSearchMisroutedAsProviderSearch("BOOK_DOCTOR_APPOINTMENT", "find me a caregiver near me")).toBe(false);
    expect(isCaregiverSearchMisroutedAsProviderSearch("QUESTION", "find me a caregiver near me")).toBe(false);
  });

  it("already-correct FIND_CAREGIVER classifications don't need this override at all", () => {
    // Sanity check: the classifier prompt itself should get these right — this
    // helper is strictly a safety net for the FIND_NEARBY_PROVIDER failure mode.
    expect(isCaregiverSearchMisroutedAsProviderSearch("FIND_CAREGIVER", "find me a caregiver near me")).toBe(false);
  });
});
