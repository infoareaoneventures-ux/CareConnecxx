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
            `Hi${firstName ? ` ${firstName}` : ""}, still thinking about care?\n\n` +
            `Just reply when you're ready:\n\n` +
            `1️⃣ I need care for someone\n` +
            `2️⃣ I'm a caregiver`;
        } else if (userType === "caregiver") {
          if (step === "caregiver_send_bgcheck" || step === "caregiver_awaiting_bgcheck") {
            message =
              `${greeting} Your background check is the last step before you can start getting booked.\n\n` +
              `Families can't book you until it's done. It takes about 5 minutes. ` +
              `Reply here and I'll send the link again.`;
          } else if (step === "caregiver_ask_rate") {
            message =
              `${greeting} Still thinking about your hourly rate?\n\n` +
              `Most caregivers on Cara charge $18-28/hr. ` +
              `You can always update it later. No pressure to get it perfect now.`;
          } else if (step === "caregiver_send_photo") {
            message =
              `${greeting} Your profile is almost live.\n\n` +
              `Adding a photo makes families much more likely to request an interview. ` +
              `A clear headshot is all you need. Ready to finish up?`;
          } else {
            message =
              `${greeting} Your caregiver profile is almost done.\n\n` +
              `Reply here whenever you're ready to continue.`;
          }
        } else {
          if (step === "client_send_payment" || step === "client_awaiting_payment") {
            message =
              `${greeting} The last step is adding a payment method so caregivers can get paid after each visit.\n\n` +
              `Takes about 30 seconds. No charges until you book a caregiver.`;
          } else if (step === "client_ask_schedule") {
            message =
              `${greeting} Almost there. Just need to know how often you need care ` +
              `and I'll start searching for caregivers.`;
          } else {
            message =
              `${greeting} I'm here whenever you're ready to continue.\n\n` +
              `Just reply and I'll pick up where we left off.`;
          }
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
