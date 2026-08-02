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

// ── Childcare U8 (plan 2026-07-22-002, R39/R40) ──────────────────────────────
//
// Childcare rows ride this SAME proven rail. The vertical branches under test:
// the platform fee comes ONLY from the frozen policy snapshot (fail closed —
// never the senior constants), the charged party is the recorded PAYER, the
// PaymentIntent carries the pinned booking/shift ledger correlation, and a
// dispute payout hold parks the row. The senior tests above are the byte-
// identical parity characterization for every one of these seams.

const childcareShift = {
  caregiverId: "cg1",
  clientId: "cl1",
  billingUserId: "payer1",
  careVertical: "child",
  childcareBookingId: "cbook_1",
  childcareShiftId: "cappt_1",
  grossPay: 100,
  currency: "usd",
  paymentMethod: "credit",
  childcarePricing: { platformFeeRate: 0.05, platformFeeMinCents: 100, currency: "usd" },
};

describe("U8 — childcare rows on the shared settlement rail", () => {
  beforeEach(() => {
    hoisted.reset();
    seedPayableEnv();
    hoisted.docState.set("customers/payer1", { stripeCustomerId: "cus_payer" });
  });

  it("charges the PAYER the policy fee (5% snapshot, not the senior 1.5%) and transfers gross", async () => {
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_cc", status: "succeeded" } as any);
    const r = await processSeededShift("cappt_1", { ...childcareShift });
    expect(r.ok).toBe(true);
    const [args] = hoisted.stripeApi.paymentIntents.create.mock.calls[0] as any[];
    // $100 gross + $5.00 policy fee (senior math would be $1.50 → 10150).
    expect(args.amount).toBe(10500);
    expect(args.customer).toBe("cus_payer"); // the recorded payer, not the guardian
    // R57/R39: pinned metadata key set — senior trio + the childcare correlation.
    expect(Object.keys(args.metadata).sort()).toEqual(
      ["appointmentId", "careVertical", "childcareBookingId", "childcareShiftId", "paymentGeneration", "shiftHoursId"].sort(),
    );
    expect(args.metadata.childcareBookingId).toBe("cbook_1");
    // Caregiver still receives exactly gross via the same transfer rail.
    const [transferArgs] = hoisted.stripeApi.transfers.create.mock.calls[0] as any[];
    expect(transferArgs.amount).toBe(10000);
    expect(hoisted.docState.get("shiftHours/cappt_1")?.status).toBe("paid");
  });

  it("FAILS CLOSED (payment_failed, no Stripe call) when the pricing snapshot is missing (R40)", async () => {
    const { childcarePricing: _omit, ...withoutSnapshot } = childcareShift as any;
    const r = await processSeededShift("cappt_2", withoutSnapshot);
    expect(r.ok).toBe(false);
    expect(hoisted.stripeApi.paymentIntents.create).not.toHaveBeenCalled();
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
    const shift = hoisted.docState.get("shiftHours/cappt_2");
    expect(shift?.status).toBe("payment_failed");
    expect(shift?.stripeFailureReason).toMatch(/fail closed|policy pricing/i);
  });

  it("a dispute/chargeback payout hold parks the row before any money moves", async () => {
    const r = await processSeededShift("cappt_3", { ...childcareShift, payoutHold: true, payoutHoldReason: "dispute:d1" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payout_hold_active");
    expect(hoisted.stripeApi.paymentIntents.create).not.toHaveBeenCalled();
    expect(hoisted.stripeApi.transfers.create).not.toHaveBeenCalled();
    expect(hoisted.docState.get("shiftHours/cappt_3")?.status).toBe("requires_admin_review");
  });

  it("senior rows never enter the childcare fee branch (no billingUserId → same customer lookup)", async () => {
    hoisted.stripeApi.paymentIntents.create.mockResolvedValue({ id: "pi_sr", status: "succeeded" } as any);
    const r = await processSeededShift("a-senior", { ...baseShift });
    expect(r.ok).toBe(true);
    const [args] = hoisted.stripeApi.paymentIntents.create.mock.calls[0] as any[];
    expect(args.amount).toBe(10150); // $100 + senior 1.5% ($1.50)
    expect(args.customer).toBe("cus_1");
    expect(Object.keys(args.metadata).sort()).toEqual(
      ["appointmentId", "paymentGeneration", "shiftHoursId"].sort(), // senior key set byte-identical
    );
  });
});
