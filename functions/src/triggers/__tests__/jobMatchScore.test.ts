import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// scoring function — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { computeSimpleMatchScore, INVITE_MATCH_THRESHOLD } from "../jobNotifications";

// U11 — the "a job opened near you, interested?" invite is gated on profile
// fit, not distance alone. These cover the score that drives the gate.

const invited = (cgSkills: string[], careTypes: string[]) =>
  computeSimpleMatchScore(cgSkills, careTypes) >= INVITE_MATCH_THRESHOLD;

describe("computeSimpleMatchScore + invite gate (U11)", () => {
  it("scores full coverage at 100 and invites", () => {
    expect(computeSimpleMatchScore(["dementia care", "mobility"], ["dementia", "mobility"])).toBe(100);
    expect(invited(["dementia care", "mobility"], ["dementia", "mobility"])).toBe(true);
  });

  it("scores zero overlap at 0 and does NOT invite", () => {
    expect(computeSimpleMatchScore(["housekeeping"], ["dementia", "hospice"])).toBe(0);
    expect(invited(["housekeeping"], ["dementia", "hospice"])).toBe(false);
  });

  it("invites a partial-but-meaningful match", () => {
    // covers 1 of 2 needs → 50% ≥ threshold
    expect(invited(["dementia care"], ["dementia", "mobility"])).toBe(true);
  });

  it("invites nearby caregivers when the job lists no care types (score 50)", () => {
    expect(computeSimpleMatchScore(["anything"], [])).toBe(50);
    expect(invited([], [])).toBe(true);
  });

  it("matches on substring either direction (skill⊇need or need⊇skill)", () => {
    expect(computeSimpleMatchScore(["memory care specialist"], ["memory care"])).toBe(100);
    expect(computeSimpleMatchScore(["cpr"], ["cpr certified"])).toBe(100);
  });
});
