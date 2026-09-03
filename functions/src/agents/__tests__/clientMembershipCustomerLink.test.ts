import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-31 (Membership page audit): createClientMembershipCheckout used to
// never set `customer:` on the Checkout session it creates, and never wrote
// customers/{uid}.stripeCustomerId — only the LATER webhook wrote the
// users/{uid} mirror on success. The website's own createCheckoutSession
// (functions/src/stripe.ts) always looks up customers/{uid} FIRST and reuses
// the existing Stripe customer. Since the two paths never shared that lookup,
// a family who signed up for membership by texting Evia, then later visited
// the website and clicked "Change plan", would mint a SECOND Stripe customer
// and a second parallel subscription — a real double-billing risk. These
// tests lock in the fix: when a userId is already known (it usually is by
// this point in onboarding), get-or-create the customer the same way the
// website does, and pass it through to the Checkout session.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
  });
  const makeCollRef = (path: string): any => ({ doc: (id: string) => makeDocRef(`${path}/${id}`) });

  const checkoutCreate = vi.fn(async (params: any) => ({ id: "cs_1", url: `https://pay.stripe/${params.customer ?? "no-customer"}` }));
  const customersCreate = vi.fn(async (_params: any) => ({ id: "cus_new123" }));

  return {
    docState, sets, checkoutCreate, customersCreate,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; checkoutCreate.mockClear(); customersCreate.mockClear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("stripe", () => ({
  __esModule: true,
  default: vi.fn(function () {
    return {
      checkout: { sessions: { create: (...a: unknown[]) => hoisted.checkoutCreate(...(a as [any])) } },
      customers: { create: (...a: unknown[]) => hoisted.customersCreate(...(a as [any])) },
    };
  }),
}));

// Peripheral stubs so onboardingConversation.ts's module graph loads.
// Note: this file lives in agents/__tests__/, one level deeper than the
// module under test — every relative path needs an extra "../".
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn() }));
vi.mock("../../utils/jsonUtils", () => ({ unwrapJson: vi.fn() }));
vi.mock("../../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(), notifyAdminNewCaregiverSignup: vi.fn() }));
vi.mock("../../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(), writeMemoryFile: vi.fn() }));
vi.mock("../../memory/zepClient", () => ({ pushOnboardingDataToZep: vi.fn(), addBusinessDataToZep: vi.fn(), getZepUserId: vi.fn() }));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn() }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../utils/phoneVerification", () => ({
  generateOtp: vi.fn(), verifyOtp: vi.fn(), formatOtpForDisplay: vi.fn(), OtpState: {},
}));
vi.mock("../../utils/language", () => ({ languageFromSession: () => "en", t: {} }));
vi.mock("../../safety/supervisor", () => ({ supervise: async (_ctx: unknown, content: string) => content }));
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../../linq/client", () => ({
  sendMessage: vi.fn(async () => ({ message_id: "m1" })),
  signalThinking: vi.fn(async () => {}),
}));
vi.mock("../commitmentTracker", () => ({ recordCommitment: vi.fn(async () => "c1"), resolveCommitment: vi.fn(async () => {}) }));
vi.mock("../../utils/linkRedirects", () => ({ createBrandedLink: vi.fn(async (_k: string, url: string) => url) }));
vi.mock("../tokenService", () => ({ generateToken: () => "tok-123" }));

import { sendOnboardingLink } from "../onboardingConversation";

const PHONE = "+15551112222";

beforeEach(() => {
  hoisted.reset();
  process.env.STRIPE_MEMBERSHIP_PRICE_ID = "price_client_monthly";
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    chatId: "chat-1",
    onboardingData: { name: "Jane Doe", seniorName: "Mary" },
  });
});

describe("createClientMembershipCheckout — customer linking (Membership page audit)", () => {
  it("reuses the existing customers/{uid}.stripeCustomerId when one already exists — no new Stripe customer created", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      userId: "uid-1",
      onboardingData: { name: "Jane Doe" },
    });
    hoisted.docState.set("customers/uid-1", { stripeCustomerId: "cus_existing" });

    await sendOnboardingLink(PHONE, "client_payment");

    expect(hoisted.customersCreate).not.toHaveBeenCalled();
    expect(hoisted.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("creates a Stripe customer and links customers/{uid} when the client has a userId but no customer yet", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      userId: "uid-2",
      onboardingData: { name: "Jane Doe" },
    });
    hoisted.docState.set("users/uid-2", { email: "jane@example.com" });

    await sendOnboardingLink(PHONE, "client_payment");

    expect(hoisted.customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "jane@example.com", metadata: { firebaseUID: "uid-2" } }),
    );
    const custSet = hoisted.sets.find((s) => s.path === "customers/uid-2");
    expect(custSet?.data.stripeCustomerId).toBe("cus_new123");
    expect(hoisted.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new123" }),
    );
  });

  it("falls back to a phone-only session (no customer) when userId isn't known yet — never blocks a cold-SMS signup", async () => {
    // No userId in session at all — the pre-fix behavior, still supported.
    await sendOnboardingLink(PHONE, "client_payment");

    expect(hoisted.customersCreate).not.toHaveBeenCalled();
    expect(hoisted.checkoutCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ customer: expect.anything() }),
    );
  });
});
