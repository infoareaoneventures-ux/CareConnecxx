import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { businessTomorrowStr, formatHHMMForDisplay } from "../utils/scheduledTime";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// Day-before client reminder. Mirror of sendDayBeforeShiftReminders but sends
// the heads-up to the FAMILY for confirmed shifts. Runs at 8 PM ET — late
// enough that the caregiver's confirmation has had time to come in (caregiver
// reminder fires at 6 PM ET), early enough not to interrupt evening routines.
//
// CONFIRM is optional — silence is treated as "yes I expect them." CANCEL
// initiates a client cancellation flow handled inbound. Question replies are
// routed through the standard QA path via the dispatcher.
export const sendClientDayBeforeReminders = functions.pubsub
  .schedule("0 0 * * *")          // midnight ET = 9 PM PT (DST handled by timeZone)
  .timeZone("America/New_York")
  .onRun(async () => {
    // Business-timezone tomorrow. At the midnight-ET run the UTC date is
    // already PT+1, so the old +1-day UTC math computed PT+2 — families were
    // reminded for the day after tomorrow and never for the actual tomorrow.
    const tomorrowStr = businessTomorrowStr();
    const tomorrowDisplay = new Date(`${tomorrowStr}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric",
    });

    // Only send for confirmed appointments — skip pending_caregiver_confirmation
    // (we don't want to tell the family it's locked in if the caregiver hasn't
    // confirmed yet) and skip ones we've already reminded.
    // NOTE: no `.where("clientDayBeforeReminderSent","!=",true)` — Firestore `!=`
    // excludes docs missing the field (appointments are created without it), so
    // it would skip every never-reminded appointment. Filter already-sent in code.
    const docs = await queryVisits({
      dateOp: "==", dateValue: tomorrowStr,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
      if (appt.clientDayBeforeReminderSent === true) continue;
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
        const cgName        = (cgSnap.data()?.name ?? "your caregiver") as string;
        const cgFirstName   = cgName.split(" ")[0];
        const seniorName    = visitSeniorName(appt);
        const startTime     = (appt.startTime ?? appt.time ?? "") as string;
        const lang          = (sessionSnap.data() as any)?.preferredLanguage === "es" ? "es" : "en";
        // Plain factual text, no model rewrite (2026-09-17, live-caught: the
        // model turned a 12:00 AM visit into "at noon"). No "reply CANCEL"
        // either — that invited a legacy appointments-based cancel path that
        // never touched the real visit; a family who wants to cancel just
        // texts Evia and gets the site's own cancel flow.
        const startLabel = startTime ? formatHHMMForDisplay(startTime) : "";
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
