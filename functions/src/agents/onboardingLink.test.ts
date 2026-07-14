import { describe, it, expect, vi, beforeEach } from "vitest";

// sendOnboardingLink lives in onboardingConversation.ts, which has a heavy import
// graph. We mock firebase-admin (session doc), the linq client (capture the
// outgoing link part), tokenService, stripe, and stub the peripheral modules so
// the module loads in isolation.

const hoisted = vi.hoisted(() => {
  const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: "m1" }));
  const updateMock  = vi.fn(async () => {});
  const sessionData: Record<string, unknown> = {
    chatId: "chat-1",
    onboardingData: { name: "Jane Doe", email: "jane@x.com" },
  };
  const docFn = () => ({
    get:    vi.fn(async () => ({ exists: true, data: () => sessionData })),
    update: updateMock,
  });
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  // Stripe stub — identity session for the client_identity path. Uses a regular
  // (non-arrow) function so it is constructable via `new Stripe(...)`.
  const identityCreate = vi.fn(async () => ({ id: "vs_1", url: "https://verify.stripe/abc" }));
  const checkoutCreate = vi.fn(async () => ({ url: "https://pay.stripe/xyz" }));
  const stripeInstance = {
    identity:     { verificationSessions: { create: identityCreate } },
    checkout:     { sessions: { create: checkoutCreate } },
    accounts:     { create: vi.fn(async () => ({ id: "acct_1" })) },
    accountLinks: { create: vi.fn(async () => ({ url: "https://connect.stripe/onb" })) },
  };
  const StripeClass = vi.fn(function () { return stripeInstance; });

  return { sendMessage, updateMock, sessionData, collectionMock, identityCreate, checkoutCreate, StripeClass };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: () => ({ collection: hoisted.collectionMock }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...a: unknown[]) => hoisted.sendMessage(...a),
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
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async () => "msg") }));
vi.mock("../utils/phoneVerification", () => ({
  generateOtp: vi.fn(), verifyOtp: vi.fn(), formatOtpForDisplay: vi.fn(), OtpState: {},
}));
vi.mock("../utils/language", () => ({ languageFromSession: () => "en", t: {} }));
// supervisor.ts → claudeClient.ts → langsmith/wrappers/anthropic: heavy init.
// Stub supervisor as a pass-through so onboardingConversation loads fast.
vi.mock("../safety/supervisor", () => ({ supervise: async (_ctx: unknown, content: string) => content }));
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));


beforeEach(() => {
  vi.clearAllMocks();
  hoisted.sessionData.chatId = "chat-1";
  hoisted.sessionData.onboardingData = { name: "Jane Doe", email: "jane@x.com" };
  delete (hoisted.sessionData as any).membershipCheckoutUrl;
  process.env.STRIPE_MEMBERSHIP_PRICE_ID = "price_client_monthly";
});

function lastLinkPart() {
  const call = hoisted.sendMessage.mock.calls.at(-1);
  return (call?.[1] as any)?.parts?.[0];
}

describe("sendOnboardingLink", () => {
  // 20s timeout: the first test pays the dynamic-import cost of the heavy
  // onboardingConversation module graph, which can exceed the 5s default when
  // the full suite runs in parallel under load.
  it("sends a token upload link (caregiver_photo) as a link part (OG card via v1-uploadPageMeta)", async () => {
    // /upload/** is served through the v1-uploadPageMeta OG rewrite (2026-07-12),
    // so the link part renders a branded preview card instead of the raw token URL.
    const { sendOnboardingLink } = await import("./onboardingConversation");
    const res = await sendOnboardingLink("+15551112222", "caregiver_photo");

    expect(res).toEqual({ success: true, linkType: "caregiver_photo" });
    expect(lastLinkPart()).toEqual({ type: "link", value: expect.stringContaining("/upload/photo?t=tok-123") });
  }, 20_000);

  it("sends the Stripe identity link for client_identity", async () => {
    const { sendOnboardingLink } = await import("./onboardingConversation");
    await sendOnboardingLink("+15551112222", "client_identity");

    expect(hoisted.identityCreate).toHaveBeenCalledOnce();
    expect(lastLinkPart()).toEqual({ type: "link", value: "https://verify.stripe/abc" });
  });

  it("creates a subscription checkout with the resolved client price when resending client_payment", async () => {
    const { sendOnboardingLink } = await import("./onboardingConversation");
    await sendOnboardingLink("+15551112222", "client_payment");

    expect(hoisted.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      line_items: [{ price: "price_client_monthly", quantity: 1 }],
      metadata: { phone: "+15551112222", task: "client_payment_setup" },
    }));
    expect(lastLinkPart()).toEqual({ type: "link", value: expect.stringContaining("https://pay.stripe/xyz") });
  });

  it("reuses a stored membership checkout URL instead of regenerating (no duplicate Stripe resource)", async () => {
    (hoisted.sessionData as any).membershipCheckoutUrl = "https://pay.stripe/stored";
    const { sendOnboardingLink } = await import("./onboardingConversation");
    await sendOnboardingLink("+15551112222", "caregiver_membership");

    expect(lastLinkPart()).toEqual({ type: "link", value: "https://pay.stripe/stored" });
  });

  it("throws (rather than silently failing) when the session has no chatId", async () => {
    hoisted.sessionData.chatId = "";
    const { sendOnboardingLink } = await import("./onboardingConversation");
    await expect(sendOnboardingLink("+15550000000", "caregiver_photo")).rejects.toThrow();
  });
});
