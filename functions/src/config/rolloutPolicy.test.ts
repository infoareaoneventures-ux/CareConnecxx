import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const policies = new Map<string, Record<string, unknown>>();
  let failReads = false;
  return {
    policies,
    setFailReads: (v: boolean) => { failReads = v; },
    firestore: () => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            if (failReads) throw new Error("firestore unavailable");
            const doc = name === "evia_rollout_policies" ? policies.get(id) : undefined;
            return { exists: !!doc, data: () => doc };
          },
        }),
      }),
    }),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

import {
  getRolloutDecision,
  cohortBucket,
  emergencyOffActive,
  invalidateRolloutCache,
  ROLLOUT_CACHE_TTL_MS,
  EMERGENCY_OFF_ENV,
  CAPABILITY_DISABLE_ENV,
} from "./rolloutPolicy";

const CAP = "care_situation";
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

beforeEach(() => {
  hoisted.policies.clear();
  hoisted.setFailReads(false);
  invalidateRolloutCache();
});

describe("fail-closed defaults (U0/KTD22)", () => {
  it("missing policy document → off", async () => {
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, shadow: false, mode: "off", reason: "missing" });
  });

  it("malformed mode → off", async () => {
    hoisted.policies.set(CAP, { mode: "yolo", policyVersion: 3 });
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, reason: "malformed" });
  });

  it("expired policy → off even when mode is full", async () => {
    hoisted.policies.set(CAP, { mode: "full", policyVersion: 2, expiresAt: "2026-01-01T00:00:00Z" });
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, reason: "expired", policyVersion: 2 });
  });

  it("canary without an expiry is malformed — experiments cannot run indefinitely", async () => {
    hoisted.policies.set(CAP, { mode: "canary", cohortPercent: 100, cohortSeed: "s1", policyVersion: 1 });
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, reason: "malformed" });
  });

  it("Firestore read error → off, not throw", async () => {
    hoisted.setFailReads(true);
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, reason: "read_error" });
  });
});

describe("emergency-off and env disable (can only turn OFF)", () => {
  it("emergency-off beats a full policy and is not cached", async () => {
    hoisted.policies.set(CAP, { mode: "full", policyVersion: 1 });
    const on = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(on.enabled).toBe(true);
    // Same warm cache, kill switch flipped: takes effect immediately.
    const off = await getRolloutDecision(CAP, "user1", { env: { [EMERGENCY_OFF_ENV]: "true" } });
    expect(off).toMatchObject({ enabled: false, shadow: false, reason: "emergency_off" });
  });

  it("per-capability env disable turns one capability off", async () => {
    hoisted.policies.set(CAP, { mode: "full", policyVersion: 1 });
    hoisted.policies.set("other_cap", { mode: "full", policyVersion: 1 });
    const env = { [CAPABILITY_DISABLE_ENV]: ` ${CAP} , something_else` };
    expect((await getRolloutDecision(CAP, "u", { env })).reason).toBe("env_disabled");
    expect((await getRolloutDecision("other_cap", "u", { env })).enabled).toBe(true);
  });

  it("environment flags can never ENABLE a capability firestore says is off", async () => {
    hoisted.policies.set(CAP, { mode: "off", policyVersion: 1 });
    const d = await getRolloutDecision(CAP, "user1", {
      env: { EVIA_INTELLIGENCE_ENABLE: "true", [CAPABILITY_DISABLE_ENV]: "" },
    });
    expect(d.enabled).toBe(false);
  });

  it("emergencyOffActive accepts 1 and true only", () => {
    expect(emergencyOffActive({ [EMERGENCY_OFF_ENV]: "true" })).toBe(true);
    expect(emergencyOffActive({ [EMERGENCY_OFF_ENV]: "1" })).toBe(true);
    expect(emergencyOffActive({ [EMERGENCY_OFF_ENV]: "false" })).toBe(false);
    expect(emergencyOffActive({})).toBe(false);
  });
});

describe("modes and deterministic cohorts", () => {
  it("shadow mode enables shadow work only", async () => {
    hoisted.policies.set(CAP, { mode: "shadow", policyVersion: 4 });
    const d = await getRolloutDecision(CAP, "user1", { env: {} });
    expect(d).toMatchObject({ enabled: false, shadow: true, mode: "shadow", policyVersion: 4 });
  });

  it("cohortBucket is deterministic and spread across the range", () => {
    const a = cohortBucket(CAP, "seed1", "subject-a");
    expect(cohortBucket(CAP, "seed1", "subject-a")).toBe(a);
    expect(cohortBucket(CAP, "seed2", "subject-a")).not.toBe(a);
    const buckets = Array.from({ length: 200 }, (_, i) => cohortBucket(CAP, "seed1", `s${i}`));
    expect(Math.min(...buckets)).toBeLessThan(2_000);
    expect(Math.max(...buckets)).toBeGreaterThan(8_000);
    for (const b of buckets) { expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(10_000); }
  });

  it("canary 0% admits nobody; 100% admits everybody; membership is stable", async () => {
    hoisted.policies.set(CAP, { mode: "canary", cohortPercent: 0, cohortSeed: "s", policyVersion: 1, expiresAt: future });
    expect((await getRolloutDecision(CAP, "u1", { env: {} })).enabled).toBe(false);
    invalidateRolloutCache();
    hoisted.policies.set(CAP, { mode: "canary", cohortPercent: 100, cohortSeed: "s", policyVersion: 2, expiresAt: future });
    expect((await getRolloutDecision(CAP, "u1", { env: {} })).enabled).toBe(true);
    invalidateRolloutCache();
    hoisted.policies.set(CAP, { mode: "partial", cohortPercent: 50, cohortSeed: "s", policyVersion: 3, expiresAt: future });
    const first = (await getRolloutDecision(CAP, "stable-user", { env: {} })).enabled;
    for (let i = 0; i < 5; i++) {
      expect((await getRolloutDecision(CAP, "stable-user", { env: {} })).enabled).toBe(first);
    }
  });

  it("canary/partial without a subject key fails closed", async () => {
    hoisted.policies.set(CAP, { mode: "partial", cohortPercent: 100, cohortSeed: "s", policyVersion: 1, expiresAt: future });
    const d = await getRolloutDecision(CAP, undefined, { env: {} });
    expect(d).toMatchObject({ enabled: false, reason: "no_subject_key" });
  });
});

describe("cache and rollback propagation", () => {
  it("serves from cache within the TTL and honors invalidation immediately", async () => {
    hoisted.policies.set(CAP, { mode: "full", policyVersion: 1 });
    expect((await getRolloutDecision(CAP, "u", { env: {} })).enabled).toBe(true);

    // Policy flipped off in Firestore: warm cache may still say on…
    hoisted.policies.set(CAP, { mode: "off", policyVersion: 2 });
    expect((await getRolloutDecision(CAP, "u", { env: {} })).enabled).toBe(true);
    // …but explicit invalidation (what admin tooling calls) propagates now.
    invalidateRolloutCache(CAP);
    expect((await getRolloutDecision(CAP, "u", { env: {} })).enabled).toBe(false);
  });

  it("stale cache entries refetch after the TTL (rollback SLA bound)", async () => {
    hoisted.policies.set(CAP, { mode: "full", policyVersion: 1 });
    const t0 = new Date("2026-07-21T10:00:00Z");
    expect((await getRolloutDecision(CAP, "u", { env: {}, now: t0 })).enabled).toBe(true);

    hoisted.policies.set(CAP, { mode: "off", policyVersion: 2 });
    const withinTtl = new Date(t0.getTime() + ROLLOUT_CACHE_TTL_MS - 1);
    expect((await getRolloutDecision(CAP, "u", { env: {}, now: withinTtl })).enabled).toBe(true);

    const pastTtl = new Date(t0.getTime() + ROLLOUT_CACHE_TTL_MS + 1);
    expect((await getRolloutDecision(CAP, "u", { env: {}, now: pastTtl })).enabled).toBe(false);
  });
});
