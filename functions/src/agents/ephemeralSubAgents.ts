import type Anthropic from "@anthropic-ai/sdk";
import { quickComplete } from "../utils/openaiClient";
import { getSharedClient } from "../utils/claudeClient";
import { callClaudeWithRetry } from "../utils/claudeRetry";

// Ephemeral sub-agents — the DeepAgents `task` pattern, ported to TS.
//
// These are STATELESS, single-shot, parallel-callable mini-agents. The main
// QA agent can call `task("decompose budget impact for X", "budget_impact")`,
// the sub-agent runs to completion with its own focused system prompt and
// narrow tool surface, returns a string, and dies. Multiple `task` calls in
// one Sonnet turn run concurrently.
//
// This is intentionally distinct from our existing executionAgent — that's
// stateful, cross-turn, 24h persistent goal trackers (matching, replacement,
// research). Sub-agents here are single-call helpers that exist only within
// the parent's turn.
//
// v1 scope (kept small to keep the surface area auditable):
//   • journal_summarizer  — distill a list of journal entries into a one-paragraph clinical-flavor summary
//   • caregiver_compare   — given 2+ caregiver records, recommend one for a specific shift with reasoning
//   • budget_impact       — given current rate/hours + a proposed change, compute monthly delta in plain English
//
// All three use a SINGLE LLM call, not a nested tool loop. That keeps latency
// bounded (each sub-agent ≤ ~1.5s) and parent-turn budget predictable. If a
// sub-agent later needs tools, expand `runEphemeralSubAgent` to support a
// narrow tool slice — the registry is the right place to evolve.

export interface SubAgentDefinition {
  name:         string;
  description:  string;
  /** When true, route to Sonnet for nuance. When false (default), gpt-4o-mini is enough. */
  needsSonnet?: boolean;
  systemPrompt: string;
  /** Optional input shape hint — used for tool description only, not runtime. */
  inputs?: string;
}

export const SUB_AGENT_REGISTRY: Record<string, SubAgentDefinition> = {
  journal_summarizer: {
    name:        "journal_summarizer",
    description:
      "Distill a list of care journal entries into a single warm-but-clinical paragraph for the family. " +
      "Pass the entries verbatim in `description` (you can include dates, moods, meals, meds, notes).",
    needsSonnet: false,
    inputs: "description should contain a list of journal entries with timestamps, moods, meals/meds flags, and notes.",
    systemPrompt:
      "You summarize a list of care journal entries for a family member. " +
      "Output one paragraph (3-5 sentences) of natural, warm prose that highlights TRENDS, not individual entries. " +
      "Call out patterns (3+ days of low appetite, repeated mood dips, missed meds) explicitly. " +
      "If there is nothing concerning, say so plainly. " +
      "Do not include greetings, sign-offs, bullet points, or markdown. " +
      "Reference dates only when a pattern starts or breaks. " +
      "Never invent details that aren't in the input.",
  },

  caregiver_compare: {
    name:        "caregiver_compare",
    description:
      "Compare two or more caregivers and recommend one for a specific shift. " +
      "Pass each caregiver's name, rate, specialties, rating, and any context in `description`.",
    needsSonnet: true, // tradeoffs need real reasoning
    inputs: "description should contain shift requirements + a list of caregivers (name, rate, specialties, rating).",
    systemPrompt:
      "You compare caregivers for a specific shift and pick one. " +
      "Output exactly two sentences: " +
      "Sentence 1 names your recommendation and the single biggest reason. " +
      "Sentence 2 names the runner-up and the one trade-off that decided it. " +
      "No headers, no lists, no hedging. If the choice is genuinely close, say \"close call\" in sentence 1.",
  },

  budget_impact: {
    name:        "budget_impact",
    description:
      "Compute the approximate monthly billing impact of a proposed care change. " +
      "Pass current hours/rate and proposed hours/rate in `description`.",
    needsSonnet: false,
    inputs: "description should contain current rate, current hours/week, proposed rate, proposed hours/week.",
    systemPrompt:
      "You compute approximate monthly cost changes for home care. " +
      "Assume 4.33 weeks per month. Output exactly one short paragraph: " +
      "the current monthly total, the new monthly total, the delta in dollars, and whether it's an increase or decrease. " +
      "Use plain language (\"about $X more per month\"). No tables, no math notation.",
  },

  // Internal — invoked automatically by the qaAgent tool loop after 2+
  // consecutive tool-error iterations. NOT meant for the main agent to call
  // directly (excluded from buildTaskToolDescription and the `task` enum).
  recovery: {
    name:        "recovery",
    description:
      "(Internal) Diagnose why the main agent keeps hitting tool errors and propose a different approach.",
    needsSonnet: true,
    inputs:
      "description should contain: the original user request, the tools tried, and the recent error messages.",
    systemPrompt:
      "You are a recovery analyst for an SMS care-coordination agent (Cara). The main agent has hit two or more consecutive tool errors in a single turn. " +
      "Your job: read the situation, then return TWO short sentences. " +
      "Sentence 1: the most likely reason the tools are failing (wrong tool, missing arg, retrying an unavailable resource, etc). " +
      "Sentence 2: a concrete different approach (a different tool, asking the user one clarifying question, or replying without tools). " +
      "Never propose retrying the exact same call. Never apologize. No headers, no lists, no markdown.",
  },
};

/** Sub-agent names the parent agent must NOT invoke via `task` (internal-only). */
export const INTERNAL_SUB_AGENT_NAMES = new Set<string>(["recovery"]);

/** Sub-agent names the parent agent CAN invoke via the `task` MCP tool. */
export function getPublicSubAgentNames(): string[] {
  return Object.keys(SUB_AGENT_REGISTRY).filter(n => !INTERNAL_SUB_AGENT_NAMES.has(n));
}

export interface RunSubAgentResult {
  output:        string;
  subagentType:  string;
  durationMs:    number;
  modelUsed:     "gpt-4o-mini" | "claude-sonnet-4-6";
}

/**
 * Execute a single ephemeral sub-agent. Returns the raw text output. Throws
 * only on infrastructure errors — bad subagent_type and empty descriptions
 * return a structured error string that the parent agent can act on without
 * crashing its turn.
 */
export async function runEphemeralSubAgent(opts: {
  subagentType: string;
  description:  string;
  /** Optional max tokens override. Defaults are tuned per sub-agent. */
  maxTokens?:   number;
  signal?:      AbortSignal;
}): Promise<RunSubAgentResult> {
  const startedAt = Date.now();
  const def = SUB_AGENT_REGISTRY[opts.subagentType];

  if (!def) {
    return {
      output:       `ERROR: unknown subagent_type "${opts.subagentType}". Available: ${Object.keys(SUB_AGENT_REGISTRY).join(", ")}.`,
      subagentType: opts.subagentType,
      durationMs:   Date.now() - startedAt,
      modelUsed:    "gpt-4o-mini",
    };
  }

  const description = (opts.description ?? "").trim();
  if (!description) {
    return {
      output:       "ERROR: description is required and was empty.",
      subagentType: opts.subagentType,
      durationMs:   Date.now() - startedAt,
      modelUsed:    "gpt-4o-mini",
    };
  }

  const maxTokens = opts.maxTokens ?? (def.needsSonnet ? 400 : 250);

  if (def.needsSonnet) {
    try {
      const resp = await callClaudeWithRetry(
        getSharedClient(),
        {
          model:      "claude-sonnet-4-6",
          max_tokens: maxTokens,
          system:     def.systemPrompt,
          messages:   [{ role: "user", content: description } as Anthropic.MessageParam],
        },
      );
      const text = ((resp.content[0] as { text?: string } | undefined)?.text ?? "").trim();
      return {
        output:       text || "(empty)",
        subagentType: def.name,
        durationMs:   Date.now() - startedAt,
        modelUsed:    "claude-sonnet-4-6",
      };
    } catch (err) {
      console.error(`subagent ${def.name} failed:`, err);
      return {
        output:       "ERROR: sub-agent failed. The main agent should try a direct approach.",
        subagentType: def.name,
        durationMs:   Date.now() - startedAt,
        modelUsed:    "claude-sonnet-4-6",
      };
    }
  }

  // Lightweight path — gpt-4o-mini for the bulk of analytical work.
  const text = await quickComplete(def.systemPrompt, description, { maxTokens, signal: opts.signal })
    .catch((err) => {
      console.error(`subagent ${def.name} (mini) failed:`, err);
      return "ERROR: sub-agent failed. The main agent should try a direct approach.";
    });

  return {
    output:       (text ?? "").trim() || "(empty)",
    subagentType: def.name,
    durationMs:   Date.now() - startedAt,
    modelUsed:    "gpt-4o-mini",
  };
}

/**
 * Build the MCP tool description for `task`. Surfaces the registry's
 * sub-agent names + descriptions so Claude can pick the right one without
 * us hardcoding tool variants per type. Single tool, multiple targets.
 */
export function buildTaskToolDescription(): string {
  const lines = Object.values(SUB_AGENT_REGISTRY)
    .filter(d => !INTERNAL_SUB_AGENT_NAMES.has(d.name))
    .map(d => `  • ${d.name}: ${d.description}`);
  return [
    "Delegate a focused analytical chunk to an ephemeral sub-agent. The sub-agent has its own focused system prompt and returns a single text result.",
    "Use this when a turn needs a distinct piece of analysis that would otherwise pollute your main reasoning (e.g. summarizing many journal entries, comparing caregivers, computing budget impact).",
    "You can call `task` multiple times in one turn — independent calls run in parallel.",
    "Available sub-agents:",
    ...lines,
  ].join("\n");
}
