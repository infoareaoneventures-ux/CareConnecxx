import { describe, it, expect } from "vitest";
import {
  decayScore,
  reputationBoost,
  REPUTATION_HALF_LIFE_MS,
  MAX_REPUTATION_BOOST,
} from "../caregiverReputation";

// U5/U6 — platform reputation feeds matching as a bounded, recency-decayed
// tie-breaker. These cover the decay math and the score→boost mapping that the
// ranking relies on (the Firestore write is exercised by integration in CI).

const NOW = Date.parse("2026-06-22T00:00:00.000Z");
const daysAgo = (n: number) => NOW - n * 24 * 60 * 60 * 1000;

describe("decayScore (U6)", () => {
  it("returns 0 for empty/missing input (cold start)", () => {
    expect(decayScore(0, 0, NOW)).toBe(0);
    expect(decayScore(5, 0, NOW)).toBe(0);
  });

  it("does not decay a score recorded just now", () => {
    expect(decayScore(4, NOW, NOW)).toBeCloseTo(4, 6);
  });

  it("halves the score after one half-life", () => {
    expect(decayScore(4, NOW - REPUTATION_HALF_LIFE_MS, NOW)).toBeCloseTo(2, 6);
  });

  it("decays a one-year-old outcome more than a recent one", () => {
    const recent = decayScore(3, daysAgo(7), NOW);
    const old    = decayScore(3, daysAgo(330), NOW);
    expect(recent).toBeGreaterThan(old);
  });
});

describe("reputationBoost (U6)", () => {
  it("is neutral (0) for a caregiver with no reputation", () => {
    expect(reputationBoost(null, NOW)).toBe(0);
    expect(reputationBoost(undefined, NOW)).toBe(0);
    expect(reputationBoost({ score: 0, lastOutcomeAt: 0 }, NOW)).toBe(0);
  });

  it("gives a positive boost for net hires and negative for net passes", () => {
    expect(reputationBoost({ score: 4, lastOutcomeAt: NOW }, NOW)).toBeGreaterThan(0);
    expect(reputationBoost({ score: -4, lastOutcomeAt: NOW }, NOW)).toBeLessThan(0);
  });

  it("never exceeds the cap, even for a huge score", () => {
    const big = reputationBoost({ score: 1000, lastOutcomeAt: NOW }, NOW);
    expect(big).toBeLessThanOrEqual(MAX_REPUTATION_BOOST);
    expect(big).toBeGreaterThan(MAX_REPUTATION_BOOST - 0.01); // asymptotes to the cap
    const small = reputationBoost({ score: -1000, lastOutcomeAt: NOW }, NOW);
    expect(small).toBeGreaterThanOrEqual(-MAX_REPUTATION_BOOST);
  });

  it("ranks a recently-hired caregiver above an equally-scored but stale one", () => {
    const fresh = reputationBoost({ score: 3, lastOutcomeAt: daysAgo(5) }, NOW);
    const stale = reputationBoost({ score: 3, lastOutcomeAt: daysAgo(700) }, NOW);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("a single outcome barely moves the score (tie-breaker, not a driver)", () => {
    // One hire (score +1) should produce a small fraction of the cap.
    const oneHire = reputationBoost({ score: 1, lastOutcomeAt: NOW }, NOW);
    expect(oneHire).toBeGreaterThan(0);
    expect(oneHire).toBeLessThan(MAX_REPUTATION_BOOST / 2);
  });
});
