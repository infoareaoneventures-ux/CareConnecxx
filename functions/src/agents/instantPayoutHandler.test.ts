import { describe, it, expect, vi, beforeEach } from "vitest";

// The Payouts tab's Cash Out button + Instant Payout modal as a flow
// (instantPayoutHandler.ts): the page's preconditions and info toasts, the
// modal's lines, CASH OUT / CANCEL, and the ONE payout implementation.

const hoisted = vi.hoisted(() => {
  class InstantPayoutError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
  return {
    docs: new Map<string, any>(),
    sent: [] as string[],
    updates: [] as any[],
    payFields: {} as Record<string, unknown>,
    balance: { instantAvailableCents: 4950, pendingCents: 0 } as any,
    balanceThrows: false,
    executeInstantPayout: vi.fn(async () => ({ payoutDocId: "p1", stripePayoutId: "po_1", amountCents: 4900, grossCents: 4950, feeCents: 50, status: "pending", arrivalDate: null })),
    InstantPayoutError,
    linkSent: [] as string[],
    quick: vi.fn(async () => "OTHER"),
    backOut: vi.fn(async () => false),
    isQuestion: vi.fn(async () => false),
  };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => { hoisted.updates.push(d); hoisted.docs.set(`${name}/${id}`, { ...(hoisted.docs.get(`${name}/${id}`) ?? {}), ...d }); }),
      }),
    }),
  }), { FieldValue: { delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("./stepHandler", () => ({ isBackOutRequest: (...a: any[]) => (hoisted.backOut as any)(...a), isQuestionOrOther: (...a: any[]) => (hoisted.isQuestion as any)(...a), answerMidFlow: vi.fn(async (_t: string, q: string) => `Answer. ${q}`) }));
vi.mock("../caregiverPrivate", () => ({ getCaregiverPayoutFields: vi.fn(async () => hoisted.payFields) }));
vi.mock("../payoutCommon", () => ({
  executeInstantPayout: (...a: any[]) => (hoisted.executeInstantPayout as any)(...a),
  InstantPayoutError: hoisted.InstantPayoutError,
  readInstantBalance: vi.fn(async () => { if (hoisted.balanceThrows) throw new Error("stripe down"); return hoisted.balance; }),
}));
vi.mock("./caregiverPayouts", () => ({ sendPayoutSetupLink: vi.fn(async (phone: string) => { hoisted.linkSent.push(phone); return true; }) }));

import { startInstantPayout, handleInstantPayoutConfirm, cashOutModalText, NOT_SET_UP, SETUP_INCOMPLETE, NOTHING_TO_CASH_OUT, HOLD_OFF } from "./instantPayoutHandler";

const CG = "cg-1", PHONE = "+15555550100", CHAT = "chat-1";
const enabled = () => { hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true, chargesEnabled: true }; };
const session = () => hoisted.docs.get(`agent_sessions/${PHONE}`) ?? {};

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.updates.length = 0; hoisted.linkSent.length = 0;
  hoisted.payFields = {}; hoisted.balance = { instantAvailableCents: 4950, pendingCents: 0 }; hoisted.balanceThrows = false;
  hoisted.executeInstantPayout.mockClear(); hoisted.quick.mockReset(); hoisted.quick.mockResolvedValue("OTHER"); hoisted.backOut.mockReset(); hoisted.backOut.mockResolvedValue(false); hoisted.isQuestion.mockReset(); hoisted.isQuestion.mockResolvedValue(false);
  hoisted.docs.set(`caregivers/${CG}`, { name: "Mahad" });
  hoisted.docs.set(`agent_sessions/${PHONE}`, { caregiverId: CG });
});

describe("startInstantPayout — the page's preconditions, in the page's order", () => {
  it("missing caregiver doc → asks for the sign-up email", async () => {
    hoisted.docs.delete(`caregivers/${CG}`);
    expect((await startInstantPayout(CG, PHONE, CHAT)).reason).toBe("not_found");
    expect(hoisted.sent[0]).toMatch(/couldn't find your caregiver profile/);
  });
  it("no Stripe account → the bank card's text + the Setup Payouts link (never 'open the app')", async () => {
    expect((await startInstantPayout(CG, PHONE, CHAT)).reason).toBe("no_account");
    expect(hoisted.sent[0]).toBe(NOT_SET_UP);
    expect(hoisted.linkSent).toEqual([PHONE]);
    expect(hoisted.sent.join(" ")).not.toMatch(/app/i);
  });
  it("account but not fully enabled (payouts AND charges) → Setup incomplete + the link", async () => {
    hoisted.payFields = { stripeAccountId: "acct_1", payoutsEnabled: true, chargesEnabled: false };
    expect((await startInstantPayout(CG, PHONE, CHAT)).reason).toBe("setup_incomplete");
    expect(hoisted.sent[0]).toBe(SETUP_INCOMPLETE);
    expect(hoisted.linkSent).toEqual([PHONE]);
  });
  it("under $1 → the page's info toasts (settling amount, else nothing to cash out); nothing parked", async () => {
    enabled(); hoisted.balance = { instantAvailableCents: 40, pendingCents: 2000 };
    expect((await startInstantPayout(CG, PHONE, CHAT)).reason).toBe("no_balance");
    expect(hoisted.sent[0]).toBe("$20.00 is still settling — it pays out automatically, no action needed.");
    hoisted.balance = { instantAvailableCents: 40, pendingCents: 0 };
    await startInstantPayout(CG, PHONE, CHAT);
    expect(hoisted.sent[1]).toBe(NOTHING_TO_CASH_OUT);
    expect(hoisted.updates).toHaveLength(0);
  });
  it("Stripe balance unreachable → try again later", async () => {
    enabled(); hoisted.balanceThrows = true;
    expect((await startInstantPayout(CG, PHONE, CHAT)).reason).toBe("balance_unavailable");
    expect(hoisted.sent[0]).toMatch(/couldn't pull your balance right now/);
  });
  it("$1+ → the modal as one text and the parked confirmation with the quoted balance", async () => {
    enabled();
    expect((await startInstantPayout(CG, PHONE, CHAT)).started).toBe(true);
    expect(hoisted.sent[0]).toBe(cashOutModalText(4950));
    expect(hoisted.sent[0]).toBe([
      "Cash Out Now — get your earnings in ~30 minutes",
      "Available Now $49.50",
      "Stripe instant fee (1%, min $0.50) −$0.50",
      "You'll Receive $49.00",
      "",
      "Arrives in about 30 minutes — funds will be sent to your connected bank account. No rush? Your earnings pay out automatically every day and land in your bank within ~2 business days.",
      "",
      "Reply CASH OUT to send $49.00 now, or CANCEL.",
    ].join("\n"));
    expect(session().pendingInstantPayoutAmount).toBe("4950");
    expect(typeof session().pendingInstantPayoutConfirm).toBe("string");
  });
  it("the fee is 1% with a $0.50 minimum, never free", () => {
    expect(cashOutModalText(10000)).toContain("Stripe instant fee (1%, min $0.50) −$1.00\nYou'll Receive $99.00");
    expect(cashOutModalText(10000)).not.toMatch(/instant payouts? (is|are) free/i);
  });
});

describe("handleInstantPayoutConfirm — the modal's two buttons", () => {
  const park = () => { hoisted.docs.set(`agent_sessions/${PHONE}`, { caregiverId: CG, pendingInstantPayoutConfirm: new Date().toISOString(), pendingInstantPayoutAmount: "4950" }); };
  it("CASH OUT → the one payout implementation, full current balance, the page's success toast, flags cleared", async () => {
    park();
    await handleInstantPayoutConfirm(CG, PHONE, "cash out", CHAT);
    expect(hoisted.executeInstantPayout).toHaveBeenCalledWith({ caregiverId: CG, source: "cara_sms" });
    expect(hoisted.sent.at(-1)).toBe("Instant payout of $49.00 initiated (after Stripe's $0.50 instant fee) — arrives in ~30 minutes!");
    expect(session().pendingInstantPayoutConfirm).toBe("__delete__");
    expect(session().pendingInstantPayoutAmount).toBe("__delete__");
  });
  it("YES and SEND also confirm; CANCEL / NO hold off with the page's line and no payout", async () => {
    park(); await handleInstantPayoutConfirm(CG, PHONE, "yes", CHAT);
    expect(hoisted.executeInstantPayout).toHaveBeenCalledTimes(1);
    park(); await handleInstantPayoutConfirm(CG, PHONE, "cancel", CHAT);
    expect(hoisted.sent.at(-1)).toBe(HOLD_OFF);
    expect(hoisted.executeInstantPayout).toHaveBeenCalledTimes(1);
    expect(session().pendingInstantPayoutConfirm).toBe("__delete__");
  });
  it("a question keeps the confirmation parked and re-asks", async () => {
    park(); hoisted.isQuestion.mockResolvedValueOnce(true);
    await handleInstantPayoutConfirm(CG, PHONE, "how long does it take?", CHAT);
    expect(hoisted.sent.at(-1)).toBe("Answer. Reply CASH OUT to send $49.00 now, or CANCEL.");
    expect(session().pendingInstantPayoutAmount).toBe("4950");
    expect(hoisted.executeInstantPayout).not.toHaveBeenCalled();
  });
  it("an unclear reply re-asks without clearing", async () => {
    park();
    await handleInstantPayoutConfirm(CG, PHONE, "maybe later idk", CHAT);
    expect(hoisted.sent.at(-1)).toBe("Sorry, I didn't quite catch that. Reply CASH OUT to send $49.00 now, or CANCEL.");
    expect(session().pendingInstantPayoutAmount).toBe("4950");
  });
  it("server refusals are texted as the server says them (the page shows error.message); duplicate and swept-balance keep their lines; unknown → the page's default", async () => {
    park(); hoisted.executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("NOT_READY", "Account not fully onboarded. Please complete your Stripe Connect setup."));
    await handleInstantPayoutConfirm(CG, PHONE, "CASH OUT", CHAT);
    expect(hoisted.sent.at(-1)).toBe("Account not fully onboarded. Please complete your Stripe Connect setup.");
    park(); hoisted.executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("DUPLICATE", "x"));
    await handleInstantPayoutConfirm(CG, PHONE, "CASH OUT", CHAT);
    expect(hoisted.sent.at(-1)).toMatch(/already sent a moment ago/);
    park(); hoisted.executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("NO_BALANCE", "x"));
    await handleInstantPayoutConfirm(CG, PHONE, "CASH OUT", CHAT);
    expect(hoisted.sent.at(-1)).toMatch(/just paid out automatically/);
    park(); hoisted.executeInstantPayout.mockRejectedValueOnce(new Error("stripe exploded"));
    await handleInstantPayoutConfirm(CG, PHONE, "CASH OUT", CHAT);
    expect(hoisted.sent.at(-1)).toBe("Payout failed. Please try again.");
  });
});
