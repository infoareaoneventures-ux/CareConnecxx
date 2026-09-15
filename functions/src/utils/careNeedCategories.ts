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

/**
 * The specific sub-tasks the web Care Plan page offers WITHIN each category
 * (components/CarePlan.tsx's own CARE_NEED_SUBS — same strings, same casing,
 * kept in sync manually since that file isn't importable from functions/).
 * A recipient's `careNeedDetails[category]` must use these EXACT strings —
 * the site's own edit UI highlights a sub-task chip by checking
 * `selectedSubs.includes(sub)` against this same list, so a near-miss string
 * would save but never show as selected.
 */
export const CARE_NEED_SUBTASKS: Record<CanonicalCareCategory, string[]> = {
  "Mobility Assistance": ["Ambulation", "Transfer Assist"],
  "Dementia / Memory Care": ["Supervision / Safety monitoring", "Memory support", "Redirection / cueing"],
  "Medication Reminders": ["Morning", "Afternoon", "Evening", "Bedtime"],
  "Personal Care": ["Bathing", "Dressing Assistance", "Toileting", "Feeding", "Comb Hair", "Oral Hygiene", "Skin Care", "Physical Activity"],
  "Companionship": [],
  "Transportation": ["Doctor appointments", "Grocery shopping", "Pharmacy visits", "Hairdresser / barber"],
  "Meal Preparation": ["Breakfast", "Lunch", "Snack", "Dinner"],
  "Light Housekeeping": ["Light housekeeping (dusting, vacuuming, mopping)", "Change bed linens", "Change bath towels", "Take out trash"],
};

// Significant words of a sub-task phrase to check for individually (a family
// says "dressing help", never the full canonical "Dressing Assistance") —
// short/generic words are dropped, INCLUDING ones that just repeat the
// category's own name ("care" in "Skin Care" would otherwise match on nearly
// any Personal Care mention at all, since the category itself is named
// "Personal Care").
function subtaskWords(sub: string, categoryLower: string): string[] {
  return sub.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !categoryLower.includes(w));
}

/**
 * Companion to normalizeCareNeeds: while that function collapses a raw term
 * ("bathing") onto its parent category ("Personal Care") for caregiver
 * matching and display grouping, this recovers the SPECIFIC sub-task(s)
 * within that category the family actually named, matching the website's
 * own two-level model (CarePlan.tsx's careNeeds + careNeedDetails) — a
 * fine-grained term collapsed to category-only loses real information the
 * site itself tracks and displays as sub-task chips under the category
 * (2026-09-14, live-caught: a family saying "bathing" correctly selected
 * "Personal Care" but left NO sub-task chip selected at all, unlike doing
 * the same thing on the site itself). A category is omitted from the result
 * entirely when no specific sub-task matched (e.g. a bare "personal care"
 * mention with nothing more specific stated) — same "don't invent" principle
 * as normalizeCareNeeds dropping an unrecognized term instead of guessing.
 */
export function extractCareNeedDetails(
  raw: string[], categories: CanonicalCareCategory[],
): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const category of categories) {
    const categoryLower = category.toLowerCase();
    const matched = new Set<string>();
    for (const sub of CARE_NEED_SUBTASKS[category] ?? []) {
      const subLower = sub.toLowerCase();
      const words = subtaskWords(sub, categoryLower);
      const hit = raw.some((term) => {
        if (typeof term !== "string") return false;
        const lower = term.trim().toLowerCase();
        if (!lower) return false;
        if (lower.includes(subLower)) return true;
        return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
      });
      if (hit) matched.add(sub);
    }
    if (matched.size) details[category] = [...matched];
  }
  return details;
}
