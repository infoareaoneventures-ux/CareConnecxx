import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

/**
 * Daily re-engagement nudge for caregivers who stalled mid-onboarding.
 *
 * Target: agent_sessions where userType="caregiver", onboardingStep ≠ "complete",
 * and lastInboundAt is between 24h and 14 days ago. Caps at one nudge per 72h
 * per caregiver via `lastReengagementNudgeAt` to avoid pestering.
 *
 * The companion stale-session checkpoint logic in webhooks.ts already handles
 * RESUME/START OVER replies; this job's job is just to remind them to come back.
 */
export const sendOnboardingReengagement = functions.pubsub
  .schedule("0 18 * * *") // 10am PT = 18:00 UTC daily
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const now             = Date.now();
    const twentyFourHrAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const fourteenDayAgo  = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const seventyTwoHrAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();

    // We can't compound-filter on userType + onboardingStep + lastInboundAt without
    // a composite index. Filter on userType and let in-loop checks handle the rest.
    const sessionsSnap = await db.collection("agent_sessions")
      .where("userType", "==", "caregiver")
      .get();

    if (sessionsSnap.empty) {
      console.log("[onboardingReengagement] No caregiver sessions found.");
      return;
    }

    let nudgesSent = 0;
    let skipped    = 0;

    for (const sessionDoc of sessionsSnap.docs) {
      const session = sessionDoc.data();
      const phone   = sessionDoc.id;

      try {
        const onboardingStep = session.onboardingStep as string | undefined;
        if (!onboardingStep || onboardingStep === "complete") { skipped++; continue; }

        // Skip if opted out or no chatId
        if (session.optedOut === true) { skipped++; continue; }
        if (!session.chatId) { skipped++; continue; }

        const lastInboundAt = session.lastInboundAt as string | undefined;
        if (!lastInboundAt) { skipped++; continue; }
        // Must be stale (>= 24h) but not abandoned (< 14d)
        if (lastInboundAt > twentyFourHrAgo) { skipped++; continue; }
        if (lastInboundAt < fourteenDayAgo)  { skipped++; continue; }

        // Throttle: one nudge per 72h
        const lastNudge = session.lastReengagementNudgeAt as string | undefined;
        if (lastNudge && lastNudge > seventyTwoHrAgo) { skipped++; continue; }

        const onboardingData = (session.onboardingData ?? {}) as Record<string, unknown>;
        const firstName = (onboardingData.name ?? onboardingData.firstName ?? "there") as string;
        const stepLabel = humanLabelForStep(onboardingStep);

        const msg = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Caregiver first name: ${firstName.split(" ")[0]}. ` +
            `They started signing up but stalled at: "${stepLabel}". ` +
            "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off. " +
            "Mention that they're close to being able to take jobs. Don't be pushy.",
          fallback:
            `Hey ${firstName.split(" ")[0]}, you're just a step or two away from being able to take jobs on CareConnex. ` +
            `Want to pick up where you left off? Reply RESUME to continue.`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     msg,
          urgency:     "low",
          sourceAgent: "onboarding_reengagement",
          canDrop:     true,
        }).catch(() => {});

        await sessionDoc.ref.update({
          lastReengagementNudgeAt: new Date().toISOString(),
        });

        nudgesSent++;
        console.log(`[onboardingReengagement] Nudged ${phone} (step: ${onboardingStep})`);
      } catch (err) {
        console.error(`[onboardingReengagement] Error for session ${phone}:`, err);
      }
    }

    console.log(`[onboardingReengagement] Done. Nudges sent: ${nudgesSent}, skipped: ${skipped}`);
  });

function humanLabelForStep(step: string): string {
  const map: Record<string, string> = {
    verify_phone:                       "verifying your phone number",
    ask_role:                           "picking a role",
    caregiver_ask_name:                 "sharing your name",
    caregiver_ask_location:             "telling me your city",
    caregiver_ask_experience:           "sharing your experience",
    caregiver_ask_specialties:          "listing your specialties",
    caregiver_ask_availability:         "sharing your availability",
    caregiver_ask_job_type:             "choosing job type",
    caregiver_ask_rate:                 "setting your rate",
    caregiver_ask_email:                "sharing your email",
    caregiver_ask_bio:                  "writing your bio",
    caregiver_send_photo:               "uploading your photo",
    caregiver_awaiting_photo:           "uploading your photo",
    caregiver_send_documents:           "uploading certifications",
    caregiver_awaiting_documents:       "uploading certifications",
    caregiver_ask_mvr:                  "the MVR question",
    caregiver_send_membership:          "completing your membership payment",
    caregiver_awaiting_membership:      "completing your membership payment",
    caregiver_send_bgcheck:             "starting your background check",
    caregiver_awaiting_bgcheck:         "finishing your background check",
    caregiver_send_stripe_connect:      "setting up your payout account",
    caregiver_awaiting_stripe:          "setting up your payout account",
  };
  return map[step] ?? "finishing your profile";
}
