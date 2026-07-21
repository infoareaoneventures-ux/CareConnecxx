import { describe, it, expect, vi, beforeEach } from "vitest";

// U2 (memory-grounding hardening 2026-07-17-002, R2/R4/KTD3) — nightly
// selection is a server-side indexed query: equality on onboardingStep /
// optedOut / userType == "client", Timestamp range on lastMessageAt, DESC
// order, document-cursor paging, bounded concurrency, per-user failure
// isolation, aggregate-only logs.
//
// Mock style mirrors the scheduled-test convention (in-memory Firestore built
// in vi.hoisted; state mutated in beforeEach — never a mock returned from it).

const hoisted = vi.hoisted(() => {
  class FakeTimestamp {
    constructor(public readonly ms: number) {}
    toMillis() {
      return this.ms;
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
  }

  const sessions = new Map<string, any>(); // phone -> agent_sessions data
  const whereCalls: Array<[string, string, any]> = [];
  const state = { failSessionsQuery: false };

  const makeSessionsQuery = () => {
    const filters: Array<[string, string, any]> = [];
    let cursorId: string | null = null;
    let lim = Infinity;
    let orderField: string | null = null;
    const ref: any = {
      where(field: string, op: string, value: any) {
        filters.push([field, op, value]);
        whereCalls.push([field, op, value]);
        return ref;
      },
      orderBy(field: string, _dir?: string) {
        orderField = field;
        return ref;
      },
      limit(n: number) {
        lim = n;
        return ref;
      },
      startAfter(doc: { id: string }) {
        cursorId = doc.id;
        return ref;
      },
      async get() {
        if (state.failSessionsQuery)
          throw new Error("simulated agent_sessions query failure");
        let rows = [...sessions.entries()].map(([id, data]) => ({
          id,
          data: () => data,
        }));
        rows = rows.filter(({ data }) =>
          filters.every(([field, op, value]) => {
            const val = data()[field];
            if (op === "==") return val === value;
            if (op === ">=") {
              // Server-side Timestamp comparison: only Timestamp-typed stored
              // values are comparable — an ISO string can never match.
              return (
                val != null &&
                typeof val.toMillis === "function" &&
                typeof value?.toMillis === "function" &&
                val.toMillis() >= value.toMillis()
              );
            }
            return true;
          }),
        );
        if (orderField) {
          rows.sort(
            (a, b) =>
              (b.data()[orderField!]?.toMillis?.() ?? 0) -
              (a.data()[orderField!]?.toMillis?.() ?? 0),
          );
        }
        if (cursorId !== null) {
          const idx = rows.findIndex((r) => r.id === cursorId);
          rows = idx >= 0 ? rows.slice(idx + 1) : rows;
        }
        rows = rows.slice(0, lim);
        return { empty: rows.length === 0, docs: rows };
      },
    };
    return ref;
  };

  // agent_conversations/{phone}/messages — in-memory store for the
  // compression tests (U3/R9). Map<phone, Map<docId, data>>.
  const conversations = new Map<string, Map<string, Record<string, unknown>>>();
  let summarySeq = 0;

  const makeMessagesCol = (phone: string): any => ({
    orderBy: (field: string, _dir?: string) => ({
      get: async () => {
        const msgs = conversations.get(phone) ?? new Map();
        const docs = [...msgs.entries()]
          .sort((a, b) => Number(a[1][field] ?? 0) - Number(b[1][field] ?? 0))
          .map(([id, data]) => ({
            id,
            data: () => data,
            ref: { __phone: phone, __id: id },
          }));
        return { docs };
      },
    }),
    doc: (id?: string) => ({
      __phone: phone,
      __id: id ?? `summary-${++summarySeq}`,
    }),
  });

  const batch = () => {
    const ops: Array<() => void> = [];
    return {
      delete: (ref: { __phone: string; __id: string }) =>
        ops.push(() => conversations.get(ref.__phone)?.delete(ref.__id)),
      set: (
        ref: { __phone: string; __id: string },
        data: Record<string, unknown>,
      ) =>
        ops.push(() => {
          if (!conversations.has(ref.__phone))
            conversations.set(ref.__phone, new Map());
          conversations.get(ref.__phone)!.set(ref.__id, data);
        }),
      commit: async () => {
        for (const op of ops) op();
      },
    };
  };

  // U9: memory_operations store for the completed-operation cleanup tests.
  const memoryOps = new Map<string, Record<string, unknown>>();
  const opsState = { failDelete: false };
  const makeMemoryOpsQuery = (): any => {
    const filters: Array<[string, string, unknown]> = [];
    let lim = Infinity;
    const ref: any = {
      where(field: string, op: string, value: unknown) {
        filters.push([field, op, value]);
        return ref;
      },
      orderBy() {
        return ref;
      },
      limit(n: number) {
        lim = n;
        return ref;
      },
      async get() {
        const rows = [...memoryOps.entries()]
          .filter(([, data]) =>
            filters.every(([field, op, value]) => {
              const val = (data as Record<string, unknown>)[field];
              if (op === "==") return val === value;
              if (op === "<=")
                return (
                  typeof val === "string" &&
                  typeof value === "string" &&
                  val <= value
                );
              return true;
            }),
          )
          .slice(0, lim)
          .map(([id, data]) => ({
            id,
            data: () => data,
            ref: {
              delete: async () => {
                if (opsState.failDelete)
                  throw new Error("simulated delete failure");
                memoryOps.delete(id);
              },
            },
          }));
        return { empty: rows.length === 0, docs: rows };
      },
    };
    return ref;
  };

  const collection = (name: string): any => {
    if (name === "agent_sessions") return makeSessionsQuery();
    if (name === "memory_operations") return makeMemoryOpsQuery();
    if (name === "agent_conversations") {
      return {
        listDocuments: async () =>
          [...conversations.keys()].map((id) => ({ id })),
        doc: (phone: string) => ({
          collection: (_sub: string) => makeMessagesCol(phone),
        }),
      };
    }
    // appointments (booking-pattern housekeeping): empty result short-circuits.
    const empty: any = {
      where: () => empty,
      get: async () => ({ empty: true, docs: [] }),
    };
    return empty;
  };

  return {
    FakeTimestamp,
    sessions,
    conversations,
    memoryOps,
    opsState,
    whereCalls,
    state,
    collection,
    batch,
    consolidateMock: vi.fn(async (_userId: string, _phone?: string) => {}),
    cleanupMock: vi.fn(async () => {}),
    // U8 (R20/KTD14): expired transient tool-file cleanup, mocked at the
    // memoryFiles boundary — behavior is tested in memoryFiles.test.ts; here
    // we pin scheduling, aggregate-only logging, and failure isolation.
    transientCleanupMock: vi.fn(async () => ({
      scanned: 0,
      retained: 0,
      deleted: 0,
      malformed: 0,
      failed: 0,
    })),
    claudeCreate: vi.fn(async () => ({
      content: [
        { type: "text", text: "<summary> compressed conversation summary" },
      ],
    })),
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(
    () => ({ collection: hoisted.collection, batch: hoisted.batch }),
    {
      Timestamp: hoisted.FakeTimestamp,
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
    },
  );
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

vi.mock("../memory/memoryFiles", () => ({
  consolidateMemoryForUser: hoisted.consolidateMock,
  cleanupExpiredTransientToolFiles: hoisted.transientCleanupMock,
}));

vi.mock("../agents/executionAgent", () => ({
  cleanupStaleExecutionAgents: hoisted.cleanupMock,
}));

vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: hoisted.claudeCreate } }),
}));

import {
  runNightlyMemoryConsolidation,
  runNightlyMemoryJob,
  compressOldConversations,
  NIGHTLY_MEMORY_WINDOW_MS,
  AGED_PENDING_SYNC_MS,
} from "./nightlyMemory";

const DAY = 24 * 60 * 60 * 1000;
const ts = (daysBack: number) =>
  hoisted.FakeTimestamp.fromMillis(Date.now() - daysBack * DAY);

function seedSession(phone: string, extra: Record<string, unknown> = {}) {
  hoisted.sessions.set(phone, {
    onboardingStep: "complete",
    optedOut: false,
    userType: "client",
    userId: `user-${phone}`,
    lastMessageAt: ts(2),
    ...extra,
  });
}

beforeEach(() => {
  hoisted.sessions.clear();
  hoisted.conversations.clear();
  hoisted.memoryOps.clear();
  hoisted.opsState.failDelete = false;
  hoisted.whereCalls.length = 0;
  hoisted.state.failSessionsQuery = false;
  hoisted.consolidateMock.mockClear();
  hoisted.consolidateMock.mockImplementation(async () => {});
  hoisted.cleanupMock.mockClear();
  hoisted.transientCleanupMock.mockClear();
  hoisted.transientCleanupMock.mockImplementation(async () => ({
    scanned: 0,
    retained: 0,
    deleted: 0,
    malformed: 0,
    failed: 0,
  }));
  hoisted.claudeCreate.mockClear();
  hoisted.claudeCreate.mockImplementation(async () => ({
    content: [
      { type: "text", text: "<summary> compressed conversation summary" },
    ],
  }));
});

describe("runNightlyMemoryConsolidation — selection (R2/KTD3)", () => {
  it("selects a recently active, completed, opted-in client and consolidates it", async () => {
    seedSession("+14085550001");

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith(
      "user-+14085550001",
      "+14085550001",
    );
    expect(counts).toEqual({
      eligible: 1,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("caregiver sessions never enter the family-memory batch", async () => {
    seedSession("+14085550002", { userType: "caregiver" });

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).not.toHaveBeenCalled();
    expect(counts.eligible).toBe(0);
  });

  it("excludes stale (>7d), incomplete, opted-out, roleless, and activity-less sessions", async () => {
    seedSession("+1000", { lastMessageAt: ts(8) }); // stale
    seedSession("+2000", { onboardingStep: "care_needs" }); // mid-onboarding
    seedSession("+3000", { optedOut: true }); // opted out
    seedSession("+4000", { userType: undefined }); // no role — never selectable
    seedSession("+5000", { lastMessageAt: undefined }); // no runtime activity yet
    seedSession("+6000"); // the one eligible client

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith("user-+6000", "+6000");
    expect(counts.eligible).toBe(1);
  });

  it("cutoff is a Firestore Timestamp at now-7d — never an ISO string comparison", async () => {
    seedSession("+14085550003", { lastMessageAt: ts(6) });
    // A legacy ISO-string value is not comparable to a Timestamp cutoff and
    // must not be selected.
    seedSession("+14085550004", {
      lastMessageAt: new Date(Date.now() - DAY).toISOString(),
    });

    await runNightlyMemoryConsolidation();

    const rangeFilter = hoisted.whereCalls.find(
      ([field, op]) => field === "lastMessageAt" && op === ">=",
    );
    expect(rangeFilter).toBeDefined();
    const cutoff = rangeFilter![2];
    expect(cutoff).toBeInstanceOf(hoisted.FakeTimestamp);
    expect(typeof cutoff).not.toBe("string");
    expect(
      Math.abs(cutoff.toMillis() - (Date.now() - NIGHTLY_MEMORY_WINDOW_MS)),
    ).toBeLessThan(10_000);

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith(
      "user-+14085550003",
      "+14085550003",
    );
  });

  it("uses equality filters for onboardingStep/optedOut/userType server-side", async () => {
    seedSession("+14085550005");
    await runNightlyMemoryConsolidation();
    expect(hoisted.whereCalls).toEqual(
      expect.arrayContaining([
        ["onboardingStep", "==", "complete"],
        ["optedOut", "==", false],
        ["userType", "==", "client"],
      ]),
    );
  });

  it("pages by document cursor with no duplicates across pages (250 sessions, page size 100)", async () => {
    for (let i = 0; i < 250; i++) {
      // Distinct timestamps so DESC ordering + cursor paging is deterministic.
      seedSession(`+1408555${String(i).padStart(4, "0")}`, {
        lastMessageAt: hoisted.FakeTimestamp.fromMillis(
          Date.now() - i * 60_000,
        ),
      });
    }

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(250);
    const phones = hoisted.consolidateMock.mock.calls.map((c) => c[1]);
    expect(new Set(phones).size).toBe(250);
    expect(counts).toEqual({
      eligible: 250,
      attempted: 250,
      succeeded: 250,
      failed: 0,
      skipped: 0,
    });
  });

  it("one client failure does not abort the batch (R4) and is counted, not identified", async () => {
    seedSession("+7001", { lastMessageAt: ts(1) });
    seedSession("+7002", { lastMessageAt: ts(2) });
    seedSession("+7003", { lastMessageAt: ts(3) });
    hoisted.consolidateMock.mockImplementation(
      async (_userId: string, phone?: string) => {
        if (phone === "+7002")
          throw new Error("zep exploded for +7002 secret content");
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const counts = await runNightlyMemoryConsolidation();

      expect(counts).toEqual({
        eligible: 3,
        attempted: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
      });
      expect(hoisted.consolidateMock).toHaveBeenCalledTimes(3);
      // R21: the failure log carries a sanitized error class — no phone, no
      // userId, no error message text.
      const failureLogs = errorSpy.mock.calls.filter((c) =>
        String(c[0]).includes("consolidation failure"),
      );
      expect(failureLogs).toHaveLength(1);
      const serialized = JSON.stringify(failureLogs[0]);
      expect(serialized).not.toContain("+7002");
      expect(serialized).not.toContain("user-");
      expect(serialized).not.toContain("secret content");
      expect(failureLogs[0][1]).toEqual({ errorClass: "Error" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("runNightlyMemoryJob — housekeeping isolation (R4)", () => {
  it("logs aggregate counts only (no IDs) and runs downstream tasks after a client failure", async () => {
    seedSession("+8001");
    seedSession("+8002");
    hoisted.consolidateMock.mockImplementation(
      async (_u: string, phone?: string) => {
        if (phone === "+8001") throw new Error("boom");
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await runNightlyMemoryJob();

      const batchLog = logSpy.mock.calls.find((c) =>
        String(c[0]).includes("memory batch"),
      );
      expect(batchLog).toBeDefined();
      expect(batchLog![1]).toEqual({
        eligible: 2,
        attempted: 2,
        succeeded: 1,
        failed: 1,
        skipped: 0,
      });
      expect(JSON.stringify(batchLog)).not.toContain("+800");
      // Existing nightly housekeeping still ran.
      expect(hoisted.cleanupMock).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a total memory-batch failure (query throws) still runs booking-pattern, compression, and cleanup", async () => {
    hoisted.state.failSessionsQuery = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runNightlyMemoryJob()).resolves.toBeUndefined();

      expect(hoisted.cleanupMock).toHaveBeenCalledTimes(1);
      expect(hoisted.transientCleanupMock).toHaveBeenCalledTimes(1);
      const abortLog = errorSpy.mock.calls.find((c) =>
        String(c[0]).includes("memory batch aborted"),
      );
      expect(abortLog).toBeDefined();
      expect(abortLog![1]).toEqual({ errorClass: "Error" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ── U8 (R20/KTD14): nightly transient tool-file cleanup wiring ────────────────

describe("runNightlyMemoryJob — transient tool-file cleanup (U8)", () => {
  it("runs the cleanup once per job and logs aggregate counts only (R21)", async () => {
    hoisted.transientCleanupMock.mockResolvedValueOnce({
      scanned: 7,
      retained: 3,
      deleted: 3,
      malformed: 1,
      failed: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await runNightlyMemoryJob();

      expect(hoisted.transientCleanupMock).toHaveBeenCalledTimes(1);
      const cleanupLog = logSpy.mock.calls.find((c) =>
        String(c[0]).includes("transient tool-file cleanup"),
      );
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog![1]).toEqual({
        scanned: 7,
        retained: 3,
        deleted: 3,
        malformed: 1,
        failed: 0,
      });
      // Aggregate only — no user IDs, phones, or slugs.
      expect(JSON.stringify(cleanupLog)).not.toMatch(/\+\d{7,}|tool_|memory\//);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a cleanup failure is isolated: sanitized error log, remaining housekeeping still runs", async () => {
    hoisted.transientCleanupMock.mockRejectedValueOnce(
      new Error("bucket listing exploded for u123"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runNightlyMemoryJob()).resolves.toBeUndefined();

      // Execution-agent cleanup (the step after) still ran.
      expect(hoisted.cleanupMock).toHaveBeenCalledTimes(1);
      const errLog = errorSpy.mock.calls.find((c) =>
        String(c[0]).includes("cleanupExpiredTransientToolFiles error"),
      );
      expect(errLog).toBeDefined();
      expect(errLog![1]).toEqual({ errorClass: "Error" }); // R21: no raw message text
      expect(JSON.stringify(errLog)).not.toContain("u123");
      // No cleanup counts log was emitted for the failed run.
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes("transient tool-file cleanup"),
        ),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ── Compression protection for unresolved memory sync (U3, R9) ───────────────
//
// A source row whose memorySyncStatus is still set (the memory-operation
// worker has not confirmed Zep/fact writes) must never be summarized or
// deleted; compression stops at the first such row. Aged pending rows surface
// in the job's aggregate counts.

const CONV_PHONE = "+14085559999";

function seedConversation(
  count: number,
  pendingIdx: number[] = [],
  opts: { pendingAgeMs?: number } = {},
) {
  const msgs = new Map<string, Record<string, unknown>>();
  const base = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    msgs.set(`m${String(i).padStart(3, "0")}`, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp:
        pendingIdx.includes(i) && opts.pendingAgeMs
          ? Date.now() - opts.pendingAgeMs
          : base + i * 60_000,
      ...(pendingIdx.includes(i) ? { memorySyncStatus: "pending" } : {}),
    });
  }
  hoisted.conversations.set(CONV_PHONE, msgs);
  return msgs;
}

describe("compressOldConversations — unresolved memorySyncStatus rows are never compressed (R9)", () => {
  it("compresses a long conversation normally when no row is pending", async () => {
    seedConversation(20);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts).toEqual({
        conversations: 1,
        compressedMessages: 10,
        skippedPendingSync: 0,
        excludedRowsDeleted: 0,
        agedPendingRows: 0,
        failed: 0,
      });
      expect(hoisted.claudeCreate).toHaveBeenCalledTimes(1);
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      // 10 retained + 1 new summary.
      expect(msgs.size).toBe(11);
      expect(
        [...msgs.values()].filter((m) => m.role === "summary"),
      ).toHaveLength(1);
      // R21 (item g): no per-phone success log — nothing logged carries the
      // conversation's phone.
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(CONV_PHONE);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a per-conversation failure logs only a sanitized errorClass — never the phone (R21)", async () => {
    seedConversation(20);
    hoisted.claudeCreate.mockRejectedValueOnce(
      new Error(`summarizer exploded for ${CONV_PHONE} with secret content`),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts.failed).toBe(1);
      const failureLogs = errorSpy.mock.calls.filter((c) =>
        String(c[0]).includes("compression failure"),
      );
      expect(failureLogs).toHaveLength(1);
      expect(failureLogs[0][1]).toEqual({ errorClass: "Error" });
      const everything = JSON.stringify([
        ...logSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]);
      expect(everything).not.toContain(CONV_PHONE);
      expect(everything).not.toContain("secret content");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a row whose sync TERMINAL-failed (memorySyncStatus 'terminal') is released and compresses", async () => {
    const msgs = seedConversation(20);
    // The worker gave up on this turn permanently — compression must not stay
    // wedged behind it (R9 repair).
    msgs.get("m003")!.memorySyncStatus = "terminal";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts.compressedMessages).toBe(10);
      expect(counts.skippedPendingSync).toBe(0);
      expect(hoisted.conversations.get(CONV_PHONE)!.has("m003")).toBe(false);
      // Terminal rows ARE summarizable — the local summary is the only
      // continuity the turn will ever get.
      const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls);
      expect(prompt).toContain("message 3");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a pending row early in the compress window blocks compression entirely (fewer than 5 compressible rows)", async () => {
    seedConversation(20, [3]);
    const counts = await compressOldConversations();

    // toCompress would be rows 0-9; the pending row at 3 truncates it to 0-2
    // (< 5) → nothing is summarized or deleted this run.
    expect(counts.compressedMessages).toBe(0);
    expect(counts.skippedPendingSync).toBe(1);
    expect(hoisted.claudeCreate).not.toHaveBeenCalled();
    expect(hoisted.conversations.get(CONV_PHONE)!.size).toBe(20);
    expect(
      hoisted.conversations.get(CONV_PHONE)!.get("m003")!.memorySyncStatus,
    ).toBe("pending");
  });

  it("rows OLDER than the first pending row still compress; the pending row and younger rows survive verbatim", async () => {
    seedConversation(20, [8]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts.compressedMessages).toBe(8); // rows 0-7 only
      expect(counts.skippedPendingSync).toBe(1); // the pending row was protected
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      // 20 - 8 compressed + 1 summary = 13.
      expect(msgs.size).toBe(13);
      const pendingRow = msgs.get("m008")!;
      expect(pendingRow.memorySyncStatus).toBe("pending");
      expect(pendingRow.content).toBe("message 8"); // verbatim, not summarized
      // The summary slots immediately before the first retained (pending) row.
      const summary = [...msgs.values()].find((m) => m.role === "summary")!;
      expect(summary.timestamp).toBe(Number(pendingRow.timestamp) - 1);
      // The summarizer never saw the pending row's content.
      const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls);
      expect(prompt).not.toContain("message 8");
      expect(prompt).toContain("message 7");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("aged pending rows surface in the job's aggregate counts without identifying the conversation (R21)", async () => {
    seedConversation(20, [2], {
      pendingAgeMs: AGED_PENDING_SYNC_MS + 60 * 60 * 1000,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runNightlyMemoryJob();

      const compressionLog = logSpy.mock.calls.find((c) =>
        String(c[0]).includes("compression"),
      );
      expect(compressionLog).toBeDefined();
      expect(compressionLog![1]).toMatchObject({
        agedPendingRows: 1,
        conversations: 1,
      });
      expect(JSON.stringify(compressionLog)).not.toContain(CONV_PHONE);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── U4b (KTD16/R23): rows marked by the correction/forget worker are excluded
// from compression SUMMARIES — deleted with the fold window, but their content
// never reaches the summarizer prompt (deletable-but-not-summarizable per the
// data contract). One forget must never wedge compression for the phone.

describe("compressOldConversations — excludeFromMemoryConsolidationAt rows (U4b)", () => {
  function seedWithExcluded(count: number, excludedIdx: number[]) {
    const msgs = new Map<string, Record<string, unknown>>();
    const base = Date.now() - count * 60_000;
    for (let i = 0; i < count; i++) {
      msgs.set(`m${String(i).padStart(3, "0")}`, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        timestamp: base + i * 60_000,
        ...(excludedIdx.includes(i)
          ? {
              excludeFromMemoryConsolidationAt: new Date().toISOString(),
              excludeFromMemoryConsolidationReason: "forget",
            }
          : {}),
      });
    }
    hoisted.conversations.set(CONV_PHONE, msgs);
  }

  it("an old excluded row is deleted with the fold, never enters the summarizer prompt, and newer history still compresses", async () => {
    seedWithExcluded(20, [2]);
    const counts = await compressOldConversations();

    // The 9 safe rows of the fold window are summarized; the excluded row is
    // deleted alongside them without ever reaching the prompt.
    expect(counts.compressedMessages).toBe(9);
    expect(counts.excludedRowsDeleted).toBe(1);
    expect(hoisted.claudeCreate).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls);
    expect(prompt).not.toContain("message 2");
    expect(prompt).toContain("message 1");
    expect(prompt).toContain("message 3");
    const messages = hoisted.conversations.get(CONV_PHONE)!;
    expect(messages.has("m002")).toBe(false);
    // 10 retained + 1 new summary — the fold window is fully gone.
    expect(messages.size).toBe(11);
  });

  it("when EVERY compressible row is marked, the rows are deleted without any summarizer call", async () => {
    seedWithExcluded(20, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const counts = await compressOldConversations();

    expect(counts.compressedMessages).toBe(0);
    expect(counts.excludedRowsDeleted).toBe(10);
    expect(hoisted.claudeCreate).not.toHaveBeenCalled();
    // The retired rows are gone; only the retained 10 remain — the phone is
    // not wedged and agent_conversations does not grow unbounded.
    expect(hoisted.conversations.get(CONV_PHONE)!.size).toBe(10);
  });

  it("masks a prior summary when every compressible row is marked and no safe transcript can regenerate it", async () => {
    seedWithExcluded(20, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    hoisted.conversations.get(CONV_PHONE)!.set("summary-old", {
      role: "summary",
      content: "<summary> earlier summary text",
      timestamp: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts.compressedMessages).toBe(0);
      expect(counts.excludedRowsDeleted).toBe(10);
      expect(hoisted.claudeCreate).not.toHaveBeenCalled();
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      const summaries = [...msgs.values()].filter((m) => m.role === "summary");
      expect(summaries).toHaveLength(0);
      // Excluded rows deleted with the (unsummarizable) window.
      expect(msgs.size).toBe(10);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("regenerates an existing summary from only the safe rows — the excluded row and old summary never reach the prompt", async () => {
    seedWithExcluded(20, [8]);
    hoisted.conversations.get(CONV_PHONE)!.set("summary-old", {
      role: "summary",
      content: "<summary> Mom is allergic to penicillin.",
      timestamp: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      // All 9 safe fold-window rows (0-7 and 9) are summarized; the excluded
      // row 8 is deleted without being summarized.
      expect(counts.compressedMessages).toBe(9);
      expect(counts.excludedRowsDeleted).toBe(1);
      const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls);
      expect(prompt).not.toContain("penicillin");
      expect(prompt).not.toContain("message 8");
      expect(prompt).toContain("message 7");
      expect(prompt).toContain("message 9");
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      expect(msgs.has("m008")).toBe(false);
      const summaries = [...msgs.values()].filter((m) => m.role === "summary");
      expect(summaries).toHaveLength(1);
      expect(summaries[0].content).not.toContain("penicillin");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("an unresolved memorySyncStatus row still hard-blocks the fold window at its position", async () => {
    // Pending row at index 6 truncates the fold window to rows 0-5 even though
    // an excluded row sits earlier at index 2: the excluded row (in the safe
    // prefix) is deleted, rows 0-5 minus it are summarized, and everything
    // from the pending row on survives verbatim.
    seedWithExcluded(20, [2]);
    hoisted.conversations.get(CONV_PHONE)!.get("m006")!.memorySyncStatus =
      "pending";
    const counts = await compressOldConversations();

    expect(counts.skippedPendingSync).toBe(1);
    expect(counts.compressedMessages).toBe(5); // rows 0,1,3,4,5
    expect(counts.excludedRowsDeleted).toBe(1); // row 2
    const msgs = hoisted.conversations.get(CONV_PHONE)!;
    expect(msgs.get("m006")!.memorySyncStatus).toBe("pending");
    expect(msgs.get("m006")!.content).toBe("message 6"); // verbatim
    expect(msgs.has("m002")).toBe(false);
    const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls);
    expect(prompt).not.toContain("message 2");
    expect(prompt).not.toContain("message 6");
    expect(prompt).toContain("message 5");
  });
});

// U6 (2026-07-20): the cleanupExpiredMemoryOperations sweep and its tests were
// removed. Completed memory_operations are now expired by a Firestore TTL policy
// on the Timestamp expiresAt field (see functions/src/memory/memoryOperations.ts
// and tests/firestoreTtlContract.test.ts). Failed/unresolved ops keep null
// expiresAt and are never TTL-eligible.
