import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

export const triggerFamilyEmergency = functions.https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const { appointmentId } = data as { appointmentId: string };
  const clientId = context.auth.uid;

  if (!appointmentId) {
    throw new functions.https.HttpsError("invalid-argument", "appointmentId is required");
  }

  // HIPAA audit log
  await db.collection("emergency_events").add({
    type:        "family_panic",
    clientId,
    appointmentId,
    triggeredAt: new Date().toISOString(),
    triggeredBy: clientId,
  });

  // Get appointment details
  const apptSnap = await db.collection("appointments").doc(appointmentId).get();
  const appt = apptSnap.data();
  if (!appt) {
    throw new functions.https.HttpsError("not-found", "Appointment not found");
  }

  // Alert the caregiver
  if (appt.caregiverPhone) {
    await sendViaInteractionAgent(appt.caregiverPhone as string, {
      content:
        `🚨 EMERGENCY: The family needs immediate help. ` +
        `Please check on ${appt.seniorName ?? "the client"} right away and call 911 if needed.`,
      urgency:     "immediate",
      sourceAgent: "emergency_replacement",
      canDrop:     false,
      // Life-critical — force SMS so delivery never silently fails on iMessage.
      preferredService: "SMS",
    });
  }

  // Open admin alert for on-call team
  await db.collection("admin_alerts").add({
    type:          "family_emergency",
    clientId,
    appointmentId,
    caregiverId:   appt.caregiverId ?? null,
    createdAt:     new Date().toISOString(),
    resolved:      false,
    severity:      "critical",
  });

  return { success: true };
});
