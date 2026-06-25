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
  | "standard_payout_requested";

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
