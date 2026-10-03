import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Payments page's Payouts tab, texted (caregiverPayouts.ts): the
// page's reads (Connect flags, the LIVE Stripe balance, approved-not-yet-charged
// timesheets), its three cards (founder "option C", 2026-10-02), and the keywords.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  payFields: {} as Record<string, unknown>,
  balance: { instantAvailableCents: 4950, pendingCents: 0 } as any,
  balanceThrows: false,
  linkResult: { success: true, linkType: "caregiver_payouts", sent: true } as any,
  startInstant: vi.fn(async () => ({ started: true })),
  loginLink: vi.fn(async (acct: string) => ({ url: `https://connect.stripe.com/express/${acct}/login` })),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, any]>): any => ({
        where: (f: string, _op: string, v: any) => q([...filters, [f, v]]),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, v]) => d[f] === v)).map(([p, d]) => ({ id: p.split("/").pop(), data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, _op: string, v: any) => q([[f, v]]),
        doc: (id: string) => ({ get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })) }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../caregiverPrivate", () => ({ getCaregiverPayoutFields: vi.fn(async () => hoisted.payFields) }));
vi.mock("../../payoutCommon", () => ({ readInstantBalance: vi.fn(async () => { if (hoisted.balanceThrows) throw new Error("stripe down"); return hoisted.balance; }) }));
vi.mock("../../stripe", () => ({ getStripeClient: () => ({ accounts: { createLoginLink: (...a: any[]) => (hoisted.loginLink as any)(...a) } }) }));
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: vi.fn(async () => hoisted.linkResult) }));
vi.mock("../instantPayoutHandler", () => ({ startInstantPayout: (...a: any[]) => (hoisted.startInstant as any)(...a) }));

import { loadPayoutsTab, payoutsTabText, sendCaregiverPayouts, handlePayoutsKeyword, FOOTNOTE, HOW_YOU_GET_PAID, STRIPE_DASHBOARD_LINE } from "../caregiverPayouts";

const enabled = () => { hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true, chargesEnabled: true }; };

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0;
  hoisted.payFields = {}; hoisted.balance = { instantAvailableCents: 4950, pendingCents: 0 }; hoisted.balanceThrows = false;
  hoisted.linkResult = { success: true, linkType: "caregiver_payouts", sent: true }; hoisted.startInstant.mockClear(); hoisted.loginLink.mockClear();
  hoisted.docs.set("caregivers/cg1", { name: "Mahad" });
});

describe("the reads", () => {
  it("fullyEnabled = payouts AND charges enabled; the live balance is read only with an account; approved-not-yet-charged sums credit approved rows", async () => {
    enabled();
    hoisted.docs.set("shiftHours/a", { caregiverId: "cg1", paymentMethod: "credit", status: "approved", grossPay: 77.02 });
    hoisted.docs.set("shiftHours/b", { caregiverId: "cg1", paymentMethod: "credit", status: "auto_approved", finalTotalHours: 2, payRate: 25 });
    hoisted.docs.set("shiftHours/c", { caregiverId: "cg1", paymentMethod: "credit", status: "paid", grossPay: 100 });
    hoisted.docs.set("shiftHours/d", { caregiverId: "cg1", paymentMethod: "credit", status: "pending_client_review", grossPay: 100 });
    const tab = await loadPayoutsTab("cg1");
    expect(tab.fullyEnabled).toBe(true);
    expect(tab.balance).toEqual({ instantAvailableCents: 4950, pendingCents: 0 });
    expect(tab.approvedAwaitingChargeCents).toBe(12702);
    hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true }; // charges not enabled → the page's "Setup incomplete"
    expect((await loadPayoutsTab("cg1")).fullyEnabled).toBe(false);
    hoisted.payFields = {};
    expect((await loadPayoutsTab("cg1")).balance).toBeNull();
  });
});

describe("the three cards", () => {
  it("connected + balance: hero from Stripe, settling + approved lines, CASH OUT with the fee, footnote, bank card with the Stripe-dashboard line, how you get paid — no history, no 'free' instant", async () => {
    enabled(); hoisted.balance = { instantAvailableCents: 4950, pendingCents: 2000 };
    hoisted.docs.set("shiftHours/a", { caregiverId: "cg1", paymentMethod: "credit", status: "approved", grossPay: 77.02 });
    const t = payoutsTabText(await loadPayoutsTab("cg1"));
    expect(t).toBe([
      "Payments · Payouts", "",
      "Available to Cash Out $49.50",
      "$20.00 is still settling — it pays out automatically, no action needed.",
      "$77.02 approved — added to your balance once the family's card is charged.",
      "Reply CASH OUT to get $49.00 in about 30 minutes (after Stripe's $0.50 instant fee).",
      FOOTNOTE, "",
      "Bank account (Stripe): Bank account connected.",
      STRIPE_DASHBOARD_LINE, "",
      HOW_YOU_GET_PAID,
    ].join("\n"));
    expect(t).not.toMatch(/history\n\d|Payout history\n/);
    expect(t).not.toMatch(/instant payouts? (is|are) free/i);
  });
  it("connected, under $1: the page's 'nothing to cash out' line; not connected / setup incomplete: SETUP; Stripe unreachable", async () => {
    enabled(); hoisted.balance = { instantAvailableCents: 40, pendingCents: 0 };
    expect(payoutsTabText(await loadPayoutsTab("cg1"))).toContain("Available to Cash Out $0.40\nNothing to cash out right now — your earnings pay out automatically every day.");
    hoisted.payFields = {};
    let t = payoutsTabText(await loadPayoutsTab("cg1"));
    expect(t).toContain("Available to Cash Out $0.00\nConnect a bank to unlock payouts — reply SETUP for your Stripe link.");
    expect(t).toContain("Bank account (Stripe): Not connected — connect a bank account to receive payouts from credit-card bookings. Reply SETUP for your Stripe link.");
    hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: false, chargesEnabled: false };
    t = payoutsTabText(await loadPayoutsTab("cg1"));
    expect(t).toContain("Bank account (Stripe): Setup incomplete — Stripe needs more information. Finish the onboarding to start receiving payouts. Reply SETUP for your Stripe link.");
    enabled(); hoisted.balanceThrows = true;
    expect(payoutsTabText(await loadPayoutsTab("cg1"))).toContain("Available to Cash Out — couldn't reach Stripe right now");
  });
  it("sends the tab", async () => {
    enabled();
    const r = await sendCaregiverPayouts("+1", "chat", "cg1");
    expect(r.instantAvailableCents).toBe(4950);
    expect(hoisted.sent.at(-1)).toContain("Payments · Payouts");
  });
});

describe("keywords", () => {
  it("PAYOUTS / BALANCE text the tab; CASH OUT starts the modal flow; SETUP sends the onboarding link; MANAGE / PAYOUT HISTORY send a signed-in Stripe dashboard link", async () => {
    enabled();
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "payouts", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Payments · Payouts");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "CASH OUT", {})).toBe("handled");
    expect(hoisted.startInstant).toHaveBeenCalledWith("cg1", "+1", "chat");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "setup", {})).toBe("handled");
    hoisted.linkResult = { success: true, linkType: "caregiver_payouts", sent: false, throttled: true, minutesSinceLastSend: 3 };
    await handlePayoutsKeyword("+1", "chat", "cg1", "SETUP", {});
    expect(hoisted.sent.at(-1)).toBe("Your Stripe setup link went out about 3 minutes ago — tap that one, or reply LINK and I'll resend it.");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "manage", {})).toBe("handled");
    expect(hoisted.loginLink).toHaveBeenCalledWith("acct_1");
    expect(hoisted.sent.at(-1)).toBe("Your Stripe dashboard (payout history, bank account, tax forms) — this link signs you in and works once: https://connect.stripe.com/express/acct_1/login");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "PAYOUT HISTORY", {})).toBe("handled");
    hoisted.payFields = {};
    await handlePayoutsKeyword("+1", "chat", "cg1", "MANAGE", {});
    expect(hoisted.sent.at(-1)).toBe("Your payout account isn't set up yet — reply SETUP for your Stripe link.");
    expect(await handlePayoutsKeyword("+1", "chat", "cg1", "hello", {})).toBe("passthrough");
  });
});
