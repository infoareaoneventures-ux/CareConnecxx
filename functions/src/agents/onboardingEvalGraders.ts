// Onboarding-loop eval graders (pure) — the pass/fail bar for the real-model eval
// of the agent-native onboarding collapse. Kept as a pure module (only the
// onboardingContract dependency) so the graders can be unit-tested with synthetic
// transcripts WITHOUT spending any API tokens, and reused by the live eval runner.
//
// The four gates mirror docs/runbooks/onboarding-agent-loop-rollout.md:
//   1. completion        — all required fields collected by the end of the run
//   2. fields-before-handoff — required set was complete at the moment the loop
//                          signalled complete_collection (no premature handoff)
//   3. no re-greet       — Evia never re-greets / re-introduces after turn 1
//   4. no double-send    — at most one user-facing message per turn

import { OnboardingRole, missingRequiredFields } from "./onboardingContract";

// Greeting / re-introduction openers the directive explicitly bans mid-conversation
// (onboardingDirective.ts "HOW TO TALK"). A reply on turn 2+ that opens with any of
// these is a re-greet. Anchored to the START of the reply so a mid-sentence "hi"
// ("...said hi to her") doesn't false-positive.
//
// NOTE: "nice/good to meet you" and "welcome" are deliberately NOT here. Saying
// "Nice to meet you, Ana" right after someone gives their name is warm and correct,
// not a conversation-restart re-greet. The real defect is opening turn 2+ with
// "Hi/Hey/Hello" as if it were first contact, or re-introducing the assistant.
const REGREET_OPENERS = [
  /^\s*(hi|hey|hello|howdy|greetings)\b/i,
  /^\s*good\s+(morning|afternoon|evening)\b/i,
  /^\s*(hi|hey|hello)\s+(again|there)\b/i,
];

// Self-introduction / chatbot phrasing banned anywhere in the reply.
const BANNED_PHRASES = [
  /\bi'?m\s+cara\b/i,
  /\bthis\s+is\s+cara\b/i,
  /\bai\s+(care\s+)?assistant\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bhow\s+can\s+i\s+help\s+you\s+today\b/i,
  /\bi'?m\s+here\s+to\s+help\b/i,
  /\bspecific\s+questions\s+or\s+concerns\b/i,
];

/** True when this reply text re-greets or re-introduces (banned after turn 1). */
export function isReGreet(reply: string): boolean {
  const r = reply ?? "";
  if (REGREET_OPENERS.some((re) => re.test(r))) return true;
  if (BANNED_PHRASES.some((re) => re.test(r))) return true;
  return false;
}

/** True when this reply uses banned chatbot phrasing (checked on every turn). */
export function hasBannedPhrasing(reply: string): boolean {
  return BANNED_PHRASES.some((re) => re.test(reply ?? ""));
}

export interface TranscriptGrade {
  passed: boolean;
  failures: string[];
  metrics: {
    turns: number;
    completed: boolean;
    missingAtEnd: string[];
    reGreets: number;
    maxSendsInATurn: number;
    completeAtFirstAllRequired: boolean;
  };
}

/**
 * Grade a single multi-turn onboarding transcript against the four gates.
 *
 * @param replies            user-facing reply text, one entry per turn (in order)
 * @param perTurnSendCounts  number of user-facing messages actually sent per turn
 * @param finalData          onboardingData accumulated by the end of the run
 * @param role               onboarding role
 * @param completeFiredWith  the missingRequiredFields snapshot AT the moment the
 *                           loop called complete_collection (undefined if it never
 *                           fired). Used for the fields-before-handoff gate.
 */
export function gradeOnboardingTranscript(args: {
  replies: string[];
  perTurnSendCounts: number[];
  finalData: Record<string, unknown>;
  role: OnboardingRole;
  completeFiredWith?: string[];
}): TranscriptGrade {
  const { replies, perTurnSendCounts, finalData, role, completeFiredWith } = args;
  const failures: string[] = [];

  // Gate 1 — completion.
  const missingAtEnd = missingRequiredFields(role, finalData);
  const completed = missingAtEnd.length === 0;
  if (!completed) {
    failures.push(`incomplete: required fields still missing at end → ${missingAtEnd.join(", ")}`);
  }

  // Gate 2 — fields saved before handoff. complete_collection must only have
  // succeeded with the required set already full. If it fired with anything
  // missing, that's a premature-handoff defect.
  const completeAtFirstAllRequired =
    completeFiredWith !== undefined && completeFiredWith.length === 0;
  if (completeFiredWith !== undefined && completeFiredWith.length > 0) {
    failures.push(
      `premature handoff: complete_collection fired with missing fields → ${completeFiredWith.join(", ")}`,
    );
  }
  if (completed && completeFiredWith === undefined) {
    failures.push("no handoff: required set is full but complete_collection was never called");
  }

  // Gate 3 — no re-greet after the first turn.
  let reGreets = 0;
  replies.forEach((reply, i) => {
    if (i === 0) {
      // Turn 1 may legitimately acknowledge; still ban self-intro / chatbot phrasing.
      if (hasBannedPhrasing(reply)) failures.push(`turn 1 used banned chatbot phrasing: "${trim(reply)}"`);
      return;
    }
    if (isReGreet(reply)) {
      reGreets++;
      failures.push(`re-greet on turn ${i + 1}: "${trim(reply)}"`);
    }
  });

  // Gate 4 — no double-send.
  const maxSendsInATurn = perTurnSendCounts.length ? Math.max(...perTurnSendCounts) : 0;
  perTurnSendCounts.forEach((n, i) => {
    if (n > 1) failures.push(`double-send on turn ${i + 1}: ${n} messages sent`);
  });

  return {
    passed: failures.length === 0,
    failures,
    metrics: {
      turns: replies.length,
      completed,
      missingAtEnd,
      reGreets,
      maxSendsInATurn,
      completeAtFirstAllRequired,
    },
  };
}

/** P95 of a latency sample (ms). Returns 0 for an empty sample. */
export function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

function trim(s: string): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}
