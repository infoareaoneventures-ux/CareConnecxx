import { describe, it, expect } from "vitest";
import {
  deriveWeeklyAvailability,
  normalizeAvailabilityInput,
  normalizeDays,
  parseHoursToSlots,
  describeWeeklyAvailability,
} from "../caregiverAvailability";

// Canonical block slots Evia must emit (must equal the webapp's BLOCK_TO_TIMESLOT
// so weeklySlotsToBl lights exactly one block each and the matcher keeps them).
const MORNING = { start: "06:00", end: "12:00" };
const AFTERNOON = { start: "12:00", end: "18:00" };
const EVENING = { start: "18:00", end: "23:00" };
const OVERNIGHT = { start: "23:00", end: "23:59" };

// Mirror of services/availabilityService.ts weeklySlotsToBl block detection —
// inlined (that file is frontend-only and imports firebase). This proves the
// emitted slots round-trip to the intended grid blocks.
function slotsToBlocks(slots: Array<{ start: string; end: string }>): string[] {
  const mins = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const windows: Record<string, { s: number; e: number }> = {
    morning: { s: 360, e: 720 },
    afternoon: { s: 720, e: 1080 },
    evening: { s: 1080, e: 1380 },
    overnight: { s: 1380, e: 1440 },
  };
  const active = new Set<string>();
  for (const slot of slots) {
    const s = mins(slot.start);
    const eRaw = mins(slot.end);
    const e = eRaw <= s ? eRaw + 1440 : eRaw;
    for (const [b, r] of Object.entries(windows)) {
      if (s < r.e && e > r.s) active.add(b);
    }
  }
  return ["morning", "afternoon", "evening", "overnight"].filter((b) => active.has(b));
}

describe("parseHoursToSlots — snaps to webapp block boundaries", () => {
  it("snaps a daytime clock range wide to the blocks it overlaps (9-5 → morning+afternoon)", () => {
    expect(parseHoursToSlots("9am-5pm")).toEqual([MORNING, AFTERNOON]);
    expect(parseHoursToSlots("9-5")).toEqual([MORNING, AFTERNOON]);
    expect(parseHoursToSlots("9:30am to 2pm")).toEqual([MORNING, AFTERNOON]);
  });
  it("maps keyword blocks to their canonical slot", () => {
    expect(parseHoursToSlots("mornings")).toEqual([MORNING]);
    expect(parseHoursToSlots("mornings and evenings")).toEqual([MORNING, EVENING]);
    expect(parseHoursToSlots("overnight")).toEqual([OVERNIGHT]);
  });
  it("handles a cross-midnight PM→AM range (10pm-6am → evening+overnight)", () => {
    expect(parseHoursToSlots("10pm-6am")).toEqual([EVENING, OVERNIGHT]);
  });
  it("treats flexible/anytime as all four blocks", () => {
    expect(parseHoursToSlots("flexible")).toEqual([MORNING, AFTERNOON, EVENING, OVERNIGHT]);
    expect(parseHoursToSlots("24/7")).toEqual([MORNING, AFTERNOON, EVENING, OVERNIGHT]);
  });
  it("falls back to morning+afternoon on junk", () => {
    expect(parseHoursToSlots("")).toEqual([MORNING, AFTERNOON]);
    expect(parseHoursToSlots("depends on the week")).toEqual([MORNING, AFTERNOON]);
  });
});

describe("emitted slots round-trip to the intended grid blocks", () => {
  it("each block slot lights exactly its own block in weeklySlotsToBl", () => {
    expect(slotsToBlocks([MORNING])).toEqual(["morning"]);
    expect(slotsToBlocks([AFTERNOON])).toEqual(["afternoon"]);
    expect(slotsToBlocks([EVENING])).toEqual(["evening"]);
    expect(slotsToBlocks([OVERNIGHT])).toEqual(["overnight"]);
  });
  it("9-5 lights morning+afternoon (and nothing else)", () => {
    expect(slotsToBlocks(parseHoursToSlots("9am-5pm"))).toEqual(["morning", "afternoon"]);
  });
  it("flexible lights all four blocks", () => {
    expect(slotsToBlocks(parseHoursToSlots("flexible"))).toEqual([
      "morning", "afternoon", "evening", "overnight",
    ]);
  });
});

describe("normalizeDays", () => {
  it("normalizes full day names", () => {
    expect(normalizeDays(["Monday", "Wednesday"])).toEqual(["monday", "wednesday"]);
  });
  it("expands weekdays / weekends / every day", () => {
    expect(normalizeDays(["weekdays"])).toEqual([
      "monday", "tuesday", "wednesday", "thursday", "friday",
    ]);
    expect(normalizeDays(["Weekends"])).toEqual(["saturday", "sunday"]);
    expect(normalizeDays(["every day"])).toHaveLength(7);
    expect(normalizeDays(["daily"])).toHaveLength(7);
  });
  it("matches 3-letter abbreviations", () => {
    expect(normalizeDays(["Mon", "Tue", "sat"])).toEqual(["monday", "tuesday", "saturday"]);
  });
  it("returns [] for non-arrays and junk", () => {
    expect(normalizeDays(undefined)).toEqual([]);
    expect(normalizeDays("Monday")).toEqual([]);
    expect(normalizeDays([42])).toEqual([]);
  });
});

describe("deriveWeeklyAvailability", () => {
  it("builds a block-aligned map for each day", () => {
    expect(
      deriveWeeklyAvailability({ days: ["Monday", "Tuesday"], hours: "9am-5pm" }),
    ).toEqual({
      monday: [MORNING, AFTERNOON],
      tuesday: [MORNING, AFTERNOON],
    });
  });
  it("returns undefined only when there is no usable signal at all", () => {
    expect(deriveWeeklyAvailability(undefined)).toBeUndefined();
    expect(deriveWeeklyAvailability("")).toBeUndefined();
    expect(deriveWeeklyAvailability("   ")).toBeUndefined();
    expect(deriveWeeklyAvailability({ days: [], hours: "" })).toBeUndefined();
    expect(deriveWeeklyAvailability([])).toBeUndefined();
    expect(deriveWeeklyAvailability(42)).toBeUndefined();
  });
  it("defaults to morning+afternoon when hours unparseable but days known", () => {
    expect(deriveWeeklyAvailability({ days: ["Friday"], hours: "varies" })).toEqual({
      friday: [MORNING, AFTERNOON],
    });
  });
  it("defaults to all 7 days when hours are stated but days are not", () => {
    const map = deriveWeeklyAvailability({ days: [], hours: "9-5" });
    expect(Object.keys(map!)).toHaveLength(7);
    expect(map!.monday).toEqual([MORNING, AFTERNOON]);
    expect(map!.sunday).toEqual([MORNING, AFTERNOON]);
  });
  // The prod regression (2026-07-11): the model saved the caregiver's words
  // verbatim as a plain string, and derivation used to bail on strings — the
  // webapp grid then never updated.
  it("parses a plain string: time-of-day words with no days → all 7 days", () => {
    const map = deriveWeeklyAvailability("mornings and evenings");
    expect(Object.keys(map!)).toHaveLength(7);
    expect(map!.monday).toEqual([MORNING, EVENING]);
    expect(map!.sunday).toEqual([MORNING, EVENING]);
  });
  it("parses a plain string with day tokens", () => {
    expect(deriveWeeklyAvailability("weekends 9am-5pm")).toEqual({
      saturday: [MORNING, AFTERNOON],
      sunday: [MORNING, AFTERNOON],
    });
  });
  it("parses a day-name array (update_caregiver_availability legacy shape)", () => {
    const map = deriveWeeklyAvailability(["Monday", "Wednesday"]);
    expect(map).toEqual({
      monday: [MORNING, AFTERNOON],
      wednesday: [MORNING, AFTERNOON],
    });
    expect(deriveWeeklyAvailability(["not a day"])).toBeUndefined();
  });
});

describe("normalizeAvailabilityInput — save-time shape coercion", () => {
  // Injectable LLM stubs (repo pattern: inject, don't vi.mock — a mocked
  // rejected promise trips vitest's unhandled-rejection tracker).
  const llmNever = async (): Promise<string> => { throw new Error("LLM must not be called for structured input"); };
  const llmDown = async (): Promise<string> => { throw new Error("down"); };

  it("cleans an already-canonical object without calling the LLM", async () => {
    await expect(normalizeAvailabilityInput({ days: [" Monday ", ""], hours: " 9-5 " }, llmNever))
      .resolves.toEqual({ days: ["Monday"], hours: "9-5" });
  });
  it("turns a day array into {days, hours:''}", async () => {
    await expect(normalizeAvailabilityInput(["Monday", "Friday"], llmNever))
      .resolves.toEqual({ days: ["Monday", "Friday"], hours: "" });
  });
  it("LLM-parses free text into the canonical object", async () => {
    const llm = async () => '{"days":["every day"],"hours":"mornings and evenings"}';
    await expect(normalizeAvailabilityInput("every day, mornings and evenings", llm))
      .resolves.toEqual({ days: ["every day"], hours: "mornings and evenings" });
  });
  it("keeps days EMPTY when the LLM returns only hours — never fabricates 'every day' (2026-09-26)", async () => {
    const llm = async () => '{"hours":"9am-5pm"}';
    await expect(normalizeAvailabilityInput("9 to 5", llm))
      .resolves.toEqual({ days: [], hours: "9am-5pm" });
  });
  it("falls back to raw text in both fields when the LLM fails", async () => {
    await expect(normalizeAvailabilityInput("weekends only", llmDown))
      .resolves.toEqual({ days: ["weekends only"], hours: "weekends only" });
  });
  it("returns undefined for empty/unusable input", async () => {
    await expect(normalizeAvailabilityInput("", llmNever)).resolves.toBeUndefined();
    await expect(normalizeAvailabilityInput({ days: [], hours: "" }, llmNever)).resolves.toBeUndefined();
    await expect(normalizeAvailabilityInput([], llmNever)).resolves.toBeUndefined();
    await expect(normalizeAvailabilityInput(undefined, llmNever)).resolves.toBeUndefined();
  });
  it("fallback output derives a usable weekly map end-to-end", async () => {
    const canonical = await normalizeAvailabilityInput("mornings and evenings", llmDown);
    const map = deriveWeeklyAvailability(canonical);
    expect(Object.keys(map!)).toHaveLength(7);
    expect(map!.tuesday).toEqual([MORNING, EVENING]);
  });
});

describe("describeWeeklyAvailability — the spoken echo", () => {
  it("summarizes weekday mornings+afternoons in plain words", () => {
    const map = deriveWeeklyAvailability({
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      hours: "9-5",
    });
    expect(describeWeeklyAvailability(map)).toBe("weekdays mornings and afternoons");
  });
  it("summarizes a single day + single block", () => {
    const map = deriveWeeklyAvailability({ days: ["Saturday"], hours: "evenings" });
    expect(describeWeeklyAvailability(map)).toBe("Saturday evenings");
  });
  it("returns empty string for an empty map", () => {
    expect(describeWeeklyAvailability(undefined)).toBe("");
    expect(describeWeeklyAvailability({})).toBe("");
  });
});
