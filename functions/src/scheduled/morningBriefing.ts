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
        const cgFirstName  = ((caregiver.name ?? "there") as string).split(" ")[0];
        const seniorName   = (senior?.seniorName ?? appt.clientName ?? "your client") as string;
        const address      = (appt.address ?? appt.location ?? "the client's home") as string;
        const schedule     = `${appt.startTime ?? ""}${appt.endTime ? `–${appt.endTime as string}` : ""}`;

        const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;

        // Fetch last journal entry for context
        const lastJournal = await db.collection("care_journal")
          .where("seniorId", "==", appt.clientId)
          .orderBy("timestamp", "desc")
          .limit(1)
          .get()
          .catch(() => null);
        const lastNotes = lastJournal?.empty ? null :
          (lastJournal?.docs[0].data().notes as string | undefined) ?? null;

        // Build context note from last visit or care plan note
        const contextNote = lastNotes
          ? lastNotes.slice(0, 120)
          : (carePlan?.notes ? (carePlan.notes as string).slice(0, 120) : null);

        // Medication line — only if there are meds
        const meds = (carePlan?.medications as string[] | undefined) ?? [];
        const medLine = meds.length > 0
          ? `Medications: ${meds.slice(0, 2).join(", ")}.`
          : null;

        const lines = [
          `Morning ${cgFirstName}! ${seniorName} today${schedule ? ` — ${schedule}` : ""} at ${address}.`,
          mapsUrl,
          contextNote,
          medLine,
          `Reply ARRIVED when you get there.`,
        ].filter(Boolean);

        await sendViaInteractionAgent(caregiver.phone as string, {
          content:     lines.join("\n\n"),
          urgency:     "standard",
          sourceAgent: "morning_briefing",
          canDrop:     true,
        });
      } catch (err) {
        console.error("morningBriefing error for appt", doc.id, err);
      }
    }
  });
