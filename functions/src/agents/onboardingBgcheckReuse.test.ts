import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 2 (caregiver-signup-fixes-2026-07-07): resendStuckStep must NOT mint a
// duplicate Checkr invitation when one was already issued — it should resend the
// cached bgcheckInviteUrl. Mirrors onboardingLink.test.ts's isolation harness
// (heavy import graph → mock firebase-admin, linq client, tokenService, stripe,
// axios, and stub the peripheral modules).

const hoisted = vi.hoisted(() => {
  const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: "m1" }));
  const updateMock  = vi.fn(async () => {});
  const setMock     = vi.fn(async () => {});
  const sessionData: Record<string, unknown> = {
    chatId: "chat-1",
    onboardingStep: "caregiver_awaiting_bgcheck",
    caregiverId: "cg-1",
    bgcheckInviteUrl: "https://apply.checkr.com/invite/abc",
    onboardingData: { name: "Jane Doe", email: "jane@x.com" },
  };
  const docFn = () => ({
    get:    vi.fn(async () => ({ exists: true, data: () => sessionData })),
    update: updateMock,
    set:    setMock,
  });
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  // The shared candidate-first Checkr helper (checkrApi.ts). Returning a fixed
  // result mirrors a successful candidate→invitation round trip.
  const checkrInvite = vi.fn(async (_args: unknown) => ({ invitationUrl: "https://new/x", candidateId: "cand_new" }));

  const stripeInstance = {
    identity:     { verificationSessions: { create: vi.fn(async () => ({ id: "vs_1", url: "https://verify.stripe/abc" })) } },
    checkout:     { sessions: { create: vi.fn(async () => ({ url: "https://pay.stripe/xyz" })) } },
    accounts:     { create: vi.fn(async () => ({ id: "acct_1" })) },
    accountLinks: { create: vi.fn(async () => ({ url: "https://connect.stripe/onb" })) },
  };
  const StripeClass = vi.fn(function () { return stripeInstance; });

  return { sendMessage, updateMock, setMock, sessionData, collectionMock, checkrInvite, StripeClass };
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
  createCheckrInvitation: (...a: unknown[]) => hoisted.checkrInvite(...a),
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
  hoisted.sessionData.onboardingStep = "caregiver_awaiting_bgcheck";
  hoisted.sessionData.caregiverId = "cg-1";
  hoisted.sessionData.bgcheckInviteUrl = "https://apply.checkr.com/invite/abc";
  hoisted.sessionData.onboardingData = { name: "Jane Doe", email: "jane@x.com" };
});

function lastLinkPart() {
  const call = hoisted.sendMessage.mock.calls.at(-1);
  return (call?.[1] as any)?.parts?.[0];
}

describe("resendStuckStep — Checkr invite reuse (Fix 2)", () => {
  it("reuses the cached bgcheckInviteUrl instead of POSTing a new Checkr invitation", async () => {
    const { resendStuckStep } = await import("./onboardingConversation");
    const ok = await resendStuckStep("+15551112222");

    expect(ok).toBe(true);
    // The core assertion: no duplicate Checkr candidate minted.
    expect(hoisted.checkrInvite).not.toHaveBeenCalled();
    // The cached link is re-sent as a canonical link part.
    expect(lastLinkPart()).toEqual({ type: "link", value: "https://apply.checkr.com/invite/abc" });
    // Step is (re)parked at awaiting.
    expect(hoisted.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingStep: "caregiver_awaiting_bgcheck" })
    );
  }, 20_000);

  it("falls through to a fresh Checkr POST (exactly once) when no invite was ever cached", async () => {
    delete (hoisted.sessionData as any).bgcheckInviteUrl;
    const { resendStuckStep } = await import("./onboardingConversation");
    await resendStuckStep("+15551112222");

    // Retry-as-designed: with no cached URL the fresh-POST path runs exactly once...
    expect(hoisted.checkrInvite).toHaveBeenCalledTimes(1);
    // ...candidate-first with the session's email + work location — the exact
    // request shape Checkr requires. The 2026-07-07 launch blocker was an
    // invitation POST with no candidate/email; this pins the fix. (The old test
    // mocked the HTTP response and never inspected the request — a regression
    // here was invisible.)
    expect(hoisted.checkrInvite).toHaveBeenCalledWith(expect.objectContaining({
      firstName:   "Jane",
      lastName:    "Doe",
      email:       "jane@x.com",
      workState:   "CA",
      packageSlug: expect.any(String),
    }));
    // ...and the NEW invitation URL is re-cached for future resends.
    expect(hoisted.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ bgcheckInviteUrl: "https://new/x" })
    );
  }, 20_000);

  it("re-points the pre-created caregiver doc at the NEW candidate on a fresh POST", async () => {
    // Restart / expired-invite scenario: cache cleared, but the doc (and its old
    // checkrCandidateId) still exist. The webhook matches on checkrCandidateId,
    // so the doc must follow the invitation the caregiver will actually complete.
    delete (hoisted.sessionData as any).bgcheckInviteUrl;
    const { resendStuckStep } = await import("./onboardingConversation");
    await resendStuckStep("+15551112222");

    expect(hoisted.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ "backgroundCheckData.checkrCandidateId": "cand_new" })
    );
  }, 20_000);
});

describe("resendStuckStep — stripeAccountId mirrored onto caregiver doc (Fix 1)", () => {
  it("merges { stripeAccountId, phone } onto caregivers/{caregiverId} so the Connect webhook can match", async () => {
    hoisted.sessionData.onboardingStep = "caregiver_awaiting_stripe";
    const { resendStuckStep } = await import("./onboardingConversation");
    await resendStuckStep("+15551112222");

    // THE Fix 1 write: without it the account.updated webhook can never match
    // this caregiver and activation depends 100% on the browser hitting /done.
    expect(hoisted.setMock).toHaveBeenCalledWith(
      { stripeAccountId: "acct_1", phone: "+15551112222" },
      { merge: true },
    );
    // And the Connect link still goes out.
    expect(lastLinkPart()).toEqual({ type: "link", value: "https://connect.stripe/onb" });
  }, 20_000);
});

describe("advanceOnboardingStep — double-fire guard (Fix 1)", () => {
  // With Fix 1 the Connect webhook can now match and fire advanceOnboardingStep,
  // so BOTH triggers (webhook + the /done callable) can fire for the same
  // stripe_connect completion. The existing processedWebhookTasks guard must make
  // the second call a no-op — no duplicate celebration/activation messages.
  it("no-ops (no celebration sent) when the task was already processed", async () => {
    (hoisted.sessionData as any).processedWebhookTasks = ["stripe_connect"];
    const { advanceOnboardingStep } = await import("./onboardingConversation");
    await advanceOnboardingStep("+15551112222", "stripe_connect", "");

    // Early return before any finalization work: nothing sent, nothing written.
    expect(hoisted.sendMessage).not.toHaveBeenCalled();
    expect(hoisted.updateMock).not.toHaveBeenCalled();
  }, 20_000);

  // Step guard: a completed Connect account must NOT finalize a caregiver whose
  // session isn't parked at the Connect step — e.g. an early payout link minted
  // by the agent tool while the background check is still pending would
  // otherwise activate them with a "background check came back clear" text.
  it("refuses to finalize when the session is not at the Connect step", async () => {
    hoisted.sessionData.onboardingStep = "caregiver_awaiting_bgcheck"; // check still pending
    delete (hoisted.sessionData as any).processedWebhookTasks;
    const { advanceOnboardingStep } = await import("./onboardingConversation");
    await advanceOnboardingStep("+15551112222", "stripe_connect", "");

    expect(hoisted.sendMessage).not.toHaveBeenCalled();
    expect(hoisted.updateMock).not.toHaveBeenCalled();
    expect(hoisted.setMock).not.toHaveBeenCalled();
  }, 20_000);
});
