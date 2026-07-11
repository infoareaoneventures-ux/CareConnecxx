import * as admin from "firebase-admin";
import Stripe from "stripe";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanMidFlow } from "./humanReply";
import { executeInstantPayout, InstantPayoutError } from "../payoutCommon";

const db = admin.firestore();

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  return _stripe;
}

/**
 * Entry: caregiver texts PAYOUT (or NLU classifies as INSTANT_PAYOUT). We look up
 * their instantly-available balance via Stripe Connect and ask for confirmation.
 * The router calls handleInstantPayoutConfirm for the subsequent YES/NO reply.
 * The payout itself goes through payoutCommon.executeInstantPayout — the same
 * implementation as the app and the MCP tool. Instant payouts are free to the
 * caregiver; regular earnings arrive automatically on Stripe's daily schedule.
 */
export async function startInstantPayout(
  caregiverId: string,
  phone:       string,
  chatId:      string,
): Promise<void> {
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = cgSnap.data();
  if (!cg) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "A caregiver asked for an instant payout but you couldn't find their caregiver profile. Warmly ask them to send the email they used to sign up so you can try again.",
      fallback: "I couldn't find your caregiver profile. Send the email you used to sign up and I'll try again.",
      maxTokens: 70,
    }));
    return;
  }
  const stripeAccountId = cg.stripeAccountId as string | undefined;
  if (!stripeAccountId) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "The caregiver asked for an instant payout but hasn't set up their payout account yet. Warmly explain they need to open the caregiver app and finish payout setup first, then text PAYOUT again. You MUST include the literal keyword \"PAYOUT\".",
      fallback: "Your payout account isn't set up yet. Open the caregiver app payout setup first, then text PAYOUT again.",
      maxTokens: 80,
    }));
    return;
  }

  // Pull the instantly-available balance from Stripe Connect (preview only —
  // the confirm step re-reads it inside executeInstantPayout).
  let availableCents = 0;
  try {
    const balance = await getStripe().balance.retrieve({ stripeAccount: stripeAccountId });
    const inst = ((balance as any).instant_available ?? []) as Array<{ amount: number; currency: string }>;
    availableCents = inst.find((b) => b.currency === "usd")?.amount ?? 0;
  } catch (err) {
    console.error("[instantPayout] balance retrieve failed:", err);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "You couldn't pull the caregiver's payout balance right now (a temporary hiccup). Warmly ask them to text PAYOUT again in a few minutes. You MUST include the literal keyword \"PAYOUT\".",
      fallback: "I couldn't pull your balance right now. Try PAYOUT again in a few minutes.",
      maxTokens: 70,
    }));
    return;
  }

  if (availableCents < 100) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "The caregiver has no funds available for an instant payout right now. Warmly let them know, and reassure them their earnings pay out automatically every day — money lands in their bank about 2 business days after each visit is paid.",
      fallback: "You don't have any funds available for instant payout right now. Your earnings pay out automatically every day — they land in your bank about 2 business days after each visit is paid.",
      maxTokens: 80,
    }));
    return;
  }

  const amount = (availableCents / 100).toFixed(2);
  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutConfirm: new Date().toISOString(),
    pendingInstantPayoutAmount: String(availableCents),
  } as any);
  await sendMessage(chatId,
    `You have $${amount} available for instant payout.\n\n` +
    `Instant payouts are free and arrive within about 30 minutes. ` +
    `Want me to send $${amount} to your bank now? Reply YES to send it, or NO to hold off.`,
  );
}

export async function handleInstantPayoutConfirm(
  caregiverId: string,
  phone:       string,
  text:        string,
  chatId:      string,
): Promise<void> {
  // isQuestionOrOther guard
  const reAsk = "So — send the instant payout? Reply YES to send it, or NO to hold off.";
  const isQ = await parseWithClaude(
    `A caregiver was asked: "${reAsk}". ` +
      "Reply YES if their message is a question or off-topic, NO if it's a direct yes/no answer. Only reply YES or NO.",
    text, 5,
  );
  if (isQ.toUpperCase().startsWith("Y")) {
    await sendMessage(chatId, await answerHumanMidFlow({
      audience: "caregiver",
      situation: "caregiver is confirming an instant payout",
      text,
      reAsk,
    }));
    return;
  }

  const decision = await parseWithClaude(
    '"yes", "confirm", "send it", "do it", "now" → YES. "no", "wait", "cancel", "not yet" → NO. Reply exactly YES or NO.',
    text, 5,
  );

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  const sd = sessionSnap.data() ?? {};
  const previewCents = parseInt((sd.pendingInstantPayoutAmount as string) ?? "0", 10);

  // Clear state regardless of decision
  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(),
    pendingInstantPayoutAmount:  admin.firestore.FieldValue.delete(),
  } as any);

  if (decision !== "YES" || previewCents <= 0) {
    const msg = await generateCaraMessage({
      audience: "caregiver",
      context: "A caregiver decided not to take an instant payout right now. Brief, neutral acknowledgment that their earnings still pay out automatically every day.",
      fallback: "No problem — your earnings still pay out automatically on the daily schedule.",
      maxTokens: 60,
    });
    await sendMessage(chatId, msg);
    return;
  }

  // Shared payout path: eligibility, replay guard, Stripe idempotency key,
  // and the caregivers/{id}/payouts record all live in executeInstantPayout.
  // We pay the CURRENT instant balance rather than the previewed amount so a
  // shift that settled between preview and YES is included, never stranded.
  try {
    const result = await executeInstantPayout({
      caregiverId,
      source: "cara_sms",
    });
    await sendMessage(chatId,
      `Done — $${(result.amountCents / 100).toFixed(2)} is on the way to your bank, no fee. ` +
      `Instant payouts typically arrive within 30 minutes.`,
    );
  } catch (err) {
    if (err instanceof InstantPayoutError && (err.code === "NO_BALANCE" || err.code === "DUPLICATE")) {
      await sendMessage(chatId,
        err.code === "DUPLICATE"
          ? "Looks like that payout was already sent a moment ago — it's on its way to your bank."
          : "Your balance was just paid out automatically, so there's nothing left to send right now. It'll land in your bank within about 2 business days.",
      );
      return;
    }
    console.error("[instantPayout] executeInstantPayout failed:", err);
    await sendMessage(chatId,
      "I wasn't able to process that instant payout — Stripe rejected it. " +
      "This usually means your bank isn't enabled for instant payouts. " +
      "Your funds are safe and will arrive automatically on the daily schedule. Contact support if this keeps happening.",
    );
  }
}
