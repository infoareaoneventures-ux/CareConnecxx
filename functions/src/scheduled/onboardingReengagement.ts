import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";
import { writeUserNotification } from "../notifications/userNotification";
import { humanLabelForStep } from "./onboardingStepLabels";

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

        // Copy rule (2026-09-26): a reminder is a factual report of where they are
        // — never a text-only protocol ("reply RESUME"), which the website has no
        // equivalent of. Replying here is simply how the text door continues.
        const msg = await generateCaraMessage({
          audience: isCaregiver ? "caregiver" : "family",
          context: isCaregiver
            ? `Caregiver first name: ${firstName.split(" ")[0]}. ` +
              `They started signing up but stalled at: "${stepLabel}". ` +
              "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off — just by replying here, or on their dashboard. " +
              "Mention that they're close to being able to take jobs. Don't be pushy. Never tell them to reply with a keyword."
            : `Family member first name: ${firstName.split(" ")[0]}. ` +
              `They started getting care set up but stalled at: "${stepLabel}". ` +
              "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off — just by replying here, or on their dashboard. " +
              "Mention they're close to seeing their caregiver matches. Don't be pushy. Never tell them to reply with a keyword.",
          fallback: isCaregiver
            ? `Hey ${firstName.split(" ")[0]}, you're just a step or two away from being able to take jobs on Evia — you stopped at ${stepLabel}. ` +
              `Reply here whenever you're ready and we'll pick up right where you left off.`
            : `Hi ${firstName.split(" ")[0]}, you're just a step or two away from seeing your caregiver matches — you stopped at ${stepLabel}. ` +
              `Reply here whenever you're ready and we'll pick up right where you left off.`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     msg,
          urgency:     "low",
          sourceAgent: "onboarding_reengagement",
          canDrop:     true,
        }).catch(() => {});

        // The same reminder in the website's notification bell (founder,
        // 2026-09-26: "add it to the notification bell" — both doors see the
        // same thing at the same moment). Idempotent per session per day; a
        // session with no account yet (cold SMS, pre-uid) has no bell to write.
        const bellUid = (session.caregiverId ?? session.userId) as string | undefined;
        if (bellUid) {
          await writeUserNotification({
            sourcePath:     `agent_sessions/${phone}`,
            eventId:        `reengagement:${new Date(now).toISOString().slice(0, 10)}`,
            recipientId:    bellUid,
            transitionType: "onboarding_reengagement",
            type:           "onboarding_reminder",
            title:          isCaregiver ? "Finish your caregiver setup" : "Finish setting up care",
            body:           isCaregiver
              ? `You're a step or two away from being able to take jobs — you stopped at ${stepLabel}.`
              : `You're a step or two away from seeing your caregiver matches — you stopped at ${stepLabel}.`,
            data:           { step: onboardingStep },
          }).catch((err) => console.error("[onboardingReengagement] bell write failed (non-fatal):", err));
        }

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

