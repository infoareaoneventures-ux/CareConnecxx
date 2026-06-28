import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore harness (shiftOffer.test.ts pattern) ──────────────────
// onboardingConversation.ts runs `admin.firestore()` at module load, so
// firebase-admin MUST be mocked before the module is imported.
const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
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
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = () => ({ collection: hoisted.collectionMock });
  return {
    __esModule: true,
    default: { firestore: firestoreFn, auth: () => ({}) },
    firestore: Object.assign(firestoreFn, {
      FieldValue: {
        arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
        arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
        increment:   (n: number) => ({ __increment: n }),
        delete:      () => ({ __delete: true }),
      },
    }),
    auth: () => ({}),
  };
});

// ── LLM + outbound messaging mocks ────────────────────────────────────────────
// parseWithClaude / isQuestionOrOther / answerQuestionMidFlow all funnel through
// quickComplete in utils/openaiClient, so controlling that one mock drives every
// LLM decision in the handler. We queue scripted responses per test.
const quickComplete = vi.fn();
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
  getOpenAIClient: vi.fn(),
}));

const sendMessage = vi.fn().mockResolvedValue({ message_id: "m1" });
vi.mock("../../linq/client", () => ({
  sendMessage:    (...args: unknown[]) => sendMessage(...args),
  signalThinking: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));

// Emotional-context engine: the dispatcher calls these once per turn. Keep them
// inert so they don't consume our scripted quickComplete responses.
vi.mock("../emotionalContext", () => ({
  classifyEmotionalContext: vi.fn(async () => "calm"),
  classifyEmotionalTopic:   vi.fn(() => "logistics"),
  blendEmotionalContext:    vi.fn(() => ({ value: "calm", persist: null })),
  buildEmotionalContextDirective: vi.fn(() => ""),
}));

// ── Heavy / backend-only transitive imports ──────────────────────────────────
// onboardingConversation.ts statically imports a wide tree (notifications,
// memory, token/job builders, media + vision utils). Several of those reach npm
// packages that aren't installed at the repo root where Vitest runs
// (firebase-functions, resend, zep, telegraf, …). The story handler touches none
// of them, so we stub the direct imports to keep Vite's transform off those
// unresolvable subtrees.
vi.mock("../../notifications", () => ({
  notifyAdminNewClientSignup:    vi.fn().mockResolvedValue(undefined),
  notifyAdminNewCaregiverSignup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({
  initializeMemoryFiles: vi.fn().mockResolvedValue(undefined),
  writeMemoryFile:       vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/zepClient", () => ({
  pushOnboardingDataToZep: vi.fn().mockResolvedValue(undefined),
  addBusinessDataToZep:    vi.fn().mockResolvedValue(undefined),
  getZepUserId:            vi.fn(() => "zep-user"),
}));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../tokenService", () => ({ generateToken: vi.fn(() => "tok") }));
vi.mock("../../utils/mediaIntake", () => ({
  downloadMedia:     vi.fn(),
  storeInboundMedia: vi.fn(),
}));
vi.mock("../../utils/visionVerify", () => ({ verifyProfilePhoto: vi.fn(), verifyDocument: vi.fn() }));
vi.mock("../../utils/locationShare", () => ({ reverseGeocode: vi.fn() }));

import { handleOnboardingStep } from "../onboardingConversation";
import type { AgentSession } from "../../linq/client";

const PHONE  = "+15555550199";
const CHAT   = "chat-cg";

function seedSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const session = {
    chatId:        CHAT,
    userType:      "caregiver",
    onboardingStep: "caregiver_ask_story",
    onboardingData: { name: "Maria" },
    ...overrides,
  } as unknown as AgentSession;
  hoisted.docState.set(`agent_sessions/${PHONE}`, { ...session });
  return session;
}

/** onboardingData currently persisted for the session under test. */
function storedData(): Record<string, unknown> {
  return (hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData ?? {}) as Record<string, unknown>;
}
function storedStep(): string | undefined {
  return hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingStep;
}

// The dispatcher fires several pre-handler LLM calls per turn before the story
// handler runs. With our inert emotionalContext mock the remaining ones, in order,
// are:
//   isGreetingOnly  (expects GREETING / OTHER),
//   detectRoleSwitch (expects JSON / "none"),
//   detectCorrection (expects "null").
// We queue safe "no-op" answers for them, then the handler's own calls.
function queueNoopPreHandlerCalls() {
  // isGreetingOnly → OTHER (this is a real answer, not a bare greeting)
  quickComplete.mockResolvedValueOnce("OTHER");
  // detectRoleSwitch → JSON {"switchTo":"none"}
  quickComplete.mockResolvedValueOnce('{"switchTo":"none"}');
  // detectCorrection → literal null
  quickComplete.mockResolvedValueOnce("null");
}

describe("handleCaregiverAskStory", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

  it("happy path: extracts years/specialties/certs from a narrative and auto-advances past satisfied steps", async () => {
    const session = seedSession();
    queueNoopPreHandlerCalls();
    // isQuestionOrOther → NO (it's an answer)
    quickComplete.mockResolvedValueOnce("NO");
    // story extraction → full JSON
    quickComplete.mockResolvedValueOnce(JSON.stringify({
      yearsExperience: 6,
      specialties: ["dementia", "mobility assistance"],
      certifications: ["CNA", "CPR"],
      skills: ["companionship"],
    }));

    await handleOnboardingStep(
      PHONE, CHAT,
      "I've cared for seniors about 6 years, mostly dementia, I'm a CNA and CPR-certified",
      session,
    );

    const data = storedData();
    expect(data.yearsExperience).toBe(6);
    expect(data.specialties).toEqual(expect.arrayContaining(["dementia"]));
    expect(data.certifications).toEqual(expect.arrayContaining(["CNA", "CPR"]));
    // Both experience + specialties satisfied → land on the profile step.
    expect(storedStep()).toBe("caregiver_ask_profile");
    expect(sendMessage).toHaveBeenCalled();
  });

  it("partial narrative: stores years, leaves certs empty, asks the remaining experience step (no fabrication)", async () => {
    const session = seedSession();
    queueNoopPreHandlerCalls();
    quickComplete.mockResolvedValueOnce("NO"); // isQuestionOrOther
    // Years only, nothing else stated.
    quickComplete.mockResolvedValueOnce(JSON.stringify({
      yearsExperience: 3,
      specialties: [],
      certifications: [],
      skills: [],
    }));

    await handleOnboardingStep(PHONE, CHAT, "I've been doing this for about 3 years", session);

    const data = storedData();
    expect(data.yearsExperience).toBe(3);
    expect(data.certifications ?? []).toEqual([]); // not fabricated
    expect(data.specialties ?? []).toEqual([]);
    // Years filled, but specialties empty → auto-advance lands on specialties step.
    expect(storedStep()).toBe("caregiver_ask_specialties");
  });

  it("isQuestionOrOther guard: a question is answered + re-asked, NOT stored as experience", async () => {
    const session = seedSession();
    queueNoopPreHandlerCalls();
    // isQuestionOrOther → YES
    quickComplete.mockResolvedValueOnce("YES");
    // answerQuestionMidFlow reply
    quickComplete.mockResolvedValueOnce("We use it to match you with families who need your skills.");

    await handleOnboardingStep(PHONE, CHAT, "why do you need my experience?", session);

    // Nothing extracted/stored beyond the seeded name.
    const data = storedData();
    expect(data.yearsExperience).toBeUndefined();
    expect(data.specialties).toBeUndefined();
    expect(data.certifications).toBeUndefined();
    // Still on the story step, re-asked.
    expect(storedStep()).toBe("caregiver_ask_story");
    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("caregiving experience"));
  });

  it("malformed LLM output: non-JSON extraction is caught, defaults applied, caregiver re-prompted without crashing", async () => {
    const session = seedSession();
    queueNoopPreHandlerCalls();
    quickComplete.mockResolvedValueOnce("NO"); // isQuestionOrOther
    // Extraction returns prose, not JSON.
    quickComplete.mockResolvedValueOnce("Sure, here is what I understood about the caregiver...");

    await expect(
      handleOnboardingStep(PHONE, CHAT, "I have lots of experience caring for people", session),
    ).resolves.not.toThrow();

    const data = storedData();
    expect(data.yearsExperience).toBeUndefined(); // defaults, nothing stored
    expect(data.specialties).toBeUndefined();
    // No fields filled → stays on the first absorbable step and asks it.
    expect(storedStep()).toBe("caregiver_ask_experience");
    expect(sendMessage).toHaveBeenCalled();
  });

  it("refusal: 'I'd rather not say' invents no fields and the flow proceeds gracefully", async () => {
    const session = seedSession();
    queueNoopPreHandlerCalls();
    quickComplete.mockResolvedValueOnce("NO"); // treated as an answer, not a question
    // Nothing extractable.
    quickComplete.mockResolvedValueOnce(JSON.stringify({
      yearsExperience: 0,
      specialties: [],
      certifications: [],
      skills: [],
    }));

    await handleOnboardingStep(PHONE, CHAT, "I'd rather not say", session);

    const data = storedData();
    expect(data.yearsExperience).toBeUndefined();
    expect(data.specialties).toBeUndefined();
    expect(data.certifications).toBeUndefined();
    // Flow proceeds to ask the experience step rather than hanging or inventing.
    expect(storedStep()).toBe("caregiver_ask_experience");
    expect(sendMessage).toHaveBeenCalled();
  });
});
