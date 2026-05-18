import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

// Background checks expire after 2 years (730 days).
// Warning window: 23–24 months old (30-day warning before expiry).

const TWO_YEARS_MS      = 2  * 365 * 24 * 60 * 60 * 1000;
const TWENTY_THREE_MONTHS_MS = (23 * 30 + 15) * 24 * 60 * 60 * 1000; // ~23.5 months — start of warning window
const THIRTY_DAYS_MS    = 30 * 24 * 60 * 60 * 1000;

export const checkBackgroundCheckExpiry = functions.pubsub
  .schedule("0 16 * * *") // 8am PT = 16:00 UTC daily
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const now = Date.now();
    const thirtyDaysAgoTs = new Date(now - THIRTY_DAYS_MS).toISOString();

    const caregiversSnap = await db.collection("caregivers")
      .where("status", "==", "active")
      .where("backgroundCheckData.status", "==", "clear")
      .get();

    if (caregiversSnap.empty) {
      console.log("[backgroundCheckExpiry] No active caregivers with clear background checks.");
      return;
    }

    let expiredCount  = 0;
    let warningCount  = 0;

    for (const cgDoc of caregiversSnap.docs) {
      const cg   = cgDoc.data();
      const cgId = cgDoc.id;

      const bgCheckData   = cg.backgroundCheckData as Record<string, unknown> | undefined;
      const completedAtRaw = bgCheckData?.completedAt as string | undefined;
      const caregiverName  = cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim() || "Unknown";

      // Skip if no completedAt date
      if (!completedAtRaw) continue;

      const completedAtMs = new Date(completedAtRaw).getTime();
      if (isNaN(completedAtMs)) continue;

      const ageMs = now - completedAtMs;

      // Skip checks under 23 months old — not in any action window yet
      if (ageMs < TWENTY_THREE_MONTHS_MS) continue;

      const expiryDate = new Date(completedAtMs + TWO_YEARS_MS).toISOString();

      // Guard: de-dup nudges — skip if a nudge was sent within the last 30 days
      const lastNudge = cg.bgCheckExpiryNudgeSentAt as string | undefined;
      const nudgeCooledDown = !lastNudge || lastNudge < thirtyDaysAgoTs;

      try {
        // ── Expired (>= 2 years old) ─────────────────────────────────────────

        if (ageMs >= TWO_YEARS_MS) {
          // Mark the background check as expired on the caregiver doc
          await cgDoc.ref.update({
            "backgroundCheckData.backgroundCheckStatus": "expired",
          });

          // Write admin alert (gated by same 30-day nudge field to avoid duplicate alerts)
          if (nudgeCooledDown) {
            await db.collection("admin_alerts").add({
              type:          "background_check_expired",
              caregiverId:   cgId,
              caregiverName,
              expiryDate,
              createdAt:     new Date().toISOString(),
              resolved:      false,
              priority:      "high",
            });

            // Send caregiver message
            const cgSessionSnap = await db.collection("agent_sessions")
              .where("userId", "==", cgId)
              .limit(1)
              .get();

            if (!cgSessionSnap.empty) {
              const cgPhone = cgSessionSnap.docs[0].id;

              await sendViaInteractionAgent(cgPhone, {
                content:
                  "Your background check has expired. New bookings are paused until it's renewed. " +
                  "Reply RENEW and I'll send you a new link.",
                urgency:     "standard",
                sourceAgent: "bg_check_expiry",
                canDrop:     false,
              });

              await cgDoc.ref.update({
                bgCheckExpiryNudgeSentAt: new Date().toISOString(),
              });
            }

            expiredCount++;
            console.log(`[backgroundCheckExpiry] Background check expired for caregiver ${cgId}`);
          }

        // ── Expiring soon (23–24 months old, ~30-day warning window) ─────────

        } else if (ageMs >= TWENTY_THREE_MONTHS_MS) {
          if (nudgeCooledDown) {
            await db.collection("admin_alerts").add({
              type:          "background_check_expiring_soon",
              caregiverId:   cgId,
              caregiverName,
              expiryDate,
              createdAt:     new Date().toISOString(),
              resolved:      false,
              priority:      "medium",
            });

            const cgSessionSnap = await db.collection("agent_sessions")
              .where("userId", "==", cgId)
              .limit(1)
              .get();

            if (!cgSessionSnap.empty) {
              const cgPhone = cgSessionSnap.docs[0].id;

              await sendViaInteractionAgent(cgPhone, {
                content:
                  "Your background check expires in about 30 days. " +
                  "Reply RENEW to stay verified and keep getting booked.",
                urgency:     "standard",
                sourceAgent: "bg_check_expiry",
                canDrop:     false,
              });

              await cgDoc.ref.update({
                bgCheckExpiryNudgeSentAt: new Date().toISOString(),
              });
            }

            warningCount++;
            console.log(`[backgroundCheckExpiry] 30-day expiry warning for caregiver ${cgId}`);
          }
        }
      } catch (err) {
        console.error(`[backgroundCheckExpiry] Error processing caregiver ${cgId}:`, err);
      }
    }

    console.log(
      `[backgroundCheckExpiry] Done. Expired: ${expiredCount}, expiring-soon warnings: ${warningCount}`
    );
  });
