import type { Intent } from "./intentClassifier";
import type { McpTool } from "../mcp/server";

// Six capability buckets used to filter the 80+ MCP tools before each Sonnet
// turn. The goal is to reduce the tool surface Claude has to attend to per
// inbound, which cuts wrong-tool calls and shaves prompt-cache decode time.
// A tool may belong to multiple buckets if it's genuinely cross-cutting.
export type Capability =
  | "booking"      // matching, requests, hiring, appointments, jobs
  | "scheduling"   // recurring care, reminders, availability
  | "billing"      // invoices, payouts, refunds, payment methods, timesheets
  | "care_plan"    // care plan + journal + health + profiles
  | "messaging"    // family/caregiver messaging, communication
  | "memory_search"; // memory files, web search, credentials, external lookups

// Tools tagged with the capability buckets they belong to. Tools NOT listed
// here are "core" — always bound regardless of intent. Core tools are the
// universal reads Evia needs on virtually every turn (senior profile, search
// memory, suggest care, pending tasks, support tickets, agent resume).
export const TOOL_CAPABILITIES: Record<string, readonly Capability[]> = {
  // ── booking ──────────────────────────────────────────────────────────────
  start_booking_flow:           ["booking"],  // preferred entry point — see bookingFlow.ts
  start_resend_booking_flow:    ["booking"],
  get_resendable_booking_requests: ["booking"],  // the Interviews tab's Resend rows (2026-09-17)  // the site's Resend row, pre-filled review-and-edit — see bookingFlow.ts (2026-09-16)
  start_replacement_flow:       ["booking"],  // Find Replacement modal, step for step — see replacementFlow.ts
  start_reschedule_flow:        ["booking", "scheduling"],  // Reschedule button on an upcoming shift, step for step — see rescheduleFlow.ts
  start_visit_request_flow:     ["booking", "scheduling"],
  start_correction_flow:        ["billing"],  // Timesheets "Review submitted hours" modal, step for step — see correctionFlow.ts
  start_cancel_flow:            ["booking", "scheduling"],  // My Bookings cancel buttons, step for step — see cancelFlow.ts  // Calendar "+ Request Visit" modal, step for step — see visitRequestFlow.ts
  get_calendar:                 ["booking", "scheduling"],  // Calendar page reads (visits + interviews in a date range)
  get_caregiver_booking_rate:   ["booking"],  // U9b: read-only rate lookup
  get_callout_backups:          ["booking"],            // parity: real Find Replacement candidates (read)
  select_callout_backup:        ["booking"],            // parity: sends a real replacement booking request
  find_nearby_caregivers:       ["booking"],
  get_caregiver_info:           ["booking"],
  get_upcoming_appointments:    ["booking", "scheduling"],
  show_active_bookings:         ["booking", "scheduling"],  // Active Bookings tab, texted whole (2026-09-28)
  show_past_bookings:           ["booking", "scheduling"],  // Past Bookings tab, texted whole (2026-09-29)
  show_calendar:                ["booking", "scheduling"],  // My Calendar page, texted whole (2026-09-30)
  show_families:                ["booking", "messaging"],   // My Families page, texted whole (2026-09-30)
  start_log_hours_flow:         ["booking", "scheduling"],  // Past Bookings › Log Hours flow (2026-09-29)
  get_pending_booking_requests: ["booking", "scheduling"],
  show_booking_requests:        ["booking", "scheduling"],
  get_pending_schedule_amendments: ["booking", "scheduling"],  // Requests tab, schedule-change cards (2026-09-16)
  get_past_visits:              ["booking", "scheduling"],  // Past Bookings tab (2026-09-16)
  start_interview_flow:         ["booking"],  // preferred entry point — see interviewFlow.ts
  schedule_interview:           ["booking"],
  resend_caregiver_profile:     ["booking"],
  respond_to_interview_request: ["booking"],
  submit_interview_feedback:    ["booking"],
  start_review_flow:            ["booking"],  // the site's Leave a Review modal, step for step — see reviewFlow.ts
  save_caregiver_favorite:      ["booking"],
  unsave_caregiver_favorite:    ["booking"],
  start_apply_flow:             ["booking"],  // the Jobs page Apply modal, step for step — see caregiverJobFlows.ts
  start_interview_reschedule_flow: ["booking"],  // the interview Propose new time form — see caregiverJobFlows.ts
  respond_to_job_application:   ["booking"],
  list_client_jobs:             ["booking"],
  cancel_job_post:              ["booking"],
  edit_job_post:                ["booking"],
  list_job_applicants:          ["booking"],
  browse_job_board:             ["booking"],
  get_job_details:              ["booking"],
  hide_job:                     ["booking"],
  unhide_job:                   ["booking"],
  get_my_applications:          ["booking"],
  withdraw_job_application:     ["booking"],
  respond_to_booking_request:   ["booking", "messaging"],
  // Booking-pipeline parity (2026-08-30): booking_requests/shifts/booking_amendments
  // cancel/resend/amendment tools, mirroring My Bookings + Calendar.
  manage_booking:                ["booking"],
  request_schedule_amendment:    ["booking", "scheduling"],
  manage_shift_reschedule:       ["booking", "scheduling"], // caregiver-side counterpart to manage_booking's propose/accept/clear_reschedule

  // ── scheduling ───────────────────────────────────────────────────────────
  get_active_bookings:           ["booking", "scheduling"],
  schedule_followup:             ["scheduling"],
  update_caregiver_availability: ["scheduling"],
  get_caregiver_availability:    ["scheduling"],

  // ── billing ──────────────────────────────────────────────────────────────
  get_membership_page:      ["billing"],
  contact_support:          ["messaging"],  // the website's "Message our team" button — see utils/supportRoom.ts  // Membership page as data — see agents/membershipPage.ts
  get_notifications:        ["messaging"],  // the website's bell as data — see agents/notificationsPage.ts
  get_account_settings:     ["care_plan"],   // the website's Account Settings page as data — see agents/accountSettingsPage.ts
  set_subscription_status:  ["billing"],
  show_timesheets:          ["billing"],            // Payments › Timesheets tab, texted whole (2026-10-01)
  start_submit_hours_flow:  ["billing"],            // Timesheets › Submit hours modal as a flow (2026-10-01)
  start_review_correction_flow: ["billing"],        // Timesheets › Review correction modal as a flow (2026-10-01)
  get_payment_update_link:  ["billing"],
  retry_shift_payment:      ["billing"],            // parity 2026-07-06: agent mirror of v1-retryShiftPayment
  request_instant_payout:   ["billing"],
  show_payouts:             ["billing"],            // Payments › Payouts tab, texted whole (2026-10-01)
  get_payout_status:        ["billing"],
  review_shift_hours:       ["billing", "care_plan"],
  get_pending_timesheets:   ["billing"],

  // ── care_plan (includes journal, health, profiles) ──────────────────────
  get_care_journal_client:   ["care_plan"],
  get_care_plan:             ["care_plan"],
  update_care_plan:          ["care_plan"],
  create_senior_profile:     ["care_plan"],
  remove_care_recipient:     ["care_plan"],
  set_recipient_photo:       ["care_plan"],
  // U7
  create_job_post:           ["booking"],
  cancel_followup:           ["scheduling"],
  update_caregiver_profile:  ["care_plan"],
  pause_account:             ["scheduling"],
  reactivate_account:        ["scheduling"],
  update_user_profile:       ["care_plan"],
  delete_account:            ["care_plan"],
  start_shift:               ["care_plan", "scheduling"],
  complete_shift:            ["care_plan", "scheduling"],
  update_shift_task:         ["care_plan"],
  add_visit_note:            ["booking", "scheduling"],  // the visit-notes box (2026-09-28)
  get_background_check_status: ["care_plan", "booking"],
  // Final signup audit (2026-07-14) — cross-cutting profile/gates read; tagged
  // broadly so "did I miss anything?" reaches it under most filtered intents.
  get_signup_completeness:     ["care_plan", "booking", "billing"],
  // Checkr Candidate MCP bridge (2026-07-09) — caregiver-only, so the tags
  // never drive client intent-filtering; tagged to satisfy coverage.
  request_checkr_verification: ["care_plan"],
  verify_checkr_otp:           ["care_plan"],
  get_checkr_report:           ["care_plan"],

  // ── messaging (contact prefs, safety) ─────────────────────
  send_caregiver_message:           ["messaging"],
  send_client_message:              ["messaging"],
  create_caregiver_referral:        ["messaging", "booking"],
  get_recent_messages:              ["messaging"],
  update_preferences:               ["messaging"],
  request_email_change:             ["messaging"],
  set_block_status:                 ["messaging"],
  delete_conversation:              ["messaging"],
  mark_messages_read:               ["messaging"],

  // ── CRUD/parity gap closures (agent-native audit 2026-07) ───────────────
  list_interviews:            ["booking"],
  cancel_interview:           ["booking"],
  reschedule_interview:       ["booking"],
  accept_interview_reschedule: ["booking"],
  complete_interview:     ["booking"],
  list_blocked_users:     ["messaging"],

  // ── memory_search (memory files) ─────────────────────────────────────────
  read_memory_file:   ["memory_search"],
  update_memory_file: ["memory_search"],
  edit_memory_file:   ["memory_search"],
  delete_memory_file: ["memory_search"],
  search_memory:      ["memory_search"],

  // Note: untagged tools are "core" and always included.
  // Core tools:
  //   get_senior_profile, list_household_seniors, get_pending_tasks,
  //   get_care_team,
  //   resume_execution_agent, send_onboarding_link
};

// Tools that are ALWAYS bound regardless of intent. These are the universal
// reads Claude needs to orient itself on virtually every turn.
export const CORE_TOOL_NAMES = new Set<string>([
  "get_senior_profile",
  "list_household_seniors",
  "get_pending_tasks",
  "get_care_team",
  "resume_execution_agent",
  "write_todos",
  "cara_knows",
  "task",
  // U4: loop-control completion signal — must be available on every turn so the
  // agent can always end intentionally, never filtered out by intent.
  "complete_task",
  // Onboarding-loop writes (U1) — the agent's per-field save and the collection
  // handoff. Only meaningful during an onboarding turn; kept core so intent
  // filtering never strips them mid-collection.
  "save_onboarding_field",
  "complete_collection",
  // Cross-cutting onboarding helper: "send me my payment / identity / photo /
  // document / background-check / payout link" arrives under many filtered
  // intents (UPDATE_PAYMENT_METHOD, UPDATE_PHOTO, …). It must never be filtered
  // out, or Evia falls back to deflecting instead of just sending the link.
  "send_onboarding_link",
  // Outbound iMessage tapback (Linq reactions, 2026-07): an expressive,
  // intent-orthogonal nicety — Evia may want to heart a photo or thumbs-up a
  // confirmation under ANY intent, so it must never be filtered out.
  "react_to_message",
]);

// Intent → required capabilities. An empty array means "no filter — bind
// everything". This is the safe default for ambiguous intents (QUESTION,
// TASK_REPLY) where we don't want to lock Claude out of any tool.
//
// Mapping principles:
//   • Stay conservative on filtering — better to bind a few extra tools than
//     to deny Claude a tool it genuinely needs.
//   • For composite flows (cancel + notify, cancel + reschedule), include all
//     plausible capabilities even if one is the "primary" intent.
//   • UPDATE_ONBOARDING is unfiltered because it touches profile, schedule,
//     and care plan all at once.
export const INTENT_CAPABILITIES: Record<Intent, readonly Capability[]> = {
  // Broad / fall-through intents — no filter
  STOP:                 [],
  HELP:                 [],
  TASK_REPLY:           [],
  QUESTION:             [],
  UPDATE_ONBOARDING:    [],


  // Booking & matching
  REBOOK_REQUEST:        ["booking"],
  CANCEL_REQUEST:        ["booking", "messaging"],
  FIND_CAREGIVER:        ["booking"],
  BOOKING_CONFIRM:       ["booking", "messaging"],
  BOOKING_DECLINE:       ["booking", "messaging"],
  HIRE_CAREGIVER:        ["booking", "messaging"],
  RESCHEDULE_REQUEST:    ["booking", "scheduling", "messaging"],
  FIND_REPLACEMENT:      ["booking", "scheduling", "messaging"],
  CANCEL_SHIFT:          ["booking", "scheduling", "messaging"],

  // Job board
  POST_JOB:        ["booking"],
  VIEW_MY_JOBS:    ["booking"],
  VIEW_APPLICANTS: ["booking"],
  BROWSE_JOB_BOARD:["booking"],

  // Scheduling
  SCHEDULE_REQUEST:    ["scheduling"],
  TRIGGER_MANAGEMENT:  ["scheduling"],
  MODIFY_SCHEDULE:     ["scheduling", "messaging"],
  PAUSE_SCHEDULE:      ["scheduling", "messaging"],
  CANCEL_SCHEDULE:     ["scheduling", "messaging"],
  UPDATE_AVAILABILITY: ["scheduling"],
  PAUSE_ACCOUNT:       ["scheduling", "messaging"],
  REACTIVATE:          ["scheduling", "messaging"],

  // Billing
  UPDATE_PAYMENT_METHOD: ["billing"],
  VIEW_INVOICE:          ["billing"],
  VIEW_EARNINGS:         ["billing"],
  INSTANT_PAYOUT:        ["billing"],

  // Care plan
  VIEW_JOURNAL:            ["care_plan"],
  VIEW_CARE_PLAN_HISTORY:  ["care_plan"],
  UPDATE_RATE:             ["care_plan"],
  UPDATE_SKILLS:           ["care_plan"],
  UPDATE_BIO:              ["care_plan"],
  UPDATE_PHOTO:            ["care_plan"],

  // Memory / external actions
  MEMORY_QUERY:            ["memory_search", "care_plan"],
  FACT_CORRECTION:         ["memory_search", "care_plan"],
  CREDENTIAL_MANAGEMENT:   ["memory_search"],
  FIND_NEARBY_PROVIDER:    ["memory_search"],
  BOOK_DOCTOR_APPOINTMENT: ["memory_search", "messaging"],
  PRESCRIPTION_REFILL:     ["memory_search", "messaging"],
  NEW_PRESCRIPTION:        ["memory_search", "messaging"],
};

// ── High-stakes mutations ─────────────────────────────────────────────────
// Tools where falsely reporting success is harmful: the user would believe a
// booking / cancellation / charge / removal / profile change happened when it
// did not. When one of these returns a tool error, the agent loop surfaces it
// as an `is_error` tool_result with an explicit "do not claim success"
// instruction (see qaAgent.ts), instead of the soft buildToolResultContent
// path used for read-only lookups. Curated rather than prefix-derived so
// adding a tool here is a deliberate decision; genuinely low-stakes writes
// (memory notes Evia already echoes back) are intentionally excluded.
export const HIGH_STAKES_MUTATIONS = new Set<string>([
  // bookings & visits
  // interviews, hiring, jobs
  "schedule_interview", "respond_to_interview_request", "submit_interview_feedback",
  "complete_interview", "respond_to_job_application",
  "create_job_post", "edit_job_post", "cancel_job_post",
  // shifts
  "review_shift_hours",
  // money
  "set_subscription_status",
  "request_instant_payout", "retry_shift_payment",
  // people & safety
  "set_block_status",
  // care data
  "update_care_plan",
  // profiles & account
  "update_user_profile",
  "update_caregiver_profile", "update_caregiver_availability",
  "pause_account", "reactivate_account", "delete_account",
  // reminders & follow-ups
  "schedule_followup", "cancel_followup",
  // message relays (family/caregiver believe a message was delivered)
  "send_caregiver_message", "send_client_message",
  // CRUD/parity gap closures (agent-native audit 2026-07) — falsely reporting
  // an archive, member edit, interview cancel, or memory delete as done
  // would be believed and acted on.
  "cancel_interview",
  "reschedule_interview", "accept_interview_reschedule",
  "delete_memory_file", "remove_care_recipient",
  // Booking-pipeline parity (2026-08-30) — cancelling/resending a booking or
  // visit, or accepting/declining a schedule amendment, is exactly the kind
  // of mutation a family/caregiver would believe happened if we falsely
  // reported success.
  "manage_booking", "request_schedule_amendment",
  "manage_shift_reschedule", "select_callout_backup",
]);

/** True when a failed call to this tool must NOT be reported to the user as success. */
export function isHighStakesMutation(toolName: string): boolean {
  return HIGH_STAKES_MUTATIONS.has(toolName);
}

/**
 * Filter a tool list by the capabilities required for the given intent.
 *
 * Always returns at minimum the "core" tools (universal reads). For broad
 * intents (QUESTION, TASK_REPLY, UPDATE_ONBOARDING) or a null intent, the
 * full input list is returned unchanged.
 */
export function selectToolsForIntent(
  allTools: McpTool[],
  intent: Intent | null | undefined,
): McpTool[] {
  // Real-world healthcare/browser-automation tools were removed entirely
  // 2026-09-05 (no site equivalent) — there is no longer a medical-tool
  // allowlist to filter here.
  const launchTools = allTools;
  if (!intent) return launchTools;

  const required = INTENT_CAPABILITIES[intent];
  if (!required || required.length === 0) return launchTools;

  const requiredSet = new Set<Capability>(required);
  return launchTools.filter(t => {
    if (CORE_TOOL_NAMES.has(t.name)) return true;
    const caps = TOOL_CAPABILITIES[t.name];
    if (!caps || caps.length === 0) return true; // unmapped → safe default
    return caps.some(c => requiredSet.has(c));
  });
}

/** Sanity check: every tool in MCP_TOOLS should be either tagged or core. */
export function findUntaggedTools(allToolNames: string[]): string[] {
  return allToolNames.filter(
    n => !CORE_TOOL_NAMES.has(n) && !TOOL_CAPABILITIES[n],
  );
}
