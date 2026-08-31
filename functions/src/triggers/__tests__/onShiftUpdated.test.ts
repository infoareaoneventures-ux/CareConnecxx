import { describe, it, expect, vi, beforeEach } from "vitest";

// Booking-pipeline parity (2026-08-30): a visit booked via the newer
// booking_requests/shifts pipeline lives in `shifts`, not `appointments` —
// onAppointmentUpdated (which only watches `appointments`) never fired for
// it, so a caregiver cancelling one triggered no family alert and no
// replacement search at all. onShiftUpdated reuses the exact same
// cancellation-detection + handoff, scoped to just that branch. These tests
// lock in the detection: non-cancellation changes are ignored, and a real
// caregiver cancellation on a `shifts` doc reaches the shared handler.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    update: vi.fn(async (data: any) => {
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: (..._a: any[]) => makeCollRef(path),
    limit: (..._a: any[]) => makeCollRef(path),
    get: async () => ({ empty: true, docs: [] }),
  });

  const dbMock = { collection: (p: string) => makeCollRef(p) };

  return {
    docState, dbMock,
    reset: () => { docState.clear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, {
    FieldValue: { delete: () => ({ __delete: true }) },
  }),
}));

// Builder mock: functions.firestore.document(path).onUpdate(handler) → handler
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onUpdate: (h: any) => h, onCreate: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

const sendToPhone = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendToPhone: (...a: unknown[]) => sendToPhone(...a) }));

const sendViaInteractionAgent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendViaInteractionAgent(...a) }));

const scoreReplacements = vi.fn().mockResolvedValue([]);
vi.mock("../../agents/replacementScorer", () => ({ scoreReplacements: (...a: unknown[]) => scoreReplacements(...a) }));

const scheduleTrigger = vi.fn().mockResolvedValue("trig-1");
vi.mock("../triggerEngine", () => ({ scheduleTrigger: (...a: unknown[]) => scheduleTrigger(...a) }));

// Deterministic "2 hours from now" regardless of the real current date, so the
// same-day/imminent replacement-search branch is always the one exercised.
vi.mock("../../utils/scheduledTime", () => ({
  parseScheduledTimeMs: () => Date.now() + 2 * 60 * 60 * 1000,
}));

const claim = vi.fn().mockResolvedValue({ leaseOwner: "owner-1" });
const complete = vi.fn().mockResolvedValue(undefined);
const fail = vi.fn().mockResolvedValue(undefined);
vi.mock("../../operations/externalSideEffect", () => ({
  claimExternalSideEffectOperation: (...a: unknown[]) => claim(...a),
  completeExternalSideEffectOperation: (...a: unknown[]) => complete(...a),
  failExternalSideEffectOperation: (...a: unknown[]) => fail(...a),
  externalOperationDocId: (key: string) => key.replace(/[/:]/g, "_"),
}));

import { onShiftUpdated } from "../appointmentUpdated";

const handler = onShiftUpdated as unknown as (change: any, context: any) => Promise<void>;

function makeChange(id: string, before: any, after: any) {
  return {
    before: { data: () => before },
    after: { id, data: () => after, updateTime: { toMillis: () => 12345 } },
  };
}

const CLIENT_ID = "client-1";
const CG_ID = "cg-1";

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  claim.mockResolvedValue({ leaseOwner: "owner-1" });
  scoreReplacements.mockResolvedValue([]);
  hoisted.docState.set(`users/${CLIENT_ID}`, { phone: "+15550001111" });
});

describe("onShiftUpdated", () => {
  it("ignores a shift with no status change", async () => {
    const shift = { clientId: CLIENT_ID, caregiverId: CG_ID, status: "scheduled", date: "2026-09-01", startTime: "09:00" };
    await handler(makeChange("s1", shift, shift), { eventId: "e1" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("ignores a status change that isn't a caregiver cancellation (e.g. in-progress)", async () => {
    const before = { clientId: CLIENT_ID, caregiverId: CG_ID, status: "scheduled", date: "2026-09-01", startTime: "09:00" };
    const after  = { ...before, status: "in-progress" };
    await handler(makeChange("s1", before, after), { eventId: "e1" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("ignores a shift with no clientId", async () => {
    const before = { caregiverId: CG_ID, status: "scheduled" };
    const after  = { caregiverId: CG_ID, status: "cancelled", cancelledBy: "caregiver" };
    await handler(makeChange("s1", before, after), { eventId: "e1" });
    expect(claim).not.toHaveBeenCalled();
  });

  it("detects a caregiver cancellation on a shifts doc and hands off to the shared replacement flow", async () => {
    const before = { clientId: CLIENT_ID, caregiverId: CG_ID, caregiverName: "Alice", status: "scheduled", date: "2026-09-01", startTime: "09:00" };
    const after  = { ...before, status: "cancelled", cancelledBy: "caregiver" };
    await handler(makeChange("s1", before, after), { eventId: "e1" });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      operationType: "caregiver_cancellation",
      targetId: "s1",
    }));
    // scoreReplacements called with the shift's date/time (startTime normalized to `time`)
    expect(scoreReplacements).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT_ID, date: "2026-09-01", time: "09:00", excludeId: CG_ID,
    }));
    // No matches found → the "couldn't find a replacement" message goes out.
    expect(sendViaInteractionAgent).toHaveBeenCalledWith(
      "+15550001111",
      expect.objectContaining({ content: expect.stringContaining("wasn't able to find") }),
    );
    expect(complete).toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("also detects the caregiver_called_out status variant", async () => {
    const before = { clientId: CLIENT_ID, caregiverId: CG_ID, status: "scheduled", date: "2026-09-01", startTime: "09:00" };
    const after  = { ...before, status: "caregiver_called_out" };
    await handler(makeChange("s1", before, after), { eventId: "e1" });
    expect(claim).toHaveBeenCalled();
  });
});
