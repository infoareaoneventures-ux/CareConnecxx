// Interview-promise net — guarantees "I'm lining up an interview with X" is
// actually followed by a real ask for date/time, instead of a hollow
// acknowledgment with nothing behind it.
//
// schedule_interview requires preferredDate/preferredTime, and its own
// description tells the model to confirm those with the family BEFORE
// calling it. When the model instead narrates a promise ("I'm lining up an
// interview with Basra", "let me schedule that for you") without ever asking
// for a date/time or calling the tool, no interview record is ever created —
// and unlike onboarding gate steps, ordinary post-onboarding chat has no
// other safety net watching for this (2026-09-06 live bug: confirmed via
// Firestore that no video_interviews doc existed for the promised interview).
//
// This runs after every qaAgent turn where schedule_interview was NOT
// actually called: it detects interview-promise narration in Evia's own
// reply (cheap prescreen + quick-tier YES/NO, mirroring linkPromiseNet.ts),
// and if found, records a tracked `interview` commitment so the sweep asks
// the family for date/time on Evia's behalf instead of leaving it dropped.

import { quickComplete } from "../utils/openaiClient";
import { recordCommitment } from "./commitmentTracker";

// Broad on purpose (see linkPromiseNet.ts's own note) — a narrow trigger
// regex gates the real (LLM) check out of existence.
const INTERVIEW_MENTION = /\binterview\b|\bmeet(ing)?\b|\bschedul(e|ing)\b|\blin(e|ing)\s*up\b/i;

export async function fulfillNarratedInterviewPromise(input: {
  phone:    string;
  chatId:   string;
  reply:    string;
  userId?:  string;
  userType: "client" | "caregiver";
}): Promise<void> {
  const { phone, chatId, reply, userId } = input;
  if (!INTERVIEW_MENTION.test(reply)) return;

  // Quick-tier YES/NO: is this reply promising to schedule/arrange an
  // interview WITHOUT actually asking what day or time works?
  const verdict = await quickComplete(
    "You will read one SMS an assistant just sent to a user. Decide if it tells the user it is " +
      "scheduling, arranging, or setting up an interview with a caregiver — e.g. \"I'm lining up an " +
      "interview with Basra\", \"let me schedule that interview for you\", \"I'll set up a meeting with her\" " +
      "— WITHOUT actually asking the user what day or time works for the interview. " +
      "Reply NO if the reply already asks for a date/time, only references an interview already scheduled " +
      "or confirmed, or merely discusses interviews in general (e.g. answering a question about one). " +
      "One word: YES or NO.",
    reply,
    { maxTokens: 3 }
  ).catch(() => "NO");
  if (verdict.trim().toUpperCase() !== "YES") return;

  console.warn("interviewPromiseNet: narrated interview promise with no tool call — tracking for follow-up", {
    phone, preview: reply.slice(0, 120),
  });

  // Unlike a link or a caregiver-matching pass, scheduling an interview needs
  // information only the family can supply (the date/time) — there is no
  // deterministic backend action to silently retry. The sweep's job here is
  // just making sure the missing question actually gets asked.
  await recordCommitment({
    phone,
    chatId,
    kind:        "interview",
    promiseText: reply.slice(0, 300),
    userType:    input.userType,
    ...(userId ? { userId } : {}),
    source:      "interviewPromiseNet:narrated_interview",
    dueInMs:     2 * 60_000,
  });
}
