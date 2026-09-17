// Tri-state care-signal evidence (plan 2026-07-18-001 U1, R2-R6/AE1-AE3).
//
// Care journal wellness fields (ateWell / tookMeds / wasActive) are OPTIONAL
// booleans. Several prompt surfaces used JS truthiness on them, which turns a
// missing field into "appetite concerns" / "meds missed" — deterministic
// fabrication no model can correct. Every consumer of wellness meaning goes
// through this module instead: a field is "yes", "no", or "unknown", and
// unknown NEVER renders as a negative observation or enters a rate denominator.
//
// Also owns future-safe next-appointment selection: a "next visit" claim must
// be backed by a start instant strictly in the future (business timezone), so
// a recent past visit whose status was never advanced can't be presented as
// upcoming (AE3).

import { apptStartMs, businessTodayStr } from "../utils/scheduledTime";

export type CareSignal = "yes" | "no" | "unknown";

// Strict parse: only explicit booleans (or their unambiguous string forms,
// which some web writers produce) are known. Numbers, empty strings, nulls,
// and anything else are unknown — never a negative (R2).
export function parseCareSignal(value: unknown): CareSignal {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "yes") return "yes";
    if (s === "false" || s === "no") return "no";
  }
  return "unknown";
}

export interface WellnessSignals {
  mood: string | null;
  ateWell: CareSignal;
  tookMeds: CareSignal;
  wasActive: CareSignal;
}

// Accepts a raw journal entry ({ wellness?: {...} }) or a bare wellness map.
export function parseWellness(entry: unknown): WellnessSignals {
  const outer = entry as Record<string, unknown> | null | undefined;
  const w = (outer?.wellness ?? outer) as Record<string, unknown> | null | undefined;
  const mood = typeof w?.mood === "string" && w.mood.trim() ? w.mood.trim() : null;
  return {
    mood,
    ateWell: parseCareSignal(w?.ateWell),
    tookMeds: parseCareSignal(w?.tookMeds),
    wasActive: parseCareSignal(w?.wasActive),
  };
}

// One journal entry as prompt prose. Known-negative wording is reserved for
// explicit false; missing data says "not recorded" so the model cannot cite it
// as a concern (AE1).
export function describeWellness(w: WellnessSignals): string {
  const ate =
    w.ateWell === "yes" ? "ate well"
    : w.ateWell === "no" ? "appetite low (recorded)"
    : "appetite not recorded";
  const meds =
    w.tookMeds === "yes" ? "meds taken"
    : w.tookMeds === "no" ? "meds missed (recorded)"
    : "med status not recorded";
  return `mood ${w.mood ?? "not recorded"}, ${ate}, ${meds}`;
}

// ── Known-denominator rollups ────────────────────────────────────────────────

export interface SignalRollup {
  total: number;   // entries examined
  yes: number;
  no: number;
  unknown: number; // total - yes - no
}

export function rollupCareSignals(
  entries: Array<Record<string, unknown>>,
  field: "ateWell" | "tookMeds" | "wasActive",
): SignalRollup {
  const r: SignalRollup = { total: 0, yes: 0, no: 0, unknown: 0 };
  for (const e of entries) {
    r.total++;
    const s = parseCareSignal((e?.wellness as Record<string, unknown> | undefined)?.[field]);
    if (s === "yes") r.yes++;
    else if (s === "no") r.no++;
    else r.unknown++;
  }
  return r;
}

// Below this many known observations a rate is noise, not evidence (R34).
export const MIN_KNOWN_FOR_RATE = 3;

// Rate sentence over KNOWN observations only, with explicit coverage; null when
// there is not enough recorded evidence to state a rate at all.
export function describeSignalRate(r: SignalRollup, minKnown = MIN_KNOWN_FOR_RATE): string | null {
  const known = r.yes + r.no;
  if (known < minKnown) return null;
  const pct = Math.round((r.yes / known) * 100);
  const coverage = r.unknown > 0
    ? ` (${r.unknown} of ${r.total} entries did not record this)`
    : "";
  return `${pct}% of the ${known} visits where it was recorded${coverage}`;
}

// ── Future-safe next-appointment selection (AE3) ─────────────────────────────

// "in-progress" is deliberately absent: a visit that has started is active-visit
// context, not the next visit. Callers that surface active visits already load
// them separately (qaAgent.getActiveVisit).
export const NEXT_APPOINTMENT_STATUSES: readonly string[] = [
  "scheduled",   // shifts — the site's collection (2026-09-17)
  "in-progress",
  "confirmed",
  "pending",
  "pending_caregiver_confirmation",
];

function candidateDate(a: Record<string, unknown>): string {
  if (typeof a?.date === "string" && a.date) return a.date;
  if (typeof a?.isoDate === "string" && a.isoDate) return a.isoDate.slice(0, 10);
  return "";
}

// Earliest appointment whose start instant is strictly in the future, in the
// business timezone. Candidates may arrive in any order (fixes the desc-sorted
// pick in operationalContext). Rules:
//   - status outside `statuses` → excluded
//   - calendar date before business-today → excluded
//   - date+time parseable and start <= now → excluded (same-day past)
//   - future date with unparseable time → included at start-of-day (a real
//     future visit is not dropped because its time field is malformed)
//   - same-day with unparseable time → included: we cannot prove it has
//     passed, and omitting a real upcoming visit is its own falsehood; the
//     rendered string carries the raw fields so nothing is invented
export function selectNextAppointment<T extends Record<string, unknown>>(
  candidates: T[],
  opts?: { now?: Date; timeZone?: string; statuses?: readonly string[] },
): T | null {
  const now = opts?.now ?? new Date();
  const nowMs = now.getTime();
  const today = businessTodayStr(opts?.timeZone, now);
  const statuses = new Set(opts?.statuses ?? NEXT_APPOINTMENT_STATUSES);

  const scored: Array<{ appt: T; ms: number }> = [];
  for (const appt of candidates) {
    if (!statuses.has(String(appt?.status ?? ""))) continue;
    const date = candidateDate(appt);
    if (!date || date < today) continue;

    const time = typeof appt?.startTime === "string" && appt.startTime
      ? appt.startTime
      : appt?.time;
    const startMs = apptStartMs(date, time, opts?.timeZone);
    if (Number.isFinite(startMs)) {
      if (startMs <= nowMs) continue; // already started or past (same-day)
      scored.push({ appt, ms: startMs });
      continue;
    }
    const dayMs = apptStartMs(date, "00:00", opts?.timeZone);
    if (!Number.isFinite(dayMs)) continue; // unparseable date — cannot place it
    scored.push({ appt, ms: dayMs });
  }

  scored.sort((a, b) => a.ms - b.ms);
  return scored.length ? scored[0].appt : null;
}
