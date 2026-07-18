// U2 — anti-invention clause + output guard on morningBriefing's two direct
// messages.create paths, tested via the extracted helpers
// (generateCaregiverBriefingContent / generateFamilyBriefingText). Module-level
// firebase mocks follow triggerCancellation.test.ts. NOTE the vitest gotcha:
// beforeEach callbacks use braces — never implicitly return a value.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const claudeHoisted = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: () => ({ collection: vi.fn() }),
}));
vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return { __esModule: true, pubsub: chain, https: { onCall: (fn: any) => fn, HttpsError: class extends Error {} } };
});
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => claudeHoisted.messagesCreate(...args) },
  }),
}));
// Imported by the module but not exercised by the extracted helpers.
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));
vi.mock("../../mcp/server", () => ({ handlePromptGet: vi.fn(() => "") }));
vi.mock("../../memory/learnedFacts", () => ({ getRelevantFacts: vi.fn(async () => []) }));
vi.mock("../../memory/memoryFiles", () => ({ getMemoryContext: vi.fn(async () => "") }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn(async () => null), isInDND: vi.fn(() => false) }));

import { generateCaregiverBriefingContent, generateFamilyBriefingText } from "../morningBriefing";
import { ANTI_INVENTION_CLAUSE } from "../../utils/caraMessage";

// The exact leaked-incident shape: the model replies to the briefing author.
const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the caregiver, what shift/client situation are we talking about...";

const FALLBACK = "Morning Sam! Rosie today — 9:00–13:00 at 12 Elm St.\n\nReply ARRIVED when you get there.";

const modelReturns = (text: string) => {
  claudeHoisted.messagesCreate.mockResolvedValue({ content: [{ type: "text", text }] });
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  claudeHoisted.messagesCreate.mockReset();
  delete process.env.CARA_OUTPUT_GUARD_ENABLED;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("generateCaregiverBriefingContent (U2)", () => {
  it("carries ANTI_INVENTION_CLAUSE as the system prompt", async () => {
    modelReturns("Morning Sam! Rosie today at 9 — you're all set.");
    await generateCaregiverBriefingContent("briefing prompt", FALLBACK);
    const params = claudeHoisted.messagesCreate.mock.calls[0][0] as { system: string };
    expect(params.system).toContain(ANTI_INVENTION_CLAUSE);
  });

  it("returns valid model text unchanged", async () => {
    modelReturns("Morning Sam! Rosie today at 9 — you're all set.");
    await expect(generateCaregiverBriefingContent("briefing prompt", FALLBACK))
      .resolves.toBe("Morning Sam! Rosie today at 9 — you're all set.");
  });

  it("guard-rejected meta-response → fallback lines, raw output never returned", async () => {
    modelReturns(META_OUTPUT);
    await expect(generateCaregiverBriefingContent("briefing prompt", FALLBACK)).resolves.toBe(FALLBACK);
  });

  it("API throw and empty output both fall back (existing behavior preserved)", async () => {
    claudeHoisted.messagesCreate.mockRejectedValueOnce(new Error("api down"));
    await expect(generateCaregiverBriefingContent("p", FALLBACK)).resolves.toBe(FALLBACK);
    modelReturns("   ");
    await expect(generateCaregiverBriefingContent("p", FALLBACK)).resolves.toBe(FALLBACK);
  });

  // Prompt-supplied URLs (the maps link) — the guard's url rule targets
  // INVENTED URLs only. Before this fix, the model echoing the system-provided
  // maps link tripped guardModelOutput(reason "url") and degraded the briefing
  // to the fallback lines EVERY day.
  describe("known prompt-supplied URLs", () => {
    const MAPS_URL = "https://maps.google.com/?q=12%20Elm%20St";

    it("model output echoing exactly the prompt-supplied maps URL is NOT rejected — link still present", async () => {
      const out = `Morning Sam! Rosie today 9:00–13:00 at 12 Elm St.\n${MAPS_URL}\nReply ARRIVED when you get there.`;
      modelReturns(out);
      const result = await generateCaregiverBriefingContent("briefing prompt", FALLBACK, [MAPS_URL]);
      expect(result).toBe(out);
      expect(result).toContain(MAPS_URL);
    });

    it("model output containing a DIFFERENT invented URL is still rejected to the fallback", async () => {
      modelReturns(`Morning Sam! Check https://evia-fake.example.com/visit for details.`);
      await expect(generateCaregiverBriefingContent("briefing prompt", FALLBACK, [MAPS_URL]))
        .resolves.toBe(FALLBACK);
    });

    it("re-appends the known URL when the model dropped it (delivered briefing always carries its link)", async () => {
      modelReturns("Morning Sam! Rosie today at 9. Reply ARRIVED when you get there.");
      const result = await generateCaregiverBriefingContent("briefing prompt", FALLBACK, [MAPS_URL]);
      expect(result).toContain(MAPS_URL);
      expect(result.startsWith("Morning Sam!")).toBe(true);
    });

    it("a guard-off run still delivers the echoed known URL unchanged (kill switch respected)", async () => {
      process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
      const out = `Morning Sam! ${MAPS_URL}`;
      modelReturns(out);
      await expect(generateCaregiverBriefingContent("briefing prompt", FALLBACK, [MAPS_URL]))
        .resolves.toBe(out);
    });
  });
});

describe("generateFamilyBriefingText (U2)", () => {
  it("carries ANTI_INVENTION_CLAUSE in its system prompt", async () => {
    modelReturns("Maria arrives at 9am for Rosie's visit today.");
    await generateFamilyBriefingText("Senior: Rosie\nCaregiver: Maria arriving at 9am");
    const params = claudeHoisted.messagesCreate.mock.calls[0][0] as { system: string };
    expect(params.system).toContain(ANTI_INVENTION_CLAUSE);
  });

  it("returns valid model text unchanged", async () => {
    modelReturns("Maria arrives at 9am for Rosie's visit today.");
    await expect(generateFamilyBriefingText("Senior: Rosie"))
      .resolves.toBe("Maria arrives at 9am for Rosie's visit today.");
  });

  it("guard-rejected meta-response → '' so the call site's catch/fallback path runs", async () => {
    modelReturns(META_OUTPUT);
    await expect(generateFamilyBriefingText("Senior: Rosie")).resolves.toBe("");
  });

  it("kill switch CARA_OUTPUT_GUARD_ENABLED='false' bypasses the guard", async () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    modelReturns(META_OUTPUT);
    await expect(generateFamilyBriefingText("Senior: Rosie")).resolves.toBe(META_OUTPUT);
  });
});
