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

// Tomorrow's date (YYYY-MM-DD) in the business timezone. Calendar arithmetic
// on the rendered date (not now+24h, which lands on the same business date
// during the fall-back DST hour).
export function businessTomorrowStr(timeZone: string = DEFAULT_TZ, now: Date = new Date()): string {
  const d = new Date(`${businessTodayStr(timeZone, now)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// "YYYY-MM-DDTHH" bucket of an instant, rendered in the business timezone.
// Calendar-collision checks must key BOTH sides through this — building one
// side from stored wall-clock fields and the other from toISOString()/UTC
// produces keys 7-8h apart that never match, so conflicts go undetected.
export function slotHourKey(ms: number, timeZone: string = DEFAULT_TZ): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const h = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${h}`;
}

// Same bucket for a stored appointment `date` ("YYYY-MM-DD") + `time` field
// ("2:00 PM", "9:00", "14:00" — wall-clock in the business timezone). Returns
// null when the time is unparseable rather than guessing a slot.
export function apptSlotHourKey(date: unknown, time: unknown, timeZone: string = DEFAULT_TZ): string | null {
  if (typeof date !== "string" || !date) return null;
  if (typeof time !== "string") return null;
  const m = time.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  if (m[3] === "PM" && hour < 12) hour += 12;
  if (m[3] === "AM" && hour === 12) hour = 0;
  if (hour > 23 || Number(minute) > 59) return null;
  const ms = parseScheduledTimeMs(`${date}T${String(hour).padStart(2, "0")}:${minute}:00`, timeZone);
  if (!Number.isFinite(ms)) return null;
  return slotHourKey(ms, timeZone);
}

// UTC instant of a stored appointment `date` ("YYYY-MM-DD") + `time` field
// ("14:00" or "2:00 PM" — Pacific wall clock). NaN when unparseable, so
// callers can skip rather than guess.
export function apptStartMs(date: unknown, time: unknown, timeZone: string = DEFAULT_TZ): number {
  if (typeof date !== "string" || !date) return NaN;
  const m = String(time ?? "").trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return NaN;
  let hour = parseInt(m[1], 10);
  if (m[3] === "PM" && hour < 12) hour += 12;
  if (m[3] === "AM" && hour === 12) hour = 0;
  if (hour > 23 || Number(m[2]) > 59) return NaN;
  return parseScheduledTimeMs(`${date}T${String(hour).padStart(2, "0")}:${m[2]}:00`, timeZone);
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

// Stored appointment/shift times stay 24h "HH:MM" internally (matches the
// site's own dayShiftTimes/appointments shape) — a family reading an SMS
// shouldn't see "13:00" echoed back at them. Originally duplicated
// separately in bookingFlow.ts and interviewFlow.ts's own recaps; a THIRD
// spot (bookingExecutor.ts's finalizeAcceptedBooking confirmation) leaked
// the same raw 24h time (2026-09-13, live-caught), so this is now the one
// shared home — every caller should import from here instead of adding a
// fourth copy.
export function formatHHMMForDisplay(time: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const period = parseInt(m[1], 10) >= 12 ? "PM" : "AM";
  const hour12 = parseInt(m[1], 10) % 12 || 12;
  return `${hour12}:${m[2]} ${period}`;
}
