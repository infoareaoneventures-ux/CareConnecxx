// The caregiver Payments page › Payouts tab, texted
// (components/caregiver/CaregiverPaymentsPage.tsx `tab === 'payouts'`,
// components/caregiver/PayoutHistory.tsx).
//
// Same reads as the page: the Stripe Connect flags (caregivers/{id}/private/payout,
// parent fallback), the LIVE instantly-available + pending balance from Stripe (what
// Cash Out actually pays — the same read the page's hero and Cash Out use), the
// approved-but-not-yet-charged timesheets, and the caregivers/{id}/payouts ledger
// the page's Payout history lists. Same four cards, same sentences. Cash Out = the
// Instant Payout modal as a flow (agents/instantPayoutHandler.ts) through the one
// payout implementation (payoutCommon.executeInstantPayout). Setup Payouts = the
// Stripe link (send_onboarding_link caregiver_payouts).
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { DEFAULT_TZ } from "../utils/scheduledTime";
import { instantPayoutFeeCentsFor } from "../billing/shiftBillingAmounts";

const db = admin.firestore();
const HISTORY_PAGE = 5;
const HISTORY_LIMIT = 25; // the page's query limit

export interface PayoutRow { id: string; amount: number; grossAmount?: number; fee: number; type: string; status: string; createdAt?: string; arrivalDate?: string | null }
export interface PayoutsTab {
  hasAccount: boolean;
  fullyEnabled: boolean;            // payoutsEnabled && chargesEnabled — the page's rule
  balance: { instantAvailableCents: number; pendingCents: number } | null; // null = Stripe unreachable (or no account)
  approvedAwaitingChargeCents: number;
  history: PayoutRow[];
}

/** The page's PayoutHistory status labels (shared with components/caregiver/PayoutHistory.tsx). */
export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  pending: "Pending", in_transit: "In transit", paid: "Paid", failed: "Failed", canceled: "Canceled",
};
export const EMPTY_HISTORY = "No payouts yet. Payouts will appear here as they're sent — automatic daily payouts and any instant cash-outs.";
export const FOOTNOTE = "Earnings pay out automatically every day (free) · Instant cash-out: Stripe's 1% fee (min $0.50), ~30 min";

const money = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;
const moneyD = (dollars: number) => `$${(Math.round(dollars * 100) / 100).toFixed(2)}`;
const shortDate = (iso: string | null | undefined) => {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric" }) : null;
};

export async function loadPayoutsTab(caregiverId: string): Promise<PayoutsTab> {
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
  const pay = await getCaregiverPayoutFields(caregiverId, cg);
  const hasAccount = !!pay.stripeAccountId;
  const fullyEnabled = pay.payoutsEnabled === true && pay.chargesEnabled === true;

  const [balance, hoursSnap, ledgerSnap] = await Promise.all([
    hasAccount
      ? import("../payoutCommon").then((m) => m.readInstantBalance(String(pay.stripeAccountId))).catch(() => null)
      : Promise.resolve(null),
    db.collection("shiftHours").where("caregiverId", "==", caregiverId).get(),
    db.collection("caregivers").doc(caregiverId).collection("payouts").orderBy("createdAt", "desc").limit(HISTORY_LIMIT).get(),
  ]);
  // The page's "approved, not yet charged" sum: credit rows approved / auto_approved, grossPay first.
  const approvedAwaitingChargeCents = hoursSnap.docs.reduce((sum, d) => {
    const r = d.data() as Record<string, unknown>;
    if (r.paymentMethod !== "credit" || (r.status !== "approved" && r.status !== "auto_approved")) return sum;
    const hours = Number(r.finalTotalHours ?? r.submittedTotalHours ?? 0) || 0;
    const pay = typeof r.grossPay === "number" ? r.grossPay : hours * (Number(r.payRate) || 0);
    return sum + Math.round(pay * 100);
  }, 0);
  const history: PayoutRow[] = ledgerSnap.docs.map((d) => {
    const p = d.data() as Record<string, unknown>;
    return { id: d.id, amount: Number(p.amount) || 0, grossAmount: typeof p.grossAmount === "number" ? p.grossAmount : undefined, fee: Number(p.fee) || 0, type: String(p.type ?? "automatic"), status: String(p.status ?? "pending"), createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined, arrivalDate: typeof p.arrivalDate === "string" ? p.arrivalDate : null };
  });
  history.sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0)); // the page's orderBy createdAt desc
  return { hasAccount, fullyEnabled, balance, approvedAwaitingChargeCents, history };
}

/** One Payout history row, the page's line: "Instant payout · Paid · Sep 18 · arrives Sep 18 · fee $0.50 · $49.00". */
export function payoutRowLine(n: number, p: PayoutRow): string {
  const type = p.type.charAt(0).toUpperCase() + p.type.slice(1);
  const bits = [`${type} payout`, PAYOUT_STATUS_LABEL[p.status] ?? p.status, shortDate(p.createdAt) ?? "—"];
  const arr = shortDate(p.arrivalDate); if (arr) bits.push(`arrives ${arr}`);
  if (p.fee > 0) bits.push(`fee ${moneyD(p.fee)}`);
  bits.push(moneyD(p.amount));
  return `${n}. ${bits.join(" · ")}`;
}

export function payoutsTabText(tab: PayoutsTab, from = 0): { text: string; shown: number; remaining: number } {
  const lines: string[] = ["Payments · Payouts", ""];
  // ── Hero ──
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
  if (tab.fullyEnabled) lines.push("Bank account (Stripe): Bank account connected. Earnings pay out automatically every day and arrive ~2 business days after each visit is paid (free). Instant payouts arrive in about 30 minutes and carry Stripe's 1% fee (minimum $0.50).");
  else if (tab.hasAccount) lines.push("Bank account (Stripe): Setup incomplete — Stripe needs more information. Finish the onboarding to start receiving payouts. Reply SETUP for your Stripe link.");
  else lines.push("Bank account (Stripe): Not connected — connect a bank account to receive payouts from credit-card bookings. Reply SETUP for your Stripe link.");
  lines.push("", "Payout schedule: Automatic — daily, ~2 business days, free · Instant — ~30 minutes, Stripe's 1% fee (min $0.50)", "");
  // ── Payout history ──
  lines.push("Payout history");
  if (tab.history.length === 0) { lines.push(EMPTY_HISTORY); return { text: lines.join("\n"), shown: 0, remaining: 0 }; }
  const page = tab.history.slice(from, from + HISTORY_PAGE);
  page.forEach((p, i) => lines.push(payoutRowLine(from + i + 1, p)));
  const remaining = Math.max(0, tab.history.length - (from + page.length));
  if (remaining > 0) lines.push(`Reply MORE for ${remaining} older.`);
  return { text: lines.join("\n"), shown: page.length, remaining };
}

export async function sendCaregiverPayouts(phone: string, chatId: string, caregiverId: string, opts: { more?: boolean } = {}) {
  const tab = await loadPayoutsTab(caregiverId);
  let from = 0;
  if (opts.more) {
    const s = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    from = Number((s?.data()?.lastPayoutList as { offset?: number } | undefined)?.offset ?? 0);
  }
  const r = payoutsTabText(tab, from);
  await sendMessage(chatId, r.text);
  await db.collection("agent_sessions").doc(phone).set({ lastPayoutList: { at: new Date().toISOString(), offset: from + r.shown, total: tab.history.length } }, { merge: true }).catch(() => {});
  return { sent: true, fullyEnabled: tab.fullyEnabled, instantAvailableCents: tab.balance?.instantAvailableCents ?? 0, pendingCents: tab.balance?.pendingCents ?? 0, approvedAwaitingChargeCents: tab.approvedAwaitingChargeCents, historyCount: tab.history.length, remaining: r.remaining };
}

/** The Setup Payouts button: the Stripe Connect link, texted (same action as send_onboarding_link caregiver_payouts). */
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

/** The Payouts list owns MORE only while it is the most recent numbered list texted. */
function payoutListIsLatest(session: Record<string, unknown>): boolean {
  const mine = Date.parse(String((session.lastPayoutList as { at?: string } | undefined)?.at ?? "")) || 0;
  if (!mine) return false;
  for (const k of ["lastPastBookingList", "lastCalendarList", "lastFamilyList", "lastActiveBookingList", "lastBookingRequestList", "lastTimesheetList"]) {
    const other = Date.parse(String((session[k] as { at?: string } | undefined)?.at ?? "")) || 0;
    if (other > mine) return false;
  }
  return true;
}

// ── Keywords (routeCaregiver): PAYOUTS · PAYOUT HISTORY · CASH OUT · SETUP · MORE ──
export async function handlePayoutsKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase();
  if (upper === "PAYOUTS" || upper === "MY PAYOUTS" || upper === "PAYOUT HISTORY" || upper === "BALANCE" || upper === "MY BALANCE") { await sendCaregiverPayouts(phone, chatId, caregiverId); return "handled"; }
  if (upper === "MORE" && payoutListIsLatest(session)) { await sendCaregiverPayouts(phone, chatId, caregiverId, { more: true }); return "handled"; }
  if (upper === "CASH OUT" || upper === "CASHOUT" || upper === "CASH OUT NOW") {
    const { startInstantPayout } = await import("./instantPayoutHandler");
    await startInstantPayout(caregiverId, phone, chatId); return "handled";
  }
  if (upper === "SETUP" || upper === "SETUP PAYOUTS" || upper === "CONNECT BANK") { await sendPayoutSetupLink(phone, chatId); return "handled"; }
  return "passthrough";
}
