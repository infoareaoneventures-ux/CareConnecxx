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

// ── R-FD5: the contract becomes role × vertical, ADDITIVELY ──────────────────
//
// docs/architecture/childcare-front-door-design.md. Every role-keyed seam below
// gained an optional SECOND key — the care vertical — defaulting to "senior", so
// every existing senior call site is byte-identical (same arguments, same
// returned array/set IDENTITY, same values). The legacy `…ForRole` exports are
// kept as thin senior-defaulting wrappers so nothing downstream had to change.
//
// The rule this encodes: a childcare caregiver is NOT a senior caregiver with
// extra fields. They share the BASE identity/contact/logistics fields (collected
// once, never re-asked — AE21) and diverge on everything vertical-specific
// (which ages they serve, childcare experience, childcare credentials,
// transport). R-FD6's "two independent vertical profiles" starts here: the
// contract can describe one vertical without asserting anything about the other.
export type OnboardingVertical = "senior" | "child";

/** The default second key. Senior is the live path and must never move. */
export const DEFAULT_ONBOARDING_VERTICAL: OnboardingVertical = "senior";

function normalizeVertical(vertical?: OnboardingVertical | null): OnboardingVertical {
  return vertical === "child" ? "child" : "senior";
}

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

// ── Childcare caregiver collection steps (R-FD5 / R-FD6, Stage 2) ────────────
//
// The childcare caregiver funnel. Steps prefixed `caregiver_ask_childcare_` are
// the VERTICAL DELTA; every other step in the list is the SHARED BASE step of
// the same name the senior funnel uses — deliberately the same identifier,
// because it collects the same field into the same key. That identity is what
// makes AE21 mechanical rather than aspirational: an existing senior caregiver
// adding childcare already has those base fields, so
// providerEligibility.computeMissingChildcareFields reports them as reused and
// the funnel simply never reaches those steps.
//
// Excluded, mirroring the senior caregiver list: confirm-name (owns its own
// parsing) and every deterministic gate. The childcare gates are the post-
// collection enrollment steps below (policy acceptance → screening consent →
// screening → MANUAL review), owned by agents/childcareCaregiverFunnel.ts.
export const CAREGIVER_CHILDCARE_COLLECTION_STEPS: readonly string[] = [
  "caregiver_ask_name",
  "caregiver_ask_location",
  "caregiver_ask_childcare_experience",
  "caregiver_ask_childcare_ages",
  "caregiver_ask_childcare_services",
  "caregiver_ask_childcare_credentials",
  "caregiver_ask_childcare_transport",
  "caregiver_ask_availability",
  "caregiver_ask_job_type",
  "caregiver_ask_rate",
  "caregiver_ask_email",
  "caregiver_ask_bio",
];

/**
 * R-FD4: the childcare CLIENT conversation collects nothing over SMS. Child
 * names, ages, DOB, health, custody, pickup, and address are web-form-only
 * (R33/R57), so there is deliberately NO childcare client collection step and NO
 * childcare client collectable field — an empty allowed set means the loop
 * cannot write a single child detail into a session even if a model tried.
 */
export const CLIENT_CHILDCARE_COLLECTION_STEPS: readonly string[] = [];

export function collectionStepsFor(
  role: OnboardingRole,
  vertical?: OnboardingVertical | null,
): readonly string[] {
  if (normalizeVertical(vertical) === "child") {
    return role === "caregiver" ? CAREGIVER_CHILDCARE_COLLECTION_STEPS : CLIENT_CHILDCARE_COLLECTION_STEPS;
  }
  return role === "caregiver" ? CAREGIVER_COLLECTION_STEPS : CLIENT_COLLECTION_STEPS;
}

/** Senior-defaulting wrapper — kept so every existing call site is unchanged. */
export function collectionStepsForRole(role: OnboardingRole): readonly string[] {
  return collectionStepsFor(role, DEFAULT_ONBOARDING_VERTICAL);
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
export const CLIENT_REQUIRED_FIELDS: readonly string[] = [
  "firstName", "seniorName", "age", "careNeeds", "city", "daysPerWeek", "timeOfDay",
];

export const CAREGIVER_REQUIRED_FIELDS: readonly string[] = [
  "name", "city", "yearsExperience", "specialties",
  "availability", "jobType", "hourlyRate", "email", "bio",
];

// Fields the loop is allowed to write via save_onboarding_field — the required
// set plus the optional/derived fields each flow legitimately captures. A write
// to anything outside this set is rejected so the model can't invent keys.
export const CLIENT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CLIENT_REQUIRED_FIELDS,
  "relationship", "conditions", "zipCode", "hoursPerDay",
  "startDate", "preferences", "budget",
  // Multi-recipient household ("both mom and dad"): every care recipient after
  // the first — [{name, relationship, age?}]. Finalization fans these out into
  // recipientPlans, household senior_profiles docs, and job_postings.
  "additionalRecipients",
  // Free-text schedule phrase the absorber may capture alongside the
  // structured daysPerWeek/timeOfDay (kept for intake display).
  "schedule",
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

// ── Childcare caregiver fields (R-FD5 / R-FD6) ───────────────────────────────
//
// SHARED BASE keys (`name`, `city`, `availability`, `jobType`, `hourlyRate`,
// `email`, `bio`) are deliberately the SAME keys the senior funnel writes: one
// question, one collected key, and the enrollment step then copies the value
// into the caregiver's OWN childcare vertical profile document
// (caregivers/{uid}/vertical_profiles/child). That is how AE21 ("never re-ask
// verified base work") and R24/R-FD6 ("two independent vertical profiles") hold
// at the same time — the ASK is shared, the STORAGE is not: the vertical
// profile's rate/approval/screening/reputation can diverge from senior's
// forever after, and nothing in the childcare path ever writes a senior field.
//
// VERTICAL-DELTA keys are all `childcare*` / `yearsChildcareExperience` and map
// 1:1 onto the U5 vertical-profile schema (providerEligibility.ts):
//   childcareAgeBands        → ageBands
//   childcareServices        → services            (enableable categories ONLY)
//   yearsChildcareExperience → yearsChildcareExperience
//   childcareCredentials     → credentials
//   childcareTransport       → transport.offersTransport
//   childcareLimitations     → limitations
//   childcareReferences      → references
//   adultAgeAttested         → adultAgeAttested    (R25 adult-age evidence)
// `jurisdictionState` is NEVER asked — it is derived from the collected city
// (the CA pilot service area), because a caregiver typing a state code is not
// evidence of anything.
//
// Senior keys are ABSENT on purpose: `specialties`, `skills`, `services`,
// `certifications`, and `yearsExperience` are senior-vertical fields, and a
// childcare turn must not be able to write them (that would be exactly the
// approval/ratings bleed R-FD6 forbids).
// NOTE on the two boolean entries: `adultAgeAttested` and `childcareTransport`
// are required to have been ANSWERED, not required to be true. `isFieldFilled`
// treats `false` as filled, so "no, I won't drive kids" satisfies the transport
// gate and the funnel moves on — the capability is simply withheld (AE13:
// transport never blocks eligibility). `adultAgeAttested` is the exception and
// carries its own rule in `missingRequiredFields`: only an explicit `true`
// counts, because it is an ATTESTATION, not a preference.
export const CAREGIVER_CHILDCARE_REQUIRED_FIELDS: readonly string[] = [
  "name", "city",
  "yearsChildcareExperience", "childcareAgeBands", "childcareServices",
  "adultAgeAttested", "childcareTransport",
  "availability", "jobType", "hourlyRate", "email", "bio",
];

export const CAREGIVER_CHILDCARE_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CAREGIVER_CHILDCARE_REQUIRED_FIELDS,
  // Optional childcare delta the funnel captures but never blocks on:
  "childcareCredentials", "childcareLimitations", "childcareReferences",
  // Shared optional base fields (same keys, same meaning as senior):
  "zipCode", "gender", "languages", "canDrive", "bioSkipped", "jobTypes",
]);

/** R-FD4: nothing is collectable for a childcare CLIENT over the conversation. */
export const CLIENT_CHILDCARE_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>();
export const CLIENT_CHILDCARE_REQUIRED_FIELDS: readonly string[] = [];

// The step the flow advances to once conversational collection completes and the
// agent loop hands back to the deterministic gate machine. Client → the legacy
// post-collection step. Caregiver → the first upload gate (matches the scripted
// handoff: handleCaregiverAskBio sets caregiver_send_photo).
export const CLIENT_POST_COLLECTION_STEP = "client_ask_start";
export const CAREGIVER_FIRST_GATE_STEP = "caregiver_send_photo";

/**
 * Childcare caregiver post-collection handoff. NOT an upload gate: the childcare
 * enrollment sequence is vertical-profile upsert + policy acceptance → explicit
 * screening consent → shared-base-package screening → MANUAL operator review.
 * Owned by agents/childcareCaregiverFunnel.ts.
 */
export const CAREGIVER_CHILDCARE_FIRST_GATE_STEP = "childcare_caregiver_enroll";

/**
 * Childcare CLIENT post-collection handoff: the authenticated child-profile
 * form (R-FD4 — there is nothing to collect over text, so this is where the
 * conversation always points).
 */
export const CLIENT_CHILDCARE_POST_COLLECTION_STEP = "childcare_web_profile";

export function requiredFieldsFor(
  role: OnboardingRole,
  vertical?: OnboardingVertical | null,
): readonly string[] {
  if (normalizeVertical(vertical) === "child") {
    return role === "caregiver" ? CAREGIVER_CHILDCARE_REQUIRED_FIELDS : CLIENT_CHILDCARE_REQUIRED_FIELDS;
  }
  return role === "caregiver" ? CAREGIVER_REQUIRED_FIELDS : CLIENT_REQUIRED_FIELDS;
}

export function allowedFieldsFor(
  role: OnboardingRole,
  vertical?: OnboardingVertical | null,
): ReadonlySet<string> {
  if (normalizeVertical(vertical) === "child") {
    return role === "caregiver" ? CAREGIVER_CHILDCARE_ALLOWED_FIELDS : CLIENT_CHILDCARE_ALLOWED_FIELDS;
  }
  return role === "caregiver" ? CAREGIVER_ALLOWED_FIELDS : CLIENT_ALLOWED_FIELDS;
}

/** Senior-defaulting wrappers — kept so every existing call site is unchanged. */
export function requiredFieldsForRole(role: OnboardingRole): readonly string[] {
  return requiredFieldsFor(role, DEFAULT_ONBOARDING_VERTICAL);
}

export function allowedFieldsForRole(role: OnboardingRole): ReadonlySet<string> {
  return allowedFieldsFor(role, DEFAULT_ONBOARDING_VERTICAL);
}

export function isAllowedField(
  role: OnboardingRole,
  fieldName: string,
  vertical?: OnboardingVertical | null,
): boolean {
  return allowedFieldsFor(role, vertical).has(fieldName);
}

// The canonical jobType enum the downstream world (caregiver doc, matching,
// deriveJobDataFromIntake) expects. Mirrors JOB_TYPES in caregiverFieldAbsorber.ts
// and the scripted parser's clamp in onboardingSteps.caregiver.ts.
export const CAREGIVER_SENIOR_JOB_TYPES: ReadonlySet<string> = new Set([
  "occasional", "part_time", "full_time",
]);

/**
 * R-FD5: CAREGIVER_JOB_TYPES gains childcare job types. Childcare keeps the
 * three schedule shapes (a nanny can be part-time) and adds the engagement
 * shapes families actually search for.
 *
 * Scoped by vertical on purpose: `caregiverJobTypesFor("senior")` is still
 * EXACTLY the original three, so a senior caregiver can never be clamped to
 * "nanny" and the senior matching engine's enum is untouched.
 */
export const CAREGIVER_CHILDCARE_JOB_TYPES: ReadonlySet<string> = new Set([
  "occasional", "part_time", "full_time",
  "nanny", "babysitter", "after_school",
]);

/** The union — the widest set any caregiver jobType value may legitimately be. */
export const CAREGIVER_JOB_TYPES: ReadonlySet<string> = new Set([
  ...CAREGIVER_SENIOR_JOB_TYPES,
  ...CAREGIVER_CHILDCARE_JOB_TYPES,
]);

export function caregiverJobTypesFor(vertical?: OnboardingVertical | null): ReadonlySet<string> {
  return normalizeVertical(vertical) === "child"
    ? CAREGIVER_CHILDCARE_JOB_TYPES
    : CAREGIVER_SENIOR_JOB_TYPES;
}

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
  vertical?: OnboardingVertical | null,
): string[] {
  const d = data ?? {};
  return requiredFieldsFor(role, vertical).filter((f) => {
    if (role === "caregiver" && f === "bio" && d.bioSkipped === true) return false;
    // R25 adult-age evidence is an ATTESTATION, not a value: only an explicit
    // `true` counts. isFieldFilled would accept `false` (a boolean is "filled"),
    // which would let "no, I'm 16" satisfy the gate — so it gets its own rule,
    // mirroring the bioSkipped special case above.
    if (f === "adultAgeAttested") return d.adultAgeAttested !== true;
    return !isFieldFilled(d[f]);
  });
}

export function firstGateStep(
  role: OnboardingRole,
  vertical?: OnboardingVertical | null,
): string {
  if (normalizeVertical(vertical) === "child") {
    return role === "caregiver"
      ? CAREGIVER_CHILDCARE_FIRST_GATE_STEP
      : CLIENT_CHILDCARE_POST_COLLECTION_STEP;
  }
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
  /**
   * Childcare U5 (plan 2026-07-22-002, R47/R48): the session's typed care
   * vertical, when the caller has it. A "child"-stamped session NEVER routes
   * into the senior collection loop — childcare provider enrollment is
   * web/callable work (providerVerticalCallables.ts) until Stage 2 ships the
   * conversational childcare caregiver funnel. Optional and additive: senior
   * sessions carry no stamp, and callers that omit the field behave exactly as
   * before (the webhooks ingress already fail-closes childcare sessions
   * upstream; this is the defense-in-depth layer at the routing predicate).
   *
   * Front door Stage 1 note: this predicate returning `false` used to be the
   * WHOLE story for a caregiver childcare stamp, on the assumption that such a
   * stamp could never exist (the only origin was gated on `role === "client"`).
   * It can now. Returning false here is still correct — the senior loop is
   * exactly where they must not go — but it is no longer sufficient on its own:
   * linq/webhooks.ts routes childcare-stamped sessions to
   * childcare/signupIngress.ts BEFORE this predicate is consulted, and that
   * router owns the caregiver branch. Both layers are required; neither may be
   * removed on the grounds that the other exists.
   */
  careVertical?: string | null;
  /**
   * The unresolved/typed intent stamp (`"child"` | `"pending"` | `"senior"`).
   * Accepted so the predicate ALSO refuses a session whose vertical is still
   * being resolved: a pending session has no confirmed vertical, so it has no
   * business inside either collection funnel (R-FD1).
   */
  verticalIntent?: string | null;
}): boolean {
  const { role, step, hasText, hasMedia } = args;
  if (args.careVertical === "child" || args.verticalIntent === "child") return false;
  if (args.careVertical === "pending" || args.verticalIntent === "pending") return false;
  if (role !== "client" && role !== "caregiver") return false;
  if (!collectionStepsForRole(role).includes(step)) return false;
  if (!hasText || hasMedia) return false;
  return true;
}

/**
 * Childcare U5: typed guard for the SMS onboarding surfaces — true when a
 * session carries the typed childcare vertical stamp (careVertical /
 * verticalIntent, written only by the U4 ingress while the Firestore-resident
 * childcare flags are on). Senior sessions have neither field and always
 * return false. Used by senior-only scheduled sources (e.g.
 * onboardingReengagement) to explicitly skip childcare sessions rather than
 * sending them senior-flavored copy.
 */
export function isChildcareVerticalSession(
  session: { careVertical?: unknown; verticalIntent?: unknown } | null | undefined,
): boolean {
  return session?.careVertical === "child" || session?.verticalIntent === "child";
}

/**
 * Front door Stage 1 (R-FD1): true while a session's vertical is still being
 * RESOLVED — Evia has asked "adult or kids?" and is waiting. Distinct from
 * `isChildcareVerticalSession`: nothing is stamped yet, so the session belongs
 * to no vertical at all. Senior-only surfaces must skip these the same way they
 * skip childcare (memory/memoryEligibility already denies them under
 * `pending_classification`); a pending session must never be treated as senior
 * by default, which is exactly the guess R-FD1 forbids.
 */
export function isPendingVerticalSession(
  session: { careVertical?: unknown; verticalIntent?: unknown } | null | undefined,
): boolean {
  return session?.careVertical === "pending" || session?.verticalIntent === "pending";
}

/**
 * Front door Stage 2: true while the CHILDCARE CAREGIVER funnel is mid-flight on
 * this session (agents/childcareCaregiverFunnelTurn.ts owns the field).
 *
 * The funnel keeps its state in its own session namespace precisely so a
 * dual-vertical ADDITION does not disturb a live senior session (R-FD6) — which
 * means such a session is NOT childcare-stamped and would slip past
 * `isChildcareVerticalSession`. Senior-only scheduled sources must skip it
 * anyway: somebody two questions into a childcare profile has no business
 * getting "finish your bio" senior copy. Senior sessions carry no such field, so
 * this is a no-op for them.
 */
export const CHILDCARE_CAREGIVER_FUNNEL_SESSION_FIELD = "childcareCaregiverFunnel";

export function isChildcareCaregiverFunnelSession(
  session: Record<string, unknown> | null | undefined,
): boolean {
  const state = session?.[CHILDCARE_CAREGIVER_FUNNEL_SESSION_FIELD];
  return !!state && typeof state === "object" && typeof (state as { step?: unknown }).step === "string";
}
