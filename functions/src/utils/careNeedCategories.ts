/**
 * The 8 canonical care-need categories, matching the web wizard's CARE_TYPES
 * (components/client/postJob/types.ts) exactly — same strings, same casing.
 * Every place Evia collects care needs over SMS must resolve to these, not
 * fine-grained sub-tasks ("bathing") or near-miss variants ("Memory Care") —
 * caregiver profiles are tagged at this category granularity, and the web
 * Care Plan page renders `careNeeds` as the parent category with sub-tasks
 * nested under it (see CarePlan.tsx) — a fine-grained term stored directly in
 * careNeeds has no parent to nest under, and never matches a caregiver's
 * skills during search (both symptoms traced to this one root cause, 2026-09-11).
 */
export const CANONICAL_CARE_CATEGORIES = [
  "Mobility Assistance",
  "Dementia / Memory Care",
  "Medication Reminders",
  "Personal Care",
  "Companionship",
  "Transportation",
  "Meal Preparation",
  "Light Housekeeping",
] as const;

export type CanonicalCareCategory = typeof CANONICAL_CARE_CATEGORIES[number];

// Keyword/synonym → canonical category. Covers near-miss category variants an
// LLM might return instead of the exact canonical string, AND the
// fine-grained sub-tasks/symptoms a family is more likely to actually type
// ("bathing", "her meds") than the category name itself. Checked as
// substrings against the lowercased raw term, in this order — first match
// wins, so put more specific keywords before generic ones.
const SYNONYM_MAP: Array<{ keywords: string[]; category: CanonicalCareCategory }> = [
  {
    category: "Dementia / Memory Care",
    keywords: ["dementia", "memory", "alzheimer", "cognitive"],
  },
  {
    category: "Mobility Assistance",
    keywords: ["mobility", "walking", "transfer", "fall prevention", "ambulation", "wheelchair"],
  },
  {
    category: "Medication Reminders",
    keywords: ["medication", "med reminder", "meds", "pill", "prescription"],
  },
  {
    category: "Personal Care",
    keywords: ["personal care", "bathing", "groom", "hygiene", "dressing", "toileting", "feeding", "oral"],
  },
  {
    category: "Meal Preparation",
    keywords: ["meal", "cooking", "nutrition", "food", "breakfast", "lunch", "dinner"],
  },
  {
    category: "Transportation",
    keywords: ["transport", "driving", "errand", "appointment", "pharmacy visit", "grocery"],
  },
  {
    category: "Companionship",
    keywords: ["companion", "social", "conversation", "activities"],
  },
  {
    category: "Light Housekeeping",
    keywords: ["housekeeping", "cleaning", "laundry", "tidying", "chores"],
  },
];

/**
 * Maps a raw care-need term (however an LLM extraction phrased it) onto its
 * canonical category, or null if nothing matches. Exact canonical matches
 * (case-insensitive) short-circuit first.
 */
export function toCanonicalCareCategory(raw: string): CanonicalCareCategory | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const exact = CANONICAL_CARE_CATEGORIES.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;

  for (const { keywords, category } of SYNONYM_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return null;
}

/**
 * Normalizes a raw array of LLM-extracted care-need terms into the canonical
 * category set — deduplicated, unrecognized terms dropped (they can't be
 * displayed with a parent category or matched against caregiver skills
 * anyway, so keeping them as-is only reintroduces the original bug).
 */
export function normalizeCareNeeds(raw: string[]): CanonicalCareCategory[] {
  const seen = new Set<CanonicalCareCategory>();
  for (const term of raw) {
    if (typeof term !== "string") continue;
    const mapped = toCanonicalCareCategory(term);
    if (mapped) seen.add(mapped);
  }
  return [...seen];
}
