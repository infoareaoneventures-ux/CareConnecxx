// agents/caregiverAvailabilityGrid.ts — the Calendar page's "Update Availability"
// modal (components/caregiver/CaregiverCalendarPage.tsx), as data.
//
// The modal is a 7-day × 4-block grid (Morning 6am–12pm, Afternoon 12pm–6pm,
// Evening 6pm–12am, Overnight 12am–6am). Save writes ONE field:
//   caregivers/{uid}.weeklyAvailability = blocksToWeeklySlots(grid)
// i.e. { monday: [{start:"06:00",end:"12:00"}, …], … } — the whole map, every
// day, each block as its canonical slot (services/availabilityService.ts).
// Nothing else changes (no day list, no preferred time of day). Evia's write is
// the same field with the same values (founder goals 3 + 6, 2026-09-30).

export const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayKey = typeof DAY_KEYS[number];
export type BlockId = "morning" | "afternoon" | "evening" | "overnight";
export const BLOCK_IDS: BlockId[] = ["morning", "afternoon", "evening", "overnight"];
/** The modal's labels, verbatim. */
export const BLOCK_LABEL: Record<BlockId, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening", overnight: "Overnight" };
export const BLOCK_HOURS: Record<BlockId, string> = { morning: "6am – 12pm", afternoon: "12pm – 6pm", evening: "6pm – 12am", overnight: "12am – 6am" };
export const DAY_LABEL: Record<DayKey, string> = { sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat" };

type Slot = { start: string; end: string };
/** services/availabilityService.ts BLOCK_TO_TIMESLOT — what Save stores for each block. */
export const BLOCK_SLOT: Record<BlockId, Slot> = {
  morning:   { start: "06:00", end: "12:00" },
  afternoon: { start: "12:00", end: "18:00" },
  evening:   { start: "18:00", end: "23:00" },
  overnight: { start: "23:00", end: "06:00" },
};
/** services/availabilityService.ts weeklySlotsToBl — the minute windows that light each block. */
const BLOCK_MINS: Record<BlockId, { s: number; e: number }> = {
  morning: { s: 360, e: 720 }, afternoon: { s: 720, e: 1080 }, evening: { s: 1080, e: 1380 }, overnight: { s: 1380, e: 1440 },
};

export type Grid = Record<DayKey, BlockId[]>;

export function emptyGrid(): Grid {
  return { sunday: [], monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] };
}

const toMin = (t: string): number => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/** One day's stored slots (or legacy block names) → the blocks the modal lights. Same overlap rule as weeklySlotsToBl. */
export function blocksFromSlots(slots: unknown): BlockId[] {
  const active = new Set<BlockId>();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (typeof slot === "string") { const b = normalizeBlock(slot); if (b) active.add(b); continue; }
    if (!slot || typeof slot !== "object") continue;
    const { start, end } = slot as Partial<Slot>;
    if (typeof start !== "string" || typeof end !== "string") continue;
    const s = toMin(start); const eRaw = toMin(end); const e = eRaw <= s ? eRaw + 1440 : eRaw;
    for (const b of BLOCK_IDS) { const r = BLOCK_MINS[b]; if (s < r.e && e > r.s) active.add(b); }
  }
  return BLOCK_IDS.filter((b) => active.has(b));
}

/** Firestore → the grid (weeklySlotsToBl): stored slots or legacy block names, either format. */
export function gridFromWeekly(weekly: unknown): Grid {
  const grid = emptyGrid();
  if (!weekly || typeof weekly !== "object") return grid;
  for (const [rawDay, slots] of Object.entries(weekly as Record<string, unknown>)) {
    const day = normalizeDay(rawDay);
    if (!day) continue;
    grid[day] = blocksFromSlots(slots);
  }
  return grid;
}

/** The grid → Firestore (blocksToWeeklySlots): every day present, canonical slots, block order. */
export function weeklyFromGrid(grid: Grid): Record<DayKey, Slot[]> {
  const out = {} as Record<DayKey, Slot[]>;
  for (const day of DAY_KEYS) out[day] = orderBlocks(grid[day] ?? []).map((b) => ({ ...BLOCK_SLOT[b] }));
  return out;
}

export function orderBlocks(blocks: Iterable<string>): BlockId[] {
  const set = new Set([...blocks].map((b) => String(b).toLowerCase()));
  return BLOCK_IDS.filter((b) => set.has(b));
}

export function normalizeDay(v: unknown): DayKey | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s.length < 3) return null;
  return DAY_KEYS.find((d) => d === s || d.startsWith(s.slice(0, 3))) ?? null;
}
export function normalizeBlock(v: unknown): BlockId | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if ((BLOCK_IDS as string[]).includes(s)) return s as BlockId;
  if (s === "night" || s === "evenings") return "evening";
  if (s === "mornings") return "morning";
  if (s === "afternoons") return "afternoon";
  if (s === "overnights") return "overnight";
  return null;
}

export interface GridPatch {
  /** Replace these days entirely (a day → its blocks; [] clears the day). The modal's whole-column tap. */
  set?: Partial<Record<string, string[] | "all">>;
  /** Add blocks to these days (single-cell taps on). */
  add?: Partial<Record<string, string[] | "all">>;
  /** Remove blocks from these days ([] or "all" = clear the day) (single-cell taps off). */
  remove?: Partial<Record<string, string[] | "all">>;
}

/** Apply taps to a copy of the grid. Unknown day names are reported, never guessed. */
export function applyGridPatch(current: Grid, patch: GridPatch): { grid: Grid; unknownDays: string[] } {
  const grid = emptyGrid();
  for (const d of DAY_KEYS) grid[d] = [...(current[d] ?? [])];
  const unknownDays: string[] = [];
  const blocksOf = (v: unknown): BlockId[] => {
    if (v === "all") return [...BLOCK_IDS];
    if (!Array.isArray(v)) return [];
    if (v.some((x) => String(x).toLowerCase() === "all")) return [...BLOCK_IDS];
    return orderBlocks(v.map(normalizeBlock).filter((b): b is BlockId => !!b));
  };
  for (const [rawDay, v] of Object.entries(patch.set ?? {})) {
    const day = normalizeDay(rawDay); if (!day) { unknownDays.push(rawDay); continue; }
    grid[day] = blocksOf(v);
  }
  for (const [rawDay, v] of Object.entries(patch.add ?? {})) {
    const day = normalizeDay(rawDay); if (!day) { unknownDays.push(rawDay); continue; }
    grid[day] = orderBlocks([...grid[day], ...blocksOf(v)]);
  }
  for (const [rawDay, v] of Object.entries(patch.remove ?? {})) {
    const day = normalizeDay(rawDay); if (!day) { unknownDays.push(rawDay); continue; }
    const drop = new Set<BlockId>(v === "all" || (Array.isArray(v) && v.length === 0) ? BLOCK_IDS : blocksOf(v));
    grid[day] = grid[day].filter((b) => !drop.has(b));
  }
  return { grid, unknownDays };
}

/** The grid as the modal reads: one line per day, Sun → Sat, "—" for none. */
export function gridText(grid: Grid): string {
  return DAY_KEYS.map((d) => `${DAY_LABEL[d]}: ${grid[d].length ? grid[d].map((b) => BLOCK_LABEL[b]).join(", ") : "—"}`).join("\n");
}
/** One day's blocks as the calendar's "Available" shading label, e.g. "Morning, Afternoon". */
export function dayBlocksLabel(grid: Grid, day: DayKey): string {
  return grid[day].length ? grid[day].map((b) => BLOCK_LABEL[b]).join(", ") : "";
}
export function gridsEqual(a: Grid, b: Grid): boolean {
  return DAY_KEYS.every((d) => a[d].join("|") === b[d].join("|"));
}
/** "Morning (6am – 12pm), Afternoon (12pm – 6pm), …" — the modal's row labels, for a question. */
export const BLOCK_CHOICES = BLOCK_IDS.map((b) => `${BLOCK_LABEL[b]} (${BLOCK_HOURS[b]})`).join(", ");
