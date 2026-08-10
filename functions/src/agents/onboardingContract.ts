// Onboarding field contract (U1) — the single source of truth for which
// conversational fields each role must collect before the agent loop hands back
// to the deterministic gate machine.
//
// Kept as a PURE LEAF module (no heavy imports) so both the MCP tool handlers and
// the onboarding directive can use it without dragging in the onboarding graph.
//
// SOURCE OF TRUTH — these mirror the legacy contracts and must stay in sync:
//   - CLIENT_REQUIRED_FIELDS  ↔ Object.values(CLIENT_STEP_FIELD) in onboardingConversation.ts
//   - CLIENT post-collection  ↔ CLIENT_POST_COLLECTION_STEP ("client_ask_start")
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
  // Step 3 — location
  "city",
  // Step 5 — schedule
  "startDate", "selectedDays", "timeOfDay",
  // Step 8/9 — who
  "relationship", "seniorName",
  // age is optional — nice to have but not required to find a caregiver
  // Step 10 — emergency contact (at minimum a name + phone)
  "emergencyContactName", "emergencyContactPhone",
  // Step 11 — care needs
  "careNeeds",
  // Step 12 — rate
  "rate",
  // Collection always ends with the family member's own name
  "firstName",
];

export const CAREGIVER_REQUIRED_FIELDS: readonly string[] = [
  "name", "city", "yearsExperience", "specialties",
  "availability", "jobType", "hourlyRate", "email", "bio",
];

// Fields the loop is allowed to write via save_onboarding_field — the required
// set plus the optional/derived fields the wizard also captures.
export const CLIENT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CLIENT_REQUIRED_FIELDS,
  // Additional wizard fields (optional but collected when offered)
  "conditions", "zipCode", "hoursPerDay", "daysPerWeek",
  "street", "state", "neighborhood",
  "emergencyContactRelationship",
  "paymentMethod",
  "jobDescription",
  "petsInHome", "smokingHousehold",
  "careRecipientLastName", "lastName",
  // Backward-compat / absorber fields kept from the pre-wizard contract
  "preferences", "budget", "schedule",
  // Multi-recipient household
  "additionalRecipients",
]);

export const CAREGIVER_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CAREGIVER_REQUIRED_FIELDS,
  // Optional/derived fields the scripted caregiver flow also captures:
  //   certifications + skills — story/experience extraction targets
  //   zipCode — the service-area gate in save_onboarding_field asks for a ZIP
  //     when the city isn't recognized; the loop must be able to save it
  //   gender / languages / canDrive — the caregiver_ask_profile step's fields
  //   jobTypes — webapp display-parity array (mirror of jobType); the model may
  //     save it directly when a caregiver names more than one work type
  //   services — canonical care-services (mirror of skills); rarely saved by the
  //     model directly but allowed so the absorber/canonicalizer can write it
  "certifications", "skills", "services", "zipCode", "gender", "languages",
  "canDrive", "bioSkipped", "jobTypes",
]);

// The step the flow advances to once conversational collection completes and the
// agent loop hands back to the deterministic gate machine. Client → the legacy
// post-collection step. Caregiver → the first upload gate (matches the scripted
// handoff: handleCaregiverAskBio sets caregiver_send_photo).
export const CLIENT_POST_COLLECTION_STEP = "client_ask_start";
export const CAREGIVER_FIRST_GATE_STEP = "caregiver_send_photo";

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

// Canonicalize an already-extracted enum-ish field value before it is persisted
// ("Full time" → "full_time"). NOT intent parsing of free-form user text — it
// canonicalizes a constrained value the model already resolved into a field, the
// same class as the absorber's JOB_TYPES validation and email-format regex (both
// allowed by the LLM-parsing rule). Unknown non-empty values pass through
// unchanged so downstream data is never silently dropped; the caller logs them.
export function normalizeOnboardingFieldValue(fieldName: string, value: unknown): unknown {
  if (fieldName === "jobType" && typeof value === "string") {
    const key = value.trim().toLowerCase().replace(/[\s_-]+/g, " ").trim();
    return JOB_TYPE_CANON[key] ?? value;
  }
  if (fieldName in NUMERIC_FIELD_RANGE) {
    const n = coerceNumericOnboardingField(fieldName, value);
    return n ?? value; // unparseable passes through; write sites reject via the coercer
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
    if (role === "caregiver" && f === "bio" && d.bioSkipped === true) return false;
    return !isFieldFilled(d[f]);
  });
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
