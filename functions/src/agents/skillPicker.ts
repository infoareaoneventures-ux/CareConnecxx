// Skill picker — decides at most ONE skill to inject into Cara's system
// prompt for the current turn. Runs in parallel with the rest of the
// pre-Sonnet pipeline (intent classifier, emotional context, voice mirror)
// so the latency hides behind I/O.
//
// Why a separate picker instead of just listing skills in Sonnet's system
// prompt? Two reasons:
//   1. Token economy. Each SKILL.md body is ~500-1500 tokens. Injecting all
//      of them every turn would blow up the prompt-cache base by ~5-10k
//      tokens. The picker keeps the body cost paid only when a skill
//      actually applies.
//   2. Picker accuracy. gpt-4o-mini is good at "which of these descriptions
//      matches this user text" — better than Sonnet's diffuse attention
//      across a giant system prompt would be at the same job.
//
// The picker returns a skill NAME (string) or null. The caller is responsible
// for looking up the body via findSkill() and injecting it.

import { quickComplete } from "../utils/openaiClient";
import { getSkillRegistry, renderSkillMetadataForPicker } from "./skills";

export interface PickSkillResult {
  skill:      string | null;
  durationMs: number;
}

const SYSTEM_PROMPT = [
  "You are a skill router for Cara, an SMS care-coordination agent.",
  "You receive a list of skill names + descriptions and a user message.",
  "Output the SINGLE skill name that best matches, or the literal string \"none\" if no skill clearly applies.",
  "Reply with only the skill name or \"none\" — no punctuation, no explanation, no quotes.",
  "When in doubt, choose \"none\". A wrong skill is worse than no skill.",
].join("\n");

/**
 * Pick the best skill for the user's message, or null if none applies.
 *
 * Latency budget: ~400ms (single gpt-4o-mini call, ~10 token output).
 * Failure mode: returns null with no thrown error — the caller proceeds
 * without a skill rather than crashing the turn.
 */
export async function pickSkill(
  userText: string,
  opts:     { signal?: AbortSignal } = {},
): Promise<PickSkillResult> {
  const startedAt = Date.now();

  const trimmed = (userText ?? "").trim();
  if (!trimmed) {
    return { skill: null, durationMs: Date.now() - startedAt };
  }

  const metadata = renderSkillMetadataForPicker();
  if (!metadata) {
    return { skill: null, durationMs: Date.now() - startedAt };
  }

  const prompt = [
    "Available skills:",
    metadata,
    "",
    "User message:",
    trimmed.slice(0, 1000), // protect against pathological lengths
    "",
    "Skill name to use (or \"none\"):",
  ].join("\n");

  let raw: string;
  try {
    raw = (await quickComplete(SYSTEM_PROMPT, prompt, {
      maxTokens: 20,
      signal:    opts.signal,
    })) ?? "";
  } catch (err) {
    console.warn("skillPicker: gpt-4o-mini failed, returning no skill", err);
    return { skill: null, durationMs: Date.now() - startedAt };
  }

  // Extract the first hyphen-case token, ignoring surrounding punctuation,
  // quotes, or trailing periods. gpt-4o-mini occasionally adds these despite
  // the system prompt.
  const lowered = raw.toLowerCase().trim();
  const tokenMatch = lowered.match(/[a-z][a-z0-9-]*/);
  const cleaned = tokenMatch ? tokenMatch[0] : "";

  if (!cleaned || cleaned === "none") {
    return { skill: null, durationMs: Date.now() - startedAt };
  }

  // Validate against the registry — anything else (hallucinated names,
  // partial matches) is treated as "none". This is the safety net for
  // gpt-4o-mini ignoring its instructions.
  const reg = getSkillRegistry();
  const match = reg.find(s => s.name === cleaned);
  if (!match) {
    return { skill: null, durationMs: Date.now() - startedAt };
  }

  return { skill: match.name, durationMs: Date.now() - startedAt };
}
