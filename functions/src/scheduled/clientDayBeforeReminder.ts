import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { formatHHMMForDisplay } from "../utils/scheduledTime";
import { tomorrowRangeAcrossZones, dayBeforeReminderDue, zoneSuffix } from "../utils/careTime";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// Day-before client reminder. Mirror of sendDayBeforeShiftReminders but sends
// the heads-up to the FAMILY for confirmed shifts. Runs HOURLY (2026-11-09, all U.S. zones) and sends each visit's
// reminder once the visit's OWN care-location clock reaches 9 PM on the day before (it was one midnight-ET run, which
// is 9 PM Pacific but already the visit's own day for Eastern families). Was: runs at 8 PM ET — late
// enough that the caregiver's confirmation has had time to come in (caregiver
// reminder fires at 6 PM ET), early enough not to interrupt evening routines.
//
// CONFIRM is optional — silence is treated as "yes I expect them." CANCEL
// initiates a client cancellation flow handled inbound. Question replies are
// routed through the standard QA path via the dispatcher.
export const sendClientDayBeforeReminders = functions.pubsub
  .schedule("0 * * * *")
  .onRun(async () => {
    // The dates that are "tomorrow" somewhere in the U.S. right now (1-2 days); each visit is then judged by its own zone.
    const range = tomorrowRangeAcrossZones();

    // Only send for confirmed appointments — skip pending_caregiver_confirmation
    // (we don't want to tell the family it's locked in if the caregiver hasn't
    // confirmed yet) and skip ones we've already reminded.
    // NOTE: no `.where("clientDayBeforeReminderSent","!=",true)` — Firestore `!=`
    // excludes docs missing the field (appointments are created without it), so
    // it would skip every never-reminded appointment. Filter already-sent in code.
    const docs = await queryVisits({
      dateOp: ">=", dateValue: range.from, dateUpperBound: range.to,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
      if (appt.clientDayBeforeReminderSent === true) continue;
      if (!dayBeforeReminderDue(appt, 21)) continue; // 9 PM on the day before, at the visit's own location
      const tomorrowDisplay = new Date(`${String(appt.date)}T12:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
      });
      const clientId    = (appt.clientId    ?? "") as string;
      const caregiverId = (appt.caregiverId ?? "") as string;
      if (!clientId || !caregiverId) continue;

      try {
        const userSnap   = await db.collection("users").doc(clientId).get();
        const userData   = userSnap.data();
        const clientPhone = userData?.phone as string | undefined;
        if (!clientPhone) continue;

        const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
        if (!sessionSnap.exists || (sessionSnap.data() as any)?.optedOut) continue;

        const cgSnap        = await db.collection("caregivers").doc(caregiverId).get();
        const cgName        = (cgSnap.data()?.name ?? "your care provider") as string;
        const cgFirstName   = cgName.split(" ")[0];
        const seniorName    = visitSeniorName(appt);
        const startTime     = (appt.startTime ?? appt.time ?? "") as string;
        const lang          = (sessionSnap.data() as any)?.preferredLanguage === "es" ? "es" : "en";
        // Plain factual text, no model rewrite (2026-09-17, live-caught: the
        // model turned a 12:00 AM visit into "at noon"). No "reply CANCEL"
        // either — that invited a legacy appointments-based cancel path that
        // never touched the real visit; a family who wants to cancel just
        // texts Evia and gets the site's own cancel flow.
        const startLabel = startTime ? `${formatHHMMForDisplay(startTime)}${zoneSuffix(appt)}` : "";
        const message = lang === "es"
          ? `Solo un aviso — ${cgFirstName} tiene la visita de ${seniorName} mañana, ${tomorrowDisplay}${startLabel ? ` a las ${startLabel}` : ""}. ` +
            `No necesitas hacer nada; escríbeme si algo cambia.`
          : `Just a heads up — ${cgFirstName} is scheduled for ${seniorName}'s visit tomorrow, ${tomorrowDisplay}${startLabel ? ` at ${startLabel}` : ""}. ` +
            `Nothing you need to do — text me if anything changes.`;

        await sendViaInteractionAgent(clientPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "client_day_before_reminder",
          canDrop:     false,
        });

        await doc.ref.update({ clientDayBeforeReminderSent: true });
      } catch (err) {
        console.error(`[sendClientDayBeforeReminders] Error for appointment ${apptId}:`, err);
      }
    }
  });
