import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Payments page's Payouts tab, texted (caregiverPayouts.ts): the
// page's reads (Connect flags, the LIVE Stripe balance, approved-not-yet-charged
// timesheets, the payouts ledger), its four cards, and the keywords.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  sessionWrites: [] as any[],
  payFields: {} as Record<string, unknown>,
  balance: { instantAvailableCents: 4950, pendingCents: 0 } as any,
  balanceThrows: false,
  linkResult: { success: true, linkType: "caregiver_payouts", sent: true } as any,
  startInstant: vi.fn(async () => ({ started: true })),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (prefix: string, filters: Array<[string, any]>): any => ({
        where: (f: string, _op: string, v: any) => q(prefix, [...filters, [f, v]]),
        orderBy: () => q(prefix, filters), limit: () => q(prefix, filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${prefix}/`) && p.split("/").length === prefix.split("/").length + 1 && filters.every(([f, v]) => d[f] === v))
            .map(([p, d]) => ({ id: p.split("/").pop(), data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, _op: string, v: any) => q(name, [[f, v]]),
        doc: (id: string) => ({
          get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
          set: vi.fn(async (d: any) => { hoisted.sessionWrites.push(d); }),
          update: vi.fn(async (d: any) => { hoisted.sessionWrites.push(d); }),
          collection: (sub: string) => q(`${name}/${id}/${sub}`, []),
        }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../caregiverPrivate", () => ({ getCaregiverPayoutFields: vi.fn(async () => hoisted.payFields) }));
vi.mock("../../payoutCommon", () => ({ readInstantBalance: vi.fn(async () => { if (hoisted.balanceThrows) throw new Error("stripe down"); return hoisted.balance; }) }));
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: vi.fn(async () => hoisted.linkResult) }));
vi.mock("../instantPayoutHandler", () => ({ startInstantPayout: (...a: any[]) => (hoisted.startInstant as any)(...a) }));

import { loadPayoutsTab, payoutsTabText, payoutRowLine, sendCaregiverPayouts, handlePayoutsKeyword, EMPTY_HISTORY, FOOTNOTE } from "../caregiverPayouts";

const enabled = () => { hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true, chargesEnabled: true }; };
const payout = (id: string, over: Record<string, unknown> = {}) => hoisted.docs.set(`caregivers/cg1/payouts/${id}`, { amount: 49.5, grossAmount: 50, fee: 0.5, type: "instant", status: "paid", createdAt: "2026-09-18T21:15:00.000Z", arrivalDate: "2026-09-18T21:45:00.000Z", ...over });

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.sessionWrites.length = 0;
  hoisted.payFields = {}; hoisted.balance = { instantAvailableCents: 4950, pendingCents: 0 }; hoisted.balanceThrows = false;
  hoisted.linkResult = { success: true, linkType: "caregiver_payouts", sent: true }; hoisted.startInstant.mockClear();
  hoisted.docs.set("caregivers/cg1", { name: "Mahad" });
  hoisted.docs.set("agent_sessions/+1", { caregiverId: "cg1" });
});

describe("the reads", () => {
  it("fullyEnabled = payouts AND charges enabled; the live balance is read only with an account; approved-not-yet-charged sums credit approved rows", async () => {
    enabled();
    hoisted.docs.set("shiftHours/a", { caregiverId: "cg1", paymentMethod: "credit", status: "approved", grossPay: 77.02 });
    hoisted.docs.set("shiftHours/b", { caregiverId: "cg1", paymentMethod: "credit", status: "auto_approved", finalTotalHours: 2, payRate: 25 });
    hoisted.docs.set("shiftHours/c", { caregiverId: "cg1", paymentMethod: "credit", status: "paid", grossPay: 100 });
    hoisted.docs.set("shiftHours/d", { caregiverId: "cg1", paymentMethod: "credit", status: "pending_client_review", grossPay: 100 });
    payout("p1");
    const tab = await loadPayoutsTab("cg1");
    expect(tab.fullyEnabled).toBe(true);
    expect(tab.balance).toEqual({ instantAvailableCents: 4950, pendingCents: 0 });
    expect(tab.approvedAwaitingChargeCents).toBe(12702);
    expect(tab.history.map((p) => p.id)).toEqual(["p1"]);
    hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true }; // charges not enabled → the page's "Setup incomplete"
    expect((await loadPayoutsTab("cg1")).fullyEnabled).toBe(false);
    hoisted.payFields = {};
    expect((await loadPayoutsTab("cg1")).balance).toBeNull();
  });
});

describe("the cards", () => {
  it("connected + balance: hero amount from Stripe, settling + approved lines, CASH OUT with the fee, the page's footnote, bank card, schedule, history row", async () => {
    enabled(); hoisted.balance = { instantAvailableCents: 4950, pendingCents: 2000 };
    hoisted.docs.set("shiftHours/a", { caregiverId: "cg1", paymentMethod: "credit", status: "approved", grossPay: 77.02 });
    payout("p1");
    const t = payoutsTabText(await loadPayoutsTab("cg1")).text;
    expect(t).toContain("Payments · Payouts\n\nAvailable to Cash Out $49.50\n$20.00 is still settling — it pays out automatically, no action needed.\n$77.02 approved — added to your balance once the family's card is charged.\nReply CASH OUT to get $49.00 in about 30 minutes (after Stripe's $0.50 instant fee).");
    expect(t).toContain(FOOTNOTE);
    expect(t).toContain("Bank account (Stripe): Bank account connected. Earnings pay out automatically every day and arrive ~2 business days after each visit is paid (free). Instant payouts arrive in about 30 minutes and carry Stripe's 1% fee (minimum $0.50).");
    expect(t).toContain("Payout schedule: Automatic — daily, ~2 business days, free · Instant — ~30 minutes, Stripe's 1% fee (min $0.50)");
    expect(t).toContain("Payout history\n1. Instant payout · Paid · Sep 18 · arrives Sep 18 · fee $0.50 · $49.50");
    expect(t).not.toMatch(/instant payouts? (is|are) free/i);
  });
  it("connected, under $1: the page's 'nothing to cash out' line; not connected: SETUP; setup incomplete: SETUP; Stripe unreachable", async () => {
    enabled(); hoisted.balance = { instantAvailableCents: 40, pendingCents: 0 };
    expect(payoutsTabText(await loadPayoutsTab("cg1")).text).toContain("Available to Cash Out $0.40\nNothing to cash out right now — your earnings pay out automatically every day.");
    hoisted.payFields = {};
    let t = payoutsTabText(await loadPayoutsTab("cg1")).text;
    expect(t).toContain("Available to Cash Out $0.00\nConnect a bank to unlock payouts — reply SETUP for your Stripe link.");
    expect(t).toContain("Bank account (Stripe): Not connected — connect a bank account to receive payouts from credit-card bookings. Reply SETUP for your Stripe link.");
    expect(t).toContain(EMPTY_HISTORY);
    hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: false, chargesEnabled: false };
    t = payoutsTabText(await loadPayoutsTab("cg1")).text;
    expect(t).toContain("Bank account (Stripe): Setup incomplete — Stripe needs more information. Finish the onboarding to start receiving payouts. Reply SETUP for your Stripe link.");
    enabled(); hoisted.balanceThrows = true;
    expect(payoutsTabText(await loadPayoutsTab("cg1")).text).toContain("Available to Cash Out — couldn't reach Stripe right now");
  });
  it("history pages 5 at a time with MORE; automatic rows carry no fee; statuses use the page's labels", async () => {
    enabled();
    for (let i = 1; i <= 7; i++) payout(`p${i}`, { type: i % 2 ? "automatic" : "instant", fee: i % 2 ? 0 : 0.5, status: i === 7 ? "in_transit" : "paid", createdAt: `2026-09-${String(10 + i).padStart(2, "0")}T21:00:00.000Z`, amount: 10 * i });
    const tab = await loadPayoutsTab("cg1");
    const p1 = payoutsTabText(tab);
    expect(p1.shown).toBe(5); expect(p1.remaining).toBe(2);
    expect(p1.text).toContain("Reply MORE for 2 older.");
    expect(payoutRowLine(1, tab.history[0])).toBe("1. Automatic payout · In transit · Sep 17 · arrives Sep 18 · $70.00");
    expect(payoutsTabText(tab, 5).shown).toBe(2);
  });
  it("sends the tab and stores the list offset; MORE continues it", async () => {
    enabled(); for (let i = 1; i <= 6; i++) payout(`p${i}`, { createdAt: `2026-09-${String(10 + i).padStart(2, "0")}T21:00:00.000Z` });
    const r = await sendCaregiverPayouts("+1", "chat", "cg1");
    expect(r.remaining).toBe(1);
    expect(hoisted.sessionWrites.at(-1).lastPayoutList.offset).toBe(5);
    hoisted.docs.set("agent_sessions/+1", { caregiverId: "cg1", lastPayoutList: { at: "2026-09-18T00:00:00.000Z", offset: 5 } });
    const r2 = await sendCaregiverPayouts("+1", "chat", "cg1", { more: true });
    expect(r2.remaining).toBe(0);
    expect(hoisted.sent.at(-1)).toContain("6. ");
  });
});

describe("keywords", () => {
  it("PAYOUTS / PAYOUT HISTORY text the tab; CASH OUT starts the modal flow; SETUP sends the Stripe link; MORE only when the Payouts list is the latest", async () => {
    enabled();
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "payouts", { caregiverId: "cg1" })).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Payments · Payouts");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "CASH OUT", { caregiverId: "cg1" })).toBe("handled");
    expect(hoisted.startInstant).toHaveBeenCalledWith("cg1", "+1", "chat");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "setup", { caregiverId: "cg1" })).toBe("handled");
    hoisted.linkResult = { success: true, linkType: "caregiver_payouts", sent: false, throttled: true, minutesSinceLastSend: 3 };
    await handlePayoutsKeyword("+1", "chat", "cg1", "SETUP", { caregiverId: "cg1" });
    expect(hoisted.sent.at(-1)).toBe("Your Stripe setup link went out about 3 minutes ago — tap that one, or reply LINK and I'll resend it.");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "MORE", { lastPayoutList: { at: "2026-09-18T00:00:00.000Z" }, lastTimesheetList: { at: "2026-09-19T00:00:00.000Z" } })).toBe("passthrough");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "MORE", { lastPayoutList: { at: "2026-09-19T00:00:00.000Z" }, lastTimesheetList: { at: "2026-09-18T00:00:00.000Z" } })).toBe("handled");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "hello", {})).toBe("passthrough");
  });
});
