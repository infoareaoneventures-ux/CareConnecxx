import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

export const runNoVisitCheck = functions.pubsub
  .schedule("0 14 * * *")  // 9am ET / 14:00 UTC daily
  .timeZone("America/New_York")
  .onRun(async () => {
    const today     = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Find active recurring schedules
    const scheduleSnap = await db.collection("recurring_schedules")
      .where("status", "==", "active")
      .get();

    if (scheduleSnap.empty) return;

    for (const scheduleDoc of scheduleSnap.docs) {
      const schedule = scheduleDoc.data();
      const clientId = schedule.clientId as string | undefined;
      if (!clientId) continue;

      try {
        // Check if there's a completed visit in the last 7 days
        const recentVisit = await db.collection("appointments")
          .where("clientId", "==", clientId)
          .where("status",   "==", "completed")
          .where("date",     ">=", sevenDaysAgo)
          .limit(1)
          .get();

        if (!recentVisit.empty) continue; // Has a recent visit — skip

        // Check if a visit is already booked for today or tomorrow
        const upcoming = await db.collection("appointments")
          .where("clientId", "==", clientId)
          .where("status",   "in", ["confirmed", "pending_caregiver_confirmation"])
          .where("date",     ">=", today)
          .limit(1)
          .get();

        if (!upcoming.empty) continue; // Already has an upcoming visit

        // De-dup: check if we sent this alert within 7 days
        const lastAlert = schedule.noVisitAlertSentAt as string | undefined;
        if (lastAlert) {
          const daysSince = (Date.now() - new Date(lastAlert).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < 7) continue;
        }

        // Get client phone
        const clientSessionSnap = await db.collection("agent_sessions")
          .where("userId", "==", clientId)
          .limit(1)
          .get();

        if (clientSessionSnap.empty) continue;
        const clientPhone  = clientSessionSnap.docs[0].id;
        const seniorName   = (clientSessionSnap.docs[0].data() as any).seniorName ?? "your loved one";
        const cgName       = schedule.caregiverName ?? "your caregiver";

        await sendViaInteractionAgent(clientPhone, {
          content:
            `Just noticed ${seniorName} hasn't had a visit in the past 7 days. ` +
            `Want me to check ${cgName}'s availability and book something this week?`,
          urgency:     "standard",
          sourceAgent: "no_visit_check",
          canDrop:     true,
        });

        // Update the schedule with sent timestamp
        await scheduleDoc.ref.update({ noVisitAlertSentAt: new Date().toISOString() });

      } catch (err) {
        console.error(`[noVisitCheck] Error for schedule ${scheduleDoc.id}:`, err);
      }
    }

    console.log(`[noVisitCheck] Completed check for ${scheduleSnap.size} active schedules`);
  });
