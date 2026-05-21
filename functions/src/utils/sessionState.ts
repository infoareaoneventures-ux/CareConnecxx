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
