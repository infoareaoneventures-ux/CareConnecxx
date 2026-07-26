import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore mock for the vertical-awareness (R45) write/read tests.
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => {
      const prev = opts?.merge ? { ...(docs.get(path) ?? {}) } : {};
      const next: Record<string, any> = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        next[k] = v && typeof v === "object" && "__inc" in (v as any)
          ? ((prev[k] as number | undefined) ?? 0) + (v as any).__inc
          : v;
      }
      docs.set(path, next);
    },
  });
  const runTransaction = async (fn: any) =>
    fn({ get: (ref: any) => ref.get(), set: (ref: any, d: any, o?: any) => void ref.set(d, o) });
  return { docs, makeDocRef, runTransaction, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => ({ doc: (id: string) => hoisted.makeDocRef(`${p}/${id}`) }),
    runTransaction: hoisted.runTransaction,
  });
  firestore.FieldValue = { increment: (n: number) => ({ __inc: n }) };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

import * as admin from "firebase-admin";
import {
  decayScore,
  reputationBoost,
  reputationFieldNames,
  recordCaregiverOutcome,
  getCaregiverReputationBoost,
  getReputationBoosts,
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

// ── Vertical awareness (childcare plan 2026-07-22-002 U6, R45) ───────────────

describe("per-vertical reputation (U6, R45)", () => {
  const db = admin.firestore() as any;

  beforeEach(() => hoisted.reset());

  it("senior keeps the ORIGINAL unprefixed fields (default vertical — parity)", () => {
    expect(reputationFieldNames("senior")).toEqual({
      score: "score",
      lastOutcomeAt: "lastOutcomeAt",
      hireCount: "hireCount",
      passCount: "passCount",
    });
  });

  it("default (senior) outcome writes are byte-identical to the pre-U6 field shape", async () => {
    await recordCaregiverOutcome(db, "cg-1", "hire", NOW);
    const doc = hoisted.docs.get("caregiver_reputation/cg-1");
    expect(doc).toEqual({ score: 1, lastOutcomeAt: NOW, hireCount: 1, passCount: 0 });
    // No child fields appear on a senior write.
    expect(Object.keys(doc).some((k) => k.startsWith("child"))).toBe(false);
  });

  it("childcare outcomes land in child-prefixed fields and never touch the senior score", async () => {
    await recordCaregiverOutcome(db, "cg-1", "hire", NOW);          // senior
    await recordCaregiverOutcome(db, "cg-1", "pass", NOW, "child"); // childcare
    const doc = hoisted.docs.get("caregiver_reputation/cg-1");
    expect(doc.score).toBe(1);          // senior untouched by the childcare pass
    expect(doc.childScore).toBe(-1);
    expect(doc.childPassCount).toBe(1);
    expect(doc.hireCount).toBe(1);
  });

  it("R45: a senior hire history yields ZERO childcare boost (cross-vertical never qualifies)", async () => {
    for (let i = 0; i < 5; i++) await recordCaregiverOutcome(db, "cg-senior-star", "hire", NOW);
    expect(await getCaregiverReputationBoost(db, "cg-senior-star", NOW)).toBeGreaterThan(0);
    expect(await getCaregiverReputationBoost(db, "cg-senior-star", NOW, "child")).toBe(0);
    const boosts = await getReputationBoosts(db, ["cg-senior-star"], NOW, "child");
    expect(boosts.get("cg-senior-star")).toBe(0);
  });

  it("childcare outcomes never move the senior boost either (isolation both ways)", async () => {
    for (let i = 0; i < 5; i++) await recordCaregiverOutcome(db, "cg-child-star", "hire", NOW, "child");
    expect(await getCaregiverReputationBoost(db, "cg-child-star", NOW)).toBe(0);
    expect(await getCaregiverReputationBoost(db, "cg-child-star", NOW, "child")).toBeGreaterThan(0);
  });
});
