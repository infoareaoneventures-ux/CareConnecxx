// Onboarding field contract (U1) — the single source of truth for which
// conversational fields each role must collect before the agent loop hands back
// to the deterministic gate machine.
//
// Kept as a PURE LEAF module (no heavy imports) so both the MCP tool handlers and
// the onboarding directive can use it without dragging in the onboarding graph.
//
// SOURCE OF TRUTH — these mirror the legacy contracts and must stay in sync:
//   - CLIENT_REQUIRED_FIELDS  ↔ Object.values(CLIENT_STEP_FIELD) in onboardingConversation.ts
//   - CLIENT post-collection  ↔ CLIENT_POST_COLLECTION_STEP ("client_confirm_intake")
//   - isFieldFilled           ↔ isFieldFilled in onboardingConversation.ts
//   - CAREGIVER_REQUIRED_FIELDS ↔ caregiver step parse targets in onboardingSteps.caregiver.ts
//
// NOTE (caregiver sequencing, resolved): the scripted caregiver flow is in fact
// collect-then-gate, like the client's — every conversational field (name,
// location, story, experience, specialties, profile, availability, job type,
// rate, email, bio) is collected BEFORE the first transactional gate
// (caregiver_send_photo). The gates then run strictly scripted: photo → documents
// (SKIP allowed) → MVR consent → membership checkout → background check (Checkr)
// → Stripe Connect. So the caregiver loop uses the same "collect all, then hand
// to the first gate" model as the client: the loop owns only the steps in
// CAREGIVER_COLLECTION_STEPS, and complete_collection hands off to
// CAREGIVER_FIRST_GATE_STEP. Gate/awaiting steps are never routed to the loop.

export type OnboardingRole = "client" | "caregiver";

// Mirror of CLIENT_STEP_ORDER in onboardingConversation.ts — the conversational
// collection steps the agent loop owns (client-first). Kept here so the routing
// predicate stays in this pure leaf module. Must stay in sync with the legacy
// CLIENT_STEP_ORDER.
export const CLIENT_COLLECTION_STEPS: readonly string[] = [
  "client_ask_name", "client_ask_senior", "client_ask_needs",
  "client_ask_location", "client_ask_schedule",
];

// The conversational caregiver collection steps the agent loop owns, in the
// scripted flow's order (mirror of the caregiver_ask_* sequence in
// onboardingConversation.ts / onboardingSteps.caregiver.ts). Deliberately
// EXCLUDED, mirroring the client list:
//   - caregiver_confirm_name — owns its own yes/correction parsing (like
//     client_confirm_name).
//   - every gate/awaiting step (photo, documents, MVR, membership, bgcheck,
//     Stripe Connect) — deterministic side effects stay on the legacy handlers.
export const CAREGIVER_COLLECTION_STEPS: readonly string[] = [
  "caregiver_ask_name", "caregiver_ask_location", "caregiver_ask_story",
  "caregiver_ask_experience", "caregiver_ask_specialties", "caregiver_ask_profile",
  "caregiver_ask_availability", "caregiver_ask_job_type", "caregiver_ask_rate",
  "caregiver_ask_email", "caregiver_ask_bio",
];

export function collectionStepsForRole(role: OnboardingRole): readonly string[] {
  return role === "caregiver" ? CAREGIVER_COLLECTION_STEPS : CLIENT_COLLECTION_STEPS;
}

// Mirror of isFieldFilled in onboardingConversation.ts.
export function isFieldFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string")  return value.trim().length > 0;
  if (typeof value === "number")  return value > 0;
  if (Array.isArray(value))       return value.length > 0;
  if (typeof value === "object")  return Object.keys(value as object).length > 0;
  return true;
}

// Required conversational fields per role, in flow order.
// IMPORTANT: these are the FLAT keys the downstream consumers read
// (buildIntakeSummary, the carePlan/senior_profiles writes, deriveJobDataFromIntake,
// pushOnboardingDataToZep all read daysPerWeek/timeOfDay/careNeeds/zipCode/city —
// never a single "schedule" object). The loop must collect these exact keys or a
// completed signup produces an empty job post after payment.
// Mirror of the web ClientJobPostingWizard 14-step sequence. Required fields
// are the minimum to create a functional job post; allowed fields are the full
// set the wizard collects, so Evia can mirror the same questions over SMS.
export const CLIENT_REQUIRED_FIELDS: readonly string[] = [
  // Step 2 — care frequency
  "careFrequency",
  // Step 3 — home address: the wizard's canAdvanceAt(3) requires BOTH the
  // street and the zip (ClientJobPostingWizard.tsx). The zip is what lets the
  // backend deterministically derive homeCity/homeState — the wizard never lets
  // the family type a city at all.
  "homeStreet", "homeZipCode",
  // Step 3b — the "is care at the same address?" confirmation must be an
  // explicit saved answer, not an assumption nothing can verify (2026-08-22: a
  // live test showed this question skipped entirely — the model silently
  // treated care as being at the home address without ever asking). When true,
  // save_onboarding_field mirrors home* fields into these on save.
  "sameAsHomeAddress",
  // city/zipCode are required (not just city) so the backend can
  // deterministically derive city/state from zip — matching the wizard, which
  // requires the zip and never lets the family type a city at all (2026-08-22:
  // asking a free-form "what's your address" let a model extraction mistake a
  // street name for a city — "Campbell Ave" as the city "Campbell").
  "city", "zipCode",
  // Step 5 — schedule. The wizard's canAdvanceAt(6) is
  // `startDate && (selectedDays.length > 0 || daysFlexible)` — timeOfDay is
  // NOT required there (still asked; a "not sure" may leave it empty), and
  // flexible-only days satisfy selectedDays (see missingRequiredFields).
  "startDate", "selectedDays",
  // Step 8/9 — who
  "relationship", "seniorName",
  // age is optional — nice to have but not required to find a caregiver
  // Step 10 — emergency contact (at minimum a name + phone)
  "emergencyContactName", "emergencyContactPhone",
  // Step 11 — care needs
  "careNeeds",
  // Step 12 — rate
  "rate",
  // Not part of the wizard's job-post steps — a recovery-only field, added so
  // new client accounts have a way back in if the phone is ever lost (2026-09-02
  // Account Settings/phone-recovery audit). Required the same way the
  // caregiver side already requires "email" below, for the same reason.
  "email",
  // Collection always ends with the family member's own name
  "firstName",
];

// = the site's CaregiverOnboardingWizard, step for step (founder, 2026-09-25:
// Evia asks the same questions in the same order and writes the same fields):
//   location (street, zip → city/state, state) → photo → availability (job
//   type, days, parts of day) → services + years of experience → transport
//   documents when Transportation is offered → rate + travel distance → bio.
// `profilePhoto` and `transportDocuments` are collected through the tokened
// upload links (send_onboarding_link), not typed — the loop still owns them.
// Email is collected on /start (the wizard skips it when on file).
export const CAREGIVER_REQUIRED_FIELDS: readonly string[] = [
  "name",
  "street", "zipCode", "city", "state",
  "profilePhoto",
  "jobType", "availability",
  "specialties", "yearsExperience",
  "transportDocuments",
  "hourlyRate", "serviceRadius",
  "email", "bio",
];

/** The wizard's experience buckets (components/caregiver/signup/constants.ts EXPERIENCE_LEVELS). */
export const EXPERIENCE_BUCKETS: readonly string[] = ["< 1 year", "1-2 years", "3-5 years", "5-10 years", "10+ years"];
/** The wizard's travel-distance options in miles (TRAVEL_OPTIONS); default 10. */
export const TRAVEL_RADIUS_OPTIONS: readonly number[] = [5, 10, 15, 25, 50];
export const DEFAULT_TRAVEL_RADIUS = 10;
/** The wizard's bio minimum (BioStep minChars). */
export const BIO_MIN_CHARS = 150;
/** The three transportation documents the wizard requires when Transportation is offered. */
export const TRANSPORT_DOC_TYPES: readonly string[] = ["driversLicense", "insurance", "registration"];

/** Does the collected data say the caregiver offers Transportation? (canonical skills/services, or raw specialties) */
export function offersTransportation(d: Record<string, unknown> | undefined): boolean {
  if (!d) return false;
  const lists = [d.skills, d.services, d.specialties].filter(Array.isArray) as unknown[][];
  return lists.some((l) => l.some((s) => typeof s === "string" && s.trim().toLowerCase() === "transportation"));
}

/** Years of experience → the wizard's bucket string. Accepts a number, "6 years", "10+", or an exact bucket. */
export function toExperienceBucket(value: unknown): string | null {
  if (typeof value === "string" && EXPERIENCE_BUCKETS.includes(value.trim())) return value.trim();
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (/^(less than|under)\s*(a|1|one)\b/.test(t) || /^<\s*1/.test(t)) return "< 1 year";
    const m = t.match(/(\d+(\.\d+)?)/);
    if (m) n = Number(m[1]);
    else if (/\b(a|one)\s+year\b/.test(t)) n = 1;
  }
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  if (n < 1) return "< 1 year";
  if (n <= 2) return "1-2 years";
  if (n <= 5) return "3-5 years";
  if (n < 10) return "5-10 years";
  return "10+ years";
}

/** Travel distance → the nearest wizard option (5/10/15/25/50 miles). */
export function toServiceRadius(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string") {
    const m = value.match(/(\d+(\.\d+)?)/);
    if (m) n = Number(m[1]);
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return TRAVEL_RADIUS_OPTIONS.reduce((best, opt) => (Math.abs(opt - (n as number)) < Math.abs(best - (n as number)) ? opt : best), TRAVEL_RADIUS_OPTIONS[0]);
}

/** All three transport documents on file? (onboardingData.transportDocs = { type: url }) */
export function transportDocumentsComplete(d: Record<string, unknown> | undefined): boolean {
  const docs = (d?.transportDocs ?? {}) as Record<string, unknown>;
  return TRANSPORT_DOC_TYPES.every((t) => typeof docs[t] === "string" && (docs[t] as string).length > 0);
}

// Fields the loop is allowed to write via save_onboarding_field — the required
// set plus the optional/derived fields the wizard also captures.
export const CLIENT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CLIENT_REQUIRED_FIELDS,
  // Additional wizard fields (optional but collected when offered)
  // age was dropped from CLIENT_REQUIRED_FIELDS on purpose (commit c62fbaf,
  // "age is optional") but that also removed it from ALLOWED_FIELDS as an
  // unintended side effect, since ALLOWED = REQUIRED + this extras list —
  // save_onboarding_field("age", ...) was silently rejected ever since even
  // though onboardingDirective.ts still instructs the model to ask for it.
  "age",
  // timeOfDay is asked (wizard step 6) but not required — see CLIENT_REQUIRED_FIELDS.
  "timeOfDay",
  // `conditions` (diagnoses) is deliberately NOT here — medical scope is out
  // and the wizard never asks it, so Evia must never ask or absorb it.
  "hoursPerDay", "daysPerWeek",
  "street", "state", "neighborhood",
  "emergencyContactRelationship",
  "jobDescription",
  "petsInHome", "smokingHousehold",
  "careRecipientLastName", "lastName",
  // Backward-compat absorber field kept from the pre-wizard contract (the
  // wizard-less `preferences`/`budget` fields were retired with the legacy
  // client_ask_preferences/client_ask_budget steps — the wizard never collects them)
  "schedule",
  // Multi-recipient household
  "additionalRecipients",
  // Home address (account holder's address — distinct from care address).
  // homeZipCode is required (see CLIENT_REQUIRED_FIELDS); the rest are allowed.
  "homeStreet", "homeCity", "homeState",
  // Care recipient photo — optional, matches wizard step 8 (ClientJobPostingWizard.tsx)
  "careRecipientPhotoURL",
  // How many caregivers needed — matches wizard step 10's counter (default 1, up to 4)
  "caregiversNeeded",
  // Ongoing vs. specific end date — matches wizard step 6's toggle + date field
  "ongoing", "endDate",
  // Whether the selected days are flexible — asked alongside selectedDays/
  // timeOfDay (step 5) but was missing from this list, so save_onboarding_field
  // silently rejected it and it always came out false regardless of the answer.
  "daysFlexible",
]);

export const CAREGIVER_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CAREGIVER_REQUIRED_FIELDS,
  // Derived fields the save handler / absorber write alongside a required one:
  //   skills / services — the canonical care-services enum (from specialties)
  //   transportDocs — { driversLicense|insurance|registration: url }, written by
  //     the upload callable, never by the model
  // Nothing the wizard doesn't collect is allowed here (no certifications,
  // gender, languages, canDrive, bioSkipped, jobTypes — removed 2026-09-25).
  "skills", "services", "transportDocs",
]);

// The step the flow advances to once conversational collection completes and the
// agent loop hands back to the deterministic gate machine. Client → the intake
// playback/confirmation step (the wizard's own review moment; the legacy
// client_ask_start/preferences/budget steps were removed — the wizard never
// collected them). Caregiver → the first upload gate (matches the scripted
// handoff: handleCaregiverAskBio sets caregiver_send_photo).
export const CLIENT_POST_COLLECTION_STEP = "client_confirm_intake";
// After the wizard's last step (bio) the site lands on the dashboard whose
// first card is Membership — so does Evia. (Photo and transport documents are
// collected inside the loop now; the old photo/certification/MVR gates are gone.)
export const CAREGIVER_FIRST_GATE_STEP = "caregiver_send_membership";

export function requiredFieldsForRole(role: OnboardingRole): readonly string[] {
  return role === "caregiver" ? CAREGIVER_REQUIRED_FIELDS : CLIENT_REQUIRED_FIELDS;
}

export function allowedFieldsForRole(role: OnboardingRole): ReadonlySet<string> {
  return role === "caregiver" ? CAREGIVER_ALLOWED_FIELDS : CLIENT_ALLOWED_FIELDS;
}

export function isAllowedField(role: OnboardingRole, fieldName: string): boolean {
  return allowedFieldsForRole(role).has(fieldName);
}

// The canonical jobType enum the downstream world (caregiver doc, matching,
// deriveJobDataFromIntake) expects. Mirrors JOB_TYPES in caregiverFieldAbsorber.ts
// and the scripted parser's clamp in onboardingSteps.caregiver.ts.
export const CAREGIVER_JOB_TYPES: ReadonlySet<string> = new Set([
  "occasional", "part_time", "full_time",
]);

// Free-form spellings the model may hand to save_onboarding_field (it saves the
// raw string it extracted — "Full time", "FT", "part-time"). Keyed on the
// space-normalized, lowercased form.
const JOB_TYPE_CANON: Record<string, string> = {
  "full time": "full_time", "fulltime": "full_time", "ft": "full_time",
  "part time": "part_time", "parttime": "part_time", "pt": "part_time",
  "occasional": "occasional", "occasionally": "occasional",
  "as needed": "occasional", "prn": "occasional", "per diem": "occasional",
};

// Evia's own internal relationship vocabulary for onboardingData — NOT the
// same value space as the website's wizard enum (myself/parent/spouse/other).
// "self" is a special sentinel checked throughout onboardingSteps.client.ts/
// qaAgent.ts/careRecipients.ts for self-referential voice and logic (the texter
// IS the care recipient) — it is set only via the dedicated self-care branch in
// handleAskRole, never via this canonicalizer. Every OTHER value describes the
// texter's relation to someone ELSE needing care ("I'm her daughter" → the
// recipient is a parent), canonicalized here so a raw "daughter"/"child"/"son"
// doesn't reach carePlans/senior_profiles unmapped — see toWebsiteRelationship
// in clientJobPostingContract.ts for the translation into the website's enum.
const RELATIONSHIP_CANON: Record<string, string> = {
  "parent": "parent", "mother": "parent", "mom": "parent", "father": "parent",
  "dad": "parent", "daughter": "parent", "son": "parent", "child": "parent",
  "spouse": "spouse", "wife": "spouse", "husband": "spouse", "partner": "spouse",
};

// Canonicalize an already-extracted enum-ish field value before it is persisted
// ("Full time" → "full_time"). NOT intent parsing of free-form user text — it
// canonicalizes a constrained value the model already resolved into a field, the
// same class as the absorber's JOB_TYPES validation and email-format regex (both
// allowed by the LLM-parsing rule). Unknown non-empty values pass through
// unchanged so downstream data is never silently dropped; the caller logs them —
// EXCEPT relationship, which maps anything unrecognized (other than the "self"
// sentinel, left untouched) to "other" rather than leaving a raw string the
// website's exact-match checks would never recognize.
export function normalizeOnboardingFieldValue(fieldName: string, value: unknown): unknown {
  if (fieldName === "jobType" && typeof value === "string") {
    const key = value.trim().toLowerCase().replace(/[\s_-]+/g, " ").trim();
    return JOB_TYPE_CANON[key] ?? value;
  }
  if (fieldName === "relationship" && typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (key === "self") return "self";
    if (key === "parent" || key === "spouse" || key === "other") return key;
    return RELATIONSHIP_CANON[key] ?? "other";
  }
  if (fieldName in NUMERIC_FIELD_RANGE) {
    const n = coerceNumericOnboardingField(fieldName, value);
    return n ?? value; // unparseable passes through; write sites reject via the coercer
  }
  // Wizard value shapes (2026-09-25): experience is one of five bucket strings,
  // travel distance one of five mile options, state a 2-letter code.
  if (fieldName === "yearsExperience") return toExperienceBucket(value) ?? value;
  if (fieldName === "serviceRadius")   return toServiceRadius(value) ?? value;
  if (fieldName === "state" && typeof value === "string") {
    const t = value.trim();
    return t.length === 2 ? t.toUpperCase() : t;
  }
  return value;
}

// Numeric-field sanity ranges. A prod session was found with
// daysPerWeek: "santa clara" — an extraction hallucination that then rendered
// as "santa clara days/week" in the intake schedule. These fields must be
// finite numbers in range or they are not saved at all.
const NUMERIC_FIELD_RANGE: Record<string, [number, number]> = {
  daysPerWeek: [1, 7],
  hoursPerDay: [1, 24],
  age:         [1, 120],
  // Matches the wizard's counter cap (ClientJobPostingWizard.tsx step 10).
  caregiversNeeded: [1, 4],
};

/**
 * Coerce a numeric onboarding field to a finite in-range number ("3 days" → 3,
 * "3" → 3, 3 → 3). Returns null when no in-range number can be extracted —
 * callers must skip the save (never persist prose into a numeric field). This
 * is type/range validation of an already-extracted value, not intent parsing.
 */
export function coerceNumericOnboardingField(fieldName: string, value: unknown): number | null {
  const range = NUMERIC_FIELD_RANGE[fieldName];
  if (!range) return null;
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string") {
    const m = value.match(/\d+(\.\d+)?/);
    if (m) n = Number(m[0]);
  }
  if (n === null || !Number.isFinite(n)) return null;
  return n >= range[0] && n <= range[1] ? n : null;
}

/** True when this field must be a number (daysPerWeek/hoursPerDay/age). */
export function isNumericOnboardingField(fieldName: string): boolean {
  return fieldName in NUMERIC_FIELD_RANGE;
}

// The webapp caregiver profile stores/reads jobTypes as an array of hyphenated
// ids (components/caregiver/signup/constants.ts JOB_TYPES: occasional |
// part-time | full-time), while Evia's collected jobType uses the matching
// engine's underscored enum (occasional | part_time | full_time). Map one to the
// other for the webapp display mirror. Unknown values are dropped.
const JOB_TYPE_TO_WEB_ID: Record<string, string> = {
  occasional: "occasional",
  part_time: "part-time",
  full_time: "full-time",
  // tolerate already-hyphenated or raw spellings so the mirror never blanks
  "part-time": "part-time",
  "full-time": "full-time",
};

// Produce the webapp jobTypes array from whatever the loop collected — a single
// jobType string and/or a jobTypes array (when the caregiver named more than one
// work type). Deduped, in a stable order, hyphenated web ids only.
export function caregiverJobTypesToWebIds(
  jobType: unknown,
  jobTypes: unknown,
): string[] {
  const raw: string[] = [];
  if (Array.isArray(jobTypes)) {
    for (const v of jobTypes) if (typeof v === "string") raw.push(v);
  }
  if (typeof jobType === "string") raw.push(jobType);
  const order = ["occasional", "part-time", "full-time"];
  const mapped = new Set<string>();
  for (const v of raw) {
    const web = JOB_TYPE_TO_WEB_ID[v.trim().toLowerCase()];
    if (web) mapped.add(web);
  }
  return order.filter((o) => mapped.has(o));
}

// Required fields still missing from the collected data, in flow order.
export function missingRequiredFields(
  role: OnboardingRole,
  data: Record<string, unknown> | undefined,
): string[] {
  const d = data ?? {};
  return requiredFieldsForRole(role).filter((f) => {
    // Transport documents are required only when the caregiver offers
    // Transportation (wizard: the transport-docs step exists only then).
    if (role === "caregiver" && f === "transportDocuments") {
      return offersTransportation(d) && !transportDocumentsComplete(d);
    }
    // Wizard canAdvanceAt(6): `selectedDays.length > 0 || daysFlexible` — a
    // family whose days are flexible with no fixed days is complete.
    if (role === "client" && f === "selectedDays" && d.daysFlexible === true) return false;
    return !isFieldFilled(d[f]);
  });
}

// Client hourly rate — the wizard's canAdvanceAt(13) is `rate > 0` (a number
// from a numeric input; there is NO "flexible" option at signup). Coerce a
// number or a numeric string ("$26", "26/hr") to the number; anything else
// (including the literal "flexible") is null → the caller re-asks for a number.
// Value-shape validation of an already-extracted answer, not intent parsing.
export function coerceClientRate(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string") {
    const m = value.match(/\d+(\.\d+)?/);
    if (m) n = Number(m[0]);
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function firstGateStep(role: OnboardingRole): string {
  return role === "caregiver" ? CAREGIVER_FIRST_GATE_STEP : CLIENT_POST_COLLECTION_STEP;
}

// The only tools the agent loop is offered during onboarding (U3). Keeping the
// surface tiny keeps collection focused and fast — never the full 88-tool set.
// complete_task lets the loop end the turn intentionally.
export const ONBOARDING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "save_onboarding_field", "complete_collection", "complete_task",
]);

export function isOnboardingTool(name: string): boolean {
  return ONBOARDING_TOOL_NAMES.has(name);
}

// Whether this inbound onboarding turn runs inside the qaAgent loop. The loop is
// the SOLE conversational-collection path (loop-only, 2026-07-08): any text turn
// at a collection step routes here. Only two things stay on the scripted runner:
//   - transactional GATE steps (not in the role's collection list) — payment,
//     Checkr, Stripe, uploads, OTP, ask_role, confirm-name;
//   - MEDIA turns (photo/document), which fall to handleOnboardingStep →
//     handleInboundMedia (the upload gates).
// Location pins are converted to text BEFORE this predicate (webhooks 2a) and
// empty-text turns get a deterministic nudge (2c), so the loop only needs
// hasText && !hasMedia. There is no feature flag anymore — loop-only must not be
// revertable-by-config to a scripted path that no longer exists.
export function shouldRouteOnboardingToLoop(args: {
  role: string | undefined;
  step: string;
  hasText: boolean;
  hasMedia: boolean;
}): boolean {
  const { role, step, hasText, hasMedia } = args;
  if (role !== "client" && role !== "caregiver") return false;
  if (!collectionStepsForRole(role).includes(step)) return false;
  if (!hasText || hasMedia) return false;
  return true;
}
