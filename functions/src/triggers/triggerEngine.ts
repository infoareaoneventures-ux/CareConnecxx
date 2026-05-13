import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

const db = admin.firestore();

export interface ProactiveTrigger {
  id?:           string;
  userId:        string;
  phone:         string;
  type:          "appointment_reminder" | "weekly_checkin" | "medication_reminder" | "custom";
  scheduledAt:   string;   // ISO
  message:       string;
  firedAt?:      string;
  cancelledAt?:  string;
  createdAt:     string;
}

// 30-day calibration period — no proactive triggers during this window
function isInCalibrationPeriod(sessionCreatedAt: string): boolean {
  const createdMs = new Date(sessionCreatedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - createdMs < thirtyDaysMs;
}

// Schedule a proactive trigger — no-op during calibration period
export async function scheduleTrigger(
  trigger: Omit<ProactiveTrigger, "id" | "createdAt">
): Promise<string> {
  // Check calibration
  const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
  if (sessionSnap.exists) {
    const session = sessionSnap.data()!;
    if (session.createdAt && isInCalibrationPeriod(session.createdAt as string)) {
      return ""; // Silently skip during calibration
    }
  }

  const ref = await db.collection("proactive_triggers").add({
    ...trigger,
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

// Called at the top of the main webhook handler (after crisis check) to cancel pending triggers
// Twin-trigger pattern: if user replied, cancel their scheduled nudge
export async function cancelTriggerIfUserReplied(userId: string, phone: string): Promise<void> {
  const now = new Date().toISOString();

  const snap = await db
    .collection("proactive_triggers")
    .where("userId", "==", userId)
    .where("cancelledAt", "==", null)
    .where("firedAt",     "==", null)
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { cancelledAt: now });
  }
  await batch.commit().catch(() => {});
}

// Every-5-minute executor — fires due triggers, skips cancelled/fired ones
export const runTriggerEngine = functions.pubsub
  .schedule("*/5 * * * *")
  .onRun(async () => {
    const now = new Date().toISOString();

    const snap = await db
      .collection("proactive_triggers")
      .where("scheduledAt", "<=", now)
      .get();

    for (const doc of snap.docs) {
      const trigger = doc.data() as ProactiveTrigger;

      // Skip already fired or cancelled
      if (trigger.firedAt || trigger.cancelledAt) continue;

      // Twin-trigger: check if user sent a message since trigger was created
      const lastReply = await db
        .collection("agent_conversations")
        .doc(trigger.phone)
        .collection("messages")
        .where("role",      "==", "user")
        .where("timestamp", ">=", new Date(trigger.createdAt).getTime())
        .limit(1)
        .get();

      if (!lastReply.empty) {
        // User already replied — cancel the trigger
        await doc.ref.update({ cancelledAt: now });
        continue;
      }

      // Get user's session to find chatId
      const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
      if (!sessionSnap.exists) {
        await doc.ref.update({ cancelledAt: now });
        continue;
      }

      const session = sessionSnap.data()!;
      if (session.optedOut) {
        await doc.ref.update({ cancelledAt: now });
        continue;
      }

      try {
        await sendMessage(session.chatId as string, trigger.message);
        await doc.ref.update({ firedAt: now });
      } catch (err) {
        console.error("triggerEngine: failed to send for", doc.id, err);
      }
    }
  });

export { runTriggerEngine as triggerEngineScheduled };
