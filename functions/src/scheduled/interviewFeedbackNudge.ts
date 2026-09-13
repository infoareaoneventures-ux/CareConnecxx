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
 *
 * 2026-09-13 (Hamse's call): "maybe" is not a final answer — the family said
 * they're still deciding, not that they're done deciding. submit_interview_
 * feedback stamps feedbackSubmitted:true for ALL three fitLevels alike, which
 * used to stop this nudge dead the moment ANY answer came in, "maybe"
 * included — silently dropping a still-open hiring decision with nothing
 * ever following up again. Only "strong" and "no" are terminal; "maybe" (or
 * no fitLevel at all yet) keeps the same 48h re-ask cycle going.
 */
export function shouldNudgeInterviewFeedback(p: {
  status:       string;
  fitLevel:     string | undefined;
  completedMs:  number | null;
  lastNudgedMs: number | null;
  nowMs:        number;
}): boolean {
  if (p.status !== "completed") return false;
  if (p.fitLevel === "strong" || p.fitLevel === "no") return false;
  if (p.completedMs === null) return false;
  if (p.nowMs - p.completedMs < NUDGE_DELAY_MS) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < RENUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * Fit-decision nudge. A completed interview with no fitLevel recorded — or
 * left at "maybe" (still deciding, not a final answer) — gets asked about,
 * 1h later, then every ~48h until an actual strong/no decision lands. So a
 * skipped in-conversation ask (or a website "Mark as Completed" click with no
 * follow-up), and an open-ended "maybe" alike, don't leave the decision
 * stuck forever. No hard cap.
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

        const fitLevel = interview.fitLevel as string | undefined;
        if (!shouldNudgeInterviewFeedback({
          status: interview.status as string,
          fitLevel,
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
          context: fitLevel === "maybe"
            ? `The family said they were still deciding ("maybe") about ${caregiverName} after their interview, and ` +
              `still haven't given a final answer. Check back in warmly — any updates, ready to move forward, or ` +
              `would they rather pass? One or two warm sentences.`
            : `The family's interview with ${caregiverName} is marked completed, but they never gave a fit decision. ` +
              `Ask whether they'd like to move forward with ${caregiverName} or pass, so you can help book them or ` +
              `keep looking. One or two warm sentences.`,
          fallback: fitLevel === "maybe"
            ? `Checking back in — any more thoughts on ${caregiverName}? Ready to move forward, or would you rather keep looking?`
            : `Following up on your interview with ${caregiverName} — would you like to move forward with them, or keep looking?`,
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

        // Same anchor as interviewCompletionNudge.ts's pendingCompletionNudge*
        // (2026-09-13 live incident) — without it, a reply like "not a fit"
        // has nothing telling the agent which interview it concerns, and with
        // more than one completed-but-undecided interview in play it could
        // get attributed to the wrong one. qaAgent.ts reads this (24h TTL).
        await sessionDoc.ref.update({
          pendingFeedbackNudgeInterviewId: doc.id,
          pendingFeedbackNudgeSetAt:       new Date(nowMs).toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendInterviewFeedbackNudges] error for interview ${doc.id}:`, err);
      }
    }
  });
