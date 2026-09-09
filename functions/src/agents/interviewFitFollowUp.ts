// Fit-decision follow-up guarantee — sibling of interviewIdentityGuard.ts,
// same class of gap: complete_interview's own tool description tells the
// model "MANDATORY: ...in the SAME reply always ask how it went and whether
// they'd like to move forward" — but that's a prompt instruction with no
// runtime enforcement.
//
// 2026-09-09 live bug: a family confirmed "yes it happened" and Evia replied
// with only an acknowledgment ("Great, glad it went well. I'll mark the
// interview complete.") — no follow-up fit question at all, leaving the
// decision to sit until the ~1hr proactive feedback nudge instead of being
// asked right away (and in that specific incident, complete_interview wasn't
// even actually called — see the "marked" verb fix in groundingClaims.ts for
// that half of the bug). This module closes the other half: whenever
// complete_interview genuinely succeeds without submit_interview_feedback
// also running in the same turn, the fit question is appended deterministically
// instead of trusting the model remembered to ask.

export interface CompletedInterviewDetails {
  interviewId:   string;
  caregiverName: string;
}

// Loose match on the model already having asked something fit-decision-shaped
// in its own words — avoids appending a redundant second ask when it already
// did the right thing unprompted.
const ALREADY_ASKS_FIT_DECISION =
  /\b(move forward|moving forward|keep looking|not a fit|good fit|great fit|how('d| did) (it|the interview) go|pass on (them|him|her|it))\b/i;

/**
 * Returns the reply to actually send — unchanged if a fit-decision ask isn't
 * warranted or already present, or the reply with a deterministic fit
 * question appended.
 */
export function applyFitDecisionFollowUp(params: {
  reply:                     string;
  completedInterviewDetails: CompletedInterviewDetails | null;
  toolNamesThisTurn:         string[];
}): string {
  const { reply, completedInterviewDetails, toolNamesThisTurn } = params;
  if (!completedInterviewDetails) return reply;
  if (!reply.trim()) return reply;
  if (toolNamesThisTurn.includes("submit_interview_feedback")) return reply;
  if (ALREADY_ASKS_FIT_DECISION.test(reply)) return reply;

  const firstName = completedInterviewDetails.caregiverName.split(" ")[0] || "them";
  return `${reply.trim()} Would you like to move forward with ${firstName}, or keep looking?`;
}
