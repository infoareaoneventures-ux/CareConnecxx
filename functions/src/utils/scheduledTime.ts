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

// Same as formatInterviewTime, short form (no year, abbreviated weekday/
// month) — for compact multi-line SMS displays like a numbered interview
// pick list, where the long form reads too wide per line.
// 2026-09-14 (live-caught): a version of this that called
// `new Date(...).toLocaleString(...)` with NO timeZone rendered in whatever
// zone Cloud Functions happens to run in (UTC) — a real interview shown as
// "9:00 AM" on the site texted back as "4:00 PM" (a plain 7-hour Pacific
// offset), and for one entry the DATE itself shifted to the next day too.
// Every other interview-time display in this codebase already goes through
// an explicit `timeZone: DEFAULT_TZ` for exactly this reason — this one
// hadn't yet.
export function formatInterviewTimeShort(ms: number, timeZone: string = DEFAULT_TZ): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    weekday: "short", month: "short", day: "numeric",
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

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Same problem, date-shaped: a raw "YYYY-MM-DD" echoed straight back at the
// family (2026-09-14, live-caught in interviewFlow.ts: "2026-09-14, got it!
// What time on 2026-09-14 works?") reads like a database dump, not something
// a person said or would want to reread. Display-only — the STORED value
// stays YYYY-MM-DD (or a raw fallback like "ASAP") for consistency with the
// rest of the system (job_posts.startDate, bookingFlowData.startDate, etc).
// Parses the string directly rather than via `new Date(...)` to avoid any
// timezone-shift risk on a date-only value with no instant to convert.
// Consolidated 2026-09-14 from a near-identical copy in jobPostingFlow.ts —
// same fix already applied once for time (see formatHHMMForDisplay above);
// don't let a second flow-local copy of this drift back in.
export function formatDateForDisplay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value; // "ASAP" or a raw fallback string — show as-is
  const [, y, mo, d] = m;
  const monthName = MONTH_NAMES[parseInt(mo, 10) - 1];
  return monthName ? `${monthName} ${parseInt(d, 10)}, ${y}` : value;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Weekday of a stored "YYYY-MM-DD", computed from the components (Date.UTC +
// getUTCDay) so it can never shift. `new Date("2026-09-16").getDay()` reads
// the string as UTC midnight, which is still the PREVIOUS day in Pacific after
// 5pm — and the model, given only the bare date, computed the weekday itself
// and got it wrong the same way (live-caught 2026-09-14: "Tuesday, Sep 16").
// Supply the weekday from here instead of letting anything derive it.
export function weekdayForDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  return WEEKDAY_NAMES[new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10))).getUTCDay()] ?? null;
}

// "Wednesday, September 16, 2026" — formatDateForDisplay with the weekday in
// front, for any family/caregiver-facing mention of a specific visit date.
export function formatDateWithWeekday(value: string): string {
  const weekday = weekdayForDate(value);
  return weekday ? `${weekday}, ${formatDateForDisplay(value)}` : formatDateForDisplay(value);
}
