import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-03 fix: admin_identity_override / admin_payment_override
// (functions/src/agents/onboardingConversation.ts, invoked from the admin
// panel via functions/src/triggers/adminAdvanceQueue.ts) used to gate the
// ENTIRE thing — including the users/{uid} data write — behind the client's
// SMS session being at the exact step expecting it (client_awaiting_identity
// / client_send_payment / client_awaiting_payment). If the session was
// already off that step for any reason (including the stuck-session bug
// this same commit fixes elsewhere), an admin's approval click silently did
// nothing at all: no error, no field written, no sign anything was wrong.
//
// An admin approving a family's identity/membership is a fact about their
// ACCOUNT, not something that should depend on where their SMS conversation
// happens to be parked — so the data write must always happen; only the
// conversational follow-up (announce it, advance the session) stays
// conditional on the session actually being at the moment expecting it.
// These tests lock in that the data write is now unconditional.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && Array.isArray((v as any).__arrayUnion)) {
      const prev = Array.isArray(cur[k]) ? cur[k] : [];
      cur[k] = [...prev, ...(v as any).__arrayUnion.filter((x: unknown) => !prev.includes(x))];
      return;
    }
    if (v && typeof v === "object" && (v as any).__serverTimestamp) { cur[k] = "<ts>"; return; }
    cur[k] = v;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
      for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
      docState.set(path, base);
    }),
    update: vi.fn(async (data: any) => {
      const cur = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
      docState.set(path, cur);
    }),
  });
  const makeCollRef = (path: string): any => ({ doc: (id: string) => makeDocRef(`${path}/${id}`) });

  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    getUserByPhoneNumber: vi.fn(async () => { throw new Error("no auth user"); }),
    reset: () => { docState.clear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
    },
  });
  const authFn = () => ({ getUserByPhoneNumber: hoisted.getUserByPhoneNumber });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn, auth: authFn };
  return { __esModule: true, default: stub, ...stub };
});

// Peripheral stubs so onboardingConversation.ts's module graph loads — see
// clientMembershipCustomerLink.test.ts (same directory) for the established
// pattern this mirrors.
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
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  signalThinking: vi.fn(async () => {}),
}));
vi.mock("../commitmentTracker", () => ({ recordCommitment: vi.fn(async () => "c1"), resolveCommitment: vi.fn(async () => {}) }));
vi.mock("../../utils/linkRedirects", () => ({ createBrandedLink: vi.fn(async (_k: string, url: string) => url) }));
vi.mock("../tokenService", () => ({ generateToken: () => "tok-123" }));

import { advanceOnboardingStep } from "../onboardingConversation";

const PHONE = "+15551112222";
const UID = "uid-1";

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
});

describe("admin_identity_override — data write no longer gated on session step", () => {
  it("writes identityCheckStatus even when the session is stuck on an unrelated earlier step", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      userId: UID,
      onboardingStep: "client_confirm_intake", // NOT client_awaiting_identity
      onboardingData: {},
    });
    await advanceOnboardingStep(PHONE, "admin_identity_override", "");
    expect(hoisted.docState.get(`users/${UID}`)).toMatchObject({ identityCheckStatus: "verified" });
    // Session wasn't at the moment expecting this — no SMS follow-up sent.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // The "session IS at client_awaiting_identity" branch is unchanged
  // pre-existing behavior (it already sent the SMS follow-up before this fix)
  // and drags in a real Stripe checkout call via handleClientSendPayment —
  // out of scope for a test whose job is to lock in the NEW unconditional
  // data write, not re-verify unrelated existing behavior.

  it("does not crash and writes nothing when no uid can be resolved", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      onboardingStep: "client_confirm_intake",
      onboardingData: {},
    });
    await expect(advanceOnboardingStep(PHONE, "admin_identity_override", "")).resolves.not.toThrow();
    expect(hoisted.docState.has(`users/${UID}`)).toBe(false);
  });
});

describe("admin_payment_override — data write no longer gated on session step", () => {
  it("writes membershipStatus even when the session is stuck on an unrelated earlier step", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      userId: UID,
      onboardingStep: "client_ask_plan", // NOT client_send_payment / client_awaiting_payment
      onboardingData: {},
    });
    await advanceOnboardingStep(PHONE, "admin_payment_override", "");
    expect(hoisted.docState.get(`users/${UID}`)).toMatchObject({
      membershipStatus: "active",
      subscriptionActive: true,
    });
  });

  it("does not crash and writes nothing when no uid can be resolved", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: "chat-1",
      onboardingStep: "client_ask_plan",
      onboardingData: {},
    });
    await expect(advanceOnboardingStep(PHONE, "admin_payment_override", "")).resolves.not.toThrow();
    expect(hoisted.docState.has(`users/${UID}`)).toBe(false);
  });
});
