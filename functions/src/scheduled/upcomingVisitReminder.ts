import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { apptStartMs, businessTodayStr, businessTomorrowStr } from "../utils/scheduledTime";

const db = admin.firestore();

export const upcomingVisitReminder = functions.pubsub
  .schedule("*/30 * * * *")
  .onRun(async () => {
    const nowMs     = Date.now();
    const plus90Ms  = nowMs + 90 * 60 * 1000;

    // Window derived from the stored `date` + `startTime`/`time` wall-clock
    // fields. The old query ranged on `startDateTime`, which NO writer ever
    // sets on appointments — this cron was silently dead. Query today's (and,
    // near midnight, tomorrow's) confirmed visits by business date, then
    // filter to the 90-minute window in code.
    // NOTE: no `.where("preVisitReminderSent","!=",true)` — Firestore `!=`
    // excludes docs missing the field. Filter already-sent in code instead.
    const snap = await db.collection("appointments")
      .where("status", "==", "confirmed")
      .where("date",   "in", [businessTodayStr(), businessTomorrowStr()])
      .get();

    if (snap.empty) return;

    console.log(`[upcomingVisitReminder] Scanning ${snap.size} confirmed visits for the 90-min window`);

    for (const doc of snap.docs) {
      const appt = doc.data();
      if (appt.preVisitReminderSent === true) continue;
      const startMs = apptStartMs(appt.date, appt.startTime ?? appt.time);
      if (!Number.isFinite(startMs) || startMs < nowMs || startMs > plus90Ms) continue;
      try {
        const userSnap = await db.collection("users").doc(appt.clientId as string).get();
        const phone    = (userSnap.data() as any)?.phone as string | undefined;
        if (!phone) continue;

        const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
        if (!sessionSnap.exists) continue;
        const session = sessionSnap.data()!;
        if (session.optedOut) continue;

        const cgName    = (appt.caregiverName ?? "Your caregiver") as string;
        const time      = (appt.startTime    ?? appt.time ?? "") as string;
        const seniorName = (appt.seniorName ?? appt.clientName ?? "") as string;

        const reminderMsg = await generateCaraMessage({
          audience: "family",
          context:
            `Send a brief upcoming visit reminder to a family. ` +
            `Caregiver: ${cgName}. Visit time: ${time || "today"}.` +
            (seniorName ? ` Senior: ${seniorName}.` : "") +
            " Let them know the visit is confirmed and to reply CANCEL if plans change.",
          fallback:
            `Just a heads up — ${cgName} is confirmed for your ${time} visit today. ` +
            `Reply CANCEL if plans change and I'll handle it.`,
          maxTokens: 80,
        });

        await sendViaInteractionAgent(phone, {
          content:     reminderMsg,
          urgency:     "standard",
          sourceAgent: "upcoming_visit_reminder",
          canDrop:     false,
        });

        await doc.ref.update({ preVisitReminderSent: true });
      } catch (err) {
        console.error(`[upcomingVisitReminder] Error for appointment ${doc.id}:`, err);
      }
    }
  });
