import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Integration harness for the onboarding-mode agent loop ────────────────────
//
// Drives runQaAgent({ onboardingMode: true, onboardingRole: "client" }) with a
// MOCKED Claude client so the tool-use loop executes a scripted sequence:
//   save_onboarding_field × N → complete_collection → final end_turn text.
//
// Mock surface is the qaAgent.test.ts block EXTENDED so the loop actually runs:
//   - firebase-admin: a fully chainable firestore stub (the pure-fn test could
//     get away with `collection: () => ({})`; the loop reads/writes Firestore).
//   - ../mcp/server: MCP_TOOLS now carries the 3 onboarding tool defs so the
//     loop's `MCP_TOOLS.filter(isOnboardingTool)` yields a non-empty surface.
//   - ../utils/claudeRetry.callClaudeWithRetry: scripted per-test via a queue.
//   - ../linq/client: sendMessage captured to assert single-reply / no re-greet.
//   - ./caraAgent.buildClickableMessage: sendSplit calls it.
//   - ./contextManagement: the loop uses patch/truncate helpers too.
//   - ./pendingActions.getLatestPending: null so complete_task `done` is allowed.
//
// The real onboardingContract / onboardingDirective / toolCapabilities modules
// load unmocked so tool routing/filtering and the directive are exercised for real.

// ── chainable firestore stub ──────────────────────────────────────────────────
// Every read returns an empty-but-shaped snapshot; every write resolves. Made
// permissive so no prelude/stuck-net read throws.
function makeDocSnap(data: Record<string, unknown> = {}) {
  return { exists: true, data: () => data };
}
function makeQuerySnap() {
  return { empty: true, docs: [] as any[] };
}
function makeChain(): any {
  const chain: any = {
    collection: () => makeChain(),
    doc: () => makeChain(),
    where: () => makeChain(),
    orderBy: () => makeChain(),
    limit: () => makeChain(),
    get: async () => {
      // Ambiguous: callers use either .data()/.exists (doc) or .docs/.empty
      // (query). Return an object satisfying both shapes. `ref` lets a doc-snap
      // caller (e.g. getPrefetchedContext's snap.ref.delete()) chain back into
      // this same permissive stub instead of throwing on undefined.
      return { ...makeDocSnap({}), ...makeQuerySnap(), ref: chain };
    },
    set: async () => {},
    update: async () => {},
    add: async () => ({ id: "mock-id" }),
    delete: async () => {},
  };
  return chain;
}
function makeFirestore(): any {
  const fs: any = () => fs;
  fs.collection = () => makeChain();
  fs.batch = () => ({ set: () => {}, update: () => {}, commit: async () => {} });
  return fs;
}

vi.mock("firebase-admin", () => {
  const FieldValue = { delete: () => "__delete__", serverTimestamp: () => "__ts__" };
  const firestoreFn: any = () => makeFirestore();
  firestoreFn.FieldValue = FieldValue;
  return {
    __esModule: true,
    default: {
      apps: [],
      initializeApp: () => ({}),
      firestore: firestoreFn,
    },
    apps: [],
    initializeApp: () => ({}),
    firestore: firestoreFn,
  };
});

vi.mock("../utils/claudeClient",   () => ({ getSharedClient: () => ({}) }));
vi.mock("../utils/openaiClient",   () => ({ quickComplete: vi.fn(), getOpenAIClient: () => ({}) }));
vi.mock("../utils/claudeRetry",    () => ({ callClaudeWithRetry: vi.fn() }));
vi.mock("../safety/supervisor",    () => ({ supervise: (msg: string) => Promise.resolve(msg) }));
vi.mock("../safety/linter",        () => ({ lintMessage: (msg: string) => msg }));

// EXTENDED vs qaAgent.test.ts: MCP_TOOLS carries the onboarding tool defs so the
// loop's onboarding filter yields a non-empty surface, and handleToolCall is a
// controllable spy.
vi.mock("../mcp/server", () => ({
  MCP_TOOLS: [
    { name: "save_onboarding_field", description: "save a field", input_schema: { type: "object", properties: {} } },
    { name: "complete_collection",   description: "finish collection", input_schema: { type: "object", properties: {} } },
    { name: "complete_task",         description: "end the turn", input_schema: { type: "object", properties: {} } },
    // a non-onboarding tool, present to prove isOnboardingTool() filters it out
    { name: "find_caregivers",       description: "noise", input_schema: { type: "object", properties: {} } },
  ],
  CAREGIVER_TOOLS: [],
  CLIENT_TOOLS: [],
  handleToolCall: vi.fn(),
  handleToolCallForCaregiver: vi.fn(),
}));

vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
const getMemoryContext      = vi.fn(async () => "");
const initializeMemoryFiles = vi.fn(async () => undefined);
vi.mock("../memory/memoryFiles",   () => ({
  getMemoryContext:      (...a: any[]) => getMemoryContext(...a),
  initializeMemoryFiles: (...a: any[]) => initializeMemoryFiles(...a),
}));
vi.mock("../memory/learnedFacts",  () => ({ getRelevantFacts: vi.fn(() => Promise.resolve([])), detectAndApplyCorrection: vi.fn() }));
vi.mock("../memory/preferences",   () => ({ getPreferences: vi.fn(() => Promise.resolve(null)), isInDND: () => false }));

// linq client — capture sendMessage to assert single-reply / no double-send.
// Each returns a resolved promise so the loop's `.catch(...)` chains (startTyping,
// the outer-catch sendMessage) don't throw on an undefined return.
vi.mock("../linq/client", () => ({
  sendMessage: vi.fn(() => Promise.resolve()),
  startTyping: vi.fn(() => Promise.resolve()),
  stopTyping:  vi.fn(() => Promise.resolve()),
}));

// caraAgent.buildClickableMessage is called inside sendSplit.
vi.mock("./caraAgent", () => ({ buildClickableMessage: (s: string) => s }));

vi.mock("./executionAgent",        () => ({ getActiveAgentForUser: vi.fn(() => Promise.resolve(null)) }));

// contextManagement: the loop needs patch/truncate (no-op) in addition to the
// two the pure-fn test stubbed. HISTORY_WINDOW is a plain constant read directly
// by getConversationHistory's .limit(HISTORY_WINDOW + 1) — must mirror the real
// module's value or that call throws on an undefined mock export.
vi.mock("./contextManagement", () => ({
  HISTORY_WINDOW:         24,
  maybeRollUpHistory:     vi.fn(() => Promise.resolve()),
  buildToolResultContent: vi.fn(async (_uid: string, _name: string, result: unknown) => JSON.stringify(result)),
  patchDanglingToolCalls: vi.fn(() => 0),
  truncateOldToolCallArgs: vi.fn(() => 0),
}));

// pendingActions: null so the complete_task `done` path is allowed.
vi.mock("./pendingActions", () => ({ getLatestPending: vi.fn(() => Promise.resolve(null)) }));

import { runQaAgent } from "./qaAgent";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import { handleToolCall } from "../mcp/server";
import { sendMessage } from "../linq/client";

const mockedClaude = vi.mocked(callClaudeWithRetry);
const mockedHandle = vi.mocked(handleToolCall);
const mockedSend   = vi.mocked(sendMessage);

// ── scripted Anthropic.Message factories ──────────────────────────────────────
let toolUseSeq = 0;
function toolUseMsg(name: string, input: Record<string, unknown>) {
  toolUseSeq += 1;
  return {
    id: `msg_${toolUseSeq}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: `toolu_${toolUseSeq}`, name, input }],
  } as any;
}
function textMsg(text: string) {
  return {
    id: "msg_final",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text }],
  } as any;
}

// Drive callClaudeWithRetry from a queue (shift per call).
function scriptClaude(queue: any[]) {
  mockedClaude.mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error("scriptClaude: queue exhausted — loop called the model more times than scripted");
    return next;
  });
}

const baseParams = {
  phone:    "+15551230000",
  chatId:   "chat-1",
  userId:   "",      // no account yet during onboarding
  seniorId: "",
  userType: "client" as const,
  onboardingMode: true,
  onboardingRole: "client" as const,
  session: { onboardingStep: "client_ask_name", onboardingData: {} as Record<string, unknown> },
};

beforeEach(() => {
  vi.clearAllMocks();
  toolUseSeq = 0;
});

describe("runQaAgent onboarding mode — happy path (client)", () => {
  it("saves every scripted field, then calls complete_collection, then returns the final text (skipSend)", async () => {
    // handleToolCall contract: save → {ok:true,...}; complete_collection → {ok:true,complete:true}
    mockedHandle.mockImplementation(async (name: string) => {
      if (name === "save_onboarding_field") return { ok: true, saved: true, missing: [], collectionComplete: false } as any;
      if (name === "complete_collection")   return { ok: true, complete: true, nextStep: "client_ask_start", status: "collection_complete" } as any;
      return { ok: true } as any;
    });

    scriptClaude([
      toolUseMsg("save_onboarding_field", { fieldName: "firstName",  fieldValue: "Imran" }),
      toolUseMsg("save_onboarding_field", { fieldName: "seniorName", fieldValue: "Mom"   }),
      toolUseMsg("complete_collection",   {}),
      textMsg("Perfect — I've got everything I need. I'll set up your account next."),
    ]);

    const reply = await runQaAgent({ ...baseParams, text: "Hi, I'm Imran and it's for my Mom", skipSend: true });

    expect(reply).toBe("Perfect — I've got everything I need. I'll set up your account next.");

    // 1) Fields saved BEFORE handoff, in order: two saves then complete_collection.
    const callNames = mockedHandle.mock.calls.map((c) => c[0]);
    expect(callNames).toEqual([
      "save_onboarding_field",
      "save_onboarding_field",
      "complete_collection",
    ]);

    // The save calls carried the scripted field names in order.
    const savedFields = mockedHandle.mock.calls
      .filter((c) => c[0] === "save_onboarding_field")
      .map((c) => (c[1] as Record<string, unknown>).fieldName);
    expect(savedFields).toEqual(["firstName", "seniorName"]);
  });

  it("injects role:\"client\" into the enriched input of every onboarding tool call", async () => {
    mockedHandle.mockImplementation(async (name: string) => {
      if (name === "save_onboarding_field") return { ok: true, saved: true, missing: [] } as any;
      if (name === "complete_collection")   return { ok: true, complete: true } as any;
      return { ok: true } as any;
    });

    scriptClaude([
      toolUseMsg("save_onboarding_field", { fieldName: "firstName", fieldValue: "Imran" }),
      toolUseMsg("complete_collection", {}),
      textMsg("All set."),
    ]);

    await runQaAgent({ ...baseParams, text: "I'm Imran", skipSend: true });

    // Role injected authoritatively into the enriched input for each onboarding call.
    for (const call of mockedHandle.mock.calls) {
      const enriched = call[1] as Record<string, unknown>;
      expect(enriched.role).toBe("client");
      expect(enriched.phone).toBe(baseParams.phone);
    }
  });

  it("only offers onboarding tools to the model (filters non-onboarding tools out)", async () => {
    mockedHandle.mockResolvedValue({ ok: true, complete: true } as any);
    scriptClaude([
      toolUseMsg("complete_collection", {}),
      textMsg("Done."),
    ]);

    await runQaAgent({ ...baseParams, text: "go", skipSend: true });

    const firstCallArgs = mockedClaude.mock.calls[0][1] as { tools: Array<{ name: string }> };
    const toolNames = firstCallArgs.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["complete_collection", "complete_task", "save_onboarding_field"]);
    expect(toolNames).not.toContain("find_caregivers");
  });

  it("delivers the final reply exactly once via sendMessage when skipSend is not set", async () => {
    mockedHandle.mockImplementation(async (name: string) => {
      if (name === "save_onboarding_field") return { ok: true, saved: true, missing: [] } as any;
      if (name === "complete_collection")   return { ok: true, complete: true } as any;
      return { ok: true } as any;
    });

    scriptClaude([
      toolUseMsg("save_onboarding_field", { fieldName: "firstName", fieldValue: "Imran" }),
      toolUseMsg("complete_collection", {}),
      textMsg("Great — that's everything for now."),
    ]);

    const reply = await runQaAgent({ ...baseParams, text: "I'm Imran" /* no skipSend */ });

    expect(reply).toBe("Great — that's everything for now.");
    // Single user-facing reply, no double-send. The final text is short (<300
    // chars) so sendSplit emits exactly one chunk.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][1]).toBe("Great — that's everything for now.");
  });
});

describe("runQaAgent onboarding mode — complete_collection missing-fields branch", () => {
  it("continues the loop (re-calls the model) when complete_collection reports missing fields", async () => {
    // First complete_collection returns complete:false + a missing list; after
    // the model saves the missing field, the second returns complete:true.
    let completeCalls = 0;
    mockedHandle.mockImplementation(async (name: string) => {
      if (name === "save_onboarding_field") {
        return { ok: true, saved: true } as any;
      }
      if (name === "complete_collection") {
        completeCalls += 1;
        if (completeCalls === 1) {
          return {
            ok: true,
            complete: false,
            missing: ["seniorName"],
            guidance: "Not done yet — call save_onboarding_field for seniorName, then complete_collection again.",
          } as any;
        }
        return { ok: true, complete: true, nextStep: "client_ask_start" } as any;
      }
      return { ok: true } as any;
    });

    scriptClaude([
      toolUseMsg("save_onboarding_field", { fieldName: "firstName", fieldValue: "Imran" }),
      toolUseMsg("complete_collection", {}),                                  // → complete:false, missing seniorName
      toolUseMsg("save_onboarding_field", { fieldName: "seniorName", fieldValue: "Mom" }), // model reacts to the missing list
      toolUseMsg("complete_collection", {}),                                  // → complete:true
      textMsg("Got it all — thanks!"),
    ]);

    const reply = await runQaAgent({ ...baseParams, text: "I'm Imran", skipSend: true });

    expect(reply).toBe("Got it all — thanks!");

    // The loop did NOT end on the first complete_collection — it fed the result
    // back, the model saved the missing field, then completion succeeded.
    const callNames = mockedHandle.mock.calls.map((c) => c[0]);
    expect(callNames).toEqual([
      "save_onboarding_field",   // firstName
      "complete_collection",     // complete:false
      "save_onboarding_field",   // seniorName (recovered from missing list)
      "complete_collection",     // complete:true
    ]);
    expect(completeCalls).toBe(2);

    // The model was re-invoked after the incomplete signal (5 scripted msgs consumed).
    expect(mockedClaude).toHaveBeenCalledTimes(5);
  });
});

// U6: memory-file init failure must be LOUD (console.error, with phone context)
// rather than the previous silent console.warn — a silent miss here means the
// lazy re-bootstrap keeps retrying every turn with nobody paged. This path is
// the general (non-onboarding-mode) lazy bootstrap in runQaAgent: onboarding-mode
// turns short-circuit memoryContext to "" via unconfirmedIdentity and never reach
// it, so this exercises the branch directly with an account already present
// (userId set, onboardingMode omitted) and empty memory context.
describe("memory-file init failure logging (U6)", () => {
  it("initializeMemoryFiles rejecting is logged via console.error with phone context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getMemoryContext.mockResolvedValueOnce("");
    initializeMemoryFiles.mockRejectedValueOnce(new Error("storage bucket unavailable"));
    mockedHandle.mockResolvedValue({ ok: true } as any);
    scriptClaude([textMsg("Hi there!")]);

    await runQaAgent({
      ...baseParams,
      onboardingMode: false,
      onboardingRole: undefined,
      userId: "uid-123",
      session: { onboardingData: { seniorName: "Dorothy" } },
      text: "hello",
      skipSend: true,
    });

    // Fire-and-forget — allow the microtask queue to flush the rejection handler.
    await new Promise((r) => setTimeout(r, 0));

    expect(initializeMemoryFiles).toHaveBeenCalled();
    const errorCall = errorSpy.mock.calls.find((c) => c[0] === "qaAgent: lazy initializeMemoryFiles failed");
    expect(errorCall).toBeTruthy();
    expect(errorCall?.[1]).toMatchObject({ phone: baseParams.phone, userId: "uid-123" });

    errorSpy.mockRestore();
  });
});
