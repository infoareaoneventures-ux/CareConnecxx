import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { businessTodayStr, parseScheduledTimeMs, formatHHMMForDisplay } from "../utils/scheduledTime";
import { visitPageLink } from "../agents/inShift";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// Runs every 15 minutes — sends a warm Evia reminder to caregivers
// whose shift is starting in 25–40 minutes.
export const sendThirtyMinShiftReminders = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const now           = new Date();
    const nowMs         = now.getTime();
    const today         = businessTodayStr();   // Pacific date, not UTC
    const windowStartMs = nowMs + 25 * 60 * 1000;
    const windowEndMs   = nowMs + 40 * 60 * 1000;

    // NOTE: no `.where("caraThirtyMinReminderSent","!=",true)` — Firestore `!=`
    // excludes docs missing the field (appointments are created without it), so
    // it would skip every never-reminded shift. Filter already-sent in code.
    const docs = await queryVisits({
      dateOp: "==", dateValue: today,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
      if (appt.caraThirtyMinReminderSent === true) continue;
      const startTime = (appt.startTime ?? appt.time ?? "") as string;
      if (!startTime) continue;

      const apptMs = parseAppointmentTimeMs(today, startTime);
      if (apptMs === null || apptMs < windowStartMs || apptMs > windowEndMs) continue;

      const caregiverId = (appt.caregiverId ?? "") as string;
      if (!caregiverId) continue;

      try {
        const cgSnap  = await db.collection("caregivers").doc(caregiverId).get();
        const cgData  = cgSnap.data();
        const cgPhone = cgData?.phone as string | undefined;
        if (!cgPhone) continue;

        const cgSessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
        if (!cgSessionSnap.exists || (cgSessionSnap.data() as any)?.optedOut) continue;        const seniorName  = visitSeniorName(appt, "your client");
        const address     = (appt.address ?? appt.location ?? "") as string;

        // Plain, fixed wording — the model's "upbeat" version read as chatty and
        // claimed Evia would "let the family know" (founder, 2026-09-29).
        const endTime = (appt.endTime ?? "") as string;
        const message =
          `${seniorName}'s visit starts at ${formatHHMMForDisplay(startTime)}${endTime ? ` – ${formatHHMMForDisplay(endTime)}` : ""}` +
          `${address ? ` at ${address}` : ""}. Text START when you arrive. ` +
          `Running behind? Text LATE and I'll send your message to the family. ` +
          `Or open it here: ${visitPageLink(apptId)}`;

        await sendViaInteractionAgent(cgPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "thirty_min_shift_reminder",
          canDrop:     false,
        });

        await doc.ref.update({ caraThirtyMinReminderSent: true });
      } catch (err) {
        console.error(`[sendThirtyMinShiftReminders] Error for appointment ${apptId}:`, err);
      }
    }
  });

function parseAppointmentTimeMs(dateStr: string, timeStr: string): number | null {
  const trimmed = timeStr.trim();
  let h: number | null = null;
  let m: number | null = null;

  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    h = parseInt(ampm[1], 10);
    m = parseInt(ampm[2], 10);
    if (ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
    if (ampm[3].toUpperCase() === "PM" && h !== 12) h += 12;
  } else {
    const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) { h = parseInt(h24[1], 10); m = parseInt(h24[2], 10); }
  }

  if (h === null || m === null) return null;
  // Interpret naive date+time as business-timezone (Pacific) wall-clock, not UTC
  // (the family-side twin of this reminder was removed 2026-09-16 — it claimed the caregiver was "on the way" from the clock alone). DST-correct.
  const ms = parseScheduledTimeMs(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  return Number.isNaN(ms) ? null : ms;
}
