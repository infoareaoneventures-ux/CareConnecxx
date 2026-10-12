import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 1 (caregiver-signup-fixes-2026-07-07): the Connect webhook now MATCHES a
// caregiver whose Express account id was mirrored onto the caregivers doc during
// onboarding, so account.updated (charges+payouts enabled) can finalize signup
// server-side. This test drives the webhook handler and asserts that a matched,
// complete account advances Evia onboarding with the caregiver's phone, and that
// the ledger's exactly-once guard drops a duplicate redelivery.

const hoisted = vi.hoisted(() => {
  const advanceOnboardingStep = vi.fn(async (..._a: unknown[]) => {});
  const docUpdate = vi.fn(async () => {});
  const privateSet = vi.fn(async () => {});
  const caregiverDoc = {
    ref:  { update: docUpdate },
    id:   "cg-1",
    data: () => ({ phone: "+15551112222" }),
  };
  // The handler resolves the caregiver via resolveCaregiverByStripeAccount
  // (stripe_accounts map first — empty here — then the parent-field query
  // fallback), then updates caregivers/{id} by doc ref and dual-writes
  // private/payout. Model that whole surface.
  const caregiverDocRef = {
    update: docUpdate,
    get: async () => ({ exists: true, data: () => ({ phone: "+15551112222" }) }),
    collection: () => ({ doc: () => ({ set: privateSet }) }),
  };
  // caregivers query → one matching doc; all other collections → empty/no-op.
  // where() args are captured so the test binds the webhook's match query to the
  // exact field Fix 1 mirrors onto the caregiver doc (stripeAccountId).
  const caregiverWhereArgs: unknown[][] = [];
  const collectionMock = vi.fn((name: string) => {
    if (name === "caregivers") {
      return {
        where: (...args: unknown[]) => {
          caregiverWhereArgs.push(args);
          return { limit: () => ({ get: async () => ({ empty: false, docs: [caregiverDoc] }) }) };
        },
        doc: () => caregiverDocRef,
      };
    }
    return {
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      doc: () => ({ get: async () => ({ exists: false, data: () => null }), set: vi.fn(async () => {}) }),
    };
  });

  const constructEvent = vi.fn();
  const claimWebhookEvent = vi.fn(async (..._a: unknown[]) => "claimed");
  const settleWebhookEvent = vi.fn(async (..._a: unknown[]) => {});

  return { advanceOnboardingStep, docUpdate, collectionMock, caregiverWhereArgs, constructEvent, claimWebhookEvent, settleWebhookEvent };
});

vi.mock("firebase-functions/v1", () => {
  const https = { onRequest: (handler: unknown) => handler };
  const fn = { https, config: () => ({}) };
  return { __esModule: true, ...fn, default: fn, https, config: () => ({}) };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "ts" };
  const firestore: any = () => ({ collection: hoisted.collectionMock });
  firestore.FieldValue = FieldValue;
  return {
    __esModule: true,
    apps: [{}],
    initializeApp: vi.fn(),
    firestore,
    default: { apps: [{}], initializeApp: vi.fn(), firestore },
  };
});

vi.mock("stripe", () => ({
  __esModule: true,
  default: vi.fn(function () {
    return { webhooks: { constructEvent: (...a: unknown[]) => hoisted.constructEvent(...a) } };
  }),
}));

vi.mock("./utils/webhookLedger", () => ({
  STRIPE_EVENTS_COLLECTION: "processed_stripe_events",
  claimWebhookEvent: (...a: unknown[]) => hoisted.claimWebhookEvent(...a),
  settleWebhookEvent: (...a: unknown[]) => hoisted.settleWebhookEvent(...a),
}));

vi.mock("./billing/paymentMethods", () => ({ isOfflinePaymentMethod: () => false }));

// Bell ⇄ text in lockstep (C11): payoutNotice texts first through sendSMSToUser
// and writes the bell through writeUserNotification only when the text went.
const lockstep = vi.hoisted(() => ({
  smsResult: { success: true } as { success: boolean; error?: string },
  sends: [] as Array<{ userId: string; text: string }>,
  bells: [] as any[],
  order: [] as string[],
}));
vi.mock("./sms", () => ({
  sendSMSToUser: vi.fn(async (userId: string, text: string) => { lockstep.sends.push({ userId, text }); lockstep.order.push("text"); return lockstep.smsResult; }),
}));
vi.mock("./notifications/userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { lockstep.bells.push(n); lockstep.order.push("bell"); return true; }),
}));

// The handler dynamically imports this at finalization time.
vi.mock("./agents/onboardingConversation", () => ({
  advanceOnboardingStep: (...a: unknown[]) => hoisted.advanceOnboardingStep(...a),
}));

function makeRes() {
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    send: vi.fn(),
    json: vi.fn(),
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.caregiverWhereArgs.length = 0;
  process.env = { ...OLD_ENV, STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_test", STRIPE_SECRET_KEY: "sk_test" };
  hoisted.claimWebhookEvent.mockResolvedValue("claimed");
  hoisted.constructEvent.mockReturnValue({
    id:   "evt_1",
    type: "account.updated",
    data: { object: { id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true } },
  });
});

describe("stripeConnectWebhook — account.updated matching (Fix 1)", () => {
  it("advances onboarding with the care provider's phone when a matched account is complete", async () => {
    const { stripeConnectWebhook } = await import("./stripeConnectWebhook");
    const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
    const res = makeRes();

    await (stripeConnectWebhook as any)(req, res);

    // The match query MUST be on the exact field Fix 1 mirrors onto the doc —
    // if either side drifts, matching silently dies and this catches it.
    expect(hoisted.caregiverWhereArgs[0]).toEqual(["stripeAccountId", "==", "acct_1"]);
    expect(hoisted.docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripeOnboardingComplete: true })
    );
    expect(hoisted.advanceOnboardingStep).toHaveBeenCalledWith("+15551112222", "stripe_connect", "");
    expect(res.json).toHaveBeenCalledWith({ received: true });
  }, 20_000);

  it("drops a duplicate redelivery via the exactly-once ledger (no double advance)", async () => {
    hoisted.claimWebhookEvent.mockResolvedValueOnce("duplicate");
    const { stripeConnectWebhook } = await import("./stripeConnectWebhook");
    const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
    const res = makeRes();

    await (stripeConnectWebhook as any)(req, res);

    expect(hoisted.advanceOnboardingStep).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
  }, 20_000);
});

// Bell ⇄ text in lockstep (caregiver sweep C11, 2026-10-11): payout.paid /
// payout.failed text FIRST; the Payouts-page bell is written only when the text
// went. Before this the bell was a raw `.add()` written before a text whose
// result was ignored.
describe("stripeConnectWebhook — payoutNotice (bell ⇄ text)", () => {
  beforeEach(() => {
    lockstep.smsResult = { success: true };
    lockstep.sends.length = 0;
    lockstep.bells.length = 0;
    lockstep.order.length = 0;
  });

  it("text sent → the bell follows it, keyed on the Stripe event (a redelivery never doubles it)", async () => {
    const { payoutNotice } = await import("./stripeConnectWebhook");
    const r = await payoutNotice("cg-1", "evt_po_1", "po_1", "payout_paid", "Payout Arrived",
      "Your payout of $120.00 has been deposited to your bank account.",
      "Evia: Your payout of $120.00 has been deposited to your bank account. It's under Payout history on your Payments page.");

    expect(r).toEqual({ text: true, bell: true });
    expect(lockstep.order).toEqual(["text", "bell"]);
    expect(lockstep.sends).toEqual([{ userId: "cg-1", text: expect.stringContaining("Evia: Your payout of $120.00") }]);
    expect(lockstep.bells).toEqual([{
      sourcePath: "caregivers/cg-1", eventId: "evt_po_1", recipientId: "cg-1", transitionType: "payout_paid",
      type: "payout_paid", title: "Payout Arrived", body: "Your payout of $120.00 has been deposited to your bank account.", data: { payoutId: "po_1" },
    }]);
  }, 20_000);

  it("text dropped (no phone / line down / transport error) → no bell", async () => {
    lockstep.smsResult = { success: false, error: "No phone number on file" };
    const { payoutNotice } = await import("./stripeConnectWebhook");
    const r = await payoutNotice("cg-1", "evt_po_2", "po_2", "payout_failed", "Payout Failed",
      "Your payout of $120.00 could not be deposited. Please check your bank account details.",
      "Evia: Your payout of $120.00 could not be deposited. Please check your bank account details. Reply SETUP for your Stripe link to update them.");

    expect(r).toEqual({ text: false, bell: false });
    expect(lockstep.sends).toHaveLength(1);
    expect(lockstep.bells).toHaveLength(0);
  }, 20_000);

  it("the one exception: a care provider who texted STOP keeps the bell — the site is her only channel", async () => {
    lockstep.smsResult = { success: false, error: "Recipient has opted out of SMS notifications" };
    const { payoutNotice } = await import("./stripeConnectWebhook");
    const r = await payoutNotice("cg-1", "evt_po_3", "po_3", "payout_paid", "Payout Arrived", "Your payout of $50.00 has been deposited to your bank account.", "Evia: …");

    expect(r).toEqual({ text: false, bell: true });
    expect(lockstep.bells).toHaveLength(1);
    expect(lockstep.bells[0]).toMatchObject({ eventId: "evt_po_3", transitionType: "payout_paid" });
  }, 20_000);
});
