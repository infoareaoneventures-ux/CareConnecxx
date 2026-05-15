import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

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

  if (!snap.empty) {
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit().catch(() => {});
  }

  // Mark any recently-fired triggers as engaged — user replied
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const firedSnap = await db
    .collection("proactive_triggers")
    .where("userId",    "==", userId)
    .where("firedAt",   ">=", oneDayAgo)
    .get();

  for (const doc of firedSnap.docs) {
    const data = doc.data() as ProactiveTrigger;
    if (!data.firedAt || (data as any).engagedAt) continue;
    await doc.ref.update({ engagedAt: now });
    await markTriggerEngaged(phone, data.type);
  }
}

// Reset consecutive-ignore count when user engages with a trigger
export async function markTriggerEngaged(phone: string, triggerType: string): Promise<void> {
  await db.collection("trigger_engagement")
    .doc(`${phone}_${triggerType}`)
    .set({ consecutiveIgnores: 0, lastEngagedAt: new Date().toISOString() }, { merge: true });
}

async function pauseTriggerType(phone: string, triggerType: string): Promise<void> {
  await db.collection("trigger_engagement")
    .doc(`${phone}_${triggerType}`)
    .set({ paused: true, pausedAt: new Date().toISOString() }, { merge: true });

  // Cancel any pending triggers of this type for this user
  const snap = await db.collection("proactive_triggers")
    .where("phone", "==", phone)
    .where("type",  "==", triggerType)
    .get();

  const now   = new Date().toISOString();
  const batch = db.batch();
  for (const doc of snap.docs) {
    const d = doc.data() as ProactiveTrigger;
    if (!d.firedAt && !d.cancelledAt) batch.update(doc.ref, { cancelledAt: now });
  }
  await batch.commit().catch(() => {});
}

// Detect triggers fired 24h+ ago with no user response; pause after 3 consecutive ignores
export async function checkIgnoredTriggers(): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const snap = await db.collection("proactive_triggers")
    .where("firedAt", "<=", oneDayAgo)
    .get();

  for (const doc of snap.docs) {
    const trigger = doc.data() as ProactiveTrigger & { engagedAt?: string; ignoreCounted?: boolean };
    if (!trigger.firedAt) continue;
    if (trigger.engagedAt) continue;    // user did engage
    if (trigger.ignoreCounted) continue; // already counted

    const engRef  = db.collection("trigger_engagement").doc(`${trigger.phone}_${trigger.type}`);
    const engSnap = await engRef.get();
    const prev    = (engSnap.data()?.consecutiveIgnores as number | undefined) ?? 0;
    const consecutiveIgnores = prev + 1;

    await engRef.set({
      phone:       trigger.phone,
      triggerType: trigger.type,
      consecutiveIgnores,
      lastIgnoredAt: new Date().toISOString(),
    }, { merge: true });

    await doc.ref.update({ ignoreCounted: true });

    if (consecutiveIgnores >= 3) {
      await pauseTriggerType(trigger.phone, trigger.type);

      const triggerFriendlyNames: Record<string, string> = {
        appointment_reminder: "appointment reminders",
        weekly_checkin:       "weekly check-ins",
        medication_reminder:  "medication reminders",
        custom:               "these messages",
      };
      const friendlyName = triggerFriendlyNames[trigger.type] ?? "these messages";

      await sendViaInteractionAgent(trigger.phone, {
        content:
          `I've paused the ${friendlyName} since you haven't been using them lately.\n\n` +
          `Want me to turn them back on, try a different time, or skip them for now?`,
        urgency:     "standard",
        sourceAgent: "trigger_engine",
        canDrop:     false,
      });
    }
  }
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
        // Replacement escalation — check if task still awaiting, escalate if so
        if (trigger.message.startsWith("replacement_task:")) {
          const taskId  = trigger.message.slice("replacement_task:".length);
          const taskSnap = await db.collection("agent_tasks").doc(taskId).get();
          const task     = taskSnap.data();
          if (task && task.status === "awaiting_approval") {
            const { handleNoReplacementsFound } = await import("../agents/replacementAgent");
            await handleNoReplacementsFound(
              task.appointmentId,
              task.clientId,
              task.clientPhone,
              { caregiverName: task.caregiverName, date: task.date, time: task.time }
            );
          }
        } else {
          await sendViaInteractionAgent(trigger.phone, {
            content:     trigger.message,
            urgency:     "standard",
            sourceAgent: "trigger_engine",
            canDrop:     true,
          });
        }
        await doc.ref.update({ firedAt: now });
      } catch (err) {
        console.error("triggerEngine: failed to send for", doc.id, err);
      }
    }

    // ── No-show detection — check for unacknowledged confirmed visits ─────────
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const noShowSnap = await db
      .collection("appointments")
      .where("status",          "==", "confirmed")
      .where("startDateTime",   "<=", twentyMinAgo)
      .where("noShowChecked",   "==", null)
      .limit(10)
      .get();

    for (const apptDoc of noShowSnap.docs) {
      const appt = apptDoc.data();
      if (appt.arrivedAt) continue; // caregiver arrived, not a no-show

      await apptDoc.ref.update({ noShowChecked: now });

      try {
        const clientSnap = await db.collection("users").doc(appt.clientId).get();
        const phone = (clientSnap.data() as any)?.phone as string | undefined;
        if (!phone) continue;

        const { runEmergencyReplacement } = await import("../agents/replacementAgent");
        await runEmergencyReplacement({
          appointmentId: apptDoc.id,
          clientId:      appt.clientId,
          clientPhone:   phone,
          appt,
        });
      } catch (err) {
        console.error("triggerEngine no-show handling error for", apptDoc.id, err);
      }
    }

    // Check for ignored triggers and pause after 3 consecutive ignores
    await checkIgnoredTriggers().catch((err) =>
      console.error("checkIgnoredTriggers error:", err)
    );
  });

export { runTriggerEngine as triggerEngineScheduled };
