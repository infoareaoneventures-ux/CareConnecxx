import { describe, it, expect, vi, beforeEach } from "vitest";

// triggers/visitActionQueue.ts (2026-10-11): the website's Start / End / ✕ /
// Cancel Booking / Log Hours arrive as visit_action_requests docs; the trigger
// routes each type to shifts/visitActions.ts with the right arguments and
// settles the doc — `done` with the typed result (a refusal included, as
// {ok:false, reason, message}), `error` only for an unexpected throw. The
// client listener (services/visitActionQueue.ts) depends on this contract.

vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onCreate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: { FieldValue: { serverTimestamp: () => "SERVER_TS" } } },
  firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => "SERVER_TS" } }),
}));

const startVisit = vi.fn();
const endVisit = vi.fn();
const cancelVisit = vi.fn();
const cancelBooking = vi.fn();
const logHours = vi.fn();
vi.mock("../../shifts/visitActions", () => ({
  startVisit: (...a: unknown[]) => startVisit(...a),
  endVisit: (...a: unknown[]) => endVisit(...a),
  cancelVisit: (...a: unknown[]) => cancelVisit(...a),
  cancelBooking: (...a: unknown[]) => cancelBooking(...a),
  logHours: (...a: unknown[]) => logHours(...a),
}));

import { processVisitActionQueue } from "../visitActionQueue";

function makeSnap(data: Record<string, unknown>) {
  const update = vi.fn().mockResolvedValue(undefined);
  return { data: () => data, ref: { update } };
}
const settled = (snap: ReturnType<typeof makeSnap>) => snap.ref.update.mock.calls[0][0];

beforeEach(() => {
  startVisit.mockReset().mockResolvedValue({ ok: true, shiftId: "s1", shift: {}, alreadyStarted: false, startedAt: "2026-10-11T18:00:00.000Z" });
  endVisit.mockReset().mockResolvedValue({ ok: true, shiftId: "s1", shift: {}, alreadyCompleted: false, completedAt: "2026-10-11T20:00:00.000Z" });
  cancelVisit.mockReset().mockResolvedValue({ ok: true, shiftId: "s1", shift: {}, status: "needs_replacement" });
  cancelBooking.mockReset().mockResolvedValue({ ok: true, shiftId: "s1", anyUrgent: false, count: 3 });
  logHours.mockReset().mockResolvedValue({ ok: true, shiftId: "s1", shift: {} });
});

describe("processVisitActionQueue", () => {
  it("start_visit → startVisit({caregiverId, shiftId}); settles done with the page's result", async () => {
    const snap = makeSnap({ type: "start_visit", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(startVisit).toHaveBeenCalledWith({ caregiverId: "cg1", shiftId: "s1" });
    expect(settled(snap)).toMatchObject({ status: "done", error: null, result: { ok: true, shiftId: "s1", status: "in-progress", alreadyStarted: false, startedAt: "2026-10-11T18:00:00.000Z" } });
  });

  it("end_visit → endVisit with the closing note (a missing note is '')", async () => {
    let snap = makeSnap({ type: "end_visit", caregiverId: "cg1", shiftId: "s1", closingNote: "Good visit." });
    await (processVisitActionQueue as any)(snap);
    expect(endVisit).toHaveBeenCalledWith({ caregiverId: "cg1", shiftId: "s1", closingNote: "Good visit." });
    expect(settled(snap).result).toEqual({ ok: true, shiftId: "s1", status: "completed", alreadyCompleted: false, completedAt: "2026-10-11T20:00:00.000Z" });
    snap = makeSnap({ type: "end_visit", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(endVisit).toHaveBeenLastCalledWith({ caregiverId: "cg1", shiftId: "s1", closingNote: "" });
  });

  it("cancel_visit → cancelVisit as the caregiver (never 'system'); the resulting status comes back", async () => {
    const snap = makeSnap({ type: "cancel_visit", caregiverId: "cg1", shiftId: "s1", cancelledBy: "system" });
    await (processVisitActionQueue as any)(snap);
    expect(cancelVisit).toHaveBeenCalledWith({ caregiverId: "cg1", shiftId: "s1", cancelledBy: "caregiver" });
    expect(settled(snap).result).toEqual({ ok: true, shiftId: "s1", status: "needs_replacement" });
  });

  it("cancel_booking → cancelBooking; anyUrgent + count for the page's toast", async () => {
    const snap = makeSnap({ type: "cancel_booking", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(cancelBooking).toHaveBeenCalledWith({ caregiverId: "cg1", shiftId: "s1" });
    expect(settled(snap).result).toEqual({ ok: true, shiftId: "s1", anyUrgent: false, count: 3 });
  });

  it("log_hours → logHours with the ISO instants parsed to ms, only string task keys, and the note", async () => {
    const snap = makeSnap({ type: "log_hours", caregiverId: "cg1", shiftId: "s1", startedAt: "2026-10-10T19:30:00.000Z", completedAt: "2026-10-10T20:05:00.000Z", tasksCompleted: ["0_a", 3, "0_b"], completionNotes: "Fine." });
    await (processVisitActionQueue as any)(snap);
    expect(logHours).toHaveBeenCalledWith({ caregiverId: "cg1", shiftId: "s1", startedAtMs: Date.parse("2026-10-10T19:30:00.000Z"), completedAtMs: Date.parse("2026-10-10T20:05:00.000Z"), tasksCompleted: ["0_a", "0_b"], completionNotes: "Fine." });
    expect(settled(snap).result).toEqual({ ok: true, shiftId: "s1", status: "completed" });
  });

  it("a refusal settles DONE with {ok:false, reason, message[, status]} — the page shows the message", async () => {
    startVisit.mockResolvedValueOnce({ ok: false, reason: "too_early", message: "Not yet — Start opens 15 minutes before the visit (11:00 AM on Mon, Sep 28, 2099)." });
    let snap = makeSnap({ type: "start_visit", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(settled(snap)).toMatchObject({ status: "done", result: { ok: false, reason: "too_early", message: expect.stringMatching(/^Not yet/) } });
    expect(settled(snap).result).not.toHaveProperty("status");
    cancelVisit.mockResolvedValueOnce({ ok: false, reason: "not_scheduled", status: "cancelled", message: "That shift is already cancelled — nothing to cancel.", caregiver: { secret: 1 } });
    snap = makeSnap({ type: "cancel_visit", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    // Only reason / message / status reach the request doc — never the caregiver record or the other visit.
    expect(settled(snap).result).toEqual({ ok: false, reason: "not_scheduled", message: "That shift is already cancelled — nothing to cancel.", status: "cancelled" });
  });

  it("missing caregiverId / shiftId, an unknown type, or a throw → status:error, nothing dispatched", async () => {
    let snap = makeSnap({ type: "start_visit", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(settled(snap)).toMatchObject({ status: "error", error: "caregiverId is required" });
    snap = makeSnap({ type: "start_visit", caregiverId: "cg1" });
    await (processVisitActionQueue as any)(snap);
    expect(settled(snap)).toMatchObject({ status: "error", error: "shiftId is required" });
    snap = makeSnap({ type: "nope", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(settled(snap)).toMatchObject({ status: "error", error: "Unknown visit action type: nope" });
    expect(startVisit).not.toHaveBeenCalled();
    endVisit.mockRejectedValueOnce(new Error("boom"));
    snap = makeSnap({ type: "end_visit", caregiverId: "cg1", shiftId: "s1" });
    await (processVisitActionQueue as any)(snap);
    expect(settled(snap)).toMatchObject({ status: "error", error: "boom" });
  });
});
