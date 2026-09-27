// Human-readable label for an onboarding step, for the two reminder jobs
// (onboardingReengagement, staleSessionNudge) and the website bell copy they
// share (2026-09-26). Pure leaf — no imports.
export function humanLabelForStep(step: string): string {
  const map: Record<string, string> = {
    verify_phone:                       "verifying your phone number",
    ask_role:                           "picking a role",
    // Client steps
    client_ask_name:                    "sharing your name",
    client_ask_senior:                  "telling me who needs care",
    client_ask_needs:                   "describing the care needs",
    client_ask_location:                "sharing the location",
    client_ask_schedule:                "setting the schedule",
    client_ask_start:                   "choosing a start date",
    client_ask_preferences:             "sharing caregiver preferences",
    client_ask_budget:                  "sharing a budget",
    client_confirm_intake:              "confirming the details",
    client_ask_plan:                    "choosing your membership",
    client_send_payment:                "starting your membership",
    client_awaiting_identity:           "verifying your identity",
    client_awaiting_payment:            "starting your membership",
    job_confirm_prefill:                "posting your care request",
    // Caregiver steps (= the site wizard's order)
    caregiver_ask_name:                 "sharing your name",
    caregiver_ask_location:             "sharing your address",
    caregiver_ask_experience:           "sharing your experience",
    caregiver_ask_specialties:          "listing your care services",
    caregiver_ask_profile:              "a couple profile details",
    caregiver_ask_availability:         "sharing your availability",
    caregiver_ask_job_type:             "choosing job type",
    caregiver_ask_rate:                 "setting your rate",
    caregiver_ask_email:                "sharing your email",
    caregiver_ask_bio:                  "writing your bio",
    caregiver_send_membership:          "completing your membership payment",
    caregiver_awaiting_membership:      "completing your membership payment",
    caregiver_send_bgcheck:             "authorizing your background check",
    caregiver_awaiting_bgcheck_consent: "authorizing your background check",
    caregiver_awaiting_bgcheck:         "finishing your background check",
    caregiver_send_stripe_connect:      "setting up your payout account",
    caregiver_awaiting_stripe:          "setting up your payout account",
  };
  return map[step] ?? "finishing your profile";
}
