/**
 * Proactive family satisfaction check-in (U8 — plan 2026-06-23-001).
 *
 * Periodically asks active families how things are going overall, to catch
 * dissatisfaction early. Distinct from the per-shift next-day feedback (U7) and
 * the 3-day silence nudge (familySilenceCheckin). Gated to once per family every
 * 14 days and subject to the shared weekly per-family budget (KTD-14), where
 * satisfaction surveys rank below operational reminders and next-day feedback —
 * so they're dropped first when a family's week is already full.
 *
 * A negative reply should be flagged for follow-up; that sentiment routing lives
 * on the client inbound path (the job sets `awaitingSatisfactionReply`).
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";
import {
  evaluateWeeklyFamilyBudget,
  type WeeklyBudgetTally,
} from "./proactiveBudget";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

export const sendFamilySatisfactionCheckins = functions.pubsub
  .schedule("0 17 * * *") // 17:00 UTC ≈ 1pm ET daily; per-family 14-day gate spreads load
  .timeZone("America/New_York")
  .onRun(async () => {
    const nowIso = new Date().toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db.collection("agent_sessions")
      .where("userType", "==", "client")
      .where("onboardingStep", "==", "complete")
      .limit(500)
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const phone = doc.id;
      const session = doc.data() as Record<string, unknown>;
      try {
        // Childcare U10 (R54/AE16): careVertical === "child" sessions are
        // skipped — senior satisfaction copy, childcare proactive deferred.
        if (session.careVertical === "child") continue;
        if (session.optedOut) continue;
        if (session.optedIn === false) continue;
        if (session.bereavementMode) continue;
        if (!session.chatId) continue;

        // Only families with ongoing care (an active care relationship).
        if (!session.hasActiveCare && !(session.onboardingData as any)?.seniorName) continue;

        // 14-day per-family gate.
        const last = session.satisfactionCheckinAt as string | undefined;
        if (last && last > fourteenDaysAgo) continue;

        // Shared weekly per-family budget (KTD-14) — lower priority than feedback.
        const budget = evaluateWeeklyFamilyBudget(
          session.weeklyProactiveTally as WeeklyBudgetTally | undefined,
          "satisfaction_checkin",
          nowIso,
        );
        if (!budget.allowed) continue;

        const seniorName = ((session.onboardingData as any)?.seniorName ?? "") as string;
        const seniorPart = seniorName ? ` with ${seniorName}'s care` : "";
        // R11: ground who's who — the care is for the recipient, never the reader.
        const whoIsWho = describeWhoIsWho((session.onboardingData ?? {}) as Record<string, unknown>);
        const message = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `Send a brief, warm satisfaction check-in to a family with ongoing care${seniorPart}. ` +
            `Ask how things have been going overall and whether there's anything you can do better. ` +
            `Genuine and low-pressure, one or two sentences, no bullets, not a formal survey.`,
          fallback: `Hi! Just checking in — how have things been going${seniorPart} lately? Anything I can do better for you?`,
          maxTokens: 80,
        });

        // U8 engine gate (KTD15): optional discretionary source — on a lost
        // pass we skip WITHOUT stamping satisfactionCheckinAt or the weekly
        // tally, so the ask re-enters naturally on the next daily run.
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "familySatisfactionCheckin",
            category: "satisfaction",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `satis:${phone}:${nowIso.slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("familySatisfactionCheckin.policy", { phone, disposition: g.disposition, reason: g.reason });
          continue;
        }

        await sendViaInteractionAgent(phone, {
          content: message,
          urgency: "low",
          sourceAgent: "satisfaction_checkin",
          canDrop: true,
        });

        await doc.ref.set(
          {
            weeklyProactiveTally: budget.next,
            satisfactionCheckinAt: nowIso,
            awaitingSatisfactionReply: { askedAt: nowIso },
          },
          { merge: true },
        );
        sent++;
      } catch (err) {
        console.error("[familySatisfactionCheckin] error for", phone, err);
      }
    }

    console.log(`[familySatisfactionCheckin] ${snap.size} active families, ${sent} check-ins sent`);
  });
