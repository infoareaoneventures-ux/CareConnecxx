import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization test for the 7 linear client onboarding steps that U2
 * migrates onto `runStep`. Drives the real `handleOnboardingStep` dispatcher
 * (so it exercises the pre-step logic — emotional context, absorb, role-switch,
 * correction — exactly as production does) and asserts the structural contract:
 *
 *  - a valid answer advances to the correct nextStep with the correct
 *    onboardingData field keys (one atomic write).
 *  - a mid-flow question re-asks WITHOUT advancing or writing fields.
 *  - a parse failure on name/schedule re-asks without advancing.
 *
 * No network is hit: `quickComplete` is mocked with a prompt-routing fake, the
 * emotional-context engine is stubbed, and `sendMessage`/`generateCaraMessage`
 * are mocked. Captures behavior BEFORE the refactor and must stay green after.
 */

// ── In-memory Firestore mock (booking.test.ts pattern) ─────────────────────────
const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const added:   Array<{ path: string; data: any }> = [];

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
      // Apply dotted-path updates the way Firestore does, so that
      // `onboardingData.firstName` updates a nested key without clobbering siblings.
      const cur = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes(".")) {
          const [head, ...rest] = k.split(".");
          const tail = rest.join(".");
          cur[head] = { ...(cur[head] ?? {}), [tail]: v };
        } else {
          cur[k] = v;
        }
      }
      docState.set(path, cur);
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    // .add() — used by admin_alerts writes (no caller-chosen doc id needed).
    ref.add = vi.fn(async (data: any) => {
      added.push({ path, data });
      return makeDocRef(`${path}/auto-${added.length}`);
    });
    ref.where = () => ({ get: vi.fn(async () => ({ docs: [] })) });
    return ref;
  };

  return {
    docState, updates, added,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; added.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      delete:          () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion:      (...v: unknown[]) => ({ __arrayUnion: v }),
    },
  });
  // createUser resolves a uid — intake confirmation now provisions the webapp
  // Auth account (ensureWebAccount), and a failing mock here would read as an
  // account-creation outage (admin_alerts) in every downstream assertion.
  const auth = () => ({
    createUser:           vi.fn(async () => ({ uid: "test-auth-uid" })),
    getUserByPhoneNumber: vi.fn(async () => ({ uid: "test-auth-uid" })),
  });
  const storage = () => ({ bucket: () => ({ file: () => ({ save: vi.fn(), exists: vi.fn(async () => [false]) }) }) });
  return {
    __esModule: true,
    apps: [],
    initializeApp: vi.fn(),
    default: { apps: [], initializeApp: vi.fn(), firestore, auth, storage },
    firestore,
    auth,
    storage,
  };
});

// Heavy transitive modules pulled in at import time — stub so module load is cheap
// and never touches the network.
vi.mock("../../memory/memoryFiles", () => ({
  initializeMemoryFiles: vi.fn(async () => {}),
  writeMemoryFile: vi.fn(async () => {}),
}));
vi.mock("../../memory/zepClient", () => ({
  pushOnboardingDataToZep: vi.fn(async () => {}),
  addBusinessDataToZep: vi.fn(async () => {}),
  getZepUserId: vi.fn(() => "zep-user"),
}));
vi.mock("../../notifications", () => ({
  notifyAdminNewClientSignup: vi.fn(async () => {}),
  notifyAdminNewCaregiverSignup: vi.fn(async () => {}),
}));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn(async () => {}) }));

// Caregiver preview action (called by handleClientShowCaregivers on the way to
// handleClientPresentPlan) — return a supply-available preview so the flow
// proceeds into the price/identity step instead of the no-supply dead end.
vi.mock("../actions/getCaregiverPreviewAction", () => ({
  runGetCaregiverPreviewAction: vi.fn(async () => ({
    available: true, widened: false, total: 1,
    locationLabel: "your area", needsLabel: "care",
    items: [{ name: "Alice" }],
    message: "I found a great match near you: Alice.",
  })),
}));

// Stripe — identity.verificationSessions.create is overridden per-test via
// stripeIdentityCreate; prices.retrieve always resolves so describeClientPrice
// (called earlier in handleClientPresentPlan) never throws.
let stripeIdentityCreate = vi.fn(async () => ({ id: "vs_test", url: "https://stripe.test/identity" }));
vi.mock("stripe", () => ({
  default: class StripeMock {
    identity = { verificationSessions: { create: (...args: any[]) => stripeIdentityCreate(...args) } };
    prices   = { retrieve: vi.fn(async () => ({ id: "price_test", unit_amount: 9900, recurring: { interval: "month" } })) };
    checkout = { sessions: { create: vi.fn(async () => ({ id: "cs_test", url: "https://stripe.test/checkout" })) } };
    accounts = { create: vi.fn(async () => ({ id: "acct_test" })) };
    accountLinks = { create: vi.fn(async () => ({ url: "https://stripe.test/connect" })) };
  },
}));

// ── Network-touching helpers ───────────────────────────────────────────────────
const sentMessages: Array<{ chatId: string; text: string }> = [];
vi.mock("../../linq/client", () => ({
  sendMessage:     vi.fn(async (chatId: string, text: string) => { sentMessages.push({ chatId, text }); }),
  signalThinking:  vi.fn(async () => {}),
  createChat:      vi.fn(async () => ({ chat_id: "chat", service: "SMS" })),
}));

// generateCaraMessage → return the fallback verbatim so we can assert the exact
// next-question text without a model call. The fallback is part of the contract.
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

// Emotional-context engine: deterministic "calm", no directive, so the pre-step
// classification path runs without a network call.
vi.mock("../emotionalContext", () => ({
  classifyEmotionalContext: vi.fn(async () => "calm"),
  classifyEmotionalTopic:   vi.fn(() => "general"),
  blendEmotionalContext:    vi.fn(() => ({ value: "calm", persist: null })),
  buildEmotionalContextDirective: vi.fn(() => undefined),
  EMOTIONAL_CONTEXT_TTL_MS: 1,
}));

// ── The single-shot LLM. Route by prompt content. ──────────────────────────────
// Tests set `answerFor` to control what the *step's* parse returns; the pre-step
// detectors (absorb / role-switch / correction) always return "nothing", and
// isQuestionOrOther is controlled per-test via `questionMode`.
let questionMode = false;          // isQuestionOrOther → YES when true
let stepAnswer = "";               // raw value the step's parse prompt should return

vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (prompt: string, _text: string) => {
    // Pre-step detectors — always benign so they don't intercept the turn.
    if (prompt.includes("You are extracting onboarding details from one message")) return "{}";
    if (prompt.includes('"switchTo"')) return '{"switchTo":"none"}';
    if (prompt.includes("Detect if they are correcting")) return "null";
    // Mid-flow question gate.
    if (prompt.includes("general question or off-topic comment")) return questionMode ? "YES" : "NO";
    // answerQuestionMidFlow — only hit when questionMode is on.
    if (prompt.includes("You are Evia, an AI care assistant")) return "Here's a helpful answer.";
    // Otherwise it's the step's own parse prompt.
    return stepAnswer;
  }),
}));

import { handleOnboardingStep, continueAfterClientCollection } from "../onboardingConversation";
import { t as tr } from "../../utils/language";

const PHONE = "+15555550100";
const CHAT  = "chat-1";

function seedSession(step: string, onboardingData: Record<string, unknown> = {}) {
  const session: any = {
    chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
    userType: "client", onboardingStep: step, onboardingData,
  };
  hoisted.docState.set(`agent_sessions/${PHONE}`, { ...session });
  return session;
}

function allSessionUpdates() {
  return hoisted.updates.filter(u => u.path === `agent_sessions/${PHONE}`).map(u => u.data);
}

beforeEach(() => {
  hoisted.reset();
  sentMessages.length = 0;
  questionMode = false;
  stepAnswer = "";
  stripeIdentityCreate = vi.fn(async () => ({ id: "vs_test", url: "https://stripe.test/identity" }));
});

describe("client onboarding steps — characterization", () => {
  // ── client_ask_name ──────────────────────────────────────────────────────────
  describe("client_ask_name", () => {
    it("valid name advances to client_ask_senior and stores firstName", async () => {
      const session = seedSession("client_ask_name");
      stepAnswer = "Maria";
      await handleOnboardingStep(PHONE, CHAT, "I'm Maria", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.firstName).toBe("Maria");
      expect(stored.onboardingStep).toBe("client_ask_senior");
      // Next question is the family-greeting fallback referencing the name.
      expect(sentMessages.some(m => m.text.includes("Maria"))).toBe(true);
    });

    it("unknown name re-asks WITHOUT advancing", async () => {
      const session = seedSession("client_ask_name");
      stepAnswer = "unknown";
      await handleOnboardingStep(PHONE, CHAT, "blah", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("client_ask_name");
      expect(stored.onboardingData?.firstName).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("didn't catch your name"))).toBe(true);
    });

    it("mid-flow question re-asks 'What's your name?' without advancing", async () => {
      const session = seedSession("client_ask_name");
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "what is careconnex?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("client_ask_name");
      expect(sentMessages.some(m => m.text === "What's your name?")).toBe(true);
    });
  });

  // ── client_ask_senior ─────────────────────────────────────────────────────────
  describe("client_ask_senior", () => {
    it("stores seniorName + relationship and advances to client_ask_needs", async () => {
      const session = seedSession("client_ask_senior", { firstName: "Maria" });
      stepAnswer = '{"seniorName":"Dorothy","relationship":"mother"}';
      await handleOnboardingStep(PHONE, CHAT, "my mom Dorothy", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.seniorName).toBe("Dorothy");
      expect(stored.onboardingData.relationship).toBe("mother");
      expect(stored.onboardingStep).toBe("client_ask_needs");
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("client_ask_senior", { firstName: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "why do you need that?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("client_ask_senior");
      expect(sentMessages.some(m => m.text.includes("who are you looking for care for"))).toBe(true);
    });
  });

  // ── client_ask_needs ──────────────────────────────────────────────────────────
  describe("client_ask_needs", () => {
    it("stores age/careNeeds/conditions and advances to client_ask_location", async () => {
      const session = seedSession("client_ask_needs", { firstName: "Maria", seniorName: "Dorothy" });
      stepAnswer = '{"age":82,"careNeeds":["bathing"],"conditions":["dementia"]}';
      await handleOnboardingStep(PHONE, CHAT, "she's 82, has dementia, needs help bathing", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.age).toBe(82);
      expect(stored.onboardingData.careNeeds).toEqual(["bathing"]);
      expect(stored.onboardingData.conditions).toEqual(["dementia"]);
      expect(stored.onboardingStep).toBe("client_ask_location");
    });
  });

  // ── client_ask_schedule ───────────────────────────────────────────────────────
  describe("client_ask_schedule", () => {
    it("stores daysPerWeek/timeOfDay/hoursPerDay and advances to client_ask_start", async () => {
      const session = seedSession("client_ask_schedule", { seniorName: "Dorothy" });
      stepAnswer = '{"daysPerWeek":5,"timeOfDay":"mornings","hoursPerDay":4}';
      await handleOnboardingStep(PHONE, CHAT, "weekday mornings", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.daysPerWeek).toBe(5);
      expect(stored.onboardingData.timeOfDay).toBe("mornings");
      expect(stored.onboardingData.hoursPerDay).toBe(4);
      expect(stored.onboardingStep).toBe("client_ask_start");
    });

    it("parse error re-asks WITHOUT advancing", async () => {
      const session = seedSession("client_ask_schedule", { seniorName: "Dorothy" });
      stepAnswer = "__parse_error__";
      await handleOnboardingStep(PHONE, CHAT, "asdf", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("client_ask_schedule");
      expect(stored.onboardingData?.daysPerWeek).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("What days and hours do you need care?"))).toBe(true);
    });
  });

  // ── client_ask_start ──────────────────────────────────────────────────────────
  describe("client_ask_start", () => {
    it("stores startDate and advances to client_ask_preferences", async () => {
      const session = seedSession("client_ask_start", { seniorName: "Dorothy" });
      stepAnswer = "asap";
      await handleOnboardingStep(PHONE, CHAT, "right away", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.startDate).toBe("asap");
      expect(stored.onboardingStep).toBe("client_ask_preferences");
    });

    it("parse error defaults startDate to 'flexible' and still advances", async () => {
      const session = seedSession("client_ask_start", { seniorName: "Dorothy" });
      stepAnswer = "__parse_error__";
      await handleOnboardingStep(PHONE, CHAT, "hmm", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.startDate).toBe("flexible");
      expect(stored.onboardingStep).toBe("client_ask_preferences");
    });
  });

  // ── client_ask_preferences ─────────────────────────────────────────────────────
  describe("client_ask_preferences", () => {
    it("expands prefs into top-level matching keys and advances to client_ask_budget", async () => {
      const session = seedSession("client_ask_preferences", { city: "Austin" });
      stepAnswer = '{"gender":"female","language":"Spanish","driving":true,"other":"non-smoker"}';
      await handleOnboardingStep(PHONE, CHAT, "a female Spanish speaker who can drive, non-smoker", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.caregiverPreferences).toEqual({ gender: "female", language: "Spanish", driving: true, other: "non-smoker" });
      expect(stored.onboardingData.genderPreference).toBe("female");
      expect(stored.onboardingData.languagePreference).toBe("Spanish");
      expect(stored.onboardingData.needsDriving).toBe(true);
      expect(stored.onboardingData.otherPreference).toBe("non-smoker");
      expect(stored.onboardingStep).toBe("client_ask_budget");
    });
  });

  // ── client_ask_budget ──────────────────────────────────────────────────────────
  describe("client_ask_budget", () => {
    it("stores budget + budgetMin/budgetMax and advances to client_confirm_intake", async () => {
      const session = seedSession("client_ask_budget", { seniorName: "Dorothy" });
      stepAnswer = '{"min":20,"max":25}';
      await handleOnboardingStep(PHONE, CHAT, "$20 to $25 an hour", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.budget).toEqual({ min: 20, max: 25 });
      expect(stored.onboardingData.budgetMin).toBe(20);
      expect(stored.onboardingData.budgetMax).toBe(25);
      expect(stored.onboardingStep).toBe("client_confirm_intake");
    });
  });

  // ── atomicity: after the turn both the field and the advanced step persist ──────
  // (End-state assertion — holds for the old two-write path AND the new atomic
  //  single-write path, so it is the behavior-preserving net.)
  it("persists both the merged field and the advanced step", async () => {
    const session = seedSession("client_ask_name");
    stepAnswer = "Maria";
    await handleOnboardingStep(PHONE, CHAT, "Maria", session, { service: "SMS" });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.onboardingData.firstName).toBe("Maria");
    expect(stored.onboardingStep).toBe("client_ask_senior");
    // And there was at least one session update carrying the step advance.
    expect(allSessionUpdates().some(u => u.onboardingStep === "client_ask_senior")).toBe(true);
  });
});

// ── U11 Part 1: honest disclosure at first contact ───────────────────────────
// otp_greeting is the very first message a brand-new phone number receives
// (before onboardingStep even exists). It must keep its warmth but disclose
// that Evia is automated with a real team behind her (CA B.O.T. Act).
describe("first-contact disclosure (otp_greeting)", () => {
  // Conversational automation disclosure removed by explicit founder decision
  // 2026-07-02 (risk accepted; web signup subtitle + honest-answer-if-asked
  // remain the disclosure surfaces). These tests pin the warm intro and the
  // absence of chatbot self-labels.
  it("English greeting keeps the warm coordinator intro without chatbot self-labels", () => {
    const msg = tr.otp_greeting("123456", "en");
    expect(msg).toContain("I'm Evia");
    expect(msg).toContain("care coordinator");
    expect(msg).toContain("123456");
    expect(msg.toLowerCase()).not.toContain("care assistant");
    expect(msg.toLowerCase()).not.toContain("ai ");
  });

  it("Spanish greeting keeps the warm coordinator intro without chatbot self-labels", () => {
    const msg = tr.otp_greeting("123456", "es");
    expect(msg).toContain("soy Evia");
    expect(msg).toContain("coordinadora de cuidado");
    expect(msg).toContain("123456");
    expect(msg.toLowerCase()).not.toContain("asistente");
  });
});

// ── U11 Part 2: identity-gate visibility on Stripe Identity failure ─────────
// When createClientIdentitySession throws (e.g. Stripe Identity outage), the
// flow must still fall back to the payment link (unchanged behavior), but now
// it must ALSO persist a needsIdentityVerification flag on the session and
// raise an admin_alerts doc so ops isn't relying on console.error alone.
describe("identity-gate visibility on Stripe Identity failure", () => {
  it("falls back to payment AND persists the session flag AND writes admin_alerts", async () => {
    stripeIdentityCreate = vi.fn(async () => { throw new Error("stripe identity outage"); });

    seedSession("client_confirm_intake", {
      firstName: "Maria", seniorName: "Dorothy", city: "Austin", careNeeds: ["bathing"],
    });
    // handleClientConfirmIntake reads "confirm" vs "edit" via parseWithClaude/quickComplete.
    stepAnswer = "confirm";

    await handleOnboardingStep(PHONE, CHAT, "yes that's right", seedSession("client_confirm_intake", {
      firstName: "Maria", seniorName: "Dorothy", city: "Austin", careNeeds: ["bathing"],
    }), { service: "SMS" });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);

    // (a) payment fallback fires — step lands on client_send_payment (or beyond,
    // since handleClientSendPayment runs synchronously after the fallback).
    expect(
      allSessionUpdates().some(u => u.onboardingStep === "client_send_payment")
    ).toBe(true);

    // (b) session flag persisted via mergeOnboardingData
    expect(stored.onboardingData.needsIdentityVerification).toBe(true);
    expect(typeof stored.onboardingData.identityGateSkippedAt).toBe("string");

    // (c) admin_alerts written with the expected shape
    const alert = hoisted.added.find(a => a.path === "admin_alerts");
    expect(alert).toBeTruthy();
    expect(alert!.data).toMatchObject({
      type:     "identity_gate_skipped",
      phone:    PHONE,
      resolved: false,
    });
    expect(typeof alert!.data.error).toBe("string");
    expect(typeof alert!.data.createdAt).toBe("string");
  });

  it("still sends the identity link on the happy path (no regression)", async () => {
    seedSession("client_confirm_intake", {
      firstName: "Maria", seniorName: "Dorothy", city: "Austin", careNeeds: ["bathing"],
    });
    stepAnswer = "confirm";

    await handleOnboardingStep(PHONE, CHAT, "yes that's right", seedSession("client_confirm_intake", {
      firstName: "Maria", seniorName: "Dorothy", city: "Austin", careNeeds: ["bathing"],
    }), { service: "SMS" });

    expect(sentMessages.some(m => m.text.includes("identity check"))).toBe(true);
    expect(hoisted.added.find(a => a.path === "admin_alerts")).toBeUndefined();

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.onboardingData.needsIdentityVerification).toBeUndefined();
  });
});
