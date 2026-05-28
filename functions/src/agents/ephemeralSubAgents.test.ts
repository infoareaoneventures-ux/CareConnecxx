import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: vi.fn() },
  }),
}));

vi.mock("../utils/claudeRetry", () => ({
  callClaudeWithRetry: async () => ({
    content: [{
      type: "text",
      text: "Maria — she has dementia-care training and is closer; Sam was second, only edged out on rate.",
    }],
  }),
}));

import {
  runEphemeralSubAgent,
  SUB_AGENT_REGISTRY,
  buildTaskToolDescription,
  INTERNAL_SUB_AGENT_NAMES,
  getPublicSubAgentNames,
} from "./ephemeralSubAgents";
import { quickComplete } from "../utils/openaiClient";

const mockQuickComplete = quickComplete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQuickComplete.mockReset();
});

describe("SUB_AGENT_REGISTRY", () => {
  it("ships with at least three sub-agents", () => {
    const names = Object.keys(SUB_AGENT_REGISTRY);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toContain("journal_summarizer");
    expect(names).toContain("caregiver_compare");
    expect(names).toContain("budget_impact");
  });

  it("every entry's key matches its .name", () => {
    for (const [k, v] of Object.entries(SUB_AGENT_REGISTRY)) {
      expect(v.name).toBe(k);
    }
  });

  it("every entry has a system prompt and description", () => {
    for (const v of Object.values(SUB_AGENT_REGISTRY)) {
      expect(v.systemPrompt.length).toBeGreaterThan(50);
      expect(v.description.length).toBeGreaterThan(20);
    }
  });
});

describe("runEphemeralSubAgent", () => {
  it("returns a structured error string on unknown subagent_type, does not throw", async () => {
    const result = await runEphemeralSubAgent({
      subagentType: "nope_not_real",
      description:  "anything",
    });
    expect(result.output).toMatch(/unknown subagent_type/);
    expect(result.output).toMatch(/Available:/);
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("returns a structured error string on empty description", async () => {
    const result = await runEphemeralSubAgent({
      subagentType: "journal_summarizer",
      description:  "   ",
    });
    expect(result.output).toMatch(/description is required/);
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("routes light-weight sub-agents (journal_summarizer) to gpt-4o-mini", async () => {
    mockQuickComplete.mockResolvedValueOnce("Mom's appetite has dipped 3 days running.");
    const result = await runEphemeralSubAgent({
      subagentType: "journal_summarizer",
      description:  "2026-05-25: ate 30% of breakfast.\n2026-05-26: skipped lunch.\n2026-05-27: barely picked at dinner.",
    });
    expect(result.modelUsed).toBe("gpt-4o-mini");
    expect(result.output).toMatch(/appetite/);
    expect(mockQuickComplete).toHaveBeenCalledOnce();
    expect(mockQuickComplete.mock.calls[0][0]).toMatch(/summariz|summar/i);
  });

  it("routes nuance sub-agents (caregiver_compare) to Sonnet", async () => {
    const result = await runEphemeralSubAgent({
      subagentType: "caregiver_compare",
      description:  "Shift: Thursday morning, dementia care. Caregivers: Maria ($28/hr, dementia trained, 4.9★), Sam ($24/hr, general, 4.6★).",
    });
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
    expect(result.output).toMatch(/Maria/);
    expect(mockQuickComplete).not.toHaveBeenCalled();
  });

  it("falls back to a structured error string on quickComplete failure (does not throw)", async () => {
    mockQuickComplete.mockRejectedValueOnce(new Error("rate limited"));
    const result = await runEphemeralSubAgent({
      subagentType: "budget_impact",
      description:  "Current: $26/hr × 20h. Proposed: $28/hr × 18h.",
    });
    expect(result.output).toMatch(/sub-agent failed/);
    expect(result.modelUsed).toBe("gpt-4o-mini");
  });

  it("records durationMs", async () => {
    mockQuickComplete.mockResolvedValueOnce("ok");
    const result = await runEphemeralSubAgent({
      subagentType: "budget_impact",
      description:  "anything",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("buildTaskToolDescription", () => {
  it("includes every PUBLIC sub-agent by name", () => {
    const desc = buildTaskToolDescription();
    for (const name of getPublicSubAgentNames()) {
      expect(desc).toContain(name);
    }
  });

  it("excludes internal sub-agents (recovery is parent-invoked only)", () => {
    const desc = buildTaskToolDescription();
    for (const name of INTERNAL_SUB_AGENT_NAMES) {
      expect(desc).not.toContain(name);
    }
  });

  it("mentions parallel-callable", () => {
    expect(buildTaskToolDescription()).toMatch(/parallel/i);
  });
});

describe("recovery sub-agent (internal)", () => {
  it("is registered and marked internal", () => {
    expect(SUB_AGENT_REGISTRY["recovery"]).toBeDefined();
    expect(INTERNAL_SUB_AGENT_NAMES.has("recovery")).toBe(true);
    expect(getPublicSubAgentNames()).not.toContain("recovery");
  });

  it("routes recovery to Sonnet (nuanced reasoning)", async () => {
    const result = await runEphemeralSubAgent({
      subagentType: "recovery",
      description:
        "User asked to cancel Thursday's shift. Tried cancel_appointment twice — both returned APPOINTMENT_NOT_FOUND.",
    });
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
    expect(result.output.length).toBeGreaterThan(0);
  });
});
