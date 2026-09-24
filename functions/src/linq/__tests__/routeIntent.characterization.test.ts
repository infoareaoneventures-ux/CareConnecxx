// U9 / KTD3 — CHARACTERIZATION TESTS for the CODED client intent router.
//
// Locks in the current behavior of `routeIntentAndRespond` (routeIntent.ts) for
// the coded client-side state machines — the safety net that proves any
// migration to agent-composed tool flows preserves behavior. Production
// routing is NOT changed here. (The family add / remove flows these tests
// originally pinned were removed with the family-group feature, 2026-09-23.)
//
// Mock style follows routeClient.test.ts / caregiverReferral.test.ts: in-memory
// Firestore, every collaborator stubbed, dynamic `handleToolCall` mocked so the
// real MCP server (heavy) is never loaded.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { TurnPersistenceOutcome } from "../../memory/conversationMemory";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const collDocs = (collPath: string) => {
    const prefix = collPath + "/";
    const out: Array<{ id: string; data: any }> = [];
    for (const [path, data] of docState) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes("/")) out.push({ id: rest, data });
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), id: path.split("/").pop(), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    },
    delete: async () => { docState.delete(path); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; op: string; val: any }> = [];
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
      }
      return {
        empty: items.length === 0,
        docs: items.map((it) => ({ id: it.id, data: () => it.data, ref: makeDocRef(`${collPath}/${it.id}`) })),
      };
    };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const runTransaction = async (fn: (t: any) => Promise<void>) => fn({
    get: (refOrQuery: any) => refOrQuery.get(),
    set: (ref: any, data: any) => { ref.set(data); },
    update: (ref: any, data: any) => { ref.update(data); },
  });

  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });

  return { docState, firestoreFn, reset: () => { docState.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
  getOrCreateSession: vi.fn(async (p: string) => ({ chatId: `chat-${p}`, phone: p })),
  AgentSession: {},
}));

// The intent classifier is the only thing deciding which branch fires. Stub it
// per-test so we drive a specific coded branch deterministically.
const classifyIntentDetailed = vi.fn(async () => ({ intent: "QUESTION", degraded: false }));
vi.mock("../../agents/intentClassifier", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classifyIntentDetailed: (...a: any[]) => (classifyIntentDetailed as Function).apply(null, a),
  // Real (pure, no side effects) implementation — routeIntent.ts's
  // FIND_CAREGIVER branch calls this directly as a safety net.
  isCaregiverSearchMisroutedAsProviderSearch: (intent: string, text: string) =>
    intent === "FIND_NEARBY_PROVIDER" && /\bcaregivers?\b/i.test(text),
}));

// `handleToolCall` is dynamically imported by several router branches.
// Mock the whole mcp/server module so the real (heavy) registry never loads.
const handleToolCall = vi.fn(async () => ({ success: true }));
vi.mock("../../mcp/server", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleToolCall: (...a: any[]) => (handleToolCall as Function).apply(null, a),
}));

// Matching is re-run from several router branches; stub it so the test
// only asserts on the recovery copy + alert, not the matching internals.
const presentCaregiverSearch = vi.fn(async (..._a: any[]) => ({ status: "shown", total: 1, shown: [], offset: 0, hasMore: false }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: (...a: any[]) => (presentCaregiverSearch as Function).apply(null, a),
}));

const quickComplete = vi.fn(async () => "");
vi.mock("../../utils/openaiClient", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quickComplete: (...a: any[]) => (quickComplete as Function).apply(null, a),
}));

// qaAgent — controllable so the U3b default-tail tests can drive full/quick
// paths; defaults (empty reply, non-trivial) keep the older tests' behavior.
const runQaAgent = vi.fn(async (..._a: any[]): Promise<string> => "");
const runQuickReply = vi.fn(async (..._a: any[]): Promise<string> => "");
const isTrivialQuickReply = vi.fn((..._a: any[]) => false);
vi.mock("../../agents/qaAgent", () => ({
  runQaAgent: (...a: any[]) => (runQaAgent as Function).apply(null, a),
  runQuickReply: (...a: any[]) => (runQuickReply as Function).apply(null, a),
  isTrivialQuickReply: (...a: any[]) => (isTrivialQuickReply as Function).apply(null, a),
}));

// U3b — the ONE completed-turn memory boundary (dynamically imported by the
// default QA/quick tail) plus the legacy learnedFacts module (only the
// FACT_CORRECTION branch may still import it — never the default tail).
const persistCompletedTurn = vi.fn(async (..._a: any[]): Promise<TurnPersistenceOutcome> =>
  ({ ok: true as const, operationId: "op-1", sourceTurnKeyHash: "hash-1", deduplicated: false }));
vi.mock("../../memory/conversationMemory", () => ({
  persistCompletedTurn: (...a: any[]) => (persistCompletedTurn as Function).apply(null, a),
}));
const extractAndStoreFacts = vi.fn(async (..._a: any[]) => {});
vi.mock("../../memory/learnedFacts", () => ({
  extractAndStoreFacts: (...a: any[]) => (extractAndStoreFacts as Function).apply(null, a),
  detectAndStageFactChange: vi.fn(async () => ({ kind: "not_correction" })),
  factChangeAckCopy: vi.fn(() => null),
  findTombstonedRestatement: vi.fn(async () => null),
  classifyReRememberReply: vi.fn(async () => "other"),
  confirmReRemember: vi.fn(async () => ({ ok: false, reason: "not_found" })),
}));
vi.mock("../../agents/permissionsConversation", () => ({
  updatePermissionFromText: vi.fn(async () => true),
}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../agents/jobPostingFlow", () => ({ startJobPostingFlow: vi.fn(async () => {}) }));
const startRescheduleFlow = vi.fn(async (..._a: any[]) => ({ started: true }));
vi.mock("../../agents/rescheduleFlow", () => ({ startRescheduleFlow: (...a: any[]) => (startRescheduleFlow as Function).apply(null, a) }));
const startReplacementFlow = vi.fn(async (..._a: any[]) => ({ started: true }));
const findResendableBookingRequests = vi.fn(async (..._a: any[]): Promise<any[]> => []);
const startResendBookingFlow = vi.fn(async (..._a: any[]) => ({ started: true }));
const startBookingFlow = vi.fn(async (..._a: any[]) => ({ started: true }));
const startCancelFlow = vi.fn(async (..._a: any[]) => ({ started: true }));
vi.mock("../../agents/cancelFlow", () => ({ startCancelFlow: (...a: any[]) => (startCancelFlow as Function).apply(null, a) }));
vi.mock("../../agents/bookingFlow", () => ({
  findResendableBookingRequests: (...a: any[]) => (findResendableBookingRequests as Function).apply(null, a),
  startResendBookingFlow: (...a: any[]) => (startResendBookingFlow as Function).apply(null, a),
  startBookingFlow: (...a: any[]) => (startBookingFlow as Function).apply(null, a),
}));
vi.mock("../../agents/replacementFlow", () => ({ startReplacementFlow: (...a: any[]) => (startReplacementFlow as Function).apply(null, a) }));
vi.mock("../../agents/earningsHandler", () => ({ handleEarningsView: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverSwapHandler", () => ({ handleCaregiverSwapRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({
  handleCaregiverProfileUpdate: vi.fn(async () => {}),
  profileFieldFromIntent: vi.fn(() => null),
}));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../triggers/jobNotifications", () => ({ handleJobResponse: vi.fn(async () => {}) }));
vi.mock("../../memory/zepClient", () => ({
  addUserMessageToZep: vi.fn(async () => {}), addAssistantMessageToZep: vi.fn(async () => {}),
  searchZepMemory: vi.fn(async () => ""), getZepUserId: (p: string) => `zep-${p}`,
}));

import { routeIntentAndRespond } from "../routeIntent";

const PHONE = "+15553334444";
const CLIENT_ID = "client-1";
const SENIOR_ID = "senior-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    chatId: "chat1", phone: PHONE, service: "SMS", userType: "client",
    userId: CLIENT_ID, seniorId: SENIOR_ID, ...sessionPatch,
  });
}

function ctx(text: string) {
  return {
    phone: PHONE, chatId: "chat1", text,
    norm: text.trim().toUpperCase(),
    session: hoisted.docState.get(`agent_sessions/${PHONE}`) as any,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
  handleToolCall.mockResolvedValue({ success: true });
  quickComplete.mockResolvedValue("");
  sendMessage.mockResolvedValue({ message_id: "m1" });
  presentCaregiverSearch.mockReset().mockResolvedValue({ status: "shown", total: 1, shown: [], offset: 0, hasMore: false });
  runQaAgent.mockResolvedValue("");
  runQuickReply.mockResolvedValue("");
  isTrivialQuickReply.mockReturnValue(false);
  persistCompletedTurn.mockResolvedValue({ ok: true, operationId: "op-1", sourceTurnKeyHash: "hash-1", deduplicated: false });
});

// ── REBOOK_REQUEST (2026-09-17): the legacy appointments-based rebook path
// is gone. "Resend the booking" / "book her again" now goes where the site's
// own buttons go — Resend (a declined/cancelled request) first, else Re-book
// via the booking flow.
describe("REBOOK_REQUEST routes to the site's Resend / Re-book", () => {
  it("with a resendable request → startResendBookingFlow, never the agent", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "REBOOK_REQUEST", degraded: false });
    findResendableBookingRequests.mockResolvedValueOnce([{ id: "br-cancelled", caregiverId: "cg1", caregiverName: "Basra", statusLabel: "Visit cancelled" }]);

    await routeIntentAndRespond(ctx("can you resend the booking"));

    expect(startResendBookingFlow).toHaveBeenCalledOnce();
    expect(startBookingFlow).not.toHaveBeenCalled();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("with nothing to resend → the booking flow (the site's Re-book / Send Booking)", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "REBOOK_REQUEST", degraded: false });
    findResendableBookingRequests.mockResolvedValueOnce([]);

    await routeIntentAndRespond(ctx("book Basra again"));

    expect(startResendBookingFlow).not.toHaveBeenCalled();
    expect(startBookingFlow).toHaveBeenCalledOnce();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

// ── U3b (memory-grounding plan 2026-07-17-002, R8-R10): the default QA/quick
// tail persists completed turns through ONE boundary — persistCompletedTurn.
// The old direct addUserMessageToZep / addAssistantMessageToZep /
// extractAndStoreFacts tail is gone; behavior + source-scan tests below are
// the plan's "one owner" exit criterion.
describe("U3b — default QA/quick tail persists through persistCompletedTurn", () => {
  it("full agent path: ONE persistCompletedTurn call carrying the Linq eventId, client extraction ON", async () => {
    seed();
    runQaAgent.mockResolvedValue("Here's the answer.");

    await routeIntentAndRespond({ ...ctx("how is mom doing today"), eventId: "evt-123" });

    expect(runQaAgent).toHaveBeenCalledOnce();
    expect(persistCompletedTurn).toHaveBeenCalledOnce();
    expect(persistCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      channel:       "linq",
      sourceKey:     "evt-123",
      phone:         PHONE,
      userId:        CLIENT_ID,
      userText:      "how is mom doing today",
      assistantText: "Here's the answer.",
      extractFacts:  true,
      adoptExistingRows: true,
    }));
    // The superseded direct tail is really gone.
    expect(extractAndStoreFacts).not.toHaveBeenCalled();
  });

  it("quick-reply path: same boundary, same key — and the full agent never runs", async () => {
    seed();
    isTrivialQuickReply.mockReturnValue(true);
    runQuickReply.mockResolvedValue("Hey! All good here.");

    await routeIntentAndRespond({ ...ctx("thanks"), eventId: "evt-9" });

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(persistCompletedTurn).toHaveBeenCalledOnce();
    expect(persistCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      channel: "linq", sourceKey: "evt-9",
      userText: "thanks", assistantText: "Hey! All good here.",
      extractFacts: true, adoptExistingRows: true,
    }));
  });

  it("caregiver turn: transcript persistence still happens but family-fact extraction is OFF (R8)", async () => {
    seed({ userType: "caregiver", caregiverId: "cg-1" });
    runQaAgent.mockResolvedValue("Your next shift is Friday.");

    await routeIntentAndRespond({ ...ctx("when is my next shift"), eventId: "evt-cg" });

    expect(persistCompletedTurn).toHaveBeenCalledOnce();
    expect(persistCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      sourceKey: "evt-cg", extractFacts: false,
    }));
  });

  it("a persistence failure is swallowed as a typed outcome — the turn does not throw or re-drive (R8)", async () => {
    seed();
    runQaAgent.mockResolvedValue("Answer already delivered.");
    persistCompletedTurn.mockResolvedValue({ ok: false, errorClass: "FirebaseError" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(routeIntentAndRespond({ ...ctx("how is mom"), eventId: "evt-fail" }))
        .resolves.toBeUndefined();
      expect(runQaAgent).toHaveBeenCalledOnce(); // never re-driven
      // R21: aggregate log only — error class + channel, no content, no phone.
      const serialized = JSON.stringify(warnSpy.mock.calls);
      expect(serialized).toContain("memory_turn_persistence_skipped");
      expect(serialized).not.toContain(PHONE);
      expect(serialized).not.toContain("how is mom");
      expect(serialized).not.toContain("Answer already delivered.");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("even a throwing persistence boundary cannot fail the turn (belt-and-suspenders)", async () => {
    seed();
    runQaAgent.mockResolvedValue("Answer.");
    persistCompletedTurn.mockRejectedValue(new Error("unexpected"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(routeIntentAndRespond({ ...ctx("hi there mom question"), eventId: "e" }))
        .resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an empty agent reply (held/DND/skipped turn) is NOT persisted — the agent layer's judgment is authoritative", async () => {
    seed();
    runQaAgent.mockResolvedValue("");

    await routeIntentAndRespond({ ...ctx("how is mom"), eventId: "evt-empty" });

    expect(persistCompletedTurn).not.toHaveBeenCalled();
  });

  it("a missing eventId still persists but with an empty source key (typed missing_source_key downstream, no idempotency promise)", async () => {
    seed();
    runQaAgent.mockResolvedValue("Answer.");
    persistCompletedTurn.mockResolvedValue({ ok: false, errorClass: "missing_source_key" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await routeIntentAndRespond(ctx("how is mom"));
      expect(persistCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: "" }));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── U3b source scan — the plan's "one owner" exit criterion ──────────────────
// Counts every PRODUCTION call site of the direct memory writers across
// functions/src. After U3b the inventory is closed:
//   • webhooks.ts keeps exactly ONE addUserMessageToZep — the pre-completion
//     ONBOARDING write (R10: preserved).
//   • memoryOperationWorker.ts is the only caller of the strict Zep adapters
//     and of extractAndStoreFacts for completed turns.
//   • caraAgent.ts keeps its ONE legacy memory-agent extractAndStoreFacts
//     (an agent-payload channel, not the default QA/quick tail — out of U3b
//     scope, documented here so any new call site fails this test).
//   • routeIntent.ts has ZERO direct writers — the default tail is owned by
//     persistCompletedTurn.
describe("U3b source scan — one owner for completed-turn memory", () => {
  const SRC_ROOT = path.resolve(__dirname, "../..");

  // Definition modules (the functions are declared/wrapped here, so the name
  // followed by "(" appears without being a production call site).
  const DEFINITION_FILES = new Set(["memory/zepClient.ts", "memory/learnedFacts.ts"]);

  const PATTERNS = {
    userZep:      /\baddUserMessageToZep(?:Strict|BestEffort)?\s*\(/g,
    assistantZep: /\baddAssistantMessageToZep(?:Strict|BestEffort)?\s*\(/g,
    extractFacts: /\bextractAndStoreFacts\s*\(/g,
  } as const;

  function listProductionSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        out.push(...listProductionSources(full));
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  function inventory(): Record<string, { userZep: number; assistantZep: number; extractFacts: number }> {
    const counts: Record<string, { userZep: number; assistantZep: number; extractFacts: number }> = {};
    for (const file of listProductionSources(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (DEFINITION_FILES.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      const row = {
        userZep:      [...src.matchAll(PATTERNS.userZep)].length,
        assistantZep: [...src.matchAll(PATTERNS.assistantZep)].length,
        extractFacts: [...src.matchAll(PATTERNS.extractFacts)].length,
      };
      if (row.userZep + row.assistantZep + row.extractFacts > 0) counts[rel] = row;
    }
    return counts;
  }

  it("the production call-site inventory is exactly the allowed set — routeIntent's tail is gone, onboarding remains", () => {
    expect(inventory()).toEqual({
      // Pre-completion onboarding Zep write (R10: preserved).
      "linq/webhooks.ts": { userZep: 1, assistantZep: 0, extractFacts: 0 },
      // The retry worker — the ONE dispatcher for completed-turn memory.
      "scheduled/memoryOperationWorker.ts": { userZep: 1, assistantZep: 1, extractFacts: 1 },
      // (caraAgent.ts's legacy agent-payload memory channel went with the unused
      // interaction/execution agent pair, 2026-09-17.)
    });
  });

  it("routeIntent.ts no longer imports or calls the direct memory writers", () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, "linq/routeIntent.ts"), "utf8");
    // Call sites (name followed by "(") — a comment naming the removed tail is fine.
    expect([...src.matchAll(PATTERNS.userZep)]).toHaveLength(0);
    expect([...src.matchAll(PATTERNS.assistantZep)]).toHaveLength(0);
    expect([...src.matchAll(PATTERNS.extractFacts)]).toHaveLength(0);
    // No import bindings for the writers either.
    expect(src).not.toMatch(/import[^;]*\baddUserMessageToZep\b/);
    expect(src).not.toMatch(/import[^;]*\baddAssistantMessageToZep\b/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bextractAndStoreFacts\b/);
    // …because the shared boundary owns the tail now.
    expect(src).toContain("persistCompletedTurn");
  });

  it("webhooks.ts keeps the onboarding Zep write on the pre-completion path only", () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, "linq/webhooks.ts"), "utf8");
    // The single call site sits under the `step && step !== "complete"` branch
    // and uses the onboarding thread variable — pin its shape.
    expect(src).toContain("onboardingZepThreadId");
    expect([...src.matchAll(/\baddUserMessageToZep\s*\(/g)]).toHaveLength(1);
  });

  it("web and SMS callers both route completed turns through persistCompletedTurn", () => {
    const webChatSrc = fs.readFileSync(path.join(SRC_ROOT, "linq/webChat.ts"), "utf8");
    const routeSrc = fs.readFileSync(path.join(SRC_ROOT, "linq/routeIntent.ts"), "utf8");
    expect(webChatSrc).toContain("persistCompletedTurn");
    expect(webChatSrc).toContain('channel:       "web"');
    expect(routeSrc).toContain('channel:       "linq"');
    // Both adopt qaAgent's durable pair — rows are written exactly once.
    expect([...webChatSrc.matchAll(/adoptExistingRows: true/g)]).toHaveLength(1);
    expect([...routeSrc.matchAll(/adoptExistingRows: true/g)]).toHaveLength(1);
  });
});

// 2026-09-07 (Hamse decision): a bare-number caregiver selection after a match
// presentation used to short-circuit into handleInterviewSelection
// (interviewAgent.ts) — a caregiver-negotiates-first flow with no website
// equivalent at all, bypassing the shared requestVideoInterview() the site's
// own "Request Interview" modal and schedule_interview both use. Removed:
// a number reply now falls through to normal routing/runQaAgent exactly like
// a name reply already did, so both paths converge on the one flow that
// matches the site.
describe("characterization — caregiver selection after a match list no longer uses the no-site-match flow", () => {
  const pendingMatches = [
    { id: "cg1", name: "Basra Yousuf", rate: 25 },
    { id: "cg2", name: "Imran", rate: 24 },
  ];

  it("a bare number reply falls through to runQaAgent", async () => {
    seed({ pendingMatches, pendingMatchesSetAt: new Date().toISOString() });

    await routeIntentAndRespond(ctx("2"));

    expect(runQaAgent).toHaveBeenCalled();
  });

  it("a caregiver named directly also falls through to runQaAgent (unchanged — same flow as a number reply now)", async () => {
    seed({ pendingMatches, pendingMatchesSetAt: new Date().toISOString() });

    await routeIntentAndRespond(ctx("let's interview Basra"));

    expect(runQaAgent).toHaveBeenCalled();
  });
});

// 2026-09-09 live incident: a fresh re-offer ("want me to send their
// profiles again, or keep looking for someone new?") got its own answer
// ("Can you send me their profiles") misclassified back into FIND_CAREGIVER,
// which blindly re-ran the deterministic search and repeated the identical
// canned question verbatim — the agent (which has resend_caregiver_profile
// and can see pendingMatches) never got a turn. Fixed: FIND_CAREGIVER now
// defers to the agent whenever pendingMatches is still fresh, instead of
// re-running the search on the intent label alone.
describe("FIND_CAREGIVER defers to the agent when pendingMatches is fresh (2026-09-09)", () => {
  const pendingMatches = [
    { id: "cg1", name: "Basra Yousuf", rate: 25 },
    { id: "cg2", name: "Imran", rate: 24 },
  ];

  it("fresh pendingMatches: FIND_CAREGIVER falls through to runQaAgent, not a re-search", async () => {
    seed({ pendingMatches, pendingMatchesSetAt: new Date().toISOString() });
    classifyIntentDetailed.mockResolvedValue({ intent: "FIND_CAREGIVER", degraded: false });

    await routeIntentAndRespond(ctx("Can you send me their profiles"));

    expect(runQaAgent).toHaveBeenCalled();
    expect(presentCaregiverSearch).not.toHaveBeenCalled();
  });

  it("no pendingMatches at all: FIND_CAREGIVER still runs the deterministic search (unchanged for a genuinely new search)", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "FIND_CAREGIVER", degraded: false });

    await routeIntentAndRespond(ctx("How many caregivers in my area"));

    expect(presentCaregiverSearch).toHaveBeenCalledOnce();
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("stale pendingMatches (past the TTL): FIND_CAREGIVER still runs the deterministic search", async () => {
    const staleSetAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago, TTL is 2h
    seed({ pendingMatches, pendingMatchesSetAt: staleSetAt });
    classifyIntentDetailed.mockResolvedValue({ intent: "FIND_CAREGIVER", degraded: false });

    await routeIntentAndRespond(ctx("Any caregivers near me?"));

    expect(presentCaregiverSearch).toHaveBeenCalledOnce();
  });
});

// 2026-09-13 live-testing find: "I would like to book Maria" classified as
// HIRE_CAREGIVER used to get a hardcoded "Who would you like to hire?" no
// matter what — even though the family's own message already named the
// caregiver — and dead-ended right there, never reaching runQaAgent/
// request_booking in that turn. Mirrors the FIND_CAREGIVER fix above: only
// ask the generic question when there's genuinely no caregiver context.
describe("HIRE_CAREGIVER defers to the agent when caregiver context exists (2026-09-13)", () => {
  const pendingMatches = [
    { id: "cg1", name: "Maria", rate: 25 },
  ];

  it("fresh pendingMatches: HIRE_CAREGIVER falls through to runQaAgent instead of re-asking who", async () => {
    seed({ pendingMatches, pendingMatchesSetAt: new Date().toISOString() });
    classifyIntentDetailed.mockResolvedValue({ intent: "HIRE_CAREGIVER", degraded: false });

    await routeIntentAndRespond(ctx("I would like to book Maria"));

    expect(runQaAgent).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Who would you like to hire"));
  });

  it("shownCaregiverIds present (no pendingMatches): HIRE_CAREGIVER still falls through to runQaAgent", async () => {
    seed({ shownCaregiverIds: ["cg1"] });
    classifyIntentDetailed.mockResolvedValue({ intent: "HIRE_CAREGIVER", degraded: false });

    await routeIntentAndRespond(ctx("let's hire her"));

    expect(runQaAgent).toHaveBeenCalled();
  });

});

// 2026-09-09 (live-caught): "cancel it" / "cancel that interview", asked
// right after Evia herself described a pending interview, used to hit a
// context-blind hardcoded "no visits to cancel" dead-end — CANCEL_REQUEST
// assumed "cancel" could only ever mean a confirmed visit. With no confirmed
// appointment to cancel, the turn now hands off to the full agent (which has
// the real conversation context and cancel_interview) instead of dead-ending.
// 2026-09-15 (live-caught): a client RESCHEDULE_REQUEST went to the free-form
// agent, which asserted a visit on a day that had none, then moved the WRONG
// visit. It now starts the scripted rescheduleFlow (the site's Reschedule
// button) with the family's own words, and never touches the agent.
describe("RESCHEDULE_REQUEST (client) starts the scripted reschedule flow (2026-09-15)", () => {
  it("calls startRescheduleFlow with the family's message as initialText and does not run the agent", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "RESCHEDULE_REQUEST", degraded: false });

    await routeIntentAndRespond(ctx("move Wednesday's visit to 9/17 10am to 3pm"));

    expect(startRescheduleFlow).toHaveBeenCalledOnce();
    expect(startRescheduleFlow.mock.calls[0][3]).toEqual({ initialText: "move Wednesday's visit to 9/17 10am to 3pm" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});

// FIND_REPLACEMENT (2026-09-15): "who is available for replacement" used to
// run a general caregiver search via the agent. With exactly one visit
// waiting on a replacement, the scripted replacementFlow starts directly.
describe("FIND_REPLACEMENT (client) routes to the scripted replacement flow", () => {
  it("exactly one needs_replacement visit → startReplacementFlow on that shift, no agent turn", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "FIND_REPLACEMENT", degraded: false });
    hoisted.docState.set("shifts/sh-tue", { clientId: CLIENT_ID, caregiverId: "cg1", status: "needs_replacement", date: "2099-01-01", startTime: "11:00", endTime: "13:00" });

    await routeIntentAndRespond(ctx("who is available for replacement"));

    expect(startReplacementFlow).toHaveBeenCalledOnce();
    expect(startReplacementFlow.mock.calls[0][3]).toEqual({ shiftId: "sh-tue" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("no visit waiting on a replacement → the agent (which has the live data) takes the turn", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "FIND_REPLACEMENT", degraded: false });
    runQaAgent.mockResolvedValue("None of your visits need a replacement right now.");

    await routeIntentAndRespond(ctx("find a replacement"));

    expect(startReplacementFlow).not.toHaveBeenCalled();
    expect(runQaAgent).toHaveBeenCalledOnce();
  });
});

// 2026-09-17: the legacy appointments-based cancel path (a pending-cancel confirm flag
// + YES/NO router branches) is gone. "cancel" — classified or the bare keyword —
// starts the scripted cancelFlow, which reads what the My Bookings page can
// cancel right now and makes the site's own write on YES.
describe("CANCEL_REQUEST starts the scripted cancel flow", () => {
  it("a classified cancel request → startCancelFlow with the family's words, never the agent", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "CANCEL_REQUEST", degraded: false });

    await routeIntentAndRespond(ctx("can you cancel Thursday's visit"));

    expect(startCancelFlow).toHaveBeenCalledOnce();
    expect(startCancelFlow.mock.calls[0][3]).toEqual({ initialText: "can you cancel Thursday's visit" });
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("the bare CANCEL keyword goes to the same flow", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });

    await routeIntentAndRespond(ctx("cancel"));

    expect(startCancelFlow).toHaveBeenCalledOnce();
    expect(runQaAgent).not.toHaveBeenCalled();
  });
});
