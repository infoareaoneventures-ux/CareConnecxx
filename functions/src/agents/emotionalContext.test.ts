import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

import {
  classifyEmotionalContext,
  blendEmotionalContext,
  buildEmotionalContextDirective,
  EMOTIONAL_CONTEXT_TTL_MS,
  type StoredEmotionalContext,
} from "./emotionalContext";
import { quickComplete } from "../utils/openaiClient";

const mockQuickComplete = quickComplete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQuickComplete.mockReset();
});

describe("classifyEmotionalContext", () => {
  it("returns calm for empty/near-empty input without calling the model", async () => {
    expect(await classifyEmotionalContext("")).toBe("calm");
    expect(await classifyEmotionalContext("ok")).toBe("calm");
    expect(await classifyEmotionalContext("   ")).toBe("calm");
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("trusts a valid label returned by the model", async () => {
    mockQuickComplete.mockResolvedValueOnce("anxious");
    expect(await classifyEmotionalContext("mom is acting strange and I'm worried"))
      .toBe("anxious");

    mockQuickComplete.mockResolvedValueOnce("grieving");
    expect(await classifyEmotionalContext("dad passed last night")).toBe("grieving");

    mockQuickComplete.mockResolvedValueOnce("celebratory");
    expect(await classifyEmotionalContext("she's HOME!!!")).toBe("celebratory");
  });

  it("normalizes case and whitespace", async () => {
    mockQuickComplete.mockResolvedValueOnce("  FRUSTRATED \n");
    expect(await classifyEmotionalContext("this is the third missed visit"))
      .toBe("frustrated");
  });

  it("falls back to calm when the model returns an unknown label", async () => {
    mockQuickComplete.mockResolvedValueOnce("panicky");
    expect(await classifyEmotionalContext("a real message")).toBe("calm");
  });

  it("falls back to calm on classifier error / timeout", async () => {
    mockQuickComplete.mockRejectedValueOnce(new Error("boom"));
    expect(await classifyEmotionalContext("a real message")).toBe("calm");
  });
});

describe("blendEmotionalContext", () => {
  const NOW = 1_700_000_000_000;

  it("uses the current label and persists when current is non-calm", () => {
    const { value, persist } = blendEmotionalContext(undefined, "anxious", NOW);
    expect(value).toBe("anxious");
    expect(persist).toEqual({
      value:     "anxious",
      setAt:     NOW,
      expiresAt: NOW + EMOTIONAL_CONTEXT_TTL_MS,
    });
  });

  it("returns calm + no persist when there's no stored state and current is calm", () => {
    const { value, persist } = blendEmotionalContext(undefined, "calm", NOW);
    expect(value).toBe("calm");
    expect(persist).toBeNull();
  });

  it("carries forward a still-valid stored non-calm posture when current is calm", () => {
    // Family is in grief — they send a normal-sounding logistics question.
    // We do NOT clear grief just because one follow-up sounds neutral.
    const stored: StoredEmotionalContext = {
      value:     "grieving",
      setAt:     NOW - 1000,
      expiresAt: NOW + 60_000,
    };
    const { value, persist } = blendEmotionalContext(stored, "calm", NOW);
    expect(value).toBe("grieving");
    expect(persist).toBeNull(); // no rewrite needed — stored is still live
  });

  it("ignores expired stored state", () => {
    const stored: StoredEmotionalContext = {
      value:     "anxious",
      setAt:     NOW - EMOTIONAL_CONTEXT_TTL_MS - 1000,
      expiresAt: NOW - 1000,
    };
    const { value, persist } = blendEmotionalContext(stored, "calm", NOW);
    expect(value).toBe("calm");
    expect(persist).toBeNull();
  });

  it("a new non-calm signal overrides a stored different non-calm posture", () => {
    // Family was anxious yesterday; now they're frustrated. Refresh.
    const stored: StoredEmotionalContext = {
      value:     "anxious",
      setAt:     NOW - 60_000,
      expiresAt: NOW + 60_000,
    };
    const { value, persist } = blendEmotionalContext(stored, "frustrated", NOW);
    expect(value).toBe("frustrated");
    expect(persist).toEqual({
      value:     "frustrated",
      setAt:     NOW,
      expiresAt: NOW + EMOTIONAL_CONTEXT_TTL_MS,
    });
  });
});

describe("buildEmotionalContextDirective", () => {
  it("returns empty string for calm (default tone, don't bust the prompt cache)", () => {
    expect(buildEmotionalContextDirective("calm")).toBe("");
  });

  it("wraps every non-calm directive in <emotional_context>", () => {
    for (const ctx of ["anxious", "grieving", "frustrated", "rushed", "celebratory"] as const) {
      const d = buildEmotionalContextDirective(ctx);
      expect(d).toMatch(/^<emotional_context>/);
      expect(d).toMatch(/<\/emotional_context>$/);
      expect(d.length).toBeGreaterThan(30);
    }
  });

  it("anxious directive leads with reassurance, not caveats", () => {
    const d = buildEmotionalContextDirective("anxious");
    expect(d).toMatch(/reassur|worried|worry/i);
    expect(d).toMatch(/caveat|hedge|disclaim/i); // tells Cara to AVOID them — text mentions the word
  });

  it("grieving directive forbids upbeat phrasing and emoji", () => {
    const d = buildEmotionalContextDirective("grieving");
    expect(d).toMatch(/no upbeat|no emoji/i);
    expect(d).toMatch(/grieving|grief|slow/i);
  });

  it("frustrated directive bans \"I understand how you feel\"", () => {
    const d = buildEmotionalContextDirective("frustrated");
    expect(d).toMatch(/understand how you feel/i);
    expect(d).toMatch(/never|don't|skip/i);
  });

  it("rushed directive enforces brevity", () => {
    const d = buildEmotionalContextDirective("rushed");
    expect(d).toMatch(/short|hurry|preamble/i);
  });

  it("celebratory directive matches warmth without overdoing", () => {
    const d = buildEmotionalContextDirective("celebratory");
    expect(d).toMatch(/good news|celebrat|warm/i);
  });
});
