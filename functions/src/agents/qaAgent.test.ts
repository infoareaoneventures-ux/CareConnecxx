import { describe, it, expect, vi } from "vitest";

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
    firestore: () => ({ collection: () => ({}) }),
  },
  apps: [],
  initializeApp: () => ({}),
  firestore: () => ({ collection: () => ({}) }),
}));
vi.mock("../utils/claudeClient",   () => ({ getSharedClient: () => ({}) }));
vi.mock("../utils/openaiClient",   () => ({ quickComplete: vi.fn(), getOpenAIClient: () => ({}) }));
vi.mock("../utils/claudeRetry",    () => ({ callClaudeWithRetry: vi.fn() }));
vi.mock("../safety/supervisor",    () => ({ supervise: (msg: string) => Promise.resolve(msg) }));
vi.mock("../safety/linter",        () => ({ lintMessage: (msg: string) => msg }));
vi.mock("../mcp/server",           () => ({ MCP_TOOLS: [], CAREGIVER_TOOLS: [], CLIENT_TOOLS: [], handleToolCall: vi.fn(), handleToolCallForCaregiver: vi.fn() }));
vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), getZepContextResult: vi.fn(), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
vi.mock("../memory/memoryFiles",   () => ({ getMemoryContext: vi.fn() }));
vi.mock("../memory/learnedFacts",  () => ({
  getRelevantFacts: vi.fn(),
  detectAndStageFactChange: vi.fn(async () => ({ kind: "not_correction" })),
  factChangeAckCopy: vi.fn(() => null),
  findTombstonedRestatement: vi.fn(async () => null),
  classifyReRememberReply: vi.fn(async () => "other"),
  confirmReRemember: vi.fn(async () => ({ ok: false, reason: "not_found" })),
  RE_REMEMBER_QUESTION_COPY: "re-remember-question",
  RE_REMEMBER_CONFIRMED_COPY: "re-remember-confirmed",
  RE_REMEMBER_BLOCKED_COPY: "re-remember-blocked",
  FACT_CHANGE_NO_MATCH_COPY: "no-match",
}));
vi.mock("../memory/preferences",   () => ({ getPreferences: vi.fn(), isInDND: () => false }));
vi.mock("../linq/client",          () => ({ sendMessage: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn() }));
vi.mock("./executionAgent",        () => ({ getActiveAgentForUser: vi.fn() }));
vi.mock("./contextManagement",     () => ({ maybeRollUpHistory: vi.fn(), buildToolResultContent: vi.fn(), HISTORY_WINDOW: 24, HISTORY_OVERFETCH_LIMIT: 60, composeHistoryWindow: (rows: unknown[]) => rows }));

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
    expect(out).toContain("ACCOUNT STATUS: account active, verification approved, background check clear, onboarding profile_complete.");
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
    expect(out).toContain("ACCOUNT STATUS: account paused.");
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
    expect(out).toEqual({ reply: fallback(), triggered: true, swapped: true });
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("keeps a SUPPORTED reply unchanged", async () => {
    const checker = vi.fn().mockResolvedValue("SUPPORTED");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Ana is coming Friday at 10.", checker });
    expect(out).toEqual({ reply: "Ana is coming Friday at 10.", triggered: true, swapped: false });
  });

  it("fails CLOSED when the checker throws — deterministic fallback goes out, not the model reply (U4)", async () => {
    const checker = vi.fn().mockRejectedValue(new Error("checker down"));
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toEqual({ reply: fallback(), triggered: true, swapped: true });
  });

  it("fails CLOSED on a garbage/unparseable verdict — deterministic fallback goes out (U4)", async () => {
    const checker = vi.fn().mockResolvedValue("hmm, hard to say really");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toEqual({ reply: fallback(), triggered: true, swapped: true });
  });

  it("fails CLOSED on an empty verdict — deterministic fallback goes out (U4)", async () => {
    const checker = vi.fn().mockResolvedValue("");
    const out = await gateQuickReplyGrounding({ ...base, reply: "Maria is coming Thursday at 3.", checker });
    expect(out).toEqual({ reply: fallback(), triggered: true, swapped: true });
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
    expect(out).toEqual({ reply: "Hey! How's everything going?", triggered: false, swapped: false });
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
});

// U1: typed Zep context → prompt/metrics mapping. One shared function serves
// both the client and caregiver branches, so parity is structural — these
// tests pin the semantics per status and prove the two roles cannot diverge.
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
