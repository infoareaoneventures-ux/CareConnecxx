import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "./client";
import { formatHHMMForDisplay } from "../utils/scheduledTime";

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
    seniorName?:   string; // multi-recipient booking passthrough (bookingExecutor)
    recipientKey?: string;
    bookingRequestId?: string; // links back to the booking_requests doc to update
  } | undefined;

  if (!pending) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    });
    return;
  }

  if (!pending.bookingRequestId) {
    // Should never happen for a booking made under the current pipeline
    // (bookingExecutor.ts always stamps bookingRequestId onto this flag) —
    // fail soft rather than silently drop the family's "yes."
    await sendMessage(chatId, "I wasn't able to find that booking to make it recurring — text me and I'll help set it up fresh.");
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
      pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  // Update the SAME booking_requests doc this booking already created —
  // schedule.ongoing + dayShiftTimes is the site's own real recurring-booking
  // mechanism (confirmed: the website has no separate recurring-schedule
  // collection). From here the site's own generateRollingShifts daily job
  // takes over generating future shifts automatically — no Evia-side
  // generation needed for this case (contrast with writeConfirmedShifts,
  // which handles the initial, often-irregular one-off dates directly).
  const dayShiftTimes: Record<string, Array<{ start: string; end: string }>> = {};
  for (const day of pending.days) {
    dayShiftTimes[day] = [{ start: pending.startTime, end: pending.endTime }];
  }

  await db.collection("booking_requests").doc(pending.bookingRequestId).update({
    schedule: {
      ongoing:   true,
      startDate: today,
      endDate:   null,
      dayShiftTimes,
    },
  });

  await db.collection("agent_sessions").doc(phone).update({
    awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  const schedDesc = `${pending.days.join("/")}s ${formatHHMMForDisplay(pending.startTime)}–${formatHHMMForDisplay(pending.endTime)}`;
  await sendMessage(chatId,
    `Set up! ${pending.caregiverName} is booked every ${schedDesc}, ongoing — ` +
    `I'll keep you posted as each visit comes up.\n\n` +
    `To stop anytime, just text me to cancel the booking.`
  );
}
