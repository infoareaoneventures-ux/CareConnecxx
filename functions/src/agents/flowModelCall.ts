// The model call the eight scripted flows share (booking, cancel, reschedule, corrections, interviews,
// replacements, visit requests, job posting) — 2026-11-09, fix plan Wave 2.
//
// Each flow used to call Anthropic Haiku DIRECTLY (getSharedClient().messages.create), bypassing the
// cross-provider path every other quick call uses. When that one provider was down or out of credit
// (July 3), all eight flows stopped at once. They now go through quickComplete (utils/openaiClient.ts):
// the configured OpenAI fast-path model first, Anthropic Haiku as the automatic backup — so both providers
// have to be down before a flow fails. Two flavours, matching what the flows already did:
//   • flowParseCall  — classify / extract (the router tier, short outputs);
//   • flowAnswerCall — the one- or two-sentence mid-flow answer (the quick tier).
import { quickComplete } from "../utils/openaiClient";
import { resolveCaraModelConfig } from "../config/caraModels";

export function flowParseCall(system: string, userText: string, maxTokens: number): Promise<string> {
  return quickComplete(system, userText, { maxTokens });
}

export function flowAnswerCall(system: string, userText: string, maxTokens: number): Promise<string> {
  return quickComplete(system, userText, { maxTokens, model: resolveCaraModelConfig("quick").model });
}
