import { describe, it, expect, vi, beforeEach } from "vitest";

// U4b (memory-grounding hardening 2026-07-17-002, R11/R23, U4 approach):
// the legacy delete_memory_file / edit_memory_file MCP tools route through the
// correction/forget pipeline semantics —
//   • the model-supplied userId is validated against the VERIFIED session
//     identity (agent_sessions/{phone}.userId); mismatches are rejected,
//   • a change that removes fact content stages a pending all-target operation
//     and retired-text tombstone before Storage mutation, then the worker owns
//     reconciliation and completion,
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
    writeMemoryFile: vi.fn(async (_u: string, _f: string, _content: string) => undefined),
    findTombstonedRestatement: vi.fn(async (_u: string, _text: string) => null as unknown),
    getMemoryContext: vi.fn(async (_u: string) => "## profile\nSenior: Margaret"),
    listMemoryFiles: vi.fn(async (_u: string) => ["profile"]),
    readMemoryFile: vi.fn(async (_u: string, _f: string) => "Mom is allergic to penicillin"),
    stageMemoryChange: vi.fn(async (_p: unknown) => ({ ok: true, operationId: "mcpfile_forget_test", factDocId: "nf_tombstone" })),
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
      Timestamp: {
        fromMillis: (ms: number) => ({ __timestampMillis: ms }),
      },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  hoisted.readMemoryFile,
  writeMemoryFile: hoisted.writeMemoryFile,
  editMemoryFile:  hoisted.editMemoryFile,
  deleteMemoryFile: hoisted.deleteMemoryFile,
  searchMemoryHybrid: vi.fn().mockResolvedValue([]),
  getMemoryContext: hoisted.getMemoryContext,
  listMemoryFiles: hoisted.listMemoryFiles,
  isTransientToolFile: (file: string) => String(file).startsWith("tool_"),
  MEMORY_QUERY_RECONCILIATION_COPY: "RECONCILIATION_PENDING_COPY",
  MemoryFile: {},
}));

// Dynamic import inside the tools — mocked so no OpenAI/embeddings graph loads.
vi.mock("../../memory/learnedFacts", () => ({
  stageMcpMemoryFileChange: hoisted.stageMemoryChange,
  findTombstonedRestatement: hoisted.findTombstonedRestatement,
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

beforeEach(() => {
  hoisted.reset();
  vi.mocked(logAudit).mockReset().mockResolvedValue(undefined);
  hoisted.deleteMemoryFile.mockClear().mockResolvedValue(true);
  hoisted.editMemoryFile.mockClear().mockResolvedValue(1);
  hoisted.getMemoryContext.mockClear().mockResolvedValue("## profile\nSenior: Margaret");
  hoisted.listMemoryFiles.mockClear().mockResolvedValue(["profile"]);
  hoisted.readMemoryFile.mockClear().mockResolvedValue(FIND);
  hoisted.writeMemoryFile.mockClear().mockResolvedValue(undefined);
  hoisted.findTombstonedRestatement.mockClear().mockResolvedValue(null);
  hoisted.stageMemoryChange.mockClear().mockResolvedValue({ ok: true, operationId: "mcpfile_forget_test", factDocId: "nf_tombstone" });
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
    expect(hoisted.stageMemoryChange).not.toHaveBeenCalled();
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

  it("stages a pending forget before deleting Storage and writes the durable audit", async () => {
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE }) as any;
    expect(r.success).toBe(true);
    expect(r.deleted).toBe(true);
    expect(hoisted.deleteMemoryFile).toHaveBeenCalledWith(USER, "health");

    expect(hoisted.stageMemoryChange).toHaveBeenCalledWith(expect.objectContaining({
      kind: "forget",
      userId: USER,
      fileSlug: "health",
      retiredText: FIND,
    }));
    expect(hoisted.stageMemoryChange.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.deleteMemoryFile.mock.invocationCallOrder[0]);

    // Durable audit + the existing memory_file_deleted audit both present.
    expect(auditEvents()).toContain("memory_fact_forgotten");
    expect(auditEvents()).toContain("memory_file_deleted");
  });

  it("reuses the staging path for a repeated request before each idempotent Storage delete", async () => {
    await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE });
    await handleToolCall("delete_memory_file", { userId: USER, file: "health", phone: PHONE });
    expect(hoisted.stageMemoryChange).toHaveBeenCalledTimes(2);
  });

  it("deleting a file that never existed records no operation", async () => {
    hoisted.readMemoryFile.mockResolvedValueOnce("");
    hoisted.deleteMemoryFile.mockResolvedValueOnce(false);
    const r = await handleToolCall("delete_memory_file", { userId: USER, file: "ghost", phone: PHONE }) as any;
    expect(r.existed).toBe(false);
    expect(hoisted.stageMemoryChange).not.toHaveBeenCalled();
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

  it("stages a correction before editing Storage and records a durable audit", async () => {
    const r = await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: FIND, replace: "Mom is allergic to amoxicillin", phone: PHONE,
    }) as any;
    expect(r.replaced).toBe(1);

    expect(hoisted.stageMemoryChange).toHaveBeenCalledWith(expect.objectContaining({
      kind: "correction",
      userId: USER,
      fileSlug: "health",
      retiredText: FIND,
    }));
    expect(hoisted.stageMemoryChange.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.editMemoryFile.mock.invocationCallOrder[0]);

    expect(auditEvents()).toContain("memory_fact_corrected");
  });

  it("a removing edit stages a forget operation before Storage", async () => {
    await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: FIND, replace: "", phone: PHONE,
    });
    expect(hoisted.stageMemoryChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "forget", retiredText: FIND }));
    expect(auditEvents()).toContain("memory_fact_forgotten");
  });

  it("an edit that matched nothing records no operation and no tombstone", async () => {
    hoisted.editMemoryFile.mockResolvedValueOnce(0);
    const r = await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: "not present", replace: "x", phone: PHONE,
    }) as any;
    expect(r.matched).toBe(false);
    expect(hoisted.stageMemoryChange).not.toHaveBeenCalled();
  });

  it("does not mutate Storage when the durable memory audit write fails", async () => {
    vi.mocked(logAudit).mockImplementation((entry: any) =>
      entry.eventType === "memory_fact_corrected"
        ? Promise.reject(new Error("ledger unavailable"))
        : Promise.resolve(undefined),
    );

    const r = await handleToolCall("edit_memory_file", {
      userId: USER, file: "health", find: FIND, replace: "Mom is allergic to amoxicillin", phone: PHONE,
    }) as any;

    expect(r._toolError).toBe(true);
    expect(hoisted.stageMemoryChange).toHaveBeenCalledTimes(1);
    expect(hoisted.editMemoryFile).not.toHaveBeenCalled();
  });
});

describe("update_memory_file — identity validation + tombstone guard (R11/R23)", () => {
  const CONTENT = "Mom prefers chamomile tea in the evening";

  it("REJECTS a model-supplied userId that does not match the verified session identity", async () => {
    const r = await handleToolCall("update_memory_file", {
      userId: "victim-user", file: "health", content: CONTENT, phone: PHONE,
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.writeMemoryFile).not.toHaveBeenCalled();
  });

  it("REJECTS a call without a verified session phone (fail closed)", async () => {
    const r = await handleToolCall("update_memory_file", {
      userId: USER, file: "health", content: CONTENT,
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.writeMemoryFile).not.toHaveBeenCalled();
  });

  it("REJECTS when the session has no bound userId yet (unconfirmed identity)", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { userType: "client" });
    const r = await handleToolCall("update_memory_file", {
      userId: USER, file: "health", content: CONTENT, phone: PHONE,
    }) as any;
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.writeMemoryFile).not.toHaveBeenCalled();
  });

  it("REFUSES appending content that restates a tombstoned/superseded fact (R23) — no write", async () => {
    hoisted.findTombstonedRestatement.mockResolvedValueOnce({
      factDocId: "nf_tombstone", fact: FIND, category: "medical",
    });
    const r = await handleToolCall("update_memory_file", {
      userId: USER, file: "health", content: FIND, phone: PHONE,
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toMatch(/forget|forgot/i);
    expect(r.message).toMatch(/confirm/i);
    expect(hoisted.findTombstonedRestatement).toHaveBeenCalledWith(USER, FIND);
    expect(hoisted.writeMemoryFile).not.toHaveBeenCalled();
  });

  it("a normal append still works: identity verified, no tombstone hit, content appended", async () => {
    const r = await handleToolCall("update_memory_file", {
      userId: USER, file: "health", content: CONTENT, phone: PHONE,
    }) as any;
    expect(r).toMatchObject({ success: true, updated: true });
    expect(hoisted.findTombstonedRestatement).toHaveBeenCalledWith(USER, CONTENT);
    // Appends to the existing file content rather than replacing it.
    expect(hoisted.writeMemoryFile).toHaveBeenCalledWith(USER, "health", `${FIND}\n\n${CONTENT}`);
  });
});

describe("read_memory_file — reconciliation masking", () => {
  function seedPendingForget(): void {
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
  }

  it("masks durable files while Storage reconciliation is pending", async () => {
    seedPendingForget();
    const r = await handleToolCall("read_memory_file", { userId: USER, file: "profile" }) as any;
    expect(r).toMatchObject({ success: true, content: "", empty: true, reconciliationPending: true });
    expect(hoisted.readMemoryFile).not.toHaveBeenCalled();
  });

  it("allows an exact transient tool_* pointer while durable memory is masked", async () => {
    seedPendingForget();
    const r = await handleToolCall("read_memory_file", { userId: USER, file: "tool_invoice_history_1" }) as any;
    expect(r).toMatchObject({ success: true, content: FIND, empty: false });
    expect(hoisted.readMemoryFile).toHaveBeenCalledWith(USER, "tool_invoice_history_1");
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
