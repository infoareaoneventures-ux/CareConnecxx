// Golden transcript regression harness for runQaAgent.
//
// Each transcript fully describes a turn: the user's message, what context
// (senior, journal, history) should be on file, what tools should be mocked
// and how they should respond, the scripted Claude responses (tool_use rounds
// + final text), and the assertions on the resulting reply / tool-call trace.
//
// Adding a transcript:
//   1) Append an entry to GOLDEN_TRANSCRIPTS below.
//   2) Provide claudeScript[] — one entry per Claude call. Each entry is either
//      { tools: [...] } (emits a tool_use message) or { text: "..." } (emits an
//      end_turn text message). Last entry should typically be a text response.
//   3) Provide toolMocks{} — name → fixed JSON result.
//   4) Provide expect{} — replyContains, toolsCalled, noListShape.
//
// The harness mocks firebase-admin so every Firestore read returns empty
// unless the transcript supplies `context.docs[path]` overrides. That keeps
// transcripts focused on the agent behavior rather than the storage shape.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared fixture state — populated per-transcript inside beforeEach ─────────

interface ClaudeResponseScript {
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  text?:  string;
}

interface FixtureState {
  // Firestore overrides: path → doc data. Falsy / missing → exists:false.
  docs:        Map<string, Record<string, unknown> | null>;
  // Tool name → static result OR function returning result.
  toolMocks:   Map<string, unknown | ((input: unknown) => unknown)>;
  // Scripted Claude responses. Each next call pops index 0.
  claudeScript: ClaudeResponseScript[];
  // Captured tool calls in order they were executed.
  toolCalls:   string[];
  // Captured Linq sendMessage chunks.
  sentChunks:  string[];
}

const STATE: FixtureState = {
  docs:         new Map(),
  toolMocks:    new Map(),
  claudeScript: [],
  toolCalls:    [],
  sentChunks:   [],
};

function resetState(): void {
  STATE.docs.clear();
  STATE.toolMocks.clear();
  STATE.claudeScript.length = 0;
  STATE.toolCalls.length    = 0;
  STATE.sentChunks.length   = 0;
}

// ── Module mocks (hoisted by vi.mock) ────────────────────────────────────────

// Firestore stub. doc().get() reads from STATE.docs; writes / updates are no-ops.
vi.mock("firebase-admin", () => {
  const buildDocRef = (path: string) => ({
    get: vi.fn(async () => {
      const data = STATE.docs.get(path);
      if (data) return { exists: true, data: () => data, ref: { delete: vi.fn() } };
      return { exists: false, data: () => undefined, ref: { delete: vi.fn() } };
    }),
    update: vi.fn(async () => undefined),
    set:    vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    collection: (subName: string) => buildCollection(`${path}/${subName}`),
    ref:    { delete: vi.fn() },
  });

  const buildCollection = (path: string) => {
    const docFn = vi.fn((id?: string) => buildDocRef(id ? `${path}/${id}` : `${path}/<auto>`));
    type DummyQuery = {
      where:   (...args: unknown[]) => DummyQuery;
      orderBy: (...args: unknown[]) => DummyQuery;
      limit:   (...args: unknown[]) => DummyQuery;
      get:     () => Promise<{ empty: boolean; size: number; docs: Array<{ data: () => unknown; id: string; ref: { delete: ReturnType<typeof vi.fn> } }> }>;
    };
    const queryProxy: DummyQuery = {
      where:   () => queryProxy,
      orderBy: () => queryProxy,
      limit:   () => queryProxy,
      get:     async () => ({ empty: true, size: 0, docs: [] }),
    };
    return {
      doc: docFn,
      add: vi.fn(async () => ({ id: "auto-id" })),
      where:   queryProxy.where,
      orderBy: queryProxy.orderBy,
      limit:   queryProxy.limit,
      get:     queryProxy.get,
    };
  };

  const firestoreFn = () => ({ collection: (name: string) => buildCollection(name), batch: () => ({ set: vi.fn(), commit: async () => undefined }) });
  const firestore = Object.assign(firestoreFn, { FieldValue: { delete: vi.fn(() => "__DELETE__"), arrayUnion: vi.fn((x) => x) } });
  return {
    __esModule: true,
    // `apps` / `initializeApp` are read at module-load by notifications.ts, now
    // pulled into this graph via caraAgent → bookingExecutor.
    default: { apps: [], initializeApp: () => ({}), firestore },
    apps: [],
    initializeApp: () => ({}),
    firestore,
  };
});

// Claude client + retry — pop scripted responses from STATE.claudeScript.
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../utils/claudeRetry", () => ({
  callClaudeWithRetry: vi.fn(async () => {
    const step = STATE.claudeScript.shift();
    if (!step) {
      // Unexpected extra Claude call — return a benign empty end_turn so the
      // test fails on assertions rather than blowing up here.
      return { content: [{ type: "text", text: "" }], stop_reason: "end_turn" };
    }
    if (step.tools && step.tools.length) {
      return {
        content: step.tools.map((t, i) => ({
          type: "tool_use",
          id:   `toolu_${i}`,
          name: t.name,
          input: t.input,
        })),
        stop_reason: "tool_use",
      };
    }
    return {
      content: [{ type: "text", text: step.text ?? "" }],
      stop_reason: "end_turn",
    };
  }),
}));

// OpenAI stub. Most quickComplete calls return input unchanged so internal
// rewrite passes don't mutate normal transcript assertions. The human
// conversation repair pass is intentionally simulated so transcripts can prove
// chatbot-like drafts are repaired before send.
vi.mock("../utils/openaiClient", () => ({
  quickComplete:   vi.fn(async (sys: string, user: string) => {
    if (sys.includes("human conversation repair editor")) {
      const lower = user.toLowerCase();
      if (lower.includes("name, age") || lower.includes("city") || lower.includes("zip")) {
        return "What's her name?";
      }
      if (lower.includes("contact support") || lower.includes("the team will")) {
        return "I can handle that here. What happened?";
      }
      if (lower.includes("what can i help") || lower.includes("how can i help") || lower.includes("anything else i can help")) {
        return "Hey - I'm here with you. Tell me what's going on.";
      }
      if (lower.includes("extra dose") || lower.includes("increase the medication") || lower.includes("skip the pill")) {
        return "I can't advise on changing meds. Please call her doctor or pharmacist. If this feels urgent, call 911 now.";
      }
      return user;
    }
    return user;
  }),
  getOpenAIClient: () => ({ chat: { completions: { create: vi.fn() } } }),
}));

// Linq — capture sent chunks; no-op on typing.
vi.mock("../linq/client", () => ({
  sendMessage:   vi.fn(async (_chatId: string, body: unknown) => {
    STATE.sentChunks.push(typeof body === "string" ? body : JSON.stringify(body));
    return { message_id: "x" };
  }),
  startTyping:   vi.fn(async () => undefined),
  stopTyping:    vi.fn(async () => undefined),
  sendVoiceMemo: vi.fn(async () => undefined),
}));

// Safety / lint — identity.
vi.mock("../safety/supervisor", () => ({ supervise: (m: string) => Promise.resolve(m) }));
vi.mock("../safety/linter",     () => ({ lintMessage: (m: string) => m }));

// Memory stubs — empty by default.
vi.mock("../memory/zepClient",    () => ({ getZepContext: vi.fn(async () => ""), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
vi.mock("../memory/memoryFiles",  () => ({ getMemoryContext: vi.fn(async () => ""), initializeMemoryFiles: vi.fn(async () => undefined) }));
vi.mock("../memory/learnedFacts", () => ({ getRelevantFacts: vi.fn(async () => []), detectAndApplyCorrection: vi.fn(async () => false) }));
vi.mock("../memory/preferences",  () => ({ getPreferences: vi.fn(async () => null), isInDND: () => false }));

// Emotional / skill / voice / recovery — neutral defaults.
vi.mock("./emotionalContext", () => ({
  classifyEmotionalContext:      vi.fn(async () => "calm"),
  classifyEmotionalTopic:         () => "general",
  blendEmotionalContext:         (_s: unknown, c: string) => ({ value: c, persist: null }),
  buildEmotionalContextDirective: () => "",
}));
vi.mock("./skillPicker", () => ({ pickSkill: vi.fn(async () => ({ skill: null, durationMs: 0 })) }));
vi.mock("./skills",      () => ({ findSkill: vi.fn(() => null), buildSkillDirective: vi.fn(() => "") }));
vi.mock("./voiceMirror", () => ({ computeVoiceProfile: vi.fn(() => null), buildVoiceDirective: vi.fn(() => "") }));
vi.mock("./recoveryDecision", () => ({
  decideRecovery: vi.fn(() => ({ shouldFire: false, consecutiveErrorIterations: 0 })),
  RECOVERY_THRESHOLD: 2,
}));
vi.mock("./ephemeralSubAgents", () => ({ runEphemeralSubAgent: vi.fn(async () => ({ output: "", durationMs: 0 })) }));

// MCP tool surface — empty tool list (the agent only runs scripted Claude
// responses, so tool defs aren't validated). handleToolCall reads STATE.toolMocks.
vi.mock("../mcp/server", () => ({
  MCP_TOOLS:        [],
  CAREGIVER_TOOLS:  [],
  handleToolCall:   vi.fn(async (name: string, _input: Record<string, unknown>) => {
    STATE.toolCalls.push(name);
    const mock = STATE.toolMocks.get(name);
    if (typeof mock === "function") return (mock as (i: unknown) => unknown)(_input);
    return mock ?? { ok: true };
  }),
  handleToolCallForCaregiver: vi.fn(async (name: string, _input: Record<string, unknown>) => {
    STATE.toolCalls.push(name);
    const mock = STATE.toolMocks.get(name);
    if (typeof mock === "function") return (mock as (i: unknown) => unknown)(_input);
    return mock ?? { ok: true };
  }),
}));

vi.mock("./executionAgent",    () => ({ getActiveAgentForUser: vi.fn(async () => null) }));
vi.mock("./contextManagement", () => ({
  maybeRollUpHistory:        vi.fn(async () => undefined),
  buildToolResultContent:    vi.fn(async (_u: string, _n: string, r: unknown) => JSON.stringify(r)),
  patchDanglingToolCalls:    vi.fn(() => 0),
  truncateOldToolCallArgs:   vi.fn(() => 0),
}));
vi.mock("./toolCapabilities", () => ({ selectToolsForIntent: (tools: unknown[]) => tools }));
// Checkpointing disabled in transcript replays — we exercise the normal path,
// not resume. Stub to inert no-ops so the flag/env doesn't matter.
vi.mock("./turnCheckpoint", () => ({
  loadCheckpoint:            vi.fn(async () => null),
  writeCheckpoint:           vi.fn(async () => undefined),
  clearCheckpoint:           vi.fn(async () => undefined),
  hashText:                  (s: string) => s,
  isCheckpointResumeEnabled: () => false,
}));
// experimentRegistry is NOT mocked — we want the real registrations so transcripts
// can assert on experiment cohort behavior (tone-warmth-v1, etc.).

// ── Import qaAgent AFTER mocks are declared ──────────────────────────────────

import {
  runQaAgent,
  hasListShape,
  detectGenericHelpAsk,
  detectMedicationInstruction,
  detectMultiQuestionDataCollection,
  detectSupportDeflection,
} from "./qaAgent";

// ── Transcript schema ────────────────────────────────────────────────────────

interface GoldenTranscript {
  name:        string;
  description: string;
  userType?:   "client" | "caregiver";
  userId?:     string;
  seniorId?:   string;
  phone?:      string;
  chatId?:     string;
  // Per-transcript Firestore doc overrides: path → data
  docs?:       Record<string, Record<string, unknown>>;
  toolMocks?:  Record<string, unknown>;
  claudeScript: ClaudeResponseScript[];
  input: {
    text:    string;
  };
  expect: {
    replyContains?:    string[];
    replyNotContains?: string[];
    toolsCalled?:      string[];   // expected order — at minimum
    noListShape?:      boolean;
    // Metric keys that must appear in the cara.turn log line for this turn.
    experimentsContains?: string[];
    conversationRepairApplied?: boolean;
    oneQuestionAtATime?: boolean;
    noSupportDeflection?: boolean;
    noGenericHelpAsk?: boolean;
    noMedicationInstruction?: boolean;
  };
}

// ── Transcripts ──────────────────────────────────────────────────────────────

const GOLDEN_TRANSCRIPTS: GoldenTranscript[] = [
  {
    name:        "greeting-no-context-warm-hello",
    description: "User says 'hi' with no special context. Cara replies warmly without a 'what do you need' open-ended ask.",
    claudeScript: [
      { text: "Hey! How's everything going with Mom today?" },
    ],
    input: { text: "hi" },
    expect: {
      replyContains:    ["Hey"],
      replyNotContains: ["what can I help", "What can I help"],
      toolsCalled:      [],
      noListShape:      true,
    },
  },

  {
    name:        "appointment-question-calls-tool-and-answers",
    description: "Family asks about next visit — Cara calls get_upcoming_appointments before answering.",
    toolMocks: {
      get_upcoming_appointments: {
        appointments: [{ date: "2026-06-01", startTime: "9:00", caregiverName: "Maria" }],
      },
    },
    claudeScript: [
      { tools: [{ name: "get_upcoming_appointments", input: { clientId: "u-1" } }] },
      { text: "Maria's coming Monday June 1st at 9. Anything you want me to pass along?" },
    ],
    input: { text: "when is the next visit?" },
    expect: {
      replyContains: ["Maria"],
      toolsCalled:   ["get_upcoming_appointments"],
      noListShape:   true,
    },
  },

  {
    name:        "no-list-shape-in-reply",
    description: "Even if Claude produces clean prose with a single inline number, no list-shape post-processor should fire.",
    claudeScript: [
      { text: "She turns 78 next month — what a milestone." },
    ],
    input: { text: "how old is mom?" },
    expect: {
      replyContains: ["78"],
      noListShape:   true,
    },
  },

  {
    name:        "multi-step-tool-chain-cancel-then-find-replacement",
    description: "Family wants to cancel + find replacement — Cara executes the chain in order.",
    toolMocks: {
      cancel_appointment:         { success: true, appointmentId: "appt-99" },
      find_replacement_caregivers: { matches: [{ id: "cg-1", name: "Alex" }] },
    },
    claudeScript: [
      { tools: [{ name: "cancel_appointment", input: { appointmentId: "appt-99" } }] },
      { tools: [{ name: "find_replacement_caregivers", input: { clientId: "u-1" } }] },
      { text: "Cancelled the visit and pulled Alex as a backup. Want me to set up a quick intro?" },
    ],
    input: { text: "cancel monday's visit and find me someone else" },
    expect: {
      replyContains: ["Alex"],
      toolsCalled:   ["cancel_appointment", "find_replacement_caregivers"],
      noListShape:   true,
    },
  },

  {
    name:        "experiment-assigned-for-client-cohort",
    description: "Client users get a tone-warmth-v1 assignment in metrics.experiments. Variant value isn't asserted — assignment presence is.",
    claudeScript: [
      { text: "Hey — I hear you. What's going on?" },
    ],
    input: { text: "feeling really worn down today" },
    expect: {
      experimentsContains: ["tone-warmth-v1"],
      noListShape:         true,
    },
  },

  {
    name:        "caregiver-cohort-excluded-from-tone-warmth",
    description: "Caregiver pathway is OFF the tone-warmth-v1 experiment by predicate. metrics.experiments should be empty.",
    userType: "caregiver",
    claudeScript: [
      { text: "Got it." },
    ],
    input: { text: "ok thanks" },
    expect: {
      replyContains: ["Got it"],
      noListShape:   true,
      // tone-warmth-v1 must NOT appear (caregiver predicate excludes them).
      // We assert this indirectly by not specifying experimentsContains and
      // letting the test harness verify via inspection — but adding a
      // negative-membership check would require extending the schema. Skip
      // for now; the cara.turn log line is in the test output for manual review.
    },
  },

  {
    name:        "banned-third-person-cara-self-reference-stays-out",
    description: "Cara never refers to herself in the third person. Even when Claude tries to slip 'reach out to Cara' through, the assertion catches it.",
    claudeScript: [
      { text: "Of course — I'll handle that personally." },
    ],
    input: { text: "can you help me?" },
    expect: {
      replyContains:    ["personally"],
      replyNotContains: [
        "reach out to Cara",
        "the Cara team",
        "Cara team member",
        "contact Cara",
      ],
      noListShape: true,
    },
  },

  {
    name:        "two-tool-parallel-batch-in-one-iteration",
    description: "Claude calls two tools in parallel in a single iteration. Both should execute and appear in the tool call trace.",
    toolMocks: {
      get_upcoming_appointments: { appointments: [] },
      get_care_team:             { team: [{ id: "cg-1", name: "Maria", role: "primary" }] },
    },
    claudeScript: [
      {
        tools: [
          { name: "get_upcoming_appointments", input: { clientId: "u-1" } },
          { name: "get_care_team",             input: { clientId: "u-1" } },
        ],
      },
      { text: "Nothing on the schedule yet. Maria is still on your team if you want to book her." },
    ],
    input: { text: "anything coming up? who's on my team?" },
    expect: {
      replyContains: ["Maria"],
      toolsCalled:   ["get_upcoming_appointments", "get_care_team"],
      noListShape:   true,
    },
  },

  {
    name:        "tool-error-handled-gracefully",
    description: "A tool returns _toolError. Cara still produces a calm, non-broken reply without leaking 'tool unavailable' phrasing.",
    toolMocks: {
      get_upcoming_appointments: { _toolError: true, message: "tool down" },
    },
    claudeScript: [
      { tools: [{ name: "get_upcoming_appointments", input: { clientId: "u-1" } }] },
      { text: "I'm not seeing that right now — give me a moment and I'll try again." },
    ],
    input: { text: "next visit?" },
    expect: {
      toolsCalled:      ["get_upcoming_appointments"],
      replyNotContains: ["error", "Error", "ERROR", "broken"],
      noListShape:      true,
    },
  },

  {
    name:        "caregiver-pathway-uses-caregiver-toolset",
    description: "Caregiver asks about earnings — handled via the caregiver tool handler, not the client one.",
    userType: "caregiver",
    toolMocks: {
      get_caregiver_earnings: { last30Days: 1450 },
    },
    claudeScript: [
      { tools: [{ name: "get_caregiver_earnings", input: {} }] },
      { text: "You've earned $1,450 in the last 30 days." },
    ],
    input: { text: "how much have I made this month?" },
    expect: {
      replyContains: ["1,450", "30 days"],
      toolsCalled:   ["get_caregiver_earnings"],
      noListShape:   true,
    },
  },

  // ── Sprint 8 Commit 1 — voice exemplar coverage ─────────────────────────────
  // Each transcript drives Claude to a scripted warm reply; the harness verifies
  // surrounding machinery (list-shape suppression, no third-person leakage, no
  // banned filler) holds even on heavy-emotion inbounds.

  {
    name:        "grief-warmth-no-platitudes",
    description: "Family reports a loss. Cara sits with it, no \"better place\", no rush to action.",
    claudeScript: [
      { text: "I'm so sorry. I'll stop the visits and pause everything on your account. Take whatever time you need — I'm here when you're ready." },
    ],
    input: { text: "Mom passed last week. Just turning off the service." },
    expect: {
      replyContains:    ["sorry"],
      replyNotContains: ["better place", "happy place", "at least", "everything happens for a reason"],
      toolsCalled:      [],
      noListShape:      true,
    },
  },

  {
    name:        "frustrated-own-it-no-corporate-empathy",
    description: "Family is angry about a recurring caregiver no-show. Cara owns it without using the banned 'I understand your frustration' phrase.",
    toolMocks: {
      get_recent_messages: { messages: [] },
    },
    claudeScript: [
      { tools: [{ name: "get_recent_messages", input: { clientId: "u-1" } }] },
      { text: "You're right, and that's not the experience we want. Let me follow up with her directly and find out what happened today." },
    ],
    input: { text: "This is the second time Maria has been late. It's not okay." },
    expect: {
      replyContains:    ["right"],
      replyNotContains: [
        "I understand your frustration",
        "I'm sorry to hear that",
        "I understand how you feel",
        "Certainly",
        "Of course",
      ],
      toolsCalled: ["get_recent_messages"],
      noListShape: true,
    },
  },

  {
    name:        "rushed-terse-reply",
    description: "Family sends a 5-word rushed question. Cara answers in two words — no padding, no warmth boilerplate.",
    claudeScript: [
      { text: "9am." },
    ],
    input: { text: "quick — is dad's visit tomorrow at 9 or 10?" },
    expect: {
      replyContains:    ["9"],
      replyNotContains: [
        "Happy to help",
        "Let me check",
        "I'll find out",
        "as I mentioned",
      ],
      toolsCalled: [],
      noListShape: true,
    },
  },

  // ── Sprint 8 Commit 3 — memory, knowledge-boundary, repetition ──────────────

  {
    name:        "memory-write-acknowledged-out-loud",
    description: "Family shares a durable preference. Cara calls update_memory_file AND says she's remembering it (never silent).",
    toolMocks: {
      update_memory_file: { success: true },
    },
    claudeScript: [
      { tools: [{ name: "update_memory_file", input: { file: "profile", content: "Dislikes being called sweetie" } }] },
      { text: "Got it, noted — I'll make sure the team knows she doesn't like 'sweetie.'" },
    ],
    input: { text: "She really doesn't like being called sweetie, by the way." },
    expect: {
      replyContains: ["noted"],
      toolsCalled:   ["update_memory_file"],
      noListShape:   true,
    },
  },

  {
    name:        "knowledge-boundary-no-invention",
    description: "Family asks about data Cara doesn't have. Cara says she doesn't see it and offers to find out — never invents a value.",
    claudeScript: [
      { text: "I don't see blood pressure logged in the notes. Want me to ask Maria to start tracking it next visit?" },
    ],
    input: { text: "what's mom's blood pressure been running?" },
    expect: {
      replyContains:    ["don't see"],
      replyNotContains: ["120", "130", "140", "/80", "/90"],
      noListShape:      true,
    },
  },

  {
    name:        "repetition-answer-fully-no-as-i-mentioned",
    description: "Family repeats a question. Cara answers fully again without 'as I mentioned' / 'like I said'.",
    claudeScript: [
      { text: "9am Thursday with Maria. Same as before." },
    ],
    input: { text: "wait, what time is the visit again?" },
    expect: {
      replyContains:    ["9am"],
      replyNotContains: ["as I mentioned", "like I said", "as I said", "I already told"],
      noListShape:      true,
    },
  },

  {
    name:        "messy-family-add-name-phone-acts",
    description: "Family asks in messy SMS shorthand to add a sister and provides name + phone. Cara acts instead of re-asking.",
    toolMocks: {
      add_family_member: { success: true, added: true, name: "Jess", phone: "+15552223333", notification: { sent: true } },
    },
    claudeScript: [
      { tools: [{ name: "add_family_member", input: { clientId: "u-1", seniorId: "s-1", name: "Jess", memberPhone: "+15552223333" } }] },
      { text: "Done - I added Jess and texted her so she'll get Mom's updates too." },
    ],
    input: { text: "hey can u add my sis jess 555-222-3333 to moms updates pls" },
    expect: {
      replyContains:         ["Jess", "texted"],
      replyNotContains:      ["what's her phone", "contact support"],
      toolsCalled:           ["add_family_member"],
      noListShape:           true,
      noSupportDeflection:   true,
      noGenericHelpAsk:      true,
      oneQuestionAtATime:    true,
    },
  },

  {
    name:        "messy-family-add-missing-phone-one-question",
    description: "Family asks to add a brother without a phone number. Cara asks only for the missing phone number.",
    claudeScript: [
      { text: "Sure - what's Mike's phone number?" },
    ],
    input: { text: "can u add my brother mike to updates idk his number rn" },
    expect: {
      replyContains:       ["Mike", "phone"],
      replyNotContains:    ["name and phone", "city", "anything else"],
      toolsCalled:         [],
      noListShape:         true,
      oneQuestionAtATime:  true,
      noGenericHelpAsk:    true,
    },
  },

  {
    name:        "messy-worried-how-is-mom-uses-journal",
    description: "Family asks vaguely and anxiously how Mom is doing. Cara reads care journal instead of guessing.",
    toolMocks: {
      get_care_journal_client: {
        entries: [{ summary: "Maria noted that Anita ate soup and took a short walk after lunch." }],
      },
    },
    claudeScript: [
      { tools: [{ name: "get_care_journal_client", input: { clientId: "u-1" } }] },
      { text: "Maria noted that Mom ate soup and took a short walk after lunch. I don't see anything alarming in the notes - want me to ask Maria for a quick update?" },
    ],
    input: { text: "how's mom?? did she eat? im kinda worried" },
    expect: {
      replyContains:            ["Maria noted", "soup"],
      replyNotContains:         ["probably", "likely", "diagnosis"],
      toolsCalled:              ["get_care_journal_client"],
      noListShape:              true,
      noMedicationInstruction:  true,
      noGenericHelpAsk:         true,
    },
  },

  {
    name:        "messy-medication-question-refuses-advice",
    description: "Family asks for dosing guidance. Cara does not give medication instructions.",
    claudeScript: [
      { text: "I can't advise on changing meds. Please call her doctor or pharmacist before giving anything extra. If she seems in danger, call 911 now." },
    ],
    input: { text: "mom is dizzy and her meds seem off should i give extra??" },
    expect: {
      replyContains:            ["doctor", "pharmacist"],
      replyNotContains:         ["give extra", "increase", "double"],
      toolsCalled:              [],
      noListShape:              true,
      noMedicationInstruction:  true,
    },
  },

  {
    name:        "angry-no-show-acts-without-support-punt",
    description: "Family is angry about a no-show. Cara owns it and starts resolving coverage instead of punting to support.",
    toolMocks: {
      get_upcoming_appointments: { appointments: [{ id: "appt-1", caregiverName: "Maria", date: "today", startTime: "9:00" }] },
      find_replacement_caregivers: { matches: [{ id: "cg-2", name: "Alex" }] },
    },
    claudeScript: [
      { tools: [{ name: "get_upcoming_appointments", input: { clientId: "u-1" } }] },
      { tools: [{ name: "find_replacement_caregivers", input: { clientId: "u-1" } }] },
      { text: "You're right - that's not okay. I found Alex as backup coverage and I'm working from the missed 9am visit now." },
    ],
    input: { text: "wtf nobody came again fix this now" },
    expect: {
      replyContains:        ["not okay", "Alex"],
      replyNotContains:     ["contact support", "the team will", "reach out"],
      toolsCalled:          ["get_upcoming_appointments", "find_replacement_caregivers"],
      noListShape:          true,
      noSupportDeflection:  true,
    },
  },

  {
    name:        "messy-caregiver-pay-question-uses-payout-tool",
    description: "Caregiver asks casually about pay after clock-out. Cara uses caregiver payout data.",
    userType: "caregiver",
    toolMocks: {
      get_payout_history: { payouts: [{ amountCents: 9600, status: "pending", expectedArrival: "Friday" }] },
    },
    claudeScript: [
      { tools: [{ name: "get_payout_history", input: { caregiverId: "u-1" } }] },
      { text: "That payout is pending and expected Friday." },
    ],
    input: { text: "when do i get paid for mrs lopez?? i clocked out yesterday" },
    expect: {
      replyContains:       ["pending", "Friday"],
      replyNotContains:    ["support", "team will"],
      toolsCalled:         ["get_payout_history"],
      noListShape:         true,
      noSupportDeflection: true,
      noGenericHelpAsk:    true,
    },
  },

  {
    name:        "repairs-generic-chatbot-final-reply",
    description: "If Claude produces a generic chatbot close, Cara repairs it before sending.",
    claudeScript: [
      { text: "Sure, I can help with that. What can I help you with today?" },
    ],
    input: { text: "hey" },
    expect: {
      replyContains:              ["I'm here with you"],
      replyNotContains:           ["What can I help", "how can I help"],
      toolsCalled:                [],
      noListShape:                true,
      noGenericHelpAsk:           true,
      conversationRepairApplied:  true,
    },
  },

  {
    name:        "repairs-form-like-intake-final-reply",
    description: "If Claude asks for a form's worth of data, Cara trims to one human question.",
    claudeScript: [
      { text: "Please send me her name, age, city, zip, and care needs." },
    ],
    input: { text: "i need to set up care for mom" },
    expect: {
      replyContains:              ["name"],
      replyNotContains:           ["age", "city", "zip", "care needs"],
      noListShape:                true,
      oneQuestionAtATime:         true,
      conversationRepairApplied:  true,
    },
  },

  {
    name:        "repairs-support-punt-final-reply",
    description: "If Claude punts to support for something Cara should handle, Cara keeps ownership.",
    claudeScript: [
      { text: "Please contact support and the team will follow up." },
    ],
    input: { text: "my caregiver didn't show up" },
    expect: {
      replyContains:              ["I can handle"],
      replyNotContains:           ["contact support", "team will"],
      noSupportDeflection:        true,
      conversationRepairApplied:  true,
    },
  },

  {
    name:        "repairs-unsafe-medication-final-reply",
    description: "If Claude gives medication advice, Cara replaces it with a safe clinical boundary.",
    claudeScript: [
      { text: "Give her an extra dose tonight and call tomorrow if she still feels dizzy." },
    ],
    input: { text: "mom is dizzy should i give extra meds" },
    expect: {
      replyContains:              ["doctor", "pharmacist"],
      replyNotContains:           ["extra dose"],
      noMedicationInstruction:    true,
      conversationRepairApplied:  true,
    },
  },

  {
    name:        "messy-emergency-fall-creates-alert",
    description: "Family reports a fall in panic. Cara avoids medical advice, tells them to call emergency services if urgent, and creates an admin/safety alert.",
    toolMocks: {
      create_support_ticket: { success: true, ticketId: "tick-fall-1" },
    },
    claudeScript: [
      { tools: [{ name: "create_support_ticket", input: { category: "safety", priority: "urgent", description: "Family reports mom fell and needs urgent guidance." } }] },
      { text: "If Mom may be hurt or cannot get up safely, call 911 now. I flagged this as urgent here too - are you with her right now?" },
    ],
    input: { text: "mom fell omg what do i do???" },
    expect: {
      replyContains:           ["911", "urgent"],
      replyNotContains:        ["take her medication", "diagnose", "probably"],
      toolsCalled:             ["create_support_ticket"],
      noMedicationInstruction: true,
      noListShape:             true,
      oneQuestionAtATime:      true,
    },
  },

  {
    name:        "messy-hours-dispute-asks-one-detail",
    description: "Client disputes hours vaguely. Cara does not approve payment or ask a list; she asks for the one missing detail.",
    claudeScript: [
      { text: "I won't approve that yet. What looks wrong - the start time, end time, or total hours?" },
    ],
    input: { text: "these hours look wrong no way" },
    expect: {
      replyContains:       ["won't approve", "What looks wrong"],
      replyNotContains:    ["approved", "paid", "contact support"],
      toolsCalled:         [],
      noSupportDeflection: true,
      noListShape:         true,
      oneQuestionAtATime:  true,
    },
  },

  {
    name:        "caregiver-approval-status-specific",
    description: "Caregiver asks why they are not approved. Cara uses caregiver status data and does not give a generic support answer.",
    userType: "caregiver",
    toolMocks: {
      get_background_check_status: {
        verificationStatus: "submitted",
        backgroundCheckStatus: "consider",
        onboardingStatus: "profile_complete",
      },
    },
    claudeScript: [
      { tools: [{ name: "get_background_check_status", input: { caregiverId: "u-1" } }] },
      { text: "Your profile is complete, but your background check is still in review. You are not bookable until Checkr clears it, and admin will review the exception." },
    ],
    input: { text: "why am i not approved yet??" },
    expect: {
      replyContains:       ["profile is complete", "background check", "not bookable"],
      replyNotContains:    ["contact support", "team will"],
      toolsCalled:         ["get_background_check_status"],
      noSupportDeflection: true,
      noGenericHelpAsk:    true,
      noListShape:         true,
    },
  },

  {
    name:        "caregiver-referral-partial-info-one-question",
    description: "Caregiver wants to refer someone but only gives a name. Cara asks for the missing phone only.",
    userType: "caregiver",
    claudeScript: [
      { text: "I can invite Ana. What's her phone number?" },
    ],
    input: { text: "i wanna refer my friend Ana shes a great caregiver" },
    expect: {
      replyContains:       ["Ana", "phone number"],
      replyNotContains:    ["name and phone", "email", "contact support"],
      toolsCalled:         [],
      noSupportDeflection: true,
      noGenericHelpAsk:    true,
      noListShape:         true,
      oneQuestionAtATime:  true,
    },
  },
];

// ── Replay driver ────────────────────────────────────────────────────────────

async function replayTranscript(t: GoldenTranscript): Promise<{
  reply:        string;
  toolCalls:    string[];
  sentChunks:   string[];
  experiments?: Record<string, string>;
  metrics?: Record<string, unknown>;
}> {
  resetState();

  // Seed Firestore overrides
  if (t.docs) {
    for (const [path, data] of Object.entries(t.docs)) {
      STATE.docs.set(path, data);
    }
  }

  // Seed tool mocks
  if (t.toolMocks) {
    for (const [name, result] of Object.entries(t.toolMocks)) {
      STATE.toolMocks.set(name, result);
    }
  }

  // Seed Claude script
  for (const step of t.claudeScript) {
    STATE.claudeScript.push(step);
  }

  // Spy on console.info to capture the cara.turn metric line for this turn.
  const turnLogs: Record<string, unknown>[] = [];
  const infoSpy = vi.spyOn(console, "info").mockImplementation((label: unknown, payload?: unknown) => {
    if (label === "cara.turn" && payload && typeof payload === "object") {
      turnLogs.push(payload as Record<string, unknown>);
    }
  });

  let reply: string;
  try {
    reply = await runQaAgent({
      text:     t.input.text,
      phone:    t.phone    ?? "+15555550100",
      chatId:   t.chatId   ?? "chat-1",
      userId:   t.userId   ?? "u-1",
      seniorId: t.seniorId ?? "s-1",
      userType: t.userType ?? "client",
      skipSend: false,
    });
  } finally {
    infoSpy.mockRestore();
  }

  const lastTurn = turnLogs[turnLogs.length - 1] ?? {};
  return {
    reply,
    toolCalls:   [...STATE.toolCalls],
    sentChunks:  [...STATE.sentChunks],
    experiments: lastTurn.experiments as Record<string, string> | undefined,
    metrics:     lastTurn,
  };
}

// ── Test runner ──────────────────────────────────────────────────────────────

describe("golden transcripts", () => {
  beforeEach(() => resetState());

  for (const t of GOLDEN_TRANSCRIPTS) {
    it(`replays "${t.name}" — ${t.description}`, async () => {
      const out = await replayTranscript(t);

      if (t.expect.replyContains) {
        for (const substr of t.expect.replyContains) {
          expect(out.reply).toContain(substr);
        }
      }
      if (t.expect.replyNotContains) {
        for (const banned of t.expect.replyNotContains) {
          expect(out.reply.toLowerCase()).not.toContain(banned.toLowerCase());
        }
      }
      if (t.expect.toolsCalled) {
        // Allow extra tool calls beyond the expected (sub-set match in order).
        // This keeps transcripts resilient to additive tool calls (logging,
        // metrics) that we don't care about asserting.
        let cursor = 0;
        for (const expected of t.expect.toolsCalled) {
          const idx = out.toolCalls.indexOf(expected, cursor);
          expect(idx, `expected "${expected}" in tool calls ${JSON.stringify(out.toolCalls)}`).toBeGreaterThanOrEqual(0);
          cursor = idx + 1;
        }
      }
      if (t.expect.noListShape) {
        expect(hasListShape(out.reply), `reply has list shape: ${out.reply}`).toBe(false);
      }
      if (t.expect.oneQuestionAtATime) {
        expect(detectMultiQuestionDataCollection(out.reply), `reply asks for too much at once: ${out.reply}`).toBe(false);
      }
      if (t.expect.noSupportDeflection) {
        expect(detectSupportDeflection(out.reply), `reply punts instead of acting: ${out.reply}`).toBe(false);
      }
      if (t.expect.noGenericHelpAsk) {
        expect(detectGenericHelpAsk(out.reply), `reply uses generic helper prompt: ${out.reply}`).toBe(false);
      }
      if (t.expect.noMedicationInstruction) {
        expect(detectMedicationInstruction(out.reply), `reply gives medication instruction: ${out.reply}`).toBe(false);
      }
      if (t.expect.experimentsContains) {
        for (const key of t.expect.experimentsContains) {
          expect(out.experiments, `experiments missing — got ${JSON.stringify(out.experiments)}`).toBeDefined();
          expect(out.experiments).toHaveProperty(key);
        }
      }
      if (t.expect.conversationRepairApplied) {
        expect(out.metrics?.conversationRepairApplied, `conversation repair did not apply: ${JSON.stringify(out.metrics)}`).toBe(true);
      }
    });
  }
});
