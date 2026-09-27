import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  shouldHandOffToHuman,
  isHandoffActive,
  handoffTtlMs,
  isHandoffGateEnabled,
  buildHandoffGroundingPayload,
  parseHandoffGroundingVerdict,
  parseGroundingVerdictTyped,
  isRiskTierGroundingEnabled,
  neutralCopyForClaims,
  resolveGroundingGateAction,
  GROUNDING_NEUTRAL_COPY,
  HANDOFF_GROUNDING_SYSTEM_PROMPT,
} from "./humanHandoff";
import { classifyGroundingClaims } from "./groundingClaims";

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

describe("U7: current-inbound evidence block (R19)", () => {
  it("carries the current user message as its own labeled block", () => {
    const payload = buildHandoffGroundingPayload(
      "ctx", [], "Got it — since your mom is 82, I'll keep that in mind.", "",
      "my mom is 82 and lives in Sacramento",
    );
    expect(payload).toContain("CURRENT USER MESSAGE:\nmy mom is 82 and lives in Sacramento");
    // Block ordering: the inbound sits between the conversation and tool results.
    expect(payload.indexOf("RECENT CONVERSATION:")).toBeLessThan(payload.indexOf("CURRENT USER MESSAGE:"));
    expect(payload.indexOf("CURRENT USER MESSAGE:")).toBeLessThan(payload.indexOf("TOOL RESULTS THIS TURN:"));
  });

  it("shows (none) when no current inbound is provided (legacy 4-arg call sites)", () => {
    const payload = buildHandoffGroundingPayload("ctx", [], "draft");
    expect(payload).toContain("CURRENT USER MESSAGE:\n(none)");
  });

  it("bounds an oversized inbound", () => {
    const payload = buildHandoffGroundingPayload("ctx", [], "draft", "", "z".repeat(50_000));
    expect(payload.length).toBeLessThan(4_000);
    expect(payload).toContain("[…middle truncated…]");
  });

  it("the verifier prompt instructs that facts from the CURRENT MESSAGE are supported", () => {
    // R19 explicit contract: a draft that truthfully repeats a fact the user
    // just shared must be verifiable as SUPPORTED.
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("CURRENT MESSAGE is SUPPORTED");
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("CURRENT MESSAGE");
  });

  // 2026-09-08 (live-caught): "are you sure the 5pm interview was completed?"
  // repeats the disputed claim's exact words back as a challenge, not an
  // assertion — Evia doubled down on the (wrong, fabricated-date) claim
  // instead of the verifier catching it, because the CURRENT MESSAGE rule
  // above didn't distinguish a user asserting a fact from a user questioning
  // one. Locks in the fix: a challenge must never count as confirmation.
  it("the verifier prompt instructs that a challenge to a fact is not confirmation of it", () => {
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("QUESTIONS or CHALLENGES a fact");
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("skepticism is not support");
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("never one that merely asks about or challenges");
  });

  // 2026-09-12 (live-caught): asked "who's on my care team", Evia claimed a
  // caregiver (deleted from booking_requests, with no appointments record
  // either — genuinely no longer any relationship on file) was still "your
  // only care team member" — apparently supported only by RECENT
  // CONVERSATION (that name had been mentioned a few turns earlier as a
  // shown/discussed candidate), with no tool actually called to check
  // current membership. The RECENT-CONVERSATION-insufficient exception
  // already existed for schedule/availability claims (2026-09-06) but never
  // covered care-team/role claims (relationship_identity) — the exact same
  // gap shape, one more category.
  it("the RECENT-CONVERSATION-insufficient exception also covers who currently holds a care-team role, not just schedule/availability", () => {
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("who is on the family's care team");
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("A caregiver merely SHOWN or DISCUSSED earlier in this conversation");
    expect(HANDOFF_GROUNDING_SYSTEM_PROMPT).toContain("NOT the same claim as that caregiver currently being an");
  });
});

describe("U7: parseGroundingVerdictTyped (strict, R19)", () => {
  it("parses explicit verdicts", () => {
    expect(parseGroundingVerdictTyped("SUPPORTED")).toBe("supported");
    expect(parseGroundingVerdictTyped("supported")).toBe("supported");
    expect(parseGroundingVerdictTyped("UNSUPPORTED")).toBe("unsupported");
    expect(parseGroundingVerdictTyped("The draft is UNSUPPORTED by context")).toBe("unsupported");
  });

  it("never reads SUPPORTED out of the word UNSUPPORTED", () => {
    expect(parseGroundingVerdictTyped("UNSUPPORTED")).toBe("unsupported");
  });

  it("garbage, empty, or non-string output is INDETERMINATE — never silently supported", () => {
    expect(parseGroundingVerdictTyped("")).toBe("indeterminate");
    expect(parseGroundingVerdictTyped("I think it looks fine")).toBe("indeterminate");
    expect(parseGroundingVerdictTyped(undefined)).toBe("indeterminate");
    expect(parseGroundingVerdictTyped(null)).toBe("indeterminate");
    expect(parseGroundingVerdictTyped(42 as unknown as string)).toBe("indeterminate");
  });

  it("legacy parse keeps its documented fail-open mapping (kill-switch path)", () => {
    expect(parseHandoffGroundingVerdict("total garbage")).toBe("supported");
    expect(parseHandoffGroundingVerdict("")).toBe("supported");
  });
});

describe("U7: GROUNDING_RISK_TIERS_ENABLED kill switch", () => {
  it("is ON by default (absent = on), OFF only on explicit false", () => {
    expect(isRiskTierGroundingEnabled({})).toBe(true);
    expect(isRiskTierGroundingEnabled({ GROUNDING_RISK_TIERS_ENABLED: "true" })).toBe(true);
    expect(isRiskTierGroundingEnabled({ GROUNDING_RISK_TIERS_ENABLED: "false" })).toBe(false);
    expect(isRiskTierGroundingEnabled({ GROUNDING_RISK_TIERS_ENABLED: " FALSE " })).toBe(false);
  });
});

describe("U7: deterministic neutral copy (fail-closed, R19)", () => {
  it("selects category-specific copy for high-risk claims", () => {
    expect(neutralCopyForClaims(classifyGroundingClaims("She has Parkinson's.")))
      .toBe(GROUNDING_NEUTRAL_COPY.medical);
    expect(neutralCopyForClaims(classifyGroundingClaims("She is allergic to penicillin.")))
      .toBe(GROUNDING_NEUTRAL_COPY.medical);
    expect(neutralCopyForClaims(classifyGroundingClaims("Your refund was processed yesterday.")))
      .toBe(GROUNDING_NEUTRAL_COPY.payment);
    expect(neutralCopyForClaims(classifyGroundingClaims("I've cancelled Thursday's visit for you.")))
      .toBe(GROUNDING_NEUTRAL_COPY.action);
    expect(neutralCopyForClaims(classifyGroundingClaims("He is her son.")))
      .toBe(GROUNDING_NEUTRAL_COPY.identity);
  });

  it("medical copy wins when several high-risk categories co-occur", () => {
    const claims = classifyGroundingClaims("She has Parkinson's and your invoice was $340.");
    expect(neutralCopyForClaims(claims)).toBe(GROUNDING_NEUTRAL_COPY.medical);
  });

  it("returns null for low-risk-only or empty claim sets (documented fail-open fallback)", () => {
    expect(neutralCopyForClaims(classifyGroundingClaims("She lives in Sacramento."))).toBeNull();
    expect(neutralCopyForClaims([])).toBeNull();
  });

  it("every neutral copy string is honest double-check copy, not an invented fact", () => {
    for (const copy of Object.values(GROUNDING_NEUTRAL_COPY)) {
      expect(copy.toLowerCase()).toMatch(/double-check|verify/);
      // and must never itself classify as a claim (loop guard — asserted in
      // groundingClaims.test.ts as well from the classifier side)
      expect(classifyGroundingClaims(copy)).toEqual([]);
    }
  });
});

describe("U7: resolveGroundingGateAction", () => {
  const high = classifyGroundingClaims("She has Parkinson's.");
  const low = classifyGroundingClaims("She lives in Sacramento.");

  it("unsupported → handoff (the true invented-fact case, unchanged)", () => {
    expect(resolveGroundingGateAction({ verdict: "unsupported", claims: high, riskTiersEnabled: true })).toBe("handoff");
    expect(resolveGroundingGateAction({ verdict: "unsupported", claims: low, riskTiersEnabled: true })).toBe("handoff");
  });

  it("supported → send (grounded claims pass unchanged)", () => {
    expect(resolveGroundingGateAction({ verdict: "supported", claims: high, riskTiersEnabled: true })).toBe("send");
  });

  it("indeterminate + high risk → neutralize (fail CLOSED, R19)", () => {
    expect(resolveGroundingGateAction({ verdict: "indeterminate", claims: high, riskTiersEnabled: true })).toBe("neutralize");
  });

  it("indeterminate + low risk → send (documented pre-U7 fail-open fallback)", () => {
    expect(resolveGroundingGateAction({ verdict: "indeterminate", claims: low, riskTiersEnabled: true })).toBe("send");
  });

  it("kill switch off → legacy fail-open even for high risk", () => {
    expect(resolveGroundingGateAction({ verdict: "indeterminate", claims: high, riskTiersEnabled: false })).toBe("send");
  });
});

describe("U7: crisis handling stays AHEAD of the grounding gate", () => {
  it("handleInbound runs crisis detection before any QA-agent dispatch", () => {
    // The grounding gate lives inside runQaAgent's post-processing; crisis
    // detection short-circuits in webhooks.handleInbound BEFORE runQaAgent /
    // quick-reply routing, so an emergency message can never be neutralized or
    // held by this gate. Source-order characterization: if someone moves agent
    // dispatch above crisis detection, this fails loudly.
    const src = fs.readFileSync(path.resolve(__dirname, "../linq/webhooks.ts"), "utf8");
    const crisisIdx = src.indexOf("detectCrisis(text)");
    const qaIdx = src.indexOf("await runQaAgent(");
    expect(crisisIdx).toBeGreaterThan(-1);
    expect(qaIdx).toBeGreaterThan(-1);
    expect(crisisIdx).toBeLessThan(qaIdx);
    // And the crisis fast-path RETURNS (short-circuit), it doesn't fall through.
    const crisisBlock = src.slice(crisisIdx, qaIdx);
    expect(crisisBlock).toContain("return;");
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

// 2026-09-27 (founder): the support-room note is read by the person in their
// own Inbox, so it speaks to them — same words as the text they got — and
// carries their message for the teammate. Identical for families and caregivers.
describe("handoffRoomNote", () => {
  it("addresses the person, matches the handoff text, and quotes their message", async () => {
    const { handoffRoomNote, HUMAN_HANDOFF_COPY } = await import("./humanHandoff");
    const note = handoffRoomNote("Monday at 9am");
    expect(note).toBe('Evia looped in a teammate to double-check this — they\'ll reply here. Your message: "Monday at 9am"');
    expect(note).not.toMatch(/told them|Their message|wasn't confident/);
    expect(HUMAN_HANDOFF_COPY).toContain("looping in a teammate");
  });
  it("caps a long message at 500 characters", async () => {
    const { handoffRoomNote } = await import("./humanHandoff");
    expect(handoffRoomNote("x".repeat(900))).toContain(`"${"x".repeat(500)}"`);
  });
});
