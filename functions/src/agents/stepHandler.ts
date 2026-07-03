// Canonical step-handler framework for Evia's conversational flows.
//
// The mandatory Evia checklist (CLAUDE.md) — isQuestionOrOther guard → parse →
// acknowledge → ask — was reimplemented ~10 times across handlers
// (onboardingConversation, availabilityHandler, jobPostingFlow,
// caregiverProfileHandler, modifyScheduleFlow, ...), each a hand-rolled copy.
// This module is the single source of truth so the checklist is STRUCTURALLY
// enforced rather than remembered per-handler. New handlers should use runStep;
// existing handlers migrate to it incrementally (one per commit, behind
// characterization tests, since they touch paid/regulated flows).

import { parseWithClaude } from "../utils/parseWithClaude";
import { answerHumanMidFlow } from "./humanReply";

// True when the user's reply is a general question or off-topic comment rather
// than a direct answer to the current step's question — so the handler can
// answer it and re-ask instead of misparsing it as the answer.
export async function isQuestionOrOther(text: string, currentQuestion?: string): Promise<boolean> {
  const context = currentQuestion
    ? `The user is in a guided flow. Current step's question: "${currentQuestion}". `
    : "The user is in a guided conversational flow with Evia, a care coordinator. ";
  const result = await parseWithClaude(
    context +
      "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
      "Reply NO if it is a direct answer to the question. Only reply YES or NO.",
    text,
    5,
  ).catch(() => "NO"); // fail toward treating it as an answer; the parse step validates
  return result.trim().toUpperCase().startsWith("Y");
}

// Answer a mid-flow question briefly, then append the re-ask so the user can
// still answer the step they were on.
export async function answerMidFlow(text: string, reAsk: string): Promise<string> {
  return answerHumanMidFlow({
    text,
    reAsk,
    situation: "the user asked a question mid-conversation in a guided Evia flow",
  });
}

export type StepResult<V> =
  | { status: "question"; reply: string }
  | { status: "answered"; value: V; reply: string };

// Run one conversational step with the mandatory shape: guard (answer a
// mid-flow question + re-ask) → parse the answer → acknowledge. The caller owns
// I/O (sending `reply`, and persisting `value` / advancing on "answered"), so
// this stays usable across every flow without coupling to storage.
export async function runStep<V>(opts: {
  text:            string;
  currentQuestion: string;
  /** Re-ask text shown after answering a mid-flow question. Defaults to currentQuestion. */
  reAsk?:          string;
  /** Extract + validate the answer from the user's text. */
  parse:           (text: string) => Promise<V> | V;
  /** Acknowledge the parsed value and (typically) pose the next question. */
  ack:             (value: V) => string;
}): Promise<StepResult<V>> {
  if (await isQuestionOrOther(opts.text, opts.currentQuestion)) {
    const reply = await answerMidFlow(opts.text, opts.reAsk ?? opts.currentQuestion);
    return { status: "question", reply };
  }
  const value = await opts.parse(opts.text);
  return { status: "answered", value, reply: opts.ack(value) };
}
