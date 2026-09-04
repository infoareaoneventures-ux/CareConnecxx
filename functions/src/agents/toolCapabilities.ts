import type { Intent } from "./intentClassifier";
import type { McpTool } from "../mcp/server";
import { MEDICAL_TOOL_NAMES, medicalActionsAvailable } from "./medicalBoundary";

// Six capability buckets used to filter the 80+ MCP tools before each Sonnet
// turn. The goal is to reduce the tool surface Claude has to attend to per
// inbound, which cuts wrong-tool calls and shaves prompt-cache decode time.
// A tool may belong to multiple buckets if it's genuinely cross-cutting.
export type Capability =
  | "booking"      // matching, requests, hiring, appointments, jobs, swaps
  | "scheduling"   // recurring care, reminders, availability
  | "billing"      // invoices, payouts, refunds, payment methods, timesheets
  | "care_plan"    // care plan + journal + health + profiles
  | "messaging"    // family/caregiver messaging, family group, communication
  | "memory_search"; // memory files, web search, credentials, external lookups

// Tools tagged with the capability buckets they belong to. Tools NOT listed
// here are "core" — always bound regardless of intent. Core tools are the
// universal reads Evia needs on virtually every turn (senior profile, search
// memory, suggest care, pending tasks, support tickets, agent resume).
export const TOOL_CAPABILITIES: Record<string, readonly Capability[]> = {
  // ── booking ──────────────────────────────────────────────────────────────
  request_booking:              ["booking"],
  get_caregiver_booking_rate:   ["booking"],  // U9b: read-only rate lookup
  quote_booking:                ["booking"],  // U9b: read-only cost estimate (no write)
  get_callout_backups:          ["booking"],            // parity: caregiver-callout backup options (read)
  select_callout_backup:        ["booking"],            // parity: assign a callout backup
  request_callout_refund:       ["booking", "billing"], // parity: callout refund request
  find_replacement_caregivers:  ["booking"],
  find_nearby_caregivers:       ["booking"],
  get_caregiver_info:           ["booking"],
  get_upcoming_appointments:    ["booking", "scheduling"],
  get_caregiver_appointments:   ["booking", "scheduling"],
  cancel_appointment:           ["booking"],
  reschedule_appointment:       ["booking", "scheduling"],
  schedule_interview:           ["booking"],
  respond_to_interview_request: ["booking"],
  submit_interview_feedback:    ["booking"],
  submit_review:                ["booking"],
  save_caregiver_favorite:      ["booking"],
  unsave_caregiver_favorite:    ["booking"],
  list_saved_caregivers:        ["booking"],
  apply_to_job:                 ["booking"],
  respond_to_job_application:   ["booking"],
  list_client_jobs:             ["booking"],
  cancel_job_post:              ["booking"],
  edit_job_post:                ["booking"],
  list_job_applicants:          ["booking"],
  browse_job_board:             ["booking"],
  get_job_recommendations:      ["booking"],
  get_my_applications:          ["booking"],
  request_shift_swap:           ["booking", "scheduling", "messaging"],
  accept_shift_swap:            ["booking", "scheduling", "messaging"],
  cancel_shift_swap:            ["booking", "scheduling", "messaging"],
  initiate_client_swap:         ["booking", "scheduling", "messaging"],
  withdraw_job_application:     ["booking"],
  respond_to_booking_request:   ["booking", "messaging"],
  // Booking-pipeline parity (2026-08-30): booking_requests/shifts/booking_amendments
  // cancel/resend/amendment tools, mirroring My Bookings + Calendar.
  manage_booking:                ["booking"],
  request_schedule_amendment:    ["booking", "scheduling"],
  respond_to_schedule_amendment: ["booking", "scheduling"],

  // ── scheduling ───────────────────────────────────────────────────────────
  get_recurring_schedule:        ["scheduling"],
  modify_recurring_schedule:     ["scheduling"],
  manage_recurring_schedule:     ["scheduling"],
  list_user_reminders:           ["scheduling"],
  create_reminder:               ["scheduling"],
  update_reminder:               ["scheduling"],  // CRUD: reminder UPDATE
  delete_reminder:               ["scheduling"],
  schedule_followup:             ["scheduling"],
  update_caregiver_availability: ["scheduling"],
  get_caregiver_availability:    ["scheduling"],

  // ── billing ──────────────────────────────────────────────────────────────
  get_billing_summary:      ["billing"],
  set_subscription_status:  ["billing"],
  get_invoice_history:      ["billing"],
  get_invoice_details:      ["billing"],
  create_refund_request:    ["billing"],
  get_refund_requests:      ["billing"],
  get_shifts:               ["billing"],
  get_payment_update_link:  ["billing"],
  retry_shift_payment:      ["billing"],            // parity 2026-07-06: agent mirror of v1-retryShiftPayment
  request_instant_payout:   ["billing"],
  respond_to_shift_hour_correction: ["billing"],
  get_payout_history:       ["billing"],
  get_payout_status:        ["billing"],
  get_caregiver_earnings:   ["billing"],
  submit_shift_hours:       ["billing"],
  review_shift_hours:       ["billing", "care_plan"],
  get_pending_timesheets:   ["billing"],
  get_tax_summary:          ["billing"],

  // ── care_plan (includes journal, health, profiles) ──────────────────────
  get_care_journal:          ["care_plan"],
  get_care_journal_client:   ["care_plan"],
  create_care_journal_entry: ["care_plan"],
  update_care_journal_entry: ["care_plan"],
  get_care_plan:             ["care_plan"],
  update_care_plan:          ["care_plan"],
  get_care_plan_history:     ["care_plan"],
  restore_care_plan_version: ["care_plan"],
  get_health_signals:        ["care_plan"],
  log_health_flag:           ["care_plan"],
  create_senior_profile:     ["care_plan"],
  remove_care_recipient:     ["care_plan"],
  // U7
  delete_care_journal_entry: ["care_plan"],
  delete_review:             ["booking"],
  log_match_feedback:        ["booking"],
  create_job_post:           ["booking"],
  list_proactive_drafts:     ["scheduling"],
  cancel_proactive_draft:    ["scheduling"],
  like_journal_entry:        ["care_plan", "messaging"],
  unlike_journal_entry:      ["care_plan", "messaging"],
  comment_on_journal_entry:  ["care_plan", "messaging"],
  edit_comment:              ["care_plan", "messaging"],  // CRUD: journal-comment UPDATE
  delete_comment:            ["care_plan", "messaging"],
  edit_review:               ["booking"],
  cancel_followup:           ["scheduling"],
  update_caregiver_profile:  ["care_plan"],
  pause_account:             ["scheduling"],
  reactivate_account:        ["scheduling"],
  accept_shift:              ["booking", "scheduling"],
  decline_shift:             ["booking", "scheduling"],
  update_senior_profile:     ["care_plan"],
  update_user_profile:       ["care_plan"],
  delete_account:            ["care_plan"],
  submit_gps_checkin:        ["care_plan"],
  start_shift:               ["care_plan", "scheduling"],
  complete_shift:            ["care_plan", "scheduling"],
  update_shift_task:         ["care_plan"],
  submit_media_update:       ["care_plan", "messaging"],
  get_background_check_status: ["care_plan", "booking"],
  // Final signup audit (2026-07-14) — cross-cutting profile/gates read; tagged
  // broadly so "did I miss anything?" reaches it under most filtered intents.
  get_signup_completeness:     ["care_plan", "booking", "billing"],
  // Checkr Candidate MCP bridge (2026-07-09) — caregiver-only, so the tags
  // never drive client intent-filtering; tagged to satisfy coverage.
  request_checkr_verification: ["care_plan"],
  verify_checkr_otp:           ["care_plan"],
  get_checkr_report:           ["care_plan"],

  // ── messaging (family group, contact prefs, safety) ─────────────────────
  send_caregiver_message:           ["messaging"],
  send_client_message:              ["messaging"],
  create_caregiver_referral:        ["messaging", "booking"],
  get_recent_messages:              ["messaging"],
  get_family_group:                 ["messaging"],
  add_family_member:                ["messaging"],
  remove_family_member:             ["messaging"],
  update_preferences:               ["messaging"],
  update_communication_preferences: ["messaging"],
  set_visit_update_frequency:       ["messaging"],
  request_email_change:             ["messaging"],
  set_block_status:                 ["messaging"],
  delete_conversation:              ["messaging"],
  mark_messages_read:               ["messaging"],
  get_support_tickets:              ["messaging"],

  // ── CRUD/parity gap closures (agent-native audit 2026-07) ───────────────
  archive_senior_profile: ["care_plan"],
  update_family_member:   ["messaging"],
  list_interviews:        ["booking"],
  cancel_interview:       ["booking"],
  complete_interview:     ["booking"],
  list_blocked_users:     ["messaging"],
  list_shift_swaps:       ["booking", "scheduling", "messaging"],

  // ── memory_search (memory files, web actions, credentials) ──────────────
  read_memory_file:   ["memory_search"],
  update_memory_file: ["memory_search"],
  edit_memory_file:   ["memory_search"],
  delete_memory_file: ["memory_search"],
  search_memory:      ["memory_search"],
  search_web:         ["memory_search"],
  perform_web_action: ["memory_search"],
  manage_credentials: ["memory_search"],
  // U9: public web primitives decomposed from perform_web_action
  search_healthcare_provider: ["memory_search"],
  fetch_web_page:             ["memory_search"],
  browse_web:                 ["memory_search"],

  // Note: untagged tools are "core" and always included.
  // Core tools:
  //   get_senior_profile, list_household_seniors, get_pending_tasks,
  //   suggest_upcoming_care, get_care_team, create_support_ticket,
  //   resume_execution_agent, send_onboarding_link
};

// Tools that are ALWAYS bound regardless of intent. These are the universal
// reads Claude needs to orient itself on virtually every turn.
export const CORE_TOOL_NAMES = new Set<string>([
  "get_senior_profile",
  "list_household_seniors",
  "get_pending_tasks",
  // Unified WIP view — like get_pending_tasks, an orientation read the agent
  // may need under any intent ("what are you working on for me?").
  "get_work_in_progress",
  "suggest_upcoming_care",
  "get_care_team",
  "create_support_ticket",
  // U7: support-ticket read/lifecycle — like create_support_ticket, these can
  // be needed under many intents (a status check mid-conversation), so they're
  // core rather than bucket-filtered.
  "get_support_ticket",
  "list_support_tickets",
  "update_support_ticket",
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
  // Native location request (2026-06-29): needed mid-onboarding (address pin)
  // and on profile/service-area updates under many intents — never filter.
  "request_location",
  // Cross-cutting onboarding helper: "send me my payment / identity / photo /
  // document / background-check / payout link" arrives under many filtered
  // intents (UPDATE_PAYMENT_METHOD, UPDATE_PHOTO, …). It must never be filtered
  // out, or Evia falls back to deflecting instead of just sending the link.
  "send_onboarding_link",
  // Parity: emergency alert is SAFETY-critical — it must be bound on every turn
  // and never filtered out by intent, so a family reporting an urgent situation
  // can always reach it.
  "trigger_emergency_alert",
  // Parity: referral send/status don't map to a logistics bucket and are
  // low-risk; keep them always-available rather than guessing an intent.
  "send_referral",
  "get_referral_status",
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
//   • For composite flows (cancel + notify, swap + reschedule), include all
//     plausible capabilities even if one is the "primary" intent.
//   • UPDATE_ONBOARDING is unfiltered because it touches profile, schedule,
//     family group, and care plan all at once.
export const INTENT_CAPABILITIES: Record<Intent, readonly Capability[]> = {
  // Broad / fall-through intents — no filter
  STOP:                 [],
  HELP:                 [],
  TASK_REPLY:           [],
  QUESTION:             [],
  UPDATE_ONBOARDING:    [],
  PERMISSION_UPDATE:    ["messaging"],

  // Family group
  ADD_FAMILY_MEMBER:    ["messaging"],
  REMOVE_FAMILY_MEMBER: ["messaging"],

  // Booking & matching
  REBOOK_REQUEST:        ["booking"],
  CANCEL_REQUEST:        ["booking", "messaging"],
  FIND_CAREGIVER:        ["booking"],
  BOOKING_CONFIRM:       ["booking", "messaging"],
  BOOKING_DECLINE:       ["booking", "messaging"],
  HIRE_CAREGIVER:        ["booking", "messaging"],
  CAREGIVER_DECLINE_JOB: ["booking", "messaging"],
  RESCHEDULE_REQUEST:    ["booking", "scheduling", "messaging"],
  SWAP_REQUEST:          ["booking", "scheduling", "messaging"],
  CLIENT_SWAP_REQUEST:   ["booking", "scheduling", "messaging"],
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
  REQUEST_REFUND:        ["billing"],
  VIEW_INVOICE:          ["billing"],
  VIEW_EARNINGS:         ["billing"],
  INSTANT_PAYOUT:        ["billing"],
  APPROVE_TIMESHEET:     ["billing", "care_plan"],

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
// (journal likes/comments, memory notes Evia already echoes back) are
// intentionally excluded.
export const HIGH_STAKES_MUTATIONS = new Set<string>([
  // bookings & visits
  "request_booking", "reschedule_appointment", "cancel_appointment",
  "manage_recurring_schedule", "modify_recurring_schedule", "initiate_client_swap",
  // interviews, hiring, jobs
  "schedule_interview", "respond_to_interview_request", "submit_interview_feedback",
  "complete_interview", "respond_to_job_application", "apply_to_job",
  "create_job_post", "edit_job_post", "cancel_job_post",
  // shifts
  "accept_shift", "decline_shift", "submit_shift_hours", "review_shift_hours",
  "request_shift_swap", "accept_shift_swap", "cancel_shift_swap", "submit_gps_checkin",
  // money
  "set_subscription_status", "create_refund_request",
  "request_instant_payout", "retry_shift_payment",
  // people & safety
  "add_family_member", "remove_family_member", "set_block_status",
  // care data
  "update_senior_profile", "update_care_plan", "restore_care_plan_version",
  "create_care_journal_entry", "log_health_flag",
  // profiles & account
  "update_user_profile", "update_communication_preferences",
  "update_caregiver_profile", "update_caregiver_availability",
  "pause_account", "reactivate_account", "delete_account",
  // reminders & follow-ups
  "create_reminder", "delete_reminder", "schedule_followup", "cancel_followup",
  // message relays (family/caregiver believe a message was delivered)
  "send_caregiver_message", "send_client_message",
  // CRUD/parity gap closures (agent-native audit 2026-07) — falsely reporting
  // an archive, member edit, interview cancel, or memory delete as done
  // would be believed and acted on.
  "archive_senior_profile", "update_family_member", "cancel_interview",
  "delete_memory_file", "remove_care_recipient",
  // Booking-pipeline parity (2026-08-30) — cancelling/resending a booking or
  // visit, or accepting/declining a schedule amendment, is exactly the kind
  // of mutation a family/caregiver would believe happened if we falsely
  // reported success.
  "manage_booking", "request_schedule_amendment", "respond_to_schedule_amendment",
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
  const launchTools = medicalActionsAvailable()
    ? allTools
    : allTools.filter(tool => !MEDICAL_TOOL_NAMES.has(tool.name));
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
