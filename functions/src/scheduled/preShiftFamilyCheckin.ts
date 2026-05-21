import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

function parseStartTimeToMinutes(timeStr: string): number | null {
  const trimmed = (timeStr ?? "").trim();

  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
    if (ampm[3].toUpperCase() === "PM" && h !== 12) h += 12;
    return h * 60 + m;
  }

  const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
  }

  return null;
}

// Runs every 15 minutes — 15 minutes before a shift, asks the family if they
// want to add any tasks or special instructions for that day.
export const sendPreShiftFamilyCheckin = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const now         = new Date();
    const nowMinutes  = now.getHours() * 60 + now.getMinutes();
    const windowStart = nowMinutes + 15;
    const windowEnd   = nowMinutes + 30;
    const today       = now.toISOString().slice(0, 10);

    const snap = await db.collection("appointments")
      .where("date",                "==", today)
      .where("status",              "in", ["confirmed", "pending_caregiver_confirmation"])
      .where("preShiftCheckinSent", "!=", true)
      .get();

    for (const doc of snap.docs) {
      const appt     = doc.data();
      const apptId   = doc.id;
      const clientId = (appt.clientId ?? "") as string;
      const startTime = (appt.startTime ?? "") as string;
      if (!clientId || !startTime) continue;

      const startMinutes = parseStartTimeToMinutes(startTime);
      if (startMinutes === null) continue;
      if (startMinutes < windowStart || startMinutes > windowEnd) continue;

      try {
        const sessionSnap = await db.collection("agent_sessions")
          .where("userId", "==", clientId)
          .limit(1)
          .get();
        if (sessionSnap.empty) continue;

        const sessionDoc  = sessionSnap.docs[0];
        const sessionData = sessionDoc.data() as any;
        if (sessionData.optedOut) continue;

        const clientPhone   = (sessionData.phone ?? sessionDoc.id) as string;
        const caregiverName = (appt.caregiverName ?? "Your caregiver") as string;
        const cgFirstName   = caregiverName.split(" ")[0] || caregiverName;
        const seniorName    = (appt.clientName ?? appt.seniorName ?? "your loved one") as string;

        const clientSnap   = await db.collection("users").doc(clientId).get().catch(() => null);
        const familyFirst  = ((clientSnap?.data()?.displayName ?? clientSnap?.data()?.name ?? "") as string)
          .split(" ")[0] || "";

        const message = await generateCaraMessage({
          audience: "family",
          context:
            `Write a friendly, brief text to ${familyFirst || "the family"} — ` +
            `${cgFirstName} is about 15 minutes away from starting ${seniorName}'s care visit.\n` +
            `Ask if there's anything they'd like added to today's plan — any tasks or special instructions ` +
            `that aren't already in the regular care routine. ` +
            `Keep it casual and easy to respond to. They can reply with tasks or just say NO if the regular plan is fine.`,
          fallback:
            `${familyFirst ? "Hey " + familyFirst + "! " : ""}${cgFirstName} is heading over to see ${seniorName} — ` +
            `about 15 minutes out. Anything you'd like added to today's plan, or are we good with the regular routine? ` +
            `Just reply with any tasks, or NO if everything's set!`,
        });

        await sendViaInteractionAgent(clientPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "pre_shift_checkin",
          canDrop:     true,
        });

        await doc.ref.update({ preShiftCheckinSent: true });
        await sessionDoc.ref.update({
          awaitingPreShiftUpdate: {
            appointmentId: apptId,
            caregiverName,
            seniorName,
            sentAt: new Date().toISOString(),
          },
          stateExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      } catch (err) {
        console.error(`[sendPreShiftFamilyCheckin] Error for appointment ${apptId}:`, err);
      }
    }
  });
