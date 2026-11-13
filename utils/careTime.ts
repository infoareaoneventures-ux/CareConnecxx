// Care-location time: one set of rules for every U.S. time zone, on the site and on the server.
//
// Decided with the founder (2026-11-09): the canonical value is the exact UTC MOMENT, never "Pacific".
// A visit is a wall-clock slot AT THE CARE ADDRESS ("Tuesday 9:00 AM" in Chicago), so each booking / visit
// carries the care location's IANA zone (`timeZone`, derived once from the ZIP); everything that compares a
// visit with "now" turns that wall clock into an instant through the zone. One-off events (interviews, clock
// in/out) are stored as instants. Pacific stays only as the default for records that carry no zone (all
// existing data) and for system-wide jobs.
//
// Pure (Intl only). Kept byte-identical on both sides by a parity test
// (functions/src/utils/__tests__/careTime.test.ts) — change both files together.

export const DEFAULT_CARE_TZ = "America/Los_Angeles";

// ZIP → zone by the first three digits (USPS sectional centers). Split states are handled by listing the
// prefixes that differ from their state's main zone; anything unlisted falls to the state's zone, and a ZIP
// that matches nothing is null (the caller uses DEFAULT_CARE_TZ).
const E = "America/New_York", C = "America/Chicago", M = "America/Denver", P = "America/Los_Angeles";
const AZ = "America/Phoenix", AK = "America/Anchorage", HI = "Pacific/Honolulu", PR = "America/Puerto_Rico";

type Range = [number, number, string];
const RANGES: Range[] = [
  [5, 5, E], [6, 9, PR], [10, 89, E], [100, 196, E], [197, 199, E], [200, 299, E], [300, 319, E], [320, 323, E],
  [324, 325, C],            // FL panhandle
  [326, 349, E], [350, 369, C],
  [370, 372, C], [373, 374, E], [375, 376, C], [377, 379, E], [380, 385, C],   // TN: east = Chattanooga/Knoxville/Tri-Cities
  [386, 397, C], [398, 399, E],
  [400, 419, E], [420, 427, C],  // KY: west = Paducah/Owensboro/Bowling Green
  [430, 459, E], [460, 462, E], [463, 464, C], [465, 475, E], [476, 477, C], [478, 479, E], // IN: NW + SW corners are Central
  [480, 499, E], [500, 528, C], [530, 549, C], [550, 567, C],
  [570, 576, C], [577, 577, M],   // SD: west river is Mountain
  [580, 585, C], [586, 586, M], [587, 588, C], // ND: SW is Mountain
  [590, 599, M], [600, 629, C], [630, 658, C], [660, 679, C],
  [680, 690, C], [691, 693, M],   // NE: panhandle is Mountain
  [700, 714, C], [716, 729, C], [730, 749, C],
  [750, 797, C], [798, 799, M],   // TX: El Paso
  [800, 816, M], [820, 831, M],
  [832, 834, M], [835, 835, P], [836, 837, M], [838, 838, P], // ID: north Idaho is Pacific
  [840, 847, M], [850, 865, AZ], [870, 884, M], [885, 885, M], [889, 898, P],
  [900, 961, P], [967, 968, HI], [970, 979, P], [980, 994, P], [995, 999, AK],
];

/** IANA zone for a U.S. ZIP code, or null when the ZIP is missing or unrecognised. */
export function zoneFromZip(zip: unknown): string | null {
  const m = typeof zip === "string" || typeof zip === "number" ? String(zip).trim().match(/^(\d{3})\d{0,2}(?:-\d{4})?$/) : null;
  if (!m) return null;
  const n = parseInt(m[1], 10);
  for (const [lo, hi, tz] of RANGES) if (n >= lo && n <= hi) return tz;
  return null;
}

/** The last 5-digit ZIP in an address line ("4746 Campbell Ave, San Jose, CA 95130"), or null. */
export function zipFromAddress(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const all = [...address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/** The zone a record is in: its own stamped `timeZone`, else its ZIP's (field or address line), else the default (Pacific). */
export function careZoneOf(rec: { timeZone?: unknown; careTimeZone?: unknown; zipCode?: unknown; zip?: unknown; address?: unknown } | null | undefined): string {
  const own = rec?.timeZone ?? rec?.careTimeZone;
  if (typeof own === "string" && isValidZone(own)) return own;
  return zoneFromZip(rec?.zipCode ?? rec?.zip) ?? zoneFromZip(zipFromAddress(rec?.address)) ?? DEFAULT_CARE_TZ;
}

export function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Offset of `timeZone` from UTC at an instant, ms (positive = ahead of UTC).
function offsetMs(utcMs: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - utcMs;
}

/**
 * The UTC instant (ms) of a wall-clock date + time AT a zone. `date` is YYYY-MM-DD, `time` is HH:mm (or HH:mm:ss).
 * A time that does not exist (spring-forward gap) lands just after the gap; an ambiguous one (fall-back) takes the
 * first occurrence. NaN when either part is unusable.
 */
export function wallToInstantMs(date: unknown, time: unknown, timeZone: string = DEFAULT_CARE_TZ): number {
  const d = typeof date === "string" ? date.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  const t = typeof time === "string" ? time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/) : null;
  if (!d || !t) return NaN;
  const asUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  const tz = isValidZone(timeZone) ? timeZone : DEFAULT_CARE_TZ;
  const guess = asUtc - offsetMs(asUtc, tz);
  const ms = asUtc - offsetMs(guess, tz);
  // Round-trip check: in a spring-forward gap the guess maps to a different wall time — step forward past the gap.
  return offsetMs(ms, tz) === asUtc - ms ? ms : guess;
}

/** The wall-clock { date: YYYY-MM-DD, time: HH:mm } of an instant AT a zone. */
export function instantToWall(ms: number, timeZone: string = DEFAULT_CARE_TZ): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: isValidZone(timeZone) ? timeZone : DEFAULT_CARE_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` };
}

/** Short zone name at an instant: "PT", "CT", "ET", "MT", "AKT", "HT"; Arizona reads "MST" (no daylight saving). */
export function zoneAbbr(timeZone: string, ms: number = Date.now()): string {
  if (timeZone === "America/Phoenix") return "MST";
  const long = new Intl.DateTimeFormat("en-US", { timeZone: isValidZone(timeZone) ? timeZone : DEFAULT_CARE_TZ, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = long.match(/^([A-Z])[SD]T$/); // PST/PDT → PT
  if (m) return `${m[1]}T`;
  if (/^AK[SD]T$/.test(long)) return "AKT";
  if (/^HST$/.test(long)) return "HT";
  return long;
}

/** "9:00 AM CT" — an instant shown in a zone, with the zone's short name. */
export function formatTimeInZone(ms: number, timeZone: string, opts: { withZone?: boolean } = {}): string {
  const tz = isValidZone(timeZone) ? timeZone : DEFAULT_CARE_TZ;
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return opts.withZone === false ? t : `${t} ${zoneAbbr(tz, ms)}`;
}

/** "Tue, Nov 10" — an instant's calendar date in a zone. */
export function formatDateInZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: isValidZone(timeZone) ? timeZone : DEFAULT_CARE_TZ, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
}

/** The viewer's own zone (the browser's); the default on the server. */
export function viewerZone(): string {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return isValidZone(z) ? z : DEFAULT_CARE_TZ; } catch { return DEFAULT_CARE_TZ; }
}

/** Every U.S. zone's "today" right now (1-3 distinct dates): the dates to query when a person's own zone is not known yet. */
export function todayDatesAcrossZones(now: Date = new Date()): string[] {
  const out = new Set<string>();
  for (const tz of ["Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York"]) out.add(instantToWall(now.getTime(), tz).date);
  return [...out];
}

/** Is this visit's date today AT ITS OWN care location? */
export function isTodayAtCareLocation(rec: { date?: unknown } & Parameters<typeof careZoneOf>[0], now: Date = new Date()): boolean {
  return typeof rec?.date === "string" && rec.date === instantToWall(now.getTime(), careZoneOf(rec)).date;
}

/** " CT" for a visit outside Pacific, "" for Pacific (existing wording unchanged) — appended to a wall-clock time so it is never ambiguous. */
export function zoneSuffix(rec: Parameters<typeof careZoneOf>[0], atMs: number = Date.now()): string {
  const tz = careZoneOf(rec);
  return tz === DEFAULT_CARE_TZ ? "" : ` ${zoneAbbr(tz, atMs)}`;
}

const addDaysStr = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The span of dates that are "tomorrow" somewhere in the U.S. right now (1-2 days): the range to query for day-before reminders. */
export function tomorrowRangeAcrossZones(now: Date = new Date()): { from: string; to: string } {
  const dates = todayDatesAcrossZones(now).map((d) => addDaysStr(d, 1)).sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

/**
 * Is a visit's day-before reminder due? True once the visit's OWN care-location clock has reached `targetHour` on the
 * day before its date (and stays true after, so a missed hourly run still sends; the caller's "sent" marker stops repeats).
 */
export function dayBeforeReminderDue(rec: { date?: unknown } & Parameters<typeof careZoneOf>[0], targetHour: number, now: Date = new Date()): boolean {
  if (typeof rec?.date !== "string") return false;
  const w = instantToWall(now.getTime(), careZoneOf(rec));
  return rec.date === addDaysStr(w.date, 1) && parseInt(w.time.slice(0, 2), 10) >= targetHour;
}
