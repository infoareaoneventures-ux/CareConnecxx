import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization test for the linear caregiver onboarding steps that U3
 * migrates onto `runStep`. Drives the real `handleOnboardingStep` dispatcher
 * (so it exercises the pre-step logic — emotional context, absorb, role-switch,
 * correction — exactly as production does) and asserts the structural contract:
 *
 *  - a valid answer advances to the correct nextStep with the correct
 *    onboardingData field keys.
 *  - a mid-flow question re-asks WITHOUT advancing or writing fields.
 *  - rate/email invalid input re-asks without advancing.
 *
 * It also asserts the NON-LINEAR steps that stay bespoke (location with the
 * local-job teaser + reverse-geocode, the profile step, and the document-upload
 * / membership awaiting states) keep their distinctive behavior — proving the
 * migration left them untouched.
 *
 * No network is hit: `quickComplete` is mocked with a prompt-routing fake, the
 * emotional-context engine is stubbed, and `sendMessage`/`generateCaraMessage`
 * are mocked. Captures behavior BEFORE the refactor and must stay green after.
 */

// ── In-memory Firestore mock (booking.test.ts pattern) ─────────────────────────
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
    // Query chain for the local-job teaser (job_posts where/limit/get).
    ref.where = () => ref;
    ref.limit = () => ref;
    ref.get   = vi.fn(async () => ({ docs: [] }));
    return ref;
  };

  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
  });
  const auth = () => ({ createUser: vi.fn() });
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

// tokenService signs upload links with JWT_SECRET — stub it so the bespoke
// photo/membership handlers (which the bio + awaiting-membership steps hand off
// to) don't need a real secret.
vi.mock("../tokenService", () => ({
  generateToken: vi.fn(() => "test-token"),
  verifyToken:   vi.fn(() => ({ phone: "+15555550100" })),
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
let questionMode = false;          // isQuestionOrOther → YES when true
let stepAnswer = "";               // raw value the step's parse prompt should return

vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (prompt: string, _text: string) => {
    // Pre-step detectors — always benign so they don't intercept the turn.
    if (prompt.includes("You are extracting onboarding details from one message")) return "{}";
    if (prompt.includes('"switchTo"')) return '{"switchTo":"none"}';
    if (prompt.includes("Detect if they are correcting")) return "null";
    // Mid-flow question gate.
    if (prompt.includes("Reply YES if this is a general question")) return questionMode ? "YES" : "NO";
    // answerQuestionMidFlow — only hit when questionMode is on.
    if (prompt.includes("You are Evia, an AI care assistant")) return "Here's a helpful answer.";
    // Otherwise it's the step's own parse prompt.
    return stepAnswer;
  }),
}));

import { handleOnboardingStep } from "../onboardingConversation";

const PHONE = "+15555550100";
const CHAT  = "chat-1";

function seedSession(step: string, onboardingData: Record<string, unknown> = {}) {
  const session: any = {
    chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
    userType: "caregiver", onboardingStep: step, onboardingData,
  };
  hoisted.docState.set(`agent_sessions/${PHONE}`, { ...session });
  return session;
}

beforeEach(() => {
  hoisted.reset();
  sentMessages.length = 0;
  questionMode = false;
  stepAnswer = "";
});

describe("caregiver onboarding steps — characterization", () => {
  // ── caregiver_ask_name ─────────────────────────────────────────────────────────
  describe("caregiver_ask_name", () => {
    it("valid name advances to caregiver_ask_location and stores name", async () => {
      const session = seedSession("caregiver_ask_name");
      stepAnswer = "Maria Lopez";
      await handleOnboardingStep(PHONE, CHAT, "I'm Maria Lopez", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.name).toBe("Maria Lopez");
      expect(stored.onboardingStep).toBe("caregiver_ask_location");
      expect(sentMessages.some(m => m.text.includes("Maria Lopez") && m.text.includes("city and zip"))).toBe(true);
    });

    it("parse error re-asks WITHOUT advancing", async () => {
      const session = seedSession("caregiver_ask_name");
      stepAnswer = "__parse_error__";
      await handleOnboardingStep(PHONE, CHAT, "blah", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_name");
      expect(stored.onboardingData?.name).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("didn't catch your name"))).toBe(true);
    });

    it("mid-flow question re-asks 'What's your name?' without advancing", async () => {
      const session = seedSession("caregiver_ask_name");
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "what is careconnex?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_name");
      expect(sentMessages.some(m => m.text === "What's your name?")).toBe(true);
    });
  });

  // ── caregiver_ask_experience ─────────────────────────────────────────────────────
  describe("caregiver_ask_experience", () => {
    it("stores yearsExperience + certifications and advances to caregiver_ask_specialties", async () => {
      const session = seedSession("caregiver_ask_experience", { name: "Maria" });
      stepAnswer = '{"yearsExperience":5,"certifications":["CNA","CPR"]}';
      await handleOnboardingStep(PHONE, CHAT, "5 years, CNA and CPR", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.yearsExperience).toBe(5);
      expect(stored.onboardingData.certifications).toEqual(["CNA", "CPR"]);
      expect(stored.onboardingStep).toBe("caregiver_ask_specialties");
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_experience", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "why do you ask?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_experience");
      expect(sentMessages.some(m => m.text.includes("years of caregiving experience"))).toBe(true);
    });
  });

  // ── caregiver_ask_specialties ─────────────────────────────────────────────────────
  describe("caregiver_ask_specialties", () => {
    it("stores specialties and advances to caregiver_ask_profile", async () => {
      const session = seedSession("caregiver_ask_specialties", { name: "Maria" });
      stepAnswer = '{"specialties":["dementia","mobility"]}';
      await handleOnboardingStep(PHONE, CHAT, "dementia and mobility", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.specialties).toEqual(["dementia", "mobility"]);
      expect(stored.onboardingStep).toBe("caregiver_ask_profile");
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_specialties", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "what counts as a specialty?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_specialties");
      expect(sentMessages.some(m => m.text.includes("What types of care do you specialize in?"))).toBe(true);
    });
  });

  // ── caregiver_ask_availability ─────────────────────────────────────────────────────
  describe("caregiver_ask_availability", () => {
    it("stores availability and advances to caregiver_ask_job_type", async () => {
      const session = seedSession("caregiver_ask_availability", { name: "Maria" });
      stepAnswer = '{"days":["Monday","Tuesday"],"hours":"9am-5pm"}';
      await handleOnboardingStep(PHONE, CHAT, "Mon and Tue, 9 to 5", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.availability).toEqual({ days: ["Monday", "Tuesday"], hours: "9am-5pm" });
      expect(stored.onboardingStep).toBe("caregiver_ask_job_type");
      // Natural either/or job-type question (no numbered menu).
      expect(sentMessages.some(m => m.text.includes("occasional fill-in shifts, part-time (under 25 hrs/week), or full-time work?"))).toBe(true);
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_availability", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "does it have to be fixed?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_availability");
      expect(sentMessages.some(m => m.text === "What days and hours are you generally available to work?")).toBe(true);
    });
  });

  // ── caregiver_ask_job_type ─────────────────────────────────────────────────────
  describe("caregiver_ask_job_type", () => {
    it("stores jobType and advances to caregiver_ask_rate", async () => {
      const session = seedSession("caregiver_ask_job_type", { name: "Maria", city: "Austin" });
      stepAnswer = "part_time";
      await handleOnboardingStep(PHONE, CHAT, "2", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.jobType).toBe("part_time");
      expect(stored.onboardingStep).toBe("caregiver_ask_rate");
      expect(sentMessages.some(m => m.text.includes("Part-time!") && m.text.includes("Austin"))).toBe(true);
    });

    it("unrecognized job type defaults to part_time and still advances", async () => {
      const session = seedSession("caregiver_ask_job_type", { name: "Maria" });
      stepAnswer = "gibberish";
      await handleOnboardingStep(PHONE, CHAT, "hmm", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.jobType).toBe("part_time");
      expect(stored.onboardingStep).toBe("caregiver_ask_rate");
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_job_type", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "what's the difference?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_job_type");
      expect(sentMessages.some(m => m.text === "Are you looking for occasional, part-time, or full-time work?")).toBe(true);
    });
  });

  // ── caregiver_ask_rate ─────────────────────────────────────────────────────────
  describe("caregiver_ask_rate", () => {
    it("stores hourlyRate and advances to caregiver_ask_email", async () => {
      const session = seedSession("caregiver_ask_rate", { name: "Maria" });
      stepAnswer = "22";
      await handleOnboardingStep(PHONE, CHAT, "$22", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.hourlyRate).toBe(22);
      expect(stored.onboardingStep).toBe("caregiver_ask_email");
      expect(sentMessages.some(m => m.text.includes("$22/hr works"))).toBe(true);
    });

    it("parse error re-asks WITHOUT advancing", async () => {
      const session = seedSession("caregiver_ask_rate", { name: "Maria" });
      stepAnswer = "__parse_error__";
      await handleOnboardingStep(PHONE, CHAT, "asdf", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_rate");
      expect(stored.onboardingData?.hourlyRate).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("I didn't catch that. What's your hourly rate?"))).toBe(true);
    });

    it("out-of-range rate re-asks WITHOUT advancing", async () => {
      const session = seedSession("caregiver_ask_rate", { name: "Maria" });
      stepAnswer = "500";
      await handleOnboardingStep(PHONE, CHAT, "500 an hour", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_rate");
      expect(stored.onboardingData?.hourlyRate).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("between $5 and $200"))).toBe(true);
    });

    it("mid-flow question re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_rate", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "what do others charge?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_rate");
      expect(sentMessages.some(m => m.text.includes("What's your hourly rate? Just a number works"))).toBe(true);
    });
  });

  // ── caregiver_ask_email ─────────────────────────────────────────────────────────
  describe("caregiver_ask_email", () => {
    it("stores email (lowercased) and advances to caregiver_ask_bio", async () => {
      const session = seedSession("caregiver_ask_email", { name: "Maria" });
      await handleOnboardingStep(PHONE, CHAT, "Maria@Example.com", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.email).toBe("maria@example.com");
      expect(stored.onboardingStep).toBe("caregiver_ask_bio");
      expect(sentMessages.some(m => m.text.includes("tell me about your approach to care"))).toBe(true);
    });

    it("invalid email re-asks WITHOUT advancing", async () => {
      const session = seedSession("caregiver_ask_email", { name: "Maria" });
      await handleOnboardingStep(PHONE, CHAT, "not an email", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_email");
      expect(stored.onboardingData?.email).toBeUndefined();
      expect(sentMessages.some(m => m.text.includes("doesn't look like a valid email"))).toBe(true);
    });

    it("mid-flow question (no @) re-asks without advancing", async () => {
      const session = seedSession("caregiver_ask_email", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "why do you need it?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("caregiver_ask_email");
      expect(sentMessages.some(m => m.text === "What's your email address?")).toBe(true);
    });

    it("text containing @ skips the question gate and is treated as an email attempt", async () => {
      // questionMode is ON, but the "@" short-circuits the question gate, so this
      // is validated as an email and stored.
      const session = seedSession("caregiver_ask_email", { name: "Maria" });
      questionMode = true;
      await handleOnboardingStep(PHONE, CHAT, "maria@example.com", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.email).toBe("maria@example.com");
      expect(stored.onboardingStep).toBe("caregiver_ask_bio");
    });
  });

  // ── caregiver_ask_bio (bespoke — kicks off the photo flow) ──────────────────────
  describe("caregiver_ask_bio", () => {
    it("stores bio and advances into the photo flow (bespoke handler, untouched)", async () => {
      const session = seedSession("caregiver_ask_bio", { name: "Maria", email: "maria@example.com" });
      await handleOnboardingStep(PHONE, CHAT, "I treat every client like family and focus on dignity.", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.bio).toContain("dignity");
      // Bio merges the bio then hands off to the bespoke handleCaregiverSendPhoto,
      // which advances to caregiver_awaiting_photo and sends the photo-upload ask.
      expect(stored.onboardingStep).toBe("caregiver_awaiting_photo");
      expect(sentMessages.some(m => typeof m.text === "string" && m.text.includes("profile photo"))).toBe(true);
    });
  });

  // ── NON-LINEAR steps stay bespoke (untouched by U3) ─────────────────────────────
  describe("non-linear steps remain bespoke", () => {
    it("caregiver_ask_location keeps its reverse-geocode + local-job teaser path (in-area)", async () => {
      const session = seedSession("caregiver_ask_location", { name: "Maria" });
      // In-area (Santa Clara County) so the service-area gate passes.
      stepAnswer = '{"city":"San Jose","zipCode":"95110"}';
      await handleOnboardingStep(PHONE, CHAT, "San Jose, CA 95110", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.city).toBe("San Jose");
      expect(stored.onboardingData.zipCode).toBe("95110");
      // Merged flow inserts cara-100's caregiver_ask_story step between location
      // and experience (mvr's flow went straight to experience).
      expect(stored.onboardingStep).toBe("caregiver_ask_story");
      // The bespoke handler sends the honest "no open jobs in <city>" teaser line.
      expect(sentMessages.some(m => m.text.includes("open jobs in San Jose"))).toBe(true);
    });

    it("caregiver out-of-area location is declined + waitlisted (Santa Clara County gate)", async () => {
      const session = seedSession("caregiver_ask_location", { name: "Maria" });
      stepAnswer = '{"city":"Austin","zipCode":"78701"}';
      await handleOnboardingStep(PHONE, CHAT, "Austin, TX 78701", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingStep).toBe("out_of_area_waitlisted");
      expect(stored.waitlisted).toBe(true);
      // A waitlist lead is captured and the user is told we don't cover their area.
      expect(hoisted.docState.get(`waitlist/${PHONE}`)).toBeTruthy();
      expect(sentMessages.some(m => /Santa Clara County/i.test(m.text))).toBe(true);
      // Did NOT advance into the rest of caregiver onboarding.
      expect(stored.onboardingStep).not.toBe("caregiver_ask_story");
    });

    it("caregiver_ask_profile keeps its bespoke handler (gender/languages/canDrive)", async () => {
      const session = seedSession("caregiver_ask_profile", { name: "Maria" });
      stepAnswer = '{"gender":"female","languages":["English"],"canDrive":true}';
      await handleOnboardingStep(PHONE, CHAT, "female, English, I can drive", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.onboardingData.gender).toBe("female");
      expect(stored.onboardingData.languages).toEqual(["English"]);
      expect(stored.onboardingData.canDrive).toBe(true);
      expect(stored.onboardingStep).toBe("caregiver_ask_availability");
    });

    it("caregiver_awaiting_membership routes to its bespoke awaiting handler (no step change)", async () => {
      const session = seedSession("caregiver_awaiting_membership", { name: "Maria" });
      await handleOnboardingStep(PHONE, CHAT, "did it go through?", session, { service: "SMS" });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      // Awaiting handler does not advance the step.
      expect(stored.onboardingStep).toBe("caregiver_awaiting_membership");
    });
  });
});
