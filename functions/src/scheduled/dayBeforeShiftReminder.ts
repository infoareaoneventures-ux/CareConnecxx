import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { businessTomorrowStr, formatHHMMForDisplay } from "../utils/scheduledTime";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// Runs daily at 6 PM ET — a plain reminder to caregivers for tomorrow's
// visits. (Until 2026-09-28 it asked for YES/NO and texted the family a
// "confirmed" note; the site never asks a caregiver to re-confirm a visit they
// accepted, so the reminder now just points at the page's own actions.)
export const sendDayBeforeShiftReminders = functions.pubsub
  .schedule("0 22 * * *")
  .timeZone("America/New_York")
  .onRun(async () => {
    // Business-timezone tomorrow. At the 22:00 ET run the UTC date is already
    // PT+1, so `new Date()`+setDate(+1)+toISOString computed PT+2 — reminders
    // went out for the day AFTER tomorrow and never for the actual tomorrow.
    const tomorrowStr = businessTomorrowStr();

    // Format as "Wednesday, May 21" for natural reading (noon-anchored so the
    // rendered date can't slip a day in either direction)
    const tomorrowDisplay = new Date(`${tomorrowStr}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric",
    });

    // NOTE: no `.where("dayBeforeConfirmSent","!=",true)` — Firestore `!=` excludes
    // docs missing the field (appointments are created without it), so it would
    // skip every never-reminded shift. Filter already-sent in code.
    const docs = await queryVisits({
      dateOp: "==", dateValue: tomorrowStr,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
      const appt        = doc.data();
      const apptId      = doc.id;
      if (appt.dayBeforeConfirmSent === true) continue;
      const caregiverId = (appt.caregiverId ?? "") as string;
      const clientId    = (appt.clientId    ?? "") as string;
      if (!caregiverId || !clientId) continue;

      try {
        const cgSnap  = await db.collection("caregivers").doc(caregiverId).get();
        const cgData  = cgSnap.data();
        const cgPhone = cgData?.phone as string | undefined;
        if (!cgPhone) continue;

        const cgSessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
        if (!cgSessionSnap.exists || (cgSessionSnap.data() as any)?.optedOut) continue;

        const cgFirstName   = ((cgData?.name ?? "there") as string).split(" ")[0];
        const seniorName    = visitSeniorName(appt, "your client");
        const startTime     = (appt.startTime ?? appt.time ?? "") as string;
        const address       = (appt.address ?? appt.location ?? "") as string;

        const message = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Write a casual, warm evening text to ${cgFirstName} reminding them about their shift tomorrow.\n` +
            `Senior: ${seniorName}\n` +
            `Date: ${tomorrowDisplay}\n` +
            `Start time: ${startTime ? formatHHMMForDisplay(startTime) : "time TBD"}\n` +
            `Location: ${address || "client's home"}\n` +
            `End by saying that if anything has changed they can text CANCEL and you will walk them through it, or text you to move the visit. ` +
            `Do NOT ask them to confirm. Sound like you're genuinely checking in — not sending an automated alert.`,
          fallback:
            `Hey ${cgFirstName}! Just a reminder — you've got ` +
            `${seniorName}'s visit tomorrow${startTime ? " at " + formatHHMMForDisplay(startTime) : ""}${address ? " at " + address : ""}` +
            `. If anything's changed, text CANCEL and I'll walk you through it, or text me to move it.`,
        });

        await sendViaInteractionAgent(cgPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "day_before_shift_reminder",
          canDrop:     false,
        });

        await doc.ref.update({ dayBeforeConfirmSent: true }); // "reminder sent" marker (field name kept so already-reminded visits aren't re-sent)
      } catch (err) {
        console.error(`[sendDayBeforeShiftReminders] Error for appointment ${apptId}:`, err);
      }
    }
  });
