import { beforeEach, describe, it, expect, vi } from "vitest";

const qaHarness = vi.hoisted(() => {
  const writes: Array<{ collection: string; id?: string; data: Record<string, unknown> }> = [];
  const sessionData: Record<string, unknown> = {};

  const makeChain = (collection = "", id?: string): any => ({
    collection: (name: string) => makeChain(name),
    doc: (docId?: string) => makeChain(collection, docId),
    where: () => makeChain(collection, id),
    orderBy: () => makeChain(collection, id),
    limit: () => makeChain(collection, id),
    get: async () => ({
      exists: collection === "agent_sessions" && Boolean(id),
      data: () => collection === "agent_sessions" ? sessionData : {},
      empty: true,
      docs: [],
      ref: makeChain(collection, id),
    }),
    set: async (data: Record<string, unknown>) => { writes.push({ collection, id, data }); },
    update: async (data: Record<string, unknown>) => { writes.push({ collection, id, data }); },
    add: async (data: Record<string, unknown>) => { writes.push({ collection, data }); return { id: "mock-id" }; },
    delete: async () => {},
  });
  const firestore: any = () => firestore;
  firestore.collection = (name: string) => makeChain(name);
  firestore.batch = () => ({ set: () => {}, update: () => {}, commit: async () => {} });
  firestore.FieldValue = { delete: () => "__delete__", serverTimestamp: () => "__timestamp__" };
  firestore.Timestamp = { fromMillis: (millis: number) => ({ millis }) };

  return {
    firestore,
    writes,
    sessionData,
    detectAndStageFactChange: vi.fn(async (..._args: unknown[]) => ({ kind: "not_correction" })),
    factChangeAckCopy: vi.fn((..._args: unknown[]) => null),
    findTombstonedRestatement: vi.fn(async (..._args: unknown[]) => null),
    classifyReRememberReply: vi.fn(async (..._args: unknown[]) => "other"),
    confirmReRemember: vi.fn(async (..._args: unknown[]) => ({ ok: false, reason: "not_found" })),
    quickComplete: vi.fn(async (..._args: unknown[]) => "SUPPORTED"),
    runAgentModelTurn: vi.fn(),
    getMemoryContext: vi.fn(async (..._args: unknown[]) => ""),
    initializeMemoryFiles: vi.fn(async (..._args: unknown[]) => undefined),
    getMemoryReconciliationState: vi.fn(async (..._args: unknown[]) => ({ pending: false, zepMasked: false, storageMasked: false })),
    // ── Childcare U10 seams ───────────────────────────────────────────────────
    getZepContextResult: vi.fn(async (..._args: unknown[]) => null),
    handleToolCall: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ success: true })),
    getChildcareFlags: vi.fn(async (..._args: unknown[]) => ({
      enabled: true, discoveryEnabled: true, writesEnabled: true, proactiveEnabled: false, emergencyOff: false,
    })),
    buildChildcareEnvelope: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown> | null> => ({
      vertical: "child",
      policyVersion: "childcare-envelope-test",
      actorUid: "client-123",
      phone: "+15555550123",
      role: "client",
      channel: "web",
      children: [{ childId: "c1", householdId: "h1", displayLabel: "Mia", ageBand: "preschool", scopes: ["view"] }],
      bookings: [],
      objectives: [],
      memory: {
        eligible: false, reason: "childcare_vertical", policyVersion: "p",
        subsystems: { zep: false, learnedFacts: false, conversationMemory: false, memoryFiles: false, summaries: false, evalCapture: false },
      },
      flags: { enabled: true, discoveryEnabled: true, writesEnabled: true, proactiveEnabled: false, emergencyOff: false },
      builtAt: "2026-07-23T00:00:00.000Z",
    })),
  };
});

// qaAgent imports a wide graph (firebase-admin, MCP, Zep, Claude). The
// helper we want to test is pure, but vitest will still load the module
// graph at import time — so stub the heavy dependencies aggressively.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    // `apps` is read at module-load by notifications.ts (`if (!admin.apps.length)`),
    // which is now in qaAgent's import graph via caraAgent → bookingExecutor.
    apps: [],
    initializeApp: () => ({}),
    firestore: qaHarness.firestore,
  },
  apps: [],
  initializeApp: () => ({}),
  firestore: qaHarness.firestore,
}));
vi.mock("../utils/claudeClient",   () => ({ getSharedClient: () => ({}) }));
vi.mock("../utils/openaiClient",   () => ({ quickComplete: (...args: unknown[]) => qaHarness.quickComplete(...args), getOpenAIClient: () => ({}), openAiTokenLimitParam: () => ({}) }));
vi.mock("../utils/claudeRetry",    () => ({ callClaudeWithRetry: vi.fn() }));
vi.mock("../safety/supervisor",    () => ({ supervise: (msg: string) => Promise.resolve(msg) }));
vi.mock("../safety/linter",        () => ({ lintMessage: (msg: string) => msg }));
vi.mock("../mcp/server",           () => ({
  MCP_TOOLS: [],
  CAREGIVER_TOOLS: [],
  CLIENT_TOOLS: [],
  // Childcare U10: a representative pack so the childcare branch binds real
  // tool defs and the dispatch guard can be exercised.
  CHILDCARE_CLIENT_TOOLS: [
    { name: "list_my_children", description: "d", input_schema: { type: "object", properties: {} } },
    { name: "get_childcare_bookings", description: "d", input_schema: { type: "object", properties: {} } },
    { name: "cancel_childcare_booking", description: "d", input_schema: { type: "object", properties: {} } },
    { name: "complete_task", description: "d", input_schema: { type: "object", properties: {} } },
  ],
  handleToolCall: (...args: unknown[]) => qaHarness.handleToolCall(...args),
  handleToolCallForCaregiver: vi.fn(),
}));
vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), getZepContextResult: (...args: unknown[]) => qaHarness.getZepContextResult(...args), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
// Childcare U10: envelope resolution is unit-tested in childcareSituation.test.ts;
// here it is a controllable seam so the qaAgent branch behavior is pinned.
vi.mock("./childcareSituation", () => ({
  CHILDCARE_ENVELOPE_POLICY_VERSION: "childcare-envelope-test",
  buildChildcareContextEnvelope: (...args: unknown[]) => qaHarness.buildChildcareEnvelope(...args),
  childcareEnvelopeHealth: () => ({ children: 1, bookings: 0, objectives: 0, flagsEnabled: true, memoryEligible: false }),
  projectChildcareSituation: () => ({ text: "CURRENT CHILDCARE SITUATION (test block)", chars: 40 }),
}));
vi.mock("../config/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChildcareFlags: (...args: unknown[]) => qaHarness.getChildcareFlags(...args),
}));
vi.mock("../memory/memoryFiles",   () => ({ getMemoryContext: (...args: unknown[]) => qaHarness.getMemoryContext(...args), initializeMemoryFiles: (...args: unknown[]) => qaHarness.initializeMemoryFiles(...args) }));
vi.mock("../memory/memoryOperations", () => ({ getMemoryReconciliationState: (...args: unknown[]) => qaHarness.getMemoryReconciliationState(...args) }));
vi.mock("../memory/learnedFacts",  () => ({
  getRelevantFacts: vi.fn(async () => []),
  detectAndStageFactChange: (...args: unknown[]) => qaHarness.detectAndStageFactChange(...args),
  factChangeAckCopy: (...args: unknown[]) => qaHarness.factChangeAckCopy(...args),
  findTombstonedRestatement: (...args: unknown[]) => qaHarness.findTombstonedRestatement(...args),
  classifyReRememberReply: (...args: unknown[]) => qaHarness.classifyReRememberReply(...args),
  confirmReRemember: (...args: unknown[]) => qaHarness.confirmReRemember(...args),
  RE_REMEMBER_QUESTION_COPY: "re-remember-question",
  RE_REMEMBER_CONFIRMED_COPY: "re-remember-confirmed",
  RE_REMEMBER_BLOCKED_COPY: "re-remember-blocked",
  FACT_CHANGE_NO_MATCH_COPY: "no-match",
}));
vi.mock("../memory/preferences",   () => ({ getPreferences: vi.fn(async () => null), isInDND: () => false }));
vi.mock("../linq/client",          () => ({ sendMessage: vi.fn(async () => undefined), startTyping: vi.fn(async () => undefined), stopTyping: vi.fn(async () => undefined) }));
vi.mock("./caraAgent",             () => ({ buildClickableMessage: (message: string) => message }));
vi.mock("./executionAgent",        () => ({ getActiveAgentForUser: vi.fn(async () => null) }));
vi.mock("./agentModelTurn",        () => ({ runAgentModelTurn: (...args: unknown[]) => qaHarness.runAgentModelTurn(...args) }));
vi.mock("./contextManagement",     () => ({ maybeRollUpHistory: vi.fn(async () => false), buildToolResultContent: vi.fn(async () => ""), patchDanglingToolCalls: () => 0, truncateOldToolCallArgs: () => 0, HISTORY_WINDOW: 24, HISTORY_OVERFETCH_LIMIT: 60, MIN_USER_ROWS_KEPT: 6, composeHistoryWindow: (rows: unknown[]) => rows }));
vi.mock("./operationalContext",    () => ({ loadCaraOperationalContext: vi.fn(async () => null), formatCaraOperationalContext: () => "", buildOperationalRecipeLead: () => "" }));
vi.mock("./situationSnapshot",     () => ({ buildCaregiverSnapshot: vi.fn(async () => ""), buildClientSnapshot: vi.fn(async () => "") }));
vi.mock("../data/seniorProfileRepository", () => ({ getSeniorProfileWithSource: vi.fn(async () => ({ profile: null, source: null })) }));
vi.mock("./turnCheckpoint",        () => ({ loadCheckpoint: vi.fn(async () => null), writeCheckpoint: vi.fn(async () => undefined), clearCheckpoint: vi.fn(async () => undefined), hashText: (value: string) => `hash:${value}` }));
vi.mock("./emotionalContext",      () => ({ classifyEmotionalContext: vi.fn(async () => "calm"), classifyEmotionalTopic: () => "general", blendEmotionalContext: () => ({ value: "calm", persist: null }), buildEmotionalContextDirective: () => "" }));
vi.mock("./skillPicker",           () => ({ pickSkill: vi.fn(async () => ({ skill: null })) }));
vi.mock("./skills",                () => ({ findSkill: () => null, buildSkillDirective: () => "" }));
vi.mock("./promptAugmenters",      () => ({ runAugmenters: vi.fn(async (systemPrompt: string) => ({ systemPrompt, applied: [] })) }));
vi.mock("./defaultPromptAugmenters", () => ({ DEFAULT_AUGMENTERS: [], buildCurrentTimeBlock: () => "" }));
vi.mock("./pendingActions",        () => ({ getLatestPending: vi.fn(async () => null) }));

import {
  hasListShape,
  detectConfidenceClaim,
  gateQuickReplyGrounding,
  detectMedicalAssertion,
  collectTurnToolObservations,
  detectPromiseWithoutToolCall,
  detectGenericHelpAsk,
  detectMedicationInstruction,
  detectPaymentAuthorityLeak,
  detectMultiQuestionDataCollection,
  detectSupportDeflection,
  buildClientSystemPrompt,
  buildCaregiverSystemPrompt,
  buildCaregiverCoreContext,
  isTrivialQuickReply,
  MEMORY_SOURCE_PRIORITY_POLICY,
  WARMTH_REFLECTION_OPENERS,
  ensureNonEmptyTurnText,
  sanitizeAnthropicMessages,
  applyZepContextResult,
  applyReconciliationMasking,
  ZEP_UNAVAILABLE_MARKER,
  MEMORY_RECONCILIATION_PENDING_MARKER,
  runQaAgent,
} from "./qaAgent";
import { createTurnMetrics, type TurnMetrics } from "./turnMetrics";
import type { ZepContextResult } from "../memory/zepClient";

describe("hasListShape", () => {
  it.each([
    ["1. foo\n2. bar",                       "multi-line numbered list"],
    ["1) foo\n2) bar",                       "multi-line numbered list w/ paren"],
    ["- foo\n- bar",                         "multi-line dash bullets"],
    ["* foo\n* bar",                         "multi-line asterisk bullets"],
    ["• foo\n• bar",                         "multi-line bullet glyph"],
    ["I need: 1. Your name 2. Your mom 3. Your city",  "inline 3+ numbered"],
    ["1. Your name\n2. Your mom's name and age\n3. What kind of help she needs day to day\n4. Your city/zip", "the actual screenshot pattern"],
  ])("flags %p (%s)", (input) => {
    expect(hasListShape(input)).toBe(true);
  });

  it.each([
    ["What's your name?",                          "single question"],
    ["Got it. And what's your mom's name?",        "two-sentence prose, no list markers"],
    ["She turns 78 next month — what a milestone.", "prose with one number, no list"],
    ["Can I get her doctor's name? Then I'll save it.", "prose, two sentences"],
    ["Going with option 1 for now.",               "single inline numeric reference"],
    ["",                                            "empty string"],
  ])("does NOT flag %p (%s)", (input) => {
    expect(hasListShape(input)).toBe(false);
  });
});

describe("detectConfidenceClaim", () => {
  it.each([
    ["Maria is free Wednesday.",            "proper-name availability assertion"],
    ["Alice is sick today.",                "proper-name state assertion"],
    ["Sarah is coming at 9.",               "proper-name schedule assertion"],
    ["I confirmed the appointment.",        "first-person done-claim"],
    ["Maria will arrive at 3pm.",           "named-person future action"],
    ["Dr. Chen is her primary physician.",  "relationship/role assertion"],
    ["Your invoice was $340.",              "concrete money claim"],
    ["Your mom has an appointment Tuesday at 2.", "appointment day fact"],
    ["She was diagnosed with diabetes.",    "confident medical assertion"],
  ])("flags %p (%s)", (input) => {
    expect(detectConfidenceClaim(input)).toBe(true);
  });

  it.each([
    ["Maria's notes mention smaller meals.",    "proper-name + ordinary verb, not a state claim"],
    ["I'll ask Alice about Wednesday.",         "future-tense ask, not a confident claim"],
    ["Let me check her schedule.",              "promise without assertion"],
    ["",                                         "empty"],
  ])("does NOT flag %p (%s)", (input) => {
    expect(detectConfidenceClaim(input)).toBe(false);
  });
});

describe("detectMedicalAssertion", () => {
  it.each([
    ["She was diagnosed with early-stage dementia.", "was diagnosed"],
    ["He is taking Lisinopril for blood pressure.",  "is taking a med"],
    ["Her blood pressure is 140 over 90.",           "stated vital"],
    ["Your dad has diabetes.",                        "named condition"],
  ])("flags confident medical fact %p (%s)", (input) => {
    expect(detectMedicalAssertion(input)).toBe(true);
  });

  it.each([
    ["I can't advise on changing meds — please call her doctor.", "safe deflection, no asserted fact"],
    ["It might be worth asking her doctor about that.",            "hedged, no flat assertion"],
    ["Let me check what's on her care plan.",                      "promise, no assertion"],
  ])("does NOT flag %p (%s)", (input) => {
    expect(detectMedicalAssertion(input)).toBe(false);
  });
});

describe("collectTurnToolObservations", () => {
  it("flattens string and text-block tool_result content, ignoring other blocks", () => {
    const messages = [
      { role: "user" as const, content: "who is coming?" },
      { role: "assistant" as const, content: [{ type: "tool_use", id: "t1", name: "get_schedule", input: {} }] },
      { role: "user" as const, content: [
        { type: "tool_result", tool_use_id: "t1", content: "Maria, Tuesday 9am" },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "invoice $85" }] },
      ] },
    ] as never;
    const out = collectTurnToolObservations(messages);
    expect(out).toContain("Maria, Tuesday 9am");
    expect(out).toContain("invoice $85");
    expect(out).not.toContain("who is coming?");
  });

  it("returns empty string when no tools ran", () => {
    const messages = [{ role: "user" as const, content: "hi" }] as never;
    expect(collectTurnToolObservations(messages)).toBe("");
  });

  it("excludes entries before fromIndex — prior-turn history can't pass as fresh grounding", () => {
    const messages = [
      { role: "user" as const, content: [
        { type: "tool_result", tool_use_id: "old", content: "STALE: Maria, LAST Tuesday" },
      ] },
      { role: "user" as const, content: "who is coming?" },
      { role: "user" as const, content: [
        { type: "tool_result", tool_use_id: "t1", content: "Maria, Tuesday 9am" },
      ] },
    ] as never;
    const out = collectTurnToolObservations(messages, 2);
    expect(out).toContain("Maria, Tuesday 9am");
    expect(out).not.toContain("STALE");
  });
});

describe("detectPromiseWithoutToolCall", () => {
  it("flags 'let me check' when zero tools were called", () => {
    expect(detectPromiseWithoutToolCall("Let me check her schedule.", 0)).toBe(true);
    expect(detectPromiseWithoutToolCall("I'll look that up for you.", 0)).toBe(true);
    expect(detectPromiseWithoutToolCall("I'll come back to you on that one.", 0)).toBe(true);
  });

  it("does NOT flag when at least one tool was called", () => {
    expect(detectPromiseWithoutToolCall("Let me check her schedule.", 1)).toBe(false);
    expect(detectPromiseWithoutToolCall("I'll look that up for you.", 2)).toBe(false);
  });

  it("does NOT flag prose without promise phrasing", () => {
    expect(detectPromiseWithoutToolCall("Thursday 9am.", 0)).toBe(false);
    expect(detectPromiseWithoutToolCall("She's doing well today.", 0)).toBe(false);
  });
});

describe("conversation quality detectors", () => {
  it.each([
    "What's your name? And what's your mom's name?",
    "Can I get her name and phone number?",
    "Please send me her name, age, city, zip, and care needs.",
  ])("flags multi-question or form-like intake %p", (input) => {
    expect(detectMultiQuestionDataCollection(input)).toBe(true);
  });

  it.each([
    "What's her phone number?",
    "What date and time works?",
    "Can you confirm Thursday at 9?",
    "Got it. And what's your mom's name?",
  ])("allows one concrete ask %p", (input) => {
    expect(detectMultiQuestionDataCollection(input)).toBe(false);
  });

  it.each([
    "Please contact support for that.",
    "The Evia team will follow up.",
    "I'd recommend reaching out to our team.",
  ])("flags support deflection %p", (input) => {
    expect(detectSupportDeflection(input)).toBe(true);
  });

  it.each([
    "I opened a support ticket with those details.",
    "I can handle that here.",
  ])("allows action-oriented support language %p", (input) => {
    expect(detectSupportDeflection(input)).toBe(false);
  });

  it.each([
    "What can I help you with?",
    "How can I help today?",
    "Is there anything else I can help with?",
  ])("flags generic helper prompts %p", (input) => {
    expect(detectGenericHelpAsk(input)).toBe(true);
  });

  it.each([
    "Hey. Maria is coming at 9.",
    "Anytime.",
  ])("allows context-led short replies %p", (input) => {
    expect(detectGenericHelpAsk(input)).toBe(false);
  });

  it.each([
    "Give her an extra dose tonight.",
    "Increase the medication to 20mg.",
    "Skip the pill if she feels dizzy.",
  ])("flags medication instructions %p", (input) => {
    expect(detectMedicationInstruction(input)).toBe(true);
  });

  it.each([
    "I can't advise on changing meds. Please call her doctor or pharmacist.",
    "If this feels urgent, call 911 now.",
  ])("allows clinical redirection %p", (input) => {
    expect(detectMedicationInstruction(input)).toBe(false);
  });

  it.each([
    "Reply APPROVE and I'll release payment.",
    "You can approve the hours here.",
    "I'll pay Maria now.",
  ])("flags payment authority leaks %p", (input) => {
    expect(detectPaymentAuthorityLeak(input)).toBe(true);
  });

  it.each([
    "I can't approve payment from this family group - the primary account holder has to approve Maria's hours.",
    "The primary client must approve the invoice.",
  ])("allows payment boundary language %p", (input) => {
    expect(detectPaymentAuthorityLeak(input)).toBe(false);
  });
});

describe("isTrivialQuickReply", () => {
  it.each([
    "hi",
    "hey",
    "thanks",
  ])("allows pure social short replies %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(true);
  });

  it.each([
    "hi did maria come",
    "thanks approve it",
    "mom fell",
    "am I approved",
    "pay maria",
    "refer Ana",
    "dad meds",
  ])("routes care, payment, safety, approval, or referral context through the full agent %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(false);
  });
});

describe("WARMTH_REFLECTION_OPENERS", () => {
  it.each([
    "That sounds exhausting — let me look.",
    "That fear makes sense, and you noticing this matters.",
    "I hear you, and that's not okay.",
    "I can imagine how hard that is.",
    "I'm so sorry.",
    "You're right, that shouldn't have happened.",
    "It makes sense you'd be worried.",
  ])("matches empathy opener %p", (s) => {
    expect(WARMTH_REFLECTION_OPENERS.test(s)).toBe(true);
  });

  it.each([
    "9am Thursday with Maria.",
    "Maria's coming at 9.",
    "Yes, Alice has 10am free.",
    "I've cancelled the visit.",
  ])("does NOT match transactional opener %p", (s) => {
    expect(WARMTH_REFLECTION_OPENERS.test(s)).toBe(false);
  });
});

describe("memory source priority prompt", () => {
  it("instructs Evia to prefer fresh tool/user facts over stale long-term memory", () => {
    const prompt = buildClientSystemPrompt(
      { name: "Anita", needs: ["companionship"] },
      [],
      null,
      null,
      "- Mom is 82 (profile)",
      "Zep says Mom is 78",
      "## profile\nMom is 78",
      null,
      "",
    );

    expect(prompt).toContain(MEMORY_SOURCE_PRIORITY_POLICY);
    expect(prompt).toContain("The user's latest message");
    expect(prompt).toContain("Fresh tool results or live Firestore state");
    expect(prompt).toContain("Never use older memory to override a newer user correction");
    expect(prompt).toContain("forget or stop remembering");
  });
});

// Regression for the canary BadRequestError (2026-06-29): an empty inbound turn
// (reaction / caption-less media / blank SMS) sent Claude an empty content string
// → Anthropic 400 on iteration 1 → fallback path. The guard must never return "".
describe("ensureNonEmptyTurnText — no empty Claude content (BadRequestError guard)", () => {
  it("passes real text through unchanged", () => {
    expect(ensureNonEmptyTurnText("I need a caregiver for my mom")).toBe("I need a caregiver for my mom");
  });

  it.each(["", "   ", "\n\t ", null, undefined])("substitutes a descriptor for blank input %j", (input) => {
    const out = ensureNonEmptyTurnText(input as any);
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain("no text");
  });
});

// Regression for the live "give me a few minutes" doom-loop (2026-06-29): a
// malformed conversation-history window 400'd the FIRST Claude call every turn.
describe("sanitizeAnthropicMessages — keeps the history window API-valid", () => {
  it("drops empty (whitespace-only) string-content entries", () => {
    const out = sanitizeAnthropicMessages([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "  " },
      { role: "assistant", content: "real reply" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "real reply" },
    ]);
  });

  it("strips leading non-user turns so the array starts with role:user", () => {
    const out = sanitizeAnthropicMessages([
      { role: "assistant", content: "What's your name?" },
      { role: "user", content: "Imran" },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "Imran" });
    expect(out).toHaveLength(1);
  });

  it("leaves a well-formed array untouched and preserves block-array content", () => {
    const blocks = [{ type: "tool_result", tool_use_id: "t1", content: "ok" }];
    const msgs = [
      { role: "user", content: "find a caregiver" },
      { role: "assistant", content: "Checking…" },
      { role: "user", content: blocks },
    ];
    expect(sanitizeAnthropicMessages(msgs as any)).toEqual(msgs);
  });
});

// U6 (hallucination hardening 2026-07-17, R9): the caregiver prompt never
// fabricates a default hourly rate. With a real rate on file it states it;
// with none, the earnings line is omitted entirely — no silent "$22/hr".
describe("buildCaregiverSystemPrompt — earnings line (R9, no fabricated money defaults)", () => {
  it("states the real rate when hourlyRate is on file", () => {
    const prompt = buildCaregiverSystemPrompt({ name: "Maria", hourlyRate: 27 }, null);
    expect(prompt).toContain("$27");
    expect(prompt).toContain("The caregiver earns $27/hr.");
  });

  it("omits the earnings line entirely when hourlyRate is unset (no $22 default)", () => {
    const prompt = buildCaregiverSystemPrompt({ name: "Maria" }, null);
    expect(prompt).not.toContain("$22");
    expect(prompt).not.toContain("earns $");
    // The payments fact survives; the prompt explicitly forbids guessing a rate.
    expect(prompt).toContain("Payments are processed automatically after each visit.");
    expect(prompt).toContain("never state or guess a dollar rate");
  });

  it("treats a non-numeric hourlyRate as unset (no invented number)", () => {
    const prompt = buildCaregiverSystemPrompt({ name: "Maria", hourlyRate: "flexible" }, null);
    expect(prompt).not.toContain("earns $");
    expect(prompt).not.toContain("$22");
  });
});

// Caregiver mirror of the client core context (U4) - pure over the caregivers
// doc, so it's testable without any Firestore fixture.
describe("buildCaregiverCoreContext", () => {
  const fullDoc = {
    name:            "Maria Lopez",
    city:            "San Jose",
    zipCode:         "95112",
    specialties:     ["dementia care", "mobility support"],
    certifications:  ["CNA", "CPR"],
    yearsExperience: 6,
    languages:       ["English", "Spanish"],
    canDrive:        true,
    availability: {
      monday: [{ start: "06:00", end: "12:00" }],
      friday: [{ start: "12:00", end: "18:00" }, { start: "18:00", end: "23:00" }],
    },
    status:              "active",
    verificationStatus:  "approved",
    onboardingStatus:    "profile_complete",
    backgroundCheckData: { status: "clear" },
  };

  it("returns empty string for a missing caregiver doc", () => {
    expect(buildCaregiverCoreContext(null)).toBe("");
    expect(buildCaregiverCoreContext(undefined)).toBe("");
  });

  it("returns empty string when the doc has none of the surfaced fields", () => {
    expect(buildCaregiverCoreContext({ hourlyRate: 25 })).toBe("");
  });

  // ── Childcare vertical (dual-vertical caregivers) ──────────────────────────
  describe("childcare vertical", () => {
    // THE parity pin: recomputeChildcareProviderVisibility deliberately writes
    // no summary for senior-only caregivers (AE9 byte-identical projection), so
    // a senior-only doc must produce byte-identical context to before childcare
    // existed. If this drifts, every senior caregiver's prompt changed.
    it("emits NOTHING for a senior-only caregiver", () => {
      const out = buildCaregiverCoreContext(fullDoc);
      expect(out).not.toMatch(/childcare/i);
      expect(out).not.toContain("CHILDCARE PROFILE");
      expect(out).not.toContain("CHILDCARE STATUS");
    });

    it("surfaces the childcare profile separately from senior skills", () => {
      const out = buildCaregiverCoreContext({
        ...fullDoc,
        yearsChildcareExperience: 4,
        childcareAgeBands: ["toddler", "school_age"],
        childcareServices: ["babysitting", "after_school_care"],
      });
      expect(out).toContain("CHILDCARE PROFILE (separate from senior care)");
      expect(out).toContain("4 years childcare experience");
      expect(out).toContain("toddler, school_age");
      expect(out).toContain("babysitting, after_school_care");
      // Senior skills must still be present and unmerged.
      expect(out).toContain("dementia care");
      expect(out).toContain("6 years experience");
    });

    it("states APPROVED plainly when discoverable, so Evia can answer 'am I approved'", () => {
      const out = buildCaregiverCoreContext({
        ...fullDoc,
        childcareProvider: {
          visible: true,
          approvalState: "approved",
          evidenceStatus: "clear",
          transportCapable: true,
        },
      });
      expect(out).toContain("APPROVED and discoverable for childcare jobs");
      expect(out).toContain("cleared to transport children");
      expect(out).toContain("OVERRIDES anything");
    });

    it("says NOT discoverable when visible is false — never leaves it ambiguous", () => {
      // The 2026-07-22 incident shape: silence lets stale memory answer. An
      // explicit negative is required, not an omission.
      const out = buildCaregiverCoreContext({
        ...fullDoc,
        childcareProvider: { visible: false, approvalState: "pending", evidenceStatus: "none" },
      });
      expect(out).toContain("NOT yet discoverable for childcare jobs");
      expect(out).toContain("approval pending");
    });

    it("treats a missing `visible` as NOT discoverable (fail closed)", () => {
      const out = buildCaregiverCoreContext({ ...fullDoc, childcareProvider: {} });
      expect(out).toContain("NOT yet discoverable");
    });

    it("does not claim transport clearance unless explicitly true", () => {
      for (const transportCapable of [false, undefined, "yes"]) {
        const out = buildCaregiverCoreContext({
          ...fullDoc,
          childcareProvider: { visible: true, transportCapable },
        });
        expect(out, `transportCapable=${String(transportCapable)}`)
          .not.toContain("cleared to transport");
      }
    });

    it("keeps senior and childcare status as two distinct blocks", () => {
      const out = buildCaregiverCoreContext({
        ...fullDoc,
        childcareProvider: { visible: true, approvalState: "approved" },
      });
      expect(out).toContain("ACCOUNT STATUS");
      expect(out).toContain("CHILDCARE STATUS");
      // Senior bg-check wording must not be reused for childcare evidence.
      expect(out).toContain("background check CLEARED");
    });
  });

  it("surfaces service area, skills, availability, and verification/account status", () => {
    const out = buildCaregiverCoreContext(fullDoc);
    expect(out).toContain("SERVICE AREA: San Jose, 95112.");
    expect(out).toContain("specialties: dementia care, mobility support");
    expect(out).toContain("certifications: CNA, CPR");
    expect(out).toContain("6 years experience");
    expect(out).toContain("languages: English, Spanish");
    expect(out).toContain("can drive");
    expect(out).toContain("WEEKLY AVAILABILITY");
    expect(out).toContain("Mon 06:00-12:00");
    expect(out).toContain("Fri 12:00-18:00, 18:00-23:00");
    // 2026-07-22 incident: status line is now explicitly live/authoritative and
    // a "clear" check is spelled out so stale memory can never override it.
    expect(out).toContain("ACCOUNT STATUS (live, read just now");
    expect(out).toContain("account active, verification approved, background check CLEARED (done — never say pending or processing), onboarding profile_complete.");
  });

  it("reads the LIVE backgroundCheckStatus field, not just legacy backgroundCheckData", () => {
    const out = buildCaregiverCoreContext({
      name: "Imran", backgroundCheckStatus: "clear", membershipPaid: true, stripeAccountId: "acct_1",
    });
    expect(out).toContain("CAREGIVER NAME: Imran.");
    expect(out).toContain("background check CLEARED");
    expect(out).toContain("caregiver membership PAID and active");
    expect(out).toContain("payout account connected");
  });

  it("tells Evia the availability snapshot may be stale and which tools to use", () => {
    const out = buildCaregiverCoreContext(fullDoc);
    expect(out).toContain("get_caregiver_info");
    expect(out).toContain("update_caregiver_availability");
  });

  it("handles legacy availability shapes (free-text string and block array)", () => {
    const asString = buildCaregiverCoreContext({ ...fullDoc, availability: "weekday mornings" });
    expect(asString).toContain("weekday mornings");
    const asArray = buildCaregiverCoreContext({ ...fullDoc, availability: ["Morning", "Evening"] });
    expect(asArray).toContain("Morning, Evening");
  });

  it("omits sections whose inputs are missing instead of emitting empty labels", () => {
    const out = buildCaregiverCoreContext({ city: "Gilroy", status: "paused" });
    expect(out).toContain("SERVICE AREA: Gilroy.");
    expect(out).toContain("account paused.");
    expect(out).not.toContain("SKILLS AND EXPERIENCE");
    expect(out).not.toContain("WEEKLY AVAILABILITY");
  });
});

describe("gateQuickReplyGrounding", () => {
  const FACTS = "Known context:\n- NEXT VISIT: Ana is coming on Friday at 10.";
  const RECENT = [{ role: "user" as const, content: "hi" }];
  const fallback = () => "Hey! Ana is coming Friday — anything you want me to pass along?";
  const base = {
    usedDeterministicFallback: false,
    groundingContext: FACTS,
    recent: RECENT,
    fallback,
  };

  it("swaps an UNSUPPORTED reply for the deterministic fallback", async () => {
    const checker = vi.fn().mockResolvedValue("UNSUPPORTED");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toMatchObject({ reply: fallback(), triggered: true, swapped: true });
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("keeps a SUPPORTED reply unchanged", async () => {
    const checker = vi.fn().mockResolvedValue("SUPPORTED");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Ana is coming Friday at 10.", checker });
    expect(out).toMatchObject({ reply: "Ana is coming Friday at 10.", triggered: true, swapped: false });
  });

  it("fails CLOSED when the checker throws — deterministic fallback goes out, not the model reply (U4)", async () => {
    const checker = vi.fn().mockRejectedValue(new Error("checker down"));
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toMatchObject({ reply: fallback(), triggered: true, swapped: true });
  });

  it("fails CLOSED on a garbage/unparseable verdict — deterministic fallback goes out (U4)", async () => {
    const checker = vi.fn().mockResolvedValue("hmm, hard to say really");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toMatchObject({ reply: fallback(), triggered: true, swapped: true });
  });

  it("fails CLOSED on an empty verdict — deterministic fallback goes out (U4)", async () => {
    const checker = vi.fn().mockResolvedValue("");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toMatchObject({ reply: fallback(), triggered: true, swapped: true });
  });

  it("never re-gates a deterministic fallback (checker not called — no loop)", async () => {
    const checker = vi.fn();
    const out = await gateQuickReplyGrounding({
      ...base,
      reply: "Maria is coming Thursday at 3.",
      usedDeterministicFallback: true,
      checker,
    });
    expect(out.swapped).toBe(false);
    expect(out.triggered).toBe(false);
    expect(checker).not.toHaveBeenCalled();
  });

  it("skips the checker entirely when the reply asserts no specific fact", async () => {
    const checker = vi.fn();
    const out = await gateQuickReplyGrounding({ ...base, reply: "Hey! How's everything going?", checker });
    expect(out).toMatchObject({ reply: "Hey! How's everything going?", triggered: false, swapped: false });
    expect(checker).not.toHaveBeenCalled();
  });

  it("feeds the checker the FACTS context and draft — never persona example copy", async () => {
    const checker = vi.fn().mockResolvedValue("SUPPORTED");
    await gateQuickReplyGrounding({ ...base, reply: "Ana is coming Friday at 10.", checker });
    const payload = checker.mock.calls[0][1] as string;
    expect(payload).toContain("NEXT VISIT: Ana is coming on Friday at 10.");
    expect(payload).toContain("DRAFT:\nAna is coming Friday at 10.");
    // The persona's hardcoded Examples block must never reach the checker —
    // a fabricated reply matching an example would read as SUPPORTED.
    expect(payload).not.toContain("Examples of good context-led greetings");
    expect(payload).not.toContain("Maria's coming Thursday at 3");
  });

  // ── U7: risk-tier classifier parity on the quick path (R18) ────────────────
  // The legacy detector needed a proper name, so pronoun-led medical/age/
  // location/identity/payment claims bypassed this gate entirely. Each plan
  // false-negative fixture must now be a candidate (checker invoked) and, when
  // UNSUPPORTED, swap to the deterministic fallback.
  describe("U7 risk-tier candidates (quick-path parity)", () => {
    it.each([
      ["She has Parkinson's.",                     "medical_condition"],
      ["She is allergic to penicillin.",           "allergy"],
      ["She had a stroke last year.",              "medical_event"],
      ["He has kidney disease.",                   "medical_condition"],
      ["She is 82.",                               "age"],
      ["She lives in Sacramento.",                 "location"],
      ["He is her son.",                           "relationship_identity"],
      ["Your mom has an appointment Tuesday at 2.", "schedule_appointment"],
      ["She is available tomorrow afternoon.",     "caregiver_availability"],
      ["Your invoice was $340.",                   "money_payment"],
      ["Your refund was processed yesterday.",     "money_payment"],
      ["I've cancelled Thursday's visit for you.", "action_authorization"],
    ] as const)("catches %p (%s) and swaps on UNSUPPORTED", async (reply, category) => {
      const checker = vi.fn().mockResolvedValue("UNSUPPORTED");
      const out = await gateQuickReplyGrounding({ ...base, reply, checker });
      expect(checker).toHaveBeenCalledTimes(1);
      expect(out.swapped).toBe(true);
      expect(out.reply).toBe(fallback());
      expect(out.verdict).toBe("unsupported");
      expect(out.claims.map((c) => c.category)).toContain(category);
    });

    it("passes the CURRENT USER MESSAGE to the checker as its own evidence block (R19)", async () => {
      const checker = vi.fn().mockResolvedValue("SUPPORTED");
      await gateQuickReplyGrounding({
        ...base,
        reply: "Got it — your mom is 82, I'll note that.",
        currentInbound: "my mom is 82",
        checker,
      });
      const payload = checker.mock.calls[0][1] as string;
      expect(payload).toContain("CURRENT USER MESSAGE:\nmy mom is 82");
    });

    it("a fact truthfully repeated from the current inbound is SUPPORTED and ships unchanged (R19)", async () => {
      // The verifier sees the inbound in its evidence and answers SUPPORTED —
      // the reply passes through instead of being swapped for the fallback.
      const checker = vi.fn(async (_sys: string, payload: string) =>
        payload.includes("CURRENT USER MESSAGE:\nmy mom is 82") ? "SUPPORTED" : "UNSUPPORTED");
      const out = await gateQuickReplyGrounding({
        ...base,
        reply: "Got it — since she's 82, I'll keep that in mind.",
        currentInbound: "my mom is 82",
        checker,
      });
      expect(out.swapped).toBe(false);
      expect(out.verdict).toBe("supported");
      expect(out.reply).toBe("Got it — since she's 82, I'll keep that in mind.");
    });

    it("grounded prior-context control: tool/context-backed claim stays untouched", async () => {
      const checker = vi.fn().mockResolvedValue("SUPPORTED");
      const out = await gateQuickReplyGrounding({ ...base, reply: "Ana is coming Friday at 10.", checker });
      expect(out.swapped).toBe(false);
      expect(out.verdict).toBe("supported");
    });

    it("checker timeout/garbage on a HIGH-RISK claim fails closed with an indeterminate verdict", async () => {
      const thrown = vi.fn().mockRejectedValue(new Error("timeout"));
      const out1 = await gateQuickReplyGrounding({ ...base, reply: "She has Parkinson's.", checker: thrown });
      expect(out1.swapped).toBe(true);
      expect(out1.verdict).toBe("indeterminate");

      const garbage = vi.fn().mockResolvedValue("who can say");
      const out2 = await gateQuickReplyGrounding({ ...base, reply: "She is allergic to penicillin.", checker: garbage });
      expect(out2.swapped).toBe(true);
      expect(out2.verdict).toBe("indeterminate");
    });

    it("returned claims serialize to categories/risk only — no draft text (R21)", async () => {
      const checker = vi.fn().mockResolvedValue("UNSUPPORTED");
      const out = await gateQuickReplyGrounding({ ...base, reply: "She is allergic to penicillin.", checker });
      const json = JSON.stringify({ claims: out.claims, verdict: out.verdict });
      expect(json).not.toContain("penicillin");
      expect(json).toContain("allergy");
    });

    it("kill switch OFF restores the legacy detector — pronoun-led claim is no longer a candidate", async () => {
      const env = { GROUNDING_RISK_TIERS_ENABLED: "false" };
      const checker = vi.fn().mockResolvedValue("UNSUPPORTED");
      // Pre-U7 false negative: legacy detector misses it, gate skips entirely.
      const missed = await gateQuickReplyGrounding({ ...base, reply: "She has Parkinson's.", checker, env });
      expect(missed.triggered).toBe(false);
      expect(missed.swapped).toBe(false);
      expect(checker).not.toHaveBeenCalled();
      // …while a legacy-detected claim still gates exactly as before.
      const caught = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker, env });
      expect(caught.triggered).toBe(true);
      expect(caught.swapped).toBe(true);
    });
  });
});

// ── U7: full-path wiring characterization (quick/full parity, R19/R21) ───────
// The full QA path's gate lives deep inside runQaAgent (too heavy to drive in a
// unit test), so pin its wiring at the source level: the same classifier, the
// same typed verdict parse, the current inbound as evidence, and no raw
// question/draft content in the gate's telemetry writes.
describe("U7 full-path grounding gate wiring (source characterization)", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src: string = fs.readFileSync(path.resolve(__dirname, "qaAgent.ts"), "utf8");

  it("full path passes the current inbound (text) as the payload's evidence block", () => {
    expect(src).toContain("buildHandoffGroundingPayload(systemPrompt, history, reply, toolObservations, text)");
  });

  it("both paths classify with the same risk-tier classifier and honor the kill switch", () => {
    const hits = src.match(/classifyGroundingClaims\(reply\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // main gate + quick gate
    const switchHits = src.match(/isRiskTierGroundingEnabled\(/g) ?? [];
    expect(switchHits.length).toBeGreaterThanOrEqual(2);
    // Legacy detector stays callable behind the switch on both paths.
    expect(src).toContain(": detectConfidenceClaim(reply)");
  });

  it("full path resolves the typed verdict through the risk-tier action resolver", () => {
    expect(src).toContain("parseGroundingVerdictTyped(verdictRaw)");
    expect(src).toContain("resolveGroundingGateAction({");
    expect(src).toContain("neutralCopyForClaims(groundingClaims)");
  });

  it("gate telemetry carries hashes/enums — the raw question/draft snippets are gone (R21)", () => {
    // The pre-U7 uncertainty-log/alert writes quoted the question and reply.
    expect(src).not.toContain("suppressedReply: reply.slice");
    expect(src).not.toContain("question:    text.slice(0, 200),\n          reply:       reply.slice(0, 500),");
    // Handoff/neutralize/suppressed records all reference the turn by hash.
    const gateRegion = src.slice(src.indexOf("resolveGroundingGateAction({"));
    expect(gateRegion).toContain("turnHash:  turnTextHash");
    expect(gateRegion).toContain("draftHash");
  });

  it("neutralized turns bypass the self-repeat rewrite (deterministic copy stays deterministic)", () => {
    expect(src).toContain("!handedOff && !groundingNeutralizedThisTurn && reply.trim()");
  });
});

// U1: typed Zep context → prompt/metrics mapping. One shared function serves
// both the client and caregiver branches, so parity is structural — these
// tests pin the semantics per status and prove the two roles cannot diverge.
describe("runQaAgent re-remember and grounding behavior", () => {
  const baseParams = {
    phone: "+15555550123",
    chatId: "chat-re-remember",
    userId: "client-123",
    seniorId: "senior-123",
    userType: "client" as const,
    skipSend: true,
  };

  const agentText = (text: string) => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const normalReply = "I can help with that.";

  beforeEach(() => {
    qaHarness.writes.length = 0;
    for (const key of Object.keys(qaHarness.sessionData)) delete qaHarness.sessionData[key];
    qaHarness.detectAndStageFactChange.mockReset();
    qaHarness.detectAndStageFactChange.mockResolvedValue({ kind: "not_correction" });
    qaHarness.factChangeAckCopy.mockReset();
    qaHarness.factChangeAckCopy.mockReturnValue(null);
    qaHarness.findTombstonedRestatement.mockReset();
    qaHarness.findTombstonedRestatement.mockResolvedValue(null);
    qaHarness.classifyReRememberReply.mockReset();
    qaHarness.classifyReRememberReply.mockResolvedValue("other");
    qaHarness.confirmReRemember.mockReset();
    qaHarness.confirmReRemember.mockResolvedValue({ ok: false, reason: "not_found" });
    qaHarness.quickComplete.mockReset();
    qaHarness.quickComplete.mockResolvedValue("SUPPORTED");
    qaHarness.runAgentModelTurn.mockReset();
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText(normalReply));
  });

  it("returns the confirmed copy when a pending re-remember is confirmed", async () => {
    qaHarness.classifyReRememberReply.mockResolvedValue("confirm");
    qaHarness.confirmReRemember.mockResolvedValue({ ok: true, reason: "" });

    const reply = await runQaAgent({
      ...baseParams,
      text: "yes, remember that again",
      session: {
        pendingReRememberFactId: "fact-1",
        pendingReRememberFact: "Mom prefers tea.",
        pendingReRememberCategory: "preference",
        pendingReRememberExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(reply).toBe("re-remember-confirmed");
    expect(qaHarness.classifyReRememberReply).toHaveBeenCalledWith("yes, remember that again");
    expect(qaHarness.confirmReRemember).toHaveBeenCalledWith(expect.objectContaining({
      userId: "client-123",
      factDocId: "fact-1",
      phone: "+15555550123",
      restatedFact: { fact: "Mom prefers tea.", category: "preference" },
    }));
    expect(qaHarness.runAgentModelTurn).not.toHaveBeenCalled();
  });

  it("returns the blocked copy when pending reconciliation prevents re-remembering", async () => {
    qaHarness.classifyReRememberReply.mockResolvedValue("confirm");
    qaHarness.confirmReRemember.mockResolvedValue({ ok: false, reason: "reconciliation_pending" });

    const reply = await runQaAgent({
      ...baseParams,
      text: "yes",
      session: {
        pendingReRememberFactId: "fact-2",
        pendingReRememberExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(reply).toBe("re-remember-blocked");
    expect(qaHarness.confirmReRemember).toHaveBeenCalledTimes(1);
    expect(qaHarness.runAgentModelTurn).not.toHaveBeenCalled();
  });

  it("continues the normal turn when a pending re-remember is declined", async () => {
    qaHarness.classifyReRememberReply.mockResolvedValue("decline");

    const reply = await runQaAgent({
      ...baseParams,
      text: "no, leave it forgotten",
      session: {
        pendingReRememberFactId: "fact-3",
        pendingReRememberExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(reply).toBe(normalReply);
    expect(qaHarness.classifyReRememberReply).toHaveBeenCalledTimes(1);
    expect(qaHarness.confirmReRemember).not.toHaveBeenCalled();
    expect(qaHarness.detectAndStageFactChange).toHaveBeenCalledWith(expect.objectContaining({
      userId: "client-123",
      text: "no, leave it forgotten",
    }));
    expect(qaHarness.runAgentModelTurn).toHaveBeenCalledTimes(1);
  });

  it("does not classify an expired re-remember confirmation and continues the normal turn", async () => {
    const reply = await runQaAgent({
      ...baseParams,
      text: "yes",
      session: {
        pendingReRememberFactId: "fact-4",
        pendingReRememberExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(reply).toBe(normalReply);
    expect(qaHarness.classifyReRememberReply).not.toHaveBeenCalled();
    expect(qaHarness.confirmReRemember).not.toHaveBeenCalled();
    expect(qaHarness.runAgentModelTurn).toHaveBeenCalledTimes(1);
  });

  it("runs the legacy full-path grounding behavior when risk tiers are disabled", async () => {
    const previous = process.env.GROUNDING_RISK_TIERS_ENABLED;
    process.env.GROUNDING_RISK_TIERS_ENABLED = "false";
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("She was diagnosed with Parkinson's."));
    // The legacy parser treats an ambiguous verifier response as supported. The
    // typed U7 path would neutralize this high-risk claim instead.
    qaHarness.quickComplete.mockResolvedValue("not enough information");

    try {
      const reply = await runQaAgent({ ...baseParams, text: "How is Mom doing?", session: {} });

      expect(reply).toBe("She was diagnosed with Parkinson's.");
      expect(qaHarness.quickComplete).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("DRAFT:\nShe was diagnosed with Parkinson's."),
        expect.objectContaining({ maxTokens: 8 }),
      );
    } finally {
      if (previous === undefined) delete process.env.GROUNDING_RISK_TIERS_ENABLED;
      else process.env.GROUNDING_RISK_TIERS_ENABLED = previous;
    }
  });
});

// P1 data-loss guard: the lazy memory-file bootstrap must fire ONLY when a
// successful Storage read came back genuinely empty for a user with real
// onboarding data. Reconciliation-masked turns and failed reads both present
// as "no memory context" but must never overwrite accumulated files with the
// onboarding skeleton — and the ?? [] defaults must not make the content guard
// vacuously true.
describe("runQaAgent lazy memory-file bootstrap guard", () => {
  const baseParams = {
    phone: "+15555550123",
    chatId: "chat-bootstrap",
    userId: "client-123",
    seniorId: "senior-123",
    userType: "client" as const,
    skipSend: true,
    text: "How is Mom doing?",
  };

  const realOnboardingData = {
    seniorName: "Margaret",
    age: "82",
    conditions: ["dementia"],
    careNeeds: ["meal prep"],
    city: "San Jose",
    firstName: "Anahi",
    relationship: "daughter",
  };

  beforeEach(() => {
    qaHarness.writes.length = 0;
    for (const key of Object.keys(qaHarness.sessionData)) delete qaHarness.sessionData[key];
    qaHarness.detectAndStageFactChange.mockReset().mockResolvedValue({ kind: "not_correction" });
    qaHarness.factChangeAckCopy.mockReset().mockReturnValue(null);
    qaHarness.findTombstonedRestatement.mockReset().mockResolvedValue(null);
    qaHarness.quickComplete.mockReset().mockResolvedValue("SUPPORTED");
    qaHarness.runAgentModelTurn.mockReset().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I can help with that." }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    qaHarness.getMemoryContext.mockReset().mockResolvedValue("");
    qaHarness.initializeMemoryFiles.mockReset().mockResolvedValue(undefined);
    qaHarness.getMemoryReconciliationState.mockReset().mockResolvedValue({
      pending: false, zepMasked: false, storageMasked: false,
    });
  });

  it("a reconciliation-masked turn (omitStorage) never bootstraps, even with empty memoryContext and real onboarding data", async () => {
    qaHarness.getMemoryReconciliationState.mockResolvedValue({
      pending: true, zepMasked: false, storageMasked: true,
    });

    await runQaAgent({ ...baseParams, session: { onboardingData: realOnboardingData } });

    // The masked fetch is omitted entirely AND the bootstrap must not fire.
    expect(qaHarness.getMemoryContext).not.toHaveBeenCalled();
    expect(qaHarness.initializeMemoryFiles).not.toHaveBeenCalled();
  });

  it("a failed memory read (transient error) never bootstraps — read failure is not 'no files yet'", async () => {
    qaHarness.getMemoryContext.mockRejectedValue(new Error("storage unavailable"));

    const reply = await runQaAgent({ ...baseParams, session: { onboardingData: realOnboardingData } });

    expect(reply).toBe("I can help with that."); // turn still completes (fail-soft)
    expect(qaHarness.getMemoryContext).toHaveBeenCalled();
    expect(qaHarness.initializeMemoryFiles).not.toHaveBeenCalled();
  });

  it("empty-array conditions/careNeeds with no seniorName does not bootstrap (the guard checks content, not truthiness)", async () => {
    await runQaAgent({ ...baseParams, session: { onboardingData: {} } });

    expect(qaHarness.getMemoryContext).toHaveBeenCalled();
    expect(qaHarness.initializeMemoryFiles).not.toHaveBeenCalled();
  });

  it("a genuinely-empty unmasked read with real onboarding data still bootstraps (feature preserved)", async () => {
    await runQaAgent({ ...baseParams, session: { onboardingData: realOnboardingData } });

    expect(qaHarness.initializeMemoryFiles).toHaveBeenCalledTimes(1);
    expect(qaHarness.initializeMemoryFiles).toHaveBeenCalledWith("client-123", expect.objectContaining({
      seniorName: "Margaret",
      conditions: ["dementia"],
      careNeeds:  ["meal prep"],
    }));
  });

  it("non-empty memory context never bootstraps", async () => {
    qaHarness.getMemoryContext.mockResolvedValue("## profile\nSenior: Margaret");

    await runQaAgent({ ...baseParams, session: { onboardingData: realOnboardingData } });

    expect(qaHarness.initializeMemoryFiles).not.toHaveBeenCalled();
  });
});

describe("applyZepContextResult", () => {
  const roles = ["client", "caregiver"] as const;

  function freshMetrics(userType: "client" | "caregiver"): TurnMetrics {
    return createTurnMetrics({ phone: "+15550001111", userType, pathway: "qa" });
  }

  function result(status: ZepContextResult["status"], context = ""): ZepContextResult {
    return { status, context, latencyMs: 123 };
  }

  it.each(roles)("loaded → returns the context and records status/latency (%s)", (role) => {
    const metrics = freshMetrics(role);
    const out = applyZepContextResult(result("loaded", "## CARE CONTEXT\nfacts"), metrics, role);
    expect(out).toBe("## CARE CONTEXT\nfacts");
    expect(metrics.zepContextStatus).toBe("loaded");
    expect(metrics.zepContextLatencyMs).toBe(123);
    expect(metrics.zepUnavailable).toBeUndefined();
    expect(metrics.zepContextEmpty).toBeUndefined();
  });

  it.each(roles)("empty → no marker, zepContextEmpty set, zepUnavailable NOT set (%s)", (role) => {
    const metrics = freshMetrics(role);
    const out = applyZepContextResult(result("empty"), metrics, role);
    expect(out).toBe("");
    expect(out).not.toContain("memory_unavailable");
    expect(metrics.zepContextStatus).toBe("empty");
    expect(metrics.zepContextEmpty).toBe(true);
    expect(metrics.zepUnavailable).toBeUndefined();
  });

  it.each(roles)("unavailable → injects the memory_unavailable marker (%s)", (role) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const metrics = freshMetrics(role);
      const out = applyZepContextResult(result("unavailable"), metrics, role);
      expect(out).toBe(ZEP_UNAVAILABLE_MARKER);
      expect(metrics.zepContextStatus).toBe("unavailable");
      expect(metrics.zepUnavailable).toBe(true);
      expect(metrics.zepContextEmpty).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each(roles)("timeout → injects the memory_unavailable marker (%s)", (role) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const metrics = freshMetrics(role);
      const out = applyZepContextResult(result("timeout"), metrics, role);
      expect(out).toBe(ZEP_UNAVAILABLE_MARKER);
      expect(metrics.zepContextStatus).toBe("timeout");
      expect(metrics.zepUnavailable).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("null (no zepThreadId) → empty string with NO status recorded — no memory was expected", () => {
    const metrics = freshMetrics("client");
    const out = applyZepContextResult(null, metrics, "client");
    expect(out).toBe("");
    expect(metrics.zepContextStatus).toBeUndefined();
    expect(metrics.zepContextLatencyMs).toBeUndefined();
    expect(metrics.zepUnavailable).toBeUndefined();
    expect(metrics.zepContextEmpty).toBeUndefined();
  });

  it("client and caregiver produce identical outputs and metric fields for every status", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const statuses: Array<ZepContextResult["status"]> = ["loaded", "empty", "unavailable", "timeout"];
      for (const status of statuses) {
        const clientMetrics = freshMetrics("client");
        const caregiverMetrics = freshMetrics("caregiver");
        const clientOut = applyZepContextResult(result(status, "ctx"), clientMetrics, "client");
        const caregiverOut = applyZepContextResult(result(status, "ctx"), caregiverMetrics, "caregiver");
        expect(caregiverOut).toBe(clientOut);
        expect({
          zepContextStatus:    caregiverMetrics.zepContextStatus,
          zepContextLatencyMs: caregiverMetrics.zepContextLatencyMs,
          zepUnavailable:      caregiverMetrics.zepUnavailable,
          zepContextEmpty:     caregiverMetrics.zepContextEmpty,
        }).toEqual({
          zepContextStatus:    clientMetrics.zepContextStatus,
          zepContextLatencyMs: clientMetrics.zepContextLatencyMs,
          zepUnavailable:      clientMetrics.zepUnavailable,
          zepContextEmpty:     clientMetrics.zepContextEmpty,
        });
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the marker wording is exactly the existing memory_unavailable instruction", () => {
    expect(ZEP_UNAVAILABLE_MARKER).toBe(
      "[SYSTEM: memory_unavailable] Long-term memory service is unavailable this turn. " +
      "Stored health facts (allergies, medications, conditions, doctor names) are NOT loaded. " +
      "If the user asks about any of these, say you don't have it available right now and ask them to confirm; " +
      "do not state any health fact you can't see in the cached context or learned facts above.",
    );
  });

  it("warn lines on unavailable/timeout carry role + status only — no IDs, no error detail", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const metrics = freshMetrics("client");
      const failure: ZepContextResult = { status: "unavailable", context: "", latencyMs: 5, errorClass: "TypeError" };
      applyZepContextResult(failure, metrics, "client");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0].map(String).join(" ");
      expect(line).toContain("unavailable");
      expect(line).toContain("client");
      expect(line).not.toMatch(/thread|[0-9]{7,}/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// U4a (KTD9/KTD10): reconciliation masking — the non-outage counterpart to the
// memory_unavailable path. While a correction/forget operation is unresolved,
// the still-unconfirmed stores are omitted and the distinct
// memory_reconciliation_pending instruction is injected WITHOUT recording an
// outage (zepUnavailable must never be set by this path).

describe("applyReconciliationMasking (U4a)", () => {
  function freshMetrics() {
    return createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
  }

  it("both stores unresolved → both omitted, instruction injected, NO outage recorded", () => {
    const metrics = freshMetrics();
    const out = applyReconciliationMasking(
      { pending: true, zepMasked: true, storageMasked: true }, metrics,
    );
    expect(out.omitZep).toBe(true);
    expect(out.omitStorage).toBe(true);
    expect(out.instruction).toBe(MEMORY_RECONCILIATION_PENDING_MARKER);
    expect(metrics.memoryReconciliationPending).toBe(true);
    // Not an outage: none of the outage signals fire.
    expect(metrics.zepUnavailable).toBeUndefined();
    expect(metrics.zepContextStatus).toBeUndefined();
  });

  it("per-store unmask: confirmed Storage returns while Zep stays omitted (and vice versa)", () => {
    const metrics = freshMetrics();
    const zepOnly = applyReconciliationMasking(
      { pending: true, zepMasked: true, storageMasked: false }, metrics,
    );
    expect(zepOnly).toMatchObject({ omitZep: true, omitStorage: false });
    expect(zepOnly.instruction).toBe(MEMORY_RECONCILIATION_PENDING_MARKER);

    const storageOnly = applyReconciliationMasking(
      { pending: true, zepMasked: false, storageMasked: true }, freshMetrics(),
    );
    expect(storageOnly).toMatchObject({ omitZep: false, omitStorage: true });
  });

  it("all-clear / null state → nothing omitted, no instruction, no metric", () => {
    for (const state of [null, undefined, { pending: false, zepMasked: false, storageMasked: false }] as const) {
      const metrics = freshMetrics();
      const out = applyReconciliationMasking(state as any, metrics);
      expect(out).toEqual({ omitZep: false, omitStorage: false, instruction: "" });
      expect(metrics.memoryReconciliationPending).toBeUndefined();
    }
  });

  it("the marker is DISTINCT from memory_unavailable and reads as an update, not an outage", () => {
    expect(MEMORY_RECONCILIATION_PENDING_MARKER).toContain("[SYSTEM: memory_reconciliation_pending]");
    expect(MEMORY_RECONCILIATION_PENDING_MARKER).not.toContain("memory_unavailable");
    expect(MEMORY_RECONCILIATION_PENDING_MARKER).toContain("NOT an outage");
    expect(MEMORY_RECONCILIATION_PENDING_MARKER).toContain("finishing an update to its stored memory");
    expect(MEMORY_RECONCILIATION_PENDING_MARKER).not.toBe(ZEP_UNAVAILABLE_MARKER);
  });
});

// U4a wiring proof (source-scan, same style as the U3 characterization tests):
// the client turn routes detection through the typed staged pipeline, masks the
// fetches per-store, and never sends the old boolean corrector.

describe("runQaAgent U4a wiring (source scan)", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src = fs.readFileSync(path.join(__dirname, "qaAgent.ts"), "utf8");

  it("uses the typed detectAndStageFactChange + deterministic ack copy — the boolean corrector is gone", () => {
    expect(src).toContain("detectAndStageFactChange({ userId, text, phone })");
    expect(src).toContain("factChangeAckCopy(factChange)");
    expect(src).not.toContain("detectAndApplyCorrection");
  });

  it("masks the Zep and Storage FETCHES per-store and injects the reconciliation instruction", () => {
    expect(src).toContain("zepThreadId && !reconciliationMask.omitZep ? getZepContextResult(zepThreadId)");
    expect(src).toContain('reconciliationMask.omitStorage ? Promise.resolve("") : getMemoryContext(userId)');
    expect(src).toContain("reconciliationMask.instruction");
  });

  it("wires the in-turn re-remember confirmation (question + one-shot resolution)", () => {
    expect(src).toContain("findTombstonedRestatement(userId, text)");
    expect(src).toContain("classifyReRememberReply(text)");
    expect(src).toContain("pendingReRememberFactId");
    expect(src).toContain("RE_REMEMBER_QUESTION_COPY");
  });

  // U4b: the CAREGIVER branch was the U4a-reported bypass — it fetched
  // getZepContextResult without reconciliation masking. It now applies the
  // SAME applyReconciliationMasking gating as the client branch: the Zep fetch
  // is skipped while the caregiver's Zep targets are unresolved, and the
  // non-outage reconciliation instruction is injected instead.
  it("caregiver branch gates its Zep fetch behind reconciliation masking (U4b)", () => {
    expect(src).toContain(
      "cgReconciliationMask = applyReconciliationMasking(await getMemoryReconciliationState(userId), metrics)",
    );
    expect(src).toContain(
      "zepThreadId && !cgReconciliationMask.omitZep ? getZepContextResult(zepThreadId)",
    );
    expect(src).toContain("cgReconciliationMask.instruction");
    // No unmasked caregiver Zep fetch remains anywhere in the file: every
    // getZepContextResult call site is gated by a reconciliation mask.
    const unguarded = src
      .split("\n")
      .filter((line) => line.includes("getZepContextResult(zepThreadId)"))
      .filter((line) => !line.includes("ReconciliationMask.omitZep") && !line.includes("reconciliationMask.omitZep"));
    expect(unguarded).toEqual([]);
  });
});

// U5 (R16/KTD11): topic-aware retrieval is WIRED (not rebuilt) and the prompt
// label is honest — the facts block is a relevance selection, never presented
// as a complete memory inventory.

describe("buildClientSystemPrompt — honest learned-facts label (U5/R16)", () => {
  const promptWithFacts = buildClientSystemPrompt(
    { name: "Anita", needs: ["companionship"] },
    [],
    null,
    null,
    "- Mom takes metformin (medical)",
  );

  it("labels the block 'Relevant learned facts' and never claims it is complete", () => {
    expect(promptWithFacts).toContain("Relevant learned facts");
    // The old label presented ten facts as a full inventory — that phrasing
    // (and any equivalent completeness claim) must be gone.
    expect(promptWithFacts).not.toContain("complete list");
    expect(promptWithFacts).not.toMatch(/\((?:the )?complete list|full list of facts|all known facts|these are all the facts/i);
    expect(promptWithFacts).toContain("other stored facts may exist");
  });

  it("keeps the anti-invention boundary despite dropping the completeness claim", () => {
    expect(promptWithFacts).toContain("never invent facts beyond your sources");
    // Knowledge boundary still points at the (renamed) facts block.
    expect(promptWithFacts).toContain("the learned facts above");
  });

  it("the no-facts fallback line is unchanged", () => {
    const empty = buildClientSystemPrompt({ name: "Anita", needs: [] }, [], null, null, undefined);
    expect(empty).toContain("No learned facts on file for this family yet.");
    expect(empty).not.toContain("Relevant learned facts");
  });
});

describe("runQaAgent U5 wiring (source scan) — current message reaches getRelevantFacts", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src = fs.readFileSync(path.join(__dirname, "qaAgent.ts"), "utf8");

  it("the prompt-assembly call site passes the current user message as the topic", () => {
    expect(src).toContain("getRelevantFacts(userId, text).catch(() => [])");
    // No topic-less prompt call remains anywhere in this module (the quick
    // path does not consume learned facts, so this is the only call site).
    const topicless = src
      .split("\n")
      .filter((line) => line.includes("getRelevantFacts(") && !line.includes("getRelevantFacts(userId, text)"));
    expect(topicless).toEqual([]);
  });

  it("unconfirmed identity still receives NO facts — the fetch itself is skipped", () => {
    const loadStart = src.indexOf("const [zepResult, memoryContext, facts");
    expect(loadStart).toBeGreaterThan(-1);
    const block = src.slice(loadStart, src.indexOf("]);", loadStart));
    // The whole parallel context load (including the facts slot) is gated on
    // the unconfirmedIdentity ternary — facts are hardcoded empty there.
    expect(block).toContain("unconfirmedIdentity");
    expect(block).toContain("[] as Array<{ fact: string; category: string }>");
    expect(block).toContain("getRelevantFacts(userId, text)");
  });
});


// ── Childcare U10 (plan 2026-07-22-002, R49-R51, KTD17) ───────────────────────
// The childcare-vertical branch: server-owned envelope before prompt/tool
// decisions, the childcare tool pack replacing the senior surface, memory
// subsystems never touched, fail-closed behavior in both tool directions, and
// byte-identical senior parity when the stamp is absent.
describe("runQaAgent childcare vertical branch (U10)", () => {
  const CHILD_SESSION = { careVertical: "child", verticalIntent: "child", userType: "client" };
  const baseParams = {
    phone: "+15555550123",
    chatId: "chat-childcare",
    userId: "client-123",
    seniorId: "",
    userType: "client" as const,
    skipSend: true,
  };

  const agentText = (text: string) => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const agentTool = (name: string, input: Record<string, unknown> = {}) => ({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_cc", name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  beforeEach(() => {
    qaHarness.writes.length = 0;
    for (const key of Object.keys(qaHarness.sessionData)) delete qaHarness.sessionData[key];
    qaHarness.runAgentModelTurn.mockReset();
    qaHarness.quickComplete.mockReset();
    qaHarness.quickComplete.mockResolvedValue("SUPPORTED");
    qaHarness.handleToolCall.mockReset();
    qaHarness.handleToolCall.mockResolvedValue({ success: true, bookings: [] });
    qaHarness.getChildcareFlags.mockReset();
    qaHarness.getChildcareFlags.mockResolvedValue({
      enabled: true, discoveryEnabled: true, writesEnabled: true, proactiveEnabled: false, emergencyOff: false,
    });
    qaHarness.buildChildcareEnvelope.mockClear();
    qaHarness.getMemoryContext.mockClear();
    qaHarness.initializeMemoryFiles.mockClear();
    qaHarness.getZepContextResult.mockClear();
    qaHarness.detectAndStageFactChange.mockReset();
    qaHarness.detectAndStageFactChange.mockResolvedValue({ kind: "not_correction" });
    qaHarness.factChangeAckCopy.mockReset();
    qaHarness.factChangeAckCopy.mockReturnValue(null);
    qaHarness.findTombstonedRestatement.mockReset();
    qaHarness.findTombstonedRestatement.mockResolvedValue(null);
  });

  it("resolves the envelope BEFORE the model runs and builds the childcare prompt (R49)", async () => {
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("Booking status coming up."));
    const reply = await runQaAgent({ ...baseParams, text: "status?", session: CHILD_SESSION });

    expect(reply).toBe("Booking status coming up.");
    expect(qaHarness.buildChildcareEnvelope).toHaveBeenCalledTimes(1);
    const call = qaHarness.runAgentModelTurn.mock.calls[0][0] as {
      system: Array<{ text: string }>;
      tools: Array<{ name: string }>;
    };
    const systemText = call.system.map((b) => b.text).join("\n");
    expect(systemText).toContain("childcare coordinator");
    expect(systemText).toContain("NEVER communicate with a child directly");
    expect(systemText).toContain("CURRENT CHILDCARE SITUATION");
    // No senior persona/context blocks on a childcare turn.
    expect(systemText.toLowerCase()).not.toContain("senior_profile");
    expect(systemText).not.toContain("get_senior_profile");
  });

  it("binds ONLY the childcare tool pack (R51 — vertical filtering replaces the senior surface)", async () => {
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("ok"));
    await runQaAgent({ ...baseParams, text: "hi", session: CHILD_SESSION });
    const call = qaHarness.runAgentModelTurn.mock.calls[0][0] as { tools: Array<{ name: string }> };
    const names = call.tools.map((t) => t.name);
    expect(names).toContain("get_childcare_bookings");
    expect(names).toContain("cancel_childcare_booking");
    expect(names).not.toContain("get_senior_profile");
    expect(names).not.toContain("request_booking");
  });

  it("stamps the server-owned vertical on childcare tool dispatch — forged values never survive (AE19)", async () => {
    qaHarness.runAgentModelTurn
      .mockResolvedValueOnce(agentTool("get_childcare_bookings", { careVertical: "senior", bookingId: "bk-1" }))
      .mockResolvedValueOnce(agentText("Found it."));
    await runQaAgent({ ...baseParams, text: "check my bookings", session: CHILD_SESSION });
    expect(qaHarness.handleToolCall).toHaveBeenCalledTimes(1);
    const [name, input] = qaHarness.handleToolCall.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("get_childcare_bookings");
    expect(input.careVertical).toBe("child"); // server-owned, overwrote the forged value
    expect(input.userId).toBe("client-123");
  });

  it("fails closed when the model calls a SENIOR tool on a childcare turn (R51)", async () => {
    qaHarness.runAgentModelTurn
      .mockResolvedValueOnce(agentTool("get_senior_profile", { seniorId: "s-1" }))
      .mockResolvedValueOnce(agentText("I can only help with childcare here."));
    await runQaAgent({ ...baseParams, text: "show the senior profile", session: CHILD_SESSION });
    expect(qaHarness.handleToolCall).not.toHaveBeenCalled(); // rejected before dispatch
  });

  it("writes child format uncertainty only to pseudonymous quality telemetry", async () => {
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("- First item\n- Second item"));
    qaHarness.quickComplete.mockResolvedValue("Here are the two items in one sentence.");
    await runQaAgent({
      ...baseParams,
      text: "What should I know?",
      session: CHILD_SESSION,
      sourceTurn: { conversationId: "c1", messageId: "m1" },
    });

    await vi.waitFor(() => {
      expect(
        qaHarness.writes.some((write) => write.collection === "childcare_quality_events"),
      ).toBe(true);
    });
    const quality = qaHarness.writes.find(
      (write) => write.collection === "childcare_quality_events",
    )?.data;
    expect(quality).toMatchObject({
      careVertical: "child",
      eventCode: "format_revision",
    });
    expect(quality).not.toHaveProperty("phone");
    expect(quality).not.toHaveProperty("userId");
    expect(quality).not.toHaveProperty("question");
    expect(quality).not.toHaveProperty("reply");
    expect(
      qaHarness.writes.some((write) => write.collection === "agent_uncertainty_log"),
    ).toBe(false);
  });

  it("strips a model-forged childcare stamp on a SENIOR turn (reverse direction fails closed at the handler)", async () => {
    qaHarness.runAgentModelTurn
      .mockResolvedValueOnce(agentTool("cancel_childcare_booking", { careVertical: "child", bookingId: "bk-1" }))
      .mockResolvedValueOnce(agentText("done"));
    await runQaAgent({ ...baseParams, seniorId: "senior-123", text: "cancel it", session: {} });
    expect(qaHarness.handleToolCall).toHaveBeenCalledTimes(1);
    const [, input] = qaHarness.handleToolCall.mock.calls[0] as [string, Record<string, unknown>];
    expect("careVertical" in input).toBe(false); // the handler vertical guard now denies
  });

  it("NEVER touches a memory subsystem on a childcare turn (R50/KTD17)", async () => {
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("ok"));
    await runQaAgent({ ...baseParams, text: "remember Mia is allergic to peanuts", session: { ...CHILD_SESSION, zepThreadId: "zep-1" } });
    expect(qaHarness.getZepContextResult).not.toHaveBeenCalled();
    expect(qaHarness.getMemoryContext).not.toHaveBeenCalled();
    expect(qaHarness.initializeMemoryFiles).not.toHaveBeenCalled();
    expect(qaHarness.detectAndStageFactChange).not.toHaveBeenCalled();
    expect(qaHarness.findTombstonedRestatement).not.toHaveBeenCalled();
  });

  it("emergency-off fails closed to the deterministic safe responder — no model, no tools (R61)", async () => {
    qaHarness.getChildcareFlags.mockResolvedValue({
      enabled: false, discoveryEnabled: false, writesEnabled: false, proactiveEnabled: false, emergencyOff: true,
    });
    const reply = await runQaAgent({ ...baseParams, text: "hi", session: CHILD_SESSION });
    expect(reply).toContain("paused");
    expect(reply).toContain("support@eviacares.com");
    expect(qaHarness.runAgentModelTurn).not.toHaveBeenCalled();
    expect(qaHarness.buildChildcareEnvelope).not.toHaveBeenCalled();
  });

  it("fails closed when the envelope cannot be resolved — never the senior prompt (R49)", async () => {
    qaHarness.buildChildcareEnvelope.mockResolvedValue(null);
    const reply = await runQaAgent({ ...baseParams, text: "hi", session: CHILD_SESSION });
    expect(reply).toContain("securely load");
    expect(qaHarness.runAgentModelTurn).not.toHaveBeenCalled();
  });

  it("SENIOR PARITY: a session without the childcare stamp never touches any childcare seam", async () => {
    qaHarness.runAgentModelTurn.mockResolvedValue(agentText("I can help with that."));
    const reply = await runQaAgent({ ...baseParams, seniorId: "senior-123", text: "How is Mom doing?", session: {} });
    expect(reply).toBe("I can help with that.");
    expect(qaHarness.buildChildcareEnvelope).not.toHaveBeenCalled();
    expect(qaHarness.getChildcareFlags).not.toHaveBeenCalled();
    const call = qaHarness.runAgentModelTurn.mock.calls[0][0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((b) => b.text).join("\n");
    expect(systemText).not.toContain("CHILDCARE");
    expect(systemText).not.toContain("childcare coordinator");
    // Senior memory fetches still run exactly as before.
    expect(qaHarness.getMemoryContext).toHaveBeenCalled();
    expect(qaHarness.detectAndStageFactChange).toHaveBeenCalled();
  });
});
