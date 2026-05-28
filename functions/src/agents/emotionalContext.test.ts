import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

import {
  classifyEmotionalContext,
  classifyEmotionalTopic,
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

describe("classifyEmotionalTopic", () => {
  it("returns general for empty input", () => {
    expect(classifyEmotionalTopic("")).toBe("general");
    expect(classifyEmotionalTopic("   ")).toBe("general");
  });

  it("classifies health-marker phrases as health", () => {
    expect(classifyEmotionalTopic("Mom hasn't been eating")).toBe("health");
    expect(classifyEmotionalTopic("She fell this morning, I'm worried about her hip")).toBe("health");
    expect(classifyEmotionalTopic("dad missed his medication yesterday")).toBe("health");
    expect(classifyEmotionalTopic("blood pressure has been high lately")).toBe("health");
  });

  it("classifies logistics-marker phrases as logistics", () => {
    expect(classifyEmotionalTopic("can we reschedule Thursday")).toBe("logistics");
    expect(classifyEmotionalTopic("what's this charge on my invoice from last week")).toBe("logistics");
    expect(classifyEmotionalTopic("what time is the visit tomorrow")).toBe("logistics");
    expect(classifyEmotionalTopic("can you cancel the booking")).toBe("logistics");
  });

  it("falls back to general for ambiguous prose", () => {
    expect(classifyEmotionalTopic("hi just checking in")).toBe("general");
    expect(classifyEmotionalTopic("everything good here")).toBe("general");
    expect(classifyEmotionalTopic("hope you're well")).toBe("general");
  });

  it("when both health and logistics markers appear, prefers health (higher stakes)", () => {
    expect(classifyEmotionalTopic("Mom's been having chest pain — can we reschedule the visit today?")).toBe("health");
  });
});

describe("buildEmotionalContextDirective with topic", () => {
  it("default topic 'general' produces no topic-specific addendum", () => {
    const d = buildEmotionalContextDirective("anxious");
    expect(d).not.toMatch(/Topic is/i);
  });

  it("anxious + health appends a health-grounding addendum", () => {
    const d = buildEmotionalContextDirective("anxious", "health");
    expect(d).toMatch(/Topic is health/i);
    expect(d).toMatch(/journal|notes|care_plan|get_care_journal/i);
  });

  it("anxious + logistics appends a logistics-clarity addendum", () => {
    const d = buildEmotionalContextDirective("anxious", "logistics");
    expect(d).toMatch(/Topic is logistics/i);
    expect(d).toMatch(/clear specific answer|time|name|yes\/no/i);
  });

  it("frustrated + health appends a care-grounding addendum", () => {
    const d = buildEmotionalContextDirective("frustrated", "health");
    expect(d).toMatch(/Topic is health/i);
    expect(d).toMatch(/journal|get_care_journal/i);
  });

  it("frustrated + logistics tells Cara to fix logistics directly", () => {
    const d = buildEmotionalContextDirective("frustrated", "logistics");
    expect(d).toMatch(/Topic is logistics/i);
    expect(d).toMatch(/fix the logistics directly|cancel, reschedule/i);
  });

  it("grieving / rushed / celebratory branches do NOT emit topic addendum (out of scope)", () => {
    expect(buildEmotionalContextDirective("grieving", "health")).not.toMatch(/Topic is/i);
    expect(buildEmotionalContextDirective("rushed", "logistics")).not.toMatch(/Topic is/i);
    expect(buildEmotionalContextDirective("celebratory", "health")).not.toMatch(/Topic is/i);
  });
});
