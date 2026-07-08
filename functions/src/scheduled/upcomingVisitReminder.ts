import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

export const upcomingVisitReminder = functions.pubsub
  .schedule("*/30 * * * *")
  .onRun(async () => {
    const now       = new Date();
    const nowIso    = now.toISOString();
    const plus90min = new Date(now.getTime() + 90 * 60 * 1000).toISOString();

    // NOTE: no `.where("preVisitReminderSent","!=",true)` — Firestore `!=` excludes
    // docs missing the field (appointments are created without it) AND can't be
    // combined with the startDateTime range (inequality on two fields). Filter
    // already-sent in code instead.
    const snap = await db.collection("appointments")
      .where("status",             "==", "confirmed")
      .where("startDateTime",      ">=", nowIso)
      .where("startDateTime",      "<=", plus90min)
      .get();

    if (snap.empty) return;

    console.log(`[upcomingVisitReminder] Processing ${snap.size} upcoming appointments`);

    for (const doc of snap.docs) {
      const appt = doc.data();
      if (appt.preVisitReminderSent === true) continue;
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
