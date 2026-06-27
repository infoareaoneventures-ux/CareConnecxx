/**
 * Next-day family feedback (U7 — plan 2026-06-23-001).
 *
 * Each morning, for shifts completed the previous day, send the family ONE warm
 * "how did yesterday's visit go?" check-in and capture the reply as solicited
 * quality-of-care feedback. Dedupes per shift, respects DND/opt-out (via
 * sendViaInteractionAgent), and enforces the shared weekly per-family proactive
 * budget (KTD-14) — next-day feedback outranks satisfaction surveys and payment
 * nudges, so it survives the budget longer than they do.
 *
 * The reply is captured by setting `awaitingNextDayFeedback` on the family's
 * session; the inbound reply-branch routing (positive / negative-escalate /
 * ambiguous-clarify) lives on the client inbound path and is tracked separately.
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
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
        if (appt.nextDayFeedbackSent === true) continue; // per-shift dedupe
        const clientId = appt.clientId as string;
        if (!clientId) continue;
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
        const message = await generateCaraMessage({
          audience: "family",
          context:
            `It's the morning after ${seniorName}'s care visit. Send the family one brief, warm check-in asking ` +
            `how yesterday's visit went. Friendly and genuine, not a survey. One or two sentences, no bullets.`,
          fallback: `Morning! How did yesterday's visit with ${seniorName} go? I'd love to hear how it went. 💙`,
          maxTokens: 80,
        });

        await sendViaInteractionAgent(phone, {
          content: message,
          urgency: "low",
          sourceAgent: "next_day_feedback",
          canDrop: true,
        });

        await doc.ref.update({ nextDayFeedbackSent: true });
        await db.collection("agent_sessions").doc(phone).set(
          {
            weeklyProactiveTally: budget.next,
            awaitingNextDayFeedback: { appointmentId: doc.id, seniorName, askedAt: nowIso },
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
