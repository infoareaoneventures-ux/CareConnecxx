// Timezone-tolerant parsing for interview scheduledTime values.
//
// Three formats coexist in prod video_interviews docs:
//   - naive local strings  "2026-07-10T14:00:00"   (legacy MCP writer)
//   - ISO with Z           "2026-07-10T21:00:00.000Z" (web writer)
//   - tz-aware ISO         (new writes)
// Parsing a naive string with `new Date()` on Cloud Functions interprets it
// as UTC, shifting reminder math ~7-8h for Pacific users. Naive strings are
// interpreted as wall-clock time in the client's timezone instead
// (America/Los_Angeles fallback — the service area is Santa Clara County).

const DEFAULT_TZ = "America/Los_Angeles";

export function parseScheduledTimeMs(value: string, timeZone: string = DEFAULT_TZ): number {
  if (!value) return NaN;
  // Offset or Z present → trust it
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return Date.parse(value);

  // Naive wall-clock → UTC instant in the given timezone (two-pass offset)
  const asUtc = Date.parse(`${value}Z`);
  if (Number.isNaN(asUtc)) return Date.parse(value); // unparseable shape, last resort
  const firstGuess  = asUtc - tzOffsetMs(asUtc, timeZone);
  const finalOffset = tzOffsetMs(firstGuess, timeZone);
  return asUtc - finalOffset;
}

// Offset of `timeZone` from UTC at the given instant, in ms (positive = ahead of UTC)
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const wall = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return wall - utcMs;
}

// Today's date (YYYY-MM-DD) in the business timezone — NOT UTC. Cloud Functions
// run in UTC, so `new Date().toISOString().slice(0,10)` is the UTC date, which
// during Pacific evening hours is already tomorrow — making `where("date","==",
// today)` query the wrong day for reminders. Use this instead.
export function businessTodayStr(timeZone: string = DEFAULT_TZ, now: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Minutes-since-midnight of `now` in the business timezone (0–1439). For jobs
// that compare a wall-clock shift/task time to "now" — using getHours() gives
// UTC minutes on Cloud Functions and fires those jobs at the wrong local hour.
export function businessNowMinutes(timeZone: string = DEFAULT_TZ, now: Date = new Date()): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(now)) parts[p.type] = p.value;
  const h = parts.hour === "24" ? 0 : Number(parts.hour);
  return h * 60 + Number(parts.minute);
}

// Human-facing time for SMS copy, rendered in the client's timezone
export function formatInterviewTime(ms: number, timeZone: string = DEFAULT_TZ): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
