import { describe, it, expect, vi, beforeEach } from "vitest";

const quickComplete = vi.fn();
vi.mock("./openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

import { detectPersonaShift } from "./personaShiftDetector";

describe("detectPersonaShift", () => {
  beforeEach(() => {
    quickComplete.mockReset();
  });

  it("returns null for messages shorter than 12 chars without calling LLM", async () => {
    const result = await detectPersonaShift({ text: "ok thanks", sessionSenior: "Linda" });
    expect(result).toBeNull();
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("returns null for empty text", async () => {
    const result = await detectPersonaShift({ text: "", sessionSenior: "Linda" });
    expect(result).toBeNull();
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("detects a different senior reference", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({
      kind: "different_senior",
      evidence: "my dad George just fell",
    }));
    const result = await detectPersonaShift({
      text: "My dad George just fell and I need a caregiver right away",
      sessionSenior: "Linda",
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("different_senior");
    expect(result?.evidence).toContain("George");
  });

  it("returns null when LLM says 'none'", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ kind: "none", evidence: "" }));
    const result = await detectPersonaShift({
      text: "How is Linda doing today, anything I should know?",
      sessionSenior: "Linda",
    });
    expect(result).toBeNull();
  });

  it("strips markdown fences from LLM output", async () => {
    quickComplete.mockResolvedValue("```json\n" + JSON.stringify({
      kind: "different_role",
      evidence: "I'm actually a caregiver",
    }) + "\n```");
    const result = await detectPersonaShift({
      text: "Actually I'm a caregiver looking for work here",
      sessionSenior: "Linda",
      sessionRole: "client",
    });
    expect(result?.kind).toBe("different_role");
  });

  it("returns null when LLM returns malformed JSON", async () => {
    quickComplete.mockResolvedValue("not json at all");
    const result = await detectPersonaShift({
      text: "this is a long enough message to trigger the llm call",
      sessionSenior: "Linda",
    });
    expect(result).toBeNull();
  });

  it("returns null on LLM error (fail-open — don't block legitimate messages)", async () => {
    quickComplete.mockRejectedValue(new Error("openai down"));
    const result = await detectPersonaShift({
      text: "this is a long enough message to trigger the llm call",
      sessionSenior: "Linda",
    });
    expect(result).toBeNull();
  });

  it("clamps evidence to 200 chars", async () => {
    const longEvidence = "x".repeat(500);
    quickComplete.mockResolvedValue(JSON.stringify({
      kind: "different_senior",
      evidence: longEvidence,
    }));
    const result = await detectPersonaShift({
      text: "this is a long enough message to trigger the llm call here",
      sessionSenior: "Linda",
    });
    expect(result?.evidence.length).toBeLessThanOrEqual(200);
  });
});
