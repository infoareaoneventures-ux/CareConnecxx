import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-06: interview_action_requests is the Firestore-trigger-queue
// workaround (same pattern as accountActionQueue.ts) that lets the website's
// caregiver calendar page call the shared respondToInterviewRequest without a
// brand-new https.onCall function (blocked by the GCP org policy — see
// project memory). These tests cover the trigger's own dispatch/success/error
// bookkeeping; interviewResponse.test.ts covers the underlying logic.

const hoisted = vi.hoisted(() => {
  const respondToInterviewRequest = vi.fn();
  return { respondToInterviewRequest };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: { FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) } } },
  firestore: { FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) } },
}));

vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onCreate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

vi.mock("../../agents/interviewResponse", () => ({
  respondToInterviewRequest: hoisted.respondToInterviewRequest,
}));

import { processInterviewActionQueue } from "../interviewActionQueue";

function snap(data: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const ref = { update: vi.fn(async (d: Record<string, unknown>) => { updates.push(d); }) };
  return { snap: { data: () => data, ref }, updates };
}

beforeEach(() => {
  hoisted.respondToInterviewRequest.mockReset();
});

describe("processInterviewActionQueue", () => {
  it("dispatches respond_to_interview with the request's fields and source:'web'", async () => {
    hoisted.respondToInterviewRequest.mockResolvedValue({ status: "accepted", interviewId: "iv_1", callUrl: null, proposedTime: null });
    const { snap: s } = snap({
      type: "respond_to_interview", caregiverId: "cg1", interviewId: "iv_1", decision: "accept",
    });
    await (processInterviewActionQueue as any)(s);
    expect(hoisted.respondToInterviewRequest).toHaveBeenCalledWith({
      caregiverId: "cg1", interviewId: "iv_1", decision: "accept",
      proposedDate: undefined, proposedTime: undefined, message: undefined, source: "web",
    });
  });

  it("passes through proposedDate/proposedTime for a counter-proposal decline", async () => {
    hoisted.respondToInterviewRequest.mockResolvedValue({ status: "declined", interviewId: "iv_1", callUrl: null, proposedTime: "2026-10-01T14:00:00.000Z" });
    const { snap: s } = snap({
      type: "respond_to_interview", caregiverId: "cg1", interviewId: "iv_1", decision: "decline",
      proposedDate: "2026-10-01", proposedTime: "14:00",
    });
    await (processInterviewActionQueue as any)(s);
    expect(hoisted.respondToInterviewRequest).toHaveBeenCalledWith(expect.objectContaining({
      proposedDate: "2026-10-01", proposedTime: "14:00",
    }));
  });

  it("marks the request doc done with the result on success", async () => {
    const result = { status: "accepted", interviewId: "iv_1", callUrl: null, proposedTime: null };
    hoisted.respondToInterviewRequest.mockResolvedValue(result);
    const { snap: s, updates } = snap({ type: "respond_to_interview", caregiverId: "cg1", interviewId: "iv_1", decision: "accept" });
    await (processInterviewActionQueue as any)(s);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "done", result, error: null });
  });

  it("marks the request doc error and captures the message when the shared function throws", async () => {
    hoisted.respondToInterviewRequest.mockRejectedValue(new Error("Interview not found"));
    const { snap: s, updates } = snap({ type: "respond_to_interview", caregiverId: "cg1", interviewId: "iv_missing", decision: "accept" });
    await (processInterviewActionQueue as any)(s);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "error", error: "Interview not found" });
  });

  it("marks the request doc error for an unknown action type", async () => {
    const { snap: s, updates } = snap({ type: "not_a_real_type" });
    await (processInterviewActionQueue as any)(s);
    expect(hoisted.respondToInterviewRequest).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("error");
    expect(updates[0].error).toMatch(/Unknown interview action type/);
  });
});
