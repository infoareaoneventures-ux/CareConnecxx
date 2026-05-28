"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTENT_CAPABILITIES = exports.TOOL_CAPABILITIES = void 0;
exports.selectToolsForIntent = selectToolsForIntent;
exports.findUntaggedTools = findUntaggedTools;
// Tools tagged with the capability buckets they belong to. Tools NOT listed
// here are "core" — always bound regardless of intent. Core tools are the
// universal reads Cara needs on virtually every turn (senior profile, search
// memory, suggest care, pending tasks, support tickets, agent resume).
exports.TOOL_CAPABILITIES = {
    // ── booking ──────────────────────────────────────────────────────────────
    request_booking: ["booking"],
    find_replacement_caregivers: ["booking"],
    get_caregiver_info: ["booking"],
    get_caregiver_reviews: ["booking"],
    get_upcoming_appointments: ["booking", "scheduling"],
    get_caregiver_appointments: ["booking", "scheduling"],
    cancel_appointment: ["booking"],
    reschedule_appointment: ["booking", "scheduling"],
    schedule_interview: ["booking"],
    respond_to_interview_request: ["booking"],
    submit_interview_feedback: ["booking"],
    submit_review: ["booking"],
    save_caregiver_favorite: ["booking"],
    unsave_caregiver_favorite: ["booking"],
    list_saved_caregivers: ["booking"],
    apply_to_job: ["booking"],
    respond_to_job_application: ["booking"],
    list_client_jobs: ["booking"],
    cancel_job_post: ["booking"],
    edit_job_post: ["booking"],
    list_job_applicants: ["booking"],
    browse_job_board: ["booking"],
    get_job_recommendations: ["booking"],
    get_my_applications: ["booking"],
    request_shift_swap: ["booking", "scheduling", "messaging"],
    accept_shift_swap: ["booking", "scheduling", "messaging"],
    cancel_shift_swap: ["booking", "scheduling", "messaging"],
    initiate_client_swap: ["booking", "scheduling", "messaging"],
    // ── scheduling ───────────────────────────────────────────────────────────
    get_recurring_schedule: ["scheduling"],
    modify_recurring_schedule: ["scheduling"],
    manage_recurring_schedule: ["scheduling"],
    list_user_reminders: ["scheduling"],
    create_reminder: ["scheduling"],
    delete_reminder: ["scheduling"],
    schedule_followup: ["scheduling"],
    update_caregiver_availability: ["scheduling"],
    // ── billing ──────────────────────────────────────────────────────────────
    get_billing_summary: ["billing"],
    cancel_subscription: ["billing"],
    reactivate_subscription: ["billing"],
    get_invoice_history: ["billing"],
    get_invoice_details: ["billing"],
    create_refund_request: ["billing"],
    get_payment_update_link: ["billing"],
    request_instant_payout: ["billing"],
    get_payout_history: ["billing"],
    get_caregiver_earnings: ["billing"],
    submit_shift_hours: ["billing"],
    review_shift_hours: ["billing", "care_plan"],
    get_pending_timesheets: ["billing"],
    get_tax_summary: ["billing"],
    // ── care_plan (includes journal, health, profiles) ──────────────────────
    get_care_journal: ["care_plan"],
    get_care_journal_client: ["care_plan"],
    create_care_journal_entry: ["care_plan"],
    get_care_plan: ["care_plan"],
    update_care_plan: ["care_plan"],
    get_care_plan_history: ["care_plan"],
    restore_care_plan_version: ["care_plan"],
    get_health_signals: ["care_plan"],
    log_health_flag: ["care_plan"],
    like_journal_entry: ["care_plan", "messaging"],
    unlike_journal_entry: ["care_plan", "messaging"],
    comment_on_journal_entry: ["care_plan", "messaging"],
    update_caregiver_profile: ["care_plan"],
    update_senior_profile: ["care_plan"],
    update_user_profile: ["care_plan"],
    submit_gps_checkin: ["care_plan"],
    // ── messaging (family group, contact prefs, safety) ─────────────────────
    send_caregiver_message: ["messaging"],
    send_client_message: ["messaging"],
    get_recent_messages: ["messaging"],
    get_family_group: ["messaging"],
    add_family_member: ["messaging"],
    remove_family_member: ["messaging"],
    update_preferences: ["messaging"],
    update_communication_preferences: ["messaging"],
    request_email_change: ["messaging"],
    block_user: ["messaging"],
    unblock_user: ["messaging"],
    report_user: ["messaging"],
    // ── memory_search (memory files, web actions, credentials) ──────────────
    read_memory_file: ["memory_search"],
    update_memory_file: ["memory_search"],
    edit_memory_file: ["memory_search"],
    search_memory: ["memory_search"],
    search_web: ["memory_search"],
    perform_web_action: ["memory_search"],
    manage_credentials: ["memory_search"],
    // Note: untagged tools are "core" and always included.
    // Core tools:
    //   get_senior_profile, list_household_seniors, get_pending_tasks,
    //   suggest_upcoming_care, get_care_team, create_support_ticket,
    //   resume_execution_agent
};
// Tools that are ALWAYS bound regardless of intent. These are the universal
// reads Claude needs to orient itself on virtually every turn.
const CORE_TOOL_NAMES = new Set([
    "get_senior_profile",
    "list_household_seniors",
    "get_pending_tasks",
    "suggest_upcoming_care",
    "get_care_team",
    "create_support_ticket",
    "resume_execution_agent",
    "write_todos",
    "cara_knows",
    "task",
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
exports.INTENT_CAPABILITIES = {
    // Broad / fall-through intents — no filter
    STOP: [],
    TASK_REPLY: [],
    QUESTION: [],
    UPDATE_ONBOARDING: [],
    PERMISSION_UPDATE: ["messaging"],
    // Family group
    ADD_FAMILY_MEMBER: ["messaging"],
    REMOVE_FAMILY_MEMBER: ["messaging"],
    // Booking & matching
    REBOOK_REQUEST: ["booking"],
    CANCEL_REQUEST: ["booking", "messaging"],
    FIND_CAREGIVER: ["booking"],
    BOOKING_CONFIRM: ["booking", "messaging"],
    BOOKING_DECLINE: ["booking", "messaging"],
    HIRE_CAREGIVER: ["booking", "messaging"],
    CAREGIVER_DECLINE_JOB: ["booking", "messaging"],
    RESCHEDULE_REQUEST: ["booking", "scheduling", "messaging"],
    SWAP_REQUEST: ["booking", "scheduling", "messaging"],
    CLIENT_SWAP_REQUEST: ["booking", "scheduling", "messaging"],
    CANCEL_SHIFT: ["booking", "scheduling", "messaging"],
    // Job board
    POST_JOB: ["booking"],
    VIEW_MY_JOBS: ["booking"],
    VIEW_APPLICANTS: ["booking"],
    BROWSE_JOB_BOARD: ["booking"],
    // Scheduling
    SCHEDULE_REQUEST: ["scheduling"],
    TRIGGER_MANAGEMENT: ["scheduling"],
    MODIFY_SCHEDULE: ["scheduling", "messaging"],
    PAUSE_SCHEDULE: ["scheduling", "messaging"],
    CANCEL_SCHEDULE: ["scheduling", "messaging"],
    UPDATE_AVAILABILITY: ["scheduling"],
    PAUSE_ACCOUNT: ["scheduling", "messaging"],
    REACTIVATE: ["scheduling", "messaging"],
    // Billing
    UPDATE_PAYMENT_METHOD: ["billing"],
    REQUEST_REFUND: ["billing"],
    VIEW_INVOICE: ["billing"],
    VIEW_EARNINGS: ["billing"],
    INSTANT_PAYOUT: ["billing"],
    APPROVE_TIMESHEET: ["billing", "care_plan"],
    // Care plan
    VIEW_JOURNAL: ["care_plan"],
    VIEW_CARE_PLAN_HISTORY: ["care_plan"],
    UPDATE_RATE: ["care_plan"],
    UPDATE_SKILLS: ["care_plan"],
    UPDATE_BIO: ["care_plan"],
    UPDATE_PHOTO: ["care_plan"],
    // Memory / external actions
    MEMORY_QUERY: ["memory_search", "care_plan"],
    FACT_CORRECTION: ["memory_search", "care_plan"],
    CREDENTIAL_MANAGEMENT: ["memory_search"],
    FIND_NEARBY_PROVIDER: ["memory_search"],
    BOOK_DOCTOR_APPOINTMENT: ["memory_search", "messaging"],
    PRESCRIPTION_REFILL: ["memory_search", "messaging"],
    NEW_PRESCRIPTION: ["memory_search", "messaging"],
};
/**
 * Filter a tool list by the capabilities required for the given intent.
 *
 * Always returns at minimum the "core" tools (universal reads). For broad
 * intents (QUESTION, TASK_REPLY, UPDATE_ONBOARDING) or a null intent, the
 * full input list is returned unchanged.
 */
function selectToolsForIntent(allTools, intent) {
    if (!intent)
        return allTools;
    const required = exports.INTENT_CAPABILITIES[intent];
    if (!required || required.length === 0)
        return allTools;
    const requiredSet = new Set(required);
    return allTools.filter(t => {
        if (CORE_TOOL_NAMES.has(t.name))
            return true;
        const caps = exports.TOOL_CAPABILITIES[t.name];
        if (!caps || caps.length === 0)
            return true; // unmapped → safe default
        return caps.some(c => requiredSet.has(c));
    });
}
/** Sanity check: every tool in MCP_TOOLS should be either tagged or core. */
function findUntaggedTools(allToolNames) {
    return allToolNames.filter(n => !CORE_TOOL_NAMES.has(n) && !exports.TOOL_CAPABILITIES[n]);
}
//# sourceMappingURL=toolCapabilities.js.map