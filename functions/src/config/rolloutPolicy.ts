// Server-only intelligence rollout control plane (plan 2026-07-18-001 U0,
// KTD22 / R54, Data Changes "evia_rollout_policies").
//
// Every intelligence capability ships behind a per-capability policy document
// `evia_rollout_policies/{capability}` — there is deliberately NO umbrella
// "EVIA_SMARTER" flag. The policy is fail-closed in every direction:
//   - missing, malformed, expired, or unreadable policy  → off
//   - environment can DISABLE (emergency-off, per-capability disable) but can
//     never enable or broaden a cohort beyond what Firestore says
//   - cohort membership is deterministic (seeded hash), so a user never
//     flickers in and out of a capability between turns
//
// Policy document shape (server-written only; rules deny client access):
//   mode:          "off" | "shadow" | "canary" | "partial" | "full"
//   cohortPercent: number 0-100 (used by canary/partial)
//   cohortSeed:    string  (rotate to reshuffle cohorts deliberately)
//   policyVersion: number
//   expiresAt:     ISO string — REQUIRED for canary/partial; a policy left
//                  running past its window fails closed rather than lingering
//   updatedAt:     ISO string
//
// Reads are cached per instance for ROLLOUT_CACHE_TTL_MS, which is therefore
// the rollback propagation bound for already-warm instances; the environment
// emergency-off is read on every call and propagates immediately.

import * as admin from "firebase-admin";
import { createHash } from "crypto";

export type RolloutMode = "off" | "shadow" | "canary" | "partial" | "full";

export const ROLLOUT_COLLECTION = "evia_rollout_policies";

// Rollback SLA bound: a policy flipped to off in Firestore is honored by every
// warm instance within this TTL; cold instances see it immediately.
export const ROLLOUT_CACHE_TTL_MS = 60_000;

// Global kill switch. Environment-level so it works even when Firestore reads
// are themselves the problem. It can only turn capabilities OFF.
export const EMERGENCY_OFF_ENV = "EVIA_INTELLIGENCE_EMERGENCY_OFF";
// Comma-separated per-capability disable list — same direction: off only.
export const CAPABILITY_DISABLE_ENV = "EVIA_INTELLIGENCE_DISABLE";

export interface RolloutPolicyDoc {
  mode?: unknown;
  cohortPercent?: unknown;
  cohortSeed?: unknown;
  policyVersion?: unknown;
  expiresAt?: unknown;
}

export interface RolloutDecision {
  capability: string;
  /** Consequential behavior may run for this subject. */
  enabled: boolean;
  /** Log-only shadow work may run (never user-visible). */
  shadow: boolean;
  mode: RolloutMode;
  policyVersion: number | null;
  reason:
    | "emergency_off"
    | "env_disabled"
    | "policy"
    | "not_in_cohort"
    | "no_subject_key"
    | "expired"
    | "missing"
    | "malformed"
    | "read_error";
}

const OFF: Omit<RolloutDecision, "capability" | "reason"> = {
  enabled: false,
  shadow: false,
  mode: "off",
  policyVersion: null,
};

function isTruthyFlag(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

export function emergencyOffActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[EMERGENCY_OFF_ENV]);
}

function envDisabled(capability: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[CAPABILITY_DISABLE_ENV] ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(capability);
}

// Deterministic bucket 0-9999. Same capability+seed+subject always lands in
// the same bucket; rotating the seed reshuffles deliberately.
export function cohortBucket(capability: string, seed: string, subjectKey: string): number {
  const digest = createHash("sha256").update(`${capability}|${seed}|${subjectKey}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

interface CacheEntry {
  fetchedAt: number;
  doc: RolloutPolicyDoc | null; // null = document missing
  readError: boolean;
}

const cache = new Map<string, CacheEntry>();

export function invalidateRolloutCache(capability?: string): void {
  if (capability) cache.delete(capability);
  else cache.clear();
}

/** Test seam — also usable by admin tooling after a policy write. */
export const __clearRolloutCacheForTests = (): void => invalidateRolloutCache();

async function readPolicy(capability: string, now: number): Promise<CacheEntry> {
  const cached = cache.get(capability);
  if (cached && now - cached.fetchedAt < ROLLOUT_CACHE_TTL_MS) return cached;

  let entry: CacheEntry;
  try {
    const snap = await admin.firestore().collection(ROLLOUT_COLLECTION).doc(capability).get();
    entry = { fetchedAt: now, doc: snap.exists ? (snap.data() as RolloutPolicyDoc) : null, readError: false };
  } catch (err) {
    console.warn("rolloutPolicy read failed — failing closed", capability, err instanceof Error ? err.message : err);
    entry = { fetchedAt: now, doc: null, readError: true };
  }
  cache.set(capability, entry);
  return entry;
}

const VALID_MODES: ReadonlySet<string> = new Set(["off", "shadow", "canary", "partial", "full"]);

export async function getRolloutDecision(
  capability: string,
  subjectKey?: string,
  opts?: { now?: Date; env?: NodeJS.ProcessEnv },
): Promise<RolloutDecision> {
  const env = opts?.env ?? process.env;
  const now = (opts?.now ?? new Date()).getTime();

  // Environment checks run on EVERY call — never cached, so a kill switch
  // propagates immediately regardless of cache state.
  if (emergencyOffActive(env)) return { capability, ...OFF, reason: "emergency_off" };
  if (envDisabled(capability, env)) return { capability, ...OFF, reason: "env_disabled" };

  const entry = await readPolicy(capability, now);
  if (entry.readError) return { capability, ...OFF, reason: "read_error" };
  if (!entry.doc) return { capability, ...OFF, reason: "missing" };

  const doc = entry.doc;
  const mode = typeof doc.mode === "string" && VALID_MODES.has(doc.mode) ? (doc.mode as RolloutMode) : null;
  if (!mode) return { capability, ...OFF, reason: "malformed" };

  const policyVersion = typeof doc.policyVersion === "number" ? doc.policyVersion : null;

  // Expiry is fail-closed. canary/partial REQUIRE an expiry so a forgotten
  // experiment cannot run indefinitely; expired anything is off.
  const expiresAtMs = typeof doc.expiresAt === "string" ? Date.parse(doc.expiresAt) : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    return { capability, ...OFF, mode: "off", policyVersion, reason: "expired" };
  }
  if ((mode === "canary" || mode === "partial") && !Number.isFinite(expiresAtMs)) {
    return { capability, ...OFF, policyVersion, reason: "malformed" };
  }

  if (mode === "off") return { capability, ...OFF, mode, policyVersion, reason: "policy" };
  if (mode === "shadow") {
    return { capability, enabled: false, shadow: true, mode, policyVersion, reason: "policy" };
  }
  if (mode === "full") {
    return { capability, enabled: true, shadow: false, mode, policyVersion, reason: "policy" };
  }

  // canary / partial — deterministic cohort; no subject key means no cohort
  // membership can be proven, which fails closed.
  const pct = typeof doc.cohortPercent === "number" && doc.cohortPercent >= 0 && doc.cohortPercent <= 100
    ? doc.cohortPercent
    : null;
  const seed = typeof doc.cohortSeed === "string" && doc.cohortSeed ? doc.cohortSeed : null;
  if (pct === null || seed === null) return { capability, ...OFF, policyVersion, reason: "malformed" };
  if (!subjectKey) return { capability, ...OFF, mode, policyVersion, reason: "no_subject_key" };

  const inCohort = cohortBucket(capability, seed, subjectKey) < pct * 100;
  return inCohort
    ? { capability, enabled: true, shadow: false, mode, policyVersion, reason: "policy" }
    : { capability, enabled: false, shadow: false, mode, policyVersion, reason: "not_in_cohort" };
}
