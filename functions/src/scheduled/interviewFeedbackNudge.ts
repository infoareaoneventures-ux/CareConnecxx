import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Sibling of interviewCompletionNudge.ts, closing the gap right after it:
// marking an interview "completed" (via complete_interview, the website's own
// "Mark as Completed" button, or the completion nudge's own "yes" reply) never
// records a hire/pass decision by itself — that's the separate
// submit_interview_feedback step. Evia's complete_interview tool description
// is "MANDATORY: ...always ask how it went ... in the SAME reply" — but that's
// a prompt-level instruction with no runtime enforcement and, unlike "did the
// interview happen", nothing ever followed up if that ask got skipped. A
// completed interview with no decision could sit unresolved indefinitely with
// nothing catching it. Discovered 2026-09-06 while auditing the completion
// flow — same day and same root-cause class as the completion nudge above.
export const NUDGE_DELAY_MS = 60 * 60 * 1000; // 1 hour after completedAt
// Client-only — the fit decision is the family's call, same as the website's
// "Not Selected" / "Send Booking" buttons only ever appearing on their side.
// 2026-09-08 (Hamse's call): no hard attempt cap, matching
// interviewCompletionNudge.ts's own fix and shouldNudgeStaleApplicants/
// shouldNudgePendingTimesheets — a hiring decision sitting unresolved
// shouldn't go silent forever after a couple of misses. Cooldown widened to
// match their ~48h cadence for the same reason (repeated indefinitely, the
// old 3h spacing would be naggy).
export const RENUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // space repeats ~2 days apart

/**
 * Pure decision: should this completed-but-undecided interview get a
 * feedback nudge now? Mirrors shouldNudgeInterviewCompletion.
 */
export function shouldNudgeInterviewFeedback(p: {
  status:           string;
  feedbackSubmitted: boolean;
  completedMs:      number | null;
  lastNudgedMs:     number | null;
  nowMs:            number;
}): boolean {
  if (p.status !== "completed") return false;
  if (p.feedbackSubmitted) return false;
  if (p.completedMs === null) return false;
  if (p.nowMs - p.completedMs < NUDGE_DELAY_MS) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < RENUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * Fit-decision nudge. A completed interview with no fitLevel recorded gets
 * asked about, 1h later — "did you want to move forward, or pass?" — so a
 * skipped in-conversation ask (or a website "Mark as Completed" click with no
 * follow-up) doesn't leave the interview stuck with no decision forever.
 * Repeats every ~48h for as long as it stays undecided — no hard cap.
 *
 * Read-only except the send + a per-interview nudge counter/timestamp; the
 * nudge does NOT record any decision itself — a reply routes through Evia's
 * normal turn handling, which already has submit_interview_feedback.
 */
export const sendInterviewFeedbackNudges = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const nowMs = Date.now();

    // Single-field equality → auto-indexed.
    const snap = await db.collection("video_interviews")
      .where("status", "==", "completed")
      .limit(300)
      .get();

    for (const doc of snap.docs) {
      const interview = doc.data();
      try {
        const completedMs = Date.parse((interview.completedAt as string) ?? "");
        const nudgeCount   = Number(interview.feedbackNudgeCount ?? 0);
        const lastNudgedMs = interview.feedbackNudgedAt
          ? Date.parse(interview.feedbackNudgedAt as string) || null
          : null;

        if (!shouldNudgeInterviewFeedback({
          status: interview.status as string,
          feedbackSubmitted: interview.feedbackSubmitted === true,
          completedMs: Number.isNaN(completedMs) ? null : completedMs,
          lastNudgedMs,
          nowMs,
        })) continue;

        const clientId = interview.clientId as string | undefined;
        if (!clientId) continue;

        const sessionQ = await db.collection("agent_sessions")
          .where("userId", "==", clientId)
          .limit(1)
          .get();
        if (sessionQ.empty) continue;
        const sessionDoc  = sessionQ.docs[0];
        const sessionData = sessionDoc.data();
        if (sessionData.optedOut) continue;
        if (sessionData.onboardingStep !== "complete") continue;
        const phone = (sessionData.phone ?? sessionDoc.id) as string;

        const caregiverName = ((interview.caregiverName ?? "your caregiver") as string).split(" ")[0] || "your caregiver";

        const message = await generateCaraMessage({
          audience: "family",
          context:
            `The family's interview with ${caregiverName} is marked completed, but they never gave a fit decision. ` +
            `Ask whether they'd like to move forward with ${caregiverName} or pass, so you can help book them or ` +
            `keep looking. One or two warm sentences.`,
          fallback:
            `Following up on your interview with ${caregiverName} — would you like to move forward with them, or keep looking?`,
          maxTokens: 100,
        });

        const sent = await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "interview_feedback_nudge",
          canDrop:     true,
        });
        // Suppressed (proactive daily cap, wait-tool, opt-out) — not an error.
        // Don't stamp feedbackNudgedAt for a message that never went out;
        // retry on the next scheduled run instead.
        if (!sent) continue;

        await doc.ref.update({
          feedbackNudgeCount: nudgeCount + 1,
          feedbackNudgedAt:   new Date(nowMs).toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendInterviewFeedbackNudges] error for interview ${doc.id}:`, err);
      }
    }
  });
