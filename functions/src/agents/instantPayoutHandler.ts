// The Payouts tab's Cash Out button + Instant Payout modal as a scripted flow
// (components/caregiver/CaregiverPaymentsPage.tsx handleOpenPayoutModal,
// components/caregiver/InstantPayoutModal.tsx).
//
// Same preconditions as the page, in the page's order: a connected, fully
// enabled Stripe account (payoutsEnabled && chargesEnabled — else the Setup
// Payouts link), then the LIVE instantly-available balance (the page's
// getPayoutBalance; under $1 → the page's two info toasts), then the modal's
// lines (Available Now / Stripe instant fee / You'll Receive / arrives in ~30
// minutes / no rush), then "Cash Out Now" → CASH OUT. The payout itself is the
// ONE implementation every door uses (payoutCommon.executeInstantPayout), and
// the confirmation texts are the page's own toasts. Plain fixed sentences —
// no model wording (rewritten 2026-10-01; the old version generated most of
// its texts, said "open the caregiver app", and blamed the bank for a setup
// problem).
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { isBackOutRequest, isQuestionOrOther, answerMidFlow } from "./stepHandler";
import { executeInstantPayout, InstantPayoutError, readInstantBalance } from "../payoutCommon";
import { instantPayoutFeeCentsFor } from "../billing/shiftBillingAmounts";

const db = admin.firestore();
const money = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;
const DIDNT_CATCH = "Sorry, I didn't quite catch that.";

export const NOT_SET_UP = "Your payout account isn't set up yet. Connect a bank account to receive payouts from credit-card bookings — here's your Stripe setup link.";
export const SETUP_INCOMPLETE = "Setup incomplete — Stripe needs more information. Finish the onboarding to start receiving payouts — here's your Stripe link.";
export const BALANCE_UNAVAILABLE = "I couldn't pull your balance right now. Reply CASH OUT again in a few minutes.";
export const NOTHING_TO_CASH_OUT = "Nothing to cash out right now — your earnings pay out automatically every day.";
export const settlingText = (pendingCents: number) => `${money(pendingCents)} is still settling — it pays out automatically, no action needed.`;
export const HOLD_OFF = "No problem — your earnings still pay out automatically on the daily schedule.";

/** The Instant Payout modal, as one text. */
export function cashOutModalText(availableCents: number): string {
  const fee = instantPayoutFeeCentsFor(availableCents);
  const net = Math.max(0, availableCents - fee);
  return [
    "Cash Out Now — get your earnings in ~30 minutes",
    `Available Now ${money(availableCents)}`,
    `Stripe instant fee (1%, min $0.50) −${money(fee)}`,
    `You'll Receive ${money(net)}`,
    "",
    "Arrives in about 30 minutes — funds will be sent to your connected bank account. No rush? Your earnings pay out automatically every day and land in your bank within ~2 business days.",
    "",
    `Reply CASH OUT to send ${money(net)} now, or CANCEL.`,
  ].join("\n");
}
const REASK = (availableCents: number) => `Reply CASH OUT to send ${money(Math.max(0, availableCents - instantPayoutFeeCentsFor(availableCents)))} now, or CANCEL.`;

/**
 * Entry: CASH OUT / PAYOUT, the agent's request_instant_payout, or the
 * INSTANT_PAYOUT intent. Checks the page's preconditions, texts the modal, and
 * parks the confirmation (pendingInstantPayoutConfirm / pendingInstantPayoutAmount,
 * 10-minute TTL in routeCaregiver).
 */
export async function startInstantPayout(caregiverId: string, phone: string, chatId: string): Promise<{ started: boolean; reason?: string }> {
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = cgSnap.data();
  if (!cg) { await sendMessage(chatId, "I couldn't find your caregiver profile. Send the email you used to sign up and I'll try again."); return { started: false, reason: "not_found" }; }
  const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
  const pay = await getCaregiverPayoutFields(caregiverId, cg);
  const stripeAccountId = pay.stripeAccountId as string | undefined;
  if (!stripeAccountId || !(pay.payoutsEnabled === true && pay.chargesEnabled === true)) {
    // The page swaps Cash Out for Setup Payouts: say which state, send the Stripe link (same action as the button).
    await sendMessage(chatId, stripeAccountId ? SETUP_INCOMPLETE : NOT_SET_UP);
    const { sendPayoutSetupLink } = await import("./caregiverPayouts");
    await sendPayoutSetupLink(phone, chatId);
    return { started: false, reason: stripeAccountId ? "setup_incomplete" : "no_account" };
  }

  let balance: { instantAvailableCents: number; pendingCents: number };
  try { balance = await readInstantBalance(stripeAccountId); }
  catch (err) { console.error("[instantPayout] balance retrieve failed:", err); await sendMessage(chatId, BALANCE_UNAVAILABLE); return { started: false, reason: "balance_unavailable" }; }

  if (balance.instantAvailableCents < 100) {
    // The page's handleOpenPayoutModal info toasts.
    await sendMessage(chatId, balance.pendingCents > 0 ? settlingText(balance.pendingCents) : NOTHING_TO_CASH_OUT);
    return { started: false, reason: "no_balance" };
  }

  await db.collection("agent_sessions").doc(phone).update({
    pendingInstantPayoutConfirm: new Date().toISOString(),
    pendingInstantPayoutAmount: String(balance.instantAvailableCents),
  } as Record<string, unknown>);
  await sendMessage(chatId, cashOutModalText(balance.instantAvailableCents));
  return { started: true };
}

/** The modal's two buttons: "Cash Out Now" → CASH OUT; Cancel → CANCEL. */
export async function handleInstantPayoutConfirm(caregiverId: string, phone: string, text: string, chatId: string): Promise<void> {
  const ref = db.collection("agent_sessions").doc(phone);
  const sd = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  const previewCents = parseInt(String(sd.pendingInstantPayoutAmount ?? "0"), 10) || 0;
  const q = REASK(previewCents);
  const norm = text.trim().toUpperCase().replace(/\s+/g, " ");

  let action: "send" | "cancel" | "other";
  if (norm === "CASH OUT" || norm === "CASHOUT" || norm === "CASH OUT NOW" || norm === "YES" || norm === "SEND" || norm === "CONFIRM") action = "send";
  else if (norm === "CANCEL" || norm === "NO" || norm === "WAIT" || norm === "NOT YET") action = "cancel";
  else if (await isBackOutRequest(text, q)) action = "cancel";
  else if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; } // confirmation stays parked
  else {
    const v = await quickComplete("Evia asked the caregiver to reply CASH OUT to send an instant payout, or CANCEL. Classify: SEND (go ahead), CANCEL (hold off), or OTHER.\nReply with ONLY the word.", text, { maxTokens: 5 }).catch(() => "OTHER");
    action = v.toUpperCase().startsWith("SEND") ? "send" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
  }
  if (action === "other") { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }

  // Decision made — clear the parked confirmation either way.
  await ref.update({ pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(), pendingInstantPayoutAmount: admin.firestore.FieldValue.delete() } as Record<string, unknown>);
  if (action === "cancel" || previewCents <= 0) { await sendMessage(chatId, HOLD_OFF); return; }

  // The page pays the CURRENT instant balance (the modal has no amount input); so do we.
  try {
    const result = await executeInstantPayout({ caregiverId, source: "cara_sms" });
    // The page's success toast.
    await sendMessage(chatId, `Instant payout of ${money(result.amountCents)} initiated (after Stripe's ${money(result.feeCents)} instant fee) — arrives in ~30 minutes!`);
  } catch (err) {
    if (err instanceof InstantPayoutError) {
      if (err.code === "DUPLICATE") { await sendMessage(chatId, "Looks like that payout was already sent a moment ago — it's on its way to your bank."); return; }
      if (err.code === "NO_BALANCE") { await sendMessage(chatId, "Your balance was just paid out automatically, so there's nothing left to send right now. It'll land in your bank within about 2 business days."); return; }
      await sendMessage(chatId, err.message); // the server's own reason — the page shows error.message
      return;
    }
    console.error("[instantPayout] executeInstantPayout failed:", err);
    await sendMessage(chatId, "Payout failed. Please try again."); // the page's default error toast
  }
}
