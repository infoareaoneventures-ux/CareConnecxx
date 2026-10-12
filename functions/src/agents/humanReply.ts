import { CARE_PROVIDER_TERM_RULE } from "./terminology";
import { quickComplete } from "../utils/openaiClient";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { enforceCareProviderTerm } from "../safety/linter";

export const HUMAN_MIDFLOW_FALLBACK = "I do not want to guess on that.";

export type HumanReplyAudience = "family" | "caregiver" | "admin";

export async function answerHumanMidFlow(opts: {
  text: string;
  reAsk: string;
  situation: string;
  audience?: HumanReplyAudience;
  maxTokens?: number;
}): Promise<string> {
  const answer = await answerHumanQuestionOnly(opts);
  return appendReAsk(answer, opts.reAsk);
}

export async function answerHumanQuestionOnly(opts: {
  text: string;
  situation: string;
  audience?: HumanReplyAudience;
  maxTokens?: number;
}): Promise<string> {
  const audience = opts.audience ?? "family";
  const answer = await quickComplete(
    CARE_PROVIDER_TERM_RULE + " " + "You are Evia, a care coordinator texting in a live care workflow. " +
      `Audience: ${audience === "caregiver" ? "care provider" : audience}. Situation: ${opts.situation}. ` +
      "Answer the user's question briefly and honestly in 1-2 sentences. " +
      "Do not use generic assistant phrasing. Do not say you will come back later. " +
      "Do not ask them to continue the workflow; the caller will send that prompt separately. " +
      "You receive a situation BRIEFING, not a transcript — your output goes STRAIGHT to the user's phone. " +
      "NEVER reply to the briefing's author, ask for missing context, or say you don't see a message — " +
      "if details are missing, answer as best you can with what you have. " +
      "NEVER write out a URL or web address — a URL you compose will be wrong and dead — and never claim you " +
      "just sent, resent, or will send a link: real links are delivered by the system as separate tappable messages. " +
      // Founder 2026-10-11: a mid-flow answer never claims an action — this ONE shared place carries the rule
      // (the same wording as onboardingConversation.answerQuestionMidFlow's rule 9).
      "NEVER say you changed, updated, saved, fixed, cancelled, sent or removed anything — you cannot change their " +
      "answers or anything else in this reply. If they want something changed, say they can tell you exactly what to " +
      "change and it will be updated. " +
      ANTI_INVENTION_CLAUSE,
    opts.text,
    { maxTokens: opts.maxTokens ?? 160 },
  ).catch(() => HUMAN_MIDFLOW_FALLBACK);

  const clean = String(answer ?? "").trim();
  // Output guard (U2, R2): a meta-response or composed URL is never delivered —
  // the deterministic fallback goes out instead. Kill switch: CARA_OUTPUT_GUARD_ENABLED=false.
  if (clean && caraOutputGuardEnabled() && !guardModelOutput(clean).ok) {
    return HUMAN_MIDFLOW_FALLBACK;
  }
  return enforceCareProviderTerm(clean) || HUMAN_MIDFLOW_FALLBACK;
}

export function appendReAsk(answer: string, reAsk: string): string {
  const cleanAnswer = String(answer || HUMAN_MIDFLOW_FALLBACK).trim();
  const cleanReAsk = String(reAsk || "").trim();
  return cleanReAsk ? `${cleanAnswer}\n\n${cleanReAsk}` : cleanAnswer;
}
