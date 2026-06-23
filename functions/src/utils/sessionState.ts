import * as admin from "firebase-admin";

export const STATE_MACHINE_FLAGS = [
  "hireMode",
  "hireModeDate",
  "pendingTimeSelection",
  "pendingRebook",
  "pendingInterviewOutcome",
  "pendingMatches",
  "pendingCancelConfirm",
  "pendingCancelConfirmSetAt",
  "pendingInterviewConfirm",
  "pendingInterviewConfirmSetAt",
  "awaitingRecurringConfirmation",
  "awaitingRecurringConfirmationSetAt",
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

// ── High-stakes confirmation freshness ───────────────────────────────────────
// pendingInterviewConfirm / pendingCancelConfirm / awaitingRecurringConfirmation
// are checked in a fixed order by the YES/NO router. A stale flag can intercept
// a YES meant for a newer question, and the global stateExpiresAt sweep only
// fires when a stateExpiresAt is present — a flag set without one never expires.
// Each set-site now stamps a `<flag>SetAt`; the router clears any flag older
// than this TTL (or present with no stamp — the never-expires case) before
// acting. Kept pure here so the staleness rule is unit-testable in isolation.
export const HIGH_STAKES_CONFIRM_FLAGS = [
  "pendingInterviewConfirm",
  "pendingCancelConfirm",
  "awaitingRecurringConfirmation",
] as const;

export const CONFIRM_FLAG_TTL_MS = 60 * 60 * 1000;

/**
 * Return the names of high-stakes confirmation flags on `session` that are
 * stale and should be cleared before the YES/NO router acts on them — older
 * than the TTL, or set with no age stamp at all (the dangerous never-expires
 * case). Pure: performs no IO and does not mutate `session`. The caller applies
 * the Firestore delete (also deleting the companion `<flag>SetAt`) and clears
 * the in-memory copy.
 */
export function staleConfirmFlags(
  session: Record<string, unknown>,
  nowMs: number = Date.now(),
): string[] {
  const cutoff = new Date(nowMs - CONFIRM_FLAG_TTL_MS).toISOString();
  const stale: string[] = [];
  for (const flag of HIGH_STAKES_CONFIRM_FLAGS) {
    if (!session[flag]) continue;
    const setAt = session[`${flag}SetAt`] as string | undefined;
    if (!setAt || setAt < cutoff) stale.push(flag);
  }
  return stale;
}

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
