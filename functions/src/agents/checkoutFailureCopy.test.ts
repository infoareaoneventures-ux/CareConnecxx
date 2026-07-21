import { describe, it, expect, vi, beforeEach } from "vitest";

// U4 (2026-07-16): a Stripe checkout-create failure must NEVER text the
// /payment/success fallback URL (that page is for AFTER a real charge). Both the
// main path (handleClientSendPayment) and the resend path (sendOnboardingLink
// "client_payment") route the failure through sendOnboardingLinkFailureMessage:
// recordCommitment FIRST (retry sweep owns it), then grounded apology copy with
// NO URL, fail-open static fallback, admin_alerts preserved.

const hoisted = vi.hoisted(() => {
  const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: "m1" }));
  const signalThinking = vi.fn(async (..._args: unknown[]) => {});
  const updateMock = vi.fn(async () => {});
  const addMock = vi.fn(async (_name: string, _doc: unknown) => ({ id: "x" }));
  const recordCommitment = vi.fn(async (..._args: unknown[]) => "commit-1");
  const resolveCommitment = vi.fn(async (..._args: unknown[]) => {});
  const generateCaraMessage = vi.fn(async (..._args: unknown[]) => "msg");
  // checkout.sessions.create — swap the implementation per test (succeed / throw).
  const checkoutCreate = vi.fn(async (..._args: unknown[]) => ({ url: "https://pay.stripe/xyz" }));
  const createBrandedLink = vi.fn(async (_kind: string, url: string) => url);

  const sessionData: Record<string, unknown> = {
    chatId: "chat-1",
    onboardingData: { name: "Jane Doe", seniorName: "Mary", selectedPlanPriceId: "price_client_monthly" },
  };
  const docFn = () => ({
    get:    vi.fn(async () => ({ exists: true, data: () => sessionData })),
    update: updateMock,
  });
  const collectionMock = vi.fn((name: string) => ({ doc: docFn, add: (d: unknown) => addMock(name, d) }));

  const stripeInstance = {
    identity:     { verificationSessions: { create: vi.fn(async () => ({ id: "vs", url: "https://verify/x" })) } },
    checkout:     { sessions: { create: (...a: unknown[]) => checkoutCreate(...a) } },
    accounts:     { create: vi.fn(async () => ({ id: "acct" })) },
    accountLinks: { create: vi.fn(async () => ({ url: "https://connect/onb" })) },
    prices:       { retrieve: vi.fn(async () => ({ unit_amount: 2995, recurring: { interval: "month" } })) },
  };
  const StripeClass = vi.fn(function () { return stripeInstance; });

  return {
    sendMessage, signalThinking, updateMock, addMock, recordCommitment, resolveCommitment,
    generateCaraMessage, checkoutCreate, createBrandedLink, sessionData, collectionMock, StripeClass,
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: () => ({ collection: hoisted.collectionMock }),
}));

vi.mock("../linq/client", () => ({
  sendMessage:    (...a: unknown[]) => hoisted.sendMessage(...a),
  signalThinking: (...a: unknown[]) => hoisted.signalThinking(...a),
}));

vi.mock("./commitmentTracker", () => ({
  recordCommitment:  (...a: unknown[]) => hoisted.recordCommitment(...a),
  resolveCommitment: (...a: unknown[]) => hoisted.resolveCommitment(...a),
}));

vi.mock("../utils/linkRedirects", () => ({
  createBrandedLink: (...a: unknown[]) => hoisted.createBrandedLink(...(a as [string, string])),
}));

vi.mock("./tokenService", () => ({ generateToken: () => "tok-123" }));
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));

// Peripheral stubs so the module loads without pulling heavy deps.
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn() }));
vi.mock("../utils/jsonUtils", () => ({ unwrapJson: vi.fn() }));
vi.mock("../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(), notifyAdminNewCaregiverSignup: vi.fn() }));
vi.mock("../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(), writeMemoryFile: vi.fn() }));
vi.mock("../memory/zepClient", () => ({ pushOnboardingDataToZep: vi.fn(), addBusinessDataToZep: vi.fn(), getZepUserId: vi.fn() }));
vi.mock("./buildJobPost", () => ({ buildAndSaveJobPost: vi.fn() }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => hoisted.generateCaraMessage(...a) }));
vi.mock("../utils/phoneVerification", () => ({
  generateOtp: vi.fn(), verifyOtp: vi.fn(), formatOtpForDisplay: vi.fn(), OtpState: {},
}));
vi.mock("../utils/language", () => ({ languageFromSession: () => "en", t: {} }));
vi.mock("../safety/supervisor", () => ({ supervise: async (_ctx: unknown, content: string) => content }));
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.sessionData.chatId = "chat-1";
  hoisted.sessionData.onboardingData = { name: "Jane Doe", seniorName: "Mary", selectedPlanPriceId: "price_client_monthly" };
  hoisted.checkoutCreate.mockImplementation(async () => ({ url: "https://pay.stripe/xyz" }));
  hoisted.generateCaraMessage.mockImplementation(async (_opts: any) => "msg");
  process.env.STRIPE_MEMBERSHIP_PRICE_ID = "price_client_monthly";
});

// Every sendMessage call whose payload carries a `link` part.
function linkPartsSent() {
  return hoisted.sendMessage.mock.calls.filter(
    (c) => Array.isArray((c[1] as any)?.parts) && (c[1] as any).parts.some((p: any) => p?.type === "link"),
  );
}

const session = () => ({ chatId: "chat-1", onboardingData: hoisted.sessionData.onboardingData } as any);

describe("handleClientSendPayment — checkout-create failure (U4, main path)", () => {
  it("throw → no URL goes out, commitment recorded (client), admin_alerts written", async () => {
    hoisted.checkoutCreate.mockImplementation(async () => { throw new Error("stripe down"); });
    const { handleClientSendPayment } = await import("./onboardingConversation");
    await handleClientSendPayment("+15551112222", "chat-1", session());

    // No link part anywhere in the outbound — the /payment/success fallback is gone.
    expect(linkPartsSent()).toHaveLength(0);
    // Commitment recorded FIRST, addressed to the family.
    expect(hoisted.recordCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "link", linkType: "client_payment", userType: "client" }),
    );
    // admin_alerts still written.
    expect(hoisted.addMock).toHaveBeenCalledWith(
      "admin_alerts",
      expect.objectContaining({ type: "stripe_checkout_create_failed", task: "client_payment_setup" }),
    );
  }, 20_000);

  it("success → the real branded checkout URL is texted (behavior unchanged)", async () => {
    const { handleClientSendPayment } = await import("./onboardingConversation");
    await handleClientSendPayment("+15551112222", "chat-1", session());

    const parts = linkPartsSent();
    expect(parts.length).toBeGreaterThan(0);
    expect((parts.at(-1)?.[1] as any).parts[0].value).toContain("https://pay.stripe/xyz");
    // No failure commitment on the happy path.
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  }, 20_000);

  it("generateCaraMessage falls back (LLM failure) → static fallback sent, no URL, commitment still recorded", async () => {
    hoisted.checkoutCreate.mockImplementation(async () => { throw new Error("stripe down"); });
    // Simulate generateCaraMessage's internal fail-open: it returns its `fallback`.
    hoisted.generateCaraMessage.mockImplementation(async (opts: any) => opts.fallback);
    const { handleClientSendPayment } = await import("./onboardingConversation");
    await handleClientSendPayment("+15551112222", "chat-1", session());

    expect(hoisted.recordCommitment).toHaveBeenCalledTimes(1);
    expect(linkPartsSent()).toHaveLength(0);
    // The static fallback string (no URL) is what actually went out.
    const lastText = hoisted.sendMessage.mock.calls.at(-1)?.[1];
    expect(typeof lastText).toBe("string");
    expect(lastText as string).toContain("membership setup");
    expect(lastText as string).not.toContain("http");
  }, 20_000);
});

describe("sendOnboardingLink client_payment — checkout-create failure (U4, resend path)", () => {
  it("throw → no URL goes out, commitment recorded, admin_alerts written, returns success:false", async () => {
    hoisted.checkoutCreate.mockImplementation(async () => { throw new Error("stripe down"); });
    const { sendOnboardingLink } = await import("./onboardingConversation");
    const res = await sendOnboardingLink("+15551112222", "client_payment");

    expect(res).toEqual({ success: false, linkType: "client_payment" });
    expect(linkPartsSent()).toHaveLength(0);
    expect(hoisted.recordCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "link", linkType: "client_payment", userType: "client" }),
    );
    expect(hoisted.addMock).toHaveBeenCalledWith(
      "admin_alerts",
      expect.objectContaining({ type: "onboarding_link_generation_failed" }),
    );
  }, 20_000);

  it("success → the real checkout URL is texted (behavior unchanged)", async () => {
    const { sendOnboardingLink } = await import("./onboardingConversation");
    const res = await sendOnboardingLink("+15551112222", "client_payment");

    expect(res).toEqual({ success: true, linkType: "client_payment" });
    const parts = linkPartsSent();
    expect((parts.at(-1)?.[1] as any).parts[0].value).toContain("https://pay.stripe/xyz");
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  }, 20_000);
});
