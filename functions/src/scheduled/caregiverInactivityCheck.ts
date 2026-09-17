import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";
import { queryVisits } from "../utils/visitQuery";

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
      const caregiverName = (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Unknown";

      try {
        // ── 14-day inactivity check ───────────────────────────────────────────

        const recent14Docs = await queryVisits({
          dateOp: ">=", dateValue: fourteenDaysAgo,
          extraWhere: [["caregiverId", "==", cgId]],
          shiftStatuses: ["completed", "in-progress"],
          limit: 1,
        });

        if (recent14Docs.length === 0) {
          // No activity in last 14 days — send nudge if not already sent within 7 days
          const lastNudge = cg.lastInactivityNudgeSentAt as string | undefined;
          if (!lastNudge || lastNudge < sevenDaysAgo) {
            const cgSessionSnap = await db.collection("agent_sessions")
              .where("userId", "==", cgId)
              .limit(1)
              .get();

            if (!cgSessionSnap.empty) {
              const cgPhone = cgSessionSnap.docs[0].id;

              // U8 engine gate (KTD15): optional re-engagement source — submit as a
              // PolicyCandidate instead of sending directly. A lost pass re-enters on
              // the next daily run (the 7-day nudge marker is only set after a send).
              const day = new Date(now).toISOString().slice(0, 10);
              const g = await gateOptionalSend({
                phone: cgPhone,
                candidate: {
                  source: "caregiverInactivityCheck",
                  category: "re_engagement",
                  urgency: 1,
                  evidenceCount: 1,
                  dedupeKey: `cginact:${cgId}:${day}`,
                },
              });
              if (!g.allowed) {
                console.info("caregiverInactivityCheck.policy", { userId: cgId, disposition: g.disposition, reason: g.reason });
              } else {
                const inactivityMsg = await generateCaraMessage({
                  audience: "caregiver",
                  context:
                    `Caregiver first name: ${firstName}. ` +
                    "They haven't had any visits in the last 14 days. Send a warm, low-pressure check-in. " +
                    "Ask if everything's okay and let them know they can reply if they want to pick up more shifts or if anything's come up. " +
                    "Don't be pushy — just genuinely caring.",
                  fallback: `Hey ${firstName} — we haven't seen you for any visits lately. All good? Reply if you want to pick up more shifts or if anything's come up.`,
                  maxTokens: 80,
                });

                await sendViaInteractionAgent(cgPhone, {
                  content:     inactivityMsg,
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
          }

          // ── 30-day inactivity check ─────────────────────────────────────────

          const recent30Docs = await queryVisits({
            dateOp: ">=", dateValue: thirtyDaysAgo,
            extraWhere: [["caregiverId", "==", cgId]],
            shiftStatuses: ["completed", "in-progress"],
            limit: 1,
          });

          if (recent30Docs.length === 0) {
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
