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

import { isOnboardingAgentLoopEnabled } from "../config/featureFlags";

export type OnboardingRole = "client" | "caregiver";

// Mirror of CLIENT_STEP_ORDER in onboardingConversation.ts — the conversational
// collection steps the agent loop owns (client-first). Kept here so the routing
// predicate stays in this pure leaf module. Must stay in sync with the legacy
// CLIENT_STEP_ORDER.
export const CLIENT_COLLECTION_STEPS: readonly string[] = [
  "client_ask_name", "client_ask_senior", "client_ask_needs",
  "client_ask_location", "client_ask_schedule",
];

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

// U4: whether this inbound onboarding turn should run inside the qaAgent loop
// (agent-native collection) instead of the scripted step runner. Client-first,
// flag-gated OFF by default, plain-text collection steps only — transactional
// gates (steps not in CLIENT_COLLECTION_STEPS) and media/location turns stay on
// the legacy handlers.
export function shouldRouteOnboardingToLoop(args: {
  role: string | undefined;
  step: string;
  hasText: boolean;
  hasMedia: boolean;
  hasLocation: boolean;
}): boolean {
  const { role, step, hasText, hasMedia, hasLocation } = args;
  if (role !== "client") return false;
  if (!isOnboardingAgentLoopEnabled("client")) return false;
  if (!CLIENT_COLLECTION_STEPS.includes(step)) return false;
  if (!hasText || hasMedia || hasLocation) return false;
  return true;
}
