// Canonical step-handler framework for Evia's conversational flows.
//
// The mandatory Evia checklist (CLAUDE.md) — isQuestionOrOther guard → parse →
// acknowledge → ask — was reimplemented ~10 times across handlers
// (onboardingConversation, availabilityHandler, jobPostingFlow,
// caregiverProfileHandler, ...), each a hand-rolled copy.
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

// True when the user's reply is a genuine request to abandon the flow
// entirely right now — "never mind", "cancel this", "stop", "forget it" —
// as opposed to an off-topic question/comment (isQuestionOrOther's job) or a
// request to change something ABOUT the flow (an edit, not a cancellation).
// 2026-09-13: every scripted flow used to only recognize a cancel at its own
// FINAL confirm step — anywhere earlier, "never mind" fell through
// isQuestionOrOther as "off-topic," got a brief reply, and the SAME question
// just got re-asked next turn with no way to actually leave. Live-caught the
// worst version of this: a family got misrouted into jobPostingFlow.ts
// mid-interview-scheduling and, with no early exit there either, "cancel
// this request" / "cancel the job post" just re-asked the flow's own
// question every time — a genuine dead end. This is the shared fix, meant
// to be checked FIRST in every step handler, ahead of isQuestionOrOther.
export async function isBackOutRequest(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "The user is in the middle of a guided step-by-step flow with Evia (e.g. scheduling an interview, sending a " +
      "booking, posting a job). Reply YES only if their message is a clear, genuine request to stop, cancel, or " +
      "abandon this flow entirely right now — e.g. \"never mind\", \"forget it\", \"cancel this\", \"cancel the " +
      "request\", \"stop\", \"I don't want to do this anymore\", \"let's not do this\". Reply NO for anything else " +
      "— a real answer to the current question (even a partial or vague one), an off-topic question, an " +
      "unrelated comment, or a request to CHANGE something about this flow (that's an edit, not a cancellation). " +
      "Only reply YES or NO.",
    text,
    5,
  ).catch(() => "NO"); // fail toward NOT cancelling — never silently abandon on an ambiguous/failed parse
  return result.trim().toUpperCase().startsWith("Y");
}

// Classify a reply sent while Evia is WAITING on the user to finish an
// out-of-band action (tap a link, finish a Checkr form, complete a payment).
// These steps have no question to answer, so the two-way question/answer split
// above is the wrong shape: a pure "thanks / sounds good" is neither, and
// treating it as "other" made Evia re-explain the step or re-blast the link at
// someone who was just being polite (broken-record behavior).
//   ack      → acknowledgment/thanks/agreement only; reply with ONE brief warm
//              line and do NOT resend the link or re-explain the step
//   question → a question or a reported problem; answer it first
//   other    → anything actionable (wants the link again, status, new info);
//              the step's normal resend/status behavior applies
export type AwaitingReplyKind = "ack" | "question" | "other";

export async function classifyAwaitingReply(text: string, waitingOn: string): Promise<AwaitingReplyKind> {
  const raw = await parseWithClaude(
    "Evia, a care coordinator, just told the user what happens next and is now waiting on them to: " +
      `${waitingOn}. The user texted back. Classify the reply: ` +
      'ONLY an acknowledgment, thanks, or agreement with nothing asked or added ("thanks", "sounds good", "ok great", "got it", "perfect", "will do", "👍") → ack. ' +
      "A question, confusion, or a reported problem (link not working, never got the email, how long does it take) → question. " +
      "Anything actionable — asks for the link again, gives new information, reports the action done → other. " +
      "Reply with exactly one word: ack, question, or other.",
    text,
    5,
  ).catch(() => "other"); // fail toward the step's normal behavior
  const v = raw.trim().toLowerCase();
  return v === "ack" || v === "question" ? v : "other";
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
