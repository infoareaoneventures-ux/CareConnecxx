import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// 30-min client notification — "Alice is on her way for Linda's 9am visit."
// Heads-up only; no response expected. Suppressed if the family already
// cancelled (status: client_cancel_requested) or if a heads-up has already
// gone out for this appointment.
export const sendClientThirtyMinReminders = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const now           = new Date();
    const nowMs         = now.getTime();
    const today         = now.toISOString().slice(0, 10);
    const windowStartMs = nowMs + 25 * 60 * 1000;
    const windowEndMs   = nowMs + 40 * 60 * 1000;

    const snap = await db.collection("appointments")
      .where("date",                            "==", today)
      .where("status",                          "==", "confirmed")
      .where("clientThirtyMinReminderSent",     "!=", true)
      .get();

    for (const doc of snap.docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
      const startTime = (appt.startTime ?? appt.time ?? "") as string;
      if (!startTime) continue;

      const apptMs = parseAppointmentTimeMs(today, startTime);
      if (apptMs === null || apptMs < windowStartMs || apptMs > windowEndMs) continue;

      const clientId    = (appt.clientId    ?? "") as string;
      const caregiverId = (appt.caregiverId ?? "") as string;
      if (!clientId || !caregiverId) continue;

      try {
        const userSnap   = await db.collection("users").doc(clientId).get();
        const clientPhone = userSnap.data()?.phone as string | undefined;
        if (!clientPhone) continue;

        const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
        if (!sessionSnap.exists || (sessionSnap.data() as any)?.optedOut) continue;

        const cgSnap      = await db.collection("caregivers").doc(caregiverId).get();
        const cgName      = (cgSnap.data()?.name ?? "your caregiver") as string;
        const cgFirstName = cgName.split(" ")[0];
        const seniorName  = (appt.seniorName ?? appt.clientName ?? "your loved one") as string;
        const lang        = (sessionSnap.data() as any)?.preferredLanguage === "es" ? "es" : "en";

        const message = await generateCaraMessage({
          audience: "family",
          language: lang,
          context:
            `Write a brief, warm heads-up to a family member that their caregiver is on the way.\n` +
            `Caregiver: ${cgFirstName}\n` +
            `Senior: ${seniorName}\n` +
            `Start time: ${startTime}\n` +
            `Tone: light, no response needed. Mention they'll arrive around the start time. ` +
            `Do NOT ask them to do anything.`,
          fallback: lang === "es"
            ? `${cgFirstName} está en camino para la visita de ${seniorName} a las ${startTime}. 💙`
            : `${cgFirstName} is on the way for ${seniorName}'s ${startTime} visit. 💙`,
        });

        await sendViaInteractionAgent(clientPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "client_thirty_min_reminder",
          canDrop:     true,   // family doesn't strictly need this; respect DND
        });

        await doc.ref.update({ clientThirtyMinReminderSent: true });
      } catch (err) {
        console.error(`[sendClientThirtyMinReminders] Error for appointment ${apptId}:`, err);
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
  return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();
}
