import { describe, it, expect, vi, beforeEach } from "vitest";

// U3 (memory-grounding hardening 2026-07-17-002, KTD5/KTD6, R9/R21): the
// server-only memory_operations ledger — deterministic operation IDs and Zep
// message UUIDs from the source-turn key, reference-only operation docs, and
// claim/complete/fail through the SHARED leased-operation engine in
// operations/externalSideEffect.ts (transactional claim, lease expiry,
// bounded attempts, exponential backoff with jitter, deduplicated terminal
// alert).
//
// Mock style mirrors the scheduled-test convention: in-memory Firestore built
// in vi.hoisted, state mutated in beforeEach — never a mock returned from it.

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();

  // Dot-path aware update + FieldValue.delete sentinel support.
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
      data: () => (data === undefined ? undefined : { ...data }),
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

  // Transactions serialize through a promise chain so two concurrent claims
  // cannot interleave their read-then-write (the real Firestore guarantee the
  // engine relies on).
  let txChain: Promise<unknown> = Promise.resolve();
  const dbObj = {
    collection: (name: string) => ({
      doc: (id: string) => makeDocRef(`${name}/${id}`),
    }),
    doc: (path: string) => makeDocRef(path),
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

  return { docs, dbObj, DELETE_SENTINEL };
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

import {
  hashSourceTurnKey,
  turnSyncOperationId,
  deriveZepMessageUuid,
  buildTurnSyncOperationDoc,
  buildFactChangeOperationDoc,
  buildMcpMemoryFileOperationDoc,
  buildReRememberOperationDoc,
  factChangeOperationId,
  reRememberOperationId,
  getMemoryReconciliationState,
  hasUnresolvedReconciliation,
  reconciliationFlagAdd,
  claimMemoryOperation,
  completeMemoryOperation,
  failMemoryOperation,
  markMemoryOperationTarget,
  memoryOperationRetryDelayMs,
  MEMORY_OPERATION_MAX_ATTEMPTS,
  MEMORY_OPERATION_RETRY_BASE_MS,
  MEMORY_OPERATION_RETRY_MAX_MS,
  MEMORY_OPERATION_LEASE_MS,
  COMPLETED_MEMORY_OPERATION_TTL_MS,
  MEMORY_RECONCILIATION_COLLECTION,
} from "./memoryOperations";

const PHONE = "+14085550001";
const SOURCE_KEY = "linq-event-abc-123";

function seedOperation(overrides: Record<string, unknown> = {}): string {
  const { operationId, doc } = buildTurnSyncOperationDoc({
    channel: "linq",
    sourceKey: SOURCE_KEY,
    phone: PHONE,
    userId: "user-1",
    turnTimestampMs: Date.parse("2026-07-17T10:00:00Z"),
    extractFacts: true,
    userMessagePath: `agent_conversations/${PHONE}/messages/turn_x_user`,
    assistantMessagePath: `agent_conversations/${PHONE}/messages/turn_x_assistant`,
  });
  h.docs.set(`memory_operations/${operationId}`, { ...(doc as unknown as Record<string, unknown>), ...overrides });
  return operationId;
}

beforeEach(() => {
  h.docs.clear();
});

// ── Deterministic keys (R9/KTD5) ─────────────────────────────────────────────

describe("deterministic keys", () => {
  it("hashSourceTurnKey is stable, channel-scoped, and never contains the raw key", () => {
    const a = hashSourceTurnKey("linq", SOURCE_KEY);
    expect(hashSourceTurnKey("linq", SOURCE_KEY)).toBe(a);
    expect(hashSourceTurnKey("web", SOURCE_KEY)).not.toBe(a); // web clientMessageId can never collide with a Linq eventId
    expect(hashSourceTurnKey("linq", "other-key")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain(SOURCE_KEY);
    expect(turnSyncOperationId(a)).toBe(`turn_sync_${a}`);
  });

  it("deriveZepMessageUuid is a stable RFC-4122-shaped v5 UUID, distinct per role and per key", () => {
    const u1 = deriveZepMessageUuid("web", "client-msg-1", "user");
    expect(deriveZepMessageUuid("web", "client-msg-1", "user")).toBe(u1);
    expect(u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveZepMessageUuid("web", "client-msg-1", "assistant")).not.toBe(u1);
    expect(deriveZepMessageUuid("web", "client-msg-2", "user")).not.toBe(u1);
    expect(deriveZepMessageUuid("linq", "client-msg-1", "user")).not.toBe(u1);
  });
});

// ── Operation document schema + privacy (Data Changes, R14/R21) ──────────────

describe("buildTurnSyncOperationDoc", () => {
  it("carries the full ledger schema with per-target statuses and pre-dispatch Zep UUIDs", () => {
    const ts = Date.parse("2026-07-17T10:00:00Z");
    const { operationId, doc } = buildTurnSyncOperationDoc({
      channel: "web", sourceKey: "cmid-1", phone: PHONE, userId: "user-9",
      turnTimestampMs: ts, extractFacts: true,
      userMessagePath: "agent_conversations/x/messages/u",
      assistantMessagePath: "agent_conversations/x/messages/a",
    });
    expect(operationId).toBe(turnSyncOperationId(hashSourceTurnKey("web", "cmid-1")));
    expect(doc.kind).toBe("turn_sync");
    expect(doc.userId).toBe("user-9");
    expect(doc.sessionRef).toBe(`agent_sessions/${PHONE}`);
    expect(doc.sourceChannel).toBe("web");
    expect(doc.sourceMessageRefs).toEqual(["agent_conversations/x/messages/u", "agent_conversations/x/messages/a"]);
    expect(doc.learnedFactRefs).toEqual([]);
    expect(doc.sourceTurnTimestamp).toBe(ts);
    // Deterministic per-role UUIDs are persisted BEFORE any dispatch (KTD5).
    expect(doc.zepMessageUuids).toEqual({
      user: deriveZepMessageUuid("web", "cmid-1", "user"),
      assistant: deriveZepMessageUuid("web", "cmid-1", "assistant"),
    });
    expect(doc.status).toBe("pending");
    expect(doc.attempts).toBe(0);
    expect(typeof doc.nextRetryAt).toBe("string"); // pending work is immediately due
    expect(doc.leaseOwner).toBeNull();
    expect(doc.leaseExpiresAt).toBeNull();
    expect(doc.completedAt).toBeNull();
    expect(doc.expiresAt).toBeNull(); // only completion sets retention expiry
    expect(Object.keys(doc.targets).sort()).toEqual([
      "embeddings", "firestore", "learnedFacts", "storage", "zepEdges", "zepEpisodes", "zepTranscript",
    ]);
    expect(doc.targets.firestore.status).toBe("completed"); // same-batch rows
    expect(doc.targets.zepTranscript.status).toBe("pending");
    expect(doc.targets.learnedFacts.status).toBe("pending");
    expect(doc.targets.storage.status).toBe("skipped");
  });

  it("caregiver/system turns mark the learnedFacts target skipped (R8)", () => {
    const { doc } = buildTurnSyncOperationDoc({
      channel: "linq", sourceKey: "e1", phone: PHONE, userId: "cg-1",
      turnTimestampMs: Date.now(), extractFacts: false,
      userMessagePath: "p/u", assistantMessagePath: "p/a",
    });
    expect(doc.targets.learnedFacts.status).toBe("skipped");
  });

  it("contains references and hashes only — no message text, no phone scalar, no Zep thread/user IDs, no raw provider key", () => {
    const { doc } = buildTurnSyncOperationDoc({
      channel: "linq", sourceKey: SOURCE_KEY, phone: PHONE, userId: "user-1",
      turnTimestampMs: Date.now(), extractFacts: true,
      userMessagePath: `agent_conversations/${PHONE}/messages/turn_x_user`,
      assistantMessagePath: `agent_conversations/${PHONE}/messages/turn_x_assistant`,
    });
    const record = doc as unknown as Record<string, unknown>;
    // No forbidden scalar fields at all.
    for (const forbidden of ["phone", "content", "text", "userText", "assistantText", "zepThreadId", "zepUserId", "threadId", "sourceKey", "eventId", "clientMessageId", "query", "prompt", "reply"]) {
      expect(record[forbidden], `field '${forbidden}' must not exist`).toBeUndefined();
    }
    // No top-level scalar equals the phone (paths may embed it — accepted).
    for (const value of Object.values(record)) {
      expect(value).not.toBe(PHONE);
    }
    // The raw provider event ID is never stored — an opaque hash is sufficient.
    expect(JSON.stringify(doc)).not.toContain(SOURCE_KEY);
  });
});

// ── Claim / complete / fail through the shared engine (KTD6) ─────────────────

describe("claim/complete/fail (shared leased-operation engine)", () => {
  it("claims a pending operation: processing, attempts=1, lease mirrored into nextRetryAt", async () => {
    const opId = seedOperation();
    const claim = await claimMemoryOperation(opId);
    expect(claim).not.toBeNull();
    expect(claim!.attemptCount).toBe(1);
    const doc = h.docs.get(`memory_operations/${opId}`)!;
    expect(doc.status).toBe("processing");
    expect(doc.leaseOwner).toBe(claim!.leaseOwner);
    // Mirroring lets the (status, nextRetryAt) index find expired leases.
    expect(doc.nextRetryAt).toBe(doc.leaseExpiresAt);
    const leaseMs = Date.parse(String(doc.leaseExpiresAt)) - Date.now();
    expect(leaseMs).toBeGreaterThan(MEMORY_OPERATION_LEASE_MS - 5_000);
    expect(leaseMs).toBeLessThanOrEqual(MEMORY_OPERATION_LEASE_MS + 5_000);
  });

  it("two workers claim once — the transactional claim admits exactly one", async () => {
    const opId = seedOperation();
    const [a, b] = await Promise.all([claimMemoryOperation(opId), claimMemoryOperation(opId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("a claim on a missing operation never fabricates a doc", async () => {
    expect(await claimMemoryOperation("turn_sync_does_not_exist")).toBeNull();
    expect(h.docs.has("memory_operations/turn_sync_does_not_exist")).toBe(false);
  });

  it("an expired lease is reclaimed (worker crash recovery) with a fresh attempt", async () => {
    const opId = seedOperation({
      status: "processing",
      attempts: 2,
      leaseOwner: "memory-worker-dead",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const claim = await claimMemoryOperation(opId);
    expect(claim).not.toBeNull();
    expect(claim!.attemptCount).toBe(3);
    expect(claim!.leaseOwner).not.toBe("memory-worker-dead");
  });

  it("a live lease is NOT reclaimed", async () => {
    const opId = seedOperation({
      status: "processing",
      attempts: 1,
      leaseOwner: "memory-worker-alive",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await claimMemoryOperation(opId)).toBeNull();
  });

  it("complete finalizes with completedAt and a 30-day retention expiresAt; wrong lease owner is rejected", async () => {
    const opId = seedOperation();
    const claim = await claimMemoryOperation(opId);
    expect(await completeMemoryOperation(opId, "someone-else")).toBe(false);
    expect(await completeMemoryOperation(opId, claim!.leaseOwner)).toBe(true);
    const doc = h.docs.get(`memory_operations/${opId}`)!;
    expect(doc.status).toBe("completed");
    expect(typeof doc.completedAt).toBe("string");
    const ttl = Date.parse(String(doc.expiresAt)) - Date.now();
    expect(Math.abs(ttl - COMPLETED_MEMORY_OPERATION_TTL_MS)).toBeLessThan(10_000);
    // A completed operation can never be re-claimed.
    expect(await claimMemoryOperation(opId)).toBeNull();
  });

  it("fail schedules a jittered exponential retry and records the SANITIZED error class, never the message", async () => {
    const opId = seedOperation();
    const claim = await claimMemoryOperation(opId);
    const result = await failMemoryOperation(opId, claim!.leaseOwner, new Error(`zep exploded for ${PHONE} secret content`));
    expect(result).toBe("retryable");
    const doc = h.docs.get(`memory_operations/${opId}`)!;
    expect(doc.status).toBe("retryable_failed");
    expect(doc.leaseOwner).toBeNull();
    const delay = Date.parse(String(doc.nextRetryAt)) - Date.now();
    expect(delay).toBeGreaterThan(MEMORY_OPERATION_RETRY_BASE_MS - 5_000);
    expect(delay).toBeLessThanOrEqual(MEMORY_OPERATION_RETRY_BASE_MS * 1.2 + 5_000);
    // R21: error class only — no phone, no message text.
    expect(doc.lastErrorCode).toBe("Error");
    expect(JSON.stringify(doc)).not.toContain("secret content");
    // Not yet due → not claimable.
    expect(await claimMemoryOperation(opId)).toBeNull();
  });

  it("retry backoff grows exponentially with jitter and is capped", () => {
    const d1 = memoryOperationRetryDelayMs(1);
    expect(d1).toBeGreaterThanOrEqual(MEMORY_OPERATION_RETRY_BASE_MS);
    expect(d1).toBeLessThanOrEqual(MEMORY_OPERATION_RETRY_BASE_MS * 1.2);
    const d3 = memoryOperationRetryDelayMs(3);
    expect(d3).toBeGreaterThanOrEqual(MEMORY_OPERATION_RETRY_BASE_MS * 4);
    const d20 = memoryOperationRetryDelayMs(20);
    expect(d20).toBeLessThanOrEqual(MEMORY_OPERATION_RETRY_MAX_MS * 1.2);
  });

  it("terminal failure after max attempts writes ONE deduplicated alert; later fails are ignored", async () => {
    const opId = seedOperation({ status: "retryable_failed", attempts: MEMORY_OPERATION_MAX_ATTEMPTS - 1, nextRetryAt: new Date(Date.now() - 1000).toISOString() });
    const claim = await claimMemoryOperation(opId); // attempt == MAX
    expect(claim!.attemptCount).toBe(MEMORY_OPERATION_MAX_ATTEMPTS);
    const result = await failMemoryOperation(opId, claim!.leaseOwner, new Error("boom"));
    expect(result).toBe("terminal");
    const doc = h.docs.get(`memory_operations/${opId}`)!;
    expect(doc.status).toBe("terminal_failed");
    expect(doc.expiresAt).toBeNull(); // failed operations never auto-expire

    const alertPath = `admin_alerts/memory-operation:${opId}`;
    expect(h.docs.has(alertPath)).toBe(true);
    const alert = h.docs.get(alertPath)!;
    expect(alert.type).toBe("memory_operation_terminal_failure");
    // Alert carries the opaque operation reference only (R21).
    expect(JSON.stringify(alert)).not.toContain(PHONE);
    expect(JSON.stringify(alert)).not.toContain("boom");

    // A second fail with a stale lease is ignored and cannot double-alert.
    expect(await failMemoryOperation(opId, claim!.leaseOwner, new Error("boom2"))).toBe("ignored");
    const alertDocs = [...h.docs.keys()].filter(k => k.startsWith("admin_alerts/"));
    expect(alertDocs).toHaveLength(1);
  });

  it("a claim that would exceed max attempts terminal-fails the operation and still alerts (crash on final attempt)", async () => {
    const opId = seedOperation({
      status: "processing",
      attempts: MEMORY_OPERATION_MAX_ATTEMPTS,
      leaseOwner: "memory-worker-dead",
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await claimMemoryOperation(opId)).toBeNull();
    expect(h.docs.get(`memory_operations/${opId}`)!.status).toBe("terminal_failed");
    expect(h.docs.has(`admin_alerts/memory-operation:${opId}`)).toBe(true);
  });

  it("markMemoryOperationTarget updates one per-target status without touching others", async () => {
    const opId = seedOperation();
    await markMemoryOperationTarget(opId, "zepTranscript", "completed");
    const doc = h.docs.get(`memory_operations/${opId}`) as any;
    expect(doc.targets.zepTranscript.status).toBe("completed");
    expect(doc.targets.learnedFacts.status).toBe("pending");
    expect(doc.targets.firestore.status).toBe("completed");
  });
});

// ── U4a: correction/forget operation builders (KTD9, R14/R21) ────────────────

describe("fact-change operations (U4a)", () => {
  it("factChangeOperationId is deterministic per (kind, user, fact, generation) and distinct across each", () => {
    const a = factChangeOperationId("forget", "user-1", "nf_abc", 0);
    expect(factChangeOperationId("forget", "user-1", "nf_abc", 0)).toBe(a);
    expect(a).toMatch(/^forget_[0-9a-f]{32}$/);
    expect(factChangeOperationId("correction", "user-1", "nf_abc", 0)).not.toBe(a);
    expect(factChangeOperationId("forget", "user-2", "nf_abc", 0)).not.toBe(a);
    expect(factChangeOperationId("forget", "user-1", "nf_def", 0)).not.toBe(a);
    // A re-remembered fact starts a NEW lifecycle → a fresh deterministic ID.
    expect(factChangeOperationId("forget", "user-1", "nf_abc", 1)).not.toBe(a);
    expect(reRememberOperationId("user-1", "nf_abc", 0)).toMatch(/^re_remember_[0-9a-f]{32}$/);
  });

  it("buildFactChangeOperationDoc: pending per-target statuses for the five propagation targets, n/a targets skipped", () => {
    const { operationId, doc } = buildFactChangeOperationDoc({
      kind: "forget",
      userId: "user-1",
      phone: PHONE,
      targetFactDocId: "nf_abc",
      targetFactPath: "learned_facts/user-1/facts/nf_abc",
      sourceMessageRefs: ["agent_conversations/x/messages/m1"],
    });
    expect(operationId).toBe(factChangeOperationId("forget", "user-1", "nf_abc", 0));
    expect(doc.kind).toBe("forget");
    expect(doc.status).toBe("pending");
    expect(doc.learnedFactRefs).toEqual(["learned_facts/user-1/facts/nf_abc"]);
    expect(doc.targets.learnedFacts.status).toBe("pending");
    expect(doc.targets.storage.status).toBe("pending");
    expect(doc.targets.embeddings.status).toBe("pending");
    expect(doc.targets.zepEdges.status).toBe("pending");
    expect(doc.targets.zepEpisodes.status).toBe("pending");
    expect(doc.targets.firestore.status).toBe("skipped");
    expect(doc.targets.zepTranscript.status).toBe("skipped");
    expect(doc.expiresAt).toBeNull(); // unresolved fact changes never auto-expire
  });

  it("a correction doc carries BOTH fact refs (old + replacement) — references only, never text", () => {
    const { doc } = buildFactChangeOperationDoc({
      kind: "correction",
      userId: "user-1",
      targetFactDocId: "nf_old",
      targetFactPath: "learned_facts/user-1/facts/nf_old",
      replacementFactPath: "learned_facts/user-1/facts/nf_new",
    });
    expect(doc.learnedFactRefs).toEqual([
      "learned_facts/user-1/facts/nf_old",
      "learned_facts/user-1/facts/nf_new",
    ]);
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("shellfish");
    for (const forbidden of ["fact", "text", "content", "phone", "query", "prompt", "reply"]) {
      expect((doc as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it("MCP file changes begin pending across every stale-memory target", () => {
    const { operationId, doc } = buildMcpMemoryFileOperationDoc({
      kind: "forget",
      userId: "user-1",
      phone: PHONE,
      fileSlug: "health",
      changeKey: "opaque-change-key",
      tombstoneFactPath: "learned_facts/user-1/facts/nf_retired",
    });
    expect(operationId).toMatch(/^mcpfile_forget_[0-9a-f]{32}$/);
    expect(doc.status).toBe("pending");
    expect(doc.nextRetryAt).toEqual(expect.any(String));
    expect(doc.completedAt).toBeNull();
    expect(doc.expiresAt).toBeNull();
    expect(doc.learnedFactRefs).toEqual(["learned_facts/user-1/facts/nf_retired"]);
    for (const target of ["learnedFacts", "storage", "embeddings", "zepEdges", "zepEpisodes"] as const) {
      expect(doc.targets[target].status).toBe("pending");
    }
    expect(JSON.stringify(doc)).not.toContain("retired assertion");
  });

  it("buildReRememberOperationDoc is born completed with a retention expiry — pure audit-by-reference", () => {
    const { operationId, doc } = buildReRememberOperationDoc({
      userId: "user-1",
      targetFactDocId: "nf_abc",
      targetFactPath: "learned_facts/user-1/facts/nf_abc",
      changeGeneration: 2,
    });
    expect(operationId).toBe(reRememberOperationId("user-1", "nf_abc", 2));
    expect(doc.kind).toBe("re_remember");
    expect(doc.status).toBe("completed");
    expect(doc.completedAt).toEqual(expect.any(String));
    expect(doc.expiresAt).toEqual(expect.any(String));
    expect(doc.targets.learnedFacts.status).toBe("completed");
    expect(doc.targets.storage.status).toBe("skipped");
  });
});

// ── U4a: per-user reconciliation flag + per-store masking (KTD9) ─────────────

describe("getMemoryReconciliationState (U4a suppression check)", () => {
  const UID = "user-1";
  const flagPath = `${MEMORY_RECONCILIATION_COLLECTION}/${UID}`;

  function seedFactChangeOp(
    operationId: string,
    kind: "correction" | "forget",
    targetOverrides: Record<string, { status: string }> = {},
    status = "pending",
  ): void {
    const { doc } = buildFactChangeOperationDoc({
      kind, userId: UID, targetFactDocId: "nf_abc",
      targetFactPath: `learned_facts/${UID}/facts/nf_abc`,
    });
    const record = doc as unknown as Record<string, unknown>;
    record.status = status;
    record.targets = { ...(record.targets as Record<string, unknown>), ...targetOverrides };
    h.docs.set(`memory_operations/${operationId}`, record);
  }

  function seedFlag(...operationIds: Array<[string, "correction" | "forget"]>): void {
    const pendingOperations: Record<string, unknown> = {};
    for (const [id, kind] of operationIds) pendingOperations[id] = { kind, createdAt: new Date().toISOString() };
    h.docs.set(flagPath, { pendingOperations, updatedAt: new Date().toISOString() });
  }

  it("no flag doc → cheap all-clear (one point read, nothing masked)", async () => {
    const state = await getMemoryReconciliationState(UID);
    expect(state).toEqual({ pending: false, storageMasked: false, zepMasked: false, pendingOperationIds: [] });
    expect(await hasUnresolvedReconciliation(UID)).toBe(false);
  });

  it("an unresolved forget masks BOTH stores while all targets are pending", async () => {
    seedFactChangeOp("forget_op1", "forget");
    seedFlag(["forget_op1", "forget"]);
    const state = await getMemoryReconciliationState(UID);
    expect(state.pending).toBe(true);
    expect(state.storageMasked).toBe(true);
    expect(state.zepMasked).toBe(true);
    expect(state.pendingOperationIds).toEqual(["forget_op1"]);
  });

  it("per-store unmask: storage+embeddings confirmed → Storage returns while Zep stays masked", async () => {
    seedFactChangeOp("forget_op1", "forget", {
      storage: { status: "completed" },
      embeddings: { status: "completed" },
    });
    seedFlag(["forget_op1", "forget"]);
    const state = await getMemoryReconciliationState(UID);
    expect(state.pending).toBe(true);
    expect(state.storageMasked).toBe(false); // unmasked per-store
    expect(state.zepMasked).toBe(true);      // still reconciling
  });

  it("a FAILED target stays masked (failed work remains masked and retryable)", async () => {
    seedFactChangeOp("forget_op1", "forget", {
      storage: { status: "failed" },
      embeddings: { status: "completed" },
      zepEdges: { status: "completed" },
      zepEpisodes: { status: "completed" },
    }, "retryable_failed");
    seedFlag(["forget_op1", "forget"]);
    const state = await getMemoryReconciliationState(UID);
    expect(state.storageMasked).toBe(true);
    expect(state.zepMasked).toBe(false);
  });

  it("fails closed when the flag exceeds the bounded operation inspection cap", async () => {
    const entries = Array.from({ length: 21 }, (_, i) => [`forget_${i}`, "forget"] as [string, "forget"]);
    seedFlag(...entries);
    const state = await getMemoryReconciliationState(UID);
    expect(state).toMatchObject({ pending: true, storageMasked: true, zepMasked: true });
    expect(state.pendingOperationIds).toHaveLength(20);
  });

  it("completed and expired (missing) operations self-heal out of the flag → all clear again", async () => {
    seedFactChangeOp("correction_done", "correction", {
      learnedFacts: { status: "completed" }, storage: { status: "completed" },
      embeddings: { status: "completed" }, zepEdges: { status: "completed" },
      zepEpisodes: { status: "completed" },
    }, "completed");
    // "forget_gone" has no operation doc at all — expired after completion.
    seedFlag(["correction_done", "correction"], ["forget_gone", "forget"]);

    const state = await getMemoryReconciliationState(UID);
    expect(state).toMatchObject({ pending: false, storageMasked: false, zepMasked: false });
    // Self-heal removed both entries (best-effort update).
    const flag = h.docs.get(flagPath)!;
    expect(flag.pendingOperations).toEqual({});
  });

  it("reconciliationFlagAdd carries operation IDs/kinds only — no fact text field shape", () => {
    const patch = reconciliationFlagAdd("forget_abc", "forget");
    expect(Object.keys(patch).sort()).toEqual(["pendingOperations", "updatedAt"]);
    expect((patch.pendingOperations as Record<string, unknown>).forget_abc).toMatchObject({ kind: "forget" });
  });
});
