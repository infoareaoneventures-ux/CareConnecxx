import { quickComplete } from "../utils/openaiClient";

// The website's care-needs taxonomy — components/CarePlan.tsx CARE_NEED_SUBS
// and components/client/postJob/Step3CareNeeds.tsx carry the identical map:
// main categories (what recipientPlans[key].careNeeds / job_postings.careNeeds
// hold) and each category's sub-tasks (recipientPlans[key].careNeedDetails).
// Evia used to store the family's free words ("bathing") as a care need, so
// the Care Plan page showed a chip the site itself never produces (live
// 2026-09-20: "bathing" instead of Personal Care › Bathing). Everything Evia
// writes now goes through canonicalizeCareNeeds. careNeedsTaxonomy.test.ts
// checks this map against the site file so the two can't drift.
export const CARE_NEED_SUBS: Record<string, string[]> = {
  "Mobility Assistance": ["Ambulation", "Transfer Assist"],
  "Dementia / Memory Care": ["Supervision / Safety monitoring", "Memory support", "Redirection / cueing"],
  "Medication Reminders": ["Morning", "Afternoon", "Evening", "Bedtime"],
  "Personal Care": ["Bathing", "Dressing Assistance", "Toileting", "Feeding", "Comb Hair", "Oral Hygiene", "Skin Care", "Physical Activity"],
  "Companionship": [],
  "Transportation": ["Doctor appointments", "Grocery shopping", "Pharmacy visits", "Hairdresser / barber"],
  "Meal Preparation": ["Breakfast", "Lunch", "Snack", "Dinner"],
  "Light Housekeeping": ["Light housekeeping (dusting, vacuuming, mopping)", "Change bed linens", "Change bath towels", "Take out trash"],
};

export const CARE_NEED_CATEGORIES: readonly string[] = Object.keys(CARE_NEED_SUBS);

export interface CanonicalCareNeeds {
  /** Main categories, in taxonomy order — the site's careNeeds array. */
  careNeeds: string[];
  /** Sub-tasks per category — the site's careNeedDetails map (only categories with picks). */
  careNeedDetails: Record<string, string[]>;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Exact (case-insensitive) matches against category / sub-task names — no interpretation. */
function matchExact(term: string): { category: string; sub?: string } | null {
  const t = norm(term);
  for (const [cat, subs] of Object.entries(CARE_NEED_SUBS)) {
    if (norm(cat) === t) return { category: cat };
    const sub = subs.find((s) => norm(s) === t);
    if (sub) return { category: cat, sub };
  }
  return null;
}

function assemble(picks: Array<{ category: string; sub?: string }>): CanonicalCareNeeds {
  const details: Record<string, string[]> = {};
  const cats = new Set<string>();
  for (const p of picks) {
    if (!CARE_NEED_SUBS[p.category]) continue;
    cats.add(p.category);
    if (p.sub && CARE_NEED_SUBS[p.category].includes(p.sub)) {
      details[p.category] = [...new Set([...(details[p.category] ?? []), p.sub])];
    }
  }
  return {
    careNeeds: CARE_NEED_CATEGORIES.filter((c) => cats.has(c)),
    careNeedDetails: details,
  };
}

/** True when every term is already a category or sub-task name. */
export function isCanonicalCareNeeds(terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => matchExact(t) !== null);
}

/**
 * Map the family's words ("bathing", "help with meals", "someone to keep her
 * company") onto the site's categories + sub-tasks. Exact names never hit the
 * model; anything else is classified against the fixed list and the result is
 * validated against it (an invented label is dropped, never stored). Terms the
 * model cannot place are kept as their own category-less note in `unmapped`
 * so nothing the family said is silently lost.
 */
export async function canonicalizeCareNeeds(
  terms: string[],
  complete: (system: string, user: string) => Promise<string> = (s, u) => quickComplete(s, u, { maxTokens: 300 }),
): Promise<CanonicalCareNeeds & { unmapped: string[] }> {
  const clean = [...new Set(terms.map((t) => String(t ?? "").trim()).filter(Boolean))];
  const picks: Array<{ category: string; sub?: string }> = [];
  const unresolved: string[] = [];
  for (const t of clean) {
    const m = matchExact(t);
    if (m) picks.push(m); else unresolved.push(t);
  }
  const unmapped: string[] = [];
  if (unresolved.length) {
    const taxonomy = Object.entries(CARE_NEED_SUBS)
      .map(([cat, subs]) => `${cat}${subs.length ? `: ${subs.join(" | ")}` : ""}`)
      .join("\n");
    const raw = await complete(
      "You map a family's plain-English care needs onto a FIXED taxonomy of care categories and sub-tasks. " +
      "Taxonomy (category: sub-tasks):\n" + taxonomy + "\n\n" +
      "For EACH input term return the best category and, when the term names a specific task, the matching sub-task. " +
      "Use ONLY names from the taxonomy, spelled exactly. If a term fits no category at all, return null for it. " +
      "Reply with raw JSON only: {\"<term>\": {\"category\": \"...\", \"sub\": \"...\" | null} | null, ...}",
      JSON.stringify(unresolved),
    ).catch(() => "{}");
    let parsed: Record<string, { category?: string; sub?: string | null } | null> = {};
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { parsed = {}; }
    for (const t of unresolved) {
      const p = parsed[t];
      const cat = p?.category && CARE_NEED_SUBS[p.category] ? p.category : null;
      if (!cat) { unmapped.push(t); continue; }
      const sub = p?.sub && CARE_NEED_SUBS[cat].includes(p.sub) ? p.sub : undefined;
      picks.push({ category: cat, sub });
    }
  }
  return { ...assemble(picks), unmapped };
}

/** "Personal Care (Bathing), Companionship" — how the summary reads a canonical set. */
export function describeCareNeeds(careNeeds: string[], details: Record<string, string[]> | undefined): string {
  return careNeeds.map((c) => {
    const subs = details?.[c] ?? [];
    return subs.length ? `${c} (${subs.join(", ")})` : c;
  }).join(", ");
}
