import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * U4 prompt-rule guard (hallucination hardening, R5/R10/R16).
 *
 * Source-text assertions in the style of mcp/__tests__/parity.test.ts and the
 * skip-flag guards in qaAgent.history.test.ts: read qaAgent.ts and assert the
 * rule text exists in BOTH system-prompt builders, so a future edit that drops
 * a grounding rule (or restores client/caregiver asymmetry) fails the build.
 *
 * Behavior tests for the quick-reply grounding gate (checker throws → fallback,
 * garbage verdict → fallback, SUPPORTED → model reply) live alongside the
 * existing gateQuickReplyGrounding suite in qaAgent.test.ts — this file only
 * pins the fail-closed wiring at the source level.
 */

const qaSrc = readFileSync(resolve(__dirname, "../qaAgent.ts"), "utf8");

// Builder slices — scope assertions to the right prompt so one builder can't
// satisfy a rule on the other's behalf.
const clientStart = qaSrc.indexOf("export function buildClientSystemPrompt");
const caregiverStart = qaSrc.indexOf("function buildCaregiverSystemPrompt(");
const caregiverEnd = qaSrc.indexOf("// ── Prefetch cache");
const clientPrompt = qaSrc.slice(clientStart, caregiverStart);
const caregiverPrompt = qaSrc.slice(caregiverStart, caregiverEnd);

it("builder slices resolve (guards against renames silently emptying the assertions)", () => {
  expect(clientStart).toBeGreaterThan(-1);
  expect(caregiverStart).toBeGreaterThan(clientStart);
  expect(caregiverEnd).toBeGreaterThan(caregiverStart);
});

describe("shared rules — present in BOTH client and caregiver prompts", () => {
  const both: Array<[string, string]> = [
    ["never-invent-people", "Never invent a person's name"],
    ["never-deny-unseen-message", "Never assert you did or did not send a message you have no record of — offer to (re)send instead."],
    ["empty-tool-result", "An empty or null tool result means none exist — say so plainly (\"nothing on file\"), never invent entries."],
    ["never-invent-locations", "Never invent a city, neighborhood, address, or zip code."],
    ["knowledge-boundary header", "KNOWLEDGE BOUNDARY (non-negotiable):"],
    ["_toolError handling", "\"_toolError\": true"],
    ["no-gap-filling", "Do not fill gaps with plausible-sounding details."],
    ["dont-know fallback", "I don't have that information yet"],
    ["memory-source priority", "MEMORY_SOURCE_PRIORITY_POLICY,"],
  ];

  it.each(both)("client prompt contains the %s rule", (_label, text) => {
    expect(clientPrompt).toContain(text);
  });

  it.each(both)("caregiver prompt contains the %s rule (parity)", (_label, text) => {
    expect(caregiverPrompt).toContain(text);
  });
});

describe("client KNOWLEDGE BOUNDARY — people extension (R5)", () => {
  it("forbids inventing names, caregivers, and relationships, not just locations", () => {
    expect(clientPrompt).toContain("Never invent a person's name, a caregiver, or a relationship.");
  });
});

// 2026-09-12: the old reschedule instruction (cancel_interview + schedule_interview)
// caused a real 2026-09-09 incident (schedule_interview called with a
// caregiverId: "unknown" placeholder) precisely because it required looking up
// the OTHER party's real id to book a brand-new interview. The new
// reschedule_interview/accept_interview_reschedule tools move the SAME interview
// in place — no second interview is created, so there is no caregiverId to guess.
describe("reschedule instruction uses the in-place reschedule tools, not cancel+rebook (2026-09-12)", () => {
  it("tells the model to use reschedule_interview on the same interview, never cancel_interview + schedule_interview", () => {
    expect(clientPrompt).toContain("use reschedule_interview, passing the SAME interviewId");
    expect(clientPrompt).toContain("Do NOT use cancel_interview + schedule_interview for this anymore");
  });
  it("tells the model accept_interview_reschedule confirms a pending proposal instead of re-proposing", () => {
    expect(clientPrompt).toContain("call accept_interview_reschedule");
    expect(clientPrompt).toContain("do NOT call reschedule_interview again for an acceptance");
  });
});

// Same class of gap, a different trigger: the family accepting a caregiver's
// counter-proposed time (decline + proposedDate/proposedTime) has no dedicated
// instruction at all before this fix, so it was exposed to the same
// guessed/placeholder caregiverId risk as the reschedule case above.
describe("accepting a caregiver's counter-proposed time also requires a real caregiverId lookup (2026-09-09)", () => {
  it("tells the model to look up the real caregiverId and not to cancel the already-declined original interview", () => {
    expect(clientPrompt).toContain("counter-proposed time");
    expect(clientPrompt).toContain("do NOT call cancel_interview on it");
  });
});

describe("caregiver prompt parity details (R16)", () => {
  it("scopes stateable facts to the grounded sources", () => {
    expect(caregiverPrompt).toContain("tool results from this conversation");
  });

  it("reuses the shared MEMORY_SOURCE_PRIORITY_POLICY constant instead of duplicating its text", () => {
    // The constant is interpolated, never pasted: its literal body must appear
    // exactly once in the whole module (the export near the top).
    expect(caregiverPrompt).toContain("MEMORY_SOURCE_PRIORITY_POLICY,");
    const bodyHits = qaSrc.split("<memory_source_priority>").length - 1;
    expect(bodyHits).toBe(1);
  });
});

describe("quick-reply grounding gate fails CLOSED (source wiring)", () => {
  const gateStart = qaSrc.indexOf("export async function gateQuickReplyGrounding");
  const gateEnd = qaSrc.indexOf("export async function runQuickReply");
  const gateBody = qaSrc.slice(gateStart, gateEnd);

  it("gate body resolves", () => {
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
  });

  it("checker error path returns the deterministic fallback (swapped), not the model reply", () => {
    const catchBlock = gateBody.slice(gateBody.indexOf("} catch {"));
    // U7: the catch now also reports a typed indeterminate verdict, but the
    // fail-closed swap is unchanged.
    expect(catchBlock).toContain('return { reply: fallback(), triggered: true, swapped: true, claims, verdict: "indeterminate" };');
    // The old fail-open return must be gone from the catch.
    expect(catchBlock).not.toContain("swapped: false");
  });

  it("only an explicit SUPPORTED verdict lets the model reply through", () => {
    // U7: verdict parsing is the shared typed parser (garbage → indeterminate),
    // and anything short of an explicit supported swaps to the fallback.
    expect(gateBody).toContain("parseGroundingVerdictTyped(verdictRaw)");
    expect(gateBody).toContain('if (verdict !== "supported")');
    // Garbage must not be normalized through the main gate's fail-open parser.
    expect(gateBody).not.toContain("parseHandoffGroundingVerdict(");
  });
});
