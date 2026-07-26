import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

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
      const caregiverName  = (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Unknown";

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

              const expiredMsg = await generateCaraMessage({
                audience: "caregiver",
                context:
                  "A caregiver's background check has expired. Let them know clearly that new bookings are paused until it's renewed. " +
                  "Tell them to reply RENEW and you'll send them a new link. " +
                  "Be direct but not harsh — explain the situation matter-of-factly.",
                fallback:
                  "Your background check has expired. New bookings are paused until it's renewed. " +
                  "Reply RENEW and I'll send you a new link.",
                maxTokens: 80,
              });

              await sendViaInteractionAgent(cgPhone, {
                content:     expiredMsg,
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

              const expiringMsg = await generateCaraMessage({
                audience: "caregiver",
                context:
                  "A caregiver's background check expires in about 30 days. Give them a heads-up and let them know they should reply RENEW to stay verified and keep getting booked. " +
                  "Keep the tone proactive and encouraging, not urgent or scary.",
                fallback:
                  "Your background check expires in about 30 days. " +
                  "Reply RENEW to stay verified and keep getting booked.",
                maxTokens: 80,
              });

              await sendViaInteractionAgent(cgPhone, {
                content:     expiringMsg,
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

    // ── Childcare screening expiry sweep (plan 2026-07-22-002 U5, R31/AE9) ──
    // ADDITIVE guarded branch: runs AFTER the senior sweep above, is gated on
    // the Firestore-resident childcare flags (skips entirely while childcare
    // is dark), and touches ONLY caregivers/{uid}/screenings/child plus the
    // namespaced childcareProvider derived summary — NEVER a senior field
    // (verified / verificationStatus / status / backgroundCheckData). Expired
    // childcare evidence removes childcare visibility while still-valid senior
    // eligibility is untouched. Safe when skipped: providerEligibility
    // evaluates report age LIVE, so a stale doc can never grant eligibility.
    try {
      const { runChildcareScreeningExpirySweep } = await import("../childcare/providerEligibility");
      const sweep = await runChildcareScreeningExpirySweep();
      console.log(
        `[backgroundCheckExpiry] childcare sweep: skipped=${sweep.skipped} scanned=${sweep.scanned} ` +
        `expired=${sweep.expired} renewalNotices=${sweep.renewalNotices}`
      );
    } catch (err) {
      console.error("[backgroundCheckExpiry] childcare sweep error (senior sweep unaffected):", err);
    }
  });
