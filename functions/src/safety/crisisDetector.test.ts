import { describe, it, expect, vi, beforeEach } from "vitest";

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

import { detectCrisis, isLikelyRealCrisis } from "./crisisDetector";

describe("detectCrisis (keyword fast-path)", () => {
  it.each([
    ["chest pain right now", "medical"],
    ["dad had a stroke", "medical"],
    ["he can't breathe", "medical"],
    ["911 needed", "medical"],
    ["choking", "medical"],
  ])("flags %p as medical", (text, expected) => {
    expect(detectCrisis(text)).toBe(expected);
  });

  it.each([
    ["I want to die", "emotional"],
    ["I want to end it all", "emotional"],
    ["I want to hurt myself", "emotional"],
  ])("flags %p as emotional", (text, expected) => {
    expect(detectCrisis(text)).toBe(expected);
  });

  it.each([
    ["just looking for a caregiver for mom"],
    ["what time is the visit tomorrow"],
    ["please cancel my appointment"],
  ])("returns null for benign message %p", (text) => {
    expect(detectCrisis(text)).toBeNull();
  });
});

describe("isLikelyRealCrisis (LLM verification)", () => {
  beforeEach(() => {
    quickComplete.mockReset();
  });

  it("returns true when LLM says YES", async () => {
    quickComplete.mockResolvedValue("YES");
    expect(await isLikelyRealCrisis("chest pain", "medical")).toBe(true);
  });

  it("returns false when LLM says NO (false positive — quoted/fiction)", async () => {
    quickComplete.mockResolvedValue("NO");
    expect(await isLikelyRealCrisis("He said 'I want to die' in the movie", "emotional")).toBe(false);
  });

  it("fails safe to crisis on LLM error", async () => {
    quickComplete.mockRejectedValue(new Error("openai down"));
    expect(await isLikelyRealCrisis("stroke", "medical")).toBe(true);
  });

  it("fails safe to crisis on unrecognized LLM output", async () => {
    quickComplete.mockResolvedValue("MAYBE?");
    expect(await isLikelyRealCrisis("stroke", "medical")).toBe(true);
  });

  it("fails safe to crisis on timeout (race with 1.2s budget)", async () => {
    // Never resolves — timeout should win
    quickComplete.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    const result = await isLikelyRealCrisis("stroke", "medical");
    const elapsed = Date.now() - start;
    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(1_600); // timeout fires at 1.2s
  }, 3_000);
});
