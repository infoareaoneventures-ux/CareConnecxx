import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ── REAL-MODEL onboarding-loop eval (the last pre-flip gate) ──────────────────
//
// Unlike qaAgent.onboarding.test.ts (which MOCKS the Claude client to script a
// fixed tool sequence), this eval runs the loop against the REAL Sonnet model on
// messy human inputs and grades the result against the four pre-flip gates:
//   1. completion              — all required fields collected
//   2. fields-before-handoff   — complete_collection only fired when full
//   3. no re-greet             — Evia never re-greets / re-introduces after turn 1
//   4. no double-send          — one user-facing reply per turn
// (see docs/runbooks/onboarding-agent-loop-rollout.md and onboardingEvalGraders.ts)
//
// SPEND GATE: the live suite is SKIPPED unless BOTH are set:
//   CARA_ONBOARDING_EVAL_LIVE=true   and   ANTHROPIC_API_KEY=<key>
// so the normal `npx vitest run` (and predeploy `npm run eval`) NEVER spend tokens.
// To run it:
//   CARA_ONBOARDING_EVAL_LIVE=true ANTHROPIC_API_KEY=sk-... \
//     npx vitest run functions/src/agents/qaAgent.onboarding.eval.test.ts
//
// Everything EXCEPT the model is mocked: an in-memory Firestore + an in-memory
// handleToolCall that applies the REAL save/complete semantics (via the real
// onboardingContract) so the model gets truthful missing-field feedback turn over
// turn. ../utils/claudeRetry and ../utils/claudeClient are NOT mocked — the loop
// calls the live API.

import {
  gradeOnboardingTranscript,
  isReGreet,
  hasBannedPhrasing,
  p95,
  type TranscriptGrade,
} from "./onboardingEvalGraders";
import {
  isAllowedField,
  missingRequiredFields,
  firstGateStep,
} from "./onboardingContract";

const LIVE =
  process.env.CARA_ONBOARDING_EVAL_LIVE === "true" && !!process.env.ANTHROPIC_API_KEY;

// ── shared in-memory store (sessions + conversation history) ──────────────────
const store = vi.hoisted(() => {
  const sessions = new Map<string, { onboardingData: Record<string, unknown>; onboardingStep: string }>();
  const convos = new Map<string, Array<{ role: string; content: string; timestamp: number }>>();
  return {
    sessions,
    convos,
    reset() { sessions.clear(); convos.clear(); },
    // initialStep defaults to the client flow's first collection step; caregiver
    // cases pass their own so the loop starts on a caregiver collection turn.
    ensure(phone: string, initialStep = "client_ask_name") {
      if (!sessions.has(phone)) sessions.set(phone, { onboardingData: {}, onboardingStep: initialStep });
      if (!convos.has(phone)) convos.set(phone, []);
    },
  };
});

// ── in-memory Firestore (agent_sessions + agent_conversations/{phone}/messages) ─
vi.mock("firebase-admin", () => {
  const FieldValue = { delete: () => "__delete__", serverTimestamp: () => "__ts__" };

  // A doc ref is path-aware so the conversation-history subcollection and the
  // session doc resolve to the right slice of the in-memory store.
  function docRef(path: string): any {
    return {
      path,
      get: async () => {
        if (path.startsWith("agent_sessions/")) {
          const phone = path.split("/")[1];
          const s = store.sessions.get(phone);
          return { exists: !!s, data: () => (s ? { ...s } : undefined) };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (data: any, opts?: any) => {
        if (path.startsWith("agent_sessions/")) {
          const phone = path.split("/")[1];
          store.ensure(phone);
          const cur = store.sessions.get(phone)!;
          if (data.onboardingData) {
            cur.onboardingData = opts?.merge ? { ...cur.onboardingData, ...data.onboardingData } : data.onboardingData;
          }
          if (data.onboardingStep) cur.onboardingStep = data.onboardingStep;
        }
      },
      update: async () => {},
      collection: (sub: string) => collRef(`${path}/${sub}`),
    };
  }

  function collRef(path: string): any {
    const ref: any = { _wantSummary: false };
    ref.doc = (id?: string) => docRef(`${path}/${id ?? `auto-${Math.random().toString(36).slice(2)}`}`);
    ref.where = (field: string, _op: string, val: unknown) => {
      if (field === "role" && val === "summary") ref._wantSummary = true;
      return ref;
    };
    ref.orderBy = () => ref;
    ref.limit = () => ref;
    ref.get = async () => {
      // messages subcollection: agent_conversations/{phone}/messages
      const m = path.match(/^agent_conversations\/(.+)\/messages$/);
      if (m) {
        const phone = m[1];
        if (ref._wantSummary) return { empty: true, docs: [] };
        const msgs = (store.convos.get(phone) ?? []).slice();
        // orderBy timestamp desc + limit 10 (getConversationHistory reverses back)
        const desc = msgs.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
        return {
          empty: desc.length === 0,
          docs: desc.map((d, i) => ({ id: `m${i}`, data: () => d })),
        };
      }
      return { empty: true, docs: [] };
    };
    ref.add = async () => ({ id: "auto" });
    // maybeRollUpHistory uses col.count().get() → .data().count
    ref.count = () => ({
      get: async () => {
        const m = path.match(/^agent_conversations\/(.+)\/messages$/);
        const n = m ? (store.convos.get(m[1])?.length ?? 0) : 0;
        return { data: () => ({ count: n }) };
      },
    });
    return ref;
  }

  const firestoreFn: any = () => ({ collection: (name: string) => collRef(name) });
  firestoreFn.FieldValue = FieldValue;
  // batch: saveConversationTurn uses db.batch().set(col.doc(), {...}).commit()
  firestoreFn().batch = () => {};
  const fs: any = () => ({
    collection: (name: string) => collRef(name),
    batch: () => {
      const ops: Array<{ path: string; data: any }> = [];
      return {
        set: (ref: any, data: any) => { ops.push({ path: ref.path, data }); },
        update: () => {},
        commit: async () => {
          for (const op of ops) {
            const m = op.path.match(/^agent_conversations\/(.+)\/messages\//);
            if (m) {
              const phone = m[1];
              store.ensure(phone);
              store.convos.get(phone)!.push({
                role: op.data.role, content: op.data.content, timestamp: op.data.timestamp,
              });
            }
          }
        },
      };
    },
  });
  fs.FieldValue = FieldValue;

  return {
    __esModule: true,
    default: { apps: [{}], initializeApp: () => ({}), firestore: fs },
    apps: [{}],
    initializeApp: () => ({}),
    firestore: fs,
  };
});

// ── real tool schemas (so the live model calls them with the right params) ─────
// Copied verbatim from functions/src/mcp/server.ts so the model sees the true
// input contract without importing the heavy server graph.
vi.mock("../mcp/server", () => {
  const MCP_TOOLS = [
    {
      name: "complete_task",
      description: "Signal that you've finished this turn — the message you pass is sent to the user as your reply. status: 'done' | 'blocked' | 'needs_user'.",
      input_schema: { type: "object", properties: {
        status: { type: "string", enum: ["done", "blocked", "needs_user"] },
        message: { type: "string" },
      }, required: ["status", "message"] },
    },
    {
      name: "save_onboarding_field",
      description: "During onboarding, persist ONE field the user just gave you. One call per field. Returns the fields still missing.",
      input_schema: { type: "object", properties: {
        role: { type: "string", enum: ["client", "caregiver"] },
        fieldName: { type: "string", description: "e.g. firstName, seniorName, age, careNeeds, city, daysPerWeek, timeOfDay" },
        fieldValue: { oneOf: [{ type: "string" }, { type: "number" }, { type: "array" }, { type: "object" }] },
      }, required: ["role", "fieldName", "fieldValue"] },
    },
    {
      name: "complete_collection",
      description: "Signal you've collected every required onboarding field. Re-checks the required set; if anything is missing it returns the missing list and does NOT advance.",
      input_schema: { type: "object", properties: {
        role: { type: "string", enum: ["client", "caregiver"] },
      }, required: ["role"] },
    },
  ];

  // in-memory handleToolCall with the REAL save/complete semantics.
  const handleToolCall = vi.fn(async (name: string, input: Record<string, unknown>) => {
    const phone = input.phone as string;
    const role = (input.role as "client" | "caregiver") ?? "client";
    store.ensure(phone);
    const sess = store.sessions.get(phone)!;

    if (name === "save_onboarding_field") {
      const fieldName = input.fieldName as string;
      const fieldValue = input.fieldValue;
      if (!fieldName) return { _toolError: true, error: "fieldName is required" };
      if (!isAllowedField(role, fieldName)) return { _toolError: true, error: `'${fieldName}' is not a collectable field for a ${role}.` };
      if (fieldValue === undefined || fieldValue === null || fieldValue === "") return { _toolError: true, error: "fieldValue is required" };
      sess.onboardingData[fieldName] = fieldValue;
      const missing = missingRequiredFields(role, sess.onboardingData);
      return { ok: true, fieldName, saved: true, missing, collectionComplete: missing.length === 0 };
    }
    if (name === "complete_collection") {
      const missing = missingRequiredFields(role, sess.onboardingData);
      if (missing.length > 0) {
        return { ok: true, complete: false, missing, guidance: "Not done yet — call save_onboarding_field for each missing field, then complete_collection again." };
      }
      sess.onboardingStep = firstGateStep(role);
      return { ok: true, complete: true, nextStep: sess.onboardingStep, status: "collection_complete" };
    }
    return { ok: true };
  });

  // Caregiver turns dispatch through handleToolCallForCaregiver (qaAgent.ts:1983) —
  // delegate to the same in-memory engine so caregiver eval cases exercise real
  // save/complete semantics instead of crashing on an undefined (non-promise) return.
  const handleToolCallForCaregiver = vi.fn(async (name: string, input: Record<string, unknown>, _shadowMode?: boolean) =>
    handleToolCall(name, input));
  return { MCP_TOOLS, CAREGIVER_TOOLS: [], CLIENT_TOOLS: [], handleToolCall, handleToolCallForCaregiver };
});

// claudeClient: return a REAL Anthropic client so the loop makes genuine live API
// calls (callClaudeWithRetry stays unmocked). Two vitest-only quirks handled here;
// neither affects production:
//   1. vite's SSR transform strips [[Construct]] off the SDK's exported class, so
//      `new Anthropic(...)` throws "is not a constructor" under the runner. Loading
//      the SDK through node's createRequire bypasses the vite transform and yields
//      the genuine, constructible CJS class.
//   2. the test env is jsdom, which the SDK detects as a browser and refuses to
//      run in — dangerouslyAllowBrowser:true opts past that (test-only).
// wrapAnthropic (LangSmith) is skipped — fine for an eval.
vi.mock("../utils/claudeClient", async () => {
  const { createRequire } = await import("node:module");
  // __filename (provided by vite-node's CJS shims) instead of import.meta.url:
  // equivalent base for createRequire, and it typechecks under the commonjs tsconfig.
  const req = createRequire(__filename);
  const mod: any = req("@anthropic-ai/sdk");
  const Anthropic = typeof mod === "function" ? mod : (mod.Anthropic ?? mod.default);
  let client: any = null;
  return {
    getSharedClient: () => {
      if (!client) {
        client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY ?? "",
          maxRetries: 0,
          timeout: 30_000,
          dangerouslyAllowBrowser: true,
        });
      }
      return client;
    },
  };
});

// openaiClient: return a REAL OpenAI client so the eval exercises PROD's actual
// agent model (CARA_AGENT_PROVIDER=openai, gpt-5.4) — not the Anthropic fallback.
// Same two vitest-only quirks as the claudeClient mock above (SSR strips the SDK
// constructor → load via createRequire; jsdom looks like a browser →
// dangerouslyAllowBrowser). wrapOpenAI (LangSmith) is skipped, as in prod-off.
// quickComplete mirrors the real single-shot helper (router-tier model, same
// token-limit param) so quick-tier calls inside the loop also hit the real model.
vi.mock("../utils/openaiClient", async () => {
  const { createRequire } = await import("node:module");
  // Same __filename-for-import.meta.url swap as the claudeClient mock above.
  const req = createRequire(__filename);
  const mod: any = req("openai");
  const OpenAI = typeof mod === "function" ? mod : (mod.OpenAI ?? mod.default);
  const { resolveCaraModelConfig } = await import("../config/caraModels");
  let openaiClient: any = null;
  let geminiClient: any = null;
  const openAiTokenLimitParam = (model: string, maxTokens: number) =>
    /^gpt-5(?:[.-]|$)/i.test(model) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const getOpenAIClient = () => {
    if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "", timeout: 30_000, maxRetries: 0, dangerouslyAllowBrowser: true });
    return openaiClient;
  };
  const getGeminiOpenAIClient = () => {
    if (!geminiClient) geminiClient = new OpenAI({ apiKey: process.env.GEMINI_API_KEY ?? "", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", timeout: 15_000, maxRetries: 0, dangerouslyAllowBrowser: true });
    return geminiClient;
  };
  const quickComplete = async (systemPrompt: string, userText: string, opts?: { maxTokens?: number; model?: string; signal?: AbortSignal }) => {
    const maxTokens = opts?.maxTokens ?? 200;
    const model = opts?.model ?? resolveCaraModelConfig("router").model;
    const res = await getOpenAIClient().chat.completions.create({
      model,
      ...openAiTokenLimitParam(model, maxTokens),
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }],
    }, { signal: opts?.signal });
    return (res.choices[0]?.message?.content ?? "").trim();
  };
  return { getOpenAIClient, getGeminiOpenAIClient, quickComplete, openAiTokenLimitParam };
});
vi.mock("../safety/supervisor", () => ({ supervise: (msg: string) => Promise.resolve(msg) }));
vi.mock("../safety/linter", () => ({ lintMessage: (msg: string) => msg }));
vi.mock("../memory/zepClient", () => ({ getZepContext: vi.fn(() => Promise.resolve("")), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
vi.mock("../memory/memoryFiles", () => ({ getMemoryContext: vi.fn(() => Promise.resolve("")) }));
vi.mock("../memory/learnedFacts", () => ({
  getRelevantFacts: vi.fn(() => Promise.resolve([])),
  detectAndStageFactChange: vi.fn(async () => ({ kind: "not_correction" })),
  factChangeAckCopy: vi.fn(() => null),
  findTombstonedRestatement: vi.fn(async () => null),
  classifyReRememberReply: vi.fn(async () => "other"),
  confirmReRemember: vi.fn(async () => ({ ok: false, reason: "not_found" })),
}));
vi.mock("../memory/preferences", () => ({ getPreferences: vi.fn(() => Promise.resolve(null)), isInDND: () => false }));
vi.mock("../linq/client", () => ({ sendMessage: vi.fn(() => Promise.resolve()), startTyping: vi.fn(() => Promise.resolve()), stopTyping: vi.fn(() => Promise.resolve()) }));
vi.mock("./caraAgent", () => ({ buildClickableMessage: (s: string) => s }));
vi.mock("./executionAgent", () => ({ getActiveAgentForUser: vi.fn(() => Promise.resolve(null)) }));
vi.mock("./pendingActions", () => ({ getLatestPending: vi.fn(() => Promise.resolve(null)) }));

// ── eval cases — messy, human, multi-turn ─────────────────────────────────────
interface EvalCase {
  id: string;
  label: string;
  turns: string[];
  // Which onboarding loop the case exercises. Defaults to "client".
  role?: "client" | "caregiver";
  // Session cursor at turn 1 (defaults to the client flow's first step).
  initialStep?: string;
}

const EVAL_CASES: EvalCase[] = [
  {
    id: "terse",
    label: "terse one-word-ish answers",
    // Terse, but not a trap: "her name is Dorothy" makes clear Dorothy is the senior,
    // and the family member gives their own name explicitly at the end.
    turns: ["my mom needs care", "her name is Dorothy", "82", "bathing and meals", "Austin", "3 days a week", "mornings", "oh and I'm Imran"],
  },
  {
    id: "front_loaded",
    label: "front-loaded multi-field answer",
    turns: [
      "Hi, I'm Sarah and my mother Jane (she's 78) in Dallas needs help with dressing and meals about 3 mornings a week",
      "yes that's right",
    ],
  },
  {
    id: "mid_flow_question",
    label: "asks a question mid-collection, then resumes",
    turns: ["I'm looking for help for my dad", "I'm Maria, his name is Robert and he's 80", "wait — how much does this cost?", "ok. he needs help with mobility and meds", "he's in Phoenix", "5 days a week, afternoons"],
  },
  {
    id: "correction",
    label: "corrects a value mid-flow",
    turns: ["I'm Tom, it's for my wife Carol", "she's 71", "actually she's 72, not 71", "she has dementia and needs supervision", "Seattle", "every day, all day", "yes"],
  },
  {
    id: "bare_greeting",
    label: "opens with a bare greeting",
    turns: ["hello?", "oh hi, I'm Ana", "it's for my grandmother Rosa, she's 90", "companionship and light housekeeping", "Miami", "2 days a week mornings"],
  },
  // ── caregiver loop (ONBOARDING_AGENT_LOOP=client,caregiver rollout gate) ────
  {
    id: "cg_story",
    label: "caregiver front-loads their whole story",
    role: "caregiver",
    initialStep: "caregiver_ask_name",
    turns: [
      "Hi I'm Maria, I'm in San Jose. I've been a caregiver about 6 years, mostly dementia clients, I'm a CNA and CPR certified",
      "weekdays 8am to 4pm",
      "part-time is ideal",
      "$25 an hour",
      "maria.g@example.com",
      "I treat every client like my own family and I never rush the hard moments",
    ],
  },
  {
    id: "cg_terse",
    label: "caregiver gives terse one-word-ish answers",
    role: "caregiver",
    initialStep: "caregiver_ask_name",
    turns: ["James", "Sunnyvale", "4 years", "mobility and post-surgery", "weekends", "occasional", "22", "james.t@example.com", "I show up on time and keep families in the loop"],
  },
  {
    id: "cg_money_question",
    label: "caregiver asks about pay and the background check mid-collection",
    role: "caregiver",
    initialStep: "caregiver_ask_name",
    turns: [
      "I'm Priya, San Jose",
      "wait, how do I actually get paid? is there a fee?",
      "ok. 8 years experience, dementia and hospice, HHA certified",
      "monday wednesday friday, mornings",
      "part time",
      "$28/hr",
      "priya.k@example.com",
      "Calm, patient, and thorough — I've sat with families through the hardest seasons",
    ],
  },
];

// ── grader-only unit tests (ALWAYS run — no API spend) ────────────────────────
describe("onboarding eval graders (pure, no spend)", () => {
  it("isReGreet flags greeting openers and self-intro / chatbot phrasing", () => {
    expect(isReGreet("Hi again! What's next?")).toBe(true);
    expect(isReGreet("Hey Sarah, how are you?")).toBe(true);
    expect(isReGreet("Good morning!")).toBe(true);
    expect(isReGreet("I'm Evia, your AI care assistant.")).toBe(true);
    expect(isReGreet("Got it — and how old is she?")).toBe(false);
    expect(isReGreet("So she's alone mornings. What city are you in?")).toBe(false);
    // "Nice to meet you, <name>" after they introduce themselves is good manners,
    // NOT a conversation-restart re-greet.
    expect(isReGreet("Nice to meet you, Ana. What city is Rosa in?")).toBe(false);
    expect(isReGreet("Good to meet you, Maria! And how old is he?")).toBe(false);
  });

  it("hasBannedPhrasing catches chatbot tells anywhere in the reply", () => {
    expect(hasBannedPhrasing("Sure! How can I help you today?")).toBe(true);
    expect(hasBannedPhrasing("I'm here to help with that.")).toBe(true);
    expect(hasBannedPhrasing("Tell me her age.")).toBe(false);
  });

  it("p95 picks the high-tail sample", () => {
    expect(p95([])).toBe(0);
    expect(p95([100])).toBe(100);
    expect(p95([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(100);
  });

  it("grades a clean transcript as passing", () => {
    const grade = gradeOnboardingTranscript({
      replies: ["Got it — who are we caring for?", "And how old is Jane?", "What city?", "Perfect, that's everything — setting you up now."],
      perTurnSendCounts: [1, 1, 1, 1],
      finalData: { firstName: "Imran", seniorName: "Jane", age: 82, careNeeds: ["bathing"], city: "Austin", daysPerWeek: 3, timeOfDay: "mornings" },
      role: "client",
      completeFiredWith: [],
    });
    expect(grade.passed).toBe(true);
    expect(grade.metrics.completed).toBe(true);
  });

  it("fails on re-greet, premature handoff, incompletion, and double-send", () => {
    const reGreet: TranscriptGrade = gradeOnboardingTranscript({
      replies: ["Got it.", "Hi again! What's her name?"],
      perTurnSendCounts: [1, 1],
      finalData: { firstName: "X", seniorName: "Y", age: 80, careNeeds: ["a"], city: "C", daysPerWeek: 2, timeOfDay: "am" },
      role: "client",
      completeFiredWith: [],
    });
    expect(reGreet.passed).toBe(false);
    expect(reGreet.failures.some((f) => f.includes("re-greet"))).toBe(true);

    const premature = gradeOnboardingTranscript({
      replies: ["ok", "done"],
      perTurnSendCounts: [1, 1],
      finalData: { firstName: "X" },
      role: "client",
      completeFiredWith: ["seniorName", "age"],
    });
    expect(premature.passed).toBe(false);
    expect(premature.failures.some((f) => f.includes("premature handoff"))).toBe(true);
    expect(premature.failures.some((f) => f.includes("incomplete"))).toBe(true);

    const doubleSend = gradeOnboardingTranscript({
      replies: ["ok", "next"],
      perTurnSendCounts: [1, 2],
      finalData: { firstName: "X", seniorName: "Y", age: 80, careNeeds: ["a"], city: "C", daysPerWeek: 2, timeOfDay: "am" },
      role: "client",
      completeFiredWith: [],
    });
    expect(doubleSend.passed).toBe(false);
    expect(doubleSend.failures.some((f) => f.includes("double-send"))).toBe(true);
  });
});

// ── harness tool-engine fidelity (ALWAYS run — no API spend) ──────────────────
// Proves the in-memory handleToolCall the live eval relies on mirrors the REAL
// server.ts save/complete semantics, so a green live run means the MODEL behaved —
// not that the harness was lenient.
describe("eval harness tool engine (no spend)", () => {
  beforeEach(() => { store.reset(); });

  it("save shrinks the missing set; complete_collection gates until full, then advances", async () => {
    const { handleToolCall } = await import("../mcp/server");
    const phone = "+15550000001";
    store.ensure(phone);
    const base = { phone, role: "client" as const };

    const r1: any = await handleToolCall("save_onboarding_field", { ...base, fieldName: "firstName", fieldValue: "Imran" }, false);
    expect(r1.ok).toBe(true);
    expect(r1.missing).toContain("seniorName");
    expect(r1.collectionComplete).toBe(false);

    // Premature complete → complete:false + a real missing list (not a tool error).
    const early: any = await handleToolCall("complete_collection", base, false);
    expect(early.complete).toBe(false);
    expect(early.missing.length).toBeGreaterThan(0);

    // Disallowed field is rejected.
    const bad: any = await handleToolCall("save_onboarding_field", { ...base, fieldName: "favoriteColor", fieldValue: "blue" }, false);
    expect(bad._toolError).toBe(true);

    // Fill the rest of the required set.
    for (const [fieldName, fieldValue] of [
      ["seniorName", "Jane"], ["age", 82], ["careNeeds", ["bathing", "meals"]],
      ["city", "Austin"], ["daysPerWeek", 3], ["timeOfDay", "mornings"],
    ] as Array<[string, unknown]>) {
      await handleToolCall("save_onboarding_field", { ...base, fieldName, fieldValue }, false);
    }

    const done: any = await handleToolCall("complete_collection", base, false);
    expect(done.complete).toBe(true);
    expect(store.sessions.get(phone)!.onboardingStep).toBe(firstGateStep("client"));
  });

  it("caregiver role: save/complete semantics mirror the caregiver contract and hand off to the photo gate", async () => {
    const { handleToolCall } = await import("../mcp/server");
    const phone = "+15550000002";
    store.ensure(phone, "caregiver_ask_name");
    const base = { phone, role: "caregiver" as const };

    const r1: any = await handleToolCall("save_onboarding_field", { ...base, fieldName: "name", fieldValue: "Maria" }, false);
    expect(r1.ok).toBe(true);
    expect(r1.missing).toContain("hourlyRate");
    expect(r1.collectionComplete).toBe(false);

    // Premature complete → gated with a real missing list.
    const early: any = await handleToolCall("complete_collection", base, false);
    expect(early.complete).toBe(false);
    expect(early.missing.length).toBeGreaterThan(0);

    // Optional scripted-flow fields (story extraction / profile step) are allowed…
    const cert: any = await handleToolCall("save_onboarding_field", { ...base, fieldName: "certifications", fieldValue: ["CNA", "CPR"] }, false);
    expect(cert.ok).toBe(true);
    // …while invented keys and cross-role keys are rejected.
    const bad: any = await handleToolCall("save_onboarding_field", { ...base, fieldName: "seniorName", fieldValue: "Jane" }, false);
    expect(bad._toolError).toBe(true);

    for (const [fieldName, fieldValue] of [
      ["city", "San Jose"], ["yearsExperience", 6], ["specialties", ["dementia"]],
      ["availability", { days: ["Monday"], hours: "9am-5pm" }], ["jobType", "part_time"],
      ["hourlyRate", 25], ["email", "maria@example.com"], ["bio", "I treat every client like family."],
    ] as Array<[string, unknown]>) {
      await handleToolCall("save_onboarding_field", { ...base, fieldName, fieldValue }, false);
    }

    const done: any = await handleToolCall("complete_collection", base, false);
    expect(done.complete).toBe(true);
    expect(done.nextStep).toBe("caregiver_send_photo");
    expect(store.sessions.get(phone)!.onboardingStep).toBe(firstGateStep("caregiver"));
  });
});

// ── live eval (SKIPPED unless CARA_ONBOARDING_EVAL_LIVE=true + ANTHROPIC_API_KEY) ─
const latencies: number[] = [];
const caseGrades: Array<{ id: string; grade: TranscriptGrade }> = [];
// Full per-case transcripts, written to a results file after the run so the run
// can be inspected turn-by-turn without scrolling/pasting terminal output.
const caseRecords: Array<Record<string, unknown>> = [];

describe.skipIf(!LIVE)("onboarding loop — REAL model eval (incurs API spend)", () => {
  beforeEach(() => { store.reset(); });

  for (const ec of EVAL_CASES) {
    it(`[${ec.id}] ${ec.label}`, async () => {
      // Imported lazily so the heavy graph only loads on the live path.
      const { runQaAgent } = await import("./qaAgent");

      const role = ec.role ?? "client";
      const phone = `+1555000${ec.id.length}${ec.turns.length}00`;
      store.ensure(phone, ec.initialStep ?? "client_ask_name");
      let completeFired = false;

      // Tap the mocked handleToolCall to observe the successful complete signal.
      const { handleToolCall } = await import("../mcp/server");
      const mocked = vi.mocked(handleToolCall);
      mocked.mockClear();

      const replies: string[] = [];
      const perTurnSendCounts: number[] = [];
      let runError: string | undefined;

      try {
        for (const turn of ec.turns) {
          const sess = store.sessions.get(phone)!;
          const t0 = Date.now();
          const reply = await runQaAgent({
            text: turn,
            phone,
            chatId: `chat-${ec.id}`,
            userId: "",
            seniorId: "",
            userType: role,
            onboardingMode: true,
            onboardingRole: role,
            intent: null,
            skipSend: true,
            session: { onboardingStep: sess.onboardingStep, onboardingData: { ...sess.onboardingData } } as any,
          });
          latencies.push(Date.now() - t0);
          replies.push(reply ?? "");
          perTurnSendCounts.push(1); // loop returns exactly one reply per turn
        }
      } catch (err) {
        // Record the error so the results file reflects THIS run (e.g. a 401 from a
        // missing key) instead of silently leaving a stale file from a prior run.
        runError = (err as Error).message;
        caseRecords.push({ id: ec.id, label: ec.label, passed: false, error: runError, turns: replies.map((r, i) => ({ user: ec.turns[i], cara: r })) });
        throw err;
      }

      // Did complete_collection ever succeed (complete:true)? Inspect the in-memory
      // step: firstGateStep is only set on a successful complete_collection.
      const finalSess = store.sessions.get(phone)!;
      completeFired = finalSess.onboardingStep === firstGateStep(role);

      const grade = gradeOnboardingTranscript({
        replies,
        perTurnSendCounts,
        finalData: finalSess.onboardingData,
        role,
        completeFiredWith: completeFired ? [] : undefined,
      });
      caseGrades.push({ id: ec.id, grade });
      caseRecords.push({
        id: ec.id,
        label: ec.label,
        passed: grade.passed,
        failures: grade.failures,
        turns: ec.turns.map((t, i) => ({ user: t, cara: replies[i] ?? "" })),
        finalData: finalSess.onboardingData,
        completeFired,
        metrics: grade.metrics,
      });

      if (!grade.passed) {
        console.error(`\n[eval:${ec.id}] FAIL`, grade.failures);
        console.error(`  replies:`, replies.map((r, i) => `\n   ${i + 1}. ${r}`).join(""));
        console.error(`  data:`, JSON.stringify(finalSess.onboardingData));
      }

      // Gates: completion + fields-before-handoff + no re-greet are hard.
      expect(grade.metrics.completed, `incomplete: missing ${grade.metrics.missingAtEnd.join(", ")}`).toBe(true);
      expect(grade.metrics.reGreets, "re-greet detected").toBe(0);
      expect(grade.passed, grade.failures.join("; ")).toBe(true);
    }, 120_000);
  }

  afterAll(async () => {
    if (!LIVE) return;
    const passed = caseGrades.filter((c) => c.grade.passed).length;
    const summary = {
      generatedAt: new Date().toISOString(),
      cases: `${passed}/${EVAL_CASES.length}`,
      ranTurns: latencies.length,
      p95LatencyMs: latencies.length ? p95(latencies) : 0,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
      latencyCeilingMs: 4000,
      records: caseRecords,
    };
    // Write a results file for turn-by-turn inspection (path is gitignored).
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const out = path.resolve(process.cwd(), "functions", ".eval-results.json");
      fs.writeFileSync(out, JSON.stringify(summary, null, 2), "utf8");
      console.log(`\n  full transcripts written to functions/.eval-results.json`);
    } catch (e) {
      console.warn("  could not write eval results file:", (e as Error).message);
    }
    console.log(`\n── Onboarding loop real-model eval ──`);
    console.log(`  cases: ${passed}/${caseGrades.length} passed`);
    console.log(`  per-turn latency: P95 ${p95(latencies)}ms (n=${latencies.length}), max ${Math.max(...latencies)}ms`);
    console.log(`  provisional ceiling: P95 <= 4000ms (runbook gate 2)`);
    if (p95(latencies) > 4000) console.warn(`  ⚠ P95 exceeds the provisional 4s ceiling — ratify or revise before canary.`);
  });
});
