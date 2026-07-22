// State-aware tool packs (plan 2026-07-18-001 U6, R28-R29, KTD11).
//
// The legacy intent filter (selectToolsForIntent) already narrows tools for
// SPECIFIC intents; its gap is broad/null intents (QUESTION, TASK_REPLY,
// UPDATE_ONBOARDING) which return the full catalog. This selector closes
// exactly that gap: when a broad turn arrives WITH an active foreground
// objective, the objective's intent — not the message's — picks the
// capability set. One registry only (KTD11): capabilities come from
// toolCapabilities' existing maps; this module adds no second tagging.
//
// Fail-open contract: any condition this selector doesn't confidently
// understand (specific intent, no foreground, unknown objective intent, or a
// suspiciously small result) returns null and the caller uses the legacy
// path unchanged. The kill switch is the `tool_packs` rollout policy.

import type { Intent } from "./intentClassifier";
import {
  CORE_TOOL_NAMES,
  TOOL_CAPABILITIES,
  INTENT_CAPABILITIES,
  type Capability,
} from "./toolCapabilities";

export const TOOL_PACKS_CAPABILITY = "tool_packs";

// A pack smaller than this is more likely a mapping gap than a good focus —
// fail open to the legacy surface rather than starving the model (R29).
export const MIN_PACK_SIZE = 8;

// Objective-intent slug (prefix) → capability set. Reuses the same Capability
// vocabulary as INTENT_CAPABILITIES; extend as ledger intents are minted.
const OBJECTIVE_INTENT_CAPABILITIES: ReadonlyArray<[prefix: string, caps: readonly Capability[]]> = [
  ["legacy.booking",  ["booking", "scheduling", "messaging"]],
  ["legacy.matching", ["booking", "messaging"]],
  ["schedule.",       ["booking", "scheduling", "messaging"]],
  ["billing.",        ["billing", "messaging"]],
  ["careplan.",       ["care_plan", "messaging"]],
];

export interface ToolPackResult<T> {
  tools: T[];
  packName: string;
}

/**
 * Narrow a BROAD turn's tool surface using the foreground objective's intent.
 * Returns null whenever the legacy path should be used instead (fail-open).
 */
export function selectToolPack<T extends { name: string }>(
  baseTools: T[],
  input: { intent: Intent | null | undefined; foregroundIntent: string | null | undefined },
): ToolPackResult<T> | null {
  // Specific intents: the legacy filter already handles them — don't stack.
  if (input.intent) {
    const required = INTENT_CAPABILITIES[input.intent];
    if (required && required.length > 0) return null;
  }
  if (!input.foregroundIntent) return null;

  const match = OBJECTIVE_INTENT_CAPABILITIES.find(([prefix]) =>
    input.foregroundIntent!.startsWith(prefix));
  if (!match) return null;

  const requiredSet = new Set<Capability>(match[1]);
  const tools = baseTools.filter((t) => {
    if (CORE_TOOL_NAMES.has(t.name)) return true;
    const caps = TOOL_CAPABILITIES[t.name];
    if (!caps || caps.length === 0) return true; // unmapped → safe include (KTD12 gate later)
    return caps.some((c) => requiredSet.has(c));
  });

  if (tools.length < MIN_PACK_SIZE || tools.length >= baseTools.length) return null;
  return { tools, packName: `objective:${match[0]}` };
}
