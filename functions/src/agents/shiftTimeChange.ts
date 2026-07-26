// Shift time changes require caregiver acceptance before the appointment moves.
//
// requestShiftTimeChange() stamps the appointment with a pendingTimeChange
// marker (times unchanged) and sends the caregiver a YES/NO shift offer.
// shiftOffer.ts applies the new times on YES, or clears the marker and keeps
// the original schedule on NO / expiry.

import * as admin from "firebase-admin";
import { createShiftOffer } from "./shiftOffer";

const db = admin.firestore();

export interface TimeChangeResult {
  ok:        boolean;
  status:    "pending_caregiver_confirmation" | "applied_directly" | "failed";
  offerId?:  string;
  reason?:   string;
}

export async function requestShiftTimeChange(params: {
  appointmentId: string;
  clientId:      string;
  clientPhone?:  string;
  newDate:       string;
  newStartTime:  string;
  newEndTime:    string;
}): Promise<TimeChangeResult> {
  const { appointmentId, clientId, newDate, newStartTime, newEndTime } = params;
  const apptRef  = db.collection("appointments").doc(appointmentId);
  const apptSnap = await apptRef.get();
  if (!apptSnap.exists) return { ok: false, status: "failed", reason: "appointment_not_found" };
  const appt = apptSnap.data()!;

  // Childcare U7: SMS-driven time changes must not touch childcare visits in
  // this unit (web/callable-only — v1-requestChildcareBookingChange owns
  // childcare schedule changes with full revalidation).
  if (appt.careVertical === "child") {
    return { ok: false, status: "failed", reason: "childcare_web_only" };
  }

  // Resolve the family's phone for offer-outcome notifications.
  let clientPhone = params.clientPhone;
  if (!clientPhone) {
    const sessSnap = await db.collection("agent_sessions").where("userId", "==", clientId).limit(1).get();
    clientPhone = sessSnap.empty ? "" : sessSnap.docs[0].id;
  }

  const cgSnap  = await db.collection("caregivers").doc(appt.caregiverId as string).get();
  const cgPhone = cgSnap.data()?.phone as string | undefined;
  const cgName  = (appt.caregiverName as string) ?? cgSnap.data()?.name ?? "your caregiver";
  const now     = new Date().toISOString();

  if (!cgPhone) {
    // Caregiver unreachable over SMS — apply directly (legacy behavior) and
    // flag for admin follow-up so a human verifies the caregiver knows.
    await apptRef.update({
      date: newDate, startTime: newStartTime, endTime: newEndTime,
      previousDate: appt.date ?? null, previousStartTime: appt.startTime ?? null,
      rescheduledAt: now,
    });
    await db.collection("admin_alerts").add({
      type:          "time_change_unconfirmed",
      appointmentId,
      caregiverId:   appt.caregiverId,
      caregiverName: cgName,
      newDate, newStartTime,
      createdAt:     now,
      resolved:      false,
    }).catch(() => {});
    return { ok: true, status: "applied_directly" };
  }

  // Mark the appointment, but leave date/time untouched until the caregiver accepts.
  await apptRef.update({
    pendingTimeChange: { newDate, newStartTime, newEndTime, requestedAt: now },
  });

  const offerId = await createShiftOffer({
    kind:           "time_change",
    caregiverId:    appt.caregiverId as string,
    caregiverName:  cgName,
    caregiverPhone: cgPhone,
    clientId,
    clientPhone:    clientPhone ?? "",
    appointmentIds: [appointmentId],
    payload: {
      newDate, newStartTime, newEndTime,
      previousDate:      appt.date ?? null,
      previousStartTime: appt.startTime ?? null,
      previousEndTime:   appt.endTime ?? null,
    },
    summary: `Move your visit from ${appt.date} at ${appt.startTime} to ${newDate} at ${newStartTime}`,
    offerMessage:
      `Schedule change request: the family would like to move your visit on ${appt.date} at ${appt.startTime} ` +
      `to ${newDate} at ${newStartTime}. The visit stays at the original time unless you accept.`,
  });

  return { ok: true, status: "pending_caregiver_confirmation", offerId };
}
