import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

/**
 * Daily re-engagement nudge for BOTH clients and caregivers who stalled
 * mid-onboarding.
 *
 * Target: agent_sessions where onboardingStep ≠ "complete" and lastInboundAt is
 * between 24h and 14 days ago. Caps at one nudge per 72h per user via
 * `lastReengagementNudgeAt` to avoid pestering. Copy is audience-aware (family
 * vs caregiver).
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

    // Pull all sessions and let in-loop checks handle step/recency/role — clients
    // stall too (identity, payment, intake), and they were previously never nudged.
    const sessionsSnap = await db.collection("agent_sessions").get();

    if (sessionsSnap.empty) {
      console.log("[onboardingReengagement] No sessions found.");
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

        // Live check (2026-08-30 fix): same bug this job shares with
        // staleSessionNudge.ts — a client who already finished via the
        // WEBSITE still has a stale, incomplete onboardingStep here forever.
        // Only clients have an independent website path (caregiver
        // onboarding is SMS-only per CLAUDE.md).
        if (session.userType !== "caregiver" && session.userId) {
          const userSnap = await db.collection("users").doc(session.userId as string).get();
          if (userSnap.exists) {
            const { userHasRealOnboardingProgress } = await import("../linq/webhooks");
            if (await userHasRealOnboardingProgress(session.userId as string, userSnap.data()!)) {
              await sessionDoc.ref.update({ onboardingStep: "complete" });
              skipped++;
              continue;
            }
          }
        }

        const lastInboundAt = session.lastInboundAt as string | undefined;
        if (!lastInboundAt) { skipped++; continue; }
        // Must be stale (>= 24h) but not abandoned (< 14d)
        if (lastInboundAt > twentyFourHrAgo) { skipped++; continue; }
        if (lastInboundAt < fourteenDayAgo)  { skipped++; continue; }

        // Throttle: one nudge per 72h
        const lastNudge = session.lastReengagementNudgeAt as string | undefined;
        if (lastNudge && lastNudge > seventyTwoHrAgo) { skipped++; continue; }

        // U8 engine gate (KTD15): optional discretionary re-engagement — the
        // engine decides per recipient per pass. A lost pass re-enters on the
        // next daily run (the 72h throttle marker is only stamped on send).
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "onboardingReengagement",
            category: "re_engagement",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `onbre:${phone}:${new Date(now).toISOString().slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("onboardingReengagement.policy", { phone, disposition: g.disposition, reason: g.reason });
          skipped++;
          continue;
        }

        const onboardingData = (session.onboardingData ?? {}) as Record<string, unknown>;
        const firstName = (onboardingData.name ?? onboardingData.firstName ?? "there") as string;
        const stepLabel = humanLabelForStep(onboardingStep);
        const isCaregiver = session.userType === "caregiver";

        const msg = await generateCaraMessage({
          audience: isCaregiver ? "caregiver" : "family",
          context: isCaregiver
            ? `Caregiver first name: ${firstName.split(" ")[0]}. ` +
              `They started signing up but stalled at: "${stepLabel}". ` +
              "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off. " +
              "Mention that they're close to being able to take jobs. Don't be pushy."
            : `Family member first name: ${firstName.split(" ")[0]}. ` +
              `They started getting care set up but stalled at: "${stepLabel}". ` +
              "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off. " +
              "Mention they're close to seeing their caregiver matches. Don't be pushy.",
          fallback: isCaregiver
            ? `Hey ${firstName.split(" ")[0]}, you're just a step or two away from being able to take jobs on Evia. ` +
              `Want to pick up where you left off? Reply RESUME to continue.`
            : `Hi ${firstName.split(" ")[0]}, you're just a step or two away from seeing your caregiver matches. ` +
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
    // Client steps
    client_ask_name:                    "sharing your name",
    client_ask_senior:                  "telling me who needs care",
    client_ask_needs:                   "describing the care needs",
    client_ask_location:                "sharing the location",
    client_ask_schedule:                "setting the schedule",
    client_ask_start:                   "choosing a start date",
    client_ask_preferences:             "sharing caregiver preferences",
    client_ask_budget:                  "sharing a budget",
    client_confirm_intake:              "confirming the details",
    client_ask_plan:                    "choosing your membership",
    client_send_payment:                "starting your membership",
    client_awaiting_identity:           "verifying your identity",
    client_awaiting_payment:            "starting your membership",
    job_confirm_prefill:                "posting your care request",
    // Caregiver steps
    caregiver_ask_name:                 "sharing your name",
    caregiver_ask_location:             "telling me your city",
    caregiver_ask_experience:           "sharing your experience",
    caregiver_ask_specialties:          "listing your specialties",
    caregiver_ask_profile:              "a couple profile details",
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
    caregiver_send_bgcheck:             "authorizing your background check",
    caregiver_awaiting_bgcheck_consent: "authorizing your background check",
    caregiver_awaiting_bgcheck:         "finishing your background check",
    caregiver_send_stripe_connect:      "setting up your payout account",
    caregiver_awaiting_stripe:          "setting up your payout account",
  };
  return map[step] ?? "finishing your profile";
}
