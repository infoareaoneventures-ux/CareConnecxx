import { describe, it, expect, vi } from "vitest";

// supervisor.ts opens Firestore at import time — stub it.
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ add: async () => ({}) }) }), { FieldValue: {} });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import { supervisorRoleNote } from "../supervisor";

// Live 2026-10-07: the safety reviewer rewrote a caregiver's own rate confirmation into family wording.
describe("supervisorRoleNote", () => {
  it("tells the reviewer a caregiver's own rates are not an unconfirmed price", () => {
    const n = supervisorRoleNote("caregiver");
    expect(n).toContain("CARE PROVIDER");
    expect(n).toContain("THEIR OWN rates");
    expect(n).toContain("confirmed with your care providers");
  });
  it("defaults to the family side", () => {
    expect(supervisorRoleNote(undefined)).toContain("FAMILY");
    expect(supervisorRoleNote("client")).toContain("FAMILY");
  });
});
