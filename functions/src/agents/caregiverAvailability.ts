// Converts the conversational availability shape Evia collects during caregiver
// onboarding ({ days: ["Monday", ...], hours: "9am-5pm" }) into the structured
// weeklyAvailability map the matching engine (ai/scoring.ts availabilityOverlap)
// and the web profile modal read: { monday: [{ start: "09:00", end: "17:00" }], ... }.
//
// This is a deterministic conversion of ALREADY-LLM-PARSED values (the
// caregiver_ask_availability step extracts days/hours with parseWithClaude),
// not intent parsing of raw user text — same category as mapTimeOfDayToSlots
// and scoring.ts TIME_BLOCKS.

const DAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;

type TimeSlot = { start: string; end: string };
export type WeeklyAvailabilityMap = Record<string, TimeSlot[]>;

// Keyword blocks mirror ai/scoring.ts TIME_BLOCKS (overnight capped at 23:59 —
// hhmmToMin drops ranges whose end wraps past midnight).
const KEYWORD_BLOCKS: Array<{ re: RegExp; slot: TimeSlot }> = [
  { re: /morning/i,            slot: { start: "06:00", end: "12:00" } },
  { re: /afternoon/i,          slot: { start: "12:00", end: "17:00" } },
  { re: /evening|night(?!.*over)/i, slot: { start: "17:00", end: "22:00" } },
  { re: /overnight|over night/i,    slot: { start: "22:00", end: "23:59" } },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// "9am" → 540, "5:30pm" → 1050, "17" → 1020. Returns null when not a time.
function parseClockToMin(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (isNaN(h) || h > 24 || min > 59) return null;
  const mer = m[3]?.toLowerCase();
  if (mer?.startsWith("p") && h < 12) h += 12;
  if (mer?.startsWith("a") && h === 12) h = 0;
  return h * 60 + min;
}

function minToHhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// Extract time slots from the free-ish hours string ("9am-5pm", "9 to 3",
// "mornings and evenings"). Falls back to a broad daytime block when the
// string carries no parseable signal — a rough default scores far better than
// a missing map, which availabilityOverlap treats as 0% available.
export function parseHoursToSlots(hours: string): TimeSlot[] {
  const text = (hours ?? "").trim();
  if (text) {
    // Explicit range(s): "9am-5pm", "9:30 to 14:00", "8 - 6pm"
    const rangeRe = /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:-|–|—|to|until|till)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/gi;
    const slots: TimeSlot[] = [];
    let m: RegExpExecArray | null;
    while ((m = rangeRe.exec(text)) !== null) {
      let start = parseClockToMin(m[1]);
      let end   = parseClockToMin(m[2]);
      if (start === null || end === null) continue;
      // "9-5" with no meridiem: assume 9am-5pm style daytime intent
      if (end <= start && end + 12 * 60 <= 24 * 60) end += 12 * 60;
      if (end > start) slots.push({ start: minToHhmm(start), end: minToHhmm(Math.min(end, 1439)) });
    }
    if (slots.length) return slots;

    const keyword = KEYWORD_BLOCKS.filter((b) => b.re.test(text)).map((b) => ({ ...b.slot }));
    if (keyword.length) return keyword;

    if (/any\s*time|flexible|24|whenever|all day/i.test(text)) {
      return [{ start: "00:00", end: "23:59" }];
    }
  }
  // Unparseable → broad daytime default
  return [{ start: "08:00", end: "18:00" }];
}

// Expand day tokens ("Monday", "weekends", "Mon–Fri", "every day") to DAY_KEYS.
export function normalizeDays(days: unknown): string[] {
  if (!Array.isArray(days)) return [];
  const out = new Set<string>();
  for (const raw of days) {
    if (typeof raw !== "string") continue;
    const t = raw.toLowerCase();
    if (/every\s*day|any\s*day|all\s*(week|days)|7 days/.test(t)) {
      DAY_KEYS.forEach((d) => out.add(d));
      continue;
    }
    if (/weekday/.test(t)) {
      ["monday", "tuesday", "wednesday", "thursday", "friday"].forEach((d) => out.add(d));
      continue;
    }
    if (/weekend/.test(t)) {
      out.add("saturday"); out.add("sunday");
      continue;
    }
    for (const day of DAY_KEYS) {
      if (t.includes(day.slice(0, 3))) out.add(day);
    }
  }
  return DAY_KEYS.filter((d) => out.has(d));
}

// Main entry — returns undefined when there's nothing usable (caller spread-omits).
export function deriveWeeklyAvailability(
  availability: unknown,
): WeeklyAvailabilityMap | undefined {
  if (!availability || typeof availability !== "object") return undefined;
  const a = availability as { days?: unknown; hours?: unknown };
  const days = normalizeDays(a.days);
  if (!days.length) return undefined;
  const slots = parseHoursToSlots(typeof a.hours === "string" ? a.hours : "");
  const map: WeeklyAvailabilityMap = {};
  for (const day of days) map[day] = slots.map((s) => ({ ...s }));
  return map;
}
