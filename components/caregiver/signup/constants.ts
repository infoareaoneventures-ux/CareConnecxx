// Primary senior care services
export const PRIMARY_SERVICES = [
  'Mobility Assistance',
  'Dementia / Memory Care',
  'Medication Reminders',
  'Personal Care',
  'Companionship',
  'Transportation',
  'Meal Preparation',
  'Light Housekeeping',
] as const;

// Display label for a service wherever the eight are shown (wizard, profile
// chips, Find Caregivers filter, admin editor, Evia's texts). The STORED value
// stays the PRIMARY_SERVICES string; only Medication Reminders reads differently
// (founder 2026-10-04: reminders only — caregivers never administer medication).
// Mirrored byte-for-byte in functions/src/agents/caregiverServiceLabels.ts.
export const SERVICE_DISPLAY_LABEL: Record<string, string> = {
  'Medication Reminders': 'Medication Reminders Only',
};
export const serviceLabel = (name: string): string => SERVICE_DISPLAY_LABEL[name] ?? name;

// ── Care kinds (child care, 2026-10-18) ────────────────────────────────────
// ONE new fact on both doors: who the care is for. It lives on each care
// provider profile (`careKinds`, one or both) and on the family's household
// record (`job_postings/{uid}.careKinds`); a job post carries the kinds its
// ticked services imply (`job_posts.careKinds`). A MISSING field means
// ['senior'] everywhere — no backfill. Mirrored byte-for-byte in
// functions/src/agents/caregiverServiceLabels.ts (parity test).
export const CARE_KINDS = ['senior', 'child'] as const;
export type CareKind = (typeof CARE_KINDS)[number];
export const CARE_KIND_LABEL: Record<CareKind, string> = { senior: 'Senior care', child: 'Child care' };
export const DEFAULT_CARE_KINDS: readonly CareKind[] = ['senior'];

// The child-care eight (founder, 2026-10-18): plain names, nothing underneath,
// no age in a name (the age-range chips carry that). Transportation keeps the
// senior list's exact name on purpose — ticked once, it counts for both kinds
// and the driving-record rule carries over unchanged.
export const CHILD_SERVICES = [
  'Supervision',
  'Baby Care',
  'Bathing & Dressing',
  'Meals & Snacks',
  'Activities & Play',
  'School & Homework',
  'Transportation',
  'Tidying & Laundry',
] as const;

/** Every service name either list can store, senior order first, Transportation once. */
export const ALL_SERVICES: readonly string[] = [...PRIMARY_SERVICES, ...CHILD_SERVICES.filter((s) => !(PRIMARY_SERVICES as readonly string[]).includes(s))];

/** Normalize a stored/absent value to the kinds it means: missing or empty = ['senior']. */
export function normalizeCareKinds(value: unknown): CareKind[] {
  const arr = Array.isArray(value) ? value : [];
  const kinds = CARE_KINDS.filter((k) => arr.includes(k));
  return kinds.length ? kinds : [...DEFAULT_CARE_KINDS];
}

/** The list(s) a person sees for the kinds they picked, as [{ kind, services }] in senior-then-child order. */
export function serviceListsForKinds(value: unknown): Array<{ kind: CareKind; services: readonly string[] }> {
  const kinds = normalizeCareKinds(value);
  return [
    ...(kinds.includes('senior') ? [{ kind: 'senior' as CareKind, services: PRIMARY_SERVICES as readonly string[] }] : []),
    ...(kinds.includes('child') ? [{ kind: 'child' as CareKind, services: CHILD_SERVICES as readonly string[] }] : []),
  ];
}

/** The kinds a set of ticked services implies. Transportation alone implies nothing; `fallback` (the household's or provider's answer) decides then. */
export function kindsOfServices(services: readonly unknown[], fallback: unknown = undefined): CareKind[] {
  const names = services.filter((s): s is string => typeof s === 'string');
  const senior = names.some((s) => s !== 'Transportation' && (PRIMARY_SERVICES as readonly string[]).includes(s));
  const child = names.some((s) => s !== 'Transportation' && (CHILD_SERVICES as readonly string[]).includes(s));
  const kinds = CARE_KINDS.filter((k) => (k === 'senior' ? senior : child));
  return kinds.length ? kinds : normalizeCareKinds(fallback);
}

/** A care provider sees a post only when they offer EVERY kind the post needs. */
export function providerCoversPost(providerKinds: unknown, postKinds: unknown): boolean {
  const have = normalizeCareKinds(providerKinds);
  return normalizeCareKinds(postKinds).every((k) => have.includes(k));
}

/** A family sees a care provider who offers ANY kind the household needs. */
export function providerMatchesHousehold(providerKinds: unknown, householdKinds: unknown): boolean {
  const have = normalizeCareKinds(providerKinds);
  return normalizeCareKinds(householdKinds).some((k) => have.includes(k));
}

// Age ranges for a child — an informational chip beside pets / smoking, never a
// filter, never a number (the no-age rule stays for everyone else).
// Labels are STAGE words, never numbers (founder 2026-10-18): the stored ids stay.
export const AGE_RANGES = [
  { id: 'infant', label: 'Infant' },
  { id: 'toddler', label: 'Toddler' },
  { id: '3-5', label: 'Preschooler' },
  { id: '6-12', label: 'School-age' },
  { id: 'teen', label: 'Teen' },
] as const;
/** The heading over the stage chips, both doors. */
export const STAGE_HEADING = 'Stage';
export type AgeRangeId = (typeof AGE_RANGES)[number]['id'];
export const ageRangeLabel = (id: string): string => AGE_RANGES.find((a) => a.id === id)?.label ?? id;

// The relationship list, the same SIX on both doors (founder, 2026-10-18 late):
// 'Adult child' = a grown son or daughter — senior side; 'Child' = a minor —
// child side. Older stored values (Grandparent, Sibling, Spouse) still read back.
export const RELATIONSHIPS = ['Myself', 'Parent', 'Spouse or Partner', 'Adult child', 'Child', 'Other'] as const;

// The ONE care-type question, asked once at signup and changed in one place —
// the same sentence on both doors (founder 2026-10-18). Labels stay
// Senior care / Child care / Both. "Adult or a child" survives only in the
// follow-up for Other.
export const CARE_TYPE_QUESTION_FAMILY = 'What kind of care do you need?';
export const CARE_TYPE_QUESTION_PROVIDER = 'What kind of care do you provide?';
export const CARE_TYPE_OPTION_LABELS = ['Senior care', 'Child care', 'Both'] as const;
export const OTHER_KIND_QUESTION = 'Is this person an adult or a child?';
export const OTHER_KIND_OPTIONS = [{ value: 'senior', label: 'Adult' }, { value: 'child', label: 'Child' }] as const;

// ── Who decides a recipient's kind (founder, 2026-10-18 evening) ────────────
// The family picks the household's care type ONCE (signup / Account Settings:
// job_postings.careKinds). Everywhere else the RELATIONSHIP decides which list a
// recipient sees: Child → child; Myself / Parent / Spouse or Partner (and the
// older stored values) → senior; Other → the recipient's own stored `careKind`
// (a two-way pick shown only for Other in a Both household). No per-recipient
// control anywhere else.
export const CHILD_RELATIONSHIPS: readonly string[] = ['Child'];
export const AMBIGUOUS_RELATIONSHIPS: readonly string[] = ['Other'];

/** The kind a recipient belongs to, from their relationship (and, for Other, their stored careKind). */
export function recipientCareKind(relationship: unknown, careKind: unknown = undefined): CareKind {
  const rel = String(relationship ?? '').trim().toLowerCase();
  if (CHILD_RELATIONSHIPS.some((r) => r.toLowerCase() === rel)) return 'child';
  if (AMBIGUOUS_RELATIONSHIPS.some((r) => r.toLowerCase() === rel) && careKind === 'child') return 'child';
  return 'senior';
}

/** The relationship choices a household can offer: Child only when it includes child care; the senior ones only when it includes senior care; Other always. */
export function relationshipsForKinds(householdKinds: unknown, opts: { includeMyself?: boolean } = {}): string[] {
  const kinds = normalizeCareKinds(householdKinds);
  return RELATIONSHIPS.filter((r) => {
    if (r === 'Myself' && opts.includeMyself === false) return false;
    if (CHILD_RELATIONSHIPS.includes(r)) return kinds.includes('child');
    if (AMBIGUOUS_RELATIONSHIPS.includes(r)) return true;
    return kinds.includes('senior');
  });
}

/** The kinds a roster implies (a child on file → child, anyone else → senior); empty roster → []. */
export function rosterCareKinds(recipients: ReadonlyArray<{ relationship?: unknown; careKind?: unknown }>): CareKind[] {
  const set = new Set(recipients.map((r) => recipientCareKind(r.relationship, r.careKind)));
  return CARE_KINDS.filter((k) => set.has(k));
}

/** The first recipient a proposed household setting would leave uncovered, or null when the setting is allowed. */
export function careTypeChangeBlockedBy<T extends { relationship?: unknown; careKind?: unknown }>(proposedKinds: unknown, recipients: readonly T[]): T | null {
  const kinds = normalizeCareKinds(proposedKinds);
  return recipients.find((r) => !kinds.includes(recipientCareKind(r.relationship, r.careKind))) ?? null;
}

// ── One stage per child (founder, 2026-10-18 late) ──────────────────────────
// The stage is set ON THE CHILD (a single AGE_RANGES id: `ageRange` on the roster
// entry and on carePlans.recipientPlans.{key}); the post's `ageRanges` is just the
// picked children's stages. The older multi-select `ageRanges` lists are still READ
// (first element) but never written again.
/** A recipient's stage: the single field, else the first of a legacy list. */
export function recipientStage(r: { ageRange?: unknown; ageRanges?: unknown } | null | undefined): string | undefined {
  if (!r) return undefined;
  if (typeof r.ageRange === 'string' && r.ageRange) return r.ageRange;
  if (Array.isArray(r.ageRanges) && typeof r.ageRanges[0] === 'string' && r.ageRanges[0]) return r.ageRanges[0];
  return undefined;
}

/** The children among these recipients (inside the household setting) who still have no stage — one single-choice row each. */
export function childrenMissingStage<T extends { relationship?: unknown; careKind?: unknown; ageRange?: unknown; ageRanges?: unknown }>(recipients: readonly T[], householdKinds: unknown): T[] {
  if (!normalizeCareKinds(householdKinds).includes('child')) return [];
  return recipients.filter((r) => recipientCareKind(r.relationship, r.careKind) === 'child' && !recipientStage(r));
}

/** The stages of the children among these recipients, deduped, in AGE_RANGES order (what a post carries as `ageRanges`). */
export function stagesOfRecipients<T extends { relationship?: unknown; careKind?: unknown; ageRange?: unknown; ageRanges?: unknown }>(recipients: readonly T[], householdKinds: unknown): string[] {
  if (!normalizeCareKinds(householdKinds).includes('child')) return [];
  const set = new Set(recipients.filter((r) => recipientCareKind(r.relationship, r.careKind) === 'child').map(recipientStage).filter((s): s is string => !!s));
  return AGE_RANGES.map((a) => a.id as string).filter((id) => set.has(id));
}

/** The default job title by kind: 'Senior care in {city}' / 'Child care in {city}' / 'Senior and child care in {city}'. */
export function defaultJobTitle(city: string | null | undefined, kinds: unknown = undefined): string {
  const k = normalizeCareKinds(kinds);
  const what = k.length === 2 ? 'Senior and child care' : k[0] === 'child' ? 'Child care' : 'Senior care';
  return city ? `${what} in ${city}` : `${what} needed`;
}

// Certifications
export const CERTIFICATIONS = ['CNA', 'HHA', 'RN', 'LPN'] as const;

// Experience level options
export const EXPERIENCE_LEVELS = [
  '< 1 year',
  '1-2 years',
  '3-5 years',
  '5-10 years',
  '10+ years',
] as const;

// Availability time blocks (UrbanSitter-style)
export const TIME_BLOCKS = [
  { id: 'morning', label: 'Morning', time: '6am - 12pm', icon: '☀️' },
  { id: 'afternoon', label: 'Afternoon', time: '12pm - 6pm', icon: '🌤' },
  { id: 'evening', label: 'Evening', time: '6pm - 12am', icon: '🌙' },
  { id: 'overnight', label: 'Overnight', time: '12am - 6am', icon: '🌑' },
] as const;

export const DAYS = [
  { id: 'sunday', short: 'S' },
  { id: 'monday', short: 'M' },
  { id: 'tuesday', short: 'T' },
  { id: 'wednesday', short: 'W' },
  { id: 'thursday', short: 'T' },
  { id: 'friday', short: 'F' },
  { id: 'saturday', short: 'S' },
] as const;

// Job type options
export const JOB_TYPES = [
  { id: 'occasional', label: 'Occasional', subtitle: '' },
  { id: 'part-time', label: 'Part-time', subtitle: '' },
  { id: 'full-time', label: 'Full-time', subtitle: '' },
] as const;

// US States
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
] as const;

// Writing ideas for the About Me bio
// Max clients dropdown options
export const MAX_CLIENTS_OPTIONS = ['1', '2', '3+'] as const;

// ONE bio rule for the caregiver (sweep C7, 2026-10-11): the onboarding wizard's
// 150-character minimum is also the profile editor's; Evia's text step holds the same.
export const BIO_MIN_CHARS = 150;
export const BIO_MAX_CHARS = 2500;
