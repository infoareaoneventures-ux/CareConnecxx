import { describe, expect, it, vi } from "vitest";

// healthTrends touches admin.firestore() and transport clients at module load.
vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../linq/client", () => ({ sendMessage: async () => ({}), sendToPhone: async () => ({}) }));
vi.mock("../config/appUrl", () => ({ getAppUrl: () => "https://example.test" }));

import { buildWellnessStatLines } from "./healthTrends";

const entry = (wellness: Record<string, unknown> | undefined) => ({ wellness });

describe("buildWellnessStatLines (U1/R2/AE1 — known denominators only)", () => {
  it("computes rates over recorded observations, not all journal rows", () => {
    // 20 entries: meds recorded on 10 (9 true, 1 false), omitted on 10.
    const journal = [
      ...Array.from({ length: 9 }, () => entry({ tookMeds: true })),
      entry({ tookMeds: false }),
      ...Array.from({ length: 10 }, () => entry({})),
    ];
    const meds = buildWellnessStatLines(journal).find(l => l.startsWith("- Medications taken"));
    // Old bug: 9/20 = 45% "of visits". Correct: 9/10 known = 90%.
    expect(meds).toContain("90% of the 10 visits where it was recorded");
    expect(meds).toContain("10 of 20 entries did not record this");
    expect(meds).not.toContain("45%");
  });

  it("reports insufficient data instead of a rate when almost nothing was recorded", () => {
    const journal = [entry({ tookMeds: true }), entry({}), entry({}), entry(undefined)];
    const meds = buildWellnessStatLines(journal).find(l => l.startsWith("- Medications taken"));
    expect(meds).toContain("not recorded often enough");
    expect(meds).toContain("do not treat this as a concern");
    expect(meds).not.toMatch(/\d+%/);
  });

  it("never lets fully-omitted fields produce a 0% negative rate", () => {
    const journal = Array.from({ length: 15 }, () => entry({ mood: "good" }));
    for (const line of buildWellnessStatLines(journal)) {
      expect(line).toContain("not recorded often enough");
      expect(line).not.toMatch(/0%/);
    }
  });

  it("covers all three tri-state fields", () => {
    const lines = buildWellnessStatLines([]);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toMatch(/Ate well/);
    expect(lines.join("\n")).toMatch(/Medications taken/);
    expect(lines.join("\n")).toMatch(/Physically active/);
  });
});
