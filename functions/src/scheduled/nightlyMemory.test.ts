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
    toMillis() { return this.ms; }
    static fromMillis(ms: number) { return new FakeTimestamp(ms); }
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
      orderBy(field: string, _dir?: string) { orderField = field; return ref; },
      limit(n: number) { lim = n; return ref; },
      startAfter(doc: { id: string }) { cursorId = doc.id; return ref; },
      async get() {
        if (state.failSessionsQuery) throw new Error("simulated agent_sessions query failure");
        let rows = [...sessions.entries()].map(([id, data]) => ({ id, data: () => data }));
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
            (a, b) => (b.data()[orderField!]?.toMillis?.() ?? 0) - (a.data()[orderField!]?.toMillis?.() ?? 0),
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
    doc: (id?: string) => ({ __phone: phone, __id: id ?? `summary-${++summarySeq}` }),
  });

  const batch = () => {
    const ops: Array<() => void> = [];
    return {
      delete: (ref: { __phone: string; __id: string }) =>
        ops.push(() => conversations.get(ref.__phone)?.delete(ref.__id)),
      set: (ref: { __phone: string; __id: string }, data: Record<string, unknown>) =>
        ops.push(() => {
          if (!conversations.has(ref.__phone)) conversations.set(ref.__phone, new Map());
          conversations.get(ref.__phone)!.set(ref.__id, data);
        }),
      commit: async () => { for (const op of ops) op(); },
    };
  };

  const collection = (name: string): any => {
    if (name === "agent_sessions") return makeSessionsQuery();
    if (name === "agent_conversations") {
      return {
        listDocuments: async () => [...conversations.keys()].map(id => ({ id })),
        doc: (phone: string) => ({ collection: (_sub: string) => makeMessagesCol(phone) }),
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
    whereCalls,
    state,
    collection,
    batch,
    consolidateMock: vi.fn(async (_userId: string, _phone?: string) => {}),
    cleanupMock: vi.fn(async () => {}),
    claudeCreate: vi.fn(async () => ({ content: [{ type: "text", text: "<summary> compressed conversation summary" }] })),
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collection, batch: hoisted.batch }), {
    Timestamp: hoisted.FakeTimestamp,
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
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

vi.mock("../memory/memoryFiles", () => ({
  consolidateMemoryForUser: hoisted.consolidateMock,
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
const ts = (daysBack: number) => hoisted.FakeTimestamp.fromMillis(Date.now() - daysBack * DAY);

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
  hoisted.whereCalls.length = 0;
  hoisted.state.failSessionsQuery = false;
  hoisted.consolidateMock.mockClear();
  hoisted.consolidateMock.mockImplementation(async () => {});
  hoisted.cleanupMock.mockClear();
  hoisted.claudeCreate.mockClear();
  hoisted.claudeCreate.mockImplementation(async () => ({ content: [{ type: "text", text: "<summary> compressed conversation summary" }] }));
});

describe("runNightlyMemoryConsolidation — selection (R2/KTD3)", () => {
  it("selects a recently active, completed, opted-in client and consolidates it", async () => {
    seedSession("+14085550001");

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith("user-+14085550001", "+14085550001");
    expect(counts).toEqual({ eligible: 1, attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  });

  it("caregiver sessions never enter the family-memory batch", async () => {
    seedSession("+14085550002", { userType: "caregiver" });

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).not.toHaveBeenCalled();
    expect(counts.eligible).toBe(0);
  });

  it("excludes stale (>7d), incomplete, opted-out, roleless, and activity-less sessions", async () => {
    seedSession("+1000", { lastMessageAt: ts(8) });                    // stale
    seedSession("+2000", { onboardingStep: "care_needs" });            // mid-onboarding
    seedSession("+3000", { optedOut: true });                          // opted out
    seedSession("+4000", { userType: undefined });                     // no role — never selectable
    seedSession("+5000", { lastMessageAt: undefined });                // no runtime activity yet
    seedSession("+6000");                                              // the one eligible client

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith("user-+6000", "+6000");
    expect(counts.eligible).toBe(1);
  });

  it("cutoff is a Firestore Timestamp at now-7d — never an ISO string comparison", async () => {
    seedSession("+14085550003", { lastMessageAt: ts(6) });
    // A legacy ISO-string value is not comparable to a Timestamp cutoff and
    // must not be selected.
    seedSession("+14085550004", { lastMessageAt: new Date(Date.now() - DAY).toISOString() });

    await runNightlyMemoryConsolidation();

    const rangeFilter = hoisted.whereCalls.find(([field, op]) => field === "lastMessageAt" && op === ">=");
    expect(rangeFilter).toBeDefined();
    const cutoff = rangeFilter![2];
    expect(cutoff).toBeInstanceOf(hoisted.FakeTimestamp);
    expect(typeof cutoff).not.toBe("string");
    expect(Math.abs(cutoff.toMillis() - (Date.now() - NIGHTLY_MEMORY_WINDOW_MS))).toBeLessThan(10_000);

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.consolidateMock).toHaveBeenCalledWith("user-+14085550003", "+14085550003");
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
        lastMessageAt: hoisted.FakeTimestamp.fromMillis(Date.now() - i * 60_000),
      });
    }

    const counts = await runNightlyMemoryConsolidation();

    expect(hoisted.consolidateMock).toHaveBeenCalledTimes(250);
    const phones = hoisted.consolidateMock.mock.calls.map((c) => c[1]);
    expect(new Set(phones).size).toBe(250);
    expect(counts).toEqual({ eligible: 250, attempted: 250, succeeded: 250, failed: 0, skipped: 0 });
  });

  it("one client failure does not abort the batch (R4) and is counted, not identified", async () => {
    seedSession("+7001", { lastMessageAt: ts(1) });
    seedSession("+7002", { lastMessageAt: ts(2) });
    seedSession("+7003", { lastMessageAt: ts(3) });
    hoisted.consolidateMock.mockImplementation(async (_userId: string, phone?: string) => {
      if (phone === "+7002") throw new Error("zep exploded for +7002 secret content");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const counts = await runNightlyMemoryConsolidation();

      expect(counts).toEqual({ eligible: 3, attempted: 3, succeeded: 2, failed: 1, skipped: 0 });
      expect(hoisted.consolidateMock).toHaveBeenCalledTimes(3);
      // R21: the failure log carries a sanitized error class — no phone, no
      // userId, no error message text.
      const failureLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes("consolidation failure"));
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
    hoisted.consolidateMock.mockImplementation(async (_u: string, phone?: string) => {
      if (phone === "+8001") throw new Error("boom");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await runNightlyMemoryJob();

      const batchLog = logSpy.mock.calls.find((c) => String(c[0]).includes("memory batch"));
      expect(batchLog).toBeDefined();
      expect(batchLog![1]).toEqual({ eligible: 2, attempted: 2, succeeded: 1, failed: 1, skipped: 0 });
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
      const abortLog = errorSpy.mock.calls.find((c) => String(c[0]).includes("memory batch aborted"));
      expect(abortLog).toBeDefined();
      expect(abortLog![1]).toEqual({ errorClass: "Error" });
    } finally {
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

function seedConversation(count: number, pendingIdx: number[] = [], opts: { pendingAgeMs?: number } = {}) {
  const msgs = new Map<string, Record<string, unknown>>();
  const base = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    msgs.set(`m${String(i).padStart(3, "0")}`, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: pendingIdx.includes(i) && opts.pendingAgeMs
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
        conversations: 1, compressedMessages: 10, skippedPendingSync: 0, agedPendingRows: 0, failed: 0,
      });
      expect(hoisted.claudeCreate).toHaveBeenCalledTimes(1);
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      // 10 retained + 1 new summary.
      expect(msgs.size).toBe(11);
      expect([...msgs.values()].filter(m => m.role === "summary")).toHaveLength(1);
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
    expect(counts.skippedPendingSync).toBe(7);
    expect(hoisted.claudeCreate).not.toHaveBeenCalled();
    expect(hoisted.conversations.get(CONV_PHONE)!.size).toBe(20);
    expect(hoisted.conversations.get(CONV_PHONE)!.get("m003")!.memorySyncStatus).toBe("pending");
  });

  it("rows OLDER than the first pending row still compress; the pending row and younger rows survive verbatim", async () => {
    seedConversation(20, [8]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const counts = await compressOldConversations();

      expect(counts.compressedMessages).toBe(8); // rows 0-7 only
      expect(counts.skippedPendingSync).toBe(2); // rows 8-9 were compress-eligible but protected
      const msgs = hoisted.conversations.get(CONV_PHONE)!;
      // 20 - 8 compressed + 1 summary = 13.
      expect(msgs.size).toBe(13);
      const pendingRow = msgs.get("m008")!;
      expect(pendingRow.memorySyncStatus).toBe("pending");
      expect(pendingRow.content).toBe("message 8"); // verbatim, not summarized
      // The summary slots immediately before the first retained (pending) row.
      const summary = [...msgs.values()].find(m => m.role === "summary")!;
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
    seedConversation(20, [2], { pendingAgeMs: AGED_PENDING_SYNC_MS + 60 * 60 * 1000 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runNightlyMemoryJob();

      const compressionLog = logSpy.mock.calls.find(c => String(c[0]).includes("compression"));
      expect(compressionLog).toBeDefined();
      expect(compressionLog![1]).toMatchObject({ agedPendingRows: 1, conversations: 1 });
      expect(JSON.stringify(compressionLog)).not.toContain(CONV_PHONE);
    } finally {
      logSpy.mockRestore();
    }
  });
});
