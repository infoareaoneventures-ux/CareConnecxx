import * as admin from "firebase-admin";

export const STATE_MACHINE_FLAGS = [
  "hireMode",
  "hireModeDate",
  "pendingTimeSelection",
  "pendingRebook",
  "pendingInterviewOutcome",
  "pendingMatches",
  "pendingCancelConfirm",
  "pendingInterviewConfirm",
  "awaitingRecurringConfirmation",
  "pendingRecurringSchedule",
  "awaitingCareNotes",
  "awaitingLateMinutes",
  "awaitingIssueDescription",
  "caregiverRescheduling",
  "pendingInterviewAvailabilityRequest",
  "awaitingJobResponse",
  "awaitingAvailabilityConfirmation",
  "pendingShiftApproval",
  "pendingDisputeDetail",
  "pendingAddFamilyMember",
  "collectingCredential",
  "stateExpiresAt",
  "jobPostingStep",
  "jobPostingData",
  // Recurring schedule modification flow
  "modifyScheduleStep",
  "modifyScheduleData",
  // Mid-shift task acknowledgment flow
  "awaitingTaskAck",
  // Pre-shift family task check-in
  "awaitingPreShiftUpdate",
  // Day-before shift confirmation from caregiver
  "pendingShiftConfirmation",
  // Day-before shift confirmation from CLIENT (family)
  "pendingClientShiftConfirm",
  // Caregiver shift swap flow
  "swapStep",
  "swapCandidates",
  "swapShiftId",
  "swapShiftDate",
  "swapClientId",
  // Swap acceptance (for caregivers contacted about covering a shift)
  "pendingSwapRequestId",
  "pendingSwapFromName",
  // Client caregiver swap flow
  "clientSwapStep",
  "clientSwapVisits",
  "clientSwapAppointmentId",
  "clientSwapDate",
  "clientSwapOptions",
  // Healthcare agentic flows (provider search, appointment booking, Rx refill, new Rx)
  "healthcareFlowStep",
  "healthcareFlowData",
  // Timesheet approval flow
  "timesheetStep",
  "pendingTimesheetId",
  "pendingTimesheetDesc",
  "pendingTimesheetQueue",
  // Availability update flow
  "availabilityStep",
  "pendingAvailability",
  // Refund flow
  "refundStep",
  "refundCandidates",
  "refundAppointmentId",
  "refundVisitDescription",
  "refundReason",
  // Caregiver-initiated shift cancellation flow
  "cancelStep",
  "cancelCandidates",
  "cancelShiftId",
  "cancelShiftDate",
  "cancelShiftClientId",
  "cancelReason",
  // Caregiver profile update flow (rate / skills / bio / photo / pause / reactivate)
  "profileUpdateStep",
  "profileUpdateField",
  "profileUpdateValue",
  // PAYOUT instant-payout confirmation
  "pendingInstantPayoutConfirm",
  // Context flags that route follow-up replies to qaAgent with rich context
  "pendingPayoutNotificationAck",
  "pendingPayoutNotificationAckSetAt",
  "pendingBgCheckAck",
  "pendingBgCheckAckSetAt",
  // Onboarding resume checkpoint (NOT cleared — intentionally kept for resume)
] as const;

export async function clearAllStateFlags(
  phone: string,
  db: admin.firestore.Firestore
): Promise<void> {
  const update: Record<string, admin.firestore.FieldValue> = {};
  for (const flag of STATE_MACHINE_FLAGS) {
    update[flag] = admin.firestore.FieldValue.delete();
  }
  await db.collection("agent_sessions").doc(phone).update(update);
}

// ── Per-phone inbound serialization ──────────────────────────────────────────
// Linq is at-least-once AND a user can fire several messages in quick
// succession; each lands in its own function instance and races on the same
// session doc. event_id dedup stops DUPLICATES but not distinct concurrent
// messages, so two near-simultaneous texts can read the same session snapshot
// and write conflicting flags (the root cause of wedged state / double-books).
// A transactional per-phone claim serializes them. A TTL lets a crashed holder
// self-heal so the lock can never wedge a conversation permanently.
export const INBOUND_LOCK_TTL_MS = 90_000;

const inboundLockRef = (phone: string, db: admin.firestore.Firestore) =>
  db.collection("agent_inbound_locks").doc(phone);

/**
 * Try to claim the per-phone inbound lock. Returns true if acquired (free, or
 * a stale claim past the TTL from a crashed holder), false if a live claim is
 * held by another in-flight message. Fails OPEN (returns true) on transaction
 * error — dropping a user's message is a worse failure than a rare race.
 */
export async function claimInboundProcessing(
  phone: string,
  db: admin.firestore.Firestore,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const ref = inboundLockRef(phone, db);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const lockedAt = (snap.data() as { lockedAt?: number } | undefined)?.lockedAt ?? 0;
      if (snap.exists && nowMs - lockedAt < INBOUND_LOCK_TTL_MS) return false;
      tx.set(ref, { lockedAt: nowMs });
      return true;
    });
  } catch {
    return true;
  }
}

/** Release the per-phone inbound lock. Best-effort — TTL covers any miss. */
export async function releaseInboundProcessing(
  phone: string,
  db: admin.firestore.Firestore,
): Promise<void> {
  await inboundLockRef(phone, db).delete().catch(() => {});
}
