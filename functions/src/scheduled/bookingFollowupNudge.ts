import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Third sibling of interviewCompletionNudge.ts / interviewFeedbackNudge.ts.
// A "strong" fit decision only records that the family wants to hire — it
// does NOT create a real booking (see submit_interview_feedback's own
// description). If the conversation stalls before the family ever gives a
// schedule/rate and the booking flow actually sends the request, nothing ever
// followed up — the interview would just sit at fitLevel:'strong' forever
// with no real booking behind it. Discovered 2026-09-13 while building
// the booking flow's full site-parity fields.
export const NUDGE_DELAY_MS = 60 * 60 * 1000; // 1h after the 'strong' decision
export const RENUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // same ~48h cadence as the other two nudges

/**
 * Pure decision: should this 'strong'-but-unbooked interview get a booking
 * follow-up nudge now? Mirrors shouldNudgeInterviewFeedback.
 */
export function shouldNudgeBookingFollowup(p: {
  fitLevel:          string | undefined;
  hasBookingRequest: boolean;
  feedbackMs:        number | null;
  lastNudgedMs:      number | null;
  nowMs:             number;
}): boolean {
  if (p.fitLevel !== "strong") return false;
  if (p.hasBookingRequest) return false; // a real booking was already started — done
  if (p.feedbackMs === null) return false;
  if (p.nowMs - p.feedbackMs < NUDGE_DELAY_MS) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < RENUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * Booking follow-up nudge. A 'strong' fit decision with no booking_requests
 * doc linked to it yet gets asked about, 1h later, then every ~48h until a
 * real booking exists — no hard cap, same reasoning as the other two nudges
 * (a hiring decision sitting half-finished shouldn't go silent forever).
 *
 * Read-only except the send + a per-interview nudge counter/timestamp; the
 * nudge does NOT create the booking itself — a reply routes through Evia's
 * normal turn handling, which already has start_booking_flow.
 */
export const sendBookingFollowupNudges = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const nowMs = Date.now();

    // Single-field equality → auto-indexed.
    const snap = await db.collection("video_interviews")
      .where("fitLevel", "==", "strong")
      .limit(300)
      .get();

    for (const doc of snap.docs) {
      const interview = doc.data();
      try {
        const feedbackMs   = Date.parse((interview.feedbackAt as string) ?? "");
        const nudgeCount   = Number(interview.bookingNudgeCount ?? 0);
        const lastNudgedMs = interview.bookingNudgedAt
          ? Date.parse(interview.bookingNudgedAt as string) || null
          : null;

        // Has a real booking already been initiated for this interview?
        // (booking_requests.interviewId is stamped by the booking flow's
        // interview linkage — see bookingSend.ts / bookingResolution.ts.)
        const brSnap = await db.collection("booking_requests")
          .where("interviewId", "==", doc.id)
          .limit(1)
          .get();
        const hasBookingRequest = !brSnap.empty;

        if (!shouldNudgeBookingFollowup({
          fitLevel: interview.fitLevel as string | undefined,
          hasBookingRequest,
          feedbackMs: Number.isNaN(feedbackMs) ? null : feedbackMs,
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
            `The family decided ${caregiverName} was a strong fit after their interview, but the actual booking ` +
            `(schedule and rate) was never finished. Check back in warmly and offer to finish setting it up now — ` +
            `what days/times work, and confirm the rate. One or two warm sentences.`,
          fallback:
            `Just following up — want me to finish setting up the booking with ${caregiverName}? I can lock in the schedule and rate whenever you're ready.`,
          maxTokens: 100,
        });

        const sent = await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "booking_followup_nudge",
          canDrop:     true,
        });
        // Suppressed (proactive daily cap, wait-tool, opt-out) — not an error.
        // Don't stamp bookingNudgedAt for a message that never went out;
        // retry on the next scheduled run instead.
        if (!sent) continue;

        await doc.ref.update({
          bookingNudgeCount: nudgeCount + 1,
          bookingNudgedAt:   new Date(nowMs).toISOString(),
        }).catch(() => {});

        // Same anchor pattern as interviewCompletionNudge.ts's
        // pendingCompletionNudge* / interviewFeedbackNudge.ts's
        // pendingFeedbackNudge* — without it, a reply like "Mon/Wed/Fri 9-5"
        // has nothing telling the agent which interview's booking it's
        // finishing. qaAgent.ts reads this (24h TTL).
        await sessionDoc.ref.update({
          pendingBookingNudgeInterviewId: doc.id,
          pendingBookingNudgeSetAt:       new Date(nowMs).toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendBookingFollowupNudges] error for interview ${doc.id}:`, err);
      }
    }
  });
