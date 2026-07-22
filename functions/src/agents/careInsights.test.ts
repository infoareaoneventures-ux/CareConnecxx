import { describe, expect, it } from "vitest";

import { deriveCareInsights, concerningInsights } from "./careInsights";

const now = new Date("2026-07-22T18:00:00Z");
const entry = (daysAgo: number, wellness: Record<string, unknown>) => ({
  timestamp: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  wellness,
});

describe("deriveCareInsights (U7/R34/AE11)", () => {
  it("a single bad day is not a pattern (AE11)", () => {
    const insights = deriveCareInsights([
      entry(1, { tookMeds: false }),
      entry(2, { tookMeds: true }),
      entry(3, { tookMeds: true }),
    ], { now });
    const meds = insights.find((i) => i.field === "tookMeds")!;
    expect(meds.kind).toBe("stable");
  });

  it("three explicit negative days form a concern with source links (AE11/R34)", () => {
    const insights = deriveCareInsights([
      entry(1, { ateWell: false }),
      entry(2, { ateWell: false }),
      entry(3, { ateWell: false }),
      entry(4, { ateWell: true }),
    ], { now });
    const appetite = insights.find((i) => i.field === "ateWell")!;
    expect(appetite.kind).toBe("concern");
    expect(appetite.negativeDays).toBe(3);
    expect(appetite.negativeSources).toHaveLength(3);
    expect(appetite.statement).toContain("recorded low on 3");
    expect(appetite.statement).toContain("4 days had recorded observations");
  });

  it("missing fields never form or strengthen a pattern (R2)", () => {
    // Two explicit negatives + five entries omitting the field entirely.
    const insights = deriveCareInsights([
      entry(1, { tookMeds: false }),
      entry(2, { tookMeds: false }),
      ...Array.from({ length: 5 }, (_, i) => entry(i + 3, { mood: "ok" })),
    ], { now });
    const meds = insights.find((i) => i.field === "tookMeds")!;
    expect(meds.kind).toBe("insufficient"); // only 2 known days < minKnownDays
    expect(meds.statement).toBe("");
  });

  it("multiple negatives on the SAME day count once (distinct days, not entries)", () => {
    const sameDay = entry(1, { wasActive: false });
    const insights = deriveCareInsights([
      sameDay, { ...sameDay }, { ...sameDay },
      entry(2, { wasActive: true }),
      entry(3, { wasActive: true }),
    ], { now });
    const activity = insights.find((i) => i.field === "wasActive")!;
    expect(activity.negativeDays).toBe(1);
    expect(activity.kind).toBe("stable");
  });

  it("entries outside the window are excluded", () => {
    const insights = deriveCareInsights([
      entry(10, { ateWell: false }),
      entry(11, { ateWell: false }),
      entry(12, { ateWell: false }),
      entry(1, { ateWell: true }),
      entry(2, { ateWell: true }),
      entry(3, { ateWell: true }),
    ], { now, windowDays: 7 });
    const appetite = insights.find((i) => i.field === "ateWell")!;
    expect(appetite.kind).toBe("stable");
    expect(appetite.negativeDays).toBe(0);
  });

  it("concerningInsights returns only concern-grade patterns", () => {
    const insights = deriveCareInsights([
      entry(1, { tookMeds: false, ateWell: true }),
      entry(2, { tookMeds: false, ateWell: true }),
      entry(3, { tookMeds: false, ateWell: true }),
    ], { now });
    const concerns = concerningInsights(insights);
    expect(concerns).toHaveLength(1);
    expect(concerns[0].field).toBe("tookMeds");
  });
});
