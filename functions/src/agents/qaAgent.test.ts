import { beforeEach, describe, it, expect, vi } from "vitest";
import { TRIVIAL_YES, TRIVIAL_NO } from "./approvalHandler";

const qaHarness = vi.hoisted(() => {
  const writes: Array<{ collection: string; id?: string; data: Record<string, unknown> }> = [];
  const sessionData: Record<string, unknown> = {};
  // Mutable box (not a plain `let`) so buildClientCoreContext tests can seed a
  // carePlans doc per-test without needing a new shared mock — additive only,
  // every other test leaves this null and sees the same exists:false as before.
  const carePlansState: { doc: Record<string, unknown> | null } = { doc: null };
  // Same idea, for the users/{uid} doc buildClientCoreContext's ACCOUNT
  // STATUS section reads — additive only, every other test leaves this null.
  const usersState: { doc: Record<string, unknown> | null } = { doc: null };
  // Same idea, generalized: seed a collection's query-result docs by name
  // (e.g. "booking_requests", "shifts") for the CARE TEAM roster tests —
  // additive only, every other test leaves this empty and sees the same
  // empty:true/docs:[] as before.
  const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};

  const makeChain = (collection = "", id?: string): any => ({
    collection: (name: string) => makeChain(name),
    doc: (docId?: string) => makeChain(collection, docId),
    where: () => makeChain(collection, id),
    orderBy: () => makeChain(collection, id),
    limit: () => makeChain(collection, id),
    get: async () => {
      const seeded = collectionDocs[collection];
      if (seeded) return { empty: seeded.length === 0, docs: seeded.map((d) => ({ id: d.id, data: () => d.data })) };
      return {
        exists: (collection === "agent_sessions" && Boolean(id)) || (collection === "carePlans" && carePlansState.doc !== null) || (collection === "users" && usersState.doc !== null),
        data: () => collection === "agent_sessions" ? sessionData : (collection === "carePlans" ? carePlansState.doc : (collection === "users" ? usersState.doc : {})),
        empty: true,
        docs: [],
        ref: makeChain(collection, id),
      };
    },
    set: async (data: Record<string, unknown>) => { writes.push({ collection, id, data }); },
    update: async (data: Record<string, unknown>) => { writes.push({ collection, id, data }); },
    add: async (data: Record<string, unknown>) => { writes.push({ collection, data }); return { id: "mock-id" }; },
    delete: async () => {},
  });
  const firestore: any = () => firestore;
  firestore.collection = (name: string) => makeChain(name);
  firestore.batch = () => ({ set: () => {}, update: () => {}, commit: async () => {} });
  firestore.FieldValue = { delete: () => "__delete__", serverTimestamp: () => "__timestamp__" };

  return {
    firestore,
    writes,
    sessionData,
    carePlansState,
    usersState,
    collectionDocs,
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
vi.mock("../mcp/server",           () => ({ MCP_TOOLS: [], CAREGIVER_TOOLS: [], CLIENT_TOOLS: [], handleToolCall: vi.fn(), handleToolCallForCaregiver: vi.fn() }));
vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), getZepContextResult: vi.fn(async () => null), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
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
  buildClientCoreContext,
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

  // 2026-08-31 fix: real production example — "What is the care address" and
  // "I think you do" (a pushback follow-up) both slipped through every
  // keyword check above and got a confidently wrong answer from the tool-less
  // fast path. Topic-keyword lists can never be complete, so this catches the
  // SHAPE of a real question or a factual pushback instead of its subject.
  it.each([
    "What is the care address",
    "I think you do",
    "Who is my caregiver",
    "Is my caregiver active",
    "Are you sure",
    "Do you have my address",
    "What's my membership status",
  ])("routes real questions/pushback through the full agent regardless of topic %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(false);
  });

  it.each([
    "How's it going",
    "How are you",
    "How is everything",
  ])("still allows rhetorical greeting-questions on the fast path %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(true);
  });

  // 2026-09-09 live incident: a bare "Yes." confirming a pending cancel_interview
  // action slipped past every check above (no digit, no "?", no action verb, no
  // listed topic word) and got routed to the toolless quick-reply fast path,
  // which fabricated "Done, I canceled that" without ever calling the tool.
  // These are exactly the words approvalHandler.ts's classifyApproval treats as
  // a real YES/NO decision — none of them may ever look trivial here, or a real
  // confirmation reply can be swallowed before the agent (or the pending-action
  // gate) ever sees it.
  it.each([
    "Yes.", "Yes", "yes", "Y", "Yeah", "Yep", "Yup",
    "Ok", "Okay", "Sure", "Confirm", "Confirmed", "Go ahead", "Do it", "Go", "Proceed", "Approved",
    "No.", "No", "no", "N", "Nope", "Nah", "Stop", "Wait", "Cancel",
    "Don't", "Dont", "Never mind", "Nevermind", "Actually no", "Forget it",
  ])("never treats a bare confirm/deny reply as trivial %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(false);
  });

  // Locks the two lists together: if someone later adds a new word to
  // approvalHandler's TRIVIAL_YES/TRIVIAL_NO without this test, they won't
  // find out it can still be swallowed by the quick-reply fast path until
  // the next live incident. Property check > hand-typed duplicate list.
  it("every TRIVIAL_YES/TRIVIAL_NO word is excluded, not just the ones listed above", () => {
    for (const word of [...TRIVIAL_YES, ...TRIVIAL_NO]) {
      const asTyped = word.charAt(0) + word.slice(1).toLowerCase();
      expect(isTrivialQuickReply(asTyped)).toBe(false);
    }
  });

  // 2026-09-13 live incident: "yes we did" answered a proactive nudge ("did
  // the interview happen? I can mark it complete") but isn't a BARE yes/no,
  // so it slipped past the check above, landed on the no-tools quick-reply
  // path, and fabricated "Perfect, I've marked Basra's interview complete"
  // without ever calling complete_interview.
  it.each([
    "yes we did", "Yes we did", "yeah it happened", "yep, went great",
    "no we didn't", "nope, had to reschedule", "yes it went well",
  ])("never treats a yes/no-PREFIXED reply as trivial either %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(false);
  });

  // 2026-09-14 live incident: a bare, all-lowercase name answering "Which
  // caregiver is this booking for?" passed every check above (the
  // proper-noun check only catches a capitalized word) and landed on the
  // no-tool fast path, which fabricated an entire fictitious booking
  // conversation with nothing real behind it.
  it.each([
    "basra yousuf", "Basra Yousuf", "maria santos", "samira",
  ])("never treats a bare name reply as trivial, capitalized or not %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(false);
  });

  // Genuine multi-word small talk must still take the fast path — each of
  // these matches one of the explicit allowlist patterns byte-for-byte in
  // shape (greeting, gratitude, acknowledgment, farewell, or a rhetorical
  // greeting-question), not just "contains a familiar word somewhere."
  it.each([
    "How's it going", "thanks so much", "sounds good", "ok great",
    "sounds great", "you too take care", "see you soon",
  ])("still allows genuine multi-word small talk on the fast path %p", (input) => {
    expect(isTrivialQuickReply(input)).toBe(true);
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

// 2026-08-24 fix: this used to read a completely different, disconnected
// collection (care_plans, snake_case) than the website's real carePlans
// (camelCase, components/CarePlan.tsx), and treated careNeeds/notes as flat
// top-level fields instead of nested per-recipient under recipientPlans.{key}
// — so the auto-injected "CARE PLAN (full, on file)" context Evia gets every
// turn never actually reflected anything a real client had on file.
describe("buildClientCoreContext", () => {
  beforeEach(() => {
    qaHarness.carePlansState.doc = null;
    qaHarness.usersState.doc = null;
    for (const k of Object.keys(qaHarness.collectionDocs)) delete qaHarness.collectionDocs[k];
  });

  // 2026-08-31 fix (Membership page audit): this line used to read
  // users/{uid}.subscriptionStatus — a field the real subscription lifecycle
  // (customer.subscription.updated webhook) never writes at all, only
  // membershipStatus. So the "subscription X" line silently never appeared
  // for any genuinely subscribed client; if it appeared at all it could only
  // be a leftover from the two now-fixed cancel/reactivate MCP tools writing
  // a nonstandard value like "canceling" that nothing else recognizes.
  it("surfaces the real membershipStatus field, not the dead subscriptionStatus one", async () => {
    qaHarness.usersState.doc = { verified: true, membershipStatus: "active" };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("ACCOUNT STATUS");
    expect(out).toContain("subscription active");
  });

  it("omits the subscription line entirely when membershipStatus is absent, rather than reading a stale field", async () => {
    qaHarness.usersState.doc = { verified: true, subscriptionStatus: "canceling" };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).not.toContain("subscription canceling");
  });

  it("flags when there's no recovery email on file, so Evia knows before offering a phone/email change", async () => {
    qaHarness.usersState.doc = { verified: true };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("recovery email NOT on file");
  });

  it("confirms the recovery email is on file once one is set", async () => {
    qaHarness.usersState.doc = { verified: true, email: "family@example.com" };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("recovery email on file");
  });

  it("reads the real carePlans collection (not care_plans) and surfaces nested per-recipient careNeeds/notes", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: {
        mary_smith: { name: "Mary Smith", careNeeds: ["Mobility Assistance", "Medication Reminders"], notes: "Prefers tea in the morning" },
      },
    };
    const out = await buildClientCoreContext("client-1", { name: "Mary Smith" }, {});
    expect(out).toContain("CARE PLAN (full, on file)");
    expect(out).toContain("Mary Smith");
    expect(out).toContain("careNeeds: Mobility Assistance; Medication Reminders");
    expect(out).toContain("notes: Prefers tea in the morning");
  });

  it("lists every recipient's plan when a household has more than one", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: {
        mary_smith: { name: "Mary Smith", careNeeds: ["Mobility Assistance"] },
        john_smith: { name: "John Smith", notes: "Uses a walker" },
      },
    };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("Mary Smith");
    expect(out).toContain("careNeeds: Mobility Assistance");
    expect(out).toContain("John Smith");
    expect(out).toContain("notes: Uses a walker");
  });

  it("omits the care plan section entirely when no carePlans doc exists", async () => {
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).not.toContain("CARE PLAN");
  });

  it("falls back to a name derived from the recipientPlans key when the entry has no name field", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: { jane_doe: { careNeeds: ["Personal Care"] } },
    };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("jane doe");
    expect(out).toContain("careNeeds: Personal Care");
  });

  // 2026-08-31 fix: this block used to hardcode only ["careNeeds","notes"],
  // silently omitting locations/lifestyle even though they live on the same
  // recipientPlans doc — a family asked about their mom's favorite activity
  // and home address, and Evia said "I don't have that" because this
  // mislabeled "(full, on file)" context told it there was nothing else.
  it("includes the home address from recipientPlans.locations", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: {
        mary_smith: { name: "Mary Smith", locations: [{ street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130" }] },
      },
    };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("address: 4746 Campbell Ave, San Jose, CA 95130");
  });

  it("includes lifestyle preferences generically, whatever keys are actually present", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: {
        mary_smith: { name: "Mary Smith", lifestyle: { favoriteActivities: ["walks", "gardening"], prefersQuiet: true, familyInArea: false, appointmentsDetails: "" } },
      },
    };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("lifestyle:");
    expect(out).toContain("favoriteActivities: walks, gardening");
    expect(out).toContain("prefersQuiet");
    // false/empty-string values must not appear as noise
    expect(out).not.toContain("familyInArea");
    expect(out).not.toContain("appointmentsDetails");
  });

  it("omits address/lifestyle lines when neither is present, without breaking careNeeds/notes", async () => {
    qaHarness.carePlansState.doc = {
      recipientPlans: { mary_smith: { name: "Mary Smith", careNeeds: ["Mobility Assistance"] } },
    };
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("careNeeds: Mobility Assistance");
    expect(out).not.toContain("address:");
    expect(out).not.toContain("lifestyle:");
  });
});

// 2026-08-31 fix: the CARE TEAM roster this context injects on every turn was
// built ONLY from the legacy `appointments` collection — a caregiver booked
// entirely through the newer booking_requests/shifts pipeline (get_care_team,
// the real tool, already checks both) was invisible here, so a family asking
// "who's my caregiver" got an empty/wrong ambient roster and Evia guessed
// instead of calling the tool (real example: it answered with the FAMILY
// MEMBER's own name as the "caregiver").
describe("buildClientCoreContext — CARE TEAM roster", () => {
  beforeEach(() => {
    for (const k of Object.keys(qaHarness.collectionDocs)) delete qaHarness.collectionDocs[k];
  });

  it("includes a caregiver known only through booking_requests/shifts (new pipeline)", async () => {
    qaHarness.collectionDocs["booking_requests"] = [
      { id: "br1", data: { clientId: "client-1", caregiverName: "Basra Yousuf", status: "accepted" } },
    ];
    qaHarness.collectionDocs["shifts"] = [
      { id: "s1", data: { clientId: "client-1", bookingRequestId: "br1", status: "scheduled", date: "2999-01-01" } },
    ];
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("CARE TEAM");
    expect(out).toContain("Basra Yousuf (next 2999-01-01)");
  });

  it("still includes a legacy appointments-only caregiver (no regression)", async () => {
    qaHarness.collectionDocs["appointments"] = [
      { id: "a1", data: { clientId: "client-1", caregiverName: "Alice", status: "confirmed", date: "2999-01-01" } },
    ];
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("CARE TEAM: Alice (next 2999-01-01).");
  });

  it("merges both pipelines without duplicating a caregiver present in both", async () => {
    qaHarness.collectionDocs["appointments"] = [
      { id: "a1", data: { clientId: "client-1", caregiverName: "Basra Yousuf", status: "completed", date: "2026-01-01" } },
    ];
    qaHarness.collectionDocs["booking_requests"] = [
      { id: "br1", data: { clientId: "client-1", caregiverName: "Basra Yousuf", status: "accepted" } },
    ];
    qaHarness.collectionDocs["shifts"] = [
      { id: "s1", data: { clientId: "client-1", bookingRequestId: "br1", status: "scheduled", date: "2999-01-01" } },
    ];
    const out = await buildClientCoreContext("client-1", null, {});
    const occurrences = (out.match(/Basra Yousuf/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).toContain("Basra Yousuf (next 2999-01-01)");
  });
});

// 2026-09-06 fix: this context had NO interview section at all — a family
// asking "do I have an interview" got zero ambient grounding, so if Evia
// answered without calling list_interviews this turn, the claim had nothing
// behind it and correctly tripped the human-handoff safety net instead of
// ever giving a real answer (real example: two "I'm looping in a teammate"
// handoffs in a row for a genuine, existing, same-day interview). Same bug
// class as the CARE TEAM roster gap above, just never caught for interviews.
describe("buildClientCoreContext — INTERVIEWS", () => {
  beforeEach(() => {
    for (const k of Object.keys(qaHarness.collectionDocs)) delete qaHarness.collectionDocs[k];
  });

  it("includes a requested/accepted interview", async () => {
    qaHarness.collectionDocs["video_interviews"] = [
      { id: "iv1", data: { clientId: "client-1", caregiverName: "Basra Yousuf", scheduledTime: "2999-01-01T10:00:00.000Z", status: "accepted" } },
    ];
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).toContain("INTERVIEWS");
    expect(out).toContain("Basra Yousuf on 2999-01-01T10:00:00.000Z (accepted)");
  });

  it("omits the section entirely when there are no open interviews", async () => {
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out).not.toContain("INTERVIEWS");
  });

  it("sorts multiple interviews by scheduledTime", async () => {
    qaHarness.collectionDocs["video_interviews"] = [
      { id: "iv1", data: { clientId: "client-1", caregiverName: "Later Cg", scheduledTime: "2999-02-01T10:00:00.000Z", status: "requested" } },
      { id: "iv2", data: { clientId: "client-1", caregiverName: "Sooner Cg", scheduledTime: "2999-01-01T10:00:00.000Z", status: "accepted" } },
    ];
    const out = await buildClientCoreContext("client-1", null, {});
    expect(out.indexOf("Sooner Cg")).toBeLessThan(out.indexOf("Later Cg"));
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

  // 2026-09-09 (live-caught): this call site runs independently of
  // routeIntent.ts's own FACT_CORRECTION-intent guard — a bare/combined
  // date-time answer misfired here even after that guard was fixed, since
  // classifyIntentDetailed is never consulted before this check runs.
  it("skips detectAndStageFactChange entirely for a bare date/time answer (2026-09-09)", async () => {
    const reply = await runQaAgent({ ...baseParams, text: "9/12/26 at 11 AM" });

    expect(reply).toBe(normalReply);
    expect(qaHarness.detectAndStageFactChange).not.toHaveBeenCalled();
    expect(qaHarness.runAgentModelTurn).toHaveBeenCalledTimes(1);
  });

  // 2026-09-15 (live-caught, twice): "skip the shift for tomorrow. no need for
  // replacement" and "move it to 9/17 at 10am to 3pm" were both swallowed by
  // this detector (no_match / completed) instead of reaching the agent that
  // acts on live bookings. Two guards, tested separately.
  it("skips detectAndStageFactChange entirely when the intent classifier already judged the turn a booking ACTION (2026-09-15)", async () => {
    const reply = await runQaAgent({ ...baseParams, text: "move it to 9/17 at 10am to 3pm", intent: "RESCHEDULE_REQUEST" });

    expect(reply).toBe(normalReply);
    expect(qaHarness.detectAndStageFactChange).not.toHaveBeenCalled();
    expect(qaHarness.runAgentModelTurn).toHaveBeenCalledTimes(1);
  });

  it("a no_match verdict WITHOUT a FACT_CORRECTION intent falls through to the agent instead of the no-match copy (2026-09-15)", async () => {
    qaHarness.detectAndStageFactChange.mockResolvedValue({ kind: "no_match" });
    (qaHarness.factChangeAckCopy as any).mockReturnValue("no-match");

    const reply = await runQaAgent({ ...baseParams, text: "skip the shift for tomorrow. no need for replacement", intent: "QUESTION" });

    expect(reply).toBe(normalReply);
    expect(qaHarness.runAgentModelTurn).toHaveBeenCalledTimes(1);
  });

  it("a no_match verdict WITH the classifier's FACT_CORRECTION intent still returns the deterministic no-match copy", async () => {
    qaHarness.detectAndStageFactChange.mockResolvedValue({ kind: "no_match" });
    (qaHarness.factChangeAckCopy as any).mockReturnValue("no-match");

    const reply = await runQaAgent({ ...baseParams, text: "actually her doctor is Dr. Chen", intent: "FACT_CORRECTION" });

    expect(reply).toBe("no-match");
    expect(qaHarness.runAgentModelTurn).not.toHaveBeenCalled();
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

  // 2026-09-17 (live-caught): start_visit_request_flow already texted the
  // family and the model still appended "I've started that add-a-shift
  // request…". Every self-sending flow start must be in the suppression set.
  it("suppresses the model's trailing reply after EVERY self-sending flow start, not just booking/interview", () => {
    for (const tool of ["start_booking_flow", "start_interview_flow", "start_replacement_flow", "start_reschedule_flow", "start_resend_booking_flow", "start_visit_request_flow", "start_cancel_flow"]) {
      expect(src).toContain('"' + tool + '"');
    }
    expect(src).toContain("SELF_SENDING_FLOW_STARTS.has(block.name)");
    // …and the grounding/handoff gate never grades the discarded draft.
    expect(src).toContain("if (reply.trim() && !selfSendingFlowStartedThisTurn && shouldHandOffToHuman({");
  });

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
