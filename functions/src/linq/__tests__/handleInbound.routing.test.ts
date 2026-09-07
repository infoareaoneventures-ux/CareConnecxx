// Characterization tests for handleInbound's routing SPINE (webhooks.ts).
//
// These pin the ORDER of the top-level guards — opt-out before crisis,
// onboarding before rate-limit, pending approvals before the shift-offer
// interception, degraded-classifier handling — because that order IS the
// product behavior. They exist so the planned decomposition of handleInbound
// can prove, branch by branch, that nothing moved. If one of these fails
// after a refactor, the refactor changed Evia's behavior.
//
// Every collaborator module is mocked; assertions are "which handler fired"
// (and which did NOT), not message wording.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const updates: Array<{ path: string; data: any }> = [];

  // Real Firestore's `{merge: true}` merges nested maps field-by-field rather than
  // replacing them wholesale (e.g. .set({onboardingData: {seniorName: "X"}}, {merge:
  // true}) adds seniorName into the existing onboardingData map instead of dropping
  // its other keys). A shallow {...prev, ...data} spread doesn't reproduce that for
  // nested-object values, so deep-merge plain objects one level of recursion at a
  // time — matching the semantics the persistence net (webhooks.ts) actually relies on.
  function deepMergePlainObjects(prev: any, data: any): any {
    const out: any = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(data ?? {})) {
      const prevVal = out[k];
      const bothPlainObjects =
        v !== null && typeof v === "object" && !Array.isArray(v) &&
        prevVal !== null && typeof prevVal === "object" && !Array.isArray(prevVal);
      out[k] = bothPlainObjects ? deepMergePlainObjects(prevVal, v) : v;
    }
    return out;
  }

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? deepMergePlainObjects(docState.get(path), data) : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc     = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return {
        empty: items.length === 0,
        size:  items.length,
        docs:  items.map((d: any, i: number) => ({
          id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`),
        })),
      };
    });
    ref.add = vi.fn(async (data: any) => {
      docState.set(`${path}/auto-add`, data);
      return { id: "auto-add" };
    });
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));

  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      delete:     () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment:  (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: {
      now:      () => ({ __ts: "now" }),
      fromDate: (d: Date) => ({ __ts: d }),
    },
  });

  return {
    docState, collState, updates, collection, firestoreFn,
    reset: () => { docState.clear(); collState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: hoisted.firestoreFn,
}));

// Private-beta gate (functions/src/config/phoneAllowlist.ts) — these tests pin
// routing behavior, not the beta allowlist, so every fixture phone passes it.
vi.mock("../../config/phoneAllowlist", () => ({ isPhoneAllowed: vi.fn(() => true) }));

// ── Linq client + messaging ──────────────────────────────────────────────────
const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const sendToPhone = vi.fn(async (..._a: any[]) => ({ message_id: "m2" }));
vi.mock("../client", () => ({
  sendMessage:      (...a: any[]) => sendMessage(...a),
  sendToPhone:      (...a: any[]) => sendToPhone(...a),
  startTyping:      vi.fn(async () => {}),
  stopTyping:       vi.fn(async () => {}),
  shareContactCard: vi.fn(async () => {}),
  checkCapability:  vi.fn(async () => true),
  markChatRead:     vi.fn(async () => {}),
}));
vi.mock("../threadMirror", () => ({
  mirrorToWebThread: vi.fn(async () => {}),
  extractMirrorText: vi.fn(() => ""),
}));

// ── Routing collaborators (the spine asserts on these) ──────────────────────
const classifyIntentDetailed = vi.fn(async (..._a: any[]) => ({ intent: "QUESTION", degraded: false }));
vi.mock("../../agents/intentClassifier", () => ({
  classifyIntentDetailed: (...a: any[]) => classifyIntentDetailed(...a),
  classifyIntent: vi.fn(async () => "QUESTION"),
  // Real (pure, no side effects) implementation — routeIntent.ts's
  // FIND_CAREGIVER branch calls this directly as a safety net.
  isCaregiverSearchMisroutedAsProviderSearch: (intent: string, text: string) =>
    intent === "FIND_NEARBY_PROVIDER" && /\bcaregivers?\b/i.test(text),
}));

const runQaAgent          = vi.fn(async (..._a: any[]) => "qa reply");
const runQuickReply       = vi.fn(async (..._a: any[]) => "quick reply");
const isTrivialQuickReply = vi.fn((..._a: any[]) => false);
vi.mock("../../agents/qaAgent", () => ({
  runQaAgent:          (...a: any[]) => runQaAgent(...a),
  runQuickReply:       (...a: any[]) => runQuickReply(...a),
  isTrivialQuickReply: (...a: any[]) => isTrivialQuickReply(...a),
}));

const getAllPending          = vi.fn(async (..._a: any[]): Promise<any[]> => []);
const handlePendingApprovals = vi.fn(
  async (..._a: any[]): Promise<{ outcome: "handled" | "fallthrough" }> => ({ outcome: "fallthrough" })
);
vi.mock("../../agents/pendingActions", () => ({
  getAllPending: (...a: any[]) => getAllPending(...a),
}));
vi.mock("../../agents/approvalHandler", () => ({
  handlePendingApprovals: (...a: any[]) => handlePendingApprovals(...a),
}));

const handleShiftOfferReply = vi.fn(async (..._a: any[]): Promise<"handled" | "fallthrough"> => "fallthrough");
vi.mock("../../agents/shiftOffer", () => ({
  handleShiftOfferReply: (...a: any[]) => handleShiftOfferReply(...a),
}));

const optOutPhoneNumber = vi.fn(async (..._a: any[]) => {});
const optInPhoneNumber  = vi.fn(async (..._a: any[]) => {});
vi.mock("../../sms", () => ({
  optOutPhoneNumber:   (...a: any[]) => optOutPhoneNumber(...a),
  optInPhoneNumber:    (...a: any[]) => optInPhoneNumber(...a),
  setupCaraContactCard: vi.fn(async () => {}),
}));

const handleOnboardingStep   = vi.fn(async (..._a: any[]) => {});
const sendBgCheckRenewalLink = vi.fn(async (..._a: any[]) => {});
const continueAfterClientCollection = vi.fn(async (..._a: any[]) => {});
const absorbClientFields     = vi.fn(async (..._a: any[]) => ({}));
const drivePostCollectionHandoff = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/onboardingConversation", () => ({
  handleOnboardingStep:   (...a: any[]) => handleOnboardingStep(...a),
  sendBgCheckRenewalLink: (...a: any[]) => sendBgCheckRenewalLink(...a),
  continueAfterClientCollection: (...a: any[]) => continueAfterClientCollection(...a),
  absorbClientFields:     (...a: any[]) => absorbClientFields(...a),
  drivePostCollectionHandoff: (...a: any[]) => drivePostCollectionHandoff(...a),
  // Gate-handoff caregiver doc pre-create (P0-C). null = no uid resolved, so
  // the handoff proceeds without patching session.caregiverId - the __RESUME__
  // routing under test is unaffected.
  ensureCaregiverDocForOnboarding: vi.fn(async () => null),
  // Cold-consent bare account creation — null = no uid resolved, so the
  // cold-inbound consent-gate tests assert on onboardingStep/optedIn without
  // depending on a real Firebase Auth mock.
  createFirebaseAuthAccount: vi.fn(async () => null),
}));

const absorbCaregiverFields = vi.fn(async (..._a: any[]) => ({}));
vi.mock("../../agents/caregiverFieldAbsorber", () => ({
  absorbCaregiverFields: (...a: any[]) => absorbCaregiverFields(...a),
}));

const detectCrisis      = vi.fn((..._a: any[]): string | null => null);
const isLikelyRealCrisis = vi.fn(async (..._a: any[]) => true);
const classifyCrisisMultilingual = vi.fn(async (..._a: any[]): Promise<string | null> => null);
vi.mock("../../safety/crisisDetector", () => ({
  detectCrisis:       (...a: any[]) => detectCrisis(...a),
  isLikelyRealCrisis: (...a: any[]) => isLikelyRealCrisis(...a),
  classifyCrisisMultilingual: (...a: any[]) => classifyCrisisMultilingual(...a),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "NONE");
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: (...a: any[]) => quickComplete(...a),
}));

const parseWithClaude = vi.fn(async (..._a: any[]) => "none");
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: any[]) => parseWithClaude(...a),
}));

const isQuestionOrOther = vi.fn(async (..._a: any[]) => false);
vi.mock("../../agents/stepHandler", () => ({
  isQuestionOrOther: (...a: any[]) => isQuestionOrOther(...a),
}));

const answerHumanQuestionOnly = vi.fn(async (..._a: any[]) => "Good question — you're in two care groups, so I just need to know which senior you mean.");
vi.mock("../../agents/humanReply", () => ({
  answerHumanQuestionOnly: (...a: any[]) => answerHumanQuestionOnly(...a),
}));

const handleToolCall = vi.fn(async (..._a: any[]) => ({ success: true, notification: { sent: true } }));
vi.mock("../../mcp/server", () => ({
  handleToolCall: (...a: any[]) => handleToolCall(...a),
}));

// ── Inert collaborators (must load, never fire in these scenarios) ──────────
vi.mock("../../agents/taskApprovalHandler", () => ({ handleTaskApproval: vi.fn(async () => {}) }));
vi.mock("../../agents/permissionsConversation", () => ({
  handleClientPermissionsReply:    vi.fn(async () => {}),
  handleCaregiverPermissionsReply: vi.fn(async () => {}),
  updatePermissionFromText:        vi.fn(async () => true),
  getPermissions:                  vi.fn(async () => ({})),
}));
vi.mock("../../agents/interviewAgent", () => ({
  handleInterviewSelection:         vi.fn(async () => {}),
  handleInterviewConfirm:           vi.fn(async () => {}),
  handleCaregiverAvailabilityReply: vi.fn(async () => {}),
  writeInterviewOutcomeSignal:      vi.fn(async () => {}),
}));
vi.mock("../../agents/bookingExecutor", () => ({
  executeBookings:   vi.fn(async () => {}),
  createBookingTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../triggers/triggerEngine", () => ({ cancelTriggerIfUserReplied: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logCrisisDetected: vi.fn(async () => {}) }));
vi.mock("../../agents/bereavement", () => ({
  isBereavementTrigger:   vi.fn(() => false),
  activateBereavementMode: vi.fn(async () => {}),
}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../agents/profileCompleteness", () => ({
  classifyCompleteness: vi.fn(() => "ONBOARDED"),
  classifyOfferReply:   vi.fn(async () => "question"),
  markOfferAccepted:    vi.fn(async () => {}),
  markOfferDeclined:    vi.fn(async () => {}),
  sendOnboardingOffer:  vi.fn(async () => {}),
  shouldReoffer:        vi.fn(() => false),
}));
vi.mock("../../agents/jobPostingFlow", () => ({
  handleJobPostingStep: vi.fn(async () => {}),
  startJobPostingFlow:  vi.fn(async () => {}),
}));
vi.mock("../../agents/modifyScheduleFlow", () => ({
  startModifyScheduleFlow:  vi.fn(async () => {}),
  handleModifyScheduleStep: vi.fn(async () => {}),
}));
vi.mock("../../agents/refundHandler", () => ({ handleRefundRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/timesheetHandler", () => ({ handleTimesheetApproval: vi.fn(async () => {}) }));
vi.mock("../../agents/earningsHandler", () => ({ handleEarningsView: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverSwapHandler", () => ({
  handleCaregiverSwapRequest: vi.fn(async () => {}),
  handleSwapAcceptance:       vi.fn(async () => {}),
}));
vi.mock("../../agents/clientSwapRequestHandler", () => ({ handleClientSwapRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({
  handleCaregiverProfileUpdate: vi.fn(async () => {}),
  profileFieldFromIntent:       vi.fn(() => null),
}));
// 2026-09-04: gates the trivial quick-reply bypass — default to "no active
// flow" so existing routing assertions are unaffected; overridden per-test.
const hasActiveSmsFlow = vi.fn((..._a: any[]) => false);
vi.mock("../../utils/sessionState", () => ({
  STATE_MACHINE_FLAGS: ["stateExpiresAt"],
  clearAllStateFlags:  vi.fn(async () => {}),
  claimInboundProcessing:   vi.fn(async () => true),
  releaseInboundProcessing: vi.fn(async () => {}),
  INBOUND_LOCK_TTL_MS: 90_000,
  // Merged in from cara-100: routeIntent now sweeps stale high-stakes confirm
  // flags. Default to none stale so existing routing assertions are unaffected.
  staleConfirmFlags: vi.fn(() => []),
  HIGH_STAKES_CONFIRM_FLAGS: ["pendingInterviewConfirm", "pendingCancelConfirm", "awaitingRecurringConfirmation"],
  CONFIRM_FLAG_TTL_MS: 60 * 60 * 1000,
  // Job-invite + multi-step flow freshness (2026-07-15). Default to fresh so
  // existing routing assertions are unaffected.
  isJobInviteStale: vi.fn(() => false),
  JOB_INVITE_FLAGS: ["awaitingJobResponse", "awaitingAvailabilityConfirmation", "pendingJobId", "pendingJobSentAt"],
  JOB_INVITE_TTL_MS: 48 * 60 * 60 * 1000,
  isFlowStale: vi.fn(() => false),
  MULTI_STEP_FLOW_TTL_MS: 24 * 60 * 60 * 1000,
  CREDENTIAL_FLOW_TTL_MS: 30 * 60 * 1000,
  hasActiveSmsFlow: (...a: any[]) => hasActiveSmsFlow(...a),
}));
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg"),
}));
vi.mock("../../utils/dndGuard", () => ({ sendIfNotDND: vi.fn(async () => {}) }));
vi.mock("../../ai/feedback", () => ({ writeFeedbackSignal: vi.fn(async () => {}) }));
vi.mock("../../triggers/jobNotifications", () => ({
  handleJobResponse:            vi.fn(async () => {}),
  handleAvailabilityConfirmation: vi.fn(async () => {}),
}));
vi.mock("../../memory/zepClient", () => ({
  initializeZepOnFirstContact: vi.fn(async () => {}),
  addUserMessageToZep:         vi.fn(async () => {}),
  addAssistantMessageToZep:    vi.fn(async () => {}),
  addBusinessDataToZep:        vi.fn(async () => {}),
  searchZepMemory:             vi.fn(async () => []),
  getZepUserId:                vi.fn(() => "zep-1"),
}));
vi.mock("../../memory/learnedFacts", () => ({
  extractAndStoreFacts:     vi.fn(async () => {}),
  detectAndStageFactChange: vi.fn(async () => ({ kind: "not_correction" })),
  factChangeAckCopy: vi.fn(() => null),
  findTombstonedRestatement: vi.fn(async () => null),
  classifyReRememberReply: vi.fn(async () => "other"),
  confirmReRemember: vi.fn(async () => ({ ok: false, reason: "not_found" })),
}));
vi.mock("../../utils/voiceTranscription", () => ({
  extractVoiceMemoPart: vi.fn(() => null),
  transcribeVoiceMemo:  vi.fn(async () => ""),
}));
const extractLocationPart = vi.fn((..._a: any[]): any => null);
const reverseGeocode      = vi.fn(async (..._a: any[]): Promise<any> => null);
vi.mock("../../utils/locationShare", () => ({
  extractLocationPart: (...a: any[]) => extractLocationPart(...a),
  reverseGeocode:      (...a: any[]) => reverseGeocode(...a),
}));
const extractMediaPart = vi.fn((..._a: any[]): any => null);
vi.mock("../../utils/mediaIntake", () => ({
  extractMediaPart:  (...a: any[]) => extractMediaPart(...a),
  downloadMedia:     vi.fn(async () => null),
  storeInboundMedia: vi.fn(async () => null),
}));
vi.mock("../../utils/visionVerify", () => ({ classifyMedia: vi.fn(async () => null) }));
vi.mock("../../utils/personaShiftDetector", () => ({ detectPersonaShift: vi.fn(async () => null) }));
vi.mock("../../utils/knownNames", () => ({ collectKnownNames: vi.fn(async () => []) }));
vi.mock("../../utils/language", () => ({
  detectLanguage:      vi.fn(async () => "en"),
  languageFromSession: vi.fn(() => "en"),
  flowLabel:           vi.fn((x: unknown) => String(x)),
  t: new Proxy({}, { get: (_t, prop) => () => `[${String(prop)}]` }),
}));

import { handleInbound, userHasRealOnboardingProgress, resolvePrimarySeniorId } from "../webhooks";

const PHONE = "+15550001111";
const CHAT  = "chat-1";

function makeEvent(text: string, opts: { health?: string; parts?: any[]; phone?: string | null } = {}) {
  return {
    data: {
      sender_handle: opts.phone === null ? {} : { handle: opts.phone ?? PHONE },
      chat: { id: CHAT, service: "SMS", health_status: { status: opts.health ?? "HEALTHY" } },
      service: "SMS",
      parts: opts.parts ?? [{ type: "text", value: text }],
    },
  };
}

function seedSession(overrides: Record<string, unknown> = {}) {
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    chatId: CHAT,
    userType: "client",
    onboardingStep: "complete",
    userId: "u1",
    optedOut: false,
    ...overrides,
  });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  // Re-arm defaults cleared by clearAllMocks
  classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
  runQaAgent.mockResolvedValue("qa reply");
  runQuickReply.mockResolvedValue("quick reply");
  isTrivialQuickReply.mockReturnValue(false);
  hasActiveSmsFlow.mockReturnValue(false);
  getAllPending.mockResolvedValue([]);
  handlePendingApprovals.mockResolvedValue({ outcome: "fallthrough" });
  handleShiftOfferReply.mockResolvedValue("fallthrough");
  detectCrisis.mockReturnValue(null);
  isLikelyRealCrisis.mockResolvedValue(true);
  classifyCrisisMultilingual.mockResolvedValue(null);
  quickComplete.mockResolvedValue("NONE");
  parseWithClaude.mockResolvedValue("none");
  handleToolCall.mockResolvedValue({ success: true, notification: { sent: true } });
  sendMessage.mockResolvedValue({ message_id: "m1" });
  extractLocationPart.mockReturnValue(null);
  reverseGeocode.mockResolvedValue(null);
  extractMediaPart.mockReturnValue(null);
});

describe("pre-checks", () => {
  it("drops events with no sender phone before touching anything", async () => {
    await handleInbound(makeEvent("hello", { phone: null }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(hoisted.collection).not.toHaveBeenCalled();
  });

  it("media-only message (sticker) gets a warm ack and never reaches routing", async () => {
    seedSession();
    await handleInbound(makeEvent("", { parts: [{ type: "sticker" }] }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("Love it");
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

describe("opt-out protocol (order: health gate -> START re-opt-in -> STOP)", () => {
  it("Linq OPTED_OUT health marks the session opted out and stays silent", async () => {
    seedSession();
    await handleInbound(makeEvent("hello", { health: "OPTED_OUT" }));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedOut: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("opted-out + START opts back in (terminal)", async () => {
    seedSession({ optedOut: true });
    await handleInbound(makeEvent("START"));
    expect(optInPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("opted-out + anything else stays completely silent", async () => {
    seedSession({ optedOut: true });
    await handleInbound(makeEvent("hello are you there?"));
    expect(optInPhoneNumber).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("STOP opts out and terminates (never reaches intent routing)", async () => {
    seedSession();
    await handleInbound(makeEvent("STOP"));
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

// Sessions seeded by the onUserCreated auth trigger (web signup) carry
// optedIn:false and no onboardingStep — the reply to the TCPA consent ask must
// be handled BEFORE any other routing, or consent is never recorded and every
// proactive sender skips the user forever.
describe("pending TCPA consent (optedIn:false, web-signup auth trigger)", () => {
  function seedPendingConsentSession(overrides: Record<string, unknown> = {}) {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId:   CHAT,
      userId:   "u1",
      seniorId: "u1",
      service:  "SMS",
      optedOut: false,
      optedIn:  false,
      ...overrides,
    });
  }

  it("YES records consent and routes a fresh client into name-first onboarding", async () => {
    seedPendingConsentSession();
    hoisted.docState.set("users/u1", { firstName: "Basra Yousuf", userType: "client" });
    parseWithClaude.mockResolvedValueOnce("yes");

    await handleInbound(makeEvent("Yes please"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      optedIn:        true,
      userType:       "client",
      onboardingStep: "client_confirm_name",
      onboardingData: { firstName: "Basra" },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("Basra");
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("YES from a client with real progress marks the session complete and greets them", async () => {
    seedPendingConsentSession();
    hoisted.docState.set("users/u1", { firstName: "Basra", userType: "client", seniorId: "senior-1" });
    parseWithClaude.mockResolvedValueOnce("yes");

    await handleInbound(makeEvent("YES"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      optedIn:        true,
      onboardingStep: "complete",
      seniorId:       "senior-1",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("STOP during pending consent opts out (carrier protocol wins)", async () => {
    seedPendingConsentSession();
    await handleInbound(makeEvent("STOP"));
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedIn: false });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("refusal opts out instead of silently staying pending", async () => {
    seedPendingConsentSession();
    parseWithClaude.mockResolvedValueOnce("no");
    await handleInbound(makeEvent("no thanks"));
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("non-answer gets ONE re-ask, then goes quiet (deny-by-default)", async () => {
    seedPendingConsentSession();
    parseWithClaude.mockResolvedValueOnce("other");
    await handleInbound(makeEvent("when is the caregiver coming?"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ consentReaskCount: 1 });

    sendMessage.mockClear();
    parseWithClaude.mockResolvedValueOnce("other");
    await handleInbound(makeEvent("hello?"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedIn: false });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("a later YES after going quiet still opts them in", async () => {
    seedPendingConsentSession({ consentReaskCount: 1 });
    hoisted.docState.set("users/u1", { firstName: "Basra", userType: "client" });
    parseWithClaude.mockResolvedValueOnce("yes");
    await handleInbound(makeEvent("YES"));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedIn: true });
  });
});

// A truly cold text — no agent_sessions doc, no web_onboarding_sessions bridge
// — now gates behind explicit consent (Terms/Privacy + SMS) before anything
// else happens, mirroring the website's "I agree to the terms" checkbox.
// Role is never known at this point, so YES hands off to ask_role rather than
// assuming a role the way the web-signup consent handler does.
describe("cold inbound (no prior session) — consent gate", () => {
  function seedColdConsentSession(overrides: Record<string, unknown> = {}) {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      service: "SMS",
      userType: null,
      onboardingStep: "cold_awaiting_consent",
      optedOut: false,
      optedIn: false,
      ...overrides,
    });
  }

  it("a truly cold text gets a consent ask, not the role question", async () => {
    await handleInbound(makeEvent("Hey"));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      optedIn:        false,
      onboardingStep: "cold_awaiting_consent",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = String(sendMessage.mock.calls[0][1]);
    expect(sent).toContain("eviacares.com");
    expect(sent).not.toContain("caregiver yourself");
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("YES opts in and asks role (not a hardcoded client assumption)", async () => {
    seedColdConsentSession();
    parseWithClaude.mockResolvedValueOnce("yes");
    await handleInbound(makeEvent("Yes please"));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      optedIn:        true,
      onboardingStep: "ask_role",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("caregiver yourself");
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("STOP during cold consent opts out (carrier protocol wins)", async () => {
    seedColdConsentSession();
    await handleInbound(makeEvent("STOP"));
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedIn: false });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("refusal opts out instead of silently staying pending", async () => {
    seedColdConsentSession();
    parseWithClaude.mockResolvedValueOnce("no");
    await handleInbound(makeEvent("no thanks"));
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("non-answer gets ONE re-ask, then goes quiet (deny-by-default)", async () => {
    seedColdConsentSession();
    parseWithClaude.mockResolvedValueOnce("other");
    await handleInbound(makeEvent("who is this?"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ consentReaskCount: 1 });

    sendMessage.mockClear();
    parseWithClaude.mockResolvedValueOnce("other");
    await handleInbound(makeEvent("hello?"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({ optedIn: false });
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

describe("safety + account gates", () => {
  it("lapsed-subscription client gets the billing notice and nothing else", async () => {
    seedSession();
    hoisted.docState.set("users/u1", { subscriptionStatus: "past_due" });
    await handleInbound(makeEvent("can you book someone for tomorrow?"));
    expect(String(sendMessage.mock.calls[0][1])).toContain("billing");
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("verified crisis is terminal: crisis message sent, NOTIFY armed, QA never runs", async () => {
    seedSession();
    detectCrisis.mockReturnValue("medical");
    isLikelyRealCrisis.mockResolvedValue(true);
    await handleInbound(makeEvent("he fell and is not breathing"));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).pendingCrisisNotify).toBeTruthy();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("verified medical crisis creates an admin-visible safety alert and runs no healthcare action (R7)", async () => {
    seedSession();
    detectCrisis.mockReturnValue("medical");
    isLikelyRealCrisis.mockResolvedValue(true);
    await handleInbound(makeEvent("he's having chest pain right now"));
    // Admin_alerts safety alert is created (Control-Room-visible), critical severity.
    expect(hoisted.docState.get("admin_alerts/auto-add"))
      .toMatchObject({ type: "cara_medical_emergency", severity: "critical" });
    // Never attempts a healthcare action / QA tool loop on the emergency path.
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("crisis keyword judged NOT real falls through to the QA agent", async () => {
    seedSession();
    detectCrisis.mockReturnValue("medical");
    isLikelyRealCrisis.mockResolvedValue(false);
    await handleInbound(makeEvent("the movie was to die for"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });

  it("verified emotional crisis sends 988 + consent offer and arms an EMOTIONAL NOTIFY (U3)", async () => {
    seedSession();
    detectCrisis.mockReturnValue("emotional");
    isLikelyRealCrisis.mockResolvedValue(true);
    await handleInbound(makeEvent("I don't want to be here anymore"));
    // 988 message + the consent-aware escalation offer.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).pendingCrisisNotify)
      .toMatchObject({ kind: "emotional" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("emotional NOTIFY reply pages the care team with an emotional alert (U3)", async () => {
    seedSession({ pendingCrisisNotify: { text: "struggling", detectedAt: "now", kind: "emotional" } });
    await handleInbound(makeEvent("NOTIFY"));
    expect(hoisted.docState.get("admin_alerts/auto-add"))
      .toMatchObject({ type: "crisis_notify_requested", severity: "critical", crisisKind: "emotional" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("NOTIFY keyword (armed) pages the care team (U11)", async () => {
    seedSession({ pendingCrisisNotify: { text: "x", detectedAt: "now", kind: "medical" } });
    await handleInbound(makeEvent("NOTIFY please"));
    expect(hoisted.docState.get("admin_alerts/auto-add"))
      .toMatchObject({ type: "crisis_notify_requested" });
  });

  it("'do not notify anyone' does NOT page the care team — no substring misfire (U11)", async () => {
    seedSession({ pendingCrisisNotify: { text: "x", detectedAt: "now", kind: "medical" } });
    await handleInbound(makeEvent("do not notify anyone"));
    expect(hoisted.docState.get("admin_alerts/auto-add")?.type).not.toBe("crisis_notify_requested");
  });

  it("non-English no-keyword message runs the multilingual classifier; emotional → escalation (U2/U3)", async () => {
    seedSession({ preferredLanguage: "es" });
    detectCrisis.mockReturnValue(null);
    classifyCrisisMultilingual.mockResolvedValue("emotional");
    // Accented chars make the non-English gate fire deterministically.
    await handleInbound(makeEvent("siento que ya no puedo más"));
    expect(classifyCrisisMultilingual).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).pendingCrisisNotify)
      .toMatchObject({ kind: "emotional" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("English no-keyword message does NOT invoke the multilingual classifier (cost gate)", async () => {
    seedSession();
    detectCrisis.mockReturnValue(null);
    await handleInbound(makeEvent("can you book someone for next tuesday"));
    expect(classifyCrisisMultilingual).not.toHaveBeenCalled();
  });

  it("caregiver RENEW keyword re-issues the bg-check link (terminal)", async () => {
    seedSession({ userType: "caregiver", caregiverId: "cg1" });
    await handleInbound(makeEvent("RENEW"));
    expect(sendBgCheckRenewalLink).toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

describe("onboarding + rate limit", () => {
  it("new secondary family member session inherits the existing family group chat", async () => {
    hoisted.collState.set("agent_sessions", [{
      id: "+15550009999",
      chatId: "primary-chat",
      groupMembers: [PHONE],
      userId: "u1",
      seniorId: "senior1",
      groupChatId: "family-group-chat",
      onboardingData: { seniorName: "Jane" },
    }]);

    await handleInbound(makeEvent("hi"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      userId: "u1",
      seniorId: "senior1",
      primaryPhone: "+15550009999",
      isSecondaryMember: true,
      groupChatId: "family-group-chat",
    });
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("care coordinator"));
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  // U8: a phone in multiple care groups is no longer dropped with nothing
  // persisted (the old dead-loop bug) — it now gets a pending disambiguation
  // marker so the next inbound's answer has somewhere to land. See the
  // "multi-care-group disambiguation (U8)" describe block below for the full
  // two-turn resolution coverage; this test only pins that the phone is never
  // silently attached to either group without asking.
  it("does not silently attach a secondary member when their phone is in multiple care groups", async () => {
    hoisted.collState.set("family_group_members", [
      { id: "m1", primaryPhone: "+15550001111", memberPhone: PHONE },
      { id: "m2", primaryPhone: "+15550002222", memberPhone: PHONE },
    ]);

    await handleInbound(makeEvent("hi"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.isSecondaryMember).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("more than one care group"));
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("mid-onboarding messages route to handleOnboardingStep, not intent routing", async () => {
    seedSession({ onboardingStep: "caregiver_name" });
    await handleInbound(makeEvent("Jane Doe"));
    expect(handleOnboardingStep).toHaveBeenCalled();
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
  });

  // ── Gate-awaiting step routing (characterization, 2026-07-17) ─────────────
  // The gate-link resend cooldown lives entirely in the SCRIPTED handler
  // (handleOnboardingStep → handleGateLinkKeyword/resendGateLink). These pin
  // the assumption that makes that sufficient: an inbound text while parked at
  // ANY gate-awaiting step routes to the scripted handler and NEVER reaches
  // runQaAgent / runQuickReply / intent classification — so no LLM loop can
  // resend a gate link (or improvise "just resent it") around the cooldown.
  // If a refactor ever routes these turns to the loop, the cooldown gains a
  // bypass and this test is the tripwire.
  describe.each([
    ["caregiver_awaiting_membership", "caregiver"], // representative checkout gate
    ["caregiver_awaiting_mvr",        "caregiver"],
    ["caregiver_awaiting_photo",      "caregiver"],
    ["caregiver_awaiting_documents",  "caregiver"],
    ["caregiver_awaiting_bgcheck",    "caregiver"],
    ["caregiver_awaiting_bgcheck_consent", "caregiver"],
    ["caregiver_awaiting_stripe",     "caregiver"],
    ["client_awaiting_payment",       "client"],
    ["client_awaiting_identity",      "client"],
  ])("gate-awaiting step %s", (step, userType) => {
    it("routes inbound text to the scripted handler — never the QA agent loop", async () => {
      seedSession({
        userType,
        onboardingStep: step,
        ...(userType === "caregiver" ? { caregiverId: "cg1" } : {}),
      });

      await handleInbound(makeEvent("hm ok but where is it"));

      expect(handleOnboardingStep).toHaveBeenCalledTimes(1);
      expect(handleOnboardingStep.mock.calls[0][0]).toBe(PHONE);
      expect(runQaAgent).not.toHaveBeenCalled();
      expect(runQuickReply).not.toHaveBeenCalled();
      expect(classifyIntentDetailed).not.toHaveBeenCalled();
    });
  });

  it("rate-limited phones are dropped silently AFTER onboarding routing", async () => {
    seedSession();
    hoisted.docState.set(`agent_rate/${PHONE}`, {
      calls: Array.from({ length: 120 }, () => Date.now()),
    });
    await handleInbound(makeEvent("hello"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).lastMessageAt).toBeUndefined();
  });

  it("accepted verified SMS stamps lastMessageAt after the rate-limit guard", async () => {
    seedSession();

    await handleInbound(makeEvent("hello"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).lastMessageAt).toEqual({ __serverTimestamp: true });
  });
});

describe("pending-approval gate and shift-offer interception (order-critical)", () => {
  it("a pending approval handled = terminal (no intent classification)", async () => {
    seedSession();
    getAllPending.mockResolvedValue([{ id: "pa1" }]);
    handlePendingApprovals.mockResolvedValue({ outcome: "handled" });
    await handleInbound(makeEvent("yes go ahead"));
    expect(handlePendingApprovals).toHaveBeenCalled();
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
  });

  it("a question during a pending approval falls through so Evia can answer it", async () => {
    seedSession();
    getAllPending.mockResolvedValue([{ id: "pa1" }]);
    handlePendingApprovals.mockResolvedValue({ outcome: "fallthrough" });
    await handleInbound(makeEvent("wait, which appointment is this for?"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });

  it("approvals run BEFORE the caregiver shift-offer interception", async () => {
    seedSession({ userType: "caregiver", caregiverId: "cg1", pendingShiftOfferId: "offer1" });
    getAllPending.mockResolvedValue([{ id: "pa1" }]);
    handlePendingApprovals.mockResolvedValue({ outcome: "handled" });
    await handleInbound(makeEvent("yes"));
    expect(handlePendingApprovals).toHaveBeenCalled();
    expect(handleShiftOfferReply).not.toHaveBeenCalled();
  });

  it("caregiver shift-offer reply handled = terminal", async () => {
    seedSession({ userType: "caregiver", caregiverId: "cg1", pendingShiftOfferId: "offer1" });
    handleShiftOfferReply.mockResolvedValue("handled");
    await handleInbound(makeEvent("YES"));
    expect(handleShiftOfferReply).toHaveBeenCalledWith({ phone: PHONE, chatId: CHAT, text: "YES" });
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
  });

  it("caregiver question about a pending offer falls through to the QA agent (offer stays pending)", async () => {
    seedSession({ userType: "caregiver", caregiverId: "cg1", pendingShiftOfferId: "offer1" });
    handleShiftOfferReply.mockResolvedValue("fallthrough");
    await handleInbound(makeEvent("what is the hourly rate for this shift?"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });
});

describe("QA tail (quick-reply bypass vs full agent)", () => {
  it("routes pending add-family phone replies before intent classification", async () => {
    seedSession({
      seniorId: "senior1",
      pendingAddFamilyMember: { name: "Sarah", phone: null },
    });
    await handleInbound(makeEvent("+1 555 222 3333"));
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
    expect(handleToolCall).toHaveBeenCalledWith("add_family_member", {
      seniorId: "senior1",
      name: "Sarah",
      memberPhone: "+15552223333",
      clientId: "u1",
    });
  });

  it("trivial QUESTION takes the quick-reply bypass, not the full agent", async () => {
    seedSession();
    classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
    isTrivialQuickReply.mockReturnValue(true);
    await handleInbound(makeEvent("thanks!"));
    expect(runQuickReply).toHaveBeenCalledTimes(1);
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("a DEGRADED classification never takes the bypass — full QA agent is the fail-safe", async () => {
    seedSession();
    classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: true });
    isTrivialQuickReply.mockReturnValue(true);
    await handleInbound(makeEvent("thanks!"));
    expect(runQuickReply).not.toHaveBeenCalled();
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });

  it("ordinary client message lands on the full QA agent", async () => {
    seedSession();
    await handleInbound(makeEvent("how do I add my sister to the account?"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });

  // 2026-09-04: found live — a short in-flow reply ("anyone else", "Amina")
  // mid a caregiver-matching flow (pendingMatches active) passed
  // isTrivialQuickReply and hit the no-tool fast path, which then fabricated
  // caregiver names/details from chat history alone. Any active state-machine
  // flow must force the full (tool-grounded) agent, regardless of how
  // trivial the text looks in isolation.
  it("a trivial-looking QUESTION mid an active SMS flow (e.g. pendingMatches) skips the quick-reply bypass", async () => {
    seedSession();
    classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
    isTrivialQuickReply.mockReturnValue(true);
    hasActiveSmsFlow.mockReturnValue(true);
    await handleInbound(makeEvent("Amina"));
    expect(runQuickReply).not.toHaveBeenCalled();
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });
});

// ── Web-onboarding bridge: name capture from /start (U2/U3) ──────────────────
// When the user typed their name on /start, the createWebOnboardingSession
// callable stored it on the web_onboarding_sessions bridge doc. The FIRST inbound
// "Hey Evia" must seed that name into the new agent_sessions doc, route to the
// *_confirm_name step (not *_ask_name), and greet by name. No name → legacy path.
describe("web-onboarding name bridge", () => {
  // Seed a bridge doc + leave agent_sessions empty so the first-contact branch fires.
  function seedWebSession(data: Record<string, unknown>) {
    hoisted.docState.set(`web_onboarding_sessions/${PHONE}`, {
      status: "awaiting_inbound",
      uid: "web-uid",
      ...data,
    });
  }
  const session = () => hoisted.docState.get(`agent_sessions/${PHONE}`);
  const greeting = () => (sendMessage.mock.calls.find((c) => typeof c[1] === "string")?.[1] ?? "") as string;

  it("client with a name → confirm step, seeded firstName, greeted by name", async () => {
    seedWebSession({ role: "client", name: "Sarah" });
    await handleInbound(makeEvent("Hey Evia"));
    expect(session()?.onboardingStep).toBe("client_confirm_name");
    expect(session()?.onboardingData?.firstName).toBe("Sarah");
    expect(greeting()).toContain("Sarah");
  });

  it("caregiver with a name → confirm step, seeded name, greeted by name", async () => {
    seedWebSession({ role: "caregiver", name: "Maria" });
    await handleInbound(makeEvent("Hey Evia"));
    expect(session()?.onboardingStep).toBe("caregiver_confirm_name");
    expect(session()?.onboardingData?.name).toBe("Maria");
    expect(greeting()).toContain("Maria");
  });

  it("no name on the bridge doc → legacy ask-name step, no seeded onboardingData", async () => {
    seedWebSession({ role: "client" });
    await handleInbound(makeEvent("Hey Evia"));
    expect(session()?.onboardingStep).toBe("client_ask_name");
    expect(session()?.onboardingData).toBeUndefined();
  });

  // 2026-09-06: /start now also collects a recovery email up front (parity
  // with Evia's SMS loop, which already requires one for both roles) —
  // seeded the same way name already was, so the loop never asks again.
  describe("recovery email seeding (2026-09-06)", () => {
    it("client with a name AND email → both seeded onto onboardingData", async () => {
      seedWebSession({ role: "client", name: "Sarah", email: "sarah@example.com" });
      await handleInbound(makeEvent("Hey Evia"));
      expect(session()?.onboardingStep).toBe("client_confirm_name");
      expect(session()?.onboardingData?.firstName).toBe("Sarah");
      expect(session()?.onboardingData?.email).toBe("sarah@example.com");
    });

    it("caregiver with a name AND email → both seeded onto onboardingData", async () => {
      seedWebSession({ role: "caregiver", name: "Maria", email: "maria@example.com" });
      await handleInbound(makeEvent("Hey Evia"));
      expect(session()?.onboardingStep).toBe("caregiver_confirm_name");
      expect(session()?.onboardingData?.name).toBe("Maria");
      expect(session()?.onboardingData?.email).toBe("maria@example.com");
    });

    it("email present but NO name → still seeds email, routes to ask-name (not confirm)", async () => {
      seedWebSession({ role: "client", email: "noname@example.com" });
      await handleInbound(makeEvent("Hey Evia"));
      expect(session()?.onboardingStep).toBe("client_ask_name");
      expect(session()?.onboardingData?.email).toBe("noname@example.com");
      expect(session()?.onboardingData?.firstName).toBeUndefined();
    });
  });
});

// ── Onboarding-loop flag routing (pre-flip gate: both-flags interaction) ─────
// ONBOARDING_AGENT_LOOP=client (this loop) and CONVERGENCE_FLIPPED=onboarding
// (the dispatcher's next-field selector) are INDEPENDENT switches. The invariant:
// when the loop flag is on for a client collection step, the turn routes to the
// qaAgent loop and RETURNS before handleOnboardingStep — so the dispatcher never
// also runs and the cursor is never double-resolved. shouldRouteOnboardingToLoop
// + featureFlags are the REAL modules here (not mocked), so env drives routing.
describe("onboarding agent-loop flag routing", () => {
  afterEach(() => {
    delete process.env.ONBOARDING_AGENT_LOOP;
    delete process.env.CONVERGENCE_FLIPPED;
  });

  // Loop-only (2026-07-08): there is no flag and no scripted collection runner —
  // a client collection step ALWAYS routes to the loop.
  it("loop-only: client collection step routes to the loop, scripted runner NOT called", async () => {
    seedSession({ onboardingStep: "client_ask_name" });
    await handleInbound(makeEvent("Sarah"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(runQaAgent.mock.calls[0][0]).toMatchObject({
      onboardingMode: true,
      onboardingRole: "client",
      userType: "client",
    });
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  it("both flags on: loop wins and handleOnboardingStep never runs — no double cursor resolve", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    process.env.CONVERGENCE_FLIPPED   = "onboarding";
    seedSession({ onboardingStep: "client_ask_senior" });
    await handleInbound(makeEvent("My mom Jane"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  // Persistence safety net: the live bug — the loop chats an answer but the model
  // never calls save_onboarding_field, so the field is lost and the cursor sticks.
  // The deterministic extractor must capture it server-side regardless.
  it("persistence net: loop saves nothing → user's answer is still captured", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_name", onboardingData: {} });
    // runQaAgent mock does no Firestore write → onboardingData unchanged this turn.
    absorbClientFields.mockResolvedValueOnce({ seniorName: "Jane" });
    await handleInbound(makeEvent("it's for my mom Jane"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(absorbClientFields).toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData)
      .toMatchObject({ seniorName: "Jane" });
  });

  // U6 (review-validated partial-save gap): the model saved ONE of the three
  // fields present in a front-loaded message (e.g. it called
  // save_onboarding_field for firstName only). The old gate compared
  // Object.keys(curData).length to preData and skipped the net entirely because
  // SOME keys grew — dropping seniorName/age silently. The net must now run
  // whenever required fields are still missing after the turn, regardless of
  // whether the model saved zero or some fields, and absorbClientFields already
  // returns only fields not already in curData, so the model-saved field is
  // never touched/double-written by the net.
  it("persistence net: model saves ONE of three fields present in the text → net persists the rest, none re-asked next turn", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    // Front-loaded "I'm Sarah, my mom Dorothy is 82". With Fix 1 the PRE-turn
    // absorber recovers the two fields the model skips (seniorName/age) and merges
    // them BEFORE the model turn; the model then saves firstName via
    // save_onboarding_field (a MERGE write — the mock must merge onboardingData,
    // not overwrite it, or it would clobber the pre-turn recovery). Either way the
    // final data has all three and nothing is re-asked next turn.
    seedSession({ onboardingStep: "client_ask_name", onboardingData: {} });
    runQaAgent.mockImplementationOnce(async (..._a: any[]) => {
      const prev = hoisted.docState.get(`agent_sessions/${PHONE}`);
      hoisted.docState.set(`agent_sessions/${PHONE}`, {
        ...prev,
        onboardingData: { ...(prev?.onboardingData ?? {}), firstName: "Sarah" },
      });
      return "qa reply";
    });
    // The absorber (pre-turn Fix 1) fills in the two fields the model skipped.
    absorbClientFields.mockResolvedValueOnce({ seniorName: "Dorothy", age: 82 });

    await handleInbound(makeEvent("I'm Sarah, my mom Dorothy is 82"));

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(absorbClientFields).toHaveBeenCalled();
    const finalData = hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData;
    // The model-saved field is untouched AND the recovered fields are present.
    expect(finalData).toMatchObject({ firstName: "Sarah", seniorName: "Dorothy", age: 82 });
  });

  // §0.2 pre-turn service-area gate: at the location step, an unrecognized city
  // with no zip (evaluateServiceArea → "need_zip") must ask for the ZIP and
  // return BEFORE the model turn — so the model can't first compose a "great,
  // that works!" acknowledgment that the gate then contradicts. runQaAgent must
  // therefore NOT run, and the cursor must not advance past collection on an
  // unconfirmed service area.
  it("pre-turn gate: need_zip at the location step asks for ZIP before the model turn and does not advance the cursor", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({
      onboardingStep: "client_ask_location",
      onboardingData: { firstName: "Sarah", seniorName: "Dorothy", age: 82, careNeeds: ["bathing"] },
    });
    // Unrecognized city, no zip → evaluateServiceArea returns "need_zip".
    absorbClientFields.mockResolvedValueOnce({ city: "Nowhereville" });

    await handleInbound(makeEvent("we're in Nowhereville"));

    // Gated BEFORE the model turn — no premature acknowledgment.
    expect(runQaAgent).not.toHaveBeenCalled();
    expect(absorbClientFields).toHaveBeenCalled();
    // Asked for the ZIP.
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("ZIP"));
    // Cursor did NOT advance past collection to the post-collection gate.
    const finalStep = hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingStep;
    expect(finalStep).not.toBe("client_ask_start");
    // No second (contradictory) reply from the scripted runner.
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  // 2d (loop-only): the scripted collection runner no longer exists, so a loop
  // that throws before replying is RETRIED once. On retry success the turn is
  // handled entirely by the loop — the scripted runner is never called.
  it("loop throws before replying → retries the loop once, no scripted fallback", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_name" });
    runQaAgent.mockRejectedValueOnce(new Error("sonnet timeout")); // first attempt throws; retry succeeds
    await handleInbound(makeEvent("Sarah"));
    expect(runQaAgent).toHaveBeenCalledTimes(2);
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  it("loop throws BOTH times → apology sent + admin_alert paged, never silent, never scripted", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_name" });
    runQaAgent.mockRejectedValue(new Error("sonnet down")); // both attempts throw
    await handleInbound(makeEvent("Sarah"));
    expect(runQaAgent).toHaveBeenCalledTimes(2);
    expect(handleOnboardingStep).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("snag"));
    expect(hoisted.docState.get("admin_alerts/auto-add")?.type).toBe("onboarding_loop_failed_after_retry");
  });

  // 2a: a location PIN at a collection step is reverse-geocoded to text and fed to
  // the loop as a normal text turn (works at ANY collection step). The scripted
  // location handler is not involved.
  it("location pin at a collection step is converted to text and routed to the loop", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_needs", onboardingData: { firstName: "Sarah" } });
    extractLocationPart.mockReturnValue({ lat: 37.33, lng: -121.88 });
    reverseGeocode.mockResolvedValue({ city: "San Jose", zipCode: "95112", region: "CA" });

    await handleInbound(makeEvent("", { parts: [{ type: "location", lat: 37.33, lng: -121.88 }] }));

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(String(runQaAgent.mock.calls[0][0].text)).toContain("San Jose");
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  // 2c: a truly empty turn (no text, no parts) at a collection step gets a
  // deterministic "type it out" nudge — the loop never runs on nothing and the
  // scripted runner is not called.
  it("empty turn at a collection step gets a type-it-out nudge, not the loop", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_needs", onboardingData: { firstName: "Sarah" } });

    await handleInbound(makeEvent("", { parts: [] }));

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(handleOnboardingStep).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("couldn't read that"));
  });

  // 2a-media: a photo/document sent WITH a caption at a collection step routes the
  // caption to the loop (the attachment is set aside) instead of falling to the
  // media handler and dropping the caption. Without the fix the caption's fields
  // are lost and the user gets the defensive "I lost that" nudge.
  it("captioned media at a collection step routes the caption text to the loop", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_experience", onboardingData: { name: "Maria" } });
    extractMediaPart.mockReturnValue({ url: "https://x/img.jpg", type: "image" });

    await handleInbound(makeEvent("6 years, mostly dementia", { parts: [{ type: "image", value: "https://x/img.jpg" }, { type: "text", value: "6 years, mostly dementia" }] }));

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(String(runQaAgent.mock.calls[0][0].text)).toContain("6 years");
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });
});

// ── Caregiver onboarding agent-loop routing (dark: flag-gated off) ──────────
// The caregiver mirror of the block above. DEFAULT MUST NOT CHANGE: with
// ONBOARDING_AGENT_LOOP unset (or naming only "client"), a caregiver mid-
// signup always runs the scripted runner. Only "caregiver" in the role list
// routes caregiver collection turns to the loop.
describe("caregiver onboarding agent-loop flag routing", () => {
  const FULL_CAREGIVER_DATA = {
    name: "Maria", city: "San Jose", yearsExperience: 6, specialties: ["dementia"],
    availability: { days: ["Monday"], hours: "9am-5pm" }, jobType: "part_time",
    hourlyRate: 25, email: "maria@example.com", bio: "I treat every client like family.",
  };

  afterEach(() => { delete process.env.ONBOARDING_AGENT_LOOP; });

  // Loop-only: a caregiver collection step ALWAYS routes to the loop as role
  // caregiver (no flag; scripted collection deleted).
  it("caregiver collection step routes to the loop as role caregiver", async () => {
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_experience", onboardingData: { name: "Maria" } });
    await handleInbound(makeEvent("6 years, mostly dementia"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(runQaAgent.mock.calls[0][0]).toMatchObject({
      onboardingMode: true,
      onboardingRole: "caregiver",
      userType: "caregiver",
    });
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  it("flag on: a caregiver GATE step (awaiting photo) never routes to the loop", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_awaiting_photo" });
    await handleInbound(makeEvent("did you get my photo?"));
    expect(runQaAgent).not.toHaveBeenCalled();
    expect(handleOnboardingStep).toHaveBeenCalledTimes(1);
  });

  it("caregiver persistence net: loop saves nothing → the CAREGIVER absorber captures the answer", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_experience", onboardingData: { name: "Maria" } });
    absorbCaregiverFields.mockResolvedValueOnce({ yearsExperience: 6, specialties: ["dementia"] });
    await handleInbound(makeEvent("6 years, mostly dementia"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(absorbCaregiverFields).toHaveBeenCalled();
    expect(absorbClientFields).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData)
      .toMatchObject({ yearsExperience: 6, specialties: ["dementia"] });
  });

  it("collection completes → drives the photo gate via the scripted runner's __RESUME__ sentinel", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_bio", onboardingData: { ...FULL_CAREGIVER_DATA, bio: "" } });
    // Simulate the model saving the bio and complete_collection advancing the
    // cursor to the first gate step (what mcp/server.ts does on complete:true).
    runQaAgent.mockImplementationOnce(async (..._a: any[]) => {
      hoisted.docState.set(`agent_sessions/${PHONE}`, {
        ...hoisted.docState.get(`agent_sessions/${PHONE}`),
        onboardingStep: "caregiver_send_photo",
        onboardingData: FULL_CAREGIVER_DATA,
      });
      return "qa reply";
    });
    await handleInbound(makeEvent("I treat every client like family."));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    // The proactive handoff drives the send-photo step exactly once, with the
    // no-user-text resume sentinel — and the client handoff never fires.
    expect(handleOnboardingStep).toHaveBeenCalledTimes(1);
    expect(handleOnboardingStep.mock.calls[0][2]).toBe("__RESUME__");
    expect(handleOnboardingStep.mock.calls[0][3]).toMatchObject({ onboardingStep: "caregiver_send_photo" });
    expect(continueAfterClientCollection).not.toHaveBeenCalled();
  });

  it("stuck-signup net: all caregiver fields present but the model never called complete_collection → cursor advances to the photo gate", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_bio", onboardingData: FULL_CAREGIVER_DATA });
    // Loop replies but writes nothing; data is already complete.
    await handleInbound(makeEvent("anything else you need?"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe("caregiver_send_photo");
    // And the gate is driven in the same turn (no dead-end silence).
    expect(handleOnboardingStep).toHaveBeenCalledTimes(1);
    expect(handleOnboardingStep.mock.calls[0][2]).toBe("__RESUME__");
  });

  it("loop throws before replying: caregiver loop is retried once (no scripted fallback)", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
    seedSession({ userType: "caregiver", onboardingStep: "caregiver_ask_name" });
    runQaAgent.mockRejectedValueOnce(new Error("sonnet timeout")); // retry succeeds
    await handleInbound(makeEvent("Maria"));
    expect(runQaAgent).toHaveBeenCalledTimes(2);
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });
});

// ── Onboarding checkpoint RESUME (2f, loop-only) ─────────────────────────────
// A paused signup carries an onboardingCheckpoint; on RESUME the loop owns
// conversational collection, so a checkpoint parked on a COLLECTION step must
// not call the (deleted) scripted collection handler. Two sub-cases:
//   - still-missing fields → a warm "here's the next thing" nudge, cursor left
//     on the collection step so the next inbound routes to the loop;
//   - everything already collected → DRIVE the post-collection handoff now (do
//     not just promise "I'll take it from here" and stall on a webhook-passive
//     gate the flow won't advance on its own).
// A checkpoint on a GATE step still resumes through the scripted runner.
describe("onboarding checkpoint RESUME (2f, loop-only)", () => {
  const COMPLETE_CLIENT = {
    firstName: "Sarah", seniorName: "Dorothy", age: 82, relationship: "daughter",
    careNeeds: ["companionship"], homeZipCode: "95110", sameAsHomeAddress: true,
    city: "San Jose", zipCode: "95110", timeOfDay: "mornings",
    careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
    emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000", rate: 25,
    email: "sarah@example.com",
  };

  function seedCheckpoint(step: string, data: Record<string, unknown>, userType = "client") {
    seedSession({
      userType,
      onboardingStep: step,
      onboardingCheckpoint: { step, onboardingData: data, savedAt: "2026-07-01T00:00:00.000Z" },
    });
  }

  it("RESUME at a collection step with everything collected → drives the handoff, no 'what's left' nudge", async () => {
    seedCheckpoint("client_ask_schedule", COMPLETE_CLIENT, "client");
    await handleInbound(makeEvent("RESUME"));
    expect(drivePostCollectionHandoff).toHaveBeenCalledTimes(1);
    expect(drivePostCollectionHandoff.mock.calls[0].slice(0, 3)).toEqual([PHONE, CHAT, "client"]);
    // Did NOT fall to the scripted runner for a (deleted) collection handler.
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  it("RESUME at a collection step with fields still missing → sends a nudge, does NOT drive the handoff", async () => {
    seedCheckpoint("client_ask_needs", { firstName: "Sarah", seniorName: "Dorothy" }, "client");
    await handleInbound(makeEvent("RESUME"));
    expect(drivePostCollectionHandoff).not.toHaveBeenCalled();
    // The welcome-back nudge went out (generateCaraMessage → fallback in the mock).
    expect(sendMessage).toHaveBeenCalled();
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });

  it("RESUME at a GATE step still resumes through the scripted runner", async () => {
    seedCheckpoint("caregiver_awaiting_photo", { name: "Maria" }, "caregiver");
    await handleInbound(makeEvent("RESUME"));
    expect(drivePostCollectionHandoff).not.toHaveBeenCalled();
    expect(handleOnboardingStep).toHaveBeenCalledTimes(1);
    expect(handleOnboardingStep.mock.calls[0][2]).toBe("__RESUME__");
  });
});

// ── Multi-care-group disambiguation (U8) ─────────────────────────────────────
// Validated bug: a phone matching 2+ care groups got asked "which senior?" and
// the turn returned with NOTHING persisted. The next inbound re-hit
// `!sessionSnap.exists` and re-asked forever — no code path ever consumed the
// answer. Fix: persist candidates + attempts on agent_sessions/{phone} before
// returning, and route the next inbound's reply through the resolver first.
describe("multi-care-group disambiguation (U8)", () => {
  const PRIMARY_A = "+15550009999";
  const PRIMARY_B = "+15550008888";

  function seedTwoGroups() {
    hoisted.collState.set("agent_sessions", [
      { id: PRIMARY_A, chatId: "chat-a", groupMembers: [PHONE], userId: "uA", seniorId: "seniorA", onboardingData: { seniorName: "Jane" } },
      { id: PRIMARY_B, chatId: "chat-b", groupMembers: [PHONE], userId: "uB", seniorId: "seniorB", onboardingData: { seniorName: "Bob" } },
    ]);
  }

  it("multi-group inbound asks with senior names and persists a marker with attempts 1, writing nothing else", async () => {
    seedTwoGroups();
    await handleInbound(makeEvent("hi"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const question = String(sendMessage.mock.calls[0][1]);
    expect(question).toContain("Jane");
    expect(question).toContain("Bob");

    const marker = hoisted.docState.get(`agent_sessions/${PHONE}`)?.pendingGroupDisambiguation;
    expect(marker).toMatchObject({ attempts: 1 });
    expect(marker.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primaryPhone: PRIMARY_A, seniorName: "Jane" }),
        expect.objectContaining({ primaryPhone: PRIMARY_B, seniorName: "Bob" }),
      ]),
    );
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("second inbound naming a candidate creates that candidate's session, no re-ask, marker cleared", async () => {
    // Seed the primary session AND the pending marker as if turn 1 already ran.
    hoisted.docState.set(`agent_sessions/${PRIMARY_B}`, {
      chatId: "chat-b", userId: "uB", seniorId: "seniorB", onboardingData: { seniorName: "Bob" },
    });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      pendingGroupDisambiguation: {
        candidates: [
          { primaryPhone: PRIMARY_A, seniorName: "Jane" },
          { primaryPhone: PRIMARY_B, seniorName: "Bob" },
        ],
        askedAt: "now",
        attempts: 1,
      },
    });
    parseWithClaude.mockResolvedValueOnce("1"); // index 1 → Bob

    await handleInbound(makeEvent("Bob, my dad"));

    const session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(session?.pendingGroupDisambiguation).toBeUndefined();
    expect(session).toMatchObject({
      userId: "uB",
      seniorId: "seniorB",
      primaryPhone: PRIMARY_B,
      isSecondaryMember: true,
    });
    // Exactly one send this turn: the "added to the care group" greeting — no re-ask.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("more than one care group");
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("STOP mid-disambiguation opts the user out instead of being parsed as an answer", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      pendingGroupDisambiguation: {
        candidates: [
          { primaryPhone: PRIMARY_A, seniorName: "Jane" },
          { primaryPhone: PRIMARY_B, seniorName: "Bob" },
        ],
        askedAt: "now",
        attempts: 1,
      },
    });

    await handleInbound(makeEvent("STOP"));

    const session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    // Marker cleared (the mock records FieldValue.delete() as a sentinel).
    expect(session?.pendingGroupDisambiguation?.candidates).toBeUndefined();
    // The reply was never treated as a disambiguation answer.
    expect(parseWithClaude).not.toHaveBeenCalled();
    // Standard opt-out handling ran (carrier protocol: STOP always works).
    expect(optOutPhoneNumber).toHaveBeenCalledWith(PHONE);
  });

  it("a mid-flow question gets answered and re-asked without burning a match attempt", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      pendingGroupDisambiguation: {
        candidates: [
          { primaryPhone: PRIMARY_A, seniorName: "Jane" },
          { primaryPhone: PRIMARY_B, seniorName: "Bob" },
        ],
        askedAt: "now",
        attempts: 1,
      },
    });
    isQuestionOrOther.mockResolvedValueOnce(true);

    await handleInbound(makeEvent("why do you need to know that?"));

    expect(answerHumanQuestionOnly).toHaveBeenCalledTimes(1);
    // Answer + re-ask, and the marker's attempts stay at 1.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const marker = hoisted.docState.get(`agent_sessions/${PHONE}`)?.pendingGroupDisambiguation;
    expect(marker).toMatchObject({ attempts: 1 });
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("awaiting-supply hold: a follow-up question gets the honest hold answer, never the orphan START OVER", async () => {
    // Supply-hold sessions complete WITHOUT payment by design (no caregivers
    // available → "no charge until then"), so no userId and no users record
    // exists. The orphan-recovery branch must not fire for them.
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      userType: "client",
      onboardingStep: "complete",
      awaitingSupply: true,
      onboardingData: { firstName: "Imran", seniorName: "Sarda", city: "Santa Clara" },
    });

    await handleInbound(makeEvent("Do you have caregivers available in San Jose yet?"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const reply = String(sendMessage.mock.calls[0][1]);
    expect(reply).not.toContain("Something's off");
    expect(reply).not.toContain("START OVER");
    // generateCaraMessage mock returns the fallback — the honest hold answer.
    expect(reply).toContain("first in line");
    expect(reply).toContain("Sarda");
    // The session was not reset or advanced.
    const session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(session?.onboardingStep).toBe("complete");
    expect(session?.awaitingSupply).toBe(true);
  });

  it("a marker with no candidates is cleared and the turn falls through instead of dead-ending", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      pendingGroupDisambiguation: { candidates: [], askedAt: "now", attempts: 1 },
    });

    await handleInbound(makeEvent("hello?"));

    const session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    // Marker cleared (the mock records FieldValue.delete() as a sentinel).
    expect(session?.pendingGroupDisambiguation?.candidates).toBeUndefined();
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("two consecutive no-match replies: one re-ask, then first-candidate fallback + admin_alerts, no infinite loop", async () => {
    hoisted.docState.set(`agent_sessions/${PRIMARY_A}`, {
      chatId: "chat-a", userId: "uA", seniorId: "seniorA", onboardingData: { seniorName: "Jane" },
    });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT,
      pendingGroupDisambiguation: {
        candidates: [
          { primaryPhone: PRIMARY_A, seniorName: "Jane" },
          { primaryPhone: PRIMARY_B, seniorName: "Bob" },
        ],
        askedAt: "now",
        attempts: 1,
      },
    });
    parseWithClaude.mockResolvedValueOnce("none");

    // First no-match reply → re-ask, attempts bumped to 2, still pending.
    await handleInbound(makeEvent("I don't know"));
    let session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(session?.pendingGroupDisambiguation).toMatchObject({ attempts: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("Jane");

    sendMessage.mockClear();
    parseWithClaude.mockResolvedValueOnce("none");

    // Second no-match reply → give up, fall back to first candidate, alert, marker cleared.
    await handleInbound(makeEvent("still not sure"));
    session = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(session?.pendingGroupDisambiguation).toBeUndefined();
    expect(session).toMatchObject({ primaryPhone: PRIMARY_A, isSecondaryMember: true });
    expect(hoisted.docState.get("admin_alerts/auto-add")).toMatchObject({
      type: "group_disambiguation_unresolved",
    });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("single-group phone is unaffected (unchanged secondary-member attach behavior)", async () => {
    hoisted.collState.set("agent_sessions", [{
      id: PRIMARY_A,
      chatId: "primary-chat",
      groupMembers: [PHONE],
      userId: "u1",
      seniorId: "senior1",
      groupChatId: "family-group-chat",
      onboardingData: { seniorName: "Jane" },
    }]);

    await handleInbound(makeEvent("hi"));

    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toMatchObject({
      userId: "u1",
      seniorId: "senior1",
      primaryPhone: PRIMARY_A,
      isSecondaryMember: true,
      groupChatId: "family-group-chat",
    });
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.pendingGroupDisambiguation).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("care coordinator"));
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

// ── Double-reply fall-through guard (U9) ─────────────────────────────────────
// Validated bug: runQaAgent sends its own reply, then a post-send write
// (persistence net / cursor update / Zep push) could throw into a shared catch
// that fell through to handleOnboardingStep — sending a SECOND, contradictory
// reply from stale pre-turn state. Fix: a loopReplied flag gates the catch.
describe("onboarding agent-loop double-send guard (U9)", () => {
  const defaultCollectionImpl = hoisted.collection.getMockImplementation();
  afterEach(() => {
    delete process.env.ONBOARDING_AGENT_LOOP;
    // Restore the plain collection() implementation — the first test in this
    // block installs a stateful override that must not leak into later tests.
    if (defaultCollectionImpl) hoisted.collection.mockImplementation(defaultCollectionImpl);
  });

  it("persistence-net write throws after runQaAgent resolves → exactly one send, admin_alerts written, handleOnboardingStep NOT called", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_name", onboardingData: {} });

    // runQaAgent resolves — its own reply already went out via the mocked
    // client — then the FIRST post-send read (`db.collection("agent_sessions")
    // .doc(phone).get()`, used to re-check the cursor/onboardingData) throws.
    // This simulates the validated failure mode: a post-send write/read fails
    // after the loop has already replied. Only calls to agent_sessions/{phone}
    // .get() made AFTER runQaAgent resolves should throw — earlier calls (the
    // session lookup at the top of the turn) must behave normally, so gate the
    // throw on a flag flipped inside the runQaAgent mock itself.
    let afterLoopReplied = false;
    runQaAgent.mockImplementationOnce(async (..._a: any[]) => {
      afterLoopReplied = true;
      return "qa reply";
    });
    const realCollection = hoisted.collection.getMockImplementation()!;
    hoisted.collection.mockImplementation((name: string) => {
      const ref = realCollection(name);
      if (name === "agent_sessions") {
        const realDoc = ref.doc;
        ref.doc = (id?: string) => {
          const docRef = realDoc(id);
          if (id === PHONE) {
            const realGet = docRef.get;
            docRef.get = vi.fn(async () => {
              if (afterLoopReplied) throw new Error("firestore unavailable");
              return realGet();
            });
          }
          return docRef;
        };
      }
      return ref;
    });

    await handleInbound(makeEvent("Sarah"));

    // Loop's own reply already went out; the guarded catch must record the
    // failure and STOP — never fall through to a second, contradictory reply
    // from the scripted runner.
    expect(handleOnboardingStep).not.toHaveBeenCalled();
    expect(hoisted.docState.get("admin_alerts/auto-add")).toMatchObject({
      type: "onboarding_loop_post_send_write_failed",
    });
  });

  it("agent loop throws before replying → loop is retried, handleOnboardingStep is NOT called (2d)", async () => {
    process.env.ONBOARDING_AGENT_LOOP = "client";
    seedSession({ onboardingStep: "client_ask_name" });
    runQaAgent.mockRejectedValueOnce(new Error("sonnet timeout")); // retry succeeds

    await handleInbound(makeEvent("Sarah"));

    expect(runQaAgent).toHaveBeenCalledTimes(2);
    expect(handleOnboardingStep).not.toHaveBeenCalled();
  });
});

// ── userHasRealOnboardingProgress — the "seeded users doc ≠ returning user" guard ──
// createWebOnboardingSession seeds users/{uid} at /start OTP time, seconds before
// the first inbound. Treating bare doc-existence as "returning" marked every fresh
// web signup onboardingStep:"complete" and skipped onboarding entirely (2026-07-08
// live bug: new caregiver greeted "Good to hear from you again!").
describe("userHasRealOnboardingProgress", () => {
  beforeEach(() => hoisted.reset());

  it("seeded stub (uid/phone/userType/name only) → false", async () => {
    expect(await userHasRealOnboardingProgress("uid-1", {
      uid: "uid-1", phone: PHONE, userType: "caregiver", name: "Imran",
    })).toBe(false);
  });

  it("client with seniorIds → true", async () => {
    expect(await userHasRealOnboardingProgress("uid-2", {
      uid: "uid-2", phone: PHONE, userType: "client", seniorIds: ["s1"],
    })).toBe(true);
  });

  it("client with legacy singular seniorId → true", async () => {
    expect(await userHasRealOnboardingProgress("uid-3", {
      uid: "uid-3", userType: "client", seniorId: "s1",
    })).toBe(true);
  });

  it("caregiver with caregivers/{uid} profile doc → true", async () => {
    hoisted.docState.set("caregivers/uid-4", { phone: PHONE, status: "pending_review" });
    expect(await userHasRealOnboardingProgress("uid-4", {
      uid: "uid-4", userType: "caregiver", name: "Imran",
    })).toBe(true);
  });

  // 2026-08-24 fix: a client who finished the website wizard has
  // jobPostingCompleted:true but no seniorId/seniorIds for the PRIMARY
  // recipient (only additional household recipients append to seniorIds) —
  // without this, texting Evia for the first time after finishing the wizard
  // looked identical to a brand-new signup and restarted the whole conversation.
  it("client with jobPostingCompleted:true (website wizard finished, no seniorId yet) → true", async () => {
    expect(await userHasRealOnboardingProgress("uid-5", {
      uid: "uid-5", userType: "client", jobPostingCompleted: true,
    })).toBe(true);
  });

  it("client with jobPostingCompleted:false → false", async () => {
    expect(await userHasRealOnboardingProgress("uid-6", {
      uid: "uid-6", userType: "client", jobPostingCompleted: false,
    })).toBe(false);
  });
});

// resolvePrimarySeniorId — getSeniorProfile("") returns null with zero
// context, so this must never resolve to "" for a client with real progress.
describe("resolvePrimarySeniorId", () => {
  it("prefers the explicit seniorId when set", () => {
    expect(resolvePrimarySeniorId("uid-1", { seniorId: "s1", seniorIds: ["s2"] })).toBe("s1");
  });

  it("falls back to the first seniorIds entry", () => {
    expect(resolvePrimarySeniorId("uid-1", { seniorIds: ["s2", "s3"] })).toBe("s2");
  });

  it("falls back to the client's own uid for a wizard-only client (senior_profiles/{uid})", () => {
    expect(resolvePrimarySeniorId("uid-1", { jobPostingCompleted: true })).toBe("uid-1");
  });

  it("resolves to empty string when there's genuinely no progress at all", () => {
    expect(resolvePrimarySeniorId("uid-1", {})).toBe("");
  });
});
