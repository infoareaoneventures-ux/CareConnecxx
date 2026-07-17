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
    expect(catchBlock).toContain("return { reply: fallback(), triggered: true, swapped: true };");
    // The old fail-open return must be gone from the catch.
    expect(catchBlock).not.toContain("swapped: false");
  });

  it("only an explicit SUPPORTED verdict lets the model reply through", () => {
    expect(gateBody).toContain("\\bSUPPORTED\\b");
    expect(gateBody).toContain("\\bUNSUPPORTED\\b");
    // Garbage must not be normalized through the main gate's fail-open parser.
    expect(gateBody).not.toContain("parseHandoffGroundingVerdict(");
  });
});
