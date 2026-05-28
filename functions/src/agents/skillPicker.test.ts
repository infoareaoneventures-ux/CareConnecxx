import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

import { pickSkill } from "./skillPicker";
import { quickComplete } from "../utils/openaiClient";
import { _resetSkillRegistryCache } from "./skills";

const mockQuickComplete = quickComplete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQuickComplete.mockReset();
  _resetSkillRegistryCache();
});

describe("pickSkill", () => {
  it("returns null on empty user text without calling the LLM", async () => {
    const result = await pickSkill("");
    expect(result.skill).toBeNull();
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("returns null on whitespace-only input", async () => {
    const result = await pickSkill("   ");
    expect(result.skill).toBeNull();
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("returns null when the picker says \"none\"", async () => {
    mockQuickComplete.mockResolvedValueOnce("none");
    const result = await pickSkill("hi what time is it");
    expect(result.skill).toBeNull();
  });

  it("strips quotes/punctuation/whitespace from picker output", async () => {
    mockQuickComplete.mockResolvedValueOnce("  \"draft-care-update\".  ");
    const result = await pickSkill("how is mom doing today?");
    expect(result.skill).toBe("draft-care-update");
  });

  it("is case-insensitive on picker output", async () => {
    mockQuickComplete.mockResolvedValueOnce("DRAFT-CARE-UPDATE");
    const result = await pickSkill("how is mom?");
    expect(result.skill).toBe("draft-care-update");
  });

  it("returns null when picker hallucinates a non-registry skill name", async () => {
    mockQuickComplete.mockResolvedValueOnce("imaginary-skill");
    const result = await pickSkill("anything");
    expect(result.skill).toBeNull();
  });

  it("returns null when the LLM throws (no crash)", async () => {
    mockQuickComplete.mockRejectedValueOnce(new Error("rate limited"));
    const result = await pickSkill("how is mom doing?");
    expect(result.skill).toBeNull();
  });

  it("records durationMs as a number", async () => {
    mockQuickComplete.mockResolvedValueOnce("none");
    const result = await pickSkill("anything");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("clips overlong user text in the picker prompt", async () => {
    const huge = "a".repeat(10_000);
    mockQuickComplete.mockResolvedValueOnce("none");
    await pickSkill(huge);
    expect(mockQuickComplete).toHaveBeenCalledOnce();
    const userPrompt = mockQuickComplete.mock.calls[0][1] as string;
    // The full user text is clipped to 1000 chars in the prompt body.
    const userSectionIdx = userPrompt.indexOf("User message:");
    const remainder = userPrompt.slice(userSectionIdx);
    const aRun = remainder.match(/a+/)?.[0] ?? "";
    expect(aRun.length).toBeLessThanOrEqual(1000);
  });
});
