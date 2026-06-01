import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Runs every 15 minutes — sends a warm Cara reminder to caregivers
// whose shift is starting in 25–40 minutes.
export const sendThirtyMinShiftReminders = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const now           = new Date();
    const nowMs         = now.getTime();
    const today         = now.toISOString().slice(0, 10);
    const windowStartMs = nowMs + 25 * 60 * 1000;
    const windowEndMs   = nowMs + 40 * 60 * 1000;

    const snap = await db.collection("appointments")
      .where("date",                       "==", today)
      .where("status",                     "in", ["confirmed", "pending_caregiver_confirmation"])
      .where("caraThirtyMinReminderSent",  "!=", true)
      .get();

    for (const doc of snap.docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
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
        if (!cgSessionSnap.exists || (cgSessionSnap.data() as any)?.optedOut) continue;

        const cgFirstName = ((cgData?.name ?? "there") as string).split(" ")[0];
        const seniorName  = (appt.clientName ?? appt.seniorName ?? "your client") as string;
        const address     = (appt.address ?? appt.location ?? "") as string;

        const message = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Write a short, upbeat heads-up text to ${cgFirstName} — their shift starts in 30 minutes.\n` +
            `Senior: ${seniorName}\n` +
            `Start time: ${startTime}\n` +
            `Address: ${address || "client's home"}\n` +
            `Remind them to text ARRIVED when they get there and LATE if they're running behind. ` +
            `Keep it light and encouraging — like a quick text from a friend.`,
          fallback:
            `Hey ${cgFirstName}, just a heads-up — ${seniorName}'s visit starts in about 30 minutes` +
            `${address ? " at " + address : ""}. ` +
            `Safe travels! Text ARRIVED when you're there or LATE if you hit any traffic. 🚗`,
        });

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
  return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();
}
