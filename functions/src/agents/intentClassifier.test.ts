import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  quickComplete: vi.fn(),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

import { classifyIntent } from "./intentClassifier";

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
