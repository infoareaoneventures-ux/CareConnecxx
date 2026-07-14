import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 1 (caregiver-signup-fixes-2026-07-07): the Connect webhook now MATCHES a
// caregiver whose Express account id was mirrored onto the caregivers doc during
// onboarding, so account.updated (charges+payouts enabled) can finalize signup
// server-side. This test drives the webhook handler and asserts that a matched,
// complete account advances Evia onboarding with the caregiver's phone, and that
// the ledger's exactly-once guard drops a duplicate redelivery.

const hoisted = vi.hoisted(() => {
  const advanceOnboardingStep = vi.fn(async () => {});
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
  const claimWebhookEvent = vi.fn(async () => "claimed");
  const settleWebhookEvent = vi.fn(async () => {});

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
  it("advances onboarding with the caregiver's phone when a matched account is complete", async () => {
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
