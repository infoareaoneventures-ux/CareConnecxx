import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { businessNowMinutes, formatHHMMForDisplay } from "../utils/scheduledTime";
import { queryVisitsMerged, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

interface RoutineTask {
  id:          string;
  time:        string;
  description: string;
  category:    "meal" | "medication" | "activity" | "hygiene";
  isCompleted?: boolean;
}

interface Medication {
  id:        string;
  name:      string;
  dosage:    string;
  frequency: string;
  notes?:    string;
}

// Parses "8:00 AM", "2:30 PM", or "14:30" → minutes since midnight. Returns null if unparseable.
function parseTimeToMinutes(timeStr: string): number | null {
  const trimmed = (timeStr ?? "").trim();

  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const period = ampm[3].toUpperCase();
    if (period === "AM") { if (h === 12) h = 0; }
    else                 { if (h !== 12) h += 12; }
    return h * 60 + m;
  }

  const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
  }

  return null;
}

function isTaskUpcoming(taskMinutes: number, nowMinutes: number, windowEnd: number): boolean {
  if (windowEnd <= 1439) {
    return taskMinutes >= nowMinutes && taskMinutes <= windowEnd;
  }
  // Window wraps past midnight
  return taskMinutes >= nowMinutes || taskMinutes <= (windowEnd - 1440);
}

async function loadCarePlan(
  seniorId: string,
  clientId: string
): Promise<{ dailyRoutine: RoutineTask[]; medications: Medication[] }> {
  const empty = { dailyRoutine: [], medications: [] };

  // 1. CANONICAL path (web cutover 2026-07-12): care_plans/{clientId} — the doc
  // both the web Care Plan tab and Evia's care-plan tools write. Must be checked
  // FIRST or a stale legacy subdoc shadows fresh data.
  if (clientId) {
    const snap = await db.collection("care_plans").doc(clientId).get();
    if (snap.exists) {
      const d = snap.data()!;
      return {
        dailyRoutine: (d.dailyRoutine ?? []) as RoutineTask[],
        medications:  (d.medications  ?? []) as Medication[],
      };
    }
  }

  // 2. Legacy web subdoc: senior_profiles/{seniorId}/care_plans/default
  if (seniorId) {
    const snap = await db.collection("senior_profiles").doc(seniorId)
      .collection("care_plans").doc("default").get();
    if (snap.exists) {
      const d = snap.data()!;
      return {
        dailyRoutine: (d.dailyRoutine ?? []) as RoutineTask[],
        medications:  (d.medications  ?? []) as Medication[],
      };
    }
  }

  // 3. Legacy 1:1 model: senior_profiles/{clientId}/care_plans/default
  if (clientId && clientId !== seniorId) {
    const snap = await db.collection("senior_profiles").doc(clientId)
      .collection("care_plans").doc("default").get();
    if (snap.exists) {
      const d = snap.data()!;
      return {
        dailyRoutine: (d.dailyRoutine ?? []) as RoutineTask[],
        medications:  (d.medications  ?? []) as Medication[],
      };
    }
  }

  return empty;
}

async function getCompletedTaskIds(appointmentId: string): Promise<Set<string>> {
  const snap = await db.collection("appointment_care_plans")
    .where("appointmentId", "==", appointmentId)
    .limit(1)
    .get();
  if (snap.empty) return new Set();
  return new Set((snap.docs[0].data().tasksCompleted ?? []) as string[]);
}

export const sendShiftTaskNudges = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    // Business-timezone (Pacific) minutes-since-midnight — getHours() would be
    // UTC on Cloud Functions and mis-fire task nudges by ~7-8h.
    const nowMinutes = businessNowMinutes();
    const windowEnd  = nowMinutes + 30;

    const docs = await queryVisitsMerged({
      apptStatuses: ["in-progress"],
      shiftStatuses: ["in-progress"],
    });

    // completedAt is set by handleDone — filter in-memory since Firestore can't query for absent fields
    const activeAppts = docs.filter(doc => !doc.data().completedAt);

    for (const apptDoc of activeAppts) {
      const appt  = apptDoc.data();
      const apptId = apptDoc.id;

      try {
        const caregiverId = appt.caregiverId as string;
        if (!caregiverId) continue;

        const cgSnap  = await db.collection("caregivers").doc(caregiverId).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (!cgPhone) continue;

        // Skip if caregiver session has a blocking state flag active (incl. an
        // open in-shift check-in prompt — a task nudge would shadow its reply)
        const sessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
        if (sessionSnap.exists) {
          const s = sessionSnap.data() as any;
          if (s.awaitingCareNotes || s.awaitingLateMinutes || s.awaitingIssueDescription || s.awaitingInShiftUpdate) continue;
        }

        const clientId = (appt.clientId ?? "") as string;
        const seniorId = (appt.seniorId ?? clientId) as string;

        const { dailyRoutine, medications } = await loadCarePlan(seniorId, clientId);
        if (dailyRoutine.length === 0) continue;

        const nudgedTaskIds   = new Set<string>((appt.nudgedTaskIds   ?? []) as string[]);
        const completedBySms  = new Set<string>((appt.completedTaskIds ?? []) as string[]);
        const completedByApp  = await getCompletedTaskIds(apptId);

        for (const task of dailyRoutine) {
          if (!task.id || !task.time) continue;
          if (nudgedTaskIds.has(task.id))   continue; // already nudged
          if (completedBySms.has(task.id))  continue; // confirmed done via SMS
          if (completedByApp.has(task.id))  continue; // checked off in the app

          const taskMinutes = parseTimeToMinutes(task.time);
          if (taskMinutes === null) continue;
          if (!isTaskUpcoming(taskMinutes, nowMinutes, windowEnd)) continue;

          // Build nudge message — use Claude for a warm, natural reminder
          const isMed = task.category === "medication";
          const matched = isMed
            ? medications.find(m => task.description.toLowerCase().includes(m.name.toLowerCase()))
            : null;
          const medDetail = matched ? ` ${matched.name} ${matched.dosage}` : "";

          const cgFirstName = (cgSnap.data()?.name ?? "").split(" ")[0] || "there";
          const seniorNameForNudge = visitSeniorName(appt, "your client");

          const content = await generateCaraMessage({
            audience: "caregiver",
            context: isMed
              ? `Write a friendly medication reminder to ${cgFirstName}. ` +
                `It's almost time for ${seniorNameForNudge}'s ${task.description} at ${formatHHMMForDisplay(task.time)}.` +
                `${medDetail ? " Medication: " + medDetail + "." : ""} ` +
                `Ask them to let you know once it's been given. Keep it warm and brief.`
              : `Write a friendly care task reminder to ${cgFirstName}. ` +
                `It's almost time for ${seniorNameForNudge}'s ${task.description} at ${formatHHMMForDisplay(task.time)}. ` +
                `Ask them to let you know when it's done. Keep it short and encouraging.`,
            fallback: isMed
              ? `Hey ${cgFirstName}, almost time for ${seniorNameForNudge}'s ${task.description} at ${formatHHMMForDisplay(task.time)}.${medDetail ? " (" + medDetail + ")" : ""} Let me know when it's done!`
              : `Hey ${cgFirstName}, heads up — ${seniorNameForNudge}'s ${task.description} is coming up at ${formatHHMMForDisplay(task.time)}. Give me a shout when it's done!`,
          });

          await sendViaInteractionAgent(cgPhone, {
            content,
            urgency:     "standard",
            sourceAgent: "shift_task_nudge",
            canDrop:     true,
          });

          // Mark as nudged immediately (before next iteration in case of crash)
          await apptDoc.ref.update({
            nudgedTaskIds: admin.firestore.FieldValue.arrayUnion(task.id),
          });
          nudgedTaskIds.add(task.id);

          // Set awaitingTaskAck on the caregiver session so their reply is routed correctly
          if (sessionSnap.exists) {
            const seniorNameSnap = seniorId
              ? await db.collection("senior_profiles").doc(seniorId).get().catch(() => null)
              : null;
            const seniorName = (seniorNameSnap?.data()?.name ?? appt.clientName ?? "") as string;

            await db.collection("agent_sessions").doc(cgPhone).update({
              awaitingTaskAck: {
                taskId:          task.id,
                taskDescription: task.description,
                taskCategory:    task.category,
                appointmentId:   apptId,
                clientId,
                seniorId,
                seniorName,
                nudgedAt: new Date().toISOString(),
              },
              stateExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            });
          }

          // Only nudge one task per run per caregiver to avoid flooding
          break;
        }
      } catch (err) {
        console.error(`[sendShiftTaskNudges] Error for appointment ${apptId}:`, err);
      }
    }
  });
