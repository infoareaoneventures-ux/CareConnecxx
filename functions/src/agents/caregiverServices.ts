// Canonical caregiver care-services vocabulary + a save-time canonicalizer.
//
// The webapp caregiver profile renders Care Services as fixed checkboxes and
// checks a box ONLY when profile.services|skills contains the EXACT canonical
// string (components/caregiver/signup/constants.ts PRIMARY_SERVICES /
// ADDITIONAL_SERVICES). Evia collects specialties as free text ("dementia",
// "cooking", "I help with bathing"), so without a mapping step a caregiver's
// real skills never light the boxes, and — because the matching engine, job
// notifications, and client cards all read the same skills field — never reach
// families either.
//
// canonicalizeCaregiverServices maps whatever the caregiver said onto the exact
// enum. This is NOT intent parsing of raw SMS (that stays in the collection
// handlers): it canonicalizes an ALREADY-EXTRACTED specialties list into a
// constrained enum — the same class as normalizeOnboardingFieldValue's jobType
// clamp, and it routes through parseWithClaude per the mandatory LLM rule.
//
// The raw specialties list is always preserved separately (profile flavor);
// only skills/services carry the canonical strings.

import { parseWithClaude } from "../utils/parseWithClaude";

// MUST stay byte-identical to components/caregiver/signup/constants.ts.
// A parity test (caregiverServices.test.ts) guards the values.
export const PRIMARY_SERVICES = [
  "Mobility Assistance",
  "Dementia / Memory Care",
  "Medication Reminders",
  "Personal Care",
  "Companionship",
  "Transportation",
  "Meal Preparation",
  "Light Housekeeping",
] as const;

export const ADDITIONAL_SERVICES = [
  "Hospice Care",
  "Post-Surgery Recovery",
  "Incontinence Care",
  "Fall Risk Management",
  "Diabetes Management",
  "Physical Therapy Support",
] as const;

export const CANONICAL_SERVICES: readonly string[] = [
  ...PRIMARY_SERVICES,
  ...ADDITIONAL_SERVICES,
];

const CANONICAL_SET = new Set(CANONICAL_SERVICES);

// A few high-confidence direct hits so the common answers never depend on the
// LLM round-trip (and so canonicalization still produces something useful if the
// model call fails). Keyed on lowercased raw text; value is a canonical string.
// This is exact-token normalization, not intent parsing.
const DIRECT_HITS: Record<string, string> = {
  "companionship": "Companionship",
  "companion": "Companionship",
  "companion care": "Companionship",
  "dementia": "Dementia / Memory Care",
  "dementia care": "Dementia / Memory Care",
  "memory care": "Dementia / Memory Care",
  "alzheimer": "Dementia / Memory Care",
  "alzheimers": "Dementia / Memory Care",
  "alzheimer's": "Dementia / Memory Care",
  "mobility": "Mobility Assistance",
  "mobility assistance": "Mobility Assistance",
  "transfers": "Mobility Assistance",
  "medication": "Medication Reminders",
  "medication reminders": "Medication Reminders",
  "meds": "Medication Reminders",
  "med reminders": "Medication Reminders",
  "personal care": "Personal Care",
  "bathing": "Personal Care",
  "dressing": "Personal Care",
  "grooming": "Personal Care",
  "hygiene": "Personal Care",
  "transportation": "Transportation",
  "driving": "Transportation",
  "errands": "Transportation",
  "meal prep": "Meal Preparation",
  "meal preparation": "Meal Preparation",
  "meals": "Meal Preparation",
  "cooking": "Meal Preparation",
  "light housekeeping": "Light Housekeeping",
  "housekeeping": "Light Housekeeping",
  "cleaning": "Light Housekeeping",
  "laundry": "Light Housekeeping",
  "hospice": "Hospice Care",
  "hospice care": "Hospice Care",
  "post-surgery": "Post-Surgery Recovery",
  "post surgery": "Post-Surgery Recovery",
  "post-op": "Post-Surgery Recovery",
  "recovery": "Post-Surgery Recovery",
  "incontinence": "Incontinence Care",
  "incontinence care": "Incontinence Care",
  "fall risk": "Fall Risk Management",
  "fall prevention": "Fall Risk Management",
  "diabetes": "Diabetes Management",
  "diabetic care": "Diabetes Management",
  "diabetes management": "Diabetes Management",
  "physical therapy": "Physical Therapy Support",
  "pt support": "Physical Therapy Support",
};

function cleanRaw(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
}

// Dedupe to canonical strings, returned in the canonical enum order (stable,
// and consistent with the backfill migration's ordering).
function orderedUnique(values: string[]): string[] {
  const present = new Set(values.filter((v) => CANONICAL_SET.has(v)));
  return CANONICAL_SERVICES.filter((s) => present.has(s));
}

/**
 * Map a caregiver's free-text specialties onto the canonical service enum the
 * webapp checkboxes and the matching engine read.
 *
 * Returns canonical strings only (a subset of CANONICAL_SERVICES), deduped and
 * in canonical order. Returns [] when nothing maps or the model call fails —
 * the caller then leaves skills untouched rather than persisting non-canonical
 * values that would never light a box.
 */
export async function canonicalizeCaregiverServices(
  rawSpecialties: unknown,
): Promise<string[]> {
  const raw = cleanRaw(rawSpecialties);
  if (!raw.length) return [];

  // Deterministic direct hits first (cheap, offline-safe).
  const direct: string[] = [];
  for (const term of raw) {
    const hit = DIRECT_HITS[term.toLowerCase().trim()];
    if (hit) direct.push(hit);
    // Already-canonical values pass straight through.
    if (CANONICAL_SET.has(term)) direct.push(term);
  }

  const enumList = CANONICAL_SERVICES.map((s) => `"${s}"`).join(", ");
  const rawText = raw.join("; ");

  const reply = await parseWithClaude(
    "You map a caregiver's described care specialties onto a FIXED list of service categories. " +
      `The ONLY allowed values are: [${enumList}]. ` +
      "Return a JSON array containing every category the caregiver's specialties clearly fit — " +
      "use ONLY exact strings from the allowed list, no others, no explanations. " +
      "Map synonyms (e.g. 'cooking' → 'Meal Preparation', 'driving' → 'Transportation', " +
      "'bathing/dressing' → 'Personal Care', 'alzheimer' → 'Dementia / Memory Care'). " +
      "A single specialty may map to more than one category, and several specialties may map to one. " +
      "Omit anything that does not clearly fit. Reply with raw JSON only, e.g. [\"Companionship\"].",
    rawText,
  ).catch(() => "__parse_error__");

  let fromModel: string[] = [];
  if (reply && reply !== "__parse_error__") {
    try {
      const parsed = JSON.parse(reply);
      if (Array.isArray(parsed)) {
        fromModel = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      /* fall back to direct hits below */
    }
  }

  return orderedUnique([...direct, ...fromModel]);
}
