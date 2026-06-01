import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

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
  .schedule("0 0 * * *")          // 0:00 UTC = 8 PM ET (DST handled by timeZone)
  .timeZone("America/New_York")
  .onRun(async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const tomorrowDisplay = tomorrow.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

    // Only send for confirmed appointments — skip pending_caregiver_confirmation
    // (we don't want to tell the family it's locked in if the caregiver hasn't
    // confirmed yet) and skip ones we've already reminded.
    const snap = await db.collection("appointments")
      .where("date",                       "==", tomorrowStr)
      .where("status",                     "==", "confirmed")
      .where("clientDayBeforeReminderSent","!=", true)
      .get();

    for (const doc of snap.docs) {
      const appt    = doc.data();
      const apptId  = doc.id;
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
        const seniorName    = (appt.seniorName ?? appt.clientName ?? "your loved one") as string;
        const startTime     = (appt.startTime ?? appt.time ?? "") as string;
        const lang          = (sessionSnap.data() as any)?.preferredLanguage === "es" ? "es" : "en";

        const message = await generateCaraMessage({
          audience: "family",
          language: lang,
          context:
            `Write a short, warm evening heads-up to a family member that their care visit is tomorrow.\n` +
            `Caregiver: ${cgFirstName}\n` +
            `Senior: ${seniorName}\n` +
            `Date: ${tomorrowDisplay}\n` +
            `Start time: ${startTime || "time TBD"}\n` +
            `Tone: reassuring, not pushy. Mention they don't need to do anything — but they can reply ` +
            `CANCEL if something's come up, or just ask any question they have. Don't sound like an ` +
            `automated reminder.`,
          fallback: lang === "es"
            ? `Solo un aviso — ${cgFirstName} pasará mañana${startTime ? " a las " + startTime : ""}` +
              ` para ${seniorName}. No necesitas hacer nada; responde CANCEL si algo cambió, ` +
              `o escríbeme si tienes preguntas.`
            : `Just a heads up — ${cgFirstName} will be by tomorrow${startTime ? " at " + startTime : ""}` +
              ` for ${seniorName}. You don't need to do anything; reply CANCEL if something's changed, ` +
              `or text me any questions.`,
        });

        await sendViaInteractionAgent(clientPhone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "client_day_before_reminder",
          canDrop:     false,
        });

        await doc.ref.update({ clientDayBeforeReminderSent: true });
        await sessionSnap.ref.update({
          pendingClientShiftConfirm: {
            appointmentId:      apptId,
            appointmentDate:    tomorrowStr,
            appointmentDisplay: tomorrowDisplay,
            caregiverId,
            caregiverName:      cgName,
            seniorName,
            startTime,
            sentAt:             new Date().toISOString(),
          },
          // 16h window — caregiver-side reminder uses the same window. Family
          // has until ~noon next day to cancel before the shift starts (most
          // shifts are morning).
          stateExpiresAt: new Date(Date.now() + 16 * 60 * 60 * 1000).toISOString(),
        });
      } catch (err) {
        console.error(`[sendClientDayBeforeReminders] Error for appointment ${apptId}:`, err);
      }
    }
  });
