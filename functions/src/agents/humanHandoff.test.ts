import { describe, it, expect } from "vitest";
import {
  shouldHandOffToHuman,
  isHandoffActive,
  handoffTtlMs,
  isHandoffGateEnabled,
  buildHandoffGroundingPayload,
  parseHandoffGroundingVerdict,
} from "./humanHandoff";

const base = {
  confidenceClaimDetected: true,
  toolCallsThisTurn: 0,
  onboardingMode: false,
  isUserChannel: true,
};

describe("shouldHandOffToHuman (ch10 low-confidence gate)", () => {
  it("hands off an unbacked confident claim on a user turn", () => {
    expect(shouldHandOffToHuman(base)).toBe(true);
  });

  it("still a candidate when a tool ran this turn (the grounding check, fed tool results, decides)", () => {
    // A tool CALL no longer short-circuits the gate — Evia can call a tool and
    // then embellish past its result, so tool-backed turns are grounding-checked too.
    expect(shouldHandOffToHuman({ ...base, toolCallsThisTurn: 1 })).toBe(true);
  });

  it("does NOT hand off when there is no confidence claim", () => {
    expect(shouldHandOffToHuman({ ...base, confidenceClaimDetected: false })).toBe(false);
  });

  it("never fires during onboarding (its own flow owns confirmation)", () => {
    expect(shouldHandOffToHuman({ ...base, onboardingMode: true })).toBe(false);
  });

  it("never fires on a non-user channel (triggers/agent relays)", () => {
    expect(shouldHandOffToHuman({ ...base, isUserChannel: false })).toBe(false);
  });

  it("is disabled by the CARA_CONFIDENCE_HANDOFF=false kill switch", () => {
    expect(shouldHandOffToHuman({ ...base, env: { CARA_CONFIDENCE_HANDOFF: "false" } })).toBe(false);
    expect(shouldHandOffToHuman({ ...base, env: { CARA_CONFIDENCE_HANDOFF: "true" } })).toBe(true);
    expect(shouldHandOffToHuman({ ...base, env: {} })).toBe(true); // default ON
  });
});

describe("isHandoffActive (hold + TTL fail-safe)", () => {
  const now = 1_000_000_000_000;

  it("is active within the TTL window", () => {
    const session = { handedToHuman: true, handedToHumanAt: new Date(now - 5 * 60_000).toISOString() };
    expect(isHandoffActive(session, now)).toBe(true);
  });

  it("auto-expires past the TTL (fail-safe resume — never permanently stranded)", () => {
    const session = { handedToHuman: true, handedToHumanAt: new Date(now - 61 * 60_000).toISOString() };
    expect(isHandoffActive(session, now)).toBe(false);
  });

  it("is inactive without the flag or a timestamp", () => {
    expect(isHandoffActive(undefined, now)).toBe(false);
    expect(isHandoffActive({ handedToHuman: true }, now)).toBe(false);
    expect(isHandoffActive({ handedToHuman: false, handedToHumanAt: new Date(now).toISOString() }, now)).toBe(false);
  });

  it("honors a custom TTL via env", () => {
    const session = { handedToHuman: true, handedToHumanAt: new Date(now - 20 * 60_000).toISOString() };
    const env = { CARA_HUMAN_HANDOFF_TTL_MIN: "10" };
    expect(isHandoffActive(session, now, env)).toBe(false); // 20 min > 10 min TTL
  });
});

describe("grounding-check FP guard", () => {
  it("only an explicit UNSUPPORTED verdict hands off — everything else fails open", () => {
    expect(parseHandoffGroundingVerdict("UNSUPPORTED")).toBe("unsupported");
    expect(parseHandoffGroundingVerdict("unsupported.")).toBe("unsupported");
    expect(parseHandoffGroundingVerdict("The draft is UNSUPPORTED by context")).toBe("unsupported");
    expect(parseHandoffGroundingVerdict("SUPPORTED")).toBe("supported");
    expect(parseHandoffGroundingVerdict("")).toBe("supported");
    expect(parseHandoffGroundingVerdict("I think it looks fine")).toBe("supported");
    expect(parseHandoffGroundingVerdict(undefined as unknown as string)).toBe("supported");
  });

  it("payload carries context, conversation tail, and the draft", () => {
    const payload = buildHandoffGroundingPayload(
      "Next visit: Maria, Tuesday 9am.",
      [
        { role: "user", content: "who is coming this week?" },
        { role: "assistant", content: "Let me check." },
      ],
      "Maria is coming Tuesday at 9am.",
    );
    expect(payload).toContain("CONTEXT:");
    expect(payload).toContain("Next visit: Maria, Tuesday 9am.");
    expect(payload).toContain("USER: who is coming this week?");
    expect(payload).toContain("DRAFT:\nMaria is coming Tuesday at 9am.");
  });

  it("carries this turn's tool observations when provided", () => {
    const payload = buildHandoffGroundingPayload(
      "ctx", [], "Maria arrives at 9am.", "get_schedule → Maria, Tuesday 9am",
    );
    expect(payload).toContain("TOOL RESULTS THIS TURN:");
    expect(payload).toContain("get_schedule → Maria, Tuesday 9am");
  });

  it("shows (none) for tool results when omitted", () => {
    const payload = buildHandoffGroundingPayload("ctx", [], "draft");
    expect(payload).toContain("TOOL RESULTS THIS TURN:\n(none)");
  });

  it("bounds an oversized system context AND tool results (quick-tier cost cap)", () => {
    const payload = buildHandoffGroundingPayload("x".repeat(50_000), [], "draft", "y".repeat(50_000));
    expect(payload.length).toBeLessThan(21_000); // 12k context + 8k tools + labels + elision markers
  });

  it("keeps BOTH ends of oversized material — facts appended late (care plan, last tool result) still ground the claim", () => {
    const context = `HEAD-FACT: Maria visits Tuesday.\n${"x".repeat(50_000)}\nTAIL-FACT: care plan lists Lisinopril.`;
    const tools = `first tool output\n${"y".repeat(50_000)}\nLAST-TOOL: invoice is $85`;
    const payload = buildHandoffGroundingPayload(context, [], "draft", tools);
    expect(payload).toContain("HEAD-FACT");
    expect(payload).toContain("TAIL-FACT");
    expect(payload).toContain("LAST-TOOL");
    expect(payload).toContain("[…middle truncated…]");
  });

  it("keeps only the last 8 conversation turns", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn-${i}`,
    }));
    const payload = buildHandoffGroundingPayload("ctx", history, "draft");
    expect(payload).toContain("turn-19");
    expect(payload).toContain("turn-12");
    expect(payload).not.toContain("turn-11");
  });
});

describe("handoffTtlMs / isHandoffGateEnabled", () => {
  it("defaults to 60 minutes", () => {
    expect(handoffTtlMs({})).toBe(60 * 60_000);
  });
  it("clamps invalid TTL to the default", () => {
    expect(handoffTtlMs({ CARA_HUMAN_HANDOFF_TTL_MIN: "-5" })).toBe(60 * 60_000);
    expect(handoffTtlMs({ CARA_HUMAN_HANDOFF_TTL_MIN: "abc" })).toBe(60 * 60_000);
  });
  it("gate is on by default, off only on explicit false", () => {
    expect(isHandoffGateEnabled({})).toBe(true);
    expect(isHandoffGateEnabled({ CARA_CONFIDENCE_HANDOFF: "FALSE" })).toBe(false);
  });
});
