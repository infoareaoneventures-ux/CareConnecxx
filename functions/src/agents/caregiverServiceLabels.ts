// The caregiver care-services menu — the website's "What services do you offer?"
// step (components/caregiver/signup/constants.ts PRIMARY_SERVICES) — and the
// display label each one carries wherever the eight are shown. Pure constants:
// safe to import from prompt builders (no model client, no Firestore).
//
// The STORED value is always the PRIMARY_SERVICES string; only the label shown
// to people differs — "Medication Reminders" reads "Medication Reminders Only"
// (founder 2026-10-04: reminding when it's time, never administering medication).
// MUST stay byte-identical to the site's constants (parity test: caregiverServices.test.ts).

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

// ── Care kinds (child care, 2026-10-18; un-framed 2026-10-19) ──────────────
// Nobody is asked "senior, child or both" anywhere (founder 2026-10-19). The
// kinds are DERIVED: a family's from the RELATIONSHIP of each person on the
// record (recipientCareKind), a provider's and a post's from the services ticked
// (kindsOfServices). Stored `careKinds` fields stay where they are cheap to keep
// derived; a MISSING value still reads ["senior"] (legacy records keep their
// senior titles), but nothing is ever hidden by kind — the view filters read
// kindsOfPost / kindsOfProvider, whose fallback is BOTH. Mirrored byte-for-byte
// in components/caregiver/signup/constants.ts (parity test).
export const CARE_KINDS = ["senior", "child"] as const;
export type CareKind = (typeof CARE_KINDS)[number];
export const CARE_KIND_LABEL: Record<CareKind, string> = { senior: "Senior care", child: "Child care" };
export const DEFAULT_CARE_KINDS: readonly CareKind[] = ["senior"];

// The child-care eight (founder, 2026-10-18): plain names, nothing underneath,
// no age in a name (the age-range chips carry that). Transportation keeps the
// senior list's exact name on purpose — ticked once, it counts for both kinds
// and the driving-record rule carries over unchanged.
export const CHILD_SERVICES = [
  "Supervision",
  "Baby Care",
  "Bathing & Dressing",
  "Meals & Snacks",
  "Activities & Play",
  "School & Homework",
  "Transportation",
  "Tidying & Laundry",
] as const;

// The six "additional services" (Hospice Care, Post-Surgery Recovery, …) were
// removed 2026-10-04 (founder: "those six shouldn't exist"): no site screen ever
// offered them. Since 2026-10-18 the canonical set is the senior eight PLUS the
// child eight (Transportation once) — every name either site list can store.
export const CANONICAL_SERVICES: readonly string[] = [...PRIMARY_SERVICES, ...CHILD_SERVICES.filter((s) => !(PRIMARY_SERVICES as readonly string[]).includes(s))];
export const ALL_SERVICES: readonly string[] = CANONICAL_SERVICES;

/** Normalize a stored/absent value to the kinds it means: missing or empty = ["senior"] (legacy records; never used to hide anyone). */
export function normalizeCareKinds(value: unknown): CareKind[] {
  const arr = Array.isArray(value) ? value : [];
  const kinds = CARE_KINDS.filter((k) => arr.includes(k));
  return kinds.length ? kinds : [...DEFAULT_CARE_KINDS];
}

/** The list(s) a person sees for the kinds they picked, as [{ kind, services }] in senior-then-child order. */
export function serviceListsForKinds(value: unknown): Array<{ kind: CareKind; services: readonly string[] }> {
  const kinds = normalizeCareKinds(value);
  return [
    ...(kinds.includes("senior") ? [{ kind: "senior" as CareKind, services: PRIMARY_SERVICES as readonly string[] }] : []),
    ...(kinds.includes("child") ? [{ kind: "child" as CareKind, services: CHILD_SERVICES as readonly string[] }] : []),
  ];
}

/** The kinds a set of ticked services implies. Transportation alone implies nothing; `fallback` (the stored kinds, or CARE_KINDS for "both") decides then. */
export function kindsOfServices(services: readonly unknown[], fallback: unknown = undefined): CareKind[] {
  const names = services.filter((s): s is string => typeof s === "string");
  const senior = names.some((s) => s !== "Transportation" && (PRIMARY_SERVICES as readonly string[]).includes(s));
  const child = names.some((s) => s !== "Transportation" && (CHILD_SERVICES as readonly string[]).includes(s));
  const kinds = CARE_KINDS.filter((k) => (k === "senior" ? senior : child));
  return kinds.length ? kinds : normalizeCareKinds(fallback);
}

/** The kinds a job post needs, read from the services on it (careTypes); the stored kinds, else senior, when the services say nothing. */
export function kindsOfPost(post: { careTypes?: unknown; careKinds?: unknown } | null | undefined): CareKind[] {
  const types = Array.isArray(post?.careTypes) ? (post!.careTypes as unknown[]) : [];
  return kindsOfServices(types, post?.careKinds);
}

/** The kinds a care provider offers, read from the services they ticked (Transportation alone, or nothing yet = both). */
export function kindsOfProvider(profile: { services?: unknown; skills?: unknown } | null | undefined): CareKind[] {
  const services = Array.isArray(profile?.services) && (profile!.services as unknown[]).length ? (profile!.services as unknown[])
    : Array.isArray(profile?.skills) ? (profile!.skills as unknown[]) : [];
  return kindsOfServices(services, CARE_KINDS);
}

/** A provider's ticked services grouped under the list name(s) they imply — ALWAYS named (founder, 2026-10-19), only the
 *  lists with any of their services; Transportation (on both lists) shows under each list shown, and alone = both. */
export function serviceGroupsOf(services: readonly unknown[]): Array<{ kind: CareKind; services: string[] }> {
  const ticked = services.filter((s): s is string => typeof s === "string");
  return serviceListsForKinds(kindsOfServices(ticked, CARE_KINDS))
    .map((l) => ({ kind: l.kind, services: l.services.filter((s) => ticked.includes(s)) }))
    .filter((g) => g.services.length > 0);
}

/**
 * An already-extracted answer to the kinds question ("child care", "both", "my mom", ["senior"]) → the
 * canonical kinds, or null when nothing in it names a kind. Value-shape canonicalization of a constrained
 * answer (the model already resolved the field) — not intent parsing of raw SMS.
 */
export function careKindsFromWords(value: unknown): CareKind[] | null {
  const parts: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string" ? [value] : [];
  const text = parts.join(" ").toLowerCase();
  if (!text.trim()) return null;
  const both = /\bboth\b|\ball\b|senior and child|child and senior|elder and child/.test(text);
  const senior = both || /\bsenior|\belder|older adult|\bageing|\baging|\bmom\b|\bdad\b|mother|father|\bparent|grandm|grandp|grandfather|grandmother|\bspouse|\bwife\b|\bhusband|\bpartner|myself|\badult\b/.test(text);
  const child = both || /\bchild|\bkid|\bson\b|daughter|\bbaby|infant|toddler|\bteen|grandchild|grandson|granddaughter|nanny|babysit|\bnephew|\bniece/.test(text);
  const kinds = CARE_KINDS.filter((k) => (k === "senior" ? senior : child));
  return kinds.length ? kinds : null;
}

/** Age-range ids from names, labels or ids ("toddler", "Ages 3–5", "3-5", "teenager") — unknown words dropped. */
export function ageRangesFromWords(value: unknown): string[] {
  const parts: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string" ? value.split(/[,;/]|\band\b/i) : [];
  const out: string[] = [];
  for (const raw of parts) {
    const s = raw.trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
    if (!s) continue;
    let id: string | null = null;
    if (/infant|newborn|\bbaby\b|baby|months old/.test(s)) id = "infant";
    else if (/toddler/.test(s)) id = "toddler";
    else if (/\bteen|teenager|high school|\b1[3-9]\b/.test(s)) id = "teen";
    else if (/3\s*-\s*5|\b[345]\b|preschool|pre-k|kindergart/.test(s)) id = "3-5";
    else if (/6\s*-\s*12|\b(6|7|8|9|10|11|12)\b|elementary|grade school|school age|school-age/.test(s)) id = "6-12";
    else { const exact = AGE_RANGES.find((a) => a.id === s || a.label.toLowerCase().replace(/[–—]/g, "-") === s); if (exact) id = exact.id; }
    if (id && !out.includes(id)) out.push(id);
  }
  return AGE_RANGES.map((a) => a.id).filter((id) => out.includes(id));
}

/** ONE stage per child (founder 2026-10-18 late): the first stage named, as its id — or null. */
export function ageRangeFromWords(value: unknown): string | null {
  const ids = ageRangesFromWords(value);
  return ids.length ? ids[0] : null;
}

/** A recipient's stored stage: the single `ageRange` id, else the first of a legacy `ageRanges` array; null when none. */
export function stageOf(r: { ageRange?: unknown; ageRanges?: unknown } | null | undefined): string | null {
  if (!r) return null;
  if (typeof r.ageRange === "string" && AGE_RANGE_IDS.includes(r.ageRange)) return r.ageRange;
  if (Array.isArray(r.ageRanges)) { const first = r.ageRanges.find((v) => typeof v === "string" && AGE_RANGE_IDS.includes(v)); if (first) return first as string; }
  return null;
}

/** The sentence that asks a child's stage, by name when the post names more than one child. */
export function stageQuestion(firstName?: string | null): string {
  const names = AGE_RANGES.map((a) => a.label);
  const list = `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return firstName ? `Which stage is ${firstName} at — ${list}?` : `Which stage — ${list}?`;
}

/** "Child care" / "Senior and child care" — the badge a card shows only when the kinds (derived from the services ticked) include child care; null for senior-only. */
export function careKindBadge(kinds: unknown): string | null {
  const k = normalizeCareKinds(kinds);
  if (!k.includes("child")) return null;
  return k.length === 2 ? "Senior and child care" : "Child care";
}

// Age ranges for a child — an informational chip beside pets / smoking, never a
// filter, never a number (the no-age rule stays for everyone else).
// Labels are STAGE words, never numbers (founder 2026-10-18): the stored ids stay.
export const AGE_RANGES = [
  { id: "infant", label: "Infant" },
  { id: "toddler", label: "Toddler" },
  { id: "3-5", label: "Preschooler" },
  { id: "6-12", label: "School-age" },
  { id: "teen", label: "Teen" },
] as const;
/** The heading over the stage chips, both doors. */
export const STAGE_HEADING = "Stage";
export type AgeRangeId = (typeof AGE_RANGES)[number]["id"];
export const ageRangeLabel = (id: string): string => AGE_RANGES.find((a) => a.id === id)?.label ?? id;
export const AGE_RANGE_IDS: readonly string[] = AGE_RANGES.map((a) => a.id);

// The relationship list, the same SIX on both doors (founder, 2026-10-18 late):
// "Adult child" = a grown son or daughter — senior side; "Child" = a minor —
// child side. Older stored values (Grandparent, Sibling, Spouse) still read back.
export const RELATIONSHIPS = ["Myself", "Parent", "Spouse or Partner", "Adult child", "Child", "Other"] as const;

// No care-type question exists on either door (founder 2026-10-19). The only
// adult-or-child question left is the follow-up for the relationship Other (and
// for an ambiguous "my son / my daughter" by text).
export const OTHER_KIND_QUESTION = "Is this person an adult or a child?";
export const OTHER_KIND_OPTIONS = [{ value: "senior", label: "Adult" }, { value: "child", label: "Child" }] as const;

// ── Who decides a recipient's kind (founder, 2026-10-19) ─────────────────────
// The RELATIONSHIP decides which list a recipient sees: Child → child; Myself /
// Parent / Spouse or Partner / Adult child (and the older stored values) →
// senior; Other → the recipient's own stored `careKind` (the adult-or-child
// follow-up, asked for every Other). The account holds nothing.
export const CHILD_RELATIONSHIPS: readonly string[] = ["Child"];
export const AMBIGUOUS_RELATIONSHIPS: readonly string[] = ["Other"];

/** The kind a recipient belongs to, from their relationship (and, for Other, their stored careKind). */
export function recipientCareKind(relationship: unknown, careKind: unknown = undefined): CareKind {
  const rel = String(relationship ?? "").trim().toLowerCase();
  if (CHILD_RELATIONSHIPS.some((r) => r.toLowerCase() === rel)) return "child";
  if (AMBIGUOUS_RELATIONSHIPS.some((r) => r.toLowerCase() === rel) && careKind === "child") return "child";
  return "senior";
}

/** The relationship choices: all six for everyone (missing kinds = both); the kinds argument survives only for callers that narrow a derived set. */
export function relationshipsForKinds(householdKinds: unknown, opts: { includeMyself?: boolean } = {}): string[] {
  const kinds = normalizeCareKinds(householdKinds);
  return RELATIONSHIPS.filter((r) => {
    if (r === "Myself" && opts.includeMyself === false) return false;
    if (CHILD_RELATIONSHIPS.includes(r)) return kinds.includes("child");
    if (AMBIGUOUS_RELATIONSHIPS.includes(r)) return true;
    return kinds.includes("senior");
  });
}

/** The kinds a roster implies (a child on file → child, anyone else → senior); empty roster → []. */
export function rosterCareKinds(recipients: ReadonlyArray<{ relationship?: unknown; careKind?: unknown }>): CareKind[] {
  const set = new Set(recipients.map((r) => recipientCareKind(r.relationship, r.careKind)));
  return CARE_KINDS.filter((k) => set.has(k));
}

/** The default job title by kind (derived from the ticked services): 'Senior care in {city}' / 'Child care in {city}' / 'Senior and child care in {city}'. */
export function defaultJobTitleFor(city: string | null | undefined, kinds: unknown = undefined): string {
  const k = normalizeCareKinds(kinds);
  const what = k.length === 2 ? "Senior and child care" : k[0] === "child" ? "Child care" : "Senior care";
  return city ? `${what} in ${city}` : `${what} needed`;
}

export const SERVICE_DISPLAY_LABEL: Record<string, string> = {
  "Medication Reminders": "Medication Reminders Only",
};

/** The label people see for a stored service value ("Medication Reminders" → "Medication Reminders Only"). */
export function serviceLabel(name: string): string {
  return SERVICE_DISPLAY_LABEL[name] ?? name;
}

export function serviceLabels(names: readonly string[]): string[] {
  return names.map(serviceLabel);
}

/** The senior eight as shown — the menu Evia lists, one per line, by name, never numbered. */
export const SERVICE_LABELS: readonly string[] = PRIMARY_SERVICES.map(serviceLabel);
/** The child eight as shown. */
export const CHILD_SERVICE_LABELS: readonly string[] = CHILD_SERVICES.map(serviceLabel);

/** The menu for the kinds on record (missing = senior): one list, or both under their own headings. */
export function serviceMenuText(kinds: unknown = undefined): string {
  const lists = serviceListsForKinds(kinds);
  if (lists.length === 1) return lists[0].services.map(serviceLabel).join("\n");
  return lists.map((l) => `${CARE_KIND_LABEL[l.kind]}:\n${l.services.map(serviceLabel).join("\n")}`).join("\n\n");
}

const CANONICAL_SET = new Set(CANONICAL_SERVICES);

/** Dedupe to canonical strings, in the menu's order (stable; matches the backfill migration). */
export function orderedCanonicalServices(values: readonly unknown[]): string[] {
  const present = new Set(values.filter((v): v is string => typeof v === "string" && CANONICAL_SET.has(v)));
  return CANONICAL_SERVICES.filter((s) => present.has(s));
}

/** A stored value or a shown label → the stored value; null when it is neither. */
export function serviceFromNameOrLabel(text: string): string | null {
  const key = text.trim().toLowerCase();
  for (const s of CANONICAL_SERVICES) {
    if (s.toLowerCase() === key || serviceLabel(s).toLowerCase() === key) return s;
  }
  return null;
}

/** Job post Details cap (founder, 2026-10-19: a limit, never a silent cut) — the site's counter and Evia's text step hold the same; over it, Evia asks for a shorter version. */
export const JOB_DESCRIPTION_MAX_CHARS = 1000;
