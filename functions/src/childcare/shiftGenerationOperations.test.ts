import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── In-memory Firestore mock (bookingCallables.test.ts pattern: ==, in, <=) ───
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, p: string): unknown =>
    p.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };

  const makeDocRef = (p: string): any => ({
    id: p.split("/").pop(),
    path: p,
    get: async () => ({
      exists: docs.has(p),
      id: p.split("/").pop(),
      data: () => docs.get(p),
      ref: makeDocRef(p),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(p, opts?.merge ? { ...(docs.get(p) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(p)) {
        const err: any = new Error(`5 NOT_FOUND: ${p}`);
        err.code = 5;
        throw err;
      }
      docs.set(p, { ...(docs.get(p) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${p}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (p: string): any => {
    const q = makeQuery(p);
    return {
      doc: (id?: string) => makeDocRef(`${p}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${p}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      orderBy: q.orderBy,
      limit: q.limit,
      get: q.get,
    };
  };

  // Reads-before-writes is enforced so a transaction that writes then reads
  // fails here exactly as it would against real Firestore.
  const runTransaction = async (fn: any) => {
    let wrote = false;
    const tx = {
      get: async (ref: any) => {
        if (wrote) throw new Error("Firestore transactions require all reads before all writes");
        return ref.get();
      },
      set: (ref: any, data: any, opts?: any) => {
        wrote = true;
        void ref.set(data, opts);
      },
      update: (ref: any, data: any) => {
        wrote = true;
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
    };
    return fn(tx);
  };

  return {
    docs,
    db: { collection: (p: string) => makeCollRef(p), runTransaction },
    reset: () => docs.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      increment: (n: number) => ({ __increment: n }),
      delete: () => ({ __delete: true }),
    },
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  default: {},
  pubsub: { schedule: () => ({ onRun: (h: any) => h }) },
}));

// The generator itself (heavy import graph) is stubbed; its deterministic-ID
// duplicate-freedom is simulated so replay behavior is observable.
const generateMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./bookingCallables", () => ({
  generateChildcareShiftsForBooking: generateMock,
}));

import {
  CHILDCARE_SHIFT_GENERATION_OPERATIONS,
  TERMINAL_SHIFT_GENERATION_STATES,
  enqueueShiftGenerationInTransaction,
  enqueueShiftGenerationOperation,
  isTerminalShiftGenerationState,
  processShiftGenerationOperation,
  readShiftGenerationOperationInTransaction,
  reconcileAndProcessChildcareShiftGeneration,
  shiftGenerationEnqueuePlan,
  shiftGenerationOperationDoc,
  shiftGenerationOperationId,
} from "./shiftGenerationOperations";
import type { ChildcareBookingDoc } from "./bookingPolicy";

const booking = {
  bookingId: "booking-1",
  careVertical: "child",
  stateVersion: 7,
  status: "confirmed",
} as ChildcareBookingDoc;

const NOW = new Date("2026-07-25T00:00:00Z");
const LATER = new Date("2026-07-25T02:00:00Z");
const OP_ID = shiftGenerationOperationId("booking-1", 7);
const OP_PATH = `${CHILDCARE_SHIFT_GENERATION_OPERATIONS}/${OP_ID}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = () => hoisted.db as any;
const op = () => hoisted.docs.get(OP_PATH);

function seedBooking(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("booking_requests/booking-1", {
    ...(booking as unknown as Record<string, unknown>),
    ...overrides,
  });
}

/** Simulates the real generator: deterministic per-date shift IDs, create-if-absent. */
function deterministicGenerator(dates: string[]) {
  return async () => {
    let created = 0;
    for (const date of dates) {
      const p = `appointments/child_booking-1_${date}`;
      if (!hoisted.docs.has(p)) {
        hoisted.docs.set(p, { bookingRequestId: "booking-1", date, status: "scheduled" });
        created++;
      }
    }
    return created;
  };
}
const shiftCount = () =>
  [...hoisted.docs.keys()].filter((k) => k.startsWith("appointments/")).length;

beforeEach(() => {
  hoisted.reset();
  generateMock.mockReset();
  generateMock.mockImplementation(async () => 0);
});

describe("childcare shift generation operations", () => {
  it("keys work by booking and schedule version", () => {
    expect(shiftGenerationOperationId("booking-1", 7))
      .toBe(shiftGenerationOperationId("booking-1", 7));
    expect(shiftGenerationOperationId("booking-1", 7))
      .not.toBe(shiftGenerationOperationId("booking-1", 8));
  });

  it("builds retryable pending work with bounded correlation", () => {
    expect(shiftGenerationOperationDoc(booking, NOW))
      .toMatchObject({
        careVertical: "child",
        bookingId: "booking-1",
        scheduleVersion: 7,
        state: "pending",
        attempt: 0,
      });
  });

  it("confirmation writes the booking and generation operation in one transaction", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "bookingCallables.ts"), "utf8");
    const start = src.indexOf("async function confirmChildcareBookingIfReady");
    const body = src.slice(start, src.indexOf("// ── U8 payment seam", start));
    expect(body).toContain("db.runTransaction");
    expect(body).toContain("enqueueShiftGenerationInTransaction");
    expect(body).not.toContain("await generateChildcareShiftsForBooking");
    // The idempotency read must precede the booking write (Firestore ordering).
    expect(body.indexOf("readShiftGenerationOperationInTransaction"))
      .toBeLessThan(body.indexOf("tx.set(ref, transition.next)"));
  });

  it("the daily scheduler runs childcare before the senior empty return and excludes child cleanup", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "scheduled", "shiftGenerator.ts"),
      "utf8",
    );
    expect(src.indexOf("childcareProcessed = await sweepChildcareRollingShifts"))
      .toBeLessThan(src.indexOf("if (bookingsSnap.empty)"));
    expect(src).toContain("doc.data()?.careVertical !== 'child'");
  });
});

// ── Enqueue idempotency (terminal states are FINAL) ──────────────────────────

describe("enqueue idempotency — terminal operations are never reset", () => {
  it("plans create / noop / resume from the existing state", () => {
    expect(shiftGenerationEnqueuePlan(null, booking, NOW).action).toBe("create");
    for (const state of TERMINAL_SHIFT_GENERATION_STATES) {
      expect(
        shiftGenerationEnqueuePlan({ exists: true, data: () => ({ state }) }, booking, NOW).action,
      ).toBe("noop");
    }
    for (const state of ["pending", "processing", "retryable_failure"]) {
      const plan = shiftGenerationEnqueuePlan(
        { exists: true, data: () => ({ state }) }, booking, NOW,
      );
      expect(plan.action).toBe("resume");
      expect(plan.payload).toEqual({ updatedAt: NOW.toISOString() });
    }
    // Corrupt/absent state self-heals into a fresh pending doc rather than
    // becoming permanently unqueryable.
    expect(
      shiftGenerationEnqueuePlan({ exists: true, data: () => ({}) }, booking, NOW).action,
    ).toBe("create");
    expect(isTerminalShiftGenerationState("completed")).toBe(true);
    expect(isTerminalShiftGenerationState("pending")).toBe(false);
  });

  it("first enqueue creates the pending operation", async () => {
    await enqueueShiftGenerationOperation(booking, { db: db(), now: NOW });
    expect(op()).toMatchObject({ state: "pending", attempt: 0, bookingId: "booking-1" });
  });

  it("replaying the trigger seam against a COMPLETED operation preserves it entirely", async () => {
    const completed = {
      ...shiftGenerationOperationDoc(booking, NOW),
      state: "completed",
      attempt: 3,
      createdCount: 5,
      completedAt: NOW.toISOString(),
      nextAttemptAt: null,
      updatedAt: NOW.toISOString(),
    };
    hoisted.docs.set(OP_PATH, { ...completed });

    // The trigger seam fires on EVERY booking write — replay it many times.
    for (let i = 0; i < 5; i++) {
      await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    }

    // Byte-identical: no state regression, no counter reset, nothing dropped.
    expect(op()).toEqual(completed);
    expect(op().state).toBe("completed");
    expect(op().createdCount).toBe(5);
    expect(op().completedAt).toBe(NOW.toISOString());
    expect(op().attempt).toBe(3);
  });

  it("a completed operation is not re-processed and creates no duplicate shifts", async () => {
    seedBooking();
    generateMock.mockImplementation(deterministicGenerator(["2026-07-27", "2026-08-03"]));

    await enqueueShiftGenerationOperation(booking, { db: db(), now: NOW });
    expect(await processShiftGenerationOperation(OP_ID, { db: db(), now: NOW })).toBe("completed");
    expect(op()).toMatchObject({ state: "completed", createdCount: 2 });
    expect(shiftCount()).toBe(2);
    expect(generateMock).toHaveBeenCalledTimes(1);

    // Trigger replays + the 15-minute reconciler must both be no-ops.
    for (let i = 0; i < 3; i++) {
      await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
      await reconcileAndProcessChildcareShiftGeneration({ db: db(), now: LATER });
    }
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(shiftCount()).toBe(2);
    expect(op()).toMatchObject({
      state: "completed",
      createdCount: 2,
      completedAt: NOW.toISOString(),
    });
  });

  it("escalated and skipped operations are equally final (never resurrected)", async () => {
    for (const state of ["escalated", "skipped"] as const) {
      hoisted.reset();
      const terminal = {
        ...shiftGenerationOperationDoc(booking, NOW),
        state,
        attempt: 8,
        nextAttemptAt: null,
      };
      hoisted.docs.set(OP_PATH, { ...terminal });
      await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
      expect(op()).toEqual(terminal);
    }
  });

  it("the confirm-transaction enqueue honours the same terminal rule", async () => {
    const completed = {
      ...shiftGenerationOperationDoc(booking, NOW),
      state: "completed",
      createdCount: 4,
      completedAt: NOW.toISOString(),
    };
    hoisted.docs.set(OP_PATH, { ...completed });
    await db().runTransaction(async (tx: any) => {
      const existing = await readShiftGenerationOperationInTransaction(tx, db(), booking);
      enqueueShiftGenerationInTransaction(tx, db(), booking, LATER, existing);
    });
    expect(op()).toEqual(completed);

    // …and still creates the operation when none exists yet.
    hoisted.reset();
    await db().runTransaction(async (tx: any) => {
      const existing = await readShiftGenerationOperationInTransaction(tx, db(), booking);
      enqueueShiftGenerationInTransaction(tx, db(), booking, LATER, existing);
    });
    expect(op()).toMatchObject({ state: "pending", attempt: 0 });
  });
});

describe("enqueue idempotency — non-terminal operations stay resumable", () => {
  it("a pending operation keeps its attempt count and is still claimable", async () => {
    seedBooking();
    generateMock.mockImplementation(deterministicGenerator(["2026-07-27"]));
    const pending = {
      ...shiftGenerationOperationDoc(booking, NOW),
      attempt: 3,
      updatedAt: NOW.toISOString(),
    };
    hoisted.docs.set(OP_PATH, { ...pending });

    await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    expect(op().state).toBe("pending");
    expect(op().attempt).toBe(3); // NOT reset to 0
    expect(op().updatedAt).toBe(LATER.toISOString());

    expect(await processShiftGenerationOperation(OP_ID, { db: db(), now: LATER }))
      .toBe("completed");
    expect(op().attempt).toBe(4);
  });

  it("a retryable_failure keeps its backoff and is still resumable", async () => {
    seedBooking();
    generateMock.mockImplementation(deterministicGenerator(["2026-07-27"]));
    const failed = {
      ...shiftGenerationOperationDoc(booking, NOW),
      state: "retryable_failure",
      attempt: 2,
      nextAttemptAt: NOW.toISOString(),
      lastErrorCode: "Error",
    };
    hoisted.docs.set(OP_PATH, { ...failed });

    await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    expect(op().state).toBe("retryable_failure");
    expect(op().attempt).toBe(2);
    expect(op().nextAttemptAt).toBe(NOW.toISOString()); // backoff not skipped
    expect(op().lastErrorCode).toBe("Error");

    const outcome = await reconcileAndProcessChildcareShiftGeneration({ db: db(), now: LATER });
    expect(outcome.processed).toBe(1);
    expect(op().state).toBe("completed");
  });

  it("a stale-lease processing operation is resumable and never duplicates shifts", async () => {
    seedBooking();
    generateMock.mockImplementation(deterministicGenerator(["2026-07-27", "2026-08-03"]));
    hoisted.docs.set(OP_PATH, {
      ...shiftGenerationOperationDoc(booking, NOW),
      state: "processing",
      attempt: 1,
      leaseOwner: "dead-worker",
      leaseExpiresAt: NOW.toISOString(), // expired relative to LATER
    });

    await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    expect(op().state).toBe("processing");
    expect(op().leaseOwner).toBe("dead-worker");

    expect(await processShiftGenerationOperation(OP_ID, { db: db(), now: LATER }))
      .toBe("completed");
    expect(shiftCount()).toBe(2);
    // Replay after recovery: deterministic IDs + terminal state = no duplicates.
    await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    await reconcileAndProcessChildcareShiftGeneration({ db: db(), now: LATER });
    expect(shiftCount()).toBe(2);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("bounded retries still terminate under trigger replay", () => {
  it("a permanently failing operation escalates within MAX_ATTEMPTS despite replays", async () => {
    seedBooking();
    generateMock.mockImplementation(async () => {
      throw new Error("generator down");
    });

    let rounds = 0;
    // Interleave the trigger seam with the worker: the enqueue must not reset
    // `attempt`, or the retry cap can never be reached.
    for (let i = 0; i < 40 && op()?.state !== "escalated"; i++) {
      await enqueueShiftGenerationOperation(booking, { db: db(), now: NOW });
      try {
        await processShiftGenerationOperation(OP_ID, { db: db(), now: NOW });
      } catch {
        /* retryable failures rethrow by design */
      }
      rounds++;
    }

    expect(op().state).toBe("escalated");
    expect(op().attempt).toBe(8);
    expect(rounds).toBeLessThanOrEqual(8);
    expect(op().nextAttemptAt).toBeNull();
    expect(
      hoisted.docs.get(`admin_alerts/shift_generation_${OP_ID}`),
    ).toMatchObject({
      type: "childcare_shift_generation_retry_exhausted",
      careVertical: "child",
      severity: "critical",
    });

    // The escalation survives further trigger replays (the alert stays actionable).
    const before = { ...op() };
    await enqueueShiftGenerationOperation(booking, { db: db(), now: LATER });
    await reconcileAndProcessChildcareShiftGeneration({ db: db(), now: LATER });
    expect(op()).toEqual(before);
  });
});
