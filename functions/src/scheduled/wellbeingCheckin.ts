import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

export const wellbeingCheckinJob = functions.pubsub
  .schedule("0 10 * * 3") // Every Wednesday at 10am UTC
  .timeZone("America/New_York")
  .onRun(async () => {
    // Only run on even ISO weeks (bi-weekly cadence)
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    if (weekNumber % 2 !== 0) return;

    const day = new Date().toISOString().slice(0, 10);

    const sessionsSnap = await db
      .collection("agent_sessions")
      .where("status",   "==", "active")
      .where("userType", "==", "caregiver")
      .limit(500)
      .get();

    for (const doc of sessionsSnap.docs) {
      const phone = doc.id;
      const data  = doc.data();
      if (data.optedOut) continue;

      const checkinMsg = await generateCaraMessage({
        audience: "caregiver",
        context:
          "Send a warm, brief wellbeing check-in to a caregiver. " +
          "Let them know it's a quick 3-question check-in and ask them to reply with a number 1–5 for each: " +
          "energy level this week (1=exhausted, 5=great), stress level (1=very stressed, 5=calm), and job satisfaction (1=unhappy, 5=love it). " +
          'Give a short example reply like: "4 3 5". Keep it friendly and low-pressure.',
        fallback:
          `Hi! Quick 3-question check-in — reply with a number 1–5 for each:\n\n` +
          `1️⃣ Energy level this week (1=exhausted, 5=great)\n` +
          `2️⃣ Stress level (1=very stressed, 5=calm)\n` +
          `3️⃣ Job satisfaction (1=unhappy, 5=love it)\n\n` +
          `Example reply: "4 3 5"`,
      });

      // U8 engine gate (KTD15): optional discretionary source — on a lost pass
      // we skip WITHOUT setting pendingWellbeingCheckin, so the check-in
      // re-enters naturally on the next bi-weekly run.
      const g = await gateOptionalSend({
        phone,
        candidate: {
          source: "wellbeingCheckin",
          category: "satisfaction",
          urgency: 1,
          evidenceCount: 1,
          dedupeKey: `wellbeing:${phone}:${day}`,
        },
      });
      if (!g.allowed) {
        console.info("wellbeingCheckin.policy", { phone, disposition: g.disposition, reason: g.reason });
        continue;
      }

      await sendViaInteractionAgent(phone, {
        content:     checkinMsg,
        urgency:     "standard",
        sourceAgent: "wellbeing_checkin",
        canDrop:     true,
      }).catch(err => console.error(`wellbeingCheckin failed for ${phone}:`, err));

      await db.collection("agent_sessions").doc(phone).update({
        pendingWellbeingCheckin:   true,
        wellbeingCheckinSentAt:    new Date().toISOString(),
      });
    }
  });
