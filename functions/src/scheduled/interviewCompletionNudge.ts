import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { parseScheduledTimeMs, formatInterviewTime } from "../utils/scheduledTime";

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
// 2026-09-08 (Hamse's call): no hard attempt cap — a hiring-relevant decision
// sitting unresolved shouldn't just go silent forever after a couple of
// misses. Matches shouldNudgeStaleApplicants/shouldNudgePendingTimesheets,
// which never give up either, just cool down between repeats. The cooldown
// itself is widened to match their cadence (48h) instead of the old 3h —
// spacing that made sense capped at 2 total sends would be naggy repeated
// indefinitely.
export const RENUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // space repeats ~2 days apart, same as stale-applicant/timesheet nudges

// Renders a UTC ISO timestamp in the family's local (Pacific — matches the
// project's own convention elsewhere, e.g. morningBriefing's cron and
// jobPostingFlow's "today" anchoring) day-of-week/date/time, so a message
// that mentions when the interview was never reads off the wrong calendar
// day just because UTC and Pacific fall on different dates.
//
// 2026-09-08: thinned to a wrapper around the shared scheduledTime.ts
// helpers (parseScheduledTimeMs + formatInterviewTime) — those already do
// this exact conversion (used by list_interviews for the same reason), and
// having two independent implementations is how one of them drifts.
export function formatPacificDateTime(iso: string | undefined): string {
  if (!iso) return "the scheduled time";
  const ms = parseScheduledTimeMs(iso);
  if (Number.isNaN(ms)) return "the scheduled time";
  return formatInterviewTime(ms);
}

/**
 * Pure decision: should this accepted interview get a completion nudge now?
 * Extracted so the freshness + repeat-count guard is unit-tested without
 * Firestore. Mirrors shouldNudgePendingTimesheets/shouldNudgeStaleApplicants.
 */
export function shouldNudgeInterviewCompletion(p: {
  status:               string;
  scheduledMs:          number | null;
  lastNudgedMs:         number | null;
  nowMs:                number;
  hasPendingReschedule?: boolean;
}): boolean {
  if (p.status !== "accepted") return false;
  // 2026-09-13: a reschedule already proposed (reschedulePendingTime set,
  // not yet accepted) means both parties already know the original
  // scheduledTime isn't happening — asking "did your interview happen?"
  // about the slot that's actively being moved reads as confused/redundant.
  // Once the proposal is accepted, scheduledTime itself updates to the new
  // time and this field clears, so the normal 1h-after-scheduledTime check
  // picks it up correctly from there with no special-casing needed.
  if (p.hasPendingReschedule) return false;
  if (p.scheduledMs === null) return false;
  if (p.nowMs - p.scheduledMs < NUDGE_DELAY_MS) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < RENUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * Interview-completion nudge. An accepted interview whose scheduledTime has
 * passed gets asked about, 1h later — "did it happen?" — so a family doesn't
 * have to remember to go mark it complete, and stale "accepted" interviews
 * don't linger forever. Repeats every ~48h for as long as it stays
 * unresolved — no hard cap, so a busy family missing the first couple of
 * check-ins doesn't mean the interview gets forgotten forever.
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
          lastNudgedMs,
          nowMs,
          hasPendingReschedule: !!interview.reschedulePendingTime,
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

        // 2026-09-08 (live-caught): interview.scheduledTime is a raw UTC ISO
        // string ("2026-09-08T00:00:00.000Z") — interpolated as-is, the model
        // read the UTC calendar date literally and told the family their
        // interview was "on September 8th" when it was actually 5pm Pacific
        // on September 7th. Format in the family's local (Pacific) time before
        // it ever reaches the prompt.
        const scheduledLabel = formatPacificDateTime(interview.scheduledTime as string | undefined);

        const message = await generateCaraMessage({
          audience: "family",
          context:
            `The family's video interview with ${caregiverName} was scheduled for ${scheduledLabel}, ` +
            `which has now passed, but it's still marked "accepted" (not completed). Ask whether the interview ` +
            `happened, and offer to mark it complete or help reschedule if it didn't. One or two warm sentences.`,
          fallback:
            `Just checking in — did your interview with ${caregiverName} happen? I can mark it complete, or help you reschedule if it didn't.`,
          maxTokens: 100,
        });

        const sent = await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "interview_completion_nudge",
          canDrop:     true,
        });
        // Suppressed (proactive daily cap, wait-tool, opt-out) — not an error.
        // Don't stamp completionNudgedAt for a message that never went out;
        // retry on the next scheduled run instead.
        if (!sent) continue;

        await doc.ref.update({
          completionNudgeCount: nudgeCount + 1,
          completionNudgedAt:   new Date(nowMs).toISOString(),
        }).catch(() => {});

        // 2026-09-13 live incident: without this, a reply like "reschedule
        // it" had nothing to anchor to — the agent had to guess which
        // interview was meant purely from conversation text, and with a
        // second interview also active for the same caregiver it grabbed the
        // wrong one entirely, then lost the thread into a brand-new
        // caregiver search. qaAgent.ts reads this (24h TTL) to tell the next
        // turn exactly which interview a completion/reschedule/cancel reply
        // concerns, instead of reconstructing it from scratch.
        await sessionDoc.ref.update({
          pendingCompletionNudgeInterviewId: doc.id,
          pendingCompletionNudgeSetAt:       new Date(nowMs).toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendInterviewCompletionNudges] error for interview ${doc.id}:`, err);
      }
    }
  });
