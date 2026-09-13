import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const added: Array<Record<string, unknown>> = [];
  return {
    added,
    firestore: () => ({ collection: () => ({ add: async (d: Record<string, unknown>) => { hoisted.added.push(d); return { id: `c${hoisted.added.length}` }; } }) }),
  };
});
vi.mock("firebase-admin", () => ({
  __esModule: true, default: { firestore: hoisted.firestore }, firestore: hoisted.firestore,
}));

import { submitEvalCandidate, hashSourceContent } from "./evalCandidateQueue";
import { __setTelemetryKeyForTests } from "../observability/intelligencePseudonym";
import { gradeFinalState, gradeTrajectory } from "./graders";

afterEach(() => { __setTelemetryKeyForTests(null); hoisted.added.length = 0; });

const input = {
  capability: "multi_step_completion",
  rootCause: "postcondition_mismatch" as const,
  channel: "linq" as const,
  role: "client" as const,
  actorId: "+14085550100",
  sourceRefs: ["agent_action_ledger/abc123"],
  sourceContentHash: hashSourceContent(["a", "b"]),
  metricSnapshot: { toolCalls: 4, durationMs: 1200 },
};

describe("submitEvalCandidate (U9/R46/KTD19)", () => {
  it("writes a reference-only candidate with pseudonym, SLA, and TTL — no raw identity", async () => {
    __setTelemetryKeyForTests("test-key");
    const id = await submitEvalCandidate(input, { now: new Date("2026-07-22T20:00:00Z") });
    expect(id).toBe("c1");
    const doc = hoisted.added[0];
    expect(doc.status).toBe("pending_review");
    expect(doc.reviewDeadline).toBe("2026-08-05T20:00:00.000Z"); // 14d SLA
    expect(doc.expiresAt).toBe("2026-08-21T20:00:00.000Z");      // 30d TTL
    expect(JSON.stringify(doc)).not.toContain("4085550100");
    expect(doc.actorPseudonym).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops the candidate when the telemetry key is unbound (fail-closed)", async () => {
    __setTelemetryKeyForTests(null);
    delete process.env.INTELLIGENCE_TELEMETRY_KEY;
    expect(await submitEvalCandidate(input)).toBeNull();
    expect(hoisted.added).toHaveLength(0);
  });

  it("drops candidates with content-smelling metric keys or non-path sourceRefs", async () => {
    __setTelemetryKeyForTests("test-key");
    expect(await submitEvalCandidate({ ...input, metricSnapshot: { draftTextLength: 12 } })).toBeNull();
    expect(await submitEvalCandidate({ ...input, sourceRefs: ["she said: hi mom"] })).toBeNull();
    expect(hoisted.added).toHaveLength(0);
  });
});

describe("graders (U9/KTD20)", () => {
  it("final-state grade catches false success and unexpected leftovers", () => {
    expect(gradeFinalState({ fields: { status: "cancelled" } }, { status: "confirmed" }).passed).toBe(false);
    expect(gradeFinalState({ fields: { status: "cancelled" } }, null).passed).toBe(false);
    const ok = gradeFinalState({ fields: { status: "cancelled" }, absentFields: ["error"] }, { status: "cancelled" });
    expect(ok.passed).toBe(true);
  });

  it("trajectory grade enforces required order, forbidden tools, and duplicate caps (R25)", () => {
    const spec = {
      requiredTools: ["get_caregiver_booking_rate", "request_booking"],
      requiredInOrder: true,
      forbiddenTools: ["cancel_subscription"],
      maxCallsPerTool: { request_booking: 1 },
    };
    expect(gradeTrajectory(spec, ["get_caregiver_booking_rate", "request_booking"]).passed).toBe(true);
    expect(gradeTrajectory(spec, ["request_booking", "get_caregiver_booking_rate"]).failures[0]).toMatch(/order broken/);
    expect(gradeTrajectory(spec, ["get_caregiver_booking_rate", "request_booking", "request_booking"]).failures[0]).toMatch(/duplicate effect/);
    expect(gradeTrajectory(spec, ["get_caregiver_booking_rate", "cancel_subscription", "request_booking"]).failures[0]).toMatch(/forbidden/);
  });

  it("flailing cap", () => {
    expect(gradeTrajectory({ maxTotalCalls: 2 }, ["a", "b", "c"]).failures[0]).toMatch(/flailing/);
  });
});
