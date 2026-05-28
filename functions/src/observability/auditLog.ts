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
  | "family_member_removed"
  | "senior_profile_updated"
  | "recurring_schedule_updated"
  | "appointment_rescheduled"
  | "care_journal_created"
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
  | "journal_comment_added";

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
