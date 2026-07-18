import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// U2 (memory-grounding hardening 2026-07-17-002): activity marking policy (R1)
// and the pure backfill decision (R3). U3 adds persistCompletedTurn — the
// atomic deterministic rows + turn_sync operation batch (R8/R9/R21). Firestore
// is mocked; every helper is exercised against an explicit in-memory db.

vi.mock("firebase-admin", () => {
  // Module-load safe (the memoryOperations import chain calls admin.firestore()
  // at load), but any accidental default-db USE still fails loudly — tests
  // must pass an explicit db.
  const firestore = Object.assign(
    () => ({
      collection: () => {
        throw new Error("tests must pass an explicit db to conversationMemory helpers");
      },
      doc: () => {
        throw new Error("tests must pass an explicit db to conversationMemory helpers");
      },
      batch: () => {
        throw new Error("tests must pass an explicit db to conversationMemory helpers");
      },
      runTransaction: () => {
        throw new Error("tests must pass an explicit db to conversationMemory helpers");
      },
    }),
    {
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), delete: () => ({ __delete: true }) },
    },
  );
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import {
  sessionActivityFields,
  markSessionActivity,
  decideActivityBackfill,
  persistCompletedTurn,
  turnMessageDocId,
  ACTIVITY_BACKFILL_WINDOW_MS,
  ACTIVITY_BACKFILL_FUTURE_SKEW_MS,
} from "./conversationMemory";
import { hashSourceTurnKey, turnSyncOperationId } from "./memoryOperations";

const DAY = 24 * 60 * 60 * 1000;

// ── In-memory db for the write helper ────────────────────────────────────────
const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
let failUpdate = false;
const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => {
        if (failUpdate) throw new Error("NOT_FOUND: simulated");
        updates.push({ path: `${name}/${id}`, data });
      },
    }),
  }),
} as any;

beforeEach(() => {
  updates.length = 0;
  failUpdate = false;
});

describe("sessionActivityFields", () => {
  it("patches lastMessageAt with a server timestamp (never an ISO string)", () => {
    const fields = sessionActivityFields() as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(["lastMessageAt"]);
    expect(fields.lastMessageAt).toEqual({ __serverTimestamp: true });
    expect(typeof fields.lastMessageAt).not.toBe("string");
  });
});

describe("markSessionActivity", () => {
  it("writes lastMessageAt to agent_sessions/{phone}", async () => {
    await markSessionActivity("+14085551234", fakeDb);
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe("agent_sessions/+14085551234");
    expect(updates[0].data).toEqual({ lastMessageAt: { __serverTimestamp: true } });
  });

  it("swallows a write failure — activity marking must never block a user turn", async () => {
    failUpdate = true;
    await expect(markSessionActivity("+14085551234", fakeDb)).resolves.toBeUndefined();
  });
});

// ── Ingress seam contracts (R1 / KTD2) ───────────────────────────────────────
// The Linq webhook writes activity beside lastInboundAt in ONE update; the web
// callable marks it after its accept guards. Behavior for the web seam is
// covered in webChat.test.ts; these source contracts pin the SMS seam (the full
// webhook handler is not unit-loadable) and the wiring itself.

const here = __dirname;

describe("verified-ingress wiring", () => {
  it("Linq webhook spreads sessionActivityFields() into the lastInboundAt session update", () => {
    const src = readFileSync(join(here, "../linq/webhooks.ts"), "utf8");
    expect(src).toContain('import { sessionActivityFields } from "../memory/conversationMemory"');
    // The activity fields ride in the SAME update object as lastInboundAt so the
    // SMS seam cannot accept a turn without marking activity.
    expect(src).toMatch(
      /lastInboundAt: new Date\(\)\.toISOString\(\),\s*\n\s*\.\.\.sessionActivityFields\(\),/,
    );
  });

  it("web chat marks activity after the onboarding guard and before the agent import", () => {
    const src = readFileSync(join(here, "../linq/webChat.ts"), "utf8");
    const markAt = src.indexOf("markSessionActivity(phone, db)");
    expect(markAt).toBeGreaterThan(-1);
    // After every accept guard…
    expect(markAt).toBeGreaterThan(src.indexOf('status:    "finishSetup"'));
    // …and before the model can possibly run.
    expect(markAt).toBeLessThan(src.indexOf('import("../agents/qaAgent")'));
  });
});

// ── Backfill decision (R3) ───────────────────────────────────────────────────

const NOW = Date.parse("2026-07-18T12:00:00Z");
const base = {
  hasLastMessageAt: false,
  sessionUserType: "client" as string | null,
  canonicalUserType: null as string | null,
  latestUserMessageTimestampMs: NOW - 2 * DAY,
  nowMs: NOW,
};

describe("decideActivityBackfill", () => {
  it("recent user-message evidence is written verbatim (epoch ms of the row, not now)", () => {
    const d = decideActivityBackfill(base);
    expect(d.history).toBe("recent_history");
    expect(d.writeLastMessageAtMs).toBe(NOW - 2 * DAY);
    expect(d.role).toBe("client");
  });

  it("already-populated sessions are never rewritten (idempotency: second dry-run reports 0)", () => {
    const d = decideActivityBackfill({ ...base, hasLastMessageAt: true });
    expect(d.history).toBe("already_populated");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("no user history → no write", () => {
    const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: null });
    expect(d.history).toBe("no_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("non-numeric/garbage timestamp evidence counts as no history", () => {
    for (const bad of [NaN, Infinity, -5, 0]) {
      const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: bad });
      expect(d.history).toBe("no_history");
      expect(d.writeLastMessageAtMs).toBeNull();
    }
  });

  it("evidence older than the 7-day window is stale and NOT written (cannot mark stale sessions active)", () => {
    const d = decideActivityBackfill({
      ...base,
      latestUserMessageTimestampMs: NOW - ACTIVITY_BACKFILL_WINDOW_MS - 1,
    });
    expect(d.history).toBe("stale_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("evidence just inside the window is written", () => {
    const ts = NOW - ACTIVITY_BACKFILL_WINDOW_MS + 60_000;
    const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: ts });
    expect(d.history).toBe("recent_history");
    expect(d.writeLastMessageAtMs).toBe(ts);
  });

  it("a future timestamp beyond clock skew is not sane evidence", () => {
    const d = decideActivityBackfill({
      ...base,
      latestUserMessageTimestampMs: NOW + ACTIVITY_BACKFILL_FUTURE_SKEW_MS + 1,
    });
    expect(d.history).toBe("stale_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("ambiguous role: no session role, no explicit canonical role → excluded from repair", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: null });
    expect(d.role).toBe("ambiguous");
    expect(d.repairUserType).toBeNull();
  });

  it("ambiguous role: a non-canonical role string (e.g. 'admin') never repairs", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: "admin" });
    expect(d.role).toBe("ambiguous");
    expect(d.repairUserType).toBeNull();
  });

  it("missing session role repairs ONLY from an explicit canonical role", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: "client" });
    expect(d.role).toBe("client");
    expect(d.repairUserType).toBe("client");
  });

  it("an explicit session role wins and is never re-repaired", () => {
    const d = decideActivityBackfill({
      ...base,
      sessionUserType: "caregiver",
      canonicalUserType: "client",
    });
    expect(d.role).toBe("caregiver");
    expect(d.repairUserType).toBeNull();
  });
});

// ── Deterministic turn persistence (U3, R8/R9/R21) ───────────────────────────

const PHONE = "+14085551234";

// In-memory db with an ATOMIC batch: create() on an existing doc fails the
// whole commit with ALREADY_EXISTS and applies nothing — the Firestore
// contract persistCompletedTurn's idempotency rests on.
const turnStore = new Map<string, Record<string, unknown>>();
const commits: number[] = [];
let failTurnCommit = false;

function makeDocRef(path: string): any {
  return {
    path,
    id: path.split("/").pop()!,
    collection: (name: string) => makeColRef(`${path}/${name}`),
  };
}
function makeColRef(prefix: string): any {
  return { doc: (id: string) => makeDocRef(`${prefix}/${id}`) };
}
const turnDb = {
  collection: (name: string) => makeColRef(name),
  doc: (path: string) => makeDocRef(path),
  batch: () => {
    const ops: Array<{ type: "create" | "set"; path: string; data: Record<string, unknown> }> = [];
    return {
      create: (ref: any, data: Record<string, unknown>) => ops.push({ type: "create", path: ref.path, data }),
      set: (ref: any, data: Record<string, unknown>) => ops.push({ type: "set", path: ref.path, data }),
      commit: async () => {
        if (failTurnCommit) throw new Error(`firestore unavailable for ${PHONE} secret detail`);
        for (const op of ops) {
          if (op.type === "create" && turnStore.has(op.path)) {
            const err = new Error("6 ALREADY_EXISTS: Document already exists") as Error & { code: number };
            err.code = 6;
            throw err; // atomic: nothing staged is applied
          }
        }
        for (const op of ops) turnStore.set(op.path, op.data);
        commits.push(ops.length);
      },
    };
  },
} as any;

const turnInput = {
  channel: "web" as const,
  sourceKey: "client-msg-7",
  phone: PHONE,
  userId: "user-1",
  userText: "Mom prefers morning visits",
  assistantText: "Noted - I'll keep mornings in mind.",
  turnTimestampMs: Date.parse("2026-07-17T18:00:00Z"),
  extractFacts: true,
};

beforeEach(() => {
  turnStore.clear();
  commits.length = 0;
  failTurnCommit = false;
});

describe("persistCompletedTurn (U3)", () => {
  it("persists user/assistant rows and the turn_sync operation in ONE atomic batch with deterministic IDs (R9)", async () => {
    const outcome = await persistCompletedTurn(turnInput, turnDb);

    expect(outcome).toEqual({
      ok: true,
      operationId: turnSyncOperationId(hashSourceTurnKey("web", "client-msg-7")),
      sourceTurnKeyHash: hashSourceTurnKey("web", "client-msg-7"),
      deduplicated: false,
    });
    // Exactly one commit carrying all three writes — rows and operation are
    // atomic (R9): no row can exist without its operation or vice versa.
    expect(commits).toEqual([3]);

    const hash = hashSourceTurnKey("web", "client-msg-7");
    const userRow = turnStore.get(`agent_conversations/${PHONE}/messages/${turnMessageDocId(hash, "user")}`);
    const assistantRow = turnStore.get(`agent_conversations/${PHONE}/messages/${turnMessageDocId(hash, "assistant")}`);
    expect(userRow).toEqual({
      role: "user", content: turnInput.userText, timestamp: turnInput.turnTimestampMs,
      sourceTurnKeyHash: hash, sourceChannel: "web", memorySyncStatus: "pending",
    });
    expect(assistantRow).toEqual({
      role: "assistant", content: turnInput.assistantText, timestamp: turnInput.turnTimestampMs + 1,
      sourceTurnKeyHash: hash, sourceChannel: "web", memorySyncStatus: "pending",
    });

    const op = turnStore.get(`memory_operations/${turnSyncOperationId(hash)}`) as any;
    expect(op.kind).toBe("turn_sync");
    expect(op.sourceMessageRefs).toEqual([
      `agent_conversations/${PHONE}/messages/${turnMessageDocId(hash, "user")}`,
      `agent_conversations/${PHONE}/messages/${turnMessageDocId(hash, "assistant")}`,
    ]);
    expect(op.sourceTurnTimestamp).toBe(turnInput.turnTimestampMs);
    expect(op.targets.learnedFacts.status).toBe("pending");
  });

  it("retrying the same source key is a deduplicated no-op — no duplicate rows, no operation reset (R9/AE10)", async () => {
    await persistCompletedTurn(turnInput, turnDb);
    const before = new Map(turnStore);

    const retry = await persistCompletedTurn({ ...turnInput, assistantText: "different retry text" }, turnDb);

    expect(retry.ok).toBe(true);
    expect((retry as { deduplicated: boolean }).deduplicated).toBe(true);
    // The atomic batch rejected everything: same doc count, byte-identical rows
    // (the retry's divergent text never landed), operation untouched.
    expect(turnStore.size).toBe(before.size);
    for (const [path, data] of before) expect(turnStore.get(path)).toEqual(data);
  });

  it("a Firestore failure returns a typed outcome WITHOUT throwing into the caller's turn (R8) and logs no phone", async () => {
    failTurnCommit = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await persistCompletedTurn(turnInput, turnDb);
      expect(outcome).toEqual({ ok: false, errorClass: "Error" });
      // R21: the failure log carries channel + error class only.
      const serialized = JSON.stringify(errorSpy.mock.calls);
      expect(serialized).toContain("memory_turn_persistence_failed");
      expect(serialized).not.toContain(PHONE);
      expect(serialized).not.toContain("secret detail");
      expect(serialized).not.toContain(turnInput.userText);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("an empty turn is refused (typed outcome) — empty history rows poison later model calls", async () => {
    expect(await persistCompletedTurn({ ...turnInput, userText: "  " }, turnDb)).toEqual({ ok: false, errorClass: "empty_turn" });
    expect(await persistCompletedTurn({ ...turnInput, assistantText: "" }, turnDb)).toEqual({ ok: false, errorClass: "empty_turn" });
    expect(turnStore.size).toBe(0);
  });

  it("a missing/blank source key gets no idempotency promise: typed refusal, no writes", async () => {
    expect(await persistCompletedTurn({ ...turnInput, sourceKey: "  " }, turnDb)).toEqual({ ok: false, errorClass: "missing_source_key" });
    expect(turnStore.size).toBe(0);
  });

  it("the operation doc stores references/hashes only — never the message text or a phone scalar (R14/R21)", async () => {
    await persistCompletedTurn(turnInput, turnDb);
    const hash = hashSourceTurnKey("web", "client-msg-7");
    const op = turnStore.get(`memory_operations/${turnSyncOperationId(hash)}`) as Record<string, unknown>;
    const serialized = JSON.stringify(op);
    expect(serialized).not.toContain(turnInput.userText);
    expect(serialized).not.toContain(turnInput.assistantText);
    expect(serialized).not.toContain("client-msg-7"); // raw provider key never stored
    expect(op.phone).toBeUndefined();
    for (const value of Object.values(op)) expect(value).not.toBe(PHONE);
  });

  it("the same key on different channels can never collide (Linq eventId vs web clientMessageId)", async () => {
    await persistCompletedTurn(turnInput, turnDb);
    const second = await persistCompletedTurn({ ...turnInput, channel: "linq" }, turnDb);
    expect(second.ok).toBe(true);
    expect((second as { deduplicated: boolean }).deduplicated).toBe(false);
    const opDocs = [...turnStore.keys()].filter(k => k.startsWith("memory_operations/"));
    expect(opDocs).toHaveLength(2);
  });
});
