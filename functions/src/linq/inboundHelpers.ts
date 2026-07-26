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
  // Childcare U7 (plan 2026-07-22-002): SMS-driven appointment creation is
  // senior-only in this unit — a childcare-vertical session must never write
  // senior-shaped appointments/recurring_schedules (childcare booking
  // mutations are web/callable-only until U10 adds classified Evia tools).
  if ((session as unknown as Record<string, unknown>).careVertical === "child") {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
      pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    await sendMessage(chatId,
      "Childcare bookings are managed on the web for now — you can set up a recurring schedule from your dashboard."
    );
    return;
  }

  const pending = (session as any).pendingRecurringSchedule as {
    caregiverId:   string;
    caregiverName: string;
    days:          string[];
    startTime:     string;
    endTime:       string;
    durationHours: number;
    hourlyRate:    number;
    seniorName?:   string; // multi-recipient booking passthrough (bookingExecutor)
    recipientKey?: string;
  } | undefined;

  if (!pending) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    });
    return;
  }

  const clientId   = session.userId ?? phone;
  // The booking's attributed recipient wins over the account's primary senior —
  // a recurring schedule born from "book for John" must stay John's.
  const seniorName = pending.seniorName
    ?? (session as any).onboardingData?.seniorName ?? (session as any).seniorName ?? "";
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
    ...(pending.recipientKey ? { recipientKey: pending.recipientKey } : {}),
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
      ...(pending.recipientKey ? { recipientKey: pending.recipientKey } : {}),
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
