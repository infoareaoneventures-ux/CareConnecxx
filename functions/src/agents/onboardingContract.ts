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
// NOTE (caregiver interleaving): the caregiver flow interleaves transactional
// gates (photo/docs/membership/bgcheck/stripe) BETWEEN these conversational
// fields — unlike the client flow which collects everything, then gates. So a
// single "collect all, then hand to one gate" model fits the client cleanly but
// the caregiver needs segmented loop ↔ gate ↔ loop handling (tracked for the
// U3/U4 wiring). complete_collection's caregiver branch is therefore provisional.

export type OnboardingRole = "client" | "caregiver";

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
export const CLIENT_REQUIRED_FIELDS: readonly string[] = [
  "firstName", "seniorName", "age", "city", "schedule",
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
  "seniorName", "relationship", "careNeeds", "conditions",
  "startDate", "preferences", "budget",
]);

export const CAREGIVER_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...CAREGIVER_REQUIRED_FIELDS,
  "certifications",
]);

// The step the flow advances to once conversational collection completes and the
// agent loop hands back to the deterministic gate machine. Client → the legacy
// post-collection step. Caregiver → the first upload gate (provisional; see the
// interleaving note above).
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
