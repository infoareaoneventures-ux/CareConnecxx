import { describe, it, expect, vi, beforeEach } from "vitest";

// Firestore harness + server-import mocks mirror reactToMessage.test.ts (the
// set server.ts needs to import cleanly). Covers retry_shift_payment (agent
// mirror of v1-retryShiftPayment, added by the 2026-07-06 parity audit) — a
// money-touching, owner-scoped tool, so the guards below are the safety
// contract. update_booking_payment_method (also from that audit) was removed
// along with cash/Venmo/Zelle platform-wide (Hamse, 2026-08-23) — there's
// nothing left to switch a booking's payment method to or from.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    update: vi.fn(async (data: any) => { updates.push({ path, data }); docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
    set: vi.fn(async (data: any, opts?: any) => { docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data); }),
    collection: (name: string) => makeCollRef(`${path}/${name}`),
  });

  const wheres: Array<{ path: string; field: string; op: string; value: any }> = [];

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.add = vi.fn(async () => makeDocRef(`${path}/auto`));
    ref.where = (field: string, op: string, value: any) => { wheres.push({ path, field, op, value }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  return {
    docState, updates, wheres,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; wheres.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }), delete: () => ({ __delete: true }) },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

import { handleToolCall } from "../server";

const CLIENT = "client_abc";
const OTHER  = "client_xyz";
const APPT   = "appt_1";

describe("retry_shift_payment tool", () => {
  beforeEach(() => hoisted.reset());

  it("errors when appointmentId or clientId missing", async () => {
    const r1 = await handleToolCall("retry_shift_payment", { clientId: CLIENT }) as any;
    expect(r1._toolError).toBe(true);
    expect(r1.code).toBe("INVALID_INPUT");
    const r2 = await handleToolCall("retry_shift_payment", { appointmentId: APPT }) as any;
    expect(r2._toolError).toBe(true);
  });

  it("returns NOT_FOUND when the shift record is missing", async () => {
    const r = await handleToolCall("retry_shift_payment", { appointmentId: APPT, clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });

  it("refuses when the shift belongs to a different client (ownership)", async () => {
    hoisted.docState.set(`shiftHours/${APPT}`, { clientId: OTHER, status: "payment_failed" });
    const r = await handleToolCall("retry_shift_payment", { appointmentId: APPT, clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.updates).toHaveLength(0);
  });

  it("refuses (idempotent no-op) when status is not payment_failed", async () => {
    hoisted.docState.set(`shiftHours/${APPT}`, { clientId: CLIENT, status: "paid" });
    const r = await handleToolCall("retry_shift_payment", { appointmentId: APPT, clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
    expect(hoisted.updates).toHaveLength(0);
  });

  it("resets the billing-operation retry lease before approving the payment", async () => {
    hoisted.docState.set(`shiftHours/${APPT}`, {
      clientId: CLIENT,
      status: "payment_failed",
      retryCount: 1,
      paymentGeneration: 2,
      nextPaymentAttemptAt: "2099-01-01T00:00:00.000Z",
    });
    const r = await handleToolCall("retry_shift_payment", { appointmentId: APPT, clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    const upd = hoisted.updates.find(u => u.path === `shiftHours/${APPT}`);
    expect(upd?.data).toMatchObject({
      status: "approved",
      retryCount: 2,
      nextPaymentAttemptAt: expect.any(String),
    });
    expect(Date.parse(upd?.data.nextPaymentAttemptAt)).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(hoisted.docState.get(
      `billingOperations/shift-payment:${APPT}:generation:2`,
    )).toMatchObject({
      state: "retry",
      nextAttemptAt: expect.any(String),
      lastErrorCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });
});

describe("get_billing_summary tool (canonical field split, R7)", () => {
  beforeEach(() => hoisted.reset());

  it("queries invoices by clientId and payments by userId", async () => {
    const r = await handleToolCall("get_billing_summary", { userId: CLIENT }) as any;
    expect(r.success).toBe(true);
    const invoiceWhere = hoisted.wheres.find(w => w.path === "invoices");
    const paymentWhere = hoisted.wheres.find(w => w.path === "payments");
    // Invoices are keyed by clientId (= the client uid) per invoicing.ts.
    expect(invoiceWhere).toMatchObject({ field: "clientId", op: "==", value: CLIENT });
    // Payments keep userId, matching the Stripe writer.
    expect(paymentWhere).toMatchObject({ field: "userId", op: "==", value: CLIENT });
    // The old bug: invoices filtered by userId. Guard against regression.
    expect(hoisted.wheres.some(w => w.path === "invoices" && w.field === "userId")).toBe(false);
  });
});
