import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

export const processDndQueue = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    const now = new Date().toISOString();

    const snap = await db.collection("agent_dnd_queue")
      .where("sendAfter", "<=", now)
      .where("sentAt",    "==", null)
      .limit(50)
      .get();

    if (snap.empty) return;

    console.log(`[processDndQueue] Processing ${snap.size} queued messages`);

    for (const doc of snap.docs) {
      const msg = doc.data();
      // Atomically claim (sentAt: null → now) BEFORE sending so an overlapping
      // run — e.g. the */15 cron racing a manual/retried invocation — can't pick
      // the same row and double-send. Only the transaction that flips sentAt
      // wins; the loser skips. A send that fails after claiming is logged and not
      // retried (at-most-once): these are DND-deferred, canDrop nudges, so a rare
      // lost send is preferable to a duplicate.
      const claimed = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists || fresh.data()?.sentAt) return false;
        tx.update(doc.ref, { sentAt: now });
        return true;
      }).catch(() => false);
      if (!claimed) continue;
      try {
        await sendViaInteractionAgent(msg.phone as string, {
          content:     msg.content     as string,
          urgency:     ((msg.urgency    as "low" | "immediate" | "standard" | undefined) ?? "standard"),
          sourceAgent: (msg.sourceAgent as string) ?? "dnd_queue",
          canDrop:     (msg.canDrop    as boolean) ?? true,
        });
      } catch (err) {
        console.error(`[processDndQueue] Failed to send queued message ${doc.id}:`, err);
      }
    }
  });
