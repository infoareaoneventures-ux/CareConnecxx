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

import { isOnboardingAgentLoopEnabled, isPhoneInOnboardingCohort } from "../config/featureFlags";

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
  "certifications", "skills", "zipCode", "gender", "languages", "canDrive",
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

// Required fields still missing from the collected data, in flow order.
export function missingRequiredFields(
  role: OnboardingRole,
  data: Record<string, unknown> | undefined,
): string[] {
  const d = data ?? {};
  return requiredFieldsForRole(role).filter((f) => !isFieldFilled(d[f]));
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

// U4: whether this inbound onboarding turn should run inside the qaAgent loop
// (agent-native collection) instead of the scripted step runner. Per-role and
// flag-gated OFF by default (ONBOARDING_AGENT_LOOP must name the role — e.g.
// "client" or "client,caregiver"), plain-text collection steps only —
// transactional gates (steps not in that role's collection list) and
// media/location turns stay on the legacy handlers.
export function shouldRouteOnboardingToLoop(args: {
  role: string | undefined;
  step: string;
  hasText: boolean;
  hasMedia: boolean;
  hasLocation: boolean;
  // The inbound phone — used for canary cohort scoping. Optional: when omitted,
  // cohort membership is decided as if no narrowing is active (default 100%).
  phone?: string;
}): boolean {
  const { role, step, hasText, hasMedia, hasLocation, phone } = args;
  if (role !== "client" && role !== "caregiver") return false;
  if (!isOnboardingAgentLoopEnabled(role)) return false;
  if (!collectionStepsForRole(role).includes(step)) return false;
  if (!hasText || hasMedia || hasLocation) return false;
  // Canary cohort: a narrowed rollout (a % or an allowlist) only routes the phones
  // in-cohort; default (no narrowing) routes everyone in the enabled role.
  if (!isPhoneInOnboardingCohort(phone)) return false;
  return true;
}
