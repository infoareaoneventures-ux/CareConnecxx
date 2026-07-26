import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));

import { isConfirmedActionValid, type PendingAction } from "./pendingActions";

const NOW = 1_000_000_000_000;
const base: PendingAction = {
  id: "a1",
  phone: "+15550001111",
  toolName: "cancel_appointment",
  toolInput: {},
  preview: "Cancel appt",
  proposedAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  status: "awaiting",
};

describe("isConfirmedActionValid", () => {
  it("accepts a matching, awaiting, unexpired action (the legit re-run)", () => {
    expect(isConfirmedActionValid(base, "cancel_appointment", "+15550001111", NOW)).toBe(true);
  });

  it("rejects a missing action (forged id)", () => {
    expect(isConfirmedActionValid(null, "cancel_appointment", "+15550001111", NOW)).toBe(false);
  });

  it("rejects a phone mismatch", () => {
    expect(isConfirmedActionValid(base, "cancel_appointment", "+15559999999", NOW)).toBe(false);
  });

  it("rejects a tool-name mismatch", () => {
    expect(isConfirmedActionValid(base, "remove_family_member", "+15550001111", NOW)).toBe(false);
  });

  it("rejects an expired action", () => {
    const expired = { ...base, expiresAt: new Date(NOW - 1).toISOString() };
    expect(isConfirmedActionValid(expired, "cancel_appointment", "+15550001111", NOW)).toBe(false);
  });

  it("rejects an already-resolved action", () => {
    for (const status of ["rejected", "expired", "executed", "failed"] as const) {
      expect(isConfirmedActionValid({ ...base, status }, "cancel_appointment", "+15550001111", NOW)).toBe(false);
    }
  });

  it("accepts an approved action (user approval awaiting execution)", () => {
    expect(isConfirmedActionValid({ ...base, status: "approved" }, "cancel_appointment", "+15550001111", NOW)).toBe(true);
  });

  it("rejects a legacy executing action without an immutable operation binding", () => {
    expect(isConfirmedActionValid({ ...base, status: "executing" }, "cancel_appointment", "+15550001111", NOW)).toBe(false);
  });

  it("accepts the claimed executing action only with the exact operation identity", () => {
    const executing: PendingAction = {
      ...base,
      userId: "user-1",
      status: "executing",
      careVertical: "child",
      toolInput: {
        bookingId: "booking-1",
        careVertical: "child",
        _sourceTurnKey: "turn-1",
      },
      operation: {
        schema: "pending-operation-v1",
        operationId: "op_child_1",
        principalId: "user-1",
        careVertical: "child",
        objectType: "childcare_booking",
        objectId: "booking-1",
        actionName: "cancel_appointment",
        actionSchemaVersion: 1,
        sourceTurnKey: "turn-1",
        expiresAt: base.expiresAt,
      },
    };
    expect(isConfirmedActionValid(
      executing,
      "cancel_appointment",
      "+15550001111",
      NOW,
      {
        bookingId: "booking-1",
        careVertical: "child",
        _sourceTurnKey: "turn-1",
        userId: "user-1",
      },
      "op_child_1",
    )).toBe(true);
    expect(isConfirmedActionValid(
      executing,
      "cancel_appointment",
      "+15550001111",
      NOW,
      {
        bookingId: "booking-1",
        careVertical: "child",
        _sourceTurnKey: "turn-1",
        userId: "user-1",
      },
      "op_wrong",
    )).toBe(false);
    expect(isConfirmedActionValid(
      executing,
      "cancel_appointment",
      "+15550001111",
      NOW,
      {
        bookingId: "booking-2",
        careVertical: "child",
        _sourceTurnKey: "turn-1",
        userId: "user-1",
      },
      "op_child_1",
    )).toBe(false);
    expect(isConfirmedActionValid(
      executing,
      "cancel_appointment",
      "+15550001111",
      NOW,
      {
        bookingId: "booking-1",
        careVertical: "senior",
        _sourceTurnKey: "turn-1",
        userId: "user-1",
      },
      "op_child_1",
    )).toBe(false);
  });

  it("rejects when no phone is provided", () => {
    expect(isConfirmedActionValid(base, "cancel_appointment", undefined, NOW)).toBe(false);
  });
});
