import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getJobRecommendationsForCaregiver } from "../agents/jobMatchRecommender";
import { sendMessage } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Runs daily — texts caregivers when a new job has >75% match
export const sendJobMatchNotifications = functions.pubsub
  .schedule("0 10 * * *")   // 10am daily
  .timeZone("America/New_York")
  .onRun(async () => {
    // Find jobs posted in last 24 hours
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const newJobsSnap = await db.collection("job_posts")
      .where("status", "==", "open")
      .where("createdAt", ">=", yesterday)
      .get();

    if (newJobsSnap.empty) {
      console.log("[sendJobMatchNotifications] No new jobs posted in last 24h");
      return;
    }

    console.log(`[sendJobMatchNotifications] Found ${newJobsSnap.size} new job(s)`);

    // Get all verified active caregivers
    const caregiverSnap = await db.collection("caregivers")
      .where("verified", "==", true)
      .limit(100)
      .get();

    console.log(`[sendJobMatchNotifications] Checking ${caregiverSnap.size} verified caregivers`);

    const todayIso = new Date().toISOString();
    for (const cgDoc of caregiverSnap.docs) {
      const cg = cgDoc.data();
      if (!cg.chatId && !cg.phone) continue;

      // Skip paused caregivers
      const pausedUntil = cg.pausedUntil as string | undefined;
      if (pausedUntil && pausedUntil > todayIso) continue;

      try {
        const recs = await getJobRecommendationsForCaregiver(cgDoc.id, 3);
        const highMatch = recs.filter(r => r.matchScore >= 75);
        if (!highMatch.length) continue;

        const chatId = cg.chatId ?? cg.phone;
        const top = highMatch[0];
        const msg = await generateCaraMessage({
          audience: "caregiver",
          context:
            `A new job came in that's a great match for this caregiver. ` +
            `Care types: ${top.careTypes.join(", ")}. Schedule: ${top.schedule}. ` +
            `Rate: $${top.rate}/hr. Match score: ${top.matchScore}%. ` +
            `Let them know about it and invite them to reply "jobs" to see the details. ` +
            `Keep the tone excited but natural.`,
          fallback:
            `New job match for you! ${top.careTypes.join(", ")} — ${top.schedule}, ` +
            `$${top.rate}/hr (${top.matchScore}% match). Reply "jobs" to see details.`,
          maxTokens: 80,
        });
        await sendMessage(chatId, msg);
        console.log(`[sendJobMatchNotifications] Notified ${cgDoc.id} — ${top.matchScore}% match`);
      } catch (e) {
        console.error(`[sendJobMatchNotifications] Failed for ${cgDoc.id}:`, e);
      }
    }
  });
