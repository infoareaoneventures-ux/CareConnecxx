import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getCaregiverTaxSummary } from "../billing/taxDocuments";
import { sendMessage } from "../linq/client";

const db = admin.firestore();

// Runs Jan 31 — notify eligible caregivers about their 1099 summary
export const send1099Notifications = functions.pubsub
  .schedule("0 9 31 1 *")   // Jan 31 at 9am
  .timeZone("America/New_York")
  .onRun(async () => {
    const year = new Date().getFullYear() - 1;
    const caregiverSnap = await db.collection("caregivers")
      .where("verified", "==", true)
      .limit(500)
      .get();

    console.log(`[send1099Notifications] Processing ${caregiverSnap.size} caregivers for tax year ${year}`);

    for (const cgDoc of caregiverSnap.docs) {
      const cg = cgDoc.data();
      if (!cg.chatId && !cg.phone) continue;
      try {
        const summary = await getCaregiverTaxSummary(cgDoc.id, year);
        if (!summary.eligibleFor1099) continue;

        const chatId = cg.chatId ?? cg.phone;
        const msg =
          `Your ${year} tax summary is ready! You earned $${summary.totalEarnings.toFixed(2)} ` +
          `across ${summary.visitCount} visits. You may receive a 1099-NEC. ` +
          `Text "tax summary" for your full breakdown.`;
        await sendMessage(chatId, msg);
        console.log(`[send1099Notifications] Notified ${cgDoc.id} — $${summary.totalEarnings}`);
      } catch (e) {
        console.error(`[send1099Notifications] Failed for ${cgDoc.id}:`, e);
      }
    }
  });
