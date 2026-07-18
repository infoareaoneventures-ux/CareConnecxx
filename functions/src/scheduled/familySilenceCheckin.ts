/**
 * Family-silence check-in.
 *
 * Runs daily. For each active client session (onboarding complete, opted-in,
 * not opted-out) where `lastInboundAt` is older than 3 days, send one gentle,
 * context-aware check-in message. Cap at one nudge per 7 days per phone so
 * we never spam silent users.
 *
 * Uses the existing `sendViaInteractionAgent` flow so DND, supervisor, and
 * audit logging are honored. Skips users currently in bereavement mode.
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";

const db = admin.firestore();

export const familySilenceCheckinJob = functions.pubsub
  .schedule("0 16 * * *") // 16:00 UTC daily (~11am ET / ~9am MT) — friendly business-hour window
  .timeZone("America/New_York")
  .onRun(async () => {
    const now            = Date.now();
    const threeDaysAgo   = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo   = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo  = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Pull active client sessions that:
    //   - onboardingStep === "complete"
    //   - userType === "client"
    //   - last inbound > 3 days ago
    //
    // We filter the rest in code (Firestore composite-index limits keep the
    // query simple). Hard cap of 500 sessions/run keeps cost bounded.
    const snap = await db.collection("agent_sessions")
      .where("userType",       "==", "client")
      .where("onboardingStep", "==", "complete")
      .where("lastInboundAt",  "<",  threeDaysAgo)
      .limit(500)
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const phone   = doc.id;
      const session = doc.data();

      if (session.optedOut) continue;
      if (session.optedIn === false) continue;
      if (session.bereavementMode) continue;            // grief — don't nudge
      if (!session.chatId) continue;

      // Skip if we already nudged this phone in the past 7 days
      const lastNudgeAt = session.silenceNudgeSentAt as string | undefined;
      if (lastNudgeAt && lastNudgeAt > sevenDaysAgo) continue;

      // Skip very new accounts (<7 days) — they may just be quiet on purpose
      const createdAt = (session.createdAt ?? "") as string;
      if (!createdAt || createdAt > sevenDaysAgo) continue;

      // Don't nudge accounts that have been silent for over 30 days; those
      // should be handled by reactivation flow, not a casual check-in.
      const lastInbound = session.lastInboundAt as string | undefined;
      if (!lastInbound || lastInbound < thirtyDaysAgo) continue;

      try {
        // Generate a warm, varied check-in. Use Claude (via caraMessage) so
        // the message reads naturally — never the same template twice.
        const seniorName = (session.onboardingData?.seniorName ?? "") as string;
        const seniorPart = seniorName ? ` and ${seniorName}` : "";
        // R11: ground who's who — the reader is the account holder, not the
        // care recipient; never attribute the care to the reader.
        const whoIsWho = describeWhoIsWho((session.onboardingData ?? {}) as Record<string, unknown>);
        const message = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `It's been a few days since this family last messaged you. Send a brief, warm check-in — NOT pushy, NOT a sales prompt. ` +
            `Ask how they${seniorPart} are doing, or if anything's come up. Acknowledge it's been a bit. ` +
            `One or two sentences max. No bullets, no questions about scheduling unless they bring it up.`,
          fallback: `Hey — it's been a few days. How's everything going${seniorPart}? I'm here whenever you need anything. 💙`,
          maxTokens: 80,
        });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "low",
          sourceAgent: "family_silence_checkin",
          canDrop:     true, // DND respects this; nudge can be skipped if user is in quiet hours
        });

        await doc.ref.update({
          silenceNudgeSentAt: new Date().toISOString(),
          silenceNudgeCount:  admin.firestore.FieldValue.increment(1),
        });
        sent++;
      } catch (err) {
        console.error("familySilenceCheckin error for", phone, err);
      }
    }

    console.log(`[familySilenceCheckin] ${snap.size} eligible sessions, ${sent} nudges sent`);
  });
