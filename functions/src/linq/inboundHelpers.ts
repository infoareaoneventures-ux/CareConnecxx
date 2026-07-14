import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "./client";
import { canonicalApptFields } from "../utils/appointmentDoc";
import { BILLING_AUTHORITY_VERSION } from "../billing/createValidatedShiftHours";

const db = admin.firestore();

// Helpers shared between webhooks.ts (handleInbound / handleReactionAdded) and
// routeIntent.ts (routeIntentAndRespond). Extracted verbatim from webhooks.ts.

// ── Recurring schedule: YES confirmation ─────────────────────────────────────

export async function handleRecurringConfirm(
  phone:   string,
  chatId:  string,
  session: AgentSession
): Promise<void> {
  const pending = (session as any).pendingRecurringSchedule as {
    caregiverId:   string;
    caregiverName: string;
    days:          string[];
    startTime:     string;
    endTime:       string;
    durationHours: number;
    hourlyRate:    number;
  } | undefined;

  if (!pending) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    });
    return;
  }

  const clientId   = session.userId ?? phone;
  const seniorName = (session as any).onboardingData?.seniorName ?? (session as any).seniorName ?? "";
  const today      = new Date().toISOString().split("T")[0];
  const now        = new Date().toISOString();

  const { generateRecurringDates } = await import("../scheduled/recurringScheduler");
  const dates = generateRecurringDates(today, pending.days, 4);

  if (dates.length === 0) {
    await sendMessage(chatId, "I couldn't generate dates for that schedule — the days may not be valid. Let me know if you'd like to try again.");
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }

  const scheduleRef = db.collection("recurring_schedules").doc();
  const batch       = db.batch();

  batch.set(scheduleRef, {
    clientId,
    caregiverId:      pending.caregiverId,
    caregiverName:    pending.caregiverName,
    clientPhone:      phone,
    seniorName,
    days:             pending.days,
    startTime:        pending.startTime,
    endTime:          pending.endTime,
    durationHours:    pending.durationHours,
    hourlyRate:       pending.hourlyRate,
    status:           "active",
    startDate:        today,
    weeksBookedAhead: 4,
    lastExtendedAt:   now,
    createdAt:        now,
  });

  for (const { date } of dates) {
    const apptRef = db.collection("appointments").doc();
    batch.set(apptRef, {
      clientId,
      caregiverId:         pending.caregiverId,
      caregiverName:       pending.caregiverName,
      seniorName:          seniorName || null,
      date,
      startTime:           pending.startTime,
      endTime:             pending.endTime,
      durationHours:       pending.durationHours,
      hourlyRate:          pending.hourlyRate,
      ...canonicalApptFields({ startTime: pending.startTime, durationHours: pending.durationHours, hourlyRate: pending.hourlyRate }),
      status:              "confirmed",
      billingAuthority:    BILLING_AUTHORITY_VERSION,
      recurringScheduleId: scheduleRef.id,
      humanApproved:       true,
      createdByAgent:      true,
      createdAt:           now,
    });
  }

  await batch.commit();

  await db.collection("agent_sessions").doc(phone).update({
    awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
    activeRecurringScheduleId:     scheduleRef.id,
  }).catch(() => {});

  const schedDesc = `${pending.days.join("/")}s ${pending.startTime}–${pending.endTime}`;
  await sendMessage(chatId,
    `Set up! ${pending.caregiverName} is booked every ${schedDesc} for the next 4 weeks — ` +
    `and I'll keep extending it automatically.\n\n` +
    `To pause or stop anytime, just text me PAUSE SCHEDULE or CANCEL SCHEDULE.`
  );
}
