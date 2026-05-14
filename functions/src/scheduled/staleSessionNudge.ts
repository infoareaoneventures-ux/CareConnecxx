import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

// Runs daily at 10 AM PT (17:00 UTC)
export const sendStaleSessionNudges = functions.pubsub
  .schedule("0 17 * * *")
  .onRun(async () => {
    const now        = Date.now();
    const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const seventyTwoHoursAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();

    // Sessions that started onboarding but never completed
    const snap = await db.collection("agent_sessions")
      .where("onboardingStep", "!=", "complete")
      .get();

    for (const doc of snap.docs) {
      const session = doc.data();

      // Skip opted-out users
      if (session.optedOut) continue;

      // Must be older than 48h (stale)
      if (!session.createdAt || session.createdAt > fortyEightHoursAgo) continue;

      // Don't nudge again within 72h of last nudge
      if (session.nudgeSentAt && session.nudgeSentAt > seventyTwoHoursAgo) continue;

      // Cap at 2 nudges total
      if ((session.nudgeCount ?? 0) >= 2) continue;

      if (!session.chatId) continue;

      try {
        const step      = session.onboardingStep ?? "ask_role";
        const firstName = (session.onboardingData?.firstName ?? session.onboardingData?.name ?? "") as string;
        const greeting  = firstName ? `Hey ${firstName}!` : "Hey there!";
        const userType  = session.userType as string | undefined;

        let message: string;
        if (!userType || step === "ask_role") {
          message =
            `Hi! 👋 I'm Cara, your care assistant.\n\n` +
            `Ready to continue? Just reply:\n\n` +
            `1️⃣ I need care for someone\n` +
            `2️⃣ I'm a caregiver`;
        } else if (userType === "caregiver") {
          message =
            `${greeting} 👋 Your caregiver profile is almost done.\n\n` +
            `Reply here whenever you're ready to continue — ` +
            `we'd love to have you on the team! 💙`;
        } else {
          message =
            `${greeting} 👋 I noticed you didn't finish setting up your care search.\n\n` +
            `Whenever you're ready — just reply here to pick up where you left off. 💙`;
        }

        await sendViaInteractionAgent(doc.id, {
          content:     message,
          urgency:     "low",
          sourceAgent: "stale_nudge",
          canDrop:     true,
        });
        await doc.ref.update({
          nudgeSentAt: new Date().toISOString(),
          nudgeCount:  admin.firestore.FieldValue.increment(1),
        });
      } catch (err) {
        console.error("staleSessionNudge error for", doc.id, err);
      }
    }
  });
