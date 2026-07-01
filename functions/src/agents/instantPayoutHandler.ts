import * as admin from "firebase-admin";
import Stripe from "stripe";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanMidFlow } from "./humanReply";

const db = admin.firestore();

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  return _stripe;
}

/**
 * Entry: caregiver texts PAYOUT (or NLU classifies as INSTANT_PAYOUT). We look up
 * their available balance via Stripe Connect and ask for confirmation. The
 * router calls handleInstantPayoutConfirm for the subsequent YES/NO reply.
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

  // Pull available balance from Stripe Connect
  let availableCents = 0;
  let currency = "usd";
  try {
    const balance = await getStripe().balance.retrieve({ stripeAccount: stripeAccountId });
    const inst = (balance.instant_available ?? balance.available ?? []) as Array<{ amount: number; currency: string }>;
    if (inst.length > 0) {
      availableCents = inst[0].amount;
      currency = inst[0].currency;
    }
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

  if (availableCents <= 0) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "The caregiver has no funds available for an instant payout right now. Warmly let them know, and reassure them their next scheduled payout will arrive on its regular Friday cadence.",
      fallback: "You don't have any funds available for instant payout right now. Your next scheduled payout is on its regular Friday cadence.",
      maxTokens: 80,
    }));
    return;
  }

  const amount = (availableCents / 100).toFixed(2);
  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutConfirm: new Date().toISOString(),
  });
  await sendMessage(chatId,
    `You have $${amount} available for instant payout.\n\n` +
    `Instant payouts arrive within 30 minutes (Stripe charges a 1.5% fee). ` +
    `Send $${amount} to your bank now? Reply YES or NO.`,
  );
  // Stash the balance on the session for the confirm step (saves another balance call)
  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutAmount: String(availableCents),
    pendingInstantPayoutCurrency: currency,
    pendingInstantPayoutStripeAccount: stripeAccountId,
  } as any);
  void currency; // used in confirm step via session
}

export async function handleInstantPayoutConfirm(
  caregiverId: string,
  phone:       string,
  text:        string,
  chatId:      string,
): Promise<void> {
  // isQuestionOrOther guard
  const reAsk = "Send the instant payout? Reply YES or NO.";
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
  const stripeAccountId = sd.pendingInstantPayoutStripeAccount as string | undefined;
  const amountCents = parseInt((sd.pendingInstantPayoutAmount as string) ?? "0", 10);
  const currency = (sd.pendingInstantPayoutCurrency as string) ?? "usd";

  // Clear state regardless of decision
  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutConfirm:       admin.firestore.FieldValue.delete(),
    pendingInstantPayoutAmount:        admin.firestore.FieldValue.delete(),
    pendingInstantPayoutCurrency:      admin.firestore.FieldValue.delete(),
    pendingInstantPayoutStripeAccount: admin.firestore.FieldValue.delete(),
  } as any);

  if (decision !== "YES" || !stripeAccountId || amountCents <= 0) {
    const msg = await generateCaraMessage({
      audience: "caregiver",
      context: "A caregiver decided not to take an instant payout right now. Brief, neutral acknowledgment.",
      fallback: "No problem — your balance stays in your account until the next regular payout.",
      maxTokens: 60,
    });
    await sendMessage(chatId, msg);
    return;
  }

  // Trigger the Stripe instant payout
  try {
    const payout = await getStripe().payouts.create(
      {
        amount: amountCents,
        currency,
        method: "instant",
        description: "Instant payout requested via Cara SMS",
      },
      { stripeAccount: stripeAccountId },
    );
    await db.collection("instant_payouts").add({
      caregiverId,
      phone,
      stripeAccountId,
      stripePayoutId: payout.id,
      amountCents,
      currency,
      requestedAt: new Date().toISOString(),
      source: "cara_sms",
    });
    const amountStr = `$${(amountCents / 100).toFixed(2)}`;
    await sendMessage(chatId,
      `Done — $${(amountCents / 100).toFixed(2)} is on the way to your bank. ` +
      `Instant payouts typically arrive within 30 minutes.`,
    );
    void amountStr;
  } catch (err) {
    console.error("[instantPayout] payouts.create failed:", err);
    await sendMessage(chatId,
      "I wasn't able to process that instant payout — Stripe rejected it. " +
      "This usually means your bank isn't enabled for instant payouts. " +
      "Your funds are safe and will arrive on the regular schedule. Contact support if this keeps happening.",
    );
  }
}
