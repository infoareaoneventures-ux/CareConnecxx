// Restored capability (Hamse, 2026-08-24): a caregiver must be able to submit
// hours directly off a `shifts` doc created by the website's own
// booking_requests -> shiftGenerator.ts pipeline, which has never written a
// matching `appointments` doc or an `appointmentId` field (confirmed via git
// history back to when that pipeline was first built). Before 2026-07-13 this
// worked; the appointments-centric billing rewrite that day broke it without
// anyone noticing, since shiftGenerator.ts was never updated to match.
//
// This test pins the restored contract: a completed shift with no
// appointmentId must produce a real, resolvable shiftHours doc (same shape
// and same billing-policy rules as the appointments-keyed path), not a
// rejection.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docState.has(path),
      id:     path.split("/").pop(),
      data:   () => docState.get(path),
    }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    },
    create: async (data: any) => {
      if (docState.has(path)) {
        const err: any = new Error("already exists");
        err.code = 6;
        throw err;
      }
      docState.set(path, data);
    },
  });

  const makeCollRef = (collPath: string): any => ({
    doc: (id: string) => makeDocRef(`${collPath}/${id}`),
  });

  const collection = vi.fn((name: string) => makeCollRef(name));

  const runTransaction = async (fn: (t: any) => Promise<any>) => fn({
    get:    (ref: any) => ref.get(),
    create: (ref: any, data: any) => ref.create(data),
    set:    (ref: any, data: any) => ref.set(data),
    update: (ref: any, data: any) => ref.update(data),
  });

  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });

  return {
    docState, collection, firestoreFn,
    reset: () => { docState.clear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default:    { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps:       [{}],
  initializeApp: vi.fn(),
  firestore:  hoisted.firestoreFn,
}));

import { createValidatedShiftHoursFromShift, ValidatedShiftHoursError } from "./createValidatedShiftHours";

const CAREGIVER = "cg_1";
const CLIENT    = "client_1";
const SHIFT_ID  = "shift_abc";

function seedCompletedShift(overrides: Record<string, unknown> = {}) {
  hoisted.docState.set(`shifts/${SHIFT_ID}`, {
    caregiverId: CAREGIVER,
    caregiverName: "Casey",
    clientId: CLIENT,
    clientName: "Family",
    status: "completed",
    date: "2026-08-24",
    startTime: "16:30",
    endTime: "18:00",
    rate: 26,
    bookingRequestId: "br_1",
    ...overrides,
  });
}

describe("createValidatedShiftHoursFromShift", () => {
  beforeEach(() => hoisted.reset());

  it("submits successfully for a completed shift with no appointmentId at all", async () => {
    seedCompletedShift();
    const result = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    });
    expect(result.status).toBe("pending_client_review");
    expect(result.alreadyExisted).toBe(false);
    expect(result.requiresExplicitApproval).toBe(false);
    expect(result.totalHours).toBe(1.5);
    expect(result.grossPayCents).toBe(3900); // 1.5h * $26

    const doc = hoisted.docState.get(`shiftHours/${SHIFT_ID}`);
    expect(doc).toMatchObject({
      appointmentId: SHIFT_ID, // backward-compat key
      caregiverId: CAREGIVER,
      clientId: CLIENT,
      status: "pending_client_review",
      billingSource: "web_legacy_shift",
    });
    expect(doc.autoApproveAt).toBeTruthy(); // no line items -> normal 24h auto-approve applies

    const outbox = hoisted.docState.get(`billingApprovalOutbox/${SHIFT_ID}:approval-request:v1`);
    expect(outbox).toMatchObject({ recipientUid: CLIENT, state: "pending" });
  });

  it("a line item forces explicit approval and disables auto-approve, same as the appointments path", async () => {
    seedCompletedShift();
    const result = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
      lineItems: [{ type: "mileage", label: "Mileage", note: "", amount: 12 }],
    });
    expect(result.requiresExplicitApproval).toBe(true);
    const doc = hoisted.docState.get(`shiftHours/${SHIFT_ID}`);
    expect(doc.autoApproveAt).toBeNull();
    expect(doc.lineItemsTotal).toBe(12);
  });

  it("rejects a different caregiver's shift", async () => {
    seedCompletedShift();
    await expect(createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: "someone_else",
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    })).rejects.toThrow(ValidatedShiftHoursError);
  });

  it("rejects a shift that isn't completed yet", async () => {
    seedCompletedShift({ status: "in-progress" });
    await expect(createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    })).rejects.toThrow(/not completed/);
  });

  it("allows hours outside the shift's own scheduled window, but forces explicit approval instead of a hard rejection", async () => {
    seedCompletedShift();
    const result = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T14:00:00.000Z", // well before the 16:30 scheduled start
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    });
    expect(result.alreadyExisted).toBe(false);
    expect(result.requiresExplicitApproval).toBe(true);
    const doc = hoisted.docState.get(`shiftHours/${SHIFT_ID}`);
    expect(doc.autoApproveAt).toBeNull();
  });

  it("allows clocking in up to 15 minutes early / out 15 minutes late (grace period)", async () => {
    seedCompletedShift();
    const result = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:20:00.000Z", // 16:20 PDT — 10 min before the 16:30 start
      submittedEndTime: "2026-08-25T01:10:00.000Z", // 18:10 PDT — 10 min after the 18:00 end
      source: "web",
    });
    expect(result.alreadyExisted).toBe(false);
  });

  it("still requires explicit approval for clocking in more than 15 minutes early, rather than rejecting", async () => {
    seedCompletedShift();
    const result = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:00:00.000Z", // 16:00 PDT — 30 min before the 16:30 start
      submittedEndTime: "2026-08-25T01:00:00.000Z",
      source: "web",
    });
    expect(result.alreadyExisted).toBe(false);
    expect(result.requiresExplicitApproval).toBe(true);
    const doc = hoisted.docState.get(`shiftHours/${SHIFT_ID}`);
    expect(doc.autoApproveAt).toBeNull();
  });

  it("is idempotent on retry with the same interval", async () => {
    seedCompletedShift();
    const first = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    });
    expect(first.alreadyExisted).toBe(false);
    const second = await createValidatedShiftHoursFromShift({
      shiftId: SHIFT_ID,
      actorUid: CAREGIVER,
      submittedStartTime: "2026-08-24T23:30:00.000Z", // 16:30 PDT
      submittedEndTime: "2026-08-25T01:00:00.000Z", // 18:00 PDT
      source: "web",
    });
    expect(second.alreadyExisted).toBe(true);
  });
});
