// Policy for projecting audit events into the family-facing "Evia Activity"
// feed (Track C / U8). This module is PURE (no firebase-admin) so it can be
// unit-tested, and it is the single source of truth for three security
// guarantees the doc-review surfaced:
//
//  1. OPT-IN allow-list. `ACTIVITY_FEED_EVENTS` is typed `Record<AuditEventType,…>`,
//     so the functions build FAILS if a new audit event is added without an
//     explicit include/exclude decision. Unmapped/sensitive events never leak in.
//  2. NO data interpolation. Descriptions are STATIC per event type — they never
//     embed `data` (no names, message content, health details), so the feed
//     cannot carry PII no matter what the source event holds.
//  3. Owner resolution, not passthrough. `userId` on an audit event is NOT a
//     uniform Firebase Auth uid (it may be a phone, a caregiverId, 'system', or
//     empty). `ownerResolutionPlan` says how the trigger should resolve the
//     OWNING FAMILY's uid; the allow-list contains only family-side events, so a
//     resolved uid is always the family, never a caregiver.

import type { AuditEventType } from "../observability/auditLog";

/** A whitelisted, family-safe activity entry. No free-form/`data`-derived fields. */
export interface ActivityFeedEntry {
  ownerUid: string;
  eventType: AuditEventType;
  description: string;
  timestamp: string;
}

interface ActivityPolicy {
  /** Whether this event type is shown to families at all. */
  included: boolean;
  /** Static, PII-free description shown in the feed (only when included). */
  description?: string;
}

// Exhaustive policy map. `Record<AuditEventType, …>` forces every event type to
// appear — adding a new AuditEventType without a decision here breaks the build.
//
// INCLUDED = family-side actions Evia took on the family's behalf, with no
// sensitive content. EXCLUDED = sensitive (crisis/safety/health), caregiver-only,
// internal/system, failure-bookkeeping, and user-relayed actions (a user's own
// review/like/comment is not something "Evia did").
export const ACTIVITY_FEED_EVENTS: Record<AuditEventType, ActivityPolicy> = {
  // ── included: family-facing agent actions ───────────────────────────────
  message_sent:               { included: true,  description: "Evia sent a message to your care team." },
  booking_created:            { included: true,  description: "Evia booked a visit." },
  booking_cancelled:          { included: true,  description: "Evia cancelled a visit." },
  caregiver_matched:          { included: true,  description: "Evia matched you with a caregiver." },
  interview_scheduled:        { included: true,  description: "Evia scheduled an interview." },
  // interview_responded is logged keyed to the CAREGIVER (mcp/server.ts), not the
  // family — it can never resolve to the family owner, so it is excluded (like the
  // already-excluded caregiver-side interview_feedback_submitted). The projector's
  // family-only gate would skip it anyway; excluding here is clearer.
  interview_responded:        { included: false },
  appointment_rescheduled:    { included: true,  description: "Evia rescheduled a visit." },
  recurring_schedule_updated: { included: true,  description: "Evia updated your recurring schedule." },
  care_update_shared:         { included: true,  description: "Evia shared a care update with your family." },
  care_plan_restored:         { included: true,  description: "Evia restored a previous care plan version." },
  subscription_cancelled:     { included: true,  description: "Evia cancelled your subscription." },
  subscription_reactivated:   { included: true,  description: "Evia reactivated your subscription." },
  family_member_added:        { included: true,  description: "Evia added a family member to your group." },
  family_member_invited:      { included: true,  description: "Evia invited a family member to your group." },
  family_member_removed:      { included: true,  description: "Evia removed a family member from your group." },

  // ── excluded: sensitive / clinical ───────────────────────────────────────
  health_data_accessed:       { included: false },
  crisis_detected:            { included: false },
  safety_violation:           { included: false },

  // ── excluded: caregiver-only or caregiver-keyed ──────────────────────────
  caregiver_sent_message:     { included: false },
  caregiver_availability_updated: { included: false },
  instant_payout_requested:   { included: false },
  shift_hours_submitted:      { included: false },
  shift_hours_reviewed:       { included: false },
  job_application_submitted:  { included: false },
  job_application_responded:  { included: false },
  interview_feedback_submitted: { included: false },
  job_post_edited:            { included: false },
  job_post_cancelled:         { included: false },

  // ── excluded: internal / system / bookkeeping ────────────────────────────
  message_received:           { included: false },
  session_created:            { included: false },
  permissions_updated:        { included: false },
  preferences_updated:        { included: false },
  profile_updated:            { included: false },
  senior_profile_updated:     { included: false },
  billing_portal_opened:      { included: false },
  email_change_requested:     { included: false },
  support_ticket_created:     { included: false },
  referral_invited:           { included: false },
  family_member_welcome_sent: { included: false },
  family_member_welcome_failed: { included: false },
  family_group_created:       { included: false },
  family_group_participant_added: { included: false },
  family_group_participant_add_failed: { included: false },

  // ── excluded: user-relayed (the user's own action, not Evia's) ───────────
  review_submitted:           { included: false },
  care_journal_created:       { included: false },
  favorite_saved:             { included: false },
  favorite_removed:           { included: false },
  user_blocked:               { included: false },
  user_unblocked:             { included: false },
  user_reported:              { included: false },
  journal_liked:              { included: false },
  journal_unliked:            { included: false },
  journal_comment_added:      { included: false },
  journal_comment_deleted:    { included: false },
  review_edited:              { included: false },
  followup_cancelled:         { included: false },
  invoice_created:            { included: false },
  invoice_sent:               { included: false },
  invoice_approved:           { included: false },
  invoice_rejected:           { included: false },
  invoice_auto_approved:      { included: false },
  invoice_deleted:            { included: false },

  // ── excluded: codified 2026-07-21 (U0 typecheck-baseline repair) ──────────
  // These event types existed in (or were added to) AuditEventType without an
  // entry here; at runtime an unmapped event was already treated as excluded
  // (describeForFeed returned null), so every entry below preserves current
  // behavior exactly. Upgrading any of them to included is a product decision
  // that must add a static, PII-free description.
  care_journal_updated:               { included: false },
  caregiver_exception_reviewed:       { included: false },
  caregiver_document_reviewed:        { included: false },
  user_suspended:                     { included: false },
  user_restored:                      { included: false },
  support_ticket_responded:           { included: false },
  dispute_resolved:                   { included: false },
  invoice_exception_reviewed:         { included: false },
  agent_action_retry_attempted:       { included: false },
  linq_delivery_retry_attempted:      { included: false },
  pending_action_replay_attempted:    { included: false },
  pending_action_cancelled:           { included: false },
  recovery_owner_assigned:            { included: false },
  recovery_marked_complete:           { included: false },
  job_application_withdrawn:          { included: false },
  booking_request_responded:          { included: false },
  shift_started:                      { included: false },
  shift_completed:                    { included: false },
  shift_task_updated:                 { included: false },
  media_update_submitted:             { included: false },
  shift_hour_correction_responded:    { included: false },
  standard_payout_requested:          { included: false },
  senior_profile_archived:            { included: false },
  family_member_updated:              { included: false },
  interview_cancelled:                { included: false },
  memory_file_deleted:                { included: false },
  cash_payment_confirmed:             { included: false },
  memory_fact_corrected:              { included: false },
  memory_fact_forgotten:              { included: false },
  emergency_alert_raised:             { included: false },
  callout_backup_selected:            { included: false },
  callout_refund_requested:           { included: false },
  referral_sent:                      { included: false },
  senior_profile_created:             { included: false },
  review_deleted:                     { included: false },
  care_journal_hidden:                { included: false },
  support_ticket_updated:             { included: false },
  match_feedback_logged:              { included: false },
  job_post_created:                   { included: false },
  proactive_draft_cancelled:          { included: false },
  shift_payment_retried:              { included: false },
  booking_payment_method_updated:     { included: false },
  journal_comment_edited:             { included: false },
  proactive_draft_approved:           { included: false },
  proactive_draft_rejected:           { included: false },

  // ── excluded: childcare U2 household/guardian-authority events ────────────
  // Child-vertical authority bookkeeping never enters the SENIOR family
  // activity feed (plan 2026-07-22-002 R46/R57; the feed is a senior-vertical
  // surface — childcare surfaces arrive in U11 with their own projection).
  household_created:                   { included: false },
  household_invite_created:            { included: false },
  household_invite_accepted:           { included: false },
  guardian_authority_granted:          { included: false },
  guardian_authority_updated:          { included: false },
  guardian_authority_revoked:          { included: false },
  guardian_authority_dispute_hold:     { included: false },
  guardian_authority_dispute_resolved: { included: false },

  // ── excluded: childcare U3 child-profile / privacy-lifecycle events ───────
  // Same rule as U2: child-vertical events never enter the senior activity
  // feed (R46/R57) — and these additionally reference the most restricted
  // data zones on the platform. Childcare surfaces arrive in U11.
  child_profile_created:               { included: false },
  child_profile_callable_create:       { included: false },
  child_profile_aged_out:              { included: false },
  child_safety_version_appended:       { included: false },
  child_file_upload_intent:            { included: false },
  child_file_upload_confirmed:         { included: false },
  child_file_read_grant:               { included: false },
  child_file_upload_verified:          { included: false },
  child_file_object_rejected:          { included: false },
  child_file_scan_result:              { included: false },
  lifecycle_provider_task_completed:   { included: false },
  data_lifecycle_completed:            { included: false },
  adult_account_deletion_started:      { included: false },

  // Childcare U4 (plan 2026-07-22-002): same rule — child-vertical signup,
  // consent, and identity events never enter the senior activity feed
  // (R46/R57). Childcare-facing surfaces arrive in U11.
  childcare_signup_ingress:            { included: false },
  childcare_objective_created:         { included: false },
  childcare_consent_receipts_recorded: { included: false },
  childcare_consent_receipt_revoked:   { included: false },
  childcare_identity_session_created:  { included: false },
  childcare_identity_session_reused:   { included: false },
  childcare_identity_callback_consumed: { included: false },
  childcare_identity_status_mirrored:  { included: false },

  // Childcare U5 (plan 2026-07-22-002): provider vertical profile, screening
  // evidence, and eligibility events are childcare-vertical operational
  // records — never senior activity-feed content (R46/R57).
  childcare_vertical_profile_upserted:   { included: false },
  childcare_policy_accepted:             { included: false },
  childcare_screening_evidence_adopted:  { included: false },
  childcare_screening_invitation_sent:   { included: false },
  childcare_provider_approved:           { included: false },
  childcare_provider_approval_revoked:   { included: false },
  childcare_provider_suspended:          { included: false },
  childcare_provider_suspension_lifted:  { included: false },

  // Childcare U6 (plan 2026-07-22-002): job/application/interview events are
  // childcare-vertical operational records — never senior activity-feed
  // content (R46/R57). Childcare-facing surfaces arrive in U11.
  childcare_job_created:                 { included: false },
  childcare_job_closed:                  { included: false },
  childcare_application_created:         { included: false },
  childcare_interview_requested:         { included: false },
  // Childcare U7 (excluded: childcare events stay out of the senior-lineage
  // activity feed entirely until U11 ships an authenticated childcare surface;
  // no child data may transit a generic feed — R46/R57).
  childcare_booking_requested:           { included: false },
  childcare_booking_accepted:            { included: false },
  childcare_booking_declined:            { included: false },
  childcare_booking_confirmed:           { included: false },
  childcare_booking_canceled:            { included: false },
  childcare_booking_substituted:         { included: false },
  childcare_shift_checked_in:            { included: false },
  childcare_shift_checked_out:           { included: false },
  childcare_booking_safety_read:         { included: false },
  childcare_safety_projection_created:   { included: false },
  childcare_safety_projection_revoked:   { included: false },
  childcare_application_accepted:        { included: false },
  childcare_application_rejected:        { included: false },
  // Childcare U8 money/review events: excluded — money state and review
  // activity never transit the generic feed (R46/R57).
  childcare_payment_pending_payer:       { included: false },
  childcare_payment_authorized:          { included: false },
  childcare_validated_hours_created:     { included: false },
  childcare_visit_overdue:               { included: false },
  childcare_refund_requested:            { included: false },
  childcare_payout_held:                 { included: false },
  childcare_review_submitted:            { included: false },
  // Childcare U9: conversation/coordination events never enter the senior
  // activity feed (child-adjacent context stays out of broad surfaces, R57).
  childcare_conversation_opened:         { included: false },
  childcare_coordination_read:           { included: false },
  // Childcare U11: household member enumeration is an operator/family settings
  // read — never a broad activity-feed row (R57).
  childcare_household_members_listed:    { included: false },
  // Childcare U10: incident escalations are operator-only (U12 queue) — never
  // a family-visible feed row, and never any content beyond the category.
  childcare_incident_escalated:          { included: false },
  // Childcare U12: operator RBAC, restricted incident cases, and moderation
  // are operator/audit surfaces ONLY (R55-R57) — a family feed must never
  // reveal that a case exists, who accessed it, or why.
  childcare_operator_access:             { included: false },
  childcare_incident_case_created:       { included: false },
  childcare_incident_status_changed:     { included: false },
  childcare_incident_assigned:           { included: false },
  childcare_incident_evidence_added:     { included: false },
  childcare_incident_party_excluded:     { included: false },
  childcare_incident_payout_hold:        { included: false },
  childcare_incident_litigation_hold:    { included: false },
  childcare_review_moderated:            { included: false },
};

/** The static, PII-free description for an included event, or null if excluded. */
export function describeForFeed(eventType: AuditEventType): string | null {
  const policy = ACTIVITY_FEED_EVENTS[eventType];
  if (!policy || !policy.included) return null;
  return policy.description ?? null;
}

/** A phone-number-shaped string (E.164 or bare digits), not a Firebase uid. */
export function looksLikePhone(s: string | undefined | null): boolean {
  if (!s) return false;
  return /^\+?\d{7,15}$/.test(s.trim());
}

/**
 * How the trigger should resolve the OWNING FAMILY's Firebase Auth uid for an
 * audit event. Returns the phone to look up and/or a uid candidate to validate.
 * Because the allow-list contains only family-side events, a uid candidate here
 * is the family's uid — never a caregiver's.
 */
export function ownerResolutionPlan(
  event: { userId?: string; phone?: string }
): { phone?: string; uidCandidate?: string } {
  const plan: { phone?: string; uidCandidate?: string } = {};
  if (event.phone && looksLikePhone(event.phone)) plan.phone = event.phone.trim();
  if (looksLikePhone(event.userId)) {
    plan.phone = plan.phone ?? (event.userId as string).trim();
  } else if (event.userId && event.userId !== "system") {
    plan.uidCandidate = event.userId;
  }
  return plan;
}
