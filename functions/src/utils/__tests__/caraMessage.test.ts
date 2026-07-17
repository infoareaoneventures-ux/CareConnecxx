// U1 — generateCaraMessage output guard + anti-invention voice clause.
//
// First test file for caraMessage.ts. Pattern per openaiClient.fallback.test.ts:
// mock the claude client module, vi.resetModules() + dynamic import in
// beforeEach so module state is rebuilt fresh each test. Env save/restore per
// mvrConfig.test.ts. NOTE the vitest gotcha: beforeEach callbacks use braces —
// never implicitly return a value.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const messagesCreate = vi.fn();
vi.mock("../claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => messagesCreate(...args) },
  }),
}));

type CaraMessageModule = typeof import("../caraMessage");
let mod: CaraMessageModule;

const SAVED = { ...process.env };

const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the caregiver, what shift/client situation are we talking about...";

const modelReturns = (text: string) => {
  messagesCreate.mockResolvedValue({ content: [{ type: "text", text }] });
};

const OPTS = {
  audience: "caregiver" as const,
  context:  "Caregiver finished onboarding.",
  fallback: "You're all set — reply here if you need anything.",
};

beforeEach(async () => {
  messagesCreate.mockReset();
  delete process.env.CARA_OUTPUT_GUARD_ENABLED;
  vi.resetModules();
  mod = await import("../caraMessage");
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("generateCaraMessage output guard (U1)", () => {
  it("returns opts.fallback when the model emits a meta-response, with a count-only warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    modelReturns(META_OUTPUT);

    const out = await mod.generateCaraMessage(OPTS);

    expect(out).toBe(OPTS.fallback);
    const tripped = warn.mock.calls.find((c) => String(c[0]).includes("output guard tripped"));
    expect(tripped).toBeTruthy();
    // Never the message text — reason only.
    const logged = warn.mock.calls.map((c) => c.map((a) => JSON.stringify(a)).join(" ")).join(" ");
    expect(logged).not.toContain("briefing context to write");
  });

  it("returns valid model text unchanged", async () => {
    modelReturns("Your check cleared — you're all set to apply for jobs!");
    const out = await mod.generateCaraMessage(OPTS);
    expect(out).toBe("Your check cleared — you're all set to apply for jobs!");
  });

  it("returns fallback when the API throws (existing behavior preserved)", async () => {
    messagesCreate.mockRejectedValue(new Error("api down"));
    const out = await mod.generateCaraMessage(OPTS);
    expect(out).toBe(OPTS.fallback);
  });

  it("returns fallback on empty model output (existing behavior preserved)", async () => {
    modelReturns("   ");
    const out = await mod.generateCaraMessage(OPTS);
    expect(out).toBe(OPTS.fallback);
  });

  it("bypasses the guard when CARA_OUTPUT_GUARD_ENABLED='false' (kill switch)", async () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    modelReturns(META_OUTPUT);
    const out = await mod.generateCaraMessage(OPTS);
    expect(out).toBe(META_OUTPUT);
  });

  it("blocks composed URLs when the guard is on", async () => {
    modelReturns("Tap here: https://eviacares.com/pay");
    const out = await mod.generateCaraMessage(OPTS);
    expect(out).toBe(OPTS.fallback);
  });
});

describe("voice prompts — anti-invention clause (R1)", () => {
  it("CAREGIVER_VOICE and FAMILY_VOICE both contain ANTI_INVENTION_CLAUSE", () => {
    expect(mod.CAREGIVER_VOICE).toContain(mod.ANTI_INVENTION_CLAUSE);
    expect(mod.FAMILY_VOICE).toContain(mod.ANTI_INVENTION_CLAUSE);
  });

  it("neither voice carries the old unconditional 'Be concrete — real names' imperative", () => {
    expect(mod.CAREGIVER_VOICE).not.toContain("Be concrete — real names");
    expect(mod.FAMILY_VOICE).not.toContain("Be concrete — real names");
  });

  it("FAMILY_VOICE's senior-name rule is briefing-conditional, not unconditional", () => {
    expect(mod.FAMILY_VOICE).not.toContain("Use the senior's name — never 'your loved one'.");
    expect(mod.FAMILY_VOICE).toContain(
      "When the briefing gives the senior's name, use it — never 'your loved one'; " +
      "when it doesn't, refer to 'their visit' and never invent a name."
    );
  });

  it("the clause instructs briefing-only concreteness and forbids invention", () => {
    expect(mod.ANTI_INVENTION_CLAUSE).toContain("ONLY names, dates, times, and amounts that appear in the briefing");
    expect(mod.ANTI_INVENTION_CLAUSE).toContain("NEVER invent one");
  });

  it("the live system prompt sent to the model carries the clause", async () => {
    modelReturns("All set!");
    await mod.generateCaraMessage({ ...OPTS, audience: "family" });
    const params = messagesCreate.mock.calls[0][0] as { system: string };
    expect(params.system).toContain(mod.ANTI_INVENTION_CLAUSE);
  });
});
