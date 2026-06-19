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
vi.mock("../mcp/server",           () => ({ MCP_TOOLS: [], CAREGIVER_TOOLS: [], handleToolCall: vi.fn(), handleToolCallForCaregiver: vi.fn() }));
vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
vi.mock("../memory/memoryFiles",   () => ({ getMemoryContext: vi.fn() }));
vi.mock("../memory/learnedFacts",  () => ({ getRelevantFacts: vi.fn(), detectAndApplyCorrection: vi.fn() }));
vi.mock("../memory/preferences",   () => ({ getPreferences: vi.fn(), isInDND: () => false }));
vi.mock("../linq/client",          () => ({ sendMessage: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn() }));
vi.mock("./executionAgent",        () => ({ getActiveAgentForUser: vi.fn() }));
vi.mock("./contextManagement",     () => ({ maybeRollUpHistory: vi.fn(), buildToolResultContent: vi.fn() }));

import {
  hasListShape,
  detectConfidenceClaim,
  detectPromiseWithoutToolCall,
  detectGenericHelpAsk,
  detectMedicationInstruction,
  detectMultiQuestionDataCollection,
  detectSupportDeflection,
  WARMTH_REFLECTION_OPENERS,
} from "./qaAgent";

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
    "The Cara team will follow up.",
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
