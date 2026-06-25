import { describe, it, expect } from "vitest";
import { CARA_CAPABILITIES as FRONTEND } from "./caraCapabilities";
import { CARA_CAPABILITIES as BACKEND } from "../functions/src/agents/caraCapabilities";

// Guards against drift between the frontend mirror and the canonical backend
// list. If one adds/removes/reorders an entry or edits a label/example without
// the other, this fails in CI. (Per the plan's Open Decision: the guard checks
// label/example/featured, not just id sets — copy is the field that drifts.)

const ROLES = ["client", "caregiver"] as const;

describe("caraCapabilities backend/frontend alignment", () => {
  it("exposes the same role keys", () => {
    expect(Object.keys(FRONTEND).sort()).toEqual(Object.keys(BACKEND).sort());
  });

  for (const role of ROLES) {
    it(`has identical id/label/example/featured + Spanish labelEs/exampleEs for role "${role}"`, () => {
      const fe = FRONTEND[role];
      const be = BACKEND[role];
      expect(fe.map((e) => e.id)).toEqual(be.map((e) => e.id));
      // entry-for-entry, in order — includes the Spanish fields so the bilingual
      // frontend hints can't silently drift from the backend (U5).
      fe.forEach((f, i) => {
        const b = be[i];
        expect({ id: f.id, label: f.label, example: f.example, labelEs: f.labelEs, exampleEs: f.exampleEs, featured: f.featured }).toEqual({
          id: b.id,
          label: b.label,
          example: b.example,
          labelEs: b.labelEs,
          exampleEs: b.exampleEs,
          featured: b.featured,
        });
      });
    });

    it(`has non-empty Spanish strings for every entry in role "${role}"`, () => {
      for (const e of FRONTEND[role]) {
        expect(e.labelEs.trim().length).toBeGreaterThan(0);
        expect(e.exampleEs.trim().length).toBeGreaterThan(0);
      }
    });
  }
});
