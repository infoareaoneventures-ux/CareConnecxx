// A typical hourly range for the area, from the real rates care providers have set (2026-11-11, fix plan Wave 3:
// "the rate step gives no guidance"). Same method as functions/src/utils/marketRateRange.ts: the 25th-75th
// percentile of sane rates, rounded outward; too few rates → the original hand-picked $18-28 so the hint is never blank.
export const FALLBACK_RATE_RANGE = { min: 18, max: 28 } as const;
const MIN_SAMPLE = 5;
const SANE_MIN = 10;
const SANE_MAX = 150;

export function computeRateRange(rates: unknown[]): { min: number; max: number } | null {
  const clean = rates.map(Number).filter((r) => Number.isFinite(r) && r >= SANE_MIN && r <= SANE_MAX).sort((a, b) => a - b);
  if (clean.length < MIN_SAMPLE) return null;
  const pct = (p: number) => clean[Math.min(clean.length - 1, Math.floor(p * clean.length))];
  const min = Math.floor(pct(0.25));
  let max = Math.ceil(pct(0.75));
  if (max <= min) max = min + 2;
  return { min, max };
}

export function rateRangeOrFallback(rates: unknown[]): { min: number; max: number } {
  return computeRateRange(rates) ?? { ...FALLBACK_RATE_RANGE };
}
