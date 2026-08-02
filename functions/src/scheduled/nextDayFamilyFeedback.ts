/**
 * Next-day family feedback (U7 — plan 2026-06-23-001).
 *
 * Each morning, for shifts completed the previous day, send the family ONE warm
 * "how did yesterday's visit go?" check-in and capture the reply as solicited
 * quality-of-care feedback. Dedupes per shift, respects DND/opt-out, and
 * enforces the shared weekly per-family proactive
 * budget (KTD-14) — next-day feedback outranks satisfaction surveys and payment
 * nudges, so it survives the budget longer than they do.
 *
 * A deterministic proactive trigger owns both delivery and the reply window.
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";
import { scheduleTrigger } from "../triggers/triggerEngine";
import {
  evaluateWeeklyFamilyBudget,
  type WeeklyBudgetTally,
} from "./proactiveBudget";

const db = admin.firestore();

async function clientPhoneFor(clientId: string): Promise<string | null> {
  if (!clientId) return null;
  const snap = await db.collection("agent_sessions").where("userId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  return ((snap.docs[0].data() as any).phone ?? snap.docs[0].id) as string;
}

export const sendNextDayFamilyFeedback = functions.pubsub
  .schedule("0 13 * * *") // 13:00 UTC ≈ 9am ET — morning after
  .timeZone("America/New_York")
  .onRun(async () => {
    const nowIso = new Date().toISOString();
    const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const snap = await db.collection("appointments")
      .where("date", "==", yesterdayStr)
      .where("status", "==", "completed")
      .limit(500)
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const appt = doc.data();
      try {
        if (appt.careVertical === "child") continue; // Childcare U10 (R54/AE16): senior feedback copy; childcare deferred
        if (appt.nextDayFeedbackSent === true) continue; // per-shift dedupe
        const clientId = appt.clientId as string;
        const caregiverId = appt.caregiverId as string;
        if (!clientId || !caregiverId) continue;
        const phone = await clientPhoneFor(clientId);
        if (!phone) continue;

        const sessSnap = await db.collection("agent_sessions").doc(phone).get();
        const session = sessSnap.exists ? (sessSnap.data() as Record<string, unknown>) : {};
        if (session.optedOut) continue;

        // Shared weekly per-family budget (KTD-14).
        const budget = evaluateWeeklyFamilyBudget(
          session.weeklyProactiveTally as WeeklyBudgetTally | undefined,
          "next_day_feedback",
          nowIso,
        );
        if (!budget.allowed) continue;

        const seniorName = (appt.clientName ?? appt.seniorName ?? "your loved one") as string;
        // R11: ground who's who — the visit was for the care recipient, not the reader.
        const whoIsWho = describeWhoIsWho({
          ...((session.onboardingData ?? {}) as Record<string, unknown>),
          seniorName: (session.onboardingData as any)?.seniorName ?? appt.clientName ?? appt.seniorName,
        });
        const message = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `It's the morning after ${seniorName}'s care visit. Send the family one brief, warm check-in asking ` +
            `how yesterday's visit went. Friendly and genuine, not a survey. One or two sentences, no bullets.`,
          fallback: `Morning! How did yesterday's visit with ${seniorName} go? I'd love to hear how it went. 💙`,
          maxTokens: 80,
        });

        await scheduleTrigger({
          userId:            clientId,
          phone,
          type:              "post_visit_feedback",
          scheduledAt:       nowIso,
          message,
          firedAt:           null,
          cancelledAt:       null,
          feedbackReceived:  null,
          expiresAt:         new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          metadata: {
            appointmentId: doc.id,
            clientId,
            caregiverId,
          },
        }, {
          bypassCalibration: true,
          idempotencyKey: `post-visit-feedback:${doc.id}`,
        });

        await doc.ref.update({ nextDayFeedbackSent: true, nextDayFeedbackScheduledAt: nowIso });
        await db.collection("agent_sessions").doc(phone).set(
          {
            weeklyProactiveTally: budget.next,
          },
          { merge: true },
        );
        sent++;
      } catch (err) {
        console.error("[nextDayFamilyFeedback] error for appt", doc.id, err);
      }
    }

    console.log(`[nextDayFamilyFeedback] ${snap.size} completed-yesterday shifts, ${sent} prompts sent`);
  });
