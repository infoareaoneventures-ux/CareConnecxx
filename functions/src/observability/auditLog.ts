import * as admin from "firebase-admin";

const db = admin.firestore();

// 6-year TTL in milliseconds (HIPAA minimum retention)
const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;

export type AuditEventType =
  | "message_sent"
  | "message_received"
  | "health_data_accessed"
  | "booking_created"
  | "booking_cancelled"
  | "caregiver_matched"
  | "permissions_updated"
  | "preferences_updated"
  | "crisis_detected"
  | "session_created"
  | "safety_violation"
  | "interview_scheduled"
  | "profile_updated"
  | "review_submitted"
  | "subscription_cancelled"
  | "subscription_reactivated"
  | "family_member_added"
  | "family_member_invited"
  | "family_member_welcome_sent"
  | "family_member_welcome_failed"
  | "family_group_created"
  | "family_group_participant_added"
  | "family_group_participant_add_failed"
  | "family_member_removed"
  | "care_update_shared"
  | "referral_invited"
  | "senior_profile_updated"
  | "recurring_schedule_updated"
  | "appointment_rescheduled"
  | "care_journal_created"
  | "care_journal_updated"
  | "job_application_submitted"
  | "job_application_responded"
  | "interview_feedback_submitted"
  | "instant_payout_requested"
  | "shift_hours_submitted"
  | "shift_hours_reviewed"
  | "support_ticket_created"
  | "interview_responded"
  | "job_post_edited"
  | "job_post_cancelled"
  | "caregiver_sent_message"
  | "caregiver_availability_updated"
  | "billing_portal_opened"
  | "care_plan_restored"
  | "email_change_requested"
  | "favorite_saved"
  | "favorite_removed"
  | "user_blocked"
  | "user_unblocked"
  | "user_reported"
  | "journal_liked"
  | "journal_unliked"
  | "journal_comment_added"
  | "journal_comment_deleted"
  | "review_edited"
  | "followup_cancelled"
  | "invoice_created"
  | "invoice_sent"
  | "invoice_approved"
  | "invoice_rejected"
  | "invoice_auto_approved"
  | "invoice_deleted"
  // Admin execution callables (U3)
  | "caregiver_exception_reviewed"
  | "caregiver_document_reviewed"
  | "user_suspended"
  | "user_restored"
  | "support_ticket_responded"
  | "dispute_resolved"
  | "invoice_exception_reviewed"
  | "agent_action_retry_attempted"
  // Admin recovery callables (U4 / R6 / R16)
  | "linq_delivery_retry_attempted"
  | "pending_action_replay_attempted"
  | "pending_action_cancelled"
  | "recovery_owner_assigned"
  | "recovery_marked_complete"
  // Caregiver action events (mcp/server.ts)
  | "job_application_withdrawn"
  | "booking_request_responded"
  | "shift_started"
  | "shift_completed"
  | "shift_task_updated"
  | "media_update_submitted"
  | "shift_hour_correction_responded"
  | "standard_payout_requested"
  // CRUD-completeness tools (mcp/server.ts, 2026-07-03)
  | "senior_profile_archived"
  | "family_member_updated"
  | "interview_cancelled"
  | "memory_file_deleted"
  | "cash_payment_confirmed"
  // Memory-grounding U4b: durable completion records for cross-store fact
  // changes (scheduled/memoryOperationWorker.ts + mcp memory tools). Written
  // BEFORE the memory_operations record becomes expiry-eligible so the
  // accountability trail outlives the 30-day ledger retention. Data carries
  // event metadata (category, source) only — NEVER fact text.
  | "memory_fact_corrected"
  | "memory_fact_forgotten"
  // Codified 2026-07-21 (plan 2026-07-18-001 U0 typecheck-baseline repair):
  // these event names were already being written by mcp/server.ts at runtime
  // but were never declared here — the transpile-only build masked it.
  | "emergency_alert_raised"
  | "callout_backup_selected"
  | "callout_refund_requested"
  | "referral_sent"
  | "senior_profile_created"
  | "review_deleted"
  | "care_journal_hidden"
  | "support_ticket_updated"
  | "match_feedback_logged"
  | "job_post_created"
  | "proactive_draft_cancelled"
  | "shift_payment_retried"
  | "booking_payment_method_updated"
  | "journal_comment_edited"
  // U8 review callable (plan 2026-07-18-001)
  | "proactive_draft_approved"
  | "proactive_draft_rejected"
  // Childcare U2 (plan 2026-07-22-002): household + guardian-authority events
  // (childcare/householdRepository.ts, guardianAuthority.ts,
  // authorityCallables.ts). Data carries IDs/scopes/versions ONLY — never a
  // child name or other child PII (R57).
  | "household_created"
  | "household_invite_created"
  | "household_invite_accepted"
  | "guardian_authority_granted"
  | "guardian_authority_updated"
  | "guardian_authority_revoked"
  | "guardian_authority_dispute_hold"
  | "guardian_authority_dispute_resolved"
  // Childcare U3 (plan 2026-07-22-002): child profiles, restricted files, and
  // the privacy lifecycle. Event data carries IDs, versions, and counts only —
  // never a display label, exact DOB, safety detail, or file content (R57).
  | "child_profile_created"
  | "child_profile_callable_create"
  | "child_profile_aged_out"
  | "child_safety_version_appended"
  | "child_file_upload_intent"
  | "child_file_upload_confirmed"
  | "child_file_read_grant"
  | "child_file_upload_verified"
  | "child_file_object_rejected"
  | "child_file_scan_result"
  | "lifecycle_provider_task_completed"
  | "data_lifecycle_completed"
  | "adult_account_deletion_started"
  // Childcare U4 (plan 2026-07-22-002): family signup ingress, versioned
  // consent receipts, and the Stripe Identity gate. Event data carries IDs,
  // versions, states, and counts only — never child PII, message text, or a
  // callback nonce (R57).
  | "childcare_signup_ingress"
  | "childcare_objective_created"
  | "childcare_consent_receipts_recorded"
  | "childcare_consent_receipt_revoked"
  | "childcare_identity_session_created"
  | "childcare_identity_session_reused"
  | "childcare_identity_callback_consumed"
  | "childcare_identity_status_mirrored"
  // Childcare U5 — provider vertical profile, screening, eligibility
  | "childcare_vertical_profile_upserted"
  | "childcare_policy_accepted"
  | "childcare_screening_evidence_adopted"
  | "childcare_screening_invitation_sent"
  | "childcare_provider_approved"
  | "childcare_provider_approval_revoked"
  | "childcare_provider_suspended"
  | "childcare_provider_suspension_lifted"
  // Childcare U6 — jobs, applications, interviews (counts/IDs only — never
  // child facts, R57)
  | "childcare_job_created"
  | "childcare_job_closed"
  | "childcare_application_created"
  | "childcare_interview_requested"
  // Childcare U7 — booking state machine, safety projections, applications
  // (IDs, versions, states, counts only — never child facts, R57)
  | "childcare_booking_requested"
  | "childcare_booking_accepted"
  | "childcare_booking_declined"
  | "childcare_booking_confirmed"
  | "childcare_booking_canceled"
  | "childcare_booking_substituted"
  | "childcare_shift_checked_in"
  | "childcare_shift_checked_out"
  | "childcare_booking_safety_read"
  | "childcare_safety_projection_created"
  | "childcare_safety_projection_revoked"
  | "childcare_application_accepted"
  | "childcare_application_rejected"
  // Childcare U8 (shift payments, refunds, reviews, reputation)
  | "childcare_payment_pending_payer"
  | "childcare_payment_authorized"
  | "childcare_validated_hours_created"
  | "childcare_visit_overdue"
  | "childcare_refund_requested"
  | "childcare_payout_held"
  | "childcare_review_submitted"
  // Childcare U9 (context chat + notification privacy + coordination read)
  | "childcare_conversation_opened"
  | "childcare_coordination_read"
  // Childcare U11 (family-facing read seams — household member enumeration)
  | "childcare_household_members_listed"
  // Childcare U10 (Evia context/tools/memory-denial/incident seam) —
  // categories/ids only, never message content (R57)
  | "childcare_incident_escalated"
  // Childcare U12 (operator RBAC + incident cases + moderation) — scopes,
  // case ids, categories, states, and the R56 reason-for-access only; never
  // child PII, message text, or evidence content (R57)
  | "childcare_operator_access"
  | "childcare_incident_case_created"
  | "childcare_incident_status_changed"
  | "childcare_incident_assigned"
  | "childcare_incident_evidence_added"
  | "childcare_incident_party_excluded"
  | "childcare_incident_payout_hold"
  | "childcare_incident_litigation_hold"
  | "childcare_review_moderated";

export interface AuditEvent {
  eventType: AuditEventType;
  userId:    string;
  phone?:    string;
  data:      Record<string, unknown>;
  timestamp: string;
  ttl:       admin.firestore.Timestamp;
}

export async function logAudit(
  event: Omit<AuditEvent, "timestamp" | "ttl">
): Promise<void> {
  const now    = new Date();
  const ttlMs  = now.getTime() + SIX_YEARS_MS;

  try {
    await db.collection("agent_audit_log").add({
      ...event,
      timestamp: now.toISOString(),
      // Firestore TTL policy uses a Timestamp field to auto-delete expired docs
      ttl: admin.firestore.Timestamp.fromMillis(ttlMs),
    } satisfies AuditEvent);
  } catch (err) {
    // Audit log failure must never interrupt the main flow
    console.error("auditLog write error:", err);
  }
}

// Convenience wrappers for common event types

export function logMessageSent(
  userId: string,
  phone: string,
  chatId: string,
  messagePreview: string
): Promise<void> {
  return logAudit({
    eventType: "message_sent",
    userId,
    phone,
    data: { chatId, preview: messagePreview.slice(0, 200) },
  });
}

export function logHealthDataAccessed(
  userId: string,
  seniorId: string,
  source: string
): Promise<void> {
  return logAudit({
    eventType: "health_data_accessed",
    userId,
    data: { seniorId, source },
  });
}

export function logBookingCreated(
  userId: string,
  caregiverId: string,
  dates: string[]
): Promise<void> {
  return logAudit({
    eventType: "booking_created",
    userId,
    data: { caregiverId, dates },
  });
}

export function logCrisisDetected(
  phone: string,
  crisisType: "medical" | "emotional",
  text: string
): Promise<void> {
  return logAudit({
    eventType: "crisis_detected",
    userId:    phone,
    phone,
    data:      { crisisType, textPreview: text.slice(0, 100) },
  });
}
