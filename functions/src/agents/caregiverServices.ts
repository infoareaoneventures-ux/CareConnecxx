// Caregiver care services — the save-time mapper behind Evia's services step.
//
// The website's step is "What services do you offer? Senior Care — select all
// that apply" with EXACTLY the eight PRIMARY_SERVICES (caregiverServiceLabels.ts),
// and the profile page checks a box ONLY when profile.services|skills holds the
// exact string. Over text the caregiver answers by name or in her own words
// ("bathing", "cooking", "I drive people to appointments"), so every answer is
// mapped onto the eight here before anything is written — the record never
// carries a word the site can't show.
//
// mapCaregiverServices sorts the caregiver's phrases three ways:
//   matched   — the services (exact PRIMARY_SERVICES strings) her words clearly describe
//   medical   — hands-on medical/nursing care (administering medication, injections,
//               insulin, wound care, vitals…) — NEVER a service here; the closest
//               the site offers is Medication Reminders (reminding, not giving)
//   unmapped  — fits none of the eight (hospice, gardening…) — not saved
//   unresolved — the model call failed, so these phrases could not be judged;
//               the caller asks the caregiver to pick by name instead of guessing
//
// This is NOT intent parsing of raw SMS (that stays in the agent loop): it maps an
// ALREADY-EXTRACTED list onto a constrained enum — the same class as
// normalizeOnboardingFieldValue's jobType clamp — and the open-ended part goes
// through parseWithClaude per the mandatory LLM rule. Direct hits cover the
// common single words offline (and keep working if the model call fails).

import { parseWithClaude } from "../utils/parseWithClaude";
import {
  PRIMARY_SERVICES,
  CANONICAL_SERVICES,
  SERVICE_DISPLAY_LABEL,
  SERVICE_LABELS,
  serviceLabel,
  serviceLabels,
  serviceMenuText,
  orderedCanonicalServices,
  serviceFromNameOrLabel,
} from "./caregiverServiceLabels";

export {
  PRIMARY_SERVICES,
  CANONICAL_SERVICES,
  SERVICE_DISPLAY_LABEL,
  SERVICE_LABELS,
  serviceLabel,
  serviceLabels,
  serviceMenuText,
  orderedCanonicalServices,
  serviceFromNameOrLabel,
};

// High-confidence single-word direct hits so the common answers never depend on
// the model round-trip. Keyed on lowercased raw text; value is a stored string.
// Exact-token normalization, not intent parsing. "medication"/"meds" alone mean
// reminders here (the only medication service the site has); any phrase about
// GIVING medication goes to the model, which files it under medical.
const DIRECT_HITS: Record<string, string> = {
  "companionship": "Companionship",
  "companion": "Companionship",
  "companion care": "Companionship",
  "company": "Companionship",
  "dementia": "Dementia / Memory Care",
  "dementia care": "Dementia / Memory Care",
  "memory care": "Dementia / Memory Care",
  "memory": "Dementia / Memory Care",
  "alzheimer": "Dementia / Memory Care",
  "alzheimers": "Dementia / Memory Care",
  "alzheimer's": "Dementia / Memory Care",
  "mobility": "Mobility Assistance",
  "mobility assistance": "Mobility Assistance",
  "mobility help": "Mobility Assistance",
  "transfers": "Mobility Assistance",
  "walking": "Mobility Assistance",
  "medication": "Medication Reminders",
  "medications": "Medication Reminders",
  "medication reminders": "Medication Reminders",
  "medication reminders only": "Medication Reminders",
  "meds": "Medication Reminders",
  "med reminders": "Medication Reminders",
  "pill reminders": "Medication Reminders",
  "reminders": "Medication Reminders",
  "personal care": "Personal Care",
  "bathing": "Personal Care",
  "dressing": "Personal Care",
  "grooming": "Personal Care",
  "hygiene": "Personal Care",
  "toileting": "Personal Care",
  "transportation": "Transportation",
  "transport": "Transportation",
  "driving": "Transportation",
  "rides": "Transportation",
  "errands": "Transportation",
  "meal prep": "Meal Preparation",
  "meal preparation": "Meal Preparation",
  "meals": "Meal Preparation",
  "cooking": "Meal Preparation",
  "light housekeeping": "Light Housekeeping",
  "housekeeping": "Light Housekeeping",
  "cleaning": "Light Housekeeping",
  "laundry": "Light Housekeeping",
};

function cleanRaw(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\n]+/) : [];
  return list
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
}

export interface ServiceMapping {
  matched: string[];
  medical: string[];
  unmapped: string[];
  unresolved: string[];
}

const EMPTY: ServiceMapping = { matched: [], medical: [], unmapped: [], unresolved: [] };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
}

/**
 * Sort a caregiver's words about the care she offers onto the website's eight
 * services. Never throws; never returns anything outside PRIMARY_SERVICES in
 * `matched`. See the header for the four buckets.
 */
export async function mapCaregiverServices(raw: unknown): Promise<ServiceMapping> {
  const terms = cleanRaw(raw);
  if (!terms.length) return { ...EMPTY };

  const direct = new Set<string>();
  const rest: string[] = [];
  for (const term of terms) {
    const exact = serviceFromNameOrLabel(term);
    const hit = exact ?? DIRECT_HITS[term.toLowerCase().trim()];
    if (hit) direct.add(hit);
    else rest.push(term);
  }
  if (!rest.length) return { ...EMPTY, matched: orderedCanonicalServices([...direct]) };

  const enumList = CANONICAL_SERVICES.map((s) => `"${s}"`).join(", ");
  const reply = await parseWithClaude(
    "You sort a caregiver's words about the care she offers into a FIXED list of eight services. " +
      `Allowed services (use these exact strings): [${enumList}]. ` +
      'Reply with raw JSON only: {"services": [allowed strings her words clearly describe], ' +
      '"medical": [her phrases that describe hands-on medical or nursing care], ' +
      '"unmapped": [her phrases that fit none of the eight and are not medical]}. ' +
      "Rules: bathing, dressing, toileting, grooming, hygiene → Personal Care. Cooking, meals, feeding → Meal Preparation. " +
      "Driving, rides, taking someone to appointments, errands by car → Transportation. Alzheimer's, memory loss, confusion → Dementia / Memory Care. " +
      "Walking, transfers, wheelchair, fall prevention → Mobility Assistance. Reminding someone to take their pills, pill reminders → Medication Reminders. " +
      "Keeping company, conversation, visits → Companionship. Laundry, cleaning, tidying, dishes → Light Housekeeping. " +
      "MEDICAL (never a service): administering or giving medication, injections, insulin, managing dosages, filling pill boxes, wound care, catheter care, vitals, therapy, nursing. " +
      '"All of them" / "everything on the list" → every allowed service. ' +
      "A phrase may fit more than one service; only CLEAR fits go in services — a vague phrase (\"help around the house\") goes in unmapped. No explanations.",
    rest.join("; "),
  ).catch(() => "__parse_error__");

  let services: string[] = [];
  let medical: string[] = [];
  let unmapped: string[] = [];
  let parsedOk = false;
  if (reply && reply !== "__parse_error__") {
    try {
      const parsed = JSON.parse(reply) as unknown;
      if (Array.isArray(parsed)) {
        // tolerate the older array shape
        services = strings(parsed);
        parsedOk = true;
      } else if (parsed && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        services = strings(o.services);
        medical = strings(o.medical);
        unmapped = strings(o.unmapped);
        parsedOk = true;
      }
    } catch {
      /* unresolved below */
    }
  }
  if (!parsedOk) {
    return { matched: orderedCanonicalServices([...direct]), medical: [], unmapped: [], unresolved: rest };
  }
  // Only exact allowed strings count; a hallucinated "Gardening" is dropped silently
  // (the caregiver's own phrase, if she said one, is already in unmapped).
  const matched = orderedCanonicalServices([...direct, ...services]);
  return { matched, medical, unmapped, unresolved: [] };
}

/**
 * The matched services only — kept for callers that just need the enum
 * (absorber, backfill). Returns [] when nothing maps or the model call fails.
 */
export async function canonicalizeCaregiverServices(rawSpecialties: unknown): Promise<string[]> {
  return (await mapCaregiverServices(rawSpecialties)).matched;
}
