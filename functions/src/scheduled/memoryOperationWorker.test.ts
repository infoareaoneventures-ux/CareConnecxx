import { describe, it, expect, vi, beforeEach } from "vitest";

// U3 (memory-grounding hardening 2026-07-17-002, KTD5/KTD6, R8/R9/R21): the
// one-minute memory-operation worker — transactional claim through the shared
// leased-operation engine, per-user SOURCE-TURN ordering, persisted
// deterministic Zep UUID reuse (never re-derived), original turn timestamps as
// Zep createdAt, provider duplicate reconciled as success, idempotent
// learned-fact extraction, memorySyncStatus clearing, deduplicated terminal
// alerts, and aggregate-only logs.
//
// U4b (KTD9/KTD10/KTD16, R13/R14/R23): correction/forget propagation —
// resumable per-target Storage/embeddings/Zep work, source-row consolidation
// exclusion, no-plaintext tombstone finalization (fingerprint key REQUIRED),
// durable audit entry before expiry eligibility, per-store unmasking, and
// reconciliation-flag cleanup.
//
// Mock style mirrors nightlyMemory.test.ts: in-memory Firestore in vi.hoisted,
// state mutated in beforeEach — never a mock returned from it.

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const DELETE_SENTINEL = { __delete: true };

  function applyUpdate(path: string, data: Record<string, unknown>) {
    const current = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (key.includes(".")) {
        const parts = key.split(".");
        let node: Record<string, unknown> = current;
        for (let i = 0; i < parts.length - 1; i++) {
          const next = node[parts[i]];
          node[parts[i]] = typeof next === "object" && next !== null ? { ...(next as object) } : {};
          node = node[parts[i]] as Record<string, unknown>;
        }
        if (value === DELETE_SENTINEL) delete node[parts[parts.length - 1]];
        else node[parts[parts.length - 1]] = value;
      } else if (value === DELETE_SENTINEL) {
        delete current[key];
      } else {
        current[key] = value;
      }
    }
    docs.set(path, current);
  }

  function snapshotOf(path: string) {
    const data = docs.get(path);
    return {
      exists: data !== undefined,
      id: path.split("/").pop()!,
      ref: makeDocRef(path),
      data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    };
  }

  function makeDocRef(path: string): any {
    return {
      path,
      id: path.split("/").pop()!,
      collection: (sub: string) => makeCollection(`${path}/${sub}`),
      get: async () => snapshotOf(path),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
      },
      update: async (data: Record<string, unknown>) => {
        if (!docs.has(path)) throw new Error("NOT_FOUND: no document to update");
        applyUpdate(path, data);
      },
    };
  }

  function compare(val: unknown, value: unknown, op: string): boolean {
    if (op === "==") return val === value;
    if (op === "in") return Array.isArray(value) && value.includes(val);
    if (typeof val === "number" && typeof value === "number") {
      if (op === "<=") return val <= value;
      if (op === ">=") return val >= value;
      return false;
    }
    if (typeof val === "string" && typeof value === "string") {
      if (op === "<=") return val <= value;
      if (op === ">=") return val >= value;
    }
    return false;
  }

  function makeQuery(basePath: string) {
    const depth = basePath.split("/").length + 1;
    const filters: Array<[string, string, unknown]> = [];
    let orderField: string | null = null;
    let lim = Infinity;
    const q: any = {
      where(field: string, op: string, value: unknown) { filters.push([field, op, value]); return q; },
      orderBy(field: string) { orderField = field; return q; },
      limit(n: number) { lim = n; return q; },
      async get() {
        let rows = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${basePath}/`) && path.split("/").length === depth)
          .map(([path]) => snapshotOf(path));
        rows = rows.filter(snap =>
          filters.every(([field, op, value]) =>
            compare((snap.data() as Record<string, unknown>)[field], value, op)),
        );
        if (orderField) {
          rows.sort((a, b) => {
            const av = (a.data() as any)[orderField!];
            const bv = (b.data() as any)[orderField!];
            if (typeof av === "number" && typeof bv === "number") return av - bv;
            return String(av ?? "").localeCompare(String(bv ?? ""));
          });
        }
        rows = rows.slice(0, lim);
        return { empty: rows.length === 0, docs: rows };
      },
    };
    return q;
  }

  function makeCollection(basePath: string) {
    return Object.assign(makeQuery(basePath), {
      doc: (id: string) => makeDocRef(`${basePath}/${id}`),
    });
  }

  let txChain: Promise<unknown> = Promise.resolve();
  const dbObj = {
    collection: (name: string) => makeCollection(name),
    doc: (path: string) => makeDocRef(path),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        update: (ref: any, data: Record<string, unknown>) => ops.push(() => applyUpdate(ref.path, data)),
        set: (ref: any, data: Record<string, unknown>) => ops.push(() => docs.set(ref.path, { ...data })),
        delete: (ref: any) => ops.push(() => docs.delete(ref.path)),
        commit: async () => { for (const op of ops) op(); },
      };
    },
    runTransaction: (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: any) => snapshotOf(ref.path),
        set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          docs.set(ref.path, opts?.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : { ...data });
        },
        update: (ref: any, data: Record<string, unknown>) => applyUpdate(ref.path, data),
      };
      const run = txChain.then(() => fn(tx));
      txChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };

  return {
    docs,
    dbObj,
    DELETE_SENTINEL,
    zepUser: vi.fn(async (_params: { threadId: string; content: string; userName: string; sentAt?: Date; uuid?: string }) => ({ messageUuids: ["provider-uuid"] })),
    zepAssistant: vi.fn(async (_params: { threadId: string; content: string; sentAt?: Date; uuid?: string }) => ({ messageUuids: ["provider-uuid"] })),
    extractFacts: vi.fn(async (..._args: unknown[]) => {}),
    // U4b adapters (zepClient / memoryFiles / auditLog)
    findEdges: vi.fn(async (_p: { zepUserId: string; factText: string }) => [] as Array<{ uuid: string; episodes: string[] }>),
    verifyForgottenFactAbsent: vi.fn(async (_p: { zepUserId: string; factText: string; threadId: string }) => {}),
    invalidateEdge: vi.fn(async (_p: { edgeUuid: string; invalidAt: string }) => ({ alreadyGone: false })),
    deleteEdge: vi.fn(async (_uuid: string) => ({ alreadyGone: false })),
    deleteEpisode: vi.fn(async (_uuid: string) => ({ alreadyGone: false })),
    reconcileFiles: vi.fn(async (_userId: string, _old: string, _replacement: string) => ({ filesScanned: 1, filesRewritten: 1, occurrencesReplaced: 1 })),
    deleteEmbeddings: vi.fn(async (_userId: string, _text: string) => 1),
    logAudit: vi.fn(async (_e: unknown) => {}),
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => h.dbObj, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => h.DELETE_SENTINEL,
    },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => {
  const pubsub = {
    schedule: () => ({
      onRun: (fn: any) => fn,
      timeZone: () => ({ onRun: (fn: any) => fn }),
    }),
  };
  return {
    pubsub,
    // U4b: the worker binds the fingerprint secret via runWith (v1 params
    // pattern) — the mock passes registration through unchanged.
    runWith: (_opts: unknown) => ({ pubsub }),
  };
});

vi.mock("../memory/zepClient", () => ({
  addUserMessageToZepStrict: h.zepUser,
  addAssistantMessageToZepStrict: h.zepAssistant,
  findZepEdgesMatchingFact: h.findEdges,
  invalidateZepEdgeStrict: h.invalidateEdge,
  deleteZepEdgeStrict: h.deleteEdge,
  deleteZepEpisodeStrict: h.deleteEpisode,
  verifyZepForgottenFactAbsent: h.verifyForgottenFactAbsent,
  // Same containment semantics as the real matcher — enough for row-scan tests.
  zepEdgeFactMatches: (edgeFact: string, target: string) =>
    edgeFact.toLowerCase().includes(target.toLowerCase()),
  getZepUserId: (phone: string) => phone.replace(/\D/g, ""),
}));

vi.mock("../memory/learnedFacts", () => ({
  extractAndStoreFacts: h.extractFacts,
  normalizeFactForFingerprint: (fact: string) =>
    (fact ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
}));

vi.mock("../memory/memoryFiles", () => ({
  reconcileFactAcrossMemoryFiles: h.reconcileFiles,
  deleteEmbeddingRowsMatching: h.deleteEmbeddings,
}));

vi.mock("../observability/auditLog", () => ({
  logAudit: h.logAudit,
}));

import {
  runMemoryOperationWorker,
  isZepDuplicateError,
  TURN_SYNC_ORDERING_SCAN_LIMIT,
  TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS,
} from "./memoryOperationWorker";
import {
  MEMORY_OPERATION_MAX_ATTEMPTS,
  getMemoryReconciliationState,
} from "../memory/memoryOperations";
import { __setFingerprintKeyForTests } from "../memory/fingerprintKey";

const PHONE = "+14085550001";
const TURN_MS = Date.parse("2026-07-17T10:00:00Z");
const PAST = new Date(Date.now() - 60_000).toISOString();

function seedTurn(opId: string, overrides: Record<string, unknown> = {}, msgOverrides: {
  userContent?: string; assistantContent?: string; phone?: string;
} = {}) {
  const phone = msgOverrides.phone ?? PHONE;
  const userPath = `agent_conversations/${phone}/messages/turn_${opId}_user`;
  const assistantPath = `agent_conversations/${phone}/messages/turn_${opId}_assistant`;
  h.docs.set(userPath, {
    role: "user", content: msgOverrides.userContent ?? "Mom prefers morning visits",
    timestamp: TURN_MS, sourceTurnKeyHash: `hash-${opId}`, sourceChannel: "web", memorySyncStatus: "pending",
  });
  h.docs.set(assistantPath, {
    role: "assistant", content: msgOverrides.assistantContent ?? "Noted!",
    timestamp: TURN_MS + 1, sourceTurnKeyHash: `hash-${opId}`, sourceChannel: "web", memorySyncStatus: "pending",
  });
  h.docs.set(`memory_operations/${opId}`, {
    kind: "turn_sync",
    userId: "user-1",
    sessionRef: `agent_sessions/${phone}`,
    sourceTurnKeyHash: `hash-${opId}`,
    sourceChannel: "web",
    sourceMessageRefs: [userPath, assistantPath],
    learnedFactRefs: [],
    sourceTurnTimestamp: TURN_MS,
    zepMessageUuids: { user: `uuid-${opId}-user`, assistant: `uuid-${opId}-assistant` },
    status: "pending",
    attempts: 0,
    nextRetryAt: PAST,
    leaseOwner: null,
    leaseExpiresAt: null,
    targets: {
      firestore: { status: "completed" },
      zepTranscript: { status: "pending" },
      learnedFacts: { status: "pending" },
      storage: { status: "skipped" },
      embeddings: { status: "skipped" },
      zepEdges: { status: "skipped" },
      zepEpisodes: { status: "skipped" },
    },
    createdAt: PAST, updatedAt: PAST, completedAt: null, expiresAt: null,
    ...overrides,
  });
  return { userPath, assistantPath };
}

function seedSession(overrides: Record<string, unknown> = {}) {
  h.docs.set(`agent_sessions/${PHONE}`, {
    zepThreadId: "thread-1", firstName: "Anahi", userType: "client", userId: "user-1", ...overrides,
  });
}

// ── U4b fixtures ──────────────────────────────────────────────────────────────

const FORGOTTEN_FACT = "Mom is allergic to penicillin";
const CORRECTED_FACT = "Mom is allergic to amoxicillin";
const FACT_PATH = "learned_facts/user-1/facts/nf_target";
const REPLACEMENT_PATH = "learned_facts/user-1/facts/nf_replacement";

function seedFactChange(
  opId: string,
  kind: "correction" | "forget",
  overrides: Record<string, unknown> = {},
  factOverrides: Record<string, unknown> | null = {},
) {
  if (factOverrides !== null) {
    h.docs.set(FACT_PATH, {
      userId: "user-1",
      fact: FORGOTTEN_FACT,
      _norm: FORGOTTEN_FACT.toLowerCase(),
      weight: 3,
      category: "medical",
      createdAt: PAST,
      lastMentionedAt: PAST,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "text-embedding-3-small",
      mentionTurnKeys: ["turnkey-1"],
      sourceMessageRefs: [],
      ...(kind === "forget"
        ? { pendingForgetOperationId: opId }
        : { pendingCorrectionOperationId: opId, supersededAt: PAST, supersededBy: "nf_replacement" }),
      ...factOverrides,
    });
  }
  if (kind === "correction") {
    h.docs.set(REPLACEMENT_PATH, {
      userId: "user-1", fact: CORRECTED_FACT, _norm: CORRECTED_FACT.toLowerCase(),
      weight: 2, category: "medical", createdAt: PAST, lastMentionedAt: PAST, correctionOf: "nf_target",
    });
  }
  h.docs.set(`memory_operations/${opId}`, {
    kind,
    userId: "user-1",
    sessionRef: `agent_sessions/${PHONE}`,
    sourceMessageRefs: [],
    learnedFactRefs: [FACT_PATH, ...(kind === "correction" ? [REPLACEMENT_PATH] : [])],
    status: "pending",
    attempts: 0,
    nextRetryAt: PAST,
    leaseOwner: null,
    leaseExpiresAt: null,
    targets: {
      firestore: { status: "skipped" },
      zepTranscript: { status: "skipped" },
      learnedFacts: { status: "pending" },
      storage: { status: "pending" },
      embeddings: { status: "pending" },
      zepEdges: { status: "pending" },
      zepEpisodes: { status: "pending" },
    },
    createdAt: PAST, updatedAt: PAST, completedAt: null, expiresAt: null,
    ...overrides,
  });
  // Reconciliation flag — staged transactionally with the operation (U4a).
  h.docs.set("memory_reconciliation/user-1", {
    pendingOperations: { [opId]: { kind, createdAt: PAST } },
    updatedAt: PAST,
  });
}

function requeue(opId: string) {
  h.docs.set(`memory_operations/${opId}`, {
    ...h.docs.get(`memory_operations/${opId}`)!,
    nextRetryAt: PAST,
  });
}

beforeEach(() => {
  h.docs.clear();
  h.zepUser.mockClear();
  h.zepUser.mockImplementation(async () => ({ messageUuids: ["provider-uuid"] }));
  h.zepAssistant.mockClear();
  h.zepAssistant.mockImplementation(async () => ({ messageUuids: ["provider-uuid"] }));
  h.extractFacts.mockClear();
  h.extractFacts.mockImplementation(async () => {});
  h.findEdges.mockClear();
  h.findEdges.mockImplementation(async () => [
    { uuid: "edge-1", episodes: ["ep-1", "ep-mixed"] },
    { uuid: "edge-2", episodes: ["ep-mixed"] },
  ]);
  h.invalidateEdge.mockClear();
  h.verifyForgottenFactAbsent.mockClear();
  h.verifyForgottenFactAbsent.mockImplementation(async () => {});
  h.invalidateEdge.mockImplementation(async () => ({ alreadyGone: false }));
  h.deleteEdge.mockClear();
  h.deleteEdge.mockImplementation(async () => ({ alreadyGone: false }));
  h.deleteEpisode.mockClear();
  h.deleteEpisode.mockImplementation(async () => ({ alreadyGone: false }));
  h.reconcileFiles.mockClear();
  h.reconcileFiles.mockImplementation(async () => ({ filesScanned: 1, filesRewritten: 1, occurrencesReplaced: 1 }));
  h.deleteEmbeddings.mockClear();
  h.deleteEmbeddings.mockImplementation(async () => 1);
  h.logAudit.mockClear();
  h.logAudit.mockImplementation(async () => {});
  __setFingerprintKeyForTests("test-fingerprint-key");
});

describe("runMemoryOperationWorker — happy path (KTD5/KTD6)", () => {
  it("claims a due op, writes Zep with the PERSISTED uuid + ORIGINAL turn timestamp, extracts facts, clears memorySyncStatus, completes", async () => {
    seedSession();
    const { userPath, assistantPath } = seedTurn("op1");

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.due).toBe(1);

    // Strict Zep adapters received the persisted deterministic UUIDs — the
    // worker must REUSE, never re-derive — and the ORIGINAL source-turn
    // timestamps as createdAt (never dispatch time).
    expect(h.zepUser).toHaveBeenCalledTimes(1);
    expect(h.zepUser).toHaveBeenCalledWith({
      threadId: "thread-1",
      content: "Mom prefers morning visits",
      userName: "Anahi",
      sentAt: new Date(TURN_MS),
      uuid: "uuid-op1-user",
    });
    expect(h.zepAssistant).toHaveBeenCalledWith({
      threadId: "thread-1",
      content: "Noted!",
      sentAt: new Date(TURN_MS + 1),
      uuid: "uuid-op1-assistant",
    });

    // Idempotent client fact extraction with turn-key provenance (KTD7), no
    // zepUserId (KTD8 — the transcript already carries the text).
    expect(h.extractFacts).toHaveBeenCalledWith("user-1", "Mom prefers morning visits", undefined, {
      sourceTurnKeyHash: "hash-op1",
      sourceMessageRefs: [userPath, assistantPath],
    });

    // Source rows released to compression (R9).
    expect(h.docs.get(userPath)!.memorySyncStatus).toBeUndefined();
    expect(h.docs.get(assistantPath)!.memorySyncStatus).toBeUndefined();

    // Operation finalized with retention expiry.
    const op = h.docs.get("memory_operations/op1")!;
    expect(op.status).toBe("completed");
    expect(typeof op.expiresAt).toBe("string");
    expect((op.targets as any).zepTranscript.status).toBe("completed");
    expect((op.targets as any).learnedFacts.status).toBe("completed");
  });

  it("a caregiver/skipped learnedFacts target never runs extraction (R8)", async () => {
    seedSession();
    seedTurn("op1", {
      targets: {
        firestore: { status: "completed" }, zepTranscript: { status: "pending" },
        learnedFacts: { status: "skipped" }, storage: { status: "skipped" },
        embeddings: { status: "skipped" }, zepEdges: { status: "skipped" }, zepEpisodes: { status: "skipped" },
      },
    });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(h.extractFacts).not.toHaveBeenCalled();
  });

  it("kinds the worker does not process are counted and left untouched", async () => {
    seedSession();
    seedTurn("op1", { kind: "bogus_future_kind" });

    const counts = await runMemoryOperationWorker();

    expect(counts.unsupportedKind).toBe(1);
    expect(counts.completed).toBe(0);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("pending");
    expect(h.zepUser).not.toHaveBeenCalled();
  });
});

describe("idempotency and reconciliation (R9/KTD5)", () => {
  it("provider duplicate/already-exists is reconciled as SUCCESS (crash/timeout after provider stored)", async () => {
    seedSession();
    seedTurn("op1");
    const dupErr = Object.assign(new Error("message already exists"), { status: 409 });
    h.zepUser.mockRejectedValueOnce(dupErr as never);

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.zepDuplicates).toBe(1);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("completed");
  });

  it("Zep timeout after provider success: retryable failure, then the retry sends the SAME uuid and reconciles as duplicate-success", async () => {
    seedSession();
    const { userPath } = seedTurn("op1");
    // Attempt 1: the provider stored the message but the response timed out.
    h.zepUser.mockRejectedValueOnce(new Error("Zep request timed out") as never);

    const first = await runMemoryOperationWorker();
    expect(first.retryable).toBe(1);
    const afterFail = h.docs.get("memory_operations/op1")!;
    expect(afterFail.status).toBe("retryable_failed");
    expect(Date.parse(String(afterFail.nextRetryAt))).toBeGreaterThan(Date.now());
    // Source rows stay protected while unresolved (R9).
    expect(h.docs.get(userPath)!.memorySyncStatus).toBe("pending");

    // Attempt 2 (simulate the backoff having elapsed): provider answers
    // duplicate → success.
    requeue("op1");
    h.zepUser.mockRejectedValueOnce(Object.assign(new Error("already exists"), { status: 409 }) as never);
    const second = await runMemoryOperationWorker();
    expect(second.completed).toBe(1);

    // Both attempts carried the identical persisted UUID.
    const uuids = h.zepUser.mock.calls.map(c => (c[0] as { uuid?: string }).uuid);
    expect(uuids).toEqual(["uuid-op1-user", "uuid-op1-user"]);
    expect(h.docs.get(userPath)!.memorySyncStatus).toBeUndefined();
  });

  it("an already-completed zepTranscript target is not re-sent on retry (per-target resume)", async () => {
    seedSession();
    seedTurn("op1", {
      status: "retryable_failed",
      attempts: 1,
      nextRetryAt: PAST,
      targets: {
        firestore: { status: "completed" }, zepTranscript: { status: "completed" },
        learnedFacts: { status: "pending" }, storage: { status: "skipped" },
        embeddings: { status: "skipped" }, zepEdges: { status: "skipped" }, zepEpisodes: { status: "skipped" },
      },
    });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(h.zepUser).not.toHaveBeenCalled();
    expect(h.zepAssistant).not.toHaveBeenCalled();
    expect(h.extractFacts).toHaveBeenCalledTimes(1);
  });

  it("two concurrent workers process the operation exactly once (transactional claim)", async () => {
    seedSession();
    seedTurn("op1");

    const [a, b] = await Promise.all([runMemoryOperationWorker(), runMemoryOperationWorker()]);

    expect(a.completed + b.completed).toBe(1);
    expect(h.zepUser).toHaveBeenCalledTimes(1);
    expect(h.zepAssistant).toHaveBeenCalledTimes(1);
    expect(h.extractFacts).toHaveBeenCalledTimes(1);
  });

  it("an expired lease is reclaimed and the work finishes (worker crash recovery)", async () => {
    seedSession();
    seedTurn("op1", {
      status: "processing",
      attempts: 1,
      leaseOwner: "memory-worker-dead",
      leaseExpiresAt: PAST,
      nextRetryAt: PAST, // mirrored lease expiry — how the sweep finds it
    });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("completed");
  });
});

describe("per-user source-turn ordering (KTD5/R9)", () => {
  it("defers an oversized unresolved backlog rather than risking out-of-order transcript writes", async () => {
    seedSession();
    for (let i = 0; i <= TURN_SYNC_ORDERING_SCAN_LIMIT; i++) {
      seedTurn(`op-backlog-${i}`, { sourceTurnTimestamp: TURN_MS + i });
    }

    const counts = await runMemoryOperationWorker();

    expect(counts.orderingBacklogOverflows).toBe(1);
    expect(counts.completed).toBe(0);
    expect(h.zepUser).not.toHaveBeenCalled();
    expect(h.docs.get("memory_operations/op-backlog-0")!.status).toBe("pending");
    const alerts = [...h.docs.entries()].filter(([path]) =>
      path.startsWith("admin_alerts/memory-turn-sync-backlog:"),
    );
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0][1])).not.toMatch(/user-1|op-backlog|\+14085550001/i);
  });

  it("an older unresolved-but-not-due turn BLOCKS a younger due turn for the same user", async () => {
    seedSession();
    // Older turn: failed, backing off into the future.
    seedTurn("op-old", {
      status: "retryable_failed", attempts: 1,
      sourceTurnTimestamp: TURN_MS,
      nextRetryAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    // Younger turn: due now.
    seedTurn("op-young", { sourceTurnTimestamp: TURN_MS + 5_000 });

    const counts = await runMemoryOperationWorker();

    expect(counts.blockedByOlder).toBe(1);
    expect(counts.completed).toBe(0);
    expect(h.zepUser).not.toHaveBeenCalled();
    expect(h.docs.get("memory_operations/op-young")!.status).toBe("pending"); // simply requeued
  });

  it("when both are due, turns are processed oldest-first with their ORIGINAL timestamps", async () => {
    seedSession();
    seedTurn("op-old", { sourceTurnTimestamp: TURN_MS }, { userContent: "older turn" });
    seedTurn("op-young", { sourceTurnTimestamp: TURN_MS + 5_000 }, { userContent: "younger turn" });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(2);
    expect(h.zepUser.mock.calls.map(c => (c[0] as { content: string }).content)).toEqual(["older turn", "younger turn"]);
    // Each retained its own source-turn createdAt.
    expect(h.zepUser.mock.calls.map(c => ((c[0] as { sentAt: Date }).sentAt).getTime())).toEqual([TURN_MS, TURN_MS + 5_000]);
  });

  it("an older turn FAILING mid-run blocks the younger turn in the same sweep", async () => {
    seedSession();
    seedTurn("op-old", { sourceTurnTimestamp: TURN_MS }, { userContent: "older turn" });
    seedTurn("op-young", { sourceTurnTimestamp: TURN_MS + 5_000 }, { userContent: "younger turn" });
    h.zepUser.mockRejectedValueOnce(new Error("zep down") as never);

    const counts = await runMemoryOperationWorker();

    expect(counts.retryable).toBe(1);
    expect(counts.blockedByOlder).toBe(1);
    expect(counts.completed).toBe(0);
    expect(h.docs.get("memory_operations/op-young")!.status).toBe("pending");
  });

  it("different users do not block each other", async () => {
    seedSession();
    seedTurn("op-a", { userId: "user-1", sourceTurnTimestamp: TURN_MS });
    seedTurn("op-b", { userId: "user-2", sourceTurnTimestamp: TURN_MS + 1 });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(2);
  });
});

describe("failure handling and telemetry (R8/R21)", () => {
  it("a session with NO Zep thread completes with zepTranscript skipped — no retry loop, no terminal alert", async () => {
    seedSession({ zepThreadId: undefined });
    const { userPath, assistantPath } = seedTurn("op1");

    const counts = await runMemoryOperationWorker();

    // Threadless sessions used to throw → retry → terminal-fail EVERY turn.
    // Now the transcript target is durably skipped (counted) and the rest of
    // the operation (fact extraction) proceeds to completion.
    expect(counts.completed).toBe(1);
    expect(counts.zepTranscriptSkips).toBe(1);
    expect(counts.retryable).toBe(0);
    expect(counts.terminal).toBe(0);
    expect(h.zepUser).not.toHaveBeenCalled();
    expect(h.zepAssistant).not.toHaveBeenCalled();
    expect(h.extractFacts).toHaveBeenCalledTimes(1);

    const op = h.docs.get("memory_operations/op1")!;
    expect(op.status).toBe("completed");
    expect((op.targets as any).zepTranscript.status).toBe("skipped");
    expect((op.targets as any).learnedFacts.status).toBe("completed");
    // Source rows released to compression; no alert spam.
    expect(h.docs.get(userPath)!.memorySyncStatus).toBeUndefined();
    expect(h.docs.get(assistantPath)!.memorySyncStatus).toBeUndefined();
    expect([...h.docs.keys()].filter(k => k.startsWith("admin_alerts/"))).toHaveLength(0);
  });

  it("a TERMINAL turn_sync failure releases its source rows with the 'terminal' marker (R9 repair)", async () => {
    seedSession();
    const { userPath, assistantPath } = seedTurn("op1", {
      status: "retryable_failed",
      attempts: MEMORY_OPERATION_MAX_ATTEMPTS - 1,
      nextRetryAt: PAST,
    });
    h.zepUser.mockRejectedValue(new Error("zep permanently down") as never);

    const counts = await runMemoryOperationWorker();

    expect(counts.terminal).toBe(1);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("terminal_failed");
    // The worker permanently gave up — the rows must not wedge compression
    // forever. The marker (not a delete) keeps the giving-up visible.
    expect(h.docs.get(userPath)!.memorySyncStatus).toBe("terminal");
    expect(h.docs.get(assistantPath)!.memorySyncStatus).toBe("terminal");
  });

  it("the terminal attempt alerts exactly once (deduplicated) and later sweeps ignore the operation", async () => {
    seedSession();
    seedTurn("op1", { status: "retryable_failed", attempts: MEMORY_OPERATION_MAX_ATTEMPTS - 1, nextRetryAt: PAST });
    h.zepUser.mockRejectedValue(new Error("zep permanently down") as never);

    const first = await runMemoryOperationWorker();
    expect(first.terminal).toBe(1);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("terminal_failed");
    expect(h.docs.has("admin_alerts/memory-operation:op1")).toBe(true);

    const second = await runMemoryOperationWorker(Date.now() + 60 * 60 * 1000);
    expect(second.due).toBe(0);
    const alertDocs = [...h.docs.keys()].filter(k => k.startsWith("admin_alerts/"));
    expect(alertDocs).toHaveLength(1);
  });

  it("worker logs are aggregate-only: counts, no operation IDs, phones, hashes, or content", async () => {
    seedSession();
    seedTurn("op1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMemoryOperationWorker();
      const workerLogs = logSpy.mock.calls.filter(c => String(c[0]).includes("memory_operation_worker"));
      expect(workerLogs).toHaveLength(1);
      const serialized = JSON.stringify(workerLogs);
      expect(serialized).not.toContain(PHONE);
      expect(serialized).not.toContain("op1");
      expect(serialized).not.toContain("hash-op1");
      expect(serialized).not.toContain("Mom prefers");
      expect(serialized).not.toContain("thread-1");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("isZepDuplicateError", () => {
  it("recognizes 409s and already-exists/duplicate messages; rejects everything else", () => {
    expect(isZepDuplicateError(Object.assign(new Error("conflict"), { status: 409 }))).toBe(true);
    expect(isZepDuplicateError(Object.assign(new Error("conflict"), { statusCode: 409 }))).toBe(true);
    expect(isZepDuplicateError(new Error("message already exists"))).toBe(true);
    expect(isZepDuplicateError(new Error("duplicate message uuid"))).toBe(true);
    expect(isZepDuplicateError(new Error("request timed out"))).toBe(false);
    expect(isZepDuplicateError(Object.assign(new Error("server error"), { status: 500 }))).toBe(false);
    expect(isZepDuplicateError(undefined)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U4b — correction/forget propagation (R13/R14/R23, KTD9/KTD16)
// ═════════════════════════════════════════════════════════════════════════════

describe("forget propagation (R14/KTD16)", () => {
  it("full pass: Storage reconcile, embedding purge, exact episode+edge deletion, tombstone strip, audit, flag cleanup, completion", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.factChangesCompleted).toBe(1);

    // Storage: exact-match reconcile with REMOVAL (empty replacement).
    expect(h.reconcileFiles).toHaveBeenCalledWith("user-1", FORGOTTEN_FACT, "");
    // Embeddings purged by retired text.
    expect(h.deleteEmbeddings).toHaveBeenCalledWith("user-1", FORGOTTEN_FACT);

    // Zep: matched via the user's graph (phone-digits identity), episodes
    // deleted FIRST (deduped — the shared episode once), then exact edges.
    expect(h.findEdges).toHaveBeenCalledWith({ zepUserId: "14085550001", factText: FORGOTTEN_FACT });
    expect(h.deleteEpisode.mock.calls.map(c => c[0]).sort()).toEqual(["ep-1", "ep-mixed"]);
    expect(h.deleteEdge.mock.calls.map(c => c[0]).sort()).toEqual(["edge-1", "edge-2"]);
    expect(h.invalidateEdge).not.toHaveBeenCalled();

    // Tombstone: serialized doc holds NO plaintext — only fingerprint,
    // category, provenance, forgottenAt (R14/KTD16).
    const tombstone = h.docs.get(FACT_PATH)!;
    const serialized = JSON.stringify(tombstone);
    expect(serialized).not.toContain("penicillin");
    expect(serialized).not.toContain(FORGOTTEN_FACT);
    expect(tombstone.fact).toBeUndefined();
    expect(tombstone._norm).toBeUndefined();
    expect(tombstone.embedding).toBeUndefined();
    expect(tombstone.embeddingModel).toBeUndefined();
    expect(tombstone.pendingForgetOperationId).toBeUndefined();
    expect(typeof tombstone.forgottenAt).toBe("string");
    expect(String(tombstone.forgottenFingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstone.fingerprintKeyVersion).toBe(1);
    expect(tombstone.category).toBe("medical");

    // Durable audit entry: written on completion, no fact text (R21).
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledWith({
      eventType: "memory_fact_forgotten",
      userId: "user-1",
      data: { source: "memory_operation_worker", category: "medical" },
    });
    expect(JSON.stringify(h.logAudit.mock.calls)).not.toContain("penicillin");

    // Operation completed with retention expiry; flag entry removed.
    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("completed");
    expect(typeof op.expiresAt).toBe("string");
    const flag = h.docs.get("memory_reconciliation/user-1")!;
    expect((flag.pendingOperations as Record<string, unknown>)["op-forget"]).toBeUndefined();

    // Post-completion reconciliation state: all clear.
    const state = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(state.pending).toBe(false);
  });

  it("mixed episode is deleted (privacy wins) and NOTHING is re-ingested into Zep", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");
    // ep-mixed is shared by both edges (i.e. it also carries unrelated facts).
    await runMemoryOperationWorker();

    expect(h.deleteEpisode.mock.calls.map(c => c[0])).toContain("ep-mixed");
    // No Zep write of any kind happened — no re-ingestion path exists here.
    expect(h.zepUser).not.toHaveBeenCalled();
    expect(h.zepAssistant).not.toHaveBeenCalled();
  });

  it("keeps the operation pending when post-delete Zep verification still finds the retired fact", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");
    h.verifyForgottenFactAbsent.mockRejectedValueOnce(new Error("zep fact still present") as never);

    const counts = await runMemoryOperationWorker();

    expect(counts.retryable).toBe(1);
    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("retryable_failed");
    expect((op.targets as any).zepEdges.status).toBe("failed");
    expect((op.targets as any).zepEpisodes.status).toBe("failed");
    expect(h.docs.get(FACT_PATH)!.pendingForgetOperationId).toBe("op-forget");
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("already-gone targets are success: missing fact doc + not-found Zep targets still complete", async () => {
    seedSession();
    seedFactChange("op-forget", "forget", {}, null); // no fact doc at all
    h.deleteEdge.mockImplementation(async () => ({ alreadyGone: true }));
    h.deleteEpisode.mockImplementation(async () => ({ alreadyGone: true }));

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    // No retired plaintext → nothing addressable; Storage/embeddings/Zep are
    // trivially complete, not failures.
    expect(h.reconcileFiles).not.toHaveBeenCalled();
    expect(h.deleteEmbeddings).not.toHaveBeenCalled();
    expect(h.findEdges).not.toHaveBeenCalled();
    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("completed");
    for (const key of ["storage", "embeddings", "zepEdges", "zepEpisodes", "learnedFacts"]) {
      expect((op.targets as any)[key].status).toBe("completed");
    }
  });

  it("a forget for a THREADLESS session completes via edge-inventory-only verification (skip counted)", async () => {
    seedSession({ zepThreadId: undefined });
    seedFactChange("op-forget", "forget");

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.factChangesCompleted).toBe(1);
    expect(counts.forgetContextChecksSkipped).toBe(1);
    // Verification ran with NO threadId — zepClient's edge-inventory half
    // stands alone (behavior pinned in zepClient.test.ts).
    expect(h.verifyForgottenFactAbsent).toHaveBeenCalledWith({
      zepUserId: "14085550001",
      factText: FORGOTTEN_FACT,
      threadId: undefined,
    });
    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("completed");
    // Deletion + tombstone still ran in full.
    expect(h.deleteEdge).toHaveBeenCalled();
    expect(h.docs.get(FACT_PATH)!.fact).toBeUndefined();
  });

  it("an unbound fingerprint secret makes forget finalization a RETRYABLE failure — plaintext is never stripped without a tombstone fingerprint", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");
    __setFingerprintKeyForTests(null);
    const prevEnv = process.env.MEMORY_FINGERPRINT_KEY;
    delete process.env.MEMORY_FINGERPRINT_KEY;
    try {
      const counts = await runMemoryOperationWorker();

      expect(counts.retryable).toBe(1);
      const op = h.docs.get("memory_operations/op-forget")!;
      expect(op.status).toBe("retryable_failed");
      expect((op.targets as any).learnedFacts.status).toBe("failed");
      // Upstream stores were reconciled, but the fact doc keeps its plaintext
      // and pending marker → still masked, never resurrectable.
      const fact = h.docs.get(FACT_PATH)!;
      expect(fact.fact).toBe(FORGOTTEN_FACT);
      expect(fact.pendingForgetOperationId).toBe("op-forget");
      expect(h.logAudit).not.toHaveBeenCalled(); // completion audit only on full completion
    } finally {
      if (prevEnv !== undefined) process.env.MEMORY_FINGERPRINT_KEY = prevEnv;
    }
  });
});

describe("correction propagation (R13)", () => {
  it("exact edge invalidation: matched edges get invalidAt, no edge/episode deletion, corrected value written to Storage", async () => {
    seedSession();
    seedFactChange("op-corr", "correction");

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    // Storage rewrite carries the CORRECTED value.
    expect(h.reconcileFiles).toHaveBeenCalledWith("user-1", FORGOTTEN_FACT, CORRECTED_FACT);
    // Exact edge invalidation, never deletion (the correction keeps history).
    expect(h.invalidateEdge.mock.calls.map(c => (c[0] as { edgeUuid: string }).edgeUuid).sort())
      .toEqual(["edge-1", "edge-2"]);
    for (const call of h.invalidateEdge.mock.calls) {
      expect(typeof (call[0] as { invalidAt: string }).invalidAt).toBe("string");
    }
    expect(h.deleteEdge).not.toHaveBeenCalled();
    expect(h.deleteEpisode).not.toHaveBeenCalled();

    // Old doc: pending marker cleared, supersede finalized, plaintext retained
    // (superseded docs keep text; the supersede state blocks reuse).
    const oldDoc = h.docs.get(FACT_PATH)!;
    expect(oldDoc.pendingCorrectionOperationId).toBeUndefined();
    expect(oldDoc.supersededAt).toBeTruthy();
    // Replacement fact untouched and current.
    expect(h.docs.get(REPLACEMENT_PATH)!.fact).toBe(CORRECTED_FACT);

    // Durable audit for the correction.
    expect(h.logAudit).toHaveBeenCalledWith({
      eventType: "memory_fact_corrected",
      userId: "user-1",
      data: { source: "memory_operation_worker", category: "medical" },
    });
  });
});

describe("resumable per-target retry (R13/R14 retry, KTD9 per-store unmask)", () => {
  it("retry after a Storage failure resumes from Storage — downstream targets were never attempted early", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");
    h.reconcileFiles.mockRejectedValueOnce(new Error("storage down") as never);

    const first = await runMemoryOperationWorker();
    expect(first.retryable).toBe(1);
    let op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("retryable_failed");
    expect((op.targets as any).storage.status).toBe("failed");
    expect((op.targets as any).storage.errorClass).toBe("Error");
    // Order guarantee: nothing downstream ran.
    expect(h.findEdges).not.toHaveBeenCalled();
    expect(h.deleteEmbeddings).not.toHaveBeenCalled();

    requeue("op-forget");
    const second = await runMemoryOperationWorker();
    expect(second.completed).toBe(1);
    // Storage was retried (2 total calls), then the rest ran exactly once.
    expect(h.reconcileFiles).toHaveBeenCalledTimes(2);
    expect(h.deleteEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.findEdges).toHaveBeenCalledTimes(1);
    op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("completed");
  });

  it("retry after a Zep failure resumes ONLY the Zep targets; per-store unmask reflects worker progress", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");
    h.findEdges.mockRejectedValueOnce(new Error("zep down") as never);

    const first = await runMemoryOperationWorker();
    expect(first.retryable).toBe(1);
    const opAfterFail = h.docs.get("memory_operations/op-forget")!;
    expect((opAfterFail.targets as any).storage.status).toBe("completed");
    expect((opAfterFail.targets as any).embeddings.status).toBe("completed");
    expect((opAfterFail.targets as any).zepEdges.status).toBe("failed");
    expect((opAfterFail.targets as any).zepEpisodes.status).toBe("failed");

    // KTD9 per-store: Storage confirmed → unmasked; Zep still masked; the
    // fact stays pending → the user remains in reconciliation.
    const midState = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(midState.pending).toBe(true);
    expect(midState.storageMasked).toBe(false);
    expect(midState.zepMasked).toBe(true);
    // Pending fact is still staged (masked) — plaintext + marker intact.
    expect(h.docs.get(FACT_PATH)!.pendingForgetOperationId).toBe("op-forget");

    requeue("op-forget");
    const second = await runMemoryOperationWorker();
    expect(second.completed).toBe(1);
    // Storage/embeddings were NOT re-run; Zep was.
    expect(h.reconcileFiles).toHaveBeenCalledTimes(1);
    expect(h.deleteEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.findEdges).toHaveBeenCalledTimes(2);

    const endState = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(endState.pending).toBe(false);
    expect(endState.zepMasked).toBe(false);
  });

  it("a failed operation never expires and stays masked (terminal alert, no expiresAt)", async () => {
    seedSession();
    seedFactChange("op-forget", "forget", { status: "retryable_failed", attempts: MEMORY_OPERATION_MAX_ATTEMPTS - 1 });
    h.reconcileFiles.mockRejectedValue(new Error("storage permanently down") as never);

    const counts = await runMemoryOperationWorker();
    expect(counts.terminal).toBe(1);

    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("terminal_failed");
    expect(op.expiresAt ?? null).toBeNull();
    expect(op.completedAt ?? null).toBeNull();
    expect(h.docs.has("admin_alerts/memory-operation:op-forget")).toBe(true);
    // Suppression persists: flag entry present, state still masked.
    const state = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(state.pending).toBe(true);
    expect(state.storageMasked).toBe(true);
    // No completion audit for failed work.
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("the same request is idempotent: a completed operation is never re-processed", async () => {
    seedSession();
    seedFactChange("op-forget", "forget");

    const first = await runMemoryOperationWorker();
    expect(first.completed).toBe(1);
    const second = await runMemoryOperationWorker();
    expect(second.due).toBe(0);
    expect(second.completed).toBe(0);
    expect(h.reconcileFiles).toHaveBeenCalledTimes(1);
    expect(h.deleteEdge.mock.calls.length).toBe(2); // still just the first run's two edges
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });
});

describe("source-row consolidation exclusion (KTD16/R23)", () => {
  it("known sourceMessageRefs are marked excludeFromMemoryConsolidationAt(+reason)", async () => {
    seedSession();
    const rowPath = `agent_conversations/${PHONE}/messages/turn_x_user`;
    h.docs.set(rowPath, { role: "user", content: "mom is allergic to penicillin btw", timestamp: TURN_MS });
    seedFactChange("op-forget", "forget", { sourceMessageRefs: [rowPath] });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.sourceRowsExcluded).toBe(1);
    const row = h.docs.get(rowPath)!;
    expect(typeof row.excludeFromMemoryConsolidationAt).toBe("string");
    expect(row.excludeFromMemoryConsolidationReason).toBe("forget");
  });

  it("legacy facts without provenance get a bounded 7-day window scan that marks only matching rows", async () => {
    seedSession();
    const now = Date.now();
    h.docs.set(`agent_conversations/${PHONE}/messages/m1`, {
      role: "user", content: "I told you Mom is allergic to penicillin", timestamp: now - 1000,
    });
    h.docs.set(`agent_conversations/${PHONE}/messages/m2`, {
      role: "assistant", content: "Noted — mom is allergic to penicillin.", timestamp: now - 900,
    });
    h.docs.set(`agent_conversations/${PHONE}/messages/m3`, {
      role: "user", content: "Also she likes gardening", timestamp: now - 800,
    });
    h.docs.set(`agent_conversations/${PHONE}/messages/m-old`, {
      role: "user", content: "mom is allergic to penicillin", timestamp: now - 8 * 24 * 60 * 60 * 1000,
    });
    seedFactChange("op-forget", "forget", { sourceMessageRefs: [] });

    const counts = await runMemoryOperationWorker();

    expect(counts.completed).toBe(1);
    expect(counts.sourceRowsExcluded).toBe(2);
    expect(h.docs.get(`agent_conversations/${PHONE}/messages/m1`)!.excludeFromMemoryConsolidationReason).toBe("forget_legacy_scan");
    expect(h.docs.get(`agent_conversations/${PHONE}/messages/m2`)!.excludeFromMemoryConsolidationReason).toBe("forget_legacy_scan");
    // Non-matching + out-of-window rows untouched.
    expect(h.docs.get(`agent_conversations/${PHONE}/messages/m3`)!.excludeFromMemoryConsolidationAt).toBeUndefined();
    expect(h.docs.get(`agent_conversations/${PHONE}/messages/m-old`)!.excludeFromMemoryConsolidationAt).toBeUndefined();
  });
});

// ── Terminal-failed forget repair sweep (audit P1) ────────────────────────────
// A forget that terminal-failed used to mask the user's memory FOREVER, even
// when its Zep data was verifiably absent. The sweep re-opens such operations
// (bounded) so the normal pipeline finishes and unmasks; a genuinely dirty
// graph keeps the mask.
describe("terminal-failed forget repair sweep", () => {
  const TERMINAL_TARGETS_BASE = {
    firestore: { status: "skipped" },
    zepTranscript: { status: "skipped" },
  };

  it("re-opens a terminal forget whose Zep targets already completed; the next sweep finalizes and unmasks", async () => {
    seedSession();
    // Terminal failure happened AFTER Zep confirmed clean (e.g. fingerprint
    // key unbound during learnedFacts finalize).
    seedFactChange("op-forget", "forget", {
      status: "terminal_failed",
      attempts: MEMORY_OPERATION_MAX_ATTEMPTS,
      nextRetryAt: null,
      targets: {
        ...TERMINAL_TARGETS_BASE,
        storage: { status: "completed" },
        embeddings: { status: "completed" },
        zepEdges: { status: "completed" },
        zepEpisodes: { status: "completed" },
        learnedFacts: { status: "failed" },
      },
    });

    const first = await runMemoryOperationWorker();
    expect(first.terminalForgetsReopened).toBe(1);
    // Per-target statuses were authoritative — no fresh Zep probe needed.
    expect(h.findEdges).not.toHaveBeenCalled();
    let op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("retryable_failed");
    expect(op.terminalReverifyAttempts).toBe(1);

    const second = await runMemoryOperationWorker();
    expect(second.completed).toBe(1);
    expect(second.factChangesCompleted).toBe(1);
    op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("completed");
    expect(typeof op.expiresAt).toBe("string");
    // Standard completion path ran in full: tombstone, audit, flag clear.
    expect(h.docs.get(FACT_PATH)!.fact).toBeUndefined();
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const state = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(state.pending).toBe(false);
    expect(state.storageMasked).toBe(false);
    expect(state.zepMasked).toBe(false);
  });

  it("re-verifies a terminal forget with unresolved Zep targets and re-opens when the edge inventory is clean", async () => {
    seedSession();
    seedFactChange("op-forget", "forget", {
      status: "terminal_failed",
      attempts: MEMORY_OPERATION_MAX_ATTEMPTS,
      nextRetryAt: null,
      targets: {
        ...TERMINAL_TARGETS_BASE,
        storage: { status: "completed" },
        embeddings: { status: "completed" },
        zepEdges: { status: "failed" },
        zepEpisodes: { status: "failed" },
        learnedFacts: { status: "pending" },
      },
    });
    h.findEdges.mockResolvedValue([]); // the graph is verifiably clean now

    const first = await runMemoryOperationWorker();
    expect(first.terminalForgetsReopened).toBe(1);
    expect(h.findEdges).toHaveBeenCalledTimes(1);
    expect(h.findEdges).toHaveBeenCalledWith({ zepUserId: "14085550001", factText: FORGOTTEN_FACT });
    const reopened = h.docs.get("memory_operations/op-forget")!;
    expect(reopened.status).toBe("retryable_failed");
    expect((reopened.targets as any).zepEdges.status).toBe("completed");
    expect((reopened.targets as any).zepEpisodes.status).toBe("completed");

    const second = await runMemoryOperationWorker();
    expect(second.completed).toBe(1);
    // The confirmed-clean Zep layer was NOT re-touched: no deletes, no
    // verification, no second inventory scan.
    expect(h.findEdges).toHaveBeenCalledTimes(1);
    expect(h.deleteEdge).not.toHaveBeenCalled();
    expect(h.deleteEpisode).not.toHaveBeenCalled();
    expect(h.verifyForgottenFactAbsent).not.toHaveBeenCalled();
    expect(h.docs.get("memory_operations/op-forget")!.status).toBe("completed");
    const state = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(state.pending).toBe(false);
  });

  it("keeps a genuinely dirty forget terminal (masked) and stops probing after the bounded re-verify budget", async () => {
    seedSession();
    seedFactChange("op-forget", "forget", {
      status: "terminal_failed",
      attempts: MEMORY_OPERATION_MAX_ATTEMPTS,
      nextRetryAt: null,
      targets: {
        ...TERMINAL_TARGETS_BASE,
        storage: { status: "completed" },
        embeddings: { status: "completed" },
        zepEdges: { status: "failed" },
        zepEpisodes: { status: "failed" },
        learnedFacts: { status: "pending" },
      },
    });
    // Default findEdges mock still returns matching edges — genuinely dirty.

    for (let i = 0; i < TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS; i++) {
      const counts = await runMemoryOperationWorker();
      expect(counts.terminalForgetsReopened).toBe(0);
    }
    expect(h.findEdges).toHaveBeenCalledTimes(TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS);

    // Budget exhausted: later sweeps leave the operation alone entirely.
    const extra = await runMemoryOperationWorker();
    expect(extra.terminalForgetsReopened).toBe(0);
    expect(h.findEdges).toHaveBeenCalledTimes(TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS);

    const op = h.docs.get("memory_operations/op-forget")!;
    expect(op.status).toBe("terminal_failed");
    expect(op.terminalReverifyAttempts).toBe(TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS);
    // Privacy suppression persists — a dirty graph must stay masked.
    const state = await getMemoryReconciliationState("user-1", h.dbObj as never);
    expect(state.pending).toBe(true);
    expect(state.zepMasked).toBe(true);
  });
});

// ── U9 (R21/R22): aged-operation alerting from the worker sweep ──────────────
describe("aged unresolved operations (U9)", () => {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  it("a due operation older than the threshold raises ONE deduplicated alert and is counted", async () => {
    seedSession();
    // Parked pending turn (created 2h ago) that keeps failing — the shape the
    // aged alert exists for.
    seedTurn("op-aged", { createdAt: TWO_HOURS_AGO });
    h.zepUser.mockRejectedValue(new Error("zep still down") as never);

    const first = await runMemoryOperationWorker();
    expect(first.agedPending).toBe(1);
    expect(first.oldestDueAgeMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 5_000);
    expect(h.docs.has("admin_alerts/memory-operation-aged:op-aged")).toBe(true);

    // Second sweep: same operation, same deterministic doc — still ONE alert.
    requeue("op-aged");
    const second = await runMemoryOperationWorker();
    expect(second.agedPending).toBe(1);
    const agedAlerts = [...h.docs.keys()].filter(k => k.startsWith("admin_alerts/memory-operation-aged:"));
    expect(agedAlerts).toHaveLength(1);

    // R21: the alert carries the opaque operation ID + enums/counts only — no
    // refs, session paths, phones, hashes, or content.
    const alert = h.docs.get("admin_alerts/memory-operation-aged:op-aged")!;
    expect(alert.type).toBe("memory_operation_aged");
    expect(alert.operationId).toBe("op-aged");
    const serialized = JSON.stringify(alert);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain("agent_conversations");
    expect(serialized).not.toContain("agent_sessions");
    expect(serialized).not.toContain("hash-op-aged");
  });

  it("a fresh due operation never raises the aged alert", async () => {
    seedSession();
    seedTurn("op-fresh"); // createdAt = 60s ago

    const counts = await runMemoryOperationWorker();

    expect(counts.agedPending).toBe(0);
    expect(counts.completed).toBe(1);
    const agedAlerts = [...h.docs.keys()].filter(k => k.startsWith("admin_alerts/memory-operation-aged:"));
    expect(agedAlerts).toHaveLength(0);
  });
});
