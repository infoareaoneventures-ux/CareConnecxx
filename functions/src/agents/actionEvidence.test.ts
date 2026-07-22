import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});

import { verifyPostcondition, handlerOutputReceipt, type PostconditionSpec } from "./actionEvidence";
import { decideAutonomy } from "./autonomyPolicy";

const now = new Date("2026-07-22T12:00:00Z");

const spec = (verify: PostconditionSpec<{ id: string }, { ok: boolean }>["verify"]): PostconditionSpec<{ id: string }, { ok: boolean }> => ({
  kind: "fresh_read",
  description: "appointments/{id} exists with expected status",
  targetRef: (input) => `appointments/${input.id}`,
  verify,
});

describe("verifyPostcondition (U5/R24/AE6)", () => {
  it("verified: authoritative read confirms the claim → completion may be stated", async () => {
    const receipt = await verifyPostcondition(
      "request_booking",
      spec(async () => ({ ok: true, observed: { status: "pending_caregiver_confirmation" } })),
      { id: "appt-1" }, { ok: true },
      { db: {} as never, now, idempotencyKey: "k1" },
    );
    expect(receipt.status).toBe("verified");
    expect(receipt.safeClaimCode).toBe("completed_verified");
    expect(receipt.targetRef).toBe("appointments/appt-1");
    expect(receipt.observed).toEqual({ status: "pending_caregiver_confirmation" });
  });

  it("mismatch: read-back contradicts the handler → completion must NOT be claimed (AE6)", async () => {
    const receipt = await verifyPostcondition(
      "cancel_visit",
      spec(async () => ({ ok: false, observed: { status: "confirmed" } })),
      { id: "appt-1" }, { ok: true },
      { db: {} as never, now },
    );
    expect(receipt.status).toBe("mismatch");
    expect(receipt.safeClaimCode).toBe("not_confirmed");
  });

  it("verifier error fails OPEN to unconfirmed — never blocks, never claims verified", async () => {
    const receipt = await verifyPostcondition(
      "update_care_plan",
      spec(async () => { throw new Error("firestore unavailable +14085550100"); }),
      { id: "appt-1" }, { ok: true },
      { db: {} as never, now },
    );
    expect(receipt.status).toBe("unverifiable");
    expect(receipt.safeClaimCode).toBe("completed_unconfirmed");
    expect(JSON.stringify(receipt)).not.toContain("4085550100");
  });

  it("handler-output receipts (migration state) never claim verified", () => {
    const r = handlerOutputReceipt("legacy_action", "k2", now);
    expect(r.kind).toBe("handler_output");
    expect(r.safeClaimCode).toBe("completed_unconfirmed");
  });
});

describe("decideAutonomy (U5/R27)", () => {
  const base = { reversible: true, explicitPermission: null, evidenceAvailable: true, providerHealthy: true } as const;

  it("reads always auto; critical always confirms — even with standing permission", () => {
    expect(decideAutonomy({ ...base, risk: "read" })).toBe("auto");
    expect(decideAutonomy({ ...base, risk: "critical", explicitPermission: true })).toBe("confirm");
  });

  it("explicit denial can never be overridden by risk math (R27)", () => {
    expect(decideAutonomy({ ...base, risk: "low", explicitPermission: false })).toBe("confirm");
  });

  it("high risk requires explicit permission AND healthy verification", () => {
    expect(decideAutonomy({ ...base, risk: "high" })).toBe("confirm");
    expect(decideAutonomy({ ...base, risk: "high", explicitPermission: true })).toBe("auto");
    expect(decideAutonomy({ ...base, risk: "high", explicitPermission: true, providerHealthy: false })).toBe("confirm");
    expect(decideAutonomy({ ...base, risk: "high", explicitPermission: true, evidenceAvailable: false })).toBe("confirm");
  });

  it("medium: permission or reversibility earns auto only when healthy", () => {
    expect(decideAutonomy({ ...base, risk: "medium" })).toBe("auto"); // reversible
    expect(decideAutonomy({ ...base, risk: "medium", reversible: false })).toBe("confirm");
    expect(decideAutonomy({ ...base, risk: "medium", providerHealthy: false })).toBe("confirm");
  });

  it("low: auto unless degraded AND irreversible", () => {
    expect(decideAutonomy({ ...base, risk: "low" })).toBe("auto");
    expect(decideAutonomy({ ...base, risk: "low", reversible: false, evidenceAvailable: false })).toBe("confirm");
  });
});
