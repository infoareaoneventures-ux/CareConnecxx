// The caregiver Payments page › Payouts tab, texted
// (components/caregiver/CaregiverPaymentsPage.tsx `tab === 'payouts'`).
//
// Founder decision 2026-10-02 ("option C"): the tab is three cards — what can be
// cashed out right now (the LIVE Stripe balance, the same read the page's hero and
// Cash Out use), the bank account state with a SIGNED-IN "Manage in Stripe" link,
// and how you get paid. Payout history, bank details and tax forms live in the
// caregiver's own Stripe dashboard (Stripe owns that record; our copy could only
// drift from it), so there is no history card here and no tax summary anywhere.
// Cash Out = the Instant Payout modal as a flow (agents/instantPayoutHandler.ts)
// through the one payout implementation (payoutCommon.executeInstantPayout).
// Setup Payouts = the Stripe onboarding link (send_onboarding_link caregiver_payouts).
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { instantPayoutFeeCentsFor } from "../billing/shiftBillingAmounts";

const db = admin.firestore();

export interface PayoutsTab {
  hasAccount: boolean;
  fullyEnabled: boolean;            // payoutsEnabled && chargesEnabled — the page's rule
  balance: { instantAvailableCents: number; pendingCents: number } | null; // null = Stripe unreachable (or no account)
  approvedAwaitingChargeCents: number;
}

export const FOOTNOTE = "Earnings pay out automatically every day (free) · Instant cash-out: Stripe's 1% fee (min $0.50), ~30 min";
export const HOW_YOU_GET_PAID = "How you get paid: Automatic — every day, free, lands in ~2 business days · Instant — ~30 minutes, Stripe's 1% fee (min $0.50)";
export const STRIPE_DASHBOARD_LINE = "Payout history, your bank account and tax forms are in your Stripe dashboard — reply MANAGE for a signed-in link.";

const money = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;

export async function loadPayoutsTab(caregiverId: string): Promise<PayoutsTab> {
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
  const pay = await getCaregiverPayoutFields(caregiverId, cg);
  const hasAccount = !!pay.stripeAccountId;
  const fullyEnabled = pay.payoutsEnabled === true && pay.chargesEnabled === true;

  // The page fetches the live balance only once setup is fully complete
  // (tab === 'payouts' && fullyEnabled) — same here, so a setup-incomplete
  // account never gets a "still settling" line the page would not show.
  const [balance, hoursSnap] = await Promise.all([
    fullyEnabled
      ? import("../payoutCommon").then((m) => m.readInstantBalance(String(pay.stripeAccountId))).catch(() => null)
      : Promise.resolve(null),
    db.collection("shiftHours").where("caregiverId", "==", caregiverId).get(),
  ]);
  // The page's "approved, not yet charged" sum: credit rows approved / auto_approved, grossPay first.
  const approvedAwaitingChargeCents = hoursSnap.docs.reduce((sum, d) => {
    const r = d.data() as Record<string, unknown>;
    if (r.paymentMethod !== "credit" || (r.status !== "approved" && r.status !== "auto_approved")) return sum;
    const hours = Number(r.finalTotalHours ?? r.submittedTotalHours ?? 0) || 0;
    const pay = typeof r.grossPay === "number" ? r.grossPay : hours * (Number(r.payRate) || 0);
    return sum + Math.round(pay * 100);
  }, 0);
  return { hasAccount, fullyEnabled, balance, approvedAwaitingChargeCents };
}

export function payoutsTabText(tab: PayoutsTab): string {
  const lines: string[] = ["Payments · Payouts", ""];
  // ── Available to Cash Out (hero) ──
  const avail = tab.balance?.instantAvailableCents ?? 0;
  lines.push(`Available to Cash Out ${tab.fullyEnabled && tab.balance === null ? "— couldn't reach Stripe right now" : money(tab.fullyEnabled ? avail : 0)}`);
  if (tab.balance && tab.balance.pendingCents > 0) lines.push(`${money(tab.balance.pendingCents)} is still settling — it pays out automatically, no action needed.`);
  if (tab.approvedAwaitingChargeCents > 0) lines.push(`${money(tab.approvedAwaitingChargeCents)} approved — added to your balance once the family's card is charged.`);
  if (tab.fullyEnabled && avail >= 100) {
    const fee = instantPayoutFeeCentsFor(avail);
    lines.push(`Reply CASH OUT to get ${money(avail - fee)} in about 30 minutes (after Stripe's ${money(fee)} instant fee).`);
  } else if (!tab.fullyEnabled) lines.push("Connect a bank to unlock payouts — reply SETUP for your Stripe link.");
  else lines.push("Nothing to cash out right now — your earnings pay out automatically every day.");
  lines.push(FOOTNOTE, "");
  // ── Bank account (Stripe) ──
  if (tab.fullyEnabled) lines.push("Bank account (Stripe): Bank account connected.", STRIPE_DASHBOARD_LINE);
  else if (tab.hasAccount) lines.push("Bank account (Stripe): Setup incomplete — Stripe needs more information. Finish the onboarding to start receiving payouts. Reply SETUP for your Stripe link.");
  else lines.push("Bank account (Stripe): Not connected — connect a bank account to receive payouts from credit-card bookings. Reply SETUP for your Stripe link.");
  lines.push("", HOW_YOU_GET_PAID);
  return lines.join("\n");
}

export async function sendCaregiverPayouts(_phone: string, chatId: string, caregiverId: string) {
  const tab = await loadPayoutsTab(caregiverId);
  await sendMessage(chatId, payoutsTabText(tab));
  return { sent: true, fullyEnabled: tab.fullyEnabled, hasAccount: tab.hasAccount, instantAvailableCents: tab.balance?.instantAvailableCents ?? 0, pendingCents: tab.balance?.pendingCents ?? 0, approvedAwaitingChargeCents: tab.approvedAwaitingChargeCents };
}

/** The Setup Payouts button: the Stripe Connect onboarding link, texted (same action as send_onboarding_link caregiver_payouts). */
export async function sendPayoutSetupLink(phone: string, chatId: string): Promise<boolean> {
  try {
    const { runSendOnboardingLinkAction } = await import("./actions/sendOnboardingLinkAction");
    const r = await runSendOnboardingLinkAction({ phone, linkType: "caregiver_payouts" }, { caller: "sms_agent", role: "caregiver", phone });
    if (r.sent) return true;
    if (r.throttled) { await sendMessage(chatId, `Your Stripe setup link went out about ${r.minutesSinceLastSend ?? "a few"} minutes ago — tap that one, or reply LINK and I'll resend it.`); return false; }
  } catch (err) { console.error("[caregiverPayouts] setup link failed:", err); }
  await sendMessage(chatId, "I couldn't generate your Stripe setup link right now — reply SETUP again in a moment.");
  return false;
}

/** The "Manage in Stripe" button: a one-time, signed-in link to the caregiver's own Stripe Express dashboard. */
export async function sendStripeDashboardLink(phone: string, chatId: string, caregiverId: string): Promise<boolean> {
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
  const pay = await getCaregiverPayoutFields(caregiverId, (cgSnap.data() ?? {}) as Record<string, unknown>);
  if (!pay.stripeAccountId) { await sendMessage(chatId, "Your payout account isn't set up yet — reply SETUP for your Stripe link."); return false; }
  try {
    const { getStripeClient } = await import("../stripe");
    const stripe = getStripeClient();
    try {
      const link = await stripe.accounts.createLoginLink(String(pay.stripeAccountId));
      await sendMessage(chatId, `Your Stripe dashboard (payout history, bank account, tax forms) — this link signs you in and works once: ${link.url}`);
      return true;
    } catch (err) {
      // Same fallback as the page's Manage in Stripe (instantPayout.getPayoutBalance):
      // Stripe says the account never finished onboarding → make the record honest and
      // hand over the Setup link instead of a failure.
      const { isConnectOnboardingIncompleteError, syncConnectAccountStatus } = await import("../connectAccount");
      if (!isConnectOnboardingIncompleteError(err)) throw err;
      await syncConnectAccountStatus(stripe, String(pay.stripeAccountId), caregiverId)
        .catch((e) => console.error("[caregiverPayouts] status sync failed:", e));
      await sendMessage(chatId, "Stripe still needs a few details before your dashboard opens — finish your payout setup first:");
      return sendPayoutSetupLink(phone, chatId);
    }
  } catch (err) {
    console.error("[caregiverPayouts] login link failed:", err);
    await sendMessage(chatId, "I couldn't open your Stripe dashboard right now — try MANAGE again in a moment.");
    return false;
  }
}

// ── Keywords (routeCaregiver): PAYOUTS · BALANCE · CASH OUT · SETUP · MANAGE ──
export async function handlePayoutsKeyword(phone: string, chatId: string, caregiverId: string, text: string, _session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase();
  if (upper === "PAYOUTS" || upper === "MY PAYOUTS" || upper === "BALANCE" || upper === "MY BALANCE") { await sendCaregiverPayouts(phone, chatId, caregiverId); return "handled"; }
  if (upper === "PAYOUT HISTORY" || upper === "MANAGE" || upper === "MANAGE PAYOUTS" || upper === "STRIPE") { await sendStripeDashboardLink(phone, chatId, caregiverId); return "handled"; }
  if (upper === "CASH OUT" || upper === "CASHOUT" || upper === "CASH OUT NOW") {
    const { startInstantPayout } = await import("./instantPayoutHandler");
    await startInstantPayout(caregiverId, phone, chatId); return "handled";
  }
  if (upper === "SETUP" || upper === "SETUP PAYOUTS" || upper === "CONNECT BANK") { await sendPayoutSetupLink(phone, chatId); return "handled"; }
  return "passthrough";
}
