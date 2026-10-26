// The family's care needs — the website's "What type of care is needed?" step:
// the SAME eight categories the caregiver side offers (caregiverServiceLabels.ts),
// shown by name, and nothing underneath.
//
// 2026-10-04 (founder: align the family side with the caregiver side): the
// sub-task chips that used to sit under each category (careNeedDetails —
// Bathing, Breakfast, Morning…) are gone from every family screen (post-job,
// Care Plan, Send Booking) and from every Evia writer. "Bathing" lands on
// Personal Care and nothing else is stored. The field stays in the record
// shape, always {}, so older records and every reader keep working.
//
// The family's words go through the one mapper both sides share
// (mapCaregiverServices): names or their own words → the eight; medical care
// (administering medication, injections, wound care…) is never a need here;
// anything that fits none of the eight is not saved and the family is told.

import {
  mapCaregiverServices,
  CANONICAL_SERVICES,
  serviceLabel,
  serviceFromNameOrLabel,
} from "./caregiverServices";

export const CARE_NEED_CATEGORIES: readonly string[] = CANONICAL_SERVICES;

export interface CanonicalCareNeeds {
  /** Main categories, in menu order — the site's careNeeds array. */
  careNeeds: string[];
  /** Always {} since 2026-10-04 — kept for the record shape the site reads. */
  careNeedDetails: Record<string, string[]>;
  /** Hands-on medical care the family named — never a care need here. */
  medical: string[];
  /** Words that fit none of the eight — not saved. */
  unmapped: string[];
  /** Words the mapper could not judge (model failure) — ask by name, never guess. */
  unresolved: string[];
}

/** True when every term is already a category name (or its shown label). */
export function isCanonicalCareNeeds(terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => serviceFromNameOrLabel(t) !== null);
}

/**
 * Map the family's words ("bathing", "help with meals", "someone to keep her
 * company") onto the site's eight categories. Exact names never hit the model;
 * anything else is sorted by the shared mapper and validated against the
 * eight (an invented label is dropped, never stored).
 */
export async function canonicalizeCareNeeds(terms: unknown, opts: { kinds?: readonly string[] } = {}): Promise<CanonicalCareNeeds> {
  const m = await mapCaregiverServices(terms, opts);
  return { careNeeds: m.matched, careNeedDetails: {}, medical: m.medical, unmapped: m.unmapped, unresolved: m.unresolved };
}

/** "Medication Reminders Only, Personal Care" — the categories by their shown names. */
export function describeCareNeeds(careNeeds: readonly string[]): string {
  return careNeeds.map(serviceLabel).join(", ");
}
