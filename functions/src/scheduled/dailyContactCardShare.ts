import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { shareContactCard } from "../linq/client";
import { setupCaraContactCard } from "../sms";

const db = admin.firestore();

// Runs every day at 10am ET (15:00 UTC).
// Best practice: re-share Cara's contact card daily so users who dismissed the
// "Add to contacts" prompt get another chance to save her name and photo.
export const dailyContactCardShare = functions.pubsub
  .schedule("0 15 * * *")
  .timeZone("UTC")
  .onRun(async () => {
    // Refresh the contact card record first (no-op if already up to date)
    await setupCaraContactCard().catch((err) =>
      console.error("dailyContactCardShare: setupCaraContactCard failed", err)
    );

    // Share to every active iMessage session (non-iMessage sessions don't support contact cards)
    const snap = await db
      .collection("agent_sessions")
      .where("optedOut", "==", false)
      .where("service", "==", "iMessage")
      .get();

    if (snap.empty) {
      console.info("dailyContactCardShare: no active iMessage sessions");
      return;
    }

    const results = await Promise.allSettled(
      snap.docs.map((doc) => {
        const { chatId } = doc.data() as { chatId: string };
        return shareContactCard(chatId);
      })
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    console.info(
      `dailyContactCardShare: shared to ${snap.size} sessions, ${failed} failed`
    );
  });
