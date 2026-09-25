import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { getMarketRateText } from "../utils/marketRateRange";
import { caregiverAnnualDisplay, clientMonthlyDisplay } from "../config/pricing";
import { LIVE_GATE_FACT_BUILDERS } from "../agents/liveGateFacts";
import { describeWhoIsWho } from "../agents/careRecipients";
import { AgentSession } from "../linq/client";
import { gateOptionalSend } from "./engineGate";

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
      "caregiver_awaiting_bgcheck_consent",
      "caregiver_awaiting_bgcheck",
      "caregiver_awaiting_stripe",
      "caregiver_awaiting_membership",
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
          // A recovery that actually re-delivered a gate link must open the
          // SAME per-step resend cooldown the inbound `other` path uses —
          // otherwise a nudge followed by an immediate "hm ok" reply delivers
          // two link cards within a minute. Scoped to the gate-parked steps
          // the cooldown governs (isGateLinkKeywordStep); the text-only 48h
          // nudges below never stamp.
          const step = session.onboardingStep as string;
          const { isGateLinkKeywordStep, stampGateLinkResent } = await import("../agents/gateLinkCooldown");
          if (isGateLinkKeywordStep(step)) await stampGateLinkResent(doc.id, step);
          console.log(`[staleSessionNudge] Re-sent stuck step for ${doc.id} (step: ${session.onboardingStep})`);
        }
      } catch (err) {
        console.error(`[staleSessionNudge] resendStuckStep failed for ${doc.id}:`, err);
      }
    }

    // ── Auto-complete sessions stuck at a permissions step for 7+ days ────────
    // The permission questions are optional yes/no setup that runs AFTER the
    // real caregiver onboarding is done (bg check cleared + payouts live; the
    // client questions were removed 2026-09-23) — but the router consumes EVERY inbound text
    // while onboardingStep is a permissions step, so a session stuck here
    // blocks all of Evia's normal features indefinitely. After 7 days: default
    // the unanswered permissions OFF, mark complete, and tell them they're set.
    const PERMISSION_STEPS = [
      "caregiver_permissions_decline", "caregiver_permissions_arrival",
    ];
    const permSnap = await db.collection("agent_sessions")
      .where("onboardingStep", "in", PERMISSION_STEPS)
      .get();

    for (const doc of permSnap.docs) {
      const session = doc.data();
      if (session.optedOut) continue;
      const updatedAt = (session.updatedAt ?? session.createdAt ?? "") as string;
      if (!updatedAt || updatedAt > sevenDaysAgo) continue;
      if (!session.chatId) continue;

      try {
        const step     = session.onboardingStep as string;
        const userType = "caregiver" as const;
        const userId   = (session.caregiverId ?? doc.id) as string;
        const { finalizePermissionsWithDefaults } = await import("../agents/permissionsConversation");
        await finalizePermissionsWithDefaults(doc.id, session.chatId as string, userType, userId, step);

        const message = await generateCaraMessage({
          audience: "caregiver",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "This caregiver's profile is complete and live, but they never answered the optional yes/no setup questions, so Evia has left those auto-settings OFF and finished setup for them. Tell them warmly: they're all set, their profile is live, and they can turn on auto-declining jobs or arrival notifications anytime by texting. Never claim anything is missing or unfinished.",
          fallback: "You're all set — your profile is live! I've left the optional auto-settings off for now; text me anytime to change them.",
          maxTokens: 120,
        });
        await sendViaInteractionAgent(doc.id, {
          content:     message,
          urgency:     "low",
          sourceAgent: "stale_nudge",
          canDrop:     true,
        });
        console.log(`[staleSessionNudge] auto-completed stale permissions for ${doc.id} (step: ${step})`);
      } catch (err) {
        console.error(`[staleSessionNudge] permissions auto-complete failed for ${doc.id}:`, err);
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
        // Live check (2026-08-30 fix): a client who finished the real thing
        // via the WEBSITE — not through this SMS conversation — still has a
        // stale, incomplete onboardingStep on this session doc forever, since
        // nothing here ever re-syncs it. Without this check this job wrongly
        // told a client who'd already finished on the site "you're almost
        // there, just tell us who needs care." Only clients have an
        // independent website path (caregiver onboarding is SMS-only per
        // CLAUDE.md), so this only applies when userType isn't "caregiver."
        if (session.userType !== "caregiver" && session.userId) {
          const userSnap = await db.collection("users").doc(session.userId as string).get();
          if (userSnap.exists) {
            const { userHasRealOnboardingProgress } = await import("../linq/webhooks");
            if (await userHasRealOnboardingProgress(session.userId as string, userSnap.data()!)) {
              // Self-heal so this session stops surfacing here every day.
              await doc.ref.update({ onboardingStep: "complete" });
              continue;
            }
          }
        }

        // U8 engine gate (KTD15): this 48h stale nudge is an OPTIONAL
        // discretionary send — the engine decides per recipient per pass. A
        // lost pass re-enters naturally on the next daily run. (The stuck-step
        // resend and permissions auto-complete loops above are transactional
        // and stay ungated per the manifest.)
        const g = await gateOptionalSend({
          phone: doc.id,
          candidate: {
            source: "staleSessionNudge",
            category: "re_engagement",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `stale:${doc.id}:${new Date(now).toISOString().slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("staleSessionNudge.policy", { phone: doc.id, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const step      = session.onboardingStep ?? "ask_role";
        const firstName = (session.onboardingData?.firstName ?? session.onboardingData?.name ?? "") as string;
        const greeting  = firstName ? `Hey ${firstName}!` : "Hey there!";
        const userType  = session.userType as string | undefined;

        // Build a per-step nudge in Evia's own voice instead of a frozen template.
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
            `Send a warm, no-pressure nudge that re-opens the conversation and asks naturally whether they're ` +
            `looking for care for someone or are a caregiver themselves. No numbered lists or menus. Keep it short.`;
          fallback =
            `Hi${namePart}, still thinking about care? Whenever you're ready, just tell me — ` +
            `are you looking for care for someone, or are you a caregiver yourself?`;
        } else if (userType === "caregiver") {
          if (step === "caregiver_send_bgcheck" || step === "caregiver_awaiting_bgcheck_consent") {
            context = `${firstName || "This caregiver"} stalled before authorizing their background check — the last thing before families can book them, and it's already included in the membership they paid. Warmly nudge them: it takes about a minute to review and authorize, then Checkr emails them a secure link to finish, and they can reply here to get the link again.`;
            fallback = `${greeting} Your background check is the last step before you can start getting booked — and it's already included in your membership.\n\nAuthorizing it takes about a minute, then Checkr emails you a secure link to finish. Reply here and I'll send the link again.`;
          } else if (step === "caregiver_awaiting_bgcheck") {
            context = `${firstName || "This caregiver"} authorized their background check but hasn't finished Checkr's form yet. Warmly nudge them: the secure link is in their email from Checkr, it takes about 5 minutes, families can't book them until it's done, and they can reply here to get the link texted again.`;
            fallback = `${greeting} Your background check is almost done — Checkr emailed you a secure link to finish (about 5 minutes).\n\nFamilies can't book you until it's complete. Reply here and I'll text you the link again.`;
          } else if (step === "caregiver_ask_rate") {
            const rateText = await getMarketRateText(); // live SCC caregiver rates, fail-soft static
            context = `${firstName || "This caregiver"} stalled on setting their hourly rate. Warmly, no pressure: most caregivers on Evia charge ${rateText}, and they can always update it later. Encourage them to pick something.`;
            fallback = `${greeting} Still thinking about your hourly rate?\n\nMost caregivers on Evia charge ${rateText}. You can always update it later. No pressure to get it perfect now.`;
          } else if (step === "caregiver_send_membership" || step === "caregiver_awaiting_membership") {
            context = `${firstName || "This caregiver"} stalled right before activating membership. Warmly nudge: their ${caregiverAnnualDisplay()} membership includes their required background check and unlocks getting booked and Evia's payout tools, and they can reply here to get the link again.`;
            fallback = `${greeting} You're one step from being able to apply to jobs near you.\n\nYour ${caregiverAnnualDisplay()} membership includes your background check and unlocks getting booked and Evia's payout tools. Reply here and I'll send the link again.`;
          } else if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
            // Their PROFILE is finished at this point — never imply otherwise
            // (founder report 2026-07-10: the generic branch below told a fully
            // live caregiver their profile was "almost there"). But do NOT assert
            // payouts are live or the background check cleared here: a caregiver
            // reaches the permissions questions before Stripe Connect / Checkr
            // actually finish (founder report 2026-07-14), so those claims can be
            // false. Keep the nudge to the profile + the optional yes/no.
            context = `${firstName || "This caregiver"}'s profile is COMPLETE — NOTHING is missing from their profile; never say it's unfinished or invent missing profile fields. Do NOT claim their payout setup or background check is finished (those may still be processing). All that's left on THIS step is one optional yes/no question Evia already asked (${step === "caregiver_permissions_arrival" ? "auto-notifying the family when they arrive at a visit" : "auto-declining job requests outside their availability"}). Warmly invite a quick yes or no — one word finishes this step, and they can change it anytime. Never write a stiff "Reply YES or NO" instruction.`;
            fallback = `${greeting} Good news — your profile is complete and live. A quick yes or no to my last question and you're all set (you can change it anytime).`;
          } else {
            context = `${firstName || "This caregiver"} stalled partway through profile setup. Send a short, warm nudge inviting them to reply whenever they're ready to continue.`;
            fallback = `${greeting} Your caregiver profile is almost done.\n\nReply here whenever you're ready to continue.`;
          }
        } else {
          if (step === "client_send_payment" || step === "client_awaiting_payment") {
            // Accurate money copy (2026-07-09): this checkout is a monthly
            // subscription (clientMonthlyDisplay) that bills immediately — never
            // claim "no charges until you book" or frame it as card-on-file.
            context = `${firstName || "This family member"} stalled at the last step — starting their ${clientMonthlyDisplay()} Evia membership, which is what lets them message, interview and book the caregivers they've seen. Warmly nudge: it takes about 30 seconds, the search starts the moment it's active, and they can reply here to get the link again.`;
            fallback = `${greeting} The last step is starting your membership (${clientMonthlyDisplay()}) so you can message, interview and book the caregivers you've seen.\n\nTakes about 30 seconds — reply here and I'll send the link again.`;
          } else if (step === "client_awaiting_identity") {
            context = `${firstName || "This family member"} stalled on a quick identity check. Warmly reassure: it's a 30-second step that keeps every family on the platform safe, and they can reply here to get a fresh link.`;
            fallback = `${greeting} Just one quick identity check left — it's a 30-second step that keeps every family on the platform safe.\n\nReply here and I'll send you a fresh link.`;
          } else if (step === "client_ask_schedule") {
            context = `${firstName || "This family member"} stalled before telling you how often they need care. Warmly nudge: once you know the schedule you can show them who's available nearby.`;
            fallback = `${greeting} Almost there. Just need to know how often you need care and I'll show you who's available nearby.`;
          } else {
            context = `${firstName || "This family member"} stalled partway through getting set up. Send a short, warm nudge inviting them to reply whenever they're ready and you'll pick up where you left off.`;
            fallback = `${greeting} I'm here whenever you're ready to continue.\n\nJust reply and I'll pick up where we left off.`;
          }
          // firstName above is the ACCOUNT HOLDER (the family member texting),
          // not the care recipient — without this grounding the model has
          // attributed visits to the account holder ("book Anahi's first
          // visits" when the care is for her mom Rosie, 2026-07-17).
          const whoIsWho = describeWhoIsWho((session.onboardingData ?? {}) as Record<string, unknown>);
          if (whoIsWho) context = `${whoIsWho} ${context}`;
        }

        // Ground the per-step nudge in the user's LIVE state so a branch's
        // baked-in assertion (e.g. the bg-check branch's "hasn't finished
        // Checkr's form yet") can never contradict Firestore — a cleared or
        // considered check must not ship that copy. Grounding only; this does
        // not change which sessions get nudged or the cadence. Fail-soft: a
        // builder error leaves the original (ungrounded) context untouched.
        const liveBuilder = LIVE_GATE_FACT_BUILDERS[step];
        if (liveBuilder) {
          try {
            const liveFact = await liveBuilder(doc.id, session as AgentSession);
            if (liveFact) {
              context = `${liveFact} Ground your nudge in this live status and NEVER assert a state that contradicts it. ${context}`;
            }
          } catch (err) {
            console.warn("[staleSessionNudge] live fact builder failed (ungrounded nudge):", err);
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
