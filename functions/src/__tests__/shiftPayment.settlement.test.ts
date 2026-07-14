// U1 — charge-before-transfer safety + reversal.
//
// Pins the core money-safety property: a caregiver is paid (Connect transfer)
// ONLY after the funding charge has actually settled. A charge that settles
// asynchronously ('processing') holds the shift in 'charge_pending' with no
// transfer; the payment_intent.succeeded webhook completes it later. A charge
// that fails after a payout reverses the transfer.
//
// NOTE: this exercises the Firestore/Stripe orchestration with mocks. It does
// NOT replace live Stripe test-mode validation of the real 'processing' ->
// succeeded / payment_failed webhook sequence, which remains required before merge.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";

  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    // Subcollections (e.g. users/{id}/notifications) — pushNotification writes here.
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    add: vi.fn(async (data: any) => { docState.set(`${path}/auto`, data); return { id: "auto" }; }),
  });
  const dbApi: any = {
    collection: (p: string) => makeCollRef(p),
    runTransaction: vi.fn(async (callback: (transaction: any) => Promise<any>) => callback({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      update: (ref: any, data: any) => ref.update(data),
    })),
  };
  const firestoreFn: any = Object.assign(() => dbApi, {
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
  });

  // Per-test-configurable Stripe surface.
  const stripeApi = {
    paymentIntents: {
      create:   vi.fn(async () => ({ id: "pi_1", status: "succeeded" })),
      retrieve: vi.fn(async () => ({ id: "pi_1", status: "succeeded" })),
    },
    transfers: {
      create:         vi.fn(async () => ({ id: "tr_1" })),
      createReversal: vi.fn(async () => ({ id: "trr_1" })),
    },
    customers: {
      retrieve: vi.fn(async () => ({ invoice_settings: { default_payment_method: "pm_1" } })),
    },
  };

  // Constructable for shiftHours.ts's `const Stripe = require('stripe'); new Stripe()`.
  function StripeClass(this: any) { return stripeApi; }

  return {
    docState, updates, firestoreFn, stripeApi, StripeClass,
    reset: () => {
      docState.clear(); updates.length = 0;
      stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_1", status: "succeeded" } as any);
      stripeApi.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded" } as any);
      stripeApi.transfers.create.mockClear();
      stripeApi.transfers.createReversal.mockClear();
      stripeApi.paymentIntents.create.mockClear();
      stripeApi.paymentIntents.retrieve.mockClear();
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));

import { processShiftPayment, completeShiftPaymentAfterCharge, reverseShiftTransfer } from "../shiftHours";

// Seed the docs processShiftPayment reads: caregiver Connect account + client customer.
function seedPayableEnv() {
  hoisted.docState.set("caregivers/cg1", { stripeAccountId: "acct_cg1" });
  hoisted.docState.set("customers/cl1", { stripeCustomerId: "cus_1" });
}

const baseShift = { caregiverId: "cg1", clientId: "cl1", grossPay: 100, currency: "usd", paymentMethod: "credit" };

async function processSeededShift(appointmentId: string, shift: Record<string, unknown>) {
  hoisted.docState.set(`shiftHours/${appointmentId}`, { ...shift });
  return processShiftPayment(appointmentId, shift);
}

describe("U1 — charge-before-transfer settlement", () => {
  beforeEach(() => { hoisted.reset(); seedPayableEnv(); });

  it("pays the caregiver when the charge settles synchronously", async () => {
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_sync", status: "succeeded" } as any);
    const r = await processSeededShift("a1", { ...baseShift });
    expect(r.ok).toBe(true);
    expect(hoisted.stripeApi.transfers.create).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get("shiftHours/a1")?.status).toBe("paid");
  });

  it("does NOT transfer when the charge is still processing — holds charge_pending", async () => {
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_proc", status: "processing" } as any);
    const r = await processSeededShift("a2", { ...baseShift });
    expect(r.ok).toBe(true);
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
    expect(hoisted.docState.get("shiftHours/a2")?.status).toBe("charge_pending");
    expect(hoisted.docState.get("shiftHours/a2")?.stripeChargeId).toBe("pi_proc");
  });

  it("completeShiftPaymentAfterCharge pays out a charge_pending shift (the success webhook path)", async () => {
    hoisted.docState.set("shiftHours/a3", { ...baseShift, status: "charge_pending", stripeChargeId: "pi_proc" });
    await completeShiftPaymentAfterCharge("a3");
    expect(hoisted.stripeApi.transfers.create).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get("shiftHours/a3")?.status).toBe("paid");
  });

  it("completeShiftPaymentAfterCharge is a no-op on an already-paid shift (no double transfer)", async () => {
    hoisted.docState.set("shiftHours/a4", { ...baseShift, status: "paid", stripeChargeId: "pi_x", stripeTransferId: "tr_x" });
    await completeShiftPaymentAfterCharge("a4");
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
  });

  it("reverseShiftTransfer reverses a payout when the charge later fails", async () => {
    const issued = await reverseShiftTransfer("a5", { ...baseShift, stripeTransferId: "tr_paid" });
    expect(issued).toBe(true);
    expect(hoisted.stripeApi.transfers.createReversal).toHaveBeenCalledWith(
      "tr_paid", expect.anything(), expect.objectContaining({ idempotencyKey: "shift-reversal-a5-generation-1" }),
    );
  });

  it("reverseShiftTransfer is a no-op when no transfer exists", async () => {
    const issued = await reverseShiftTransfer("a6", { ...baseShift });
    expect(issued).toBe(false);
    expect(hoisted.stripeApi.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("short-circuits an already-settled shift without touching Stripe", async () => {
    const r = await processSeededShift("a7", { ...baseShift, status: "paid", stripeChargeId: "pi_x", stripeTransferId: "tr_x" });
    expect(r.ok).toBe(true);
    expect(hoisted.stripeApi.paymentIntents.create).not.toHaveBeenCalled();
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
  });

  it("creates a fresh PaymentIntent when retrying a terminal failed charge", async () => {
    hoisted.stripeApi.paymentIntents.retrieve.mockResolvedValue({ id: "pi_failed", status: "requires_payment_method" } as any);
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_retry", status: "succeeded" } as any);
    const r = await processSeededShift("a8", {
      ...baseShift,
      status: "payment_failed",
      stripeChargeId: "pi_failed",
      paymentAttemptCount: 1,
    });
    expect(r.ok).toBe(true);
    expect(hoisted.stripeApi.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "shift-charge-a8-generation-1-attempt-2" }),
    );
    expect(hoisted.docState.get("shiftHours/a8")?.stripeChargeId).toBe("pi_retry");
    expect(hoisted.stripeApi.transfers.create).toHaveBeenCalledTimes(1);
  });

  // U11 scenario 3 — a missing client payment method must move the shift to
  // payment_failed (NOT mark it paid / report a false success), must not charge,
  // and must not pay out the caregiver.
  it("moves to payment_failed (not silent success) when the client has no default payment method", async () => {
    hoisted.stripeApi.customers.retrieve.mockResolvedValueOnce({ invoice_settings: {} } as any); // no default_payment_method, no default_source
    const r = await processSeededShift("a9", { ...baseShift });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/default payment method/i);
    expect(hoisted.stripeApi.paymentIntents.create).not.toHaveBeenCalled();
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
    const shift = hoisted.docState.get("shiftHours/a9");
    expect(shift?.status).toBe("payment_failed");
    expect(shift?.status).not.toBe("paid");
    expect(shift?.stripeFailureReason).toMatch(/default payment method/i);
  });

  // U11 scenario 4 (highest-value) — duplicate approval / re-fire of the
  // payment path must NOT create a second charge or a second transfer. The
  // hard idempotency short-circuit in processShiftPayment is the guard: once a
  // shift is paid (charge + transfer recorded), a second invocation is a no-op.
  it("duplicate approval does not double-charge or double-transfer (idempotency)", async () => {
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_dup", status: "succeeded" } as any);

    // First approval → exactly one charge + one transfer, shift becomes paid.
    const r1 = await processSeededShift("a10", { ...baseShift });
    expect(r1.ok).toBe(true);
    expect(hoisted.stripeApi.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(hoisted.stripeApi.transfers.create).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get("shiftHours/a10")?.status).toBe("paid");

    // Second approval reads the now-settled shift and must short-circuit —
    // no new charge, no new transfer, still exactly one of each total.
    const settled = hoisted.docState.get("shiftHours/a10");
    const r2 = await processShiftPayment("a10", { ...settled });
    expect(r2.ok).toBe(true);
    expect(hoisted.stripeApi.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(hoisted.stripeApi.transfers.create).toHaveBeenCalledTimes(1);
  });
});
