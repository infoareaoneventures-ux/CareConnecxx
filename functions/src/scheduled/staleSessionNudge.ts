import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Runs daily at 10 AM PT (17:00 UTC)
export const sendStaleSessionNudges = functions.pubsub
  .schedule("0 17 * * *")
  .onRun(async () => {
    const now        = Date.now();
    const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const seventyTwoHoursAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo       = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();

    // ── Auto-recover sessions stuck waiting for a webhook for 7+ days ─────────
    const WEBHOOK_AWAITING_STEPS = [
      "caregiver_awaiting_bgcheck",
      "caregiver_awaiting_stripe",
      "caregiver_awaiting_membership",
      "caregiver_awaiting_photo",
      "caregiver_awaiting_documents",
      "client_awaiting_payment",
      "client_awaiting_identity",
    ];
    const stuckSnap = await db.collection("agent_sessions")
      .where("onboardingStep", "in", WEBHOOK_AWAITING_STEPS)
      .get();

    for (const doc of stuckSnap.docs) {
      const session = doc.data();
      if (session.optedOut) continue;
      // Only recover sessions stuck > 7 days
      const updatedAt = (session.updatedAt ?? session.createdAt ?? "") as string;
      if (!updatedAt || updatedAt > sevenDaysAgo) continue;
      // Idempotency: don't re-send more than once per 7 days
      if (session.stuckRecoverySentAt && session.stuckRecoverySentAt > sevenDaysAgo) continue;

      try {
        const { resendStuckStep } = await import("../agents/onboardingConversation");
        const sent = await resendStuckStep(doc.id);
        if (sent) {
          await doc.ref.update({ stuckRecoverySentAt: new Date().toISOString() });
          console.log(`[staleSessionNudge] Re-sent stuck step for ${doc.id} (step: ${session.onboardingStep})`);
        }
      } catch (err) {
        console.error(`[staleSessionNudge] resendStuckStep failed for ${doc.id}:`, err);
      }
    }

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

        // Build a per-step nudge in Cara's own voice instead of a frozen template.
        // Each branch supplies (a) a context describing the moment + the concrete
        // facts she must keep (prices, the SKIP keyword, value props) and (b) the
        // original copy as a fallback if the model call fails. This is a daily
        // cron, so the extra generation call carries no user-facing latency.
        const language: "en" | "es" = session.preferredLanguage === "es" ? "es" : "en";
        const audience: "caregiver" | "family" = userType === "caregiver" ? "caregiver" : "family";
        const namePart = firstName ? ` ${firstName}` : "";
        let context: string;
        let fallback: string;
        if (!userType || step === "ask_role") {
          context =
            `You haven't heard back from this person (name: ${firstName || "unknown"}) in a couple of days. ` +
            `They first reached out about care but never told you whether they need care for a loved one or are a caregiver looking for work. ` +
            `Send a warm, no-pressure nudge that re-opens the conversation and lays out the two options as a simple numbered list: ` +
            `"1️⃣ I need care for someone" and "2️⃣ I'm a caregiver". Keep it short.`;
          fallback =
            `Hi${namePart}, still thinking about care?\n\nJust reply when you're ready:\n\n` +
            `1️⃣ I need care for someone\n2️⃣ I'm a caregiver`;
        } else if (userType === "caregiver") {
          if (step === "caregiver_send_bgcheck" || step === "caregiver_awaiting_bgcheck") {
            context = `${firstName || "This caregiver"} stalled at the background-check step — the last thing before families can book them. Warmly nudge them: families can't book until it's done, it takes about 5 minutes, and they can reply here to get the link again.`;
            fallback = `${greeting} Your background check is the last step before you can start getting booked.\n\nFamilies can't book you until it's done. It takes about 5 minutes. Reply here and I'll send the link again.`;
          } else if (step === "caregiver_ask_rate") {
            context = `${firstName || "This caregiver"} stalled on setting their hourly rate. Warmly, no pressure: most caregivers on Cara charge $18-28/hr, and they can always update it later. Encourage them to pick something.`;
            fallback = `${greeting} Still thinking about your hourly rate?\n\nMost caregivers on Cara charge $18-28/hr. You can always update it later. No pressure to get it perfect now.`;
          } else if (step === "caregiver_send_photo" || step === "caregiver_awaiting_photo") {
            context = `${firstName || "This caregiver"} stalled before adding a profile photo. Warmly nudge: a clear headshot makes families much more likely to request an interview, and they can reply here to get the upload link again.`;
            fallback = `${greeting} Your profile is almost live.\n\nAdding a photo makes families much more likely to request an interview. A clear headshot is all you need. Reply here and I'll send the link again.`;
          } else if (step === "caregiver_send_membership" || step === "caregiver_awaiting_membership") {
            context = `${firstName || "This caregiver"} stalled right before activating membership. Warmly nudge: activating their $24.95/year membership unlocks getting booked and Cara's payout tools, and they can reply here to get the link again.`;
            fallback = `${greeting} You're one step from being able to apply to jobs near you.\n\nActivating your $24.95/year membership unlocks getting booked and Cara's payout tools. Reply here and I'll send the link again.`;
          } else if (step === "caregiver_send_documents" || step === "caregiver_awaiting_documents") {
            context = `${firstName || "This caregiver"} stalled on uploading certifications (CNA, CPR, etc.). Warmly nudge: they can upload now or reply SKIP to keep going, and reply here to get the upload link again. You MUST mention they can reply "SKIP" to continue.`;
            fallback = `${greeting} Almost done — just your certifications left (CNA, CPR, etc.).\n\nYou can upload them now or reply SKIP to keep going. Reply here and I'll send the upload link again.`;
          } else {
            context = `${firstName || "This caregiver"} stalled partway through profile setup. Send a short, warm nudge inviting them to reply whenever they're ready to continue.`;
            fallback = `${greeting} Your caregiver profile is almost done.\n\nReply here whenever you're ready to continue.`;
          }
        } else {
          if (step === "client_send_payment" || step === "client_awaiting_payment") {
            context = `${firstName || "This family member"} stalled at the last step — adding a payment method so caregivers can get paid after each visit. Warmly reassure: it takes about 30 seconds and there are no charges until they book a caregiver.`;
            fallback = `${greeting} The last step is adding a payment method so caregivers can get paid after each visit.\n\nTakes about 30 seconds. No charges until you book a caregiver.`;
          } else if (step === "client_awaiting_identity") {
            context = `${firstName || "This family member"} stalled on a quick identity check. Warmly reassure: it's a 30-second step that keeps every family on the platform safe, and they can reply here to get a fresh link.`;
            fallback = `${greeting} Just one quick identity check left — it's a 30-second step that keeps every family on the platform safe.\n\nReply here and I'll send you a fresh link.`;
          } else if (step === "client_ask_schedule") {
            context = `${firstName || "This family member"} stalled before telling you how often they need care. Warmly nudge: once you know the schedule you'll start searching for caregivers.`;
            fallback = `${greeting} Almost there. Just need to know how often you need care and I'll start searching for caregivers.`;
          } else {
            context = `${firstName || "This family member"} stalled partway through getting set up. Send a short, warm nudge inviting them to reply whenever they're ready and you'll pick up where you left off.`;
            fallback = `${greeting} I'm here whenever you're ready to continue.\n\nJust reply and I'll pick up where we left off.`;
          }
        }

        const message = await generateCaraMessage({
          audience,
          language,
          context: `${context} This is a gentle re-engagement text after a couple of days of silence — sound like a real person checking in, never pushy or salesy.`,
          fallback,
          maxTokens: 130,
        });

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
