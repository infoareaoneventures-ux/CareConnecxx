import { describe, it, expect, vi, beforeEach } from "vitest";

// U4b (memory-grounding hardening 2026-07-17-002, R11/R23, U4 approach):
// the legacy delete_memory_file / edit_memory_file MCP tools route through the
// correction/forget pipeline semantics —
//   • the model-supplied userId is validated against the VERIFIED session
//     identity (agent_sessions/{phone}.userId); mismatches are rejected,
//   • a change that removed fact content records a completed memory operation
//     (audit-by-reference; never the edited text) + a retired-text tombstone
//     + the durable memory_fact_* audit entry,
//   • cara_knows returns the deterministic reconciliation-pending copy while
//     the user's Storage memory is masked — never the generic amnesia fallback.
//
// Harness mirrors crudTools.test.ts (in-memory Firestore; where/orderBy/limit
// are pass-through on the base collection ref).

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${sets.length}`;
      sets.push({ path, data });
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; updates.length = 0; },
    deleteMemoryFile: vi.fn(async (_u: string, _f: string) => true),
    editMemoryFile: vi.fn(async (_u: string, _f: string, _find: string, _rep: string) => 1),
    getMemoryContext: vi.fn(async (_u: string) => "## profile\nSenior: Margaret"),
    listMemoryFiles: vi.fn(async (_u: string) => ["profile"]),
    stampTombstone: vi.fn(async (_p: unknown) => ({ factDocId: "nf_tombstone" })),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue(""),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  editMemoryFile:  hoisted.editMemoryFile,
  deleteMemoryFile: hoisted.deleteMemoryFile,
  searchMemoryHybrid: vi.fn().mockResolvedValue([]),
  getMemoryContext: hoisted.getMemoryContext,
  listMemoryFiles: hoisted.listMemoryFiles,
  MEMORY_QUERY_RECONCILIATION_COPY: "RECONCILIATION_PENDING_COPY",
  MemoryFile: {},
}));

// Dynamic import inside the tools — mocked so no OpenAI/embeddings graph loads.
vi.mock("../../memory/learnedFacts", () => ({
  stampRetiredTextTombstone: hoisted.stampTombstone,
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue(null),
}));

// delete_memory_file is confirmation-gated (HIGH_RISK_TOOLS). The pending-action
// gate has its own dedicated suite — here it is bypassed so these tests drive
// the tool BODY (identity validation + pipeline routing), which runs after the
// gate on the real path.
vi.mock("../../agents/pendingActions", () => ({
  isHighRisk: () => false,
  proposePendingAction: vi.fn(),
  buildPendingActionStub: vi.fn(),
  getPendingActionById: vi.fn().mockResolvedValue(null),
  isConfirmedActionValid: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";
import { logAudit } from "../../observability/auditLog";

const PHONE = "+14085550001";
const USER = "u1";
const FIND = "Mom is allergic to penicillin";

function auditEvents(): string[] {
  return vi.mocked(logAudit).mock.calls.map(c => (c[0] as { eventType: string }).eventType);
}

function opSets() {
  return hoisted.sets.filter(s => s.path.startsWith("memory_operations/"));
}

beforeEach(() => {
  hoisted.reset();
  vi.mocked(logAudit).mockClear();
  hoisted.deleteMemoryFile.mockClear().mockResolvedValue(true);
  hoisted.editMemoryFile.mockClear().mockResolvedValue(1);
  hoisted.getMemoryContext.mockClear().mockResolvedValue("## profile\nSenior: Margaret");
  hoisted.listMemoryFiles.mockClear().mockResolvedValue(["profile"]);
  hoisted.stampTombstone.mockClear().mockResolvedValue({ factDocId: "nf_tombstone" });
  // Verified session identity for the phone qaAgent injects (R11 anchor).
  hoisted.docState.set(`agent_sessions/${PHONE}`, { userId: USER, userType: "client" });
});

describe("delete_memory_file — identity validation + pipeline routing (R11/R23)", () => {
  it("REJECTS a model-supplied userId that does not match the verified session identity", async () => {
    const r = await handleToolCall("delete_memory_file", {
      userId: "victim-user", file: "health", phone: PHONE,
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.deleteMemoryFile).not.toHaveBeenCalled();
    expect(opSets()).toHaveLength(0);
  });

  it("REJECTS a call without a verified session phone (fail closed)", async () => {
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "health" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.deleteMemoryFile).not.toHaveBeenCalled();
  });

  it("REJECTS when the session has no bound userId yet (unconfirmed identity)", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { userType: "client" });
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE }) as any;
    expect(r.code).toBe("PERMISSION_DENIED");
  });

  it("a valid deletion records a completed forget operation + durable audit (never a bare Storage mutation)", async () => {
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE }) as any;
    expect(r.success).toBe(true);
    expect(r.deleted).toBe(true);
    expect(hoisted.deleteMemoryFile).toHaveBeenCalledWith(USER, "health");

    const ops = opSets();
    expect(ops).toHaveLength(1);
    expect(ops[0].path).toMatch(/^memory_operations\/mcpfile_forget_[0-9a-f]{32}$/);
    expect(ops[0].data).toMatchObject({
      kind: "forget",
      userId: USER,
      fileSlug: "health",
      source: "mcp_memory_tool",
      status: "completed",
    });
    expect(typeof ops[0].data.completedAt).toBe("string");
    expect(typeof ops[0].data.expiresAt).toBe("string");

    // Durable audit + the existing memory_file_deleted audit both present.
    expect(auditEvents()).toContain("memory_fact_forgotten");
    expect(auditEvents()).toContain("memory_file_deleted");
  });

  it("the same request is idempotent — the deterministic operation ID is reused", async () => {
    await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE });
    await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE });
    const ops = opSets();
    expect(ops).toHaveLength(2);
    expect(ops[0].path).toBe(ops[1].path); // same doc — overwritten, never duplicated
  });

  it("deleting a file that never existed records no operation", async () => {
    hoisted.deleteMemoryFile.mockResolvedValueOnce(false);
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "ghost", phone: PHONE }) as any;
    expect(r.existed).toBe(false);
    expect(opSets()).toHaveLength(0);
    expect(auditEvents()).not.toContain("memory_fact_forgotten");
  });
});

describe("edit_memory_file — identity validation + pipeline routing (R11/R23)", () => {
  it("REJECTS a mismatched userId before touching Storage", async () => {
    const r = await handleToolCall("edit_memory_file", {
      userId: "victim-user", file: "health", find: FIND, replace: "x", phone: PHONE,
    }) as any;
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.editMemoryFile).not.toHaveBeenCalled();
  });

  it("a replacing edit records a completed CORRECTION operation + superseded tombstone + audit", async () => {
    const r = await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: FIND, replace: "Mom is allergic to amoxicillin", phone: PHONE,
    }) as any;
    expect(r.replaced).toBe(1);

    // R23: the retired text gets a superseded marker/tombstone so passive
    // extraction cannot silently restore it.
    expect(hoisted.stampTombstone).toHaveBeenCalledWith({
      userId: USER, retiredText: FIND, mode: "superseded",
    });

    const ops = opSets();
    expect(ops).toHaveLength(1);
    expect(ops[0].path).toMatch(/^memory_operations\/mcpfile_correction_[0-9a-f]{32}$/);
    expect(ops[0].data).toMatchObject({
      kind: "correction",
      userId: USER,
      fileSlug: "health",
      learnedFactRefs: [`learned_facts/${USER}/facts/nf_tombstone`],
    });
    // Ledger privacy: the edited text never lands in the operation record.
    expect(JSON.stringify(ops[0].data)).not.toContain("penicillin");
    expect(JSON.stringify(ops[0].data)).not.toContain("amoxicillin");

    expect(auditEvents()).toContain("memory_fact_corrected");
  });

  it("a removing edit (empty replace) records a FORGET operation with a forget-mode tombstone", async () => {
    await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: FIND, replace: "", phone: PHONE,
    });
    expect(hoisted.stampTombstone).toHaveBeenCalledWith({
      userId: USER, retiredText: FIND, mode: "forget",
    });
    const ops = opSets();
    expect(ops).toHaveLength(1);
    expect(ops[0].data.kind).toBe("forget");
    expect(auditEvents()).toContain("memory_fact_forgotten");
  });

  it("an edit that matched nothing records no operation and no tombstone", async () => {
    hoisted.editMemoryFile.mockResolvedValueOnce(0);
    const r = await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: "not present", replace: "x", phone: PHONE,
    }) as any;
    expect(r.matched).toBe(false);
    expect(hoisted.stampTombstone).not.toHaveBeenCalled();
    expect(opSets()).toHaveLength(0);
  });
});

describe("cara_knows — reconciliation-pending copy (U4b, KTD10)", () => {
  it("returns the deterministic reconciliation copy (never the amnesia fallback) while Storage is masked", async () => {
    hoisted.docState.set(`memory_reconciliation/${USER}`, {
      pendingOperations: { forget_op1: { kind: "forget", createdAt: new Date().toISOString() } },
    });
    hoisted.docState.set("memory_operations/forget_op1", {
      kind: "forget", userId: USER, status: "pending",
      targets: {
        storage: { status: "pending" }, embeddings: { status: "pending" },
        zepEdges: { status: "pending" }, zepEpisodes: { status: "pending" },
        learnedFacts: { status: "pending" },
      },
    });

    const r = await handleToolCall("cara_knows", { userId: USER, phone: PHONE }) as any;

    expect(r.success).toBe(true);
    expect(r.reconciliationPending).toBe(true);
    expect(r.context).toBe("RECONCILIATION_PENDING_COPY");
    expect(r.context).not.toContain("no memory files on file yet");
    expect(hoisted.getMemoryContext).not.toHaveBeenCalled();
  });

  it("per-store: once Storage targets confirm, cara_knows reads normally even while Zep is masked", async () => {
    hoisted.docState.set(`memory_reconciliation/${USER}`, {
      pendingOperations: { forget_op1: { kind: "forget", createdAt: new Date().toISOString() } },
    });
    hoisted.docState.set("memory_operations/forget_op1", {
      kind: "forget", userId: USER, status: "retryable_failed",
      targets: {
        storage: { status: "completed" }, embeddings: { status: "completed" },
        zepEdges: { status: "failed" }, zepEpisodes: { status: "failed" },
        learnedFacts: { status: "pending" },
      },
    });

    const r = await handleToolCall("cara_knows", { userId: USER, phone: PHONE }) as any;

    expect(r.reconciliationPending).toBeUndefined();
    expect(r.context).toContain("Margaret");
  });

  it("all-clear users get the normal context", async () => {
    const r = await handleToolCall("cara_knows", { userId: USER, phone: PHONE }) as any;
    expect(r.context).toContain("Margaret");
    expect(r.files).toEqual(["profile"]);
  });
});
