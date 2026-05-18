import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

export const checkCaregiverInactivity = functions.pubsub
  .schedule("0 17 * * *") // 9am PT = 17:00 UTC daily
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const now = Date.now();
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const thirtyDaysAgo   = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sevenDaysAgo    = new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgoTs = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const caregiversSnap = await db.collection("caregivers")
      .where("status", "==", "active")
      .get();

    if (caregiversSnap.empty) {
      console.log("[caregiverInactivityCheck] No active caregivers found.");
      return;
    }

    let nudgesSent = 0;
    let alertsWritten = 0;

    for (const cgDoc of caregiversSnap.docs) {
      const cg   = cgDoc.data();
      const cgId = cgDoc.id;

      const firstName    = (cg.firstName ?? cg.name ?? "there") as string;
      const caregiverName = cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim() || "Unknown";

      try {
        // ── 14-day inactivity check ───────────────────────────────────────────

        const recent14Snap = await db.collection("appointments")
          .where("caregiverId", "==", cgId)
          .where("status", "in", ["completed", "in-progress"])
          .where("date", ">=", fourteenDaysAgo)
          .limit(1)
          .get();

        if (recent14Snap.empty) {
          // No activity in last 14 days — send nudge if not already sent within 7 days
          const lastNudge = cg.lastInactivityNudgeSentAt as string | undefined;
          if (!lastNudge || lastNudge < sevenDaysAgo) {
            const cgSessionSnap = await db.collection("agent_sessions")
              .where("userId", "==", cgId)
              .limit(1)
              .get();

            if (!cgSessionSnap.empty) {
              const cgPhone = cgSessionSnap.docs[0].id;

              await sendViaInteractionAgent(cgPhone, {
                content: `Hey ${firstName} — we haven't seen you for any visits lately. All good? Reply if you want to pick up more shifts or if anything's come up.`,
                urgency:     "low",
                sourceAgent: "inactivity_check",
                canDrop:     true,
              });

              await cgDoc.ref.update({
                lastInactivityNudgeSentAt: new Date().toISOString(),
              });

              nudgesSent++;
              console.log(`[caregiverInactivityCheck] Sent 14-day nudge to caregiver ${cgId}`);
            }
          }

          // ── Warn families with active recurring schedules for this caregiver ─
          const recurringSnap = await db.collection("recurring_schedules")
            .where("caregiverId", "==", cgId)
            .where("status", "==", "active")
            .get();

          if (!recurringSnap.empty) {
            for (const schedDoc of recurringSnap.docs) {
              const sched = schedDoc.data();
              const clientPhone   = sched.clientPhone as string | undefined;
              const lastWarnedAt  = sched.inactivityWarnedAt as string | undefined;
              if (clientPhone && (!lastWarnedAt || lastWarnedAt < sevenDaysAgo)) {
                await sendViaInteractionAgent(clientPhone, {
                  content: `Your regular caregiver ${caregiverName} hasn't had any recent visits. Want me to find a backup for your upcoming scheduled visits?`,
                  urgency:     "standard",
                  sourceAgent: "inactivity_check",
                  canDrop:     true,
                }).catch((err: unknown) =>
                  console.error(`[caregiverInactivityCheck] Failed to warn family ${clientPhone}:`, err)
                );
                await schedDoc.ref.update({ inactivityWarnedAt: new Date().toISOString() });
              }
            }
          }

          // ── 30-day inactivity check ─────────────────────────────────────────

          const recent30Snap = await db.collection("appointments")
            .where("caregiverId", "==", cgId)
            .where("status", "in", ["completed", "in-progress"])
            .where("date", ">=", thirtyDaysAgo)
            .limit(1)
            .get();

          if (recent30Snap.empty) {
            const last30dAlert = cg.lastInactivity30dAlertAt as string | undefined;
            if (!last30dAlert || last30dAlert < thirtyDaysAgoTs) {
              await db.collection("admin_alerts").add({
                type:          "caregiver_inactive_30d",
                caregiverId:   cgId,
                caregiverName,
                createdAt:     new Date().toISOString(),
                resolved:      false,
                priority:      "low",
              });

              await cgDoc.ref.update({
                lastInactivity30dAlertAt: new Date().toISOString(),
              });

              alertsWritten++;
              console.log(`[caregiverInactivityCheck] Wrote 30-day admin alert for caregiver ${cgId}`);
            }
          }
        }
      } catch (err) {
        console.error(`[caregiverInactivityCheck] Error processing caregiver ${cgId}:`, err);
      }
    }

    console.log(
      `[caregiverInactivityCheck] Done. Nudges sent: ${nudgesSent}, admin alerts written: ${alertsWritten}`
    );
  });
