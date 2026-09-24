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
    expect(isConfirmedActionValid(base, "cancel_job_post", "+15550001111", NOW)).toBe(false);
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

  // 2026-09-06 fix: this used to assert `false` — but claimPendingAction
  // (awaiting → executing) ALWAYS runs before approvalHandler dispatches to
  // the MCP gate with _confirmedActionId, so the legitimate confirmed re-run
  // sees "executing" every single time, never "awaiting". Asserting `false`
  // here meant every confirmed high-risk action in the product failed
  // unconditionally (a live test caught this — see pendingActions.ts).
  it("accepts an executing action (claimPendingAction already ran — this is the normal confirmed re-run, not a duplicate)", () => {
    expect(isConfirmedActionValid({ ...base, status: "executing" }, "cancel_appointment", "+15550001111", NOW)).toBe(true);
  });

  it("rejects when no phone is provided", () => {
    expect(isConfirmedActionValid(base, "cancel_appointment", undefined, NOW)).toBe(false);
  });
});
