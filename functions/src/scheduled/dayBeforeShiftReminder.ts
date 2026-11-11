import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { formatHHMMForDisplay } from "../utils/scheduledTime";
import { tomorrowRangeAcrossZones, dayBeforeReminderDue, zoneSuffix } from "../utils/careTime";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// Runs HOURLY (2026-11-09, all U.S. zones; it was once a day at 10 PM ET) and sends each visit's reminder once the
// visit's OWN care-location clock reaches 7 PM on the day before — the old single run was 7 PM Pacific, which is
// 10 PM Eastern and 9 PM Central. A visit already reminded is skipped (dayBeforeConfirmSent), so a missed run still
// sends later that evening. A plain reminder to caregivers for tomorrow's
// visits. (Until 2026-09-28 it asked for YES/NO and texted the family a
// "confirmed" note; the site never asks a caregiver to re-confirm a visit they
// accepted, so the reminder now just points at the page's own actions.)
export const sendDayBeforeShiftReminders = functions.pubsub
  .schedule("0 * * * *")
  .onRun(async () => {
    // The dates that are "tomorrow" somewhere in the U.S. right now (1-2 days); each visit is then judged by its own zone.
    const range = tomorrowRangeAcrossZones();

    // NOTE: no `.where("dayBeforeConfirmSent","!=",true)` — Firestore `!=` excludes
    // docs missing the field (appointments are created without it), so it would
    // skip every never-reminded shift. Filter already-sent in code.
    const docs = await queryVisits({
      dateOp: ">=", dateValue: range.from, dateUpperBound: range.to,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
      const appt        = doc.data();
      const apptId      = doc.id;
      if (appt.dayBeforeConfirmSent === true) continue;
      if (!dayBeforeReminderDue(appt, 19)) continue; // 7 PM on the day before, at the visit's own location
      // Format as "Wednesday, May 21" (noon-anchored so the rendered date can't slip a day).
      const tomorrowDisplay = new Date(`${String(appt.date)}T12:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
      });
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
        const seniorName    = visitSeniorName(appt, "your client");
        const startTime     = (appt.startTime ?? appt.time ?? "") as string;
        const address       = (appt.address ?? appt.location ?? "") as string;

        // Plain, fixed wording (founder, 2026-09-29) — no model, no "checking in".
        const endTime = (appt.endTime ?? "") as string;
        const message =
          `Reminder: ${seniorName}'s visit tomorrow, ${tomorrowDisplay}` +
          `${startTime ? `, ${formatHHMMForDisplay(startTime)}${endTime ? ` – ${formatHHMMForDisplay(endTime)}` : ""}${zoneSuffix(appt)}` : ""}` +
          `${address ? ` at ${address}` : ""}.`; // just the reminder — no cancel prompt (founder, 2026-09-29: "does it have to say cancel shift")

        const sent = await sendViaInteractionAgent(cgPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "day_before_shift_reminder",
          canDrop:     false,
          fixedString: true, // the founder's plain wording — never rephrased (C12)
        });
        // Bell ⇄ text in lockstep (C11): the same sentence on the site, only when the text went.
        if (sent) {
          await writeUserNotification({
            sourcePath: `shifts/${apptId}`, eventId: "day-before-reminder", recipientId: caregiverId,
            transitionType: "shift_tomorrow", type: "shift_tomorrow", title: "Visit tomorrow", body: message,
            data: { shiftId: apptId },
          }).catch((err) => console.error("[sendDayBeforeShiftReminders] bell failed:", apptId, err));
        }

        await doc.ref.update({ dayBeforeConfirmSent: true }); // "reminder sent" marker (field name kept so already-reminded visits aren't re-sent)
      } catch (err) {
        console.error(`[sendDayBeforeShiftReminders] Error for appointment ${apptId}:`, err);
      }
    }
  });
