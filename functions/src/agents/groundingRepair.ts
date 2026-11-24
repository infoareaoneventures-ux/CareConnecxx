// Repair, don't just block: what the grounding gate does with a draft whose claims it could not back.
//
// Until now an unbacked, non-risky draft was replaced by one canned line. Live 2026-11-23 that line went to three questions in a
// row ("when does the shift end?", "do I have a shift in progress?"), each time throwing away an answer that was probably right
// and giving the person nothing. The better move is what a careful person would do: keep what is backed, drop what isn't,
// and say plainly what could not be found. This module rewrites the draft ONCE from the evidence, re-checks the rewrite with the
// same checker, and only falls back to the neutral line when the rewrite is still not backed.
import { buildHandoffGroundingPayload, GROUNDING_REASK_COPY, HANDOFF_GROUNDING_SYSTEM_PROMPT, parseGroundingVerdictTyped } from "./humanHandoff";
import { classifyGroundingClaims } from "./groundingClaims";

export const GROUNDING_REPAIR_SYSTEM_PROMPT =
  "You are Evia, a warm, brief SMS care coordinator. Below you get CONTEXT (account data), RECENT CONVERSATION, the person's CURRENT MESSAGE, " +
  "TOOL RESULTS from this turn, and a DRAFT reply that contained facts a fact-check could not find in that material. " +
  "Write the reply again using ONLY facts that appear in CONTEXT, RECENT CONVERSATION, the CURRENT MESSAGE or TOOL RESULTS. " +
  "Keep every fact that IS there. Remove any fact that is not — never guess a time, a date, a count or a name. " +
  "If part of the question cannot be answered from that material, say so in one short plain sentence (for example \"I can't see an end time on that visit\"), " +
  "and give the part you can. Answer the question that was asked; do not ask the person to repeat it unless nothing at all can be answered. " +
  "Do not add offers, next steps or questions that were not in the DRAFT. Do not mention a checker, a gate or a system. " +
  "No markdown, no greeting, at most three short sentences. Output only the message.";

export interface RepairDeps {
  /** One quick-tier completion (system, user, opts) → text. Injected so the logic is testable without a model. */
  complete: (system: string, user: string, opts: { maxTokens: number }) => Promise<string>;
}

export interface RepairInput {
  draft: string;
  userText: string;
  systemContext: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  toolObservations: string;
}

export interface RepairResult {
  reply: string;
  /** "repaired" = a rewrite that passed the same check; "fallback" = the neutral line. */
  outcome: "repaired" | "fallback";
  /** Why it fell back (no content, just the cause): the model gave nothing, the re-check rejected the rewrite, or a call failed. */
  reason?: "empty" | "rejected" | "error";
}

export async function repairUnsupportedDraft(input: RepairInput, deps: RepairDeps): Promise<RepairResult> {
  const fallback = (reason: "empty" | "rejected" | "error"): RepairResult => ({ reply: GROUNDING_REASK_COPY, outcome: "fallback", reason });
  try {
    const payload = buildHandoffGroundingPayload(input.systemContext, input.history, input.draft, input.toolObservations, input.userText);
    const rewritten = (await deps.complete(GROUNDING_REPAIR_SYSTEM_PROMPT, payload, { maxTokens: 220 })).trim();
    if (!rewritten) return fallback("empty");
    // A rewrite that keeps no facts needs no check; one that still states facts is checked by the same gate that rejected the draft.
    // (A digit means a time, date, count or amount: those are always re-checked, whether or not the claim detector flags them.)
    if (!/\d/.test(rewritten) && classifyGroundingClaims(rewritten).length === 0) return { reply: rewritten, outcome: "repaired" };
    const verdict = parseGroundingVerdictTyped(
      await deps.complete(
        HANDOFF_GROUNDING_SYSTEM_PROMPT,
        buildHandoffGroundingPayload(input.systemContext, input.history, rewritten, input.toolObservations, input.userText),
        { maxTokens: 8 },
      ),
    );
    return verdict === "supported" ? { reply: rewritten, outcome: "repaired" } : fallback("rejected");
  } catch {
    return fallback("error");
  }
}
