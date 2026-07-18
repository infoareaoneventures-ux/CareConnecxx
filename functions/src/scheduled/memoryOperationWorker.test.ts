import { describe, it, expect, vi, beforeEach } from "vitest";

// U3 (memory-grounding hardening 2026-07-17-002, KTD5/KTD6, R8/R9/R21): the
// one-minute memory-operation worker — transactional claim through the shared
// leased-operation engine, per-user SOURCE-TURN ordering, persisted
// deterministic Zep UUID reuse (never re-derived), original turn timestamps as
// Zep createdAt, provider duplicate reconciled as success, idempotent
// learned-fact extraction, memorySyncStatus clearing, deduplicated terminal
// alerts, and aggregate-only logs.
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
      data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    };
  }

  function makeDocRef(path: string): any {
    return {
      path,
      id: path.split("/").pop()!,
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

  function makeQuery(collectionName: string) {
    const filters: Array<[string, string, unknown]> = [];
    let orderField: string | null = null;
    let lim = Infinity;
    const q: any = {
      where(field: string, op: string, value: unknown) { filters.push([field, op, value]); return q; },
      orderBy(field: string) { orderField = field; return q; },
      limit(n: number) { lim = n; return q; },
      async get() {
        let rows = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${collectionName}/`) && path.split("/").length === 2)
          .map(([path]) => snapshotOf(path));
        rows = rows.filter(snap =>
          filters.every(([field, op, value]) => {
            const val = (snap.data() as Record<string, unknown>)[field];
            if (op === "==") return val === value;
            if (op === "<=") return typeof val === "string" && typeof value === "string" && val <= value;
            if (op === "in") return Array.isArray(value) && value.includes(val);
            return true;
          }),
        );
        if (orderField) {
          rows.sort((a, b) => String((a.data() as any)[orderField!] ?? "").localeCompare(String((b.data() as any)[orderField!] ?? "")));
        }
        rows = rows.slice(0, lim);
        return { empty: rows.length === 0, docs: rows };
      },
    };
    return q;
  }

  let txChain: Promise<unknown> = Promise.resolve();
  const dbObj = {
    collection: (name: string) => Object.assign(makeQuery(name), {
      doc: (id: string) => makeDocRef(`${name}/${id}`),
    }),
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

vi.mock("firebase-functions/v1", () => ({
  pubsub: {
    schedule: () => ({
      onRun: (fn: any) => fn,
      timeZone: () => ({ onRun: (fn: any) => fn }),
    }),
  },
}));

vi.mock("../memory/zepClient", () => ({
  addUserMessageToZepStrict: h.zepUser,
  addAssistantMessageToZepStrict: h.zepAssistant,
}));

vi.mock("../memory/learnedFacts", () => ({
  extractAndStoreFacts: h.extractFacts,
}));

import { runMemoryOperationWorker, isZepDuplicateError } from "./memoryOperationWorker";
import { MEMORY_OPERATION_MAX_ATTEMPTS } from "../memory/memoryOperations";

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
    zepThreadId: "thread-1", firstName: "Anahi", userType: "client", ...overrides,
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

  it("non-turn_sync kinds are counted and left untouched (correction/forget arrive in a later unit)", async () => {
    seedSession();
    seedTurn("op1", { kind: "forget" });

    const counts = await runMemoryOperationWorker();

    expect(counts.nonTurnSync).toBe(1);
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
    h.docs.set("memory_operations/op1", { ...h.docs.get("memory_operations/op1")!, nextRetryAt: PAST });
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
  it("a missing Zep thread is a retryable failure — source rows stay protected", async () => {
    seedSession({ zepThreadId: undefined });
    const { userPath } = seedTurn("op1");

    const counts = await runMemoryOperationWorker();

    expect(counts.retryable).toBe(1);
    expect(h.docs.get("memory_operations/op1")!.status).toBe("retryable_failed");
    expect(h.docs.get(userPath)!.memorySyncStatus).toBe("pending");
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
