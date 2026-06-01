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
      try {
        await sendViaInteractionAgent(msg.phone as string, {
          content:     msg.content     as string,
          urgency:     ((msg.urgency    as "low" | "immediate" | "standard" | undefined) ?? "standard"),
          sourceAgent: (msg.sourceAgent as string) ?? "dnd_queue",
          canDrop:     (msg.canDrop    as boolean) ?? true,
        });
        await doc.ref.update({ sentAt: now });
      } catch (err) {
        console.error(`[processDndQueue] Failed to send queued message ${doc.id}:`, err);
      }
    }
  });
