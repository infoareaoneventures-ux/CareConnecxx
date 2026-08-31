import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";
import { queryVisitsMerged } from "../utils/visitQuery";

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
        // Check if there's a completed visit in the last 7 days (either pipeline)
        const recentVisits = await queryVisitsMerged({
          dateOp: ">=", dateValue: sevenDaysAgo,
          extraWhere: [["clientId", "==", clientId]],
          apptStatuses: ["completed"],
          shiftStatuses: ["completed"],
          limit: 1,
        });

        if (recentVisits.length > 0) continue; // Has a recent visit — skip

        // Check if a visit is already booked for today or tomorrow
        const upcoming = await queryVisitsMerged({
          dateOp: ">=", dateValue: today,
          extraWhere: [["clientId", "==", clientId]],
          apptStatuses: ["confirmed", "pending_caregiver_confirmation"],
          shiftStatuses: ["scheduled"],
          limit: 1,
        });

        if (upcoming.length > 0) continue; // Already has an upcoming visit

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
        const sessionData  = clientSessionSnap.docs[0].data() as any;
        const seniorName   = sessionData.seniorName ?? "your loved one";
        const cgName       = schedule.caregiverName ?? "your caregiver";
        // R11: ground who's who — the reader coordinates care; the visits are
        // for the care recipient, never for the account holder.
        const whoIsWho     = describeWhoIsWho({
          ...(sessionData.onboardingData ?? {}),
          seniorName: sessionData.onboardingData?.seniorName ?? sessionData.seniorName,
        });

        const noVisitMsg = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `Senior: ${seniorName}. ` +
            (cgName !== "your caregiver" ? `Their regular caregiver: ${cgName}. ` : "") +
            `${seniorName} hasn't had a visit in the past 7 days. ` +
            "Gently flag this to the family and offer to check the caregiver's availability to book something this week. " +
            "Keep it caring and helpful, not alarming.",
          fallback:
            `Just noticed ${seniorName} hasn't had a visit in the past 7 days. ` +
            `Want me to check ${cgName}'s availability and book something this week?`,
          maxTokens: 80,
        });

        await sendViaInteractionAgent(clientPhone, {
          content:     noVisitMsg,
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
