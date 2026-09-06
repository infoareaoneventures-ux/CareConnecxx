import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// A scheduled interview whose time has passed but is still "accepted" (never
// marked completed) sits there silently today — neither the website nor Evia
// proactively follows up; the site's only path is a manual "Mark as
// Completed" button. Discovered 2026-09-06 while testing: after manually
// editing an interview's scheduledTime in Firestore to the past, nothing
// asked whether it actually happened.
export const NUDGE_DELAY_MS = 60 * 60 * 1000; // 1 hour after scheduledTime, per Hamse
// Client-only, mirrors the site's own "Mark as Completed" action being a
// client-side control — the caregiver has no equivalent completion step here.
export const MAX_NUDGES = 2; // "repeating maybe one or two" — one follow-up, then stop
export const RENUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000; // space repeats a few hours apart, same day

/**
 * Pure decision: should this accepted interview get a completion nudge now?
 * Extracted so the freshness + repeat-count guard is unit-tested without
 * Firestore. Mirrors shouldNudgePendingTimesheets/shouldNudgeStaleApplicants.
 */
export function shouldNudgeInterviewCompletion(p: {
  status:        string;
  scheduledMs:   number | null;
  nudgeCount:    number;
  lastNudgedMs:  number | null;
  nowMs:         number;
}): boolean {
  if (p.status !== "accepted") return false;
  if (p.scheduledMs === null) return false;
  if (p.nowMs - p.scheduledMs < NUDGE_DELAY_MS) return false;
  if (p.nudgeCount >= MAX_NUDGES) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < RENUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * Interview-completion nudge. An accepted interview whose scheduledTime has
 * passed gets asked about, 1h later — "did it happen?" — so a family doesn't
 * have to remember to go mark it complete, and stale "accepted" interviews
 * don't linger forever. Repeats at most once (MAX_NUDGES=2 total sends) if
 * ignored, spaced a few hours apart; never a third attempt.
 *
 * Read-only except the send + a per-interview nudge counter/timestamp; the
 * nudge does NOT mark anything complete itself — a "yes" reply routes through
 * Evia's normal turn handling, which already has the complete_interview tool.
 */
export const sendInterviewCompletionNudges = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const nowMs = Date.now();

    // Single-field equality → auto-indexed.
    const snap = await db.collection("video_interviews")
      .where("status", "==", "accepted")
      .limit(300)
      .get();

    for (const doc of snap.docs) {
      const interview = doc.data();
      try {
        const scheduledMs = Date.parse((interview.scheduledTime as string) ?? "");
        const nudgeCount   = Number(interview.completionNudgeCount ?? 0);
        const lastNudgedMs = interview.completionNudgedAt
          ? Date.parse(interview.completionNudgedAt as string) || null
          : null;

        if (!shouldNudgeInterviewCompletion({
          status: interview.status as string,
          scheduledMs: Number.isNaN(scheduledMs) ? null : scheduledMs,
          nudgeCount,
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
            `The family's video interview with ${caregiverName} was scheduled for ${interview.scheduledTime}, ` +
            `which has now passed, but it's still marked "accepted" (not completed). Ask whether the interview ` +
            `happened, and offer to mark it complete or help reschedule if it didn't. One or two warm sentences.`,
          fallback:
            `Just checking in — did your interview with ${caregiverName} happen? I can mark it complete, or help you reschedule if it didn't.`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "interview_completion_nudge",
          canDrop:     true,
        });

        await doc.ref.update({
          completionNudgeCount: nudgeCount + 1,
          completionNudgedAt:   new Date(nowMs).toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendInterviewCompletionNudges] error for interview ${doc.id}:`, err);
      }
    }
  });
