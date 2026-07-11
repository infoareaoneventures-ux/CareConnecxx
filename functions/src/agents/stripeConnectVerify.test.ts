import { describe, it, expect, vi, beforeEach } from "vitest";

// stripe-connect-false-complete fix (2026-07-09): landing on /done must not
// activate a caregiver whose Stripe Connect onboarding never finished. These
// tests cover verifyStripeConnectComplete (the markTaskComplete gate) and
// mintStripeConnectAccountLink (the /stripe-refresh re-mint). Mirrors
// onboardingBgcheckReuse.test.ts's isolation harness (heavy import graph →
// mock firebase-admin, linq client, tokenService, stripe, and peripherals).

const hoisted = vi.hoisted(() => {
  const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: "m1" }));
  const updateMock  = vi.fn(async () => {});
  const setMock     = vi.fn(async () => {});
  const sessionData: Record<string, unknown> = {
    chatId: "chat-1",
    onboardingStep: "caregiver_awaiting_stripe",
    caregiverId: "cg-1",
    onboardingData: { name: "Jane Doe", email: "jane@x.com", stripeAccountId: "acct_1" },
  };
  const docFn = () => ({
    get:    vi.fn(async () => ({ exists: true, data: () => sessionData })),
    update: updateMock,
    set:    setMock,
  });
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  const accountsRetrieve = vi.fn(async () => ({
    id: "acct_1", charges_enabled: false, payouts_enabled: false, details_submitted: false,
  }));
  const accountsCreate    = vi.fn(async () => ({ id: "acct_new" }));
  const accountLinksCreate = vi.fn(async (_args: unknown) => ({ url: "https://connect.stripe/fresh" }));

  const stripeInstance = {
    identity:     { verificationSessions: { create: vi.fn(async () => ({ id: "vs_1", url: "https://verify.stripe/abc" })) } },
    checkout:     { sessions: { create: vi.fn(async () => ({ url: "https://pay.stripe/xyz" })) } },
    accounts:     { create: accountsCreate, retrieve: accountsRetrieve },
    accountLinks: { create: accountLinksCreate },
  };
  const StripeClass = vi.fn(function () { return stripeInstance; });

  return { sendMessage, updateMock, setMock, sessionData, collectionMock, accountsRetrieve, accountsCreate, accountLinksCreate, StripeClass };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "ts", arrayUnion: (...a: unknown[]) => a, delete: () => "__delete__" };
  const firestore: any = () => ({ collection: hoisted.collectionMock });
  firestore.FieldValue = FieldValue;
  return {
    __esModule: true,
    default: { firestore },
    firestore,
  };
});

vi.mock("../linq/client", () => ({
  sendMessage: (...a: unknown[]) => hoisted.sendMessage(...a),
  signalThinking: vi.fn(async () => {}),
}));

vi.mock("../checkrApi", () => ({
  createCheckrInvitation: vi.fn(),
  checkrPost: vi.fn(),
  CheckrApiError: class CheckrApiError extends Error {},
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
vi.mock("../safety/supervisor", () => ({ supervise: async (_ctx: unknown, content: string) => content }));
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.sessionData.chatId = "chat-1";
  hoisted.sessionData.onboardingStep = "caregiver_awaiting_stripe";
  hoisted.sessionData.caregiverId = "cg-1";
  hoisted.sessionData.onboardingData = { name: "Jane Doe", email: "jane@x.com", stripeAccountId: "acct_1" };
  hoisted.accountsRetrieve.mockResolvedValue({
    id: "acct_1", charges_enabled: false, payouts_enabled: false, details_submitted: false,
  } as any);
});

describe("verifyStripeConnectComplete — the /done activation gate", () => {
  it("returns incomplete + a fresh onboarding link when Stripe says payouts are NOT enabled", async () => {
    const { verifyStripeConnectComplete } = await import("./onboardingConversation");
    const result = await verifyStripeConnectComplete("+15551112222");

    expect(result.status).toBe("incomplete");
    expect((result as any).finishUrl).toBe("https://connect.stripe/fresh");
    // Reuses the existing Express account — no duplicate accounts.create.
    expect(hoisted.accountsCreate).not.toHaveBeenCalled();
    // The fresh link's refresh_url points at the re-mint endpoint, never /done.
    const linkArgs = hoisted.accountLinksCreate.mock.calls.at(-1)?.[0] as any;
    expect(linkArgs.account).toBe("acct_1");
    expect(linkArgs.refresh_url).toContain("/stripe-refresh?t=");
    expect(linkArgs.refresh_url).not.toContain("/done");
  }, 20_000);

  it("returns complete and stamps the caregiver doc when charges+payouts are enabled", async () => {
    hoisted.accountsRetrieve.mockResolvedValue({
      id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true,
    } as any);
    const { verifyStripeConnectComplete } = await import("./onboardingConversation");
    const result = await verifyStripeConnectComplete("+15551112222");

    expect(result.status).toBe("complete");
    // No pointless re-mint on the happy path.
    expect(hoisted.accountLinksCreate).not.toHaveBeenCalled();
    // Webhook-parity stamp so the webapp shows payouts set up immediately.
    expect(hoisted.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ stripeOnboardingComplete: true, payoutsEnabled: true }),
      { merge: true }
    );
  }, 20_000);

  it("fails CLOSED (unverified, no advance signal) when the Stripe API errors", async () => {
    hoisted.accountsRetrieve.mockRejectedValue(new Error("stripe down"));
    const { verifyStripeConnectComplete } = await import("./onboardingConversation");
    const result = await verifyStripeConnectComplete("+15551112222");

    expect(result.status).toBe("unverified");
    expect(hoisted.accountLinksCreate).not.toHaveBeenCalled();
    expect(hoisted.setMock).not.toHaveBeenCalled();
  }, 20_000);

  it("treats a session with no Express account as incomplete and mints account + link", async () => {
    hoisted.sessionData.onboardingData = { name: "Jane Doe", email: "jane@x.com" };
    const { verifyStripeConnectComplete } = await import("./onboardingConversation");
    const result = await verifyStripeConnectComplete("+15551112222");

    expect(result.status).toBe("incomplete");
    expect(hoisted.accountsCreate).toHaveBeenCalledTimes(1);
    expect((result as any).finishUrl).toBe("https://connect.stripe/fresh");
  }, 20_000);
});

describe("mintStripeConnectAccountLink — /stripe-refresh re-mint", () => {
  it("reuses the stored account and returns a fresh link with the re-mint refresh_url", async () => {
    const { mintStripeConnectAccountLink } = await import("./onboardingConversation");
    const url = await mintStripeConnectAccountLink("+15551112222");

    expect(url).toBe("https://connect.stripe/fresh");
    expect(hoisted.accountsCreate).not.toHaveBeenCalled();
    const linkArgs = hoisted.accountLinksCreate.mock.calls.at(-1)?.[0] as any;
    expect(linkArgs.refresh_url).toContain("/stripe-refresh?t=tok-123");
    expect(linkArgs.return_url).toContain("/done?task=stripe_connect");
  }, 20_000);

  it("returns null (never throws) when Stripe link creation fails", async () => {
    hoisted.accountLinksCreate.mockRejectedValueOnce(new Error("stripe down"));
    const { mintStripeConnectAccountLink } = await import("./onboardingConversation");
    const url = await mintStripeConnectAccountLink("+15551112222");
    expect(url).toBeNull();
  }, 20_000);
});
