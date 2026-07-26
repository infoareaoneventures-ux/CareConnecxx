import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => ({ default: {}, firestore: vi.fn() }));
vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (handler: unknown) => handler }) },
}));

import {
  enqueueChildcarePayoutHold,
  payoutHoldOperationId,
  processPayoutHoldOperation,
} from "./payoutHoldWorker";

function memoryDb(seed: Record<string, unknown> = {}) {
  const docs = new Map<string, any>(Object.entries(seed));
  const doc = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data),
    update: async (data: any) => docs.set(path, { ...docs.get(path), ...data }),
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string): any => ({
    doc: (id: string) => doc(`${path}/${id}`),
  });
  const db: any = {
    collection,
    runTransaction: async (handler: any) => handler({
      get: (ref: any) => ref.get(),
      create: (ref: any, data: any) => {
        if (docs.has(ref.path)) throw new Error("already exists");
        docs.set(ref.path, data);
      },
      update: (ref: any, data: any) => docs.set(ref.path, { ...docs.get(ref.path), ...data }),
    }),
  };
  return { db, docs };
}

describe("durable childcare payout holds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses one deterministic operation for duplicate source delivery", async () => {
    const { db, docs } = memoryDb();
    const input = {
      sourceType: "internal_dispute" as const,
      sourceId: "dispute-1",
      appointmentId: "shift-1",
      reason: "dispute:dispute-1",
      db,
    };
    expect((await enqueueChildcarePayoutHold(input)).created).toBe(true);
    expect((await enqueueChildcarePayoutHold(input)).created).toBe(false);
    expect([...docs.keys()].filter((path) => path.startsWith("childcare_payout_hold_operations/"))).toHaveLength(1);
  });

  it("holds once and replay converges without duplicate notices", async () => {
    const { db, docs } = memoryDb({
      "shiftHours/shift-1": {
        careVertical: "child",
        childcareBookingId: "booking-1",
        clientId: "family-1",
        caregiverId: "caregiver-1",
      },
    });
    const { operationId } = await enqueueChildcarePayoutHold({
      sourceType: "stripe_dispute",
      sourceId: "dp-1",
      appointmentId: "shift-1",
      reason: "stripe_chargeback:dp-1",
      db,
    });
    expect(await processPayoutHoldOperation(operationId, { db })).toBe("held");
    expect(await processPayoutHoldOperation(operationId, { db })).toBe("held");
    expect(docs.get("shiftHours/shift-1")).toMatchObject({
      payoutHold: true,
      payoutHoldOperationId: operationId,
    });
    expect([...docs.keys()].filter((path) => path.endsWith(`payout_hold_${operationId}`))).toHaveLength(2);
  });

  it("escalates an already-transferred payout with a deterministic alert", async () => {
    const { db, docs } = memoryDb({
      "shiftHours/shift-paid": {
        careVertical: "child",
        stripeTransferId: "tr_1",
        clientId: "family-1",
        caregiverId: "caregiver-1",
      },
    });
    const { operationId } = await enqueueChildcarePayoutHold({
      sourceType: "internal_dispute",
      sourceId: "dispute-paid",
      appointmentId: "shift-paid",
      reason: "dispute:dispute-paid",
      db,
    });
    expect(await processPayoutHoldOperation(operationId, { db })).toBe("already_paid_requires_recovery");
    expect(docs.get(`admin_alerts/payout_hold_${operationId}`)).toMatchObject({
      type: "childcare_dispute_after_payout",
      severity: "critical",
    });
  });

  it("operation IDs distinguish source and correlation", () => {
    expect(payoutHoldOperationId("stripe_dispute", "dp-1", "shift-1"))
      .not.toBe(payoutHoldOperationId("internal_dispute", "dp-1", "shift-1"));
  });
});
