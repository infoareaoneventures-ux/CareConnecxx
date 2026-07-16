// Live market rate range — replaces the hand-written "$18-28/hr" hint that was
// hardcoded in four message sites. Computed from real caregiver hourly rates in
// Firestore (caregivers visible to families: onboardingStatus profile_complete).
// The platform serves Santa Clara County ONLY (config/serviceArea.ts gates both
// signups), so every caregiver doc IS an SCC rate — no geo filter needed here.
// Widening the service area later would call for a per-area split; today it
// would only dilute a single-county dataset.
//
// Fail-soft by design: too few real rates, a Firestore error, junk values —
// all fall back to the original static $18–28 so a hint is never blank.

import * as admin from "firebase-admin";

/** The original hand-picked range — used until live data is trustworthy. */
export const FALLBACK_RANGE = { min: 18, max: 28 } as const;

// Below this many real rates the percentiles are noise — use the fallback.
const MIN_SAMPLE = 5;
// Sanity band for stored rates; update_caregiver_profile validates 15–150,
// but legacy/backfilled docs may hold junk — discard rather than skew.
const RATE_SANE_MIN = 10;
const RATE_SANE_MAX = 150;
// One Firestore scan per warm function instance per 6h — rates move slowly.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Pure: 25th–75th percentile of the given rates, rounded outward to whole
 * dollars. Returns null when there aren't enough sane values to be meaningful.
 */
export function computeRateRange(rates: number[]): { min: number; max: number } | null {
  const clean = rates
    .filter((r) => Number.isFinite(r) && r >= RATE_SANE_MIN && r <= RATE_SANE_MAX)
    .sort((a, b) => a - b);
  if (clean.length < MIN_SAMPLE) return null;
  const pct = (p: number) => clean[Math.min(clean.length - 1, Math.floor(p * clean.length))];
  const min = Math.floor(pct(0.25));
  let max = Math.ceil(pct(0.75));
  // A degenerate spread ("$25–25/hr") reads like a typo — give it a real width.
  if (max <= min) max = min + 2;
  return { min, max };
}

let cache: { range: { min: number; max: number }; at: number } | null = null;

/** For tests only — clears the module-level cache. */
export function __resetMarketRateCache(): void {
  cache = null;
}

/**
 * The live SCC market range, cached per instance. Never throws — falls back
 * to FALLBACK_RANGE on any error or thin data (errors are not cached, so the
 * next call retries).
 */
export async function getMarketRateRange(): Promise<{ min: number; max: number }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.range;
  try {
    const snap = await admin.firestore()
      .collection("caregivers")
      .where("onboardingStatus", "==", "profile_complete")
      .select("hourlyRate")
      .get();
    const rates = snap.docs
      .map((d) => Number((d.data() as Record<string, unknown>)?.hourlyRate))
      .filter((n) => Number.isFinite(n));
    const range = computeRateRange(rates) ?? FALLBACK_RANGE;
    cache = { range, at: Date.now() };
    return range;
  } catch (err) {
    console.error("getMarketRateRange: query failed, using static fallback:", err);
    return FALLBACK_RANGE;
  }
}

/** The range as message copy, e.g. "$18–28/hr" — the form every hint uses. */
export async function getMarketRateText(): Promise<string> {
  const { min, max } = await getMarketRateRange();
  return `$${min}–${max}/hr`;
}
