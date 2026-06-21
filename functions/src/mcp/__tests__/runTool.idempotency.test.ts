import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory tool_execution_ledger backed by a Map, exercising the real
// claimToolExecution/settleToolExecution semantics through a mocked
// firebase-admin. This proves a CONFIRMED idempotent action fires its side
// effect at most once across replays — the U5 money-movement guarantee.
const store = vi.hoisted(() => new Map<string, any>());

vi.mock("firebase-admin", () => {
  const makeDoc = (col: string, id: string) => {
    const k = `${col}/${id}`;
    return {
      async create(data: any) {
        if (store.has(k)) { const e: any = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
        store.set(k, { ...data });
      },
      async set(data: any, opts?: any) {
        store.set(k, opts?.merge ? { ...(store.get(k) ?? {}), ...data } : { ...data });
      },
      async delete() { store.delete(k); },
      async get() { const d = store.get(k); return { exists: !!d, data: () => d }; },
    };
  };
  const firestore = () => ({
    collection: (col: string) => ({ doc: (id: string) => makeDoc(col, id) }),
    async runTransaction(fn: any) {
      return fn({
        async get(ref: any) { return ref.get(); },
        set(ref: any, data: any) { return ref.set(data); },
        update(ref: any, data: any) { return ref.set(data, { merge: true }); },
      });
    },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

// Don't actually gate in these tests — focus on the idempotency band.
vi.mock("../../agents/pendingActions", () => ({
  isHighRisk: vi.fn().mockReturnValue(false),
  proposePendingAction: vi.fn(),
  buildPendingActionStub: vi.fn(),
}));

import { runTool, ToolHandler, RunToolContext } from "../runTool";

const ctx: RunToolContext = { phone: "+15125550123", userId: "u1", actor: "client" };

beforeEach(() => store.clear());

function payoutTool(sideEffect: () => void): ToolHandler {
  return {
    name: "request_instant_payout",
    idempotent: true,
    run: vi.fn(async () => { sideEffect(); return { success: true, payoutId: "po_1", amountCents: 5000 }; }),
  };
}

describe("runTool — confirmed-action idempotency (U5)", () => {
  it("a confirmed idempotent action runs its side effect exactly once across a replay", async () => {
    let charges = 0;
    const tool = payoutTool(() => { charges += 1; });

    const first  = await runTool(tool, { _confirmedActionId: "pa_42", amountCents: 5000 }, ctx);
    const second = await runTool(tool, { _confirmedActionId: "pa_42", amountCents: 5000 }, ctx);

    expect(charges).toBe(1);                         // no double-charge
    expect(tool.run).toHaveBeenCalledTimes(1);       // second call served from the ledger
    expect(second).toEqual(first);                   // replay returns the cached result
  });

  it("distinct inputs under the same confirmation id each run (different keys)", async () => {
    let charges = 0;
    const tool = payoutTool(() => { charges += 1; });

    await runTool(tool, { _confirmedActionId: "pa_42", amountCents: 5000 }, ctx);
    await runTool(tool, { _confirmedActionId: "pa_42", amountCents: 9000 }, ctx);

    expect(charges).toBe(2);
    expect(tool.run).toHaveBeenCalledTimes(2);
  });

  it("a failed confirmed run is NOT cached — a retry re-drives it", async () => {
    let attempts = 0;
    const tool: ToolHandler = {
      name: "request_instant_payout",
      idempotent: true,
      run: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stripe timeout");
        return { success: true, payoutId: "po_2" };
      }),
    };

    await expect(runTool(tool, { _confirmedActionId: "pa_7" }, ctx)).rejects.toThrow("stripe timeout");
    const retry = await runTool(tool, { _confirmedActionId: "pa_7" }, ctx); // claim was cleared

    expect(attempts).toBe(2);
    expect(retry).toMatchObject({ success: true, payoutId: "po_2" });
  });

  it("a tool-error result is retryable (not cached as a success)", async () => {
    let attempts = 0;
    const tool: ToolHandler = {
      name: "request_instant_payout",
      idempotent: true,
      run: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? { _toolError: true, success: false, code: "UNAVAILABLE", message: "try later" }
          : { success: true, payoutId: "po_3" };
      }),
    };

    await runTool(tool, { _confirmedActionId: "pa_9" }, ctx);
    const retry = await runTool(tool, { _confirmedActionId: "pa_9" }, ctx);

    expect(attempts).toBe(2);
    expect(retry).toMatchObject({ success: true, payoutId: "po_3" });
  });

  it("non-confirmed calls skip the ledger entirely (no key written)", async () => {
    const tool = payoutTool(() => {});
    await runTool(tool, { amountCents: 5000 }, ctx); // no _confirmedActionId
    expect(store.size).toBe(0);
  });

  it("a non-idempotent confirmed tool is not ledgered (legacy behavior preserved)", async () => {
    let runs = 0;
    const tool: ToolHandler = {
      name: "cancel_appointment",
      run: vi.fn(async () => { runs += 1; return { success: true }; }),
      // idempotent NOT set
    };
    await runTool(tool, { _confirmedActionId: "pa_x" }, ctx);
    await runTool(tool, { _confirmedActionId: "pa_x" }, ctx);
    expect(runs).toBe(2);       // re-runs (relies on the handler being naturally idempotent)
    expect(store.size).toBe(0); // ledger untouched
  });
});
