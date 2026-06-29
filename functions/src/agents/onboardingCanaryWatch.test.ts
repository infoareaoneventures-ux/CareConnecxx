import { describe, it, expect } from "vitest";
import {
  summarizeOnboardingCanary,
  formatCanaryReport,
  ONBOARDING_LATENCY_CEILING_MS,
  type CanaryRecord,
} from "./onboardingCanaryWatch";

function rec(over: Partial<CanaryRecord> = {}): CanaryRecord {
  return { flowClass: "onboarding", durationMs: 1500, ...over };
}

describe("summarizeOnboardingCanary", () => {
  it("ignores non-onboarding rows", () => {
    const s = summarizeOnboardingCanary([
      rec(),
      { flowClass: "booking", durationMs: 9000, onboardingReGreet: true },
      { flowClass: null, durationMs: 9000 },
    ]);
    expect(s.turns).toBe(1);
    expect(s.reGreetCount).toBe(0);
    expect(s.maxLatencyMs).toBe(1500);
  });

  it("flags a clean batch as healthy", () => {
    const s = summarizeOnboardingCanary([
      rec({ durationMs: 1200, phone: "+1a" }),
      rec({ durationMs: 1800, phone: "+1b" }),
      rec({ durationMs: 2200, phone: "+1a" }),
    ]);
    expect(s.turns).toBe(3);
    expect(s.uniquePhones).toBe(2);
    expect(s.reGreetCount).toBe(0);
    expect(s.withinLatencyCeiling).toBe(true);
    expect(s.healthy).toBe(true);
  });

  it("is NOT healthy when a re-greet is present", () => {
    const s = summarizeOnboardingCanary([rec(), rec({ onboardingReGreet: true })]);
    expect(s.reGreetCount).toBe(1);
    expect(s.reGreetRate).toBeCloseTo(0.5);
    expect(s.healthy).toBe(false);
  });

  it("is NOT healthy when P95 latency exceeds the ceiling", () => {
    // 18 fast + 2 very slow (n=20 → P95 index 18) → P95 lands on a slow sample.
    const records = [
      ...Array.from({ length: 18 }, () => rec({ durationMs: 1000 })),
      rec({ durationMs: 9000 }),
      rec({ durationMs: 9000 }),
    ];
    const s = summarizeOnboardingCanary(records);
    expect(s.p95LatencyMs).toBeGreaterThan(ONBOARDING_LATENCY_CEILING_MS);
    expect(s.withinLatencyCeiling).toBe(false);
    expect(s.healthy).toBe(false);
  });

  it("counts tool-error / exhausted / errored turns and blocks health on hard ones", () => {
    const s = summarizeOnboardingCanary([
      rec({ toolErrors: 2 }),
      rec({ exhausted: true }),
      rec({ errored: true }),
    ]);
    expect(s.toolErrorTurns).toBe(1);
    expect(s.exhaustedTurns).toBe(1);
    expect(s.erroredTurns).toBe(1);
    expect(s.healthy).toBe(false);
  });

  it("empty window is not healthy (nothing to confirm)", () => {
    const s = summarizeOnboardingCanary([]);
    expect(s.turns).toBe(0);
    expect(s.healthy).toBe(false);
    expect(formatCanaryReport(s, "last 24h")).toContain("no onboarding turns");
  });

  it("formats a healthy report with an OK summary line", () => {
    const s = summarizeOnboardingCanary([rec(), rec({ durationMs: 2000 })]);
    const report = formatCanaryReport(s, "last 6h");
    expect(report).toContain("canary watch (last 6h)");
    expect(report).toContain("✅ healthy");
  });
});
