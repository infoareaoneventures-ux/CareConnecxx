import { quickComplete } from "../utils/openaiClient";

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
    "You are Evia, a care coordinator texting in a live care workflow. " +
      `Audience: ${audience}. Situation: ${opts.situation}. ` +
      "Answer the user's question briefly and honestly in 1-2 sentences. " +
      "Do not use generic assistant phrasing. Do not say you will come back later. " +
      "Do not ask them to continue the workflow; the caller will send that prompt separately.",
    opts.text,
    { maxTokens: opts.maxTokens ?? 160 },
  ).catch(() => HUMAN_MIDFLOW_FALLBACK);

  const clean = String(answer ?? "").trim();
  return clean || HUMAN_MIDFLOW_FALLBACK;
}

export function appendReAsk(answer: string, reAsk: string): string {
  const cleanAnswer = String(answer || HUMAN_MIDFLOW_FALLBACK).trim();
  const cleanReAsk = String(reAsk || "").trim();
  return cleanReAsk ? `${cleanAnswer}\n\n${cleanReAsk}` : cleanAnswer;
}
