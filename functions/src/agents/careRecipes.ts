import { LAUNCH_ACTION_PARITY } from "./launchActionParity";

export type CareRecipeRole = "client" | "caregiver" | "admin";

export type CareRecipeDeliveryRule =
  | "private_primary"
  | "caregiver_private"
  | "admin_only"
  | "no_outbound";

export interface CareRecipe {
  id: string;
  label: string;
  phrase: string;
  roleScope: readonly CareRecipeRole[];
  triggerPhrases: readonly string[];
  requiredContext: readonly string[];
  toolPlan: readonly string[];
  sideEffects?: readonly string[];
  authorityRule: string;
  deliveryRule: CareRecipeDeliveryRule;
  failureVisibility: string;
  parityIds: readonly string[];
}

export const CARE_RECIPES: readonly CareRecipe[] = [
  {
    id: "next_visit_briefing",
    label: "Next visit briefing",
    phrase: "pull up your next visit and who is coming",
    roleScope: ["client"],
    triggerPhrases: ["who is coming", "next visit", "when is care", "who is with mom"],
    requiredContext: ["client or family identity", "appointments"],
    toolPlan: ["get_upcoming_appointments", "get_care_team"],
    authorityRule: "Client and family members may read scoped visit/care-team details only.",
    deliveryRule: "private_primary",
    failureVisibility: "Failed appointment/care-team reads write cara_turn_metrics and admin_alerts when repeated.",
    parityIds: ["client-view-upcoming-appointments", "client-view-care-team"],
  },
  {
    id: "confirm_tomorrow_visit",
    label: "Confirm tomorrow visit",
    phrase: "confirm tomorrow's visit or ask the caregiver for an update",
    roleScope: ["client", "caregiver"],
    triggerPhrases: ["confirm tomorrow", "is caregiver coming", "confirm my shift"],
    requiredContext: ["appointment", "client or caregiver identity"],
    toolPlan: ["send_caregiver_message", "respond_to_booking_request"],
    authorityRule: "Clients may request confirmation; caregivers may confirm their own booking requests.",
    deliveryRule: "private_primary",
    failureVisibility: "Failed confirmation messages become failed ledger entries and admin alerts.",
    parityIds: ["client-message-caregiver", "caregiver-respond-booking-request"],
  },
  {
    id: "late_or_no_show_recovery",
    label: "Late/no-show recovery",
    phrase: "find backup care if a visit looks late or uncovered",
    roleScope: ["client", "admin"],
    triggerPhrases: ["caregiver late", "no show", "need backup", "not here"],
    requiredContext: ["appointment", "eligible caregiver supply"],
    toolPlan: ["start_replacement_flow"],
    authorityRule: "Clients can request backup; admin handles unsafe or unresolved coverage failures.",
    deliveryRule: "private_primary",
    failureVisibility: "Coverage failures are admin-visible and remain on the action ledger until resolved.",
    parityIds: ["client-find-caregiver"],
  },
  {
    id: "care_update_summary",
    label: "Care update summary",
    phrase: "catch you up on the latest care note",
    roleScope: ["client"],
    triggerPhrases: ["how is mom", "latest update", "what happened today"],
    requiredContext: ["care_journal"],
    toolPlan: ["get_care_journal_client"],
    authorityRule: "Family can read scoped care updates; no payment or private billing detail is included.",
    deliveryRule: "private_primary",
    failureVisibility: "Missing or failed care-journal reads are recorded in turn metrics.",
    parityIds: ["client-read-care-journal"],
  },
  {
    id: "approve_or_dispute_hours",
    label: "Approve or dispute hours",
    phrase: "review caregiver hours and approve or dispute them",
    roleScope: ["client"],
    triggerPhrases: ["approve hours", "dispute hours", "review timesheet"],
    requiredContext: ["primary client identity", "shiftHours"],
    toolPlan: ["get_pending_timesheets", "review_shift_hours"],
    authorityRule: "Only the primary client/account holder may approve, reject, or dispute payment.",
    deliveryRule: "private_primary",
    failureVisibility: "Failed approval/dispute writes admin alerts and keeps shiftHours non-terminal.",
    parityIds: ["client-view-timesheets", "client-approve-timesheet"],
  },
  {
    id: "caregiver_shift_closeout",
    label: "Caregiver shift closeout",
    phrase: "finish the visit with a closing note (hours are created from the completed shift)",
    roleScope: ["caregiver"],
    triggerPhrases: ["clock out", "finished visit", "end my shift"],
    requiredContext: ["caregiver identity", "active appointment or shift"],
    toolPlan: ["start_shift", "complete_shift"],
    authorityRule: "Caregivers can only start/complete their own assigned visits.",
    deliveryRule: "caregiver_private",
    failureVisibility: "Completion/payment rail failures become failed ledger entries and admin alerts.",
    parityIds: ["caregiver-start-shift", "caregiver-complete-shift"],
  },
  {
    id: "caregiver_pay_status",
    label: "Caregiver pay status",
    phrase: "check your latest hours, earnings, and payout status",
    roleScope: ["caregiver"],
    triggerPhrases: ["when do I get paid", "payout status", "earnings"],
    requiredContext: ["caregiver identity", "shiftHours or Stripe Connect"],
    toolPlan: ["show_payouts", "request_instant_payout"],
    authorityRule: "Caregivers may read and request payouts only for their own account.",
    deliveryRule: "caregiver_private",
    failureVisibility: "Payout failures remain admin-visible and cannot be reported as paid.",
    parityIds: ["caregiver-request-instant-payout"],
  },
  {
    id: "caregiver_referral",
    label: "Caregiver referral",
    phrase: "refer another caregiver without making them bookable until cleared",
    roleScope: ["caregiver"],
    triggerPhrases: ["refer a caregiver", "my friend wants to work", "invite caregiver"],
    requiredContext: ["referred name", "referred phone"],
    toolPlan: ["create_caregiver_referral"],
    authorityRule: "Referral creates an invite only; onboarding and Checkr clear still control bookability.",
    deliveryRule: "caregiver_private",
    failureVisibility: "Referral invite failures write agent_action_ledger and admin alerts.",
    parityIds: ["caregiver-refer-caregiver"],
  },
  {
    id: "memory_review_or_correction",
    label: "Memory review or correction",
    phrase: "show or fix what I remember about care preferences",
    roleScope: ["client", "caregiver"],
    triggerPhrases: ["what do you remember", "forget that", "actually her doctor is"],
    requiredContext: ["confirmed identity", "role-scoped memory"],
    toolPlan: ["cara_knows", "update_memory_file"],
    authorityRule: "Users may view or correct only memory they are authorized to see or update.",
    deliveryRule: "private_primary",
    failureVisibility: "Risky memory corrections are metric-visible and may create admin review alerts.",
    parityIds: ["client-review-cara-memory", "client-update-cara-memory"],
  },
];

export function getCareRecipesForRole(role: CareRecipeRole): CareRecipe[] {
  const shippedIds = new Set(
    LAUNCH_ACTION_PARITY.filter((row) => row.status === "shipped").map((row) => row.id),
  );

  return CARE_RECIPES.filter((recipe) =>
    recipe.roleScope.includes(role) &&
    recipe.parityIds.every((id) => shippedIds.has(id)),
  );
}

export function getCareRecipeExamples(role: CareRecipeRole, limit = 4): string[] {
  const max = Math.max(2, Math.min(5, limit));
  return getCareRecipesForRole(role)
    .map((recipe) => recipe.phrase)
    .slice(0, max);
}

export function findCareRecipe(id: string): CareRecipe | undefined {
  return CARE_RECIPES.find((recipe) => recipe.id === id);
}

export function findAdvertisedRecipeWithoutBacking(
  text: string,
  role: CareRecipeRole,
): CareRecipe | undefined {
  const shippedIds = new Set(
    LAUNCH_ACTION_PARITY.filter((row) => row.status === "shipped").map((row) => row.id),
  );
  const lower = text.toLowerCase();

  return CARE_RECIPES.find((recipe) => {
    if (!recipe.roleScope.includes(role)) return false;
    const advertised = [
      recipe.label,
      recipe.phrase,
      ...recipe.triggerPhrases,
    ].some((phrase) => phrase && lower.includes(phrase.toLowerCase()));
    if (!advertised) return false;
    return recipe.parityIds.some((id) => !shippedIds.has(id));
  });
}
