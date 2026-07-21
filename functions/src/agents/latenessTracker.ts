import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "./caraAgent";

const db = admin.firestore();

export interface LatenessEvent {
  caregiverId:   string;
  caregiverName: string;
  appointmentId: string;
  clientId:      string;
  date:          string;   // YYYY-MM-DD
  scheduledTime: string;   // HH:MM
  minutesLate:   number;
  selfReported:  boolean;
}

export async function recordLatenessEvent(event: LatenessEvent): Promise<void> {
  await db.collection("caregiver_lateness_log").add({
    ...event,
    createdAt: new Date().toISOString(),
  });
}

export async function getCaregiver30dLatenessCount(caregiverId: string): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // orderBy(date desc) reuses the existing caregiver_lateness_log
  // (caregiverId, date DESC) composite. The date>= inequality already excludes
  // older/missing entries, so ordering does not change the 30-day count.
  const snap = await db.collection("caregiver_lateness_log")
    .where("caregiverId", "==", caregiverId)
    .where("date", ">=", thirtyDaysAgo)
    .orderBy("date", "desc")
    .get();

  return snap.size;
}

export async function checkLatenessPattern(
  caregiverId:   string,
  caregiverName: string
): Promise<void> {
  const count = await getCaregiver30dLatenessCount(caregiverId);

  // Update denormalized count on caregiver doc
  await db.collection("caregivers").doc(caregiverId).update({
    latenessCount30d: count,
  }).catch(() => {});

  if (count < 3) return;

  // Check if we already sent an alert within 7 days
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const lastAlertSent = cgSnap.data()?.lastLatenessAlertSent as string | undefined;
  if (lastAlertSent) {
    const daysSince = (Date.now() - new Date(lastAlertSent).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return;
  }

  // Check for existing unresolved admin_alerts for this caregiver
  const existingAlert = await db.collection("admin_alerts")
    .where("type",        "==", "chronic_lateness")
    .where("caregiverId", "==", caregiverId)
    .where("resolved",    "==", false)
    .limit(1)
    .get();

  if (existingAlert.empty) {
    await db.collection("admin_alerts").add({
      type:          "chronic_lateness",
      caregiverId,
      caregiverName,
      latenessCount: count,
      createdAt:     new Date().toISOString(),
      resolved:      false,
      priority:      "medium",
    });
  }

  // Warn affected families with upcoming confirmed appointments for this caregiver
  const today = new Date().toISOString().slice(0, 10);
  const upcomingAppts = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("status",      "==", "confirmed")
    .where("date",        ">=", today)
    .limit(10)
    .get();

  const notifiedClients = new Set<string>();
  for (const apptDoc of upcomingAppts.docs) {
    const appt = apptDoc.data();
    if (notifiedClients.has(appt.clientId)) continue;
    notifiedClients.add(appt.clientId);

    // Get client phone
    const clientSessionSnap = await db.collection("agent_sessions")
      .where("userId", "==", appt.clientId)
      .limit(1)
      .get();
    if (clientSessionSnap.empty) continue;

    const clientPhone = clientSessionSnap.docs[0].id;
    await sendViaInteractionAgent(clientPhone, {
      content:
        `Heads up — ${caregiverName} has been running late to visits a few times recently. ` +
        `Wanted to let you know before the ${appt.date} visit. ` +
        `Reply REPLACE if you'd like a different caregiver.`,
      urgency:     "standard",
      sourceAgent: "lateness_tracker",
      canDrop:     false,
    });
  }

  await db.collection("caregivers").doc(caregiverId).update({
    lastLatenessAlertSent: new Date().toISOString(),
  }).catch(() => {});
}
