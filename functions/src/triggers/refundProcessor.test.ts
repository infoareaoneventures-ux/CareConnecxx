// Refund processor tests (childcare plan 2026-07-22-002, U8 — plan-named file).
//
// The file never had tests, so this covers the SENIOR path characterization
// FIRST (claim math, one-refund-per-request idempotency keys, partial/full,
// exceed-remaining rejection, transfer reversal, SMS notice), then the U8
// childcare cases: the R39 booking-correlation metadata (pinned exact key
// set) and the generic in-app notice replacing the senior SMS. One retry path
// yields ONE Stripe refund (AE15).

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const docs = new Map<string, any>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    add: async (data: any) => {
      const ref = makeDocRef(`${path}/auto-${docs.size}`);
      await ref.set(data);
      return ref;
    },
  });
  const db = {
    collection: (p: string) => makeCollRef(p),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => void ref.set(data, opts),
        update: (ref: any, data: any) => {
          docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
        },
      }),
  };

  const stripeApi = {
    refunds: { create: vi.fn(async () => ({ id: "re_1" })) },
    transfers: { createReversal: vi.fn(async () => ({ id: "trr_1" })) },
  };
  function StripeClass(this: any) { return stripeApi; }

  const sendViaInteractionAgent = vi.fn(async () => true);

  return {
    docs,
    db,
    stripeApi,
    StripeClass,
    sendViaInteractionAgent,
    reset: () => {
      docs.clear();
      stripeApi.refunds.create.mockClear();
      stripeApi.refunds.create.mockResolvedValue({ id: "re_1" } as any);
      stripeApi.transfers.createReversal.mockClear();
      stripeApi.transfers.createReversal.mockResolvedValue({ id: "trr_1" } as any);
      sendViaInteractionAgent.mockClear();
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => hoisted.db;
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));
vi.mock("../agents/caraAgent", () => ({ sendViaInteractionAgent: hoisted.sendViaInteractionAgent }));
vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }
  const api = {
    https: { onCall: (h: any) => h, HttpsError },
    firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) },
    pubsub: { schedule: () => ({ onRun: (h: any) => h, timeZone: () => ({ onRun: (h: any) => h }) }) },
    config: () => ({}),
  };
  return { __esModule: true, default: api, ...api };
});

import { claimApprovedRefund, processApprovedRefund, onRefundRequestWrite } from "./refundProcessor";

/* eslint-disable @typescript-eslint/no-explicit-any */
const onWriteHandler = onRefundRequestWrite as any;

const APPT = "appt-1";
const REQ = "req-1";

function seedPaidShift(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`shiftHours/${APPT}`, {
    clientId: "cl1",
    caregiverId: "cg1",
    status: "paid",
    stripeChargeId: "pi_1",
    stripeTransferId: "tr_1",
    amountCents: 10000,
    paymentGeneration: 1,
    ...overrides,
  });
  hoisted.docs.set(`appointments/${APPT}`, { clientId: "cl1", status: "completed" });
  hoisted.docs.set("users/cl1", { phone: "+15551230000" });
}

function seedApprovedRequest(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`refundRequests/${REQ}`, {
    clientId: "cl1",
    appointmentId: APPT,
    status: "approved",
    attemptCount: 0,
    ...overrides,
  });
}

beforeEach(() => hoisted.reset());

// ── Senior path characterization (pre-existing behavior, now pinned) ─────────

describe("senior refund path — characterization", () => {
  it("full refund: ONE Stripe refund + transfer reversal with stable idempotency keys, SMS notice", async () => {
    seedPaidShift();
    seedApprovedRequest();

    await processApprovedRefund(REQ);

    expect(hoisted.stripeApi.refunds.create).toHaveBeenCalledTimes(1);
    const [refundArgs, refundOpts] = hoisted.stripeApi.refunds.create.mock.calls[0] as any[];
    expect(refundArgs.payment_intent).toBe("pi_1");
    expect(refundArgs.amount).toBe(10000);
    // Senior metadata key set is byte-identical to pre-U8 (exactly these four).
    expect(Object.keys(refundArgs.metadata).sort()).toEqual(
      ["appointmentId", "clientId", "paymentGeneration", "requestId"].sort(),
    );
    expect(refundOpts.idempotencyKey).toBe(`shift-refund-${REQ}`);

    expect(hoisted.stripeApi.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect((hoisted.stripeApi.transfers.createReversal.mock.calls[0] as any[])[2].idempotencyKey).toBe(
      `shift-refund-reversal-${REQ}`,
    );

    const request = hoisted.docs.get(`refundRequests/${REQ}`);
    expect(request.status).toBe("refunded");
    expect(request.stripeRefundId).toBe("re_1");
    const shift = hoisted.docs.get(`shiftHours/${APPT}`);
    expect(shift.refundedAmountCents).toBe(10000);
    expect(shift.refundStatus).toBe("refunded");
    expect(hoisted.docs.get(`appointments/${APPT}`).paymentStatus).toBe("refunded");
    // Senior notice channel: the interaction-agent SMS.
    expect(hoisted.sendViaInteractionAgent).toHaveBeenCalledTimes(1);
  });

  it("partial refund per approved amount → partially_refunded", async () => {
    seedPaidShift();
    seedApprovedRequest({ approvedAmountCents: 4000 });
    await processApprovedRefund(REQ);
    expect((hoisted.stripeApi.refunds.create.mock.calls[0] as any[])[0].amount).toBe(4000);
    expect(hoisted.docs.get(`shiftHours/${APPT}`).refundStatus).toBe("partially_refunded");
  });

  it("an amount exceeding the remaining balance is parked under_review, no Stripe call", async () => {
    seedPaidShift({ refundedAmountCents: 8000 });
    seedApprovedRequest({ approvedAmountCents: 5000 });
    const claim = await claimApprovedRefund(REQ);
    expect(claim).toBeNull();
    const request = hoisted.docs.get(`refundRequests/${REQ}`);
    expect(request.status).toBe("under_review");
    expect(request.lastErrorCode).toBe("refund_amount_exceeds_remaining_balance");
    expect(hoisted.stripeApi.refunds.create).not.toHaveBeenCalled();
  });

  it("a mismatched client or unpaid shift is never refundable", async () => {
    seedPaidShift({ clientId: "someone-else" });
    seedApprovedRequest();
    expect(await claimApprovedRefund(REQ)).toBeNull();
    expect(hoisted.docs.get(`refundRequests/${REQ}`).lastErrorCode).toBe(
      "refund_not_authorized_for_payment",
    );
  });

  it("a duplicate trigger fire converges to ONE refund (AE15)", async () => {
    seedPaidShift();
    seedApprovedRequest();
    const change = {
      before: { exists: true, data: () => ({ status: "requested" }) },
      after: { exists: true, data: () => ({ status: "approved" }) },
    };
    await onWriteHandler(change, { params: { requestId: REQ } });
    // Re-delivery of the same transition: the request is now 'refunded', so
    // the claim refuses and Stripe is not called again.
    await onWriteHandler(change, { params: { requestId: REQ } });
    expect(hoisted.stripeApi.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("a Stripe failure releases the reservation and parks the request under_review", async () => {
    seedPaidShift();
    seedApprovedRequest();
    hoisted.stripeApi.refunds.create.mockRejectedValueOnce(new Error("stripe down"));
    await processApprovedRefund(REQ);
    const request = hoisted.docs.get(`refundRequests/${REQ}`);
    expect(request.status).toBe("under_review");
    expect(hoisted.docs.get(`shiftHours/${APPT}`).refundReservedCents).toBe(0);
    const alerts = [...hoisted.docs.values()].filter((d) => d.type === "refund_processing_failed");
    expect(alerts).toHaveLength(1);
  });
});

// ── Childcare guarded branch (U8) ────────────────────────────────────────────

describe("childcare refund branch (R39/R57 — correlation metadata + in-app notice)", () => {
  it("carries the pinned childcare metadata key set and books the same one-refund guarantees", async () => {
    seedPaidShift({ careVertical: "child", childcareBookingId: "cbook_1", billingUserId: "payer-1" });
    seedApprovedRequest({ careVertical: "child", childcareBookingId: "cbook_1" });

    await processApprovedRefund(REQ);

    const [refundArgs, refundOpts] = hoisted.stripeApi.refunds.create.mock.calls[0] as any[];
    expect(Object.keys(refundArgs.metadata).sort()).toEqual(
      ["appointmentId", "careVertical", "childcareBookingId", "clientId", "paymentGeneration", "requestId"].sort(),
    );
    expect(refundArgs.metadata.careVertical).toBe("child");
    expect(refundArgs.metadata.childcareBookingId).toBe("cbook_1");
    // Values are opaque IDs — no child data can appear in a pinned key's value.
    for (const v of Object.values(refundArgs.metadata)) expect(typeof v).toBe("string");
    expect(refundOpts.idempotencyKey).toBe(`shift-refund-${REQ}`);

    expect(hoisted.docs.get(`refundRequests/${REQ}`).status).toBe("refunded");
  });

  it("notifies the family with a generic IN-APP notice — never the senior SMS channel", async () => {
    seedPaidShift({ careVertical: "child", childcareBookingId: "cbook_1" });
    seedApprovedRequest({ careVertical: "child" });

    await processApprovedRefund(REQ);

    expect(hoisted.sendViaInteractionAgent).not.toHaveBeenCalled();
    const notices = [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith("users/cl1/notifications/"))
      .map(([, d]) => d);
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe("childcare_refund_processed");
    // Generic content: amount + timing only, no child data fields.
    expect(notices[0].body).toContain("$100.00");
    expect(JSON.stringify(notices[0])).not.toMatch(/childName|recipientLabel|allergy|custody/);
  });

  it("senior rows keep the SMS channel (parity within the same suite)", async () => {
    seedPaidShift();
    seedApprovedRequest();
    await processApprovedRefund(REQ);
    expect(hoisted.sendViaInteractionAgent).toHaveBeenCalledTimes(1);
    const notices = [...hoisted.docs.keys()].filter((p) => p.startsWith("users/cl1/notifications/"));
    expect(notices).toHaveLength(0);
  });
});
