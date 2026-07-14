import { describe, it, expect, vi, beforeEach } from "vitest";

// Firestore harness + server-import mocks mirror reactToMessage.test.ts (the
// set server.ts needs to import cleanly). Covers the two client money tools
// added by the 2026-07-06 parity audit: retry_shift_payment (agent mirror of
// v1-retryShiftPayment) and update_booking_payment_method (agent mirror of
// v1-updateBookingPaymentMethod). Both are money-touching and owner-scoped, so
// the guards below are the safety contract.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    update: vi.fn(async (data: any) => { updates.push({ path, data }); docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
    set: vi.fn(async (data: any, opts?: any) => { docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data); }),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.add = vi.fn(async () => makeDocRef(`${path}/auto`));
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
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
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

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

describe("update_booking_payment_method tool", () => {
  beforeEach(() => hoisted.reset());

  const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it("rejects an unknown payment method", async () => {
    const r = await handleToolCall("update_booking_payment_method", { appointmentId: APPT, clientId: CLIENT, paymentMethod: "bitcoin" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("refuses when the booking belongs to a different client", async () => {
    hoisted.docState.set(`appointments/${APPT}`, { clientId: OTHER, status: "confirmed", isoDate: future() });
    const r = await handleToolCall("update_booking_payment_method", { appointmentId: APPT, clientId: CLIENT, paymentMethod: "credit" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(hoisted.updates).toHaveLength(0);
  });

  it("refuses when the booking is not confirmed", async () => {
    hoisted.docState.set(`appointments/${APPT}`, { clientId: CLIENT, status: "completed", isoDate: future() });
    const r = await handleToolCall("update_booking_payment_method", { appointmentId: APPT, clientId: CLIENT, paymentMethod: "credit" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("refuses when the booking has already started", async () => {
    hoisted.docState.set(`appointments/${APPT}`, { clientId: CLIENT, status: "confirmed", isoDate: "2020-01-01T00:00:00.000Z" });
    const r = await handleToolCall("update_booking_payment_method", { appointmentId: APPT, clientId: CLIENT, paymentMethod: "credit" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("switches an upcoming confirmed booking to an offline method", async () => {
    hoisted.docState.set(`appointments/${APPT}`, { clientId: CLIENT, status: "confirmed", isoDate: future() });
    const r = await handleToolCall("update_booking_payment_method", { appointmentId: APPT, clientId: CLIENT, paymentMethod: "venmo" }) as any;
    expect(r.success).toBe(true);
    expect(r.paymentMethod).toBe("venmo");
    const upd = hoisted.updates.find(u => u.path === `appointments/${APPT}`);
    expect(upd?.data).toMatchObject({ paymentMethod: "venmo" });
  });
});
