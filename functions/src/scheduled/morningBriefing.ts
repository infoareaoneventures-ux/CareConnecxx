import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

// Runs every day at 7am local (12:00 UTC covers most US time zones at 7am)
export const sendMorningBriefings = functions.pubsub
  .schedule("0 12 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Find all confirmed appointments for today
    const snap = await db.collection("appointments")
      .where("date",   "==", today)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .get();

    for (const doc of snap.docs) {
      const appt = doc.data();
      const caregiverId = appt.caregiverId as string;
      if (!caregiverId) continue;

      try {
        const [cgSnap, clientSnap, carePlanSnap] = await Promise.all([
          db.collection("caregivers").doc(caregiverId).get(),
          db.collection("users").doc(appt.clientId).get(),
          db.collection("care_plans").doc(appt.clientId).get(),
        ]);

        const caregiver = cgSnap.data();
        if (!caregiver?.phone) continue;

        const cgSession = await db.collection("agent_sessions").doc(caregiver.phone).get();
        if (!cgSession.exists) continue;

        const senior   = clientSnap.data();
        const carePlan = carePlanSnap.data();
        const name     = caregiver.name ?? "there";
        const seniorName  = (senior?.seniorName ?? appt.clientName ?? "your client") as string;
        const address     = (appt.address ?? appt.location ?? "the client's home") as string;

        // Build care plan highlights
        const highlights: string[] = [];
        if (carePlan?.medications?.length) {
          highlights.push(`· Medications: ${(carePlan.medications as string[]).slice(0, 2).join(", ")}`);
        }
        if (carePlan?.notes) {
          highlights.push(`· Notes: ${(carePlan.notes as string).slice(0, 100)}`);
        }
        if (!highlights.length) highlights.push("· No special notes for today");

        const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;

        await sendViaInteractionAgent(caregiver.phone as string, {
          content:
            `Good morning ${name}! Here's your day:\n\n` +
            `👤 ${seniorName}\n` +
            `📍 ${address}\n` +
            `   ${mapsUrl}\n` +
            `⏰ ${appt.startTime ?? ""}–${appt.endTime ?? ""}\n\n` +
            `Care plan highlights:\n` +
            highlights.join("\n") +
            `\n\nReply ARRIVED when you get there. 💙`,
          urgency:     "standard",
          sourceAgent: "morning_briefing",
          canDrop:     true,
        });
      } catch (err) {
        console.error("morningBriefing error for appt", doc.id, err);
      }
    }
  });
