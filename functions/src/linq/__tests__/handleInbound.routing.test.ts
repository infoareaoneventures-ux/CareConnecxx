// Characterization tests for handleInbound's routing SPINE (webhooks.ts).
//
// These pin the ORDER of the top-level guards — opt-out before crisis,
// onboarding before rate-limit, pending approvals before the shift-offer
// interception, degraded-classifier handling — because that order IS the
// product behavior. They exist so the planned decomposition of handleInbound
// can prove, branch by branch, that nothing moved. If one of these fails
// after a refactor, the refactor changed Cara's behavior.
//
// Every collaborator module is mocked; assertions are "which handler fired"
// (and which did NOT), not message wording.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ??  {}), ...data } : data);
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

// ── Linq client + messaging ──────────────────────────────────────────────────
const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
vi.mock("../client", () => ({
  sendMessage:      (...a: any[]) => sendMessage(...a),
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
vi.mock("../../agents/onboardingConversation", () => ({
  handleOnboardingStep:   (...a: any[]) => handleOnboardingStep(...a),
  sendBgCheckRenewalLink: (...a: any[]) => sendBgCheckRenewalLink(...a),
}));

const detectCrisis      = vi.fn((..._a: any[]): string | null => null);
const isLikelyRealCrisis = vi.fn(async (..._a: any[]) => true);
vi.mock("../../safety/crisisDetector", () => ({
  detectCrisis:       (...a: any[]) => detectCrisis(...a),
  isLikelyRealCrisis: (...a: any[]) => isLikelyRealCrisis(...a),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "NONE");
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: (...a: any[]) => quickComplete(...a),
}));

// ── Inert collaborators (must load, never fire in these scenarios) ──────────
vi.mock("../../agents/taskApprovalHandler", () => ({ handleTaskApproval: vi.fn(async () => {}) }));
vi.mock("../../agents/permissionsConversation", () => ({
  handleClientPermissionsReply:    vi.fn(async () => {}),
  handleCaregiverPermissionsReply: vi.fn(async () => {}),
  updatePermissionFromText:        vi.fn(async () => {}),
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
vi.mock("../../utils/sessionState", () => ({
  STATE_MACHINE_FLAGS: ["stateExpiresAt"],
  clearAllStateFlags:  vi.fn(async () => {}),
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
  detectAndApplyCorrection: vi.fn(async () => null),
}));
vi.mock("../../utils/voiceTranscription", () => ({
  extractVoiceMemoPart: vi.fn(() => null),
  transcribeVoiceMemo:  vi.fn(async () => ""),
}));
vi.mock("../../utils/locationShare", () => ({
  extractLocationPart: vi.fn(() => null),
  reverseGeocode:      vi.fn(async () => null),
}));
vi.mock("../../utils/mediaIntake", () => ({
  extractMediaPart:  vi.fn(() => null),
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

import { handleInbound } from "../webhooks";

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
  getAllPending.mockResolvedValue([]);
  handlePendingApprovals.mockResolvedValue({ outcome: "fallthrough" });
  handleShiftOfferReply.mockResolvedValue("fallthrough");
  detectCrisis.mockReturnValue(null);
  isLikelyRealCrisis.mockResolvedValue(true);
  quickComplete.mockResolvedValue("NONE");
  sendMessage.mockResolvedValue({ message_id: "m1" });
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

  it("crisis keyword judged NOT real falls through to the QA agent", async () => {
    seedSession();
    detectCrisis.mockReturnValue("medical");
    isLikelyRealCrisis.mockResolvedValue(false);
    await handleInbound(makeEvent("the movie was to die for"));
    expect(runQaAgent).toHaveBeenCalledTimes(1);
  });

  it("caregiver RENEW keyword re-issues the bg-check link (terminal)", async () => {
    seedSession({ userType: "caregiver", caregiverId: "cg1" });
    await handleInbound(makeEvent("RENEW"));
    expect(sendBgCheckRenewalLink).toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

describe("onboarding + rate limit", () => {
  it("mid-onboarding messages route to handleOnboardingStep, not intent routing", async () => {
    seedSession({ onboardingStep: "caregiver_name" });
    await handleInbound(makeEvent("Jane Doe"));
    expect(handleOnboardingStep).toHaveBeenCalled();
    expect(classifyIntentDetailed).not.toHaveBeenCalled();
  });

  it("rate-limited phones are dropped silently AFTER onboarding routing", async () => {
    seedSession();
    hoisted.docState.set(`agent_rate/${PHONE}`, {
      calls: Array.from({ length: 120 }, () => Date.now()),
    });
    await handleInbound(makeEvent("hello"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
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

  it("a question during a pending approval falls through so Cara can answer it", async () => {
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
});
