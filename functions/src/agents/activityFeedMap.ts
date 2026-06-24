// Policy for projecting audit events into the family-facing "Cara Activity"
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
// INCLUDED = family-side actions Cara took on the family's behalf, with no
// sensitive content. EXCLUDED = sensitive (crisis/safety/health), caregiver-only,
// internal/system, failure-bookkeeping, and user-relayed actions (a user's own
// review/like/comment is not something "Cara did").
export const ACTIVITY_FEED_EVENTS: Record<AuditEventType, ActivityPolicy> = {
  // ── included: family-facing agent actions ───────────────────────────────
  message_sent:               { included: true,  description: "Cara sent a message to your care team." },
  booking_created:            { included: true,  description: "Cara booked a visit." },
  booking_cancelled:          { included: true,  description: "Cara cancelled a visit." },
  caregiver_matched:          { included: true,  description: "Cara matched you with a caregiver." },
  interview_scheduled:        { included: true,  description: "Cara scheduled an interview." },
  interview_responded:        { included: true,  description: "Cara handled an interview response." },
  appointment_rescheduled:    { included: true,  description: "Cara rescheduled a visit." },
  recurring_schedule_updated: { included: true,  description: "Cara updated your recurring schedule." },
  care_update_shared:         { included: true,  description: "Cara shared a care update with your family." },
  care_plan_restored:         { included: true,  description: "Cara restored a previous care plan version." },
  subscription_cancelled:     { included: true,  description: "Cara cancelled your subscription." },
  subscription_reactivated:   { included: true,  description: "Cara reactivated your subscription." },
  family_member_added:        { included: true,  description: "Cara added a family member to your group." },
  family_member_invited:      { included: true,  description: "Cara invited a family member to your group." },
  family_member_removed:      { included: true,  description: "Cara removed a family member from your group." },

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

  // ── excluded: user-relayed (the user's own action, not Cara's) ───────────
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
