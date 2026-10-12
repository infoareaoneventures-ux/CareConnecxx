// Founder decision 2026-10-12: the people who give care are "care providers" in
// everything a person reads. Code identifiers, Firestore fields, step names,
// tool names and the userType value keep the legacy "caregiver" spelling (same
// precedent as the Cara → Evia rebrand: only user-facing text changed).
//
// This one sentence is appended to every prompt that writes text a family or a
// care provider will read; safety/linter.ts enforceCareProviderTerm backs it up
// on model-written replies.
export const CARE_PROVIDER_TERM_RULE =
  'WORDING (non-negotiable): say "care provider" / "care providers" — never "caregiver" or "caregivers" — in everything you write.';
