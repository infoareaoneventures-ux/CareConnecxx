import { AgentSession } from "../linq/client";

/**
 * conversationStep — the deep module behind Cara's onboarding checklist.
 *
 * Every linear onboarding question used to be a hand-written handler that
 * re-typed the same six steps (the CLAUDE.md "new handler checklist"):
 *
 *   isQuestionOrOther → parseWithClaude → validate → ack → merge → advance → send
 *
 * That checklist now lives in ONE place — `runStep`. A step is data plus a few
 * small functions (`parse`, `reask`, `retry`, `nextQuestion`); the runner owns
 * the control flow. The runner is pure: it touches no Firestore and no network
 * directly. All side effects arrive through `StepDeps`, so the interface is also
 * the test surface — drive `runStep` with fakes and you exercise the whole
 * checklist without a database.
 *
 * What this module deliberately does NOT cover: the non-linear onboarding steps
 * (photo/document upload, membership, Checkr, Stripe Connect, the playback
 * confirm). Those keep their bespoke handlers — `runStep` is for the
 * ask-a-question / store-an-answer / ask-the-next steps only.
 */

/** The per-turn inputs a step runs against. */
export interface RunStepContext {
  phone:   string;
  chatId:  string;
  text:    string;
  /** The live session. `runStep` mutates `onboardingData`/`onboardingStep` in
   *  memory after a successful answer so `nextQuestion` sees the new data. */
  session: AgentSession;
}

/**
 * Side effects the runner needs, injected so the runner stays pure and
 * testable. Production wiring supplies the real helpers from
 * `onboardingConversation.ts`; tests supply fakes.
 */
export interface StepDeps {
  /** True when the user asked a mid-flow question instead of answering. */
  isQuestionOrOther:    (text: string) => Promise<boolean>;
  /** Answer a mid-flow question in context. */
  answerQuestionMidFlow:(text: string, session: AgentSession) => Promise<string>;
  /** Single-shot structured extraction (gpt-4o-mini under the hood). */
  parseWithClaude:      (prompt: string, text: string) => Promise<string>;
  /**
   * Merge the parsed fields into `onboardingData` AND advance `onboardingStep`
   * in ONE write. Replaces the old two-write merge+advance, which could leave a
   * user half-advanced if the second write failed.
   */
  mergeAndAdvance:      (phone: string, fields: Record<string, unknown>, nextStep: string | null) => Promise<void>;
  /** Outbound transport (routes through the voice-cleanup chokepoint). */
  sendMessage:          (chatId: string, text: string) => Promise<unknown>;
}

/**
 * A single linear onboarding question, expressed as data + small functions.
 * The variation that used to differ per handler (the parse prompt, how raw
 * output maps to stored fields, the re-ask text) lives here; the control flow
 * does not.
 */
export interface ConversationStep {
  /** Stable step id (matches `onboardingStep`), e.g. "client_ask_name". */
  id: string;

  /** Prompt handed to `parseWithClaude` to extract this step's answer. */
  parsePrompt: string;

  /**
   * Turn the parser's raw output into the field map to merge into
   * `onboardingData`. Return `null` to signal "didn't catch that" — the runner
   * then sends `retry()` and does NOT advance. Return a (possibly empty) object
   * to advance: an empty object is valid for steps where "no preference" is a
   * real answer (preferences, budget). `parse` owns any JSON.parse and any
   * derived top-level keys the matching engine reads (e.g. `budgetMax`).
   */
  parse: (raw: string, session: AgentSession) => Record<string, unknown> | null;

  /** Next `onboardingStep`. `null` = terminal or handed to a bespoke handler. */
  nextStep: string | null;

  /** Question to re-ask after answering a mid-flow question. */
  reask: (session: AgentSession) => string;

  /** Prompt to re-send when `parse` returned `null` ("didn't catch that"). */
  retry: (session: AgentSession) => string;

  /**
   * The next thing Cara says after a successful answer. By convention this
   * single message both acknowledges what the user just said and asks the next
   * question (mirroring the existing generateCaraMessage calls), so the checklist's
   * "acknowledge before advancing" step is satisfied here.
   */
  nextQuestion: (session: AgentSession) => Promise<string>;
}

/**
 * Run one onboarding step's full checklist. Pure control flow — all effects go
 * through `deps`.
 *
 * 1. Mid-flow question → answer it, re-ask the current question, stop (no write).
 * 2. Parse the answer.
 * 3. `parse` returned null → re-send the retry prompt, stop (no advance).
 * 4. Merge fields + advance step in one write.
 * 5. Send the acknowledging next question.
 */
export async function runStep(
  step: ConversationStep,
  ctx:  RunStepContext,
  deps: StepDeps,
): Promise<void> {
  const { phone, chatId, text, session } = ctx;

  // 1. Mid-flow question: answer it, re-ask, and do not touch stored data.
  if (await deps.isQuestionOrOther(text)) {
    const answer = await deps.answerQuestionMidFlow(text, session);
    await deps.sendMessage(chatId, answer);
    await deps.sendMessage(chatId, step.reask(session));
    return;
  }

  // 2. Parse the answer into stored fields.
  const raw    = await deps.parseWithClaude(step.parsePrompt, text);
  const fields = step.parse(raw, session);

  // 3. Couldn't extract a usable answer — re-ask without advancing.
  if (fields === null) {
    await deps.sendMessage(chatId, step.retry(session));
    return;
  }

  // 4. Atomic merge + advance (one write, no half-advanced state).
  await deps.mergeAndAdvance(phone, fields, step.nextStep);

  // Reflect the write in memory so nextQuestion() sees the just-saved answer.
  session.onboardingData = { ...(session.onboardingData ?? {}), ...fields };
  if (step.nextStep) session.onboardingStep = step.nextStep;

  // 5. Acknowledge + ask the next question.
  const next = await step.nextQuestion(session);
  await deps.sendMessage(chatId, next);
}
