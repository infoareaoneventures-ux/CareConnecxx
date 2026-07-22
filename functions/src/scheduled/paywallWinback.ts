import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

/**
 * Daily win-back for families who hit the subscription paywall but didn't
 * subscribe. The web gate (`useAccessGates`) stamps `lastPaywallViewedAt` and
 * `paywallContext` (the caregiver they tried to reach) on the user doc when the
 * PlanSelectModal opens. This job nudges those who are still unconverted.
 *
 * Targets users where:
 *   - lastPaywallViewedAt is between 24h and 7d ago (intent is hot but cooling)
 *   - they are NOT subscribed (subscriptionActive falsy, membership not active/trialing)
 *   - we haven't already win-backed them in the last 72h
 *
 * Channel reuses the existing Evia SMS infra: we resolve the family's phone the
 * same way the billing flow does (agent_sessions where userId == uid), so this
 * only reaches families who onboarded via Evia and aren't opted out.
 */
export const sendPaywallWinback = functions.pubsub
  .schedule("0 18 * * *") // 10am PT = 18:00 UTC daily
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const now            = Date.now();
    const twentyFourHrAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const sevenDayAgo     = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const seventyTwoHrAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();

    // Only users who have ever seen the paywall are candidates.
    const usersSnap = await db
      .collection("users")
      .where("lastPaywallViewedAt", ">=", sevenDayAgo)
      .get();

    if (usersSnap.empty) {
      console.log("[paywallWinback] No recent paywall views.");
      return;
    }

    let nudgesSent = 0;
    let skipped    = 0;

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const uid  = userDoc.id;

      try {
        const viewedAt = user.lastPaywallViewedAt as string | undefined;
        if (!viewedAt) { skipped++; continue; }
        // Hot-but-cooling window: stale enough to need a nudge, recent enough to care.
        if (viewedAt > twentyFourHrAgo) { skipped++; continue; }
        if (viewedAt < sevenDayAgo)     { skipped++; continue; }

        // Already converted — never nudge a paying member.
        const isSubscribed = !!user.subscriptionActive
          || user.membershipStatus === "active"
          || user.membershipStatus === "trialing";
        if (isSubscribed) { skipped++; continue; }

        // Throttle: one win-back per 72h.
        const lastWinback = user.lastPaywallWinbackAt as string | undefined;
        if (lastWinback && lastWinback > seventyTwoHrAgo) { skipped++; continue; }

        // Resolve the family's phone the same way billing does.
        const sessionSnap = await db
          .collection("agent_sessions")
          .where("userId", "==", uid)
          .where("optedOut", "==", false)
          .limit(1)
          .get();
        if (sessionSnap.empty) { skipped++; continue; }
        const phone = sessionSnap.docs[0].id;

        // U8 engine gate (KTD15): optional discretionary win-back — the
        // engine decides per recipient per pass. A lost pass re-enters on the
        // next daily run (lastPaywallWinbackAt is only stamped on send).
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "paywallWinback",
            category: "re_engagement",
            urgency: 0,
            evidenceCount: 1,
            dedupeKey: `winback:${uid}:${new Date(now).toISOString().slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("paywallWinback.policy", { uid, disposition: g.disposition, reason: g.reason });
          skipped++;
          continue;
        }

        const ctx = (user.paywallContext ?? {}) as { caregiverName?: string | null };
        const caregiverName = ctx.caregiverName || "";
        const firstName = ((user.name ?? user.displayName ?? "there") as string).split(" ")[0];

        const msg = await generateCaraMessage({
          audience: "family",
          context:
            `Family member first name: ${firstName}. ` +
            (caregiverName
              ? `They looked at subscribing so they could reach ${caregiverName}, a caregiver they matched with, but didn't finish. `
              : "They looked at subscribing to contact their caregiver matches but didn't finish. ") +
            "Send a short, warm reminder (1-2 sentences) that their match is still available and an Evia " +
            "membership lets them message, interview, and book. Don't be pushy or salesy.",
          fallback: caregiverName
            ? `Hi ${firstName}, ${caregiverName} is still available on Evia. ` +
              `A membership lets you message and book them whenever you're ready — just head back to your dashboard.`
            : `Hi ${firstName}, your caregiver matches are still waiting on Evia. ` +
              `A membership lets you message and book them whenever you're ready — just head back to your dashboard.`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     msg,
          urgency:     "low",
          sourceAgent: "paywall_winback",
          canDrop:     true,
        }).catch(() => {});

        await userDoc.ref.update({
          lastPaywallWinbackAt: new Date().toISOString(),
        });

        nudgesSent++;
        console.log(`[paywallWinback] Nudged ${uid} (caregiver: ${caregiverName || "n/a"})`);
      } catch (err) {
        console.error(`[paywallWinback] Error for user ${uid}:`, err);
      }
    }

    console.log(`[paywallWinback] Done. Nudges sent: ${nudgesSent}, skipped: ${skipped}`);
  });
