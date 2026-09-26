// Converts the conversational availability shape Evia collects during caregiver
// onboarding ({ days: ["Monday", ...], hours: "9am-5pm" }) into the structured
// weeklyAvailability map the webapp grid AND the matching engine both read.
//
// CRITICAL — the stored slots must snap to the webapp's four fixed TIME_BLOCKS,
// not to whatever clock range the caregiver stated. The profile grid
// (services/availabilityService.ts weeklySlotsToBl) lights a block only when a
// stored slot overlaps that block's minute window, and the matching engine
// (ai/scoring.ts caregiverDayRanges) DROPS any slot whose end ≤ start. So each
// block is emitted as the exact canonical slot that (a) lights that ONE block in
// weeklySlotsToBl and (b) is never dropped by the matcher:
//
//   morning   06:00–12:00   afternoon 12:00–18:00
//   evening   18:00–23:00   overnight 23:00–23:59  (NOT cross-midnight —
//                                                   the matcher drops wraps)
//
// A caregiver who states a clock range ("9 to 5") snaps WIDE to every block the
// range overlaps (→ morning + afternoon). This deliberately widens stated hours
// to the block grid; the caregiver can trim it in the webapp. This is a
// deterministic conversion of ALREADY-LLM-PARSED values, not intent parsing.

const DAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;

type TimeSlot = { start: string; end: string };
export type WeeklyAvailabilityMap = Record<string, TimeSlot[]>;

type BlockId = "morning" | "afternoon" | "evening" | "overnight";

// The canonical stored slot for each webapp block. Emitting these exact values
// guarantees the round-trip through weeklySlotsToBl lights exactly one block and
// the matcher keeps the slot (end > start for all four).
const BLOCK_SLOT: Record<BlockId, TimeSlot> = {
  morning:   { start: "06:00", end: "12:00" },
  afternoon: { start: "12:00", end: "18:00" },
  evening:   { start: "18:00", end: "23:00" },
  overnight: { start: "23:00", end: "23:59" },
};

// The "intent window" (in minutes) used to decide which block(s) a stated clock
// range or keyword covers. These follow the block LABELS the caregiver sees
// (Morning 6a–12p, Afternoon 12p–6p, Evening 6p–12a, Overnight 12a–6a), which
// differ slightly from the stored-slot minutes above (overnight especially).
const BLOCK_WINDOW: Record<BlockId, { s: number; e: number }> = {
  morning:   { s: 6 * 60,  e: 12 * 60 },  // 06:00–12:00
  afternoon: { s: 12 * 60, e: 18 * 60 },  // 12:00–18:00
  evening:   { s: 18 * 60, e: 24 * 60 },  // 18:00–24:00
  overnight: { s: 0,       e: 6 * 60  },  // 00:00–06:00
};

const BLOCK_ORDER: BlockId[] = ["morning", "afternoon", "evening", "overnight"];

const KEYWORD_BLOCKS: Array<{ re: RegExp; block: BlockId }> = [
  { re: /morning/i,                block: "morning" },
  { re: /afternoon|midday|noon/i,  block: "afternoon" },
  { re: /evening|(?<!over)night/i, block: "evening" },
  { re: /overnight|over night|graveyard/i, block: "overnight" },
];

const ANY_TIME_RE   = /any\s*time|flexible|24\/7|24-7|whenever|all day|open/i;
const CLOCK_RANGE_RE = /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:-|–|—|to|until|till|thru|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i;

/**
 * Did the caregiver actually STATE a part of the day (or clock range, or "any
 * time")? The website's availability picker has two separate inputs — days of
 * the week and parts of the day — and Evia must collect both rather than
 * fabricate one (live 2026-09-26: "Monday" alone became Monday morning +
 * afternoon on the profile, times the caregiver never chose). Deterministic
 * check of an already-collected value, not intent parsing.
 */
export function hasTimeOfDaySignal(hours: unknown): boolean {
  if (typeof hours !== "string") return false;
  const t = hours.trim();
  if (!t) return false;
  if (ANY_TIME_RE.test(t) || CLOCK_RANGE_RE.test(t)) return true;
  return KEYWORD_BLOCKS.some(({ re }) => re.test(t));
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

// Which blocks does a minute range [s, e) overlap? Handles cross-midnight ranges
// (e ≤ s) by splitting into [s, 1440) ∪ [0, e).
function blocksForRange(s: number, e: number): BlockId[] {
  const segments: Array<[number, number]> = e > s ? [[s, e]] : [[s, 1440], [0, e]];
  const active = new Set<BlockId>();
  for (const [segS, segE] of segments) {
    for (const b of BLOCK_ORDER) {
      const w = BLOCK_WINDOW[b];
      if (segS < w.e && segE > w.s) active.add(b);
    }
  }
  return BLOCK_ORDER.filter((b) => active.has(b));
}

function slotsForBlocks(blocks: Iterable<BlockId>): TimeSlot[] {
  const seen = new Set<BlockId>();
  const out: TimeSlot[] = [];
  for (const b of BLOCK_ORDER) {
    if ([...blocks].includes(b) && !seen.has(b)) {
      seen.add(b);
      out.push({ ...BLOCK_SLOT[b] });
    }
  }
  return out;
}

// Turn the free-ish hours string ("9am-5pm", "mornings and evenings", "9 to 3")
// into a set of canonical block slots. Falls back to a broad daytime default
// (morning + afternoon) when there is no parseable signal — a rough default
// scores far better than a missing map, which the matcher treats as 0% available.
export function parseHoursToSlots(hours: string): TimeSlot[] {
  const text = (hours ?? "").trim();
  const blocks = new Set<BlockId>();

  if (text) {
    if (/any\s*time|flexible|24\/7|24-7|whenever|all day|open/i.test(text)) {
      return slotsForBlocks(BLOCK_ORDER);
    }

    // Explicit range(s): "9am-5pm", "9:30 to 14:00", "10pm-6am"
    const rangeRe = /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:-|–|—|to|until|till|thru|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/gi;
    let m: RegExpExecArray | null;
    let matchedRange = false;
    while ((m = rangeRe.exec(text)) !== null) {
      const start = parseClockToMin(m[1]);
      let end = parseClockToMin(m[2]);
      if (start === null || end === null) continue;
      // "9-5" with no meridiem on either side and end < start: assume daytime
      // (9am–5pm), NOT a cross-midnight range. If a meridiem is present we trust
      // it (so "10pm-6am" stays cross-midnight and lights evening + overnight).
      const hasMeridiem = /am|pm|a\.m\.|p\.m\./i.test(m[1] + m[2]);
      if (!hasMeridiem && end <= start && end + 12 * 60 <= 24 * 60) end += 12 * 60;
      matchedRange = true;
      for (const b of blocksForRange(start, end)) blocks.add(b);
    }
    if (matchedRange && blocks.size) return slotsForBlocks(blocks);

    for (const { re, block } of KEYWORD_BLOCKS) {
      if (re.test(text)) blocks.add(block);
    }
    if (blocks.size) return slotsForBlocks(blocks);
  }

  // Unparseable → broad daytime default (morning + afternoon).
  return slotsForBlocks(["morning", "afternoon"]);
}

// Expand day tokens ("Monday", "weekends", "Mon–Fri", "every day") to DAY_KEYS.
export function normalizeDays(days: unknown): string[] {
  if (!Array.isArray(days)) return [];
  const out = new Set<string>();
  for (const raw of days) {
    if (typeof raw !== "string") continue;
    const t = raw.toLowerCase();
    if (/every\s*day|any\s*day|all\s*(week|days)|7 days|daily/.test(t)) {
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

function buildMap(days: string[], slots: TimeSlot[]): WeeklyAvailabilityMap {
  const map: WeeklyAvailabilityMap = {};
  for (const day of days) map[day] = slots.map((s) => ({ ...s }));
  return map;
}

// Main entry — returns undefined when there's nothing usable (caller spread-omits).
//
// Accepts every availability shape that exists in prod, not just the canonical
// { days, hours } object (2026-07-11: a live caregiver's session held the plain
// string "mornings and evenings", so the mirror never wrote weeklyAvailability
// and the webapp grid stayed stale):
//  • { days, hours }  — canonical LLM-parsed object (primary path)
//  • plain string     — the model saved the caregiver's words verbatim
//  • string[]         — day-name list (update_caregiver_availability legacy)
// When day names are absent but a time signal exists, default to ALL 7 days —
// a caregiver stating only times means "any day", and a rough map beats a
// missing one (the matcher scores a missing map as 0% available).
export function deriveWeeklyAvailability(
  availability: unknown,
): WeeklyAvailabilityMap | undefined {
  if (!availability) return undefined;

  if (typeof availability === "string") {
    const text = availability.trim();
    if (!text) return undefined;
    const days = normalizeDays([text]);
    return buildMap(days.length ? days : [...DAY_KEYS], parseHoursToSlots(text));
  }

  if (Array.isArray(availability)) {
    const days = normalizeDays(availability);
    if (!days.length) return undefined;
    return buildMap(days, parseHoursToSlots(""));
  }

  if (typeof availability !== "object") return undefined;
  const a = availability as { days?: unknown; hours?: unknown };
  const days = normalizeDays(a.days);
  const hours = typeof a.hours === "string" ? a.hours.trim() : "";
  if (!days.length && !hours) return undefined;
  return buildMap(days.length ? days : [...DAY_KEYS], parseHoursToSlots(hours));
}

// Save-time coercion for the loop's save_onboarding_field tool: turn whatever
// the model passed for `availability` into the canonical { days, hours } object
// before it lands in the session. Free text goes through the LLM (per the Evia
// parsing policy); already-structured values are cleaned deterministically.
// Returns undefined when there is no usable signal (caller keeps the raw value).
// llmParse is injectable for tests; production uses parseWithClaude.
export async function normalizeAvailabilityInput(
  value: unknown,
  llmParse?: (systemPrompt: string, userText: string) => Promise<string>,
): Promise<{ days: string[]; hours: string } | undefined> {
  const cleanDays = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
      : [];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const a = value as Record<string, unknown>;
    const days = cleanDays(a.days);
    const hours = typeof a.hours === "string" ? a.hours.trim() : "";
    return days.length || hours ? { days, hours } : undefined;
  }

  if (Array.isArray(value)) {
    const days = cleanDays(value);
    return days.length ? { days, hours: "" } : undefined;
  }

  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  try {
    const parse = llmParse ?? (await import("../utils/parseWithClaude")).parseWithClaude;
    // Never invent the half they didn't state: days stay [] when they only gave
    // times (and vice versa) so the loop asks for the missing piece, exactly like
    // the website's two-part picker (2026-09-26).
    const raw = await parse(
      "Extract a caregiver's work availability from their message. Reply with raw JSON only: " +
        '{"days":["Monday"],"hours":"9am-5pm"}. days = ONLY the day names they actually stated; use ["weekdays"], ' +
        '["weekends"], or ["every day"] when they speak in those terms; [] when they name no days at all. ' +
        'hours = their stated time window or time-of-day words ("mornings and evenings"); "" if none stated.',
      text,
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const days = cleanDays(parsed.days);
    const hours = typeof parsed.hours === "string" ? parsed.hours.trim() : "";
    if (days.length || hours) return { days, hours };
  } catch (err) {
    console.warn("[normalizeAvailabilityInput] LLM parse failed, using raw-text fallback:", err);
  }
  // LLM unavailable/unusable: keep the raw text in BOTH fields so
  // deriveWeeklyAvailability can still pull day tokens and time keywords out.
  return { days: [text], hours: text };
}

// Human-readable summary of a derived availability map, for Evia's spoken
// acknowledgment ("weekday mornings and afternoons"). Returns "" when empty.
export function describeWeeklyAvailability(
  map: WeeklyAvailabilityMap | undefined,
): string {
  if (!map) return "";
  const dayBlocks = new Map<string, BlockId[]>();
  for (const [day, slots] of Object.entries(map)) {
    const blocks = new Set<BlockId>();
    for (const slot of slots) {
      const s = hhmm(slot.start);
      const e = hhmm(slot.end);
      for (const b of BLOCK_ORDER) {
        const w = { morning: { s: 360, e: 720 }, afternoon: { s: 720, e: 1080 }, evening: { s: 1080, e: 1380 }, overnight: { s: 1380, e: 1440 } }[b];
        if (s < w.e && e > w.s) blocks.add(b);
      }
    }
    if (blocks.size) dayBlocks.set(day, BLOCK_ORDER.filter((b) => blocks.has(b)));
  }
  if (!dayBlocks.size) return "";

  const daysList = [...dayBlocks.keys()];
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
  const isWeekdays = weekdays.every((d) => daysList.includes(d)) && daysList.length === 5;
  const isEveryDay = daysList.length === 7;
  const dayPhrase = isEveryDay ? "every day" : isWeekdays ? "weekdays" : daysList.map(cap).join(", ");

  const allBlocks = [...dayBlocks.values()][0];
  const sameEveryDay = [...dayBlocks.values()].every((b) => b.join() === allBlocks.join());
  const blockPhrase = sameEveryDay ? joinWords(allBlocks.map(blockLabel)) : "your selected times";

  return `${dayPhrase} ${blockPhrase}`.trim();
}

function hhmm(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function blockLabel(b: BlockId): string {
  return { morning: "mornings", afternoon: "afternoons", evening: "evenings", overnight: "overnights" }[b];
}
function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
