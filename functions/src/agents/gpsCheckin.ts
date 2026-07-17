import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const submitGpsCheckin = functions.https.onCall(async (data, context) => {
  const { caregiverId, appointmentId, latitude, longitude, manual } = data as {
    caregiverId: string;
    appointmentId: string;
    latitude?: number;
    longitude?: number;
    /** Set when the caregiver checks in without usable GPS (permission denied,
     *  signal unavailable, or timeout). Records an unvalidated arrival. */
    manual?: boolean;
  };

  // Coordinates are required unless this is an explicit manual (no-GPS) check-in.
  if (!caregiverId || !appointmentId || (!manual && (latitude == null || longitude == null))) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "caregiverId and appointmentId are required (plus latitude/longitude unless manual)"
    );
  }

  // U4 (auth-harden): require authentication and bind the check-in to the
  // authenticated caller. Previously any authenticated user could pass an
  // arbitrary caregiverId and spoof another caregiver's arrival (skewing the
  // confidence score and deceiving families). Web caregivers are uid-keyed, so
  // the auth uid is the source of truth; phone-keyed Evia caregivers check in
  // over SMS, not through this callable.
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to check in.");
  }
  if (caregiverId !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "You can only check in as yourself.");
  }

  // Get appointment
  const apptSnap = await db.collection("appointments").doc(appointmentId).get();
  if (!apptSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Appointment not found");
  }
  const appt = apptSnap.data()!;
  if (appt.caregiverId !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "This shift is not assigned to you.");
  }

  // Manual (no-GPS) check-in — record an unvalidated arrival and notify family.
  if (manual || latitude == null || longitude == null) {
    const ref = await db.collection("shift_checkins").add({
      appointmentId, caregiverId, caregiverName: appt.caregiverName, clientId: appt.clientId,
      checkinAt: new Date().toISOString(),
      status: "arrived", gpsProvided: false, gpsValidated: false,
      note: "Manual check-in (location unavailable)",
    });
    const clientSnap = await db.collection("users").doc(appt.clientId).get();
    if (clientSnap.exists && clientSnap.data()?.chatId) {
      await sendMessage(clientSnap.data()!.chatId, `${appt.caregiverName} has checked in for today's visit.`);
    }
    return { validated: false, checkinId: ref.id, message: "Checked in. The family has been notified." };
  }

  // Get client/senior address with lat/lng
  const seniorSnap = await db.collection("senior_profiles").doc(appt.clientId).get();
  const senior = seniorSnap.data();
  const clientLat: number | undefined = senior?.latitude;
  const clientLon: number | undefined = senior?.longitude;

  if (!clientLat || !clientLon) {
    // No GPS on file — create check-in without validation
    await db.collection("shift_checkins").add({
      appointmentId,
      caregiverId,
      caregiverName: appt.caregiverName,
      clientId: appt.clientId,
      checkinAt: new Date().toISOString(),
      status: "arrived",
      gpsProvided: true,
      gpsValidated: false,
      note: "Client address has no GPS coordinates on file",
    });
    return { validated: false, message: "Checked in (address coordinates not on file)." };
  }

  const distanceMeters = haversineDistanceMeters(latitude, longitude, clientLat, clientLon);
  const withinRadius = distanceMeters <= 200;

  const checkinRef = await db.collection("shift_checkins").add({
    appointmentId,
    caregiverId,
    caregiverName: appt.caregiverName,
    clientId: appt.clientId,
    checkinAt: new Date().toISOString(),
    status: withinRadius ? "arrived" : "arrived_offsite",
    gpsProvided: true,
    gpsValidated: withinRadius,
    distanceMeters: Math.round(distanceMeters),
    caregiverLat: latitude,
    caregiverLon: longitude,
  });

  // Notify client
  const clientSnap = await db.collection("users").doc(appt.clientId).get();
  if (clientSnap.exists && clientSnap.data()?.chatId) {
    const distStr = withinRadius
      ? `${Math.round(distanceMeters)}m from the address`
      : `${Math.round((distanceMeters / 1000) * 10) / 10}km from the address`;
    // R12 (hallucination hardening 2026-07-17): ground the senior's name in the
    // briefing. The appointment's own attribution (seniorName, stamped by the
    // booking path) wins; the senior profile is the fallback. When neither has
    // a name, the briefing explicitly forbids inventing one — an ungrounded
    // "with their loved one" plus a name-pushing voice is how "Marcus" happened.
    const seniorName =
      (typeof appt.seniorName === "string" && appt.seniorName.trim())
        ? appt.seniorName.trim()
        : (typeof senior?.name === "string" && senior.name.trim())
          ? senior.name.trim()
          : "";
    const arrivedMsg = withinRadius
      ? await generateCaraMessage({
          audience: "family",
          context: seniorName
            ? `Evia is notifying the family that their caregiver ${appt.caregiverName} just arrived for today's visit with ${seniorName}.`
            : `Evia is notifying the family that their caregiver ${appt.caregiverName} just arrived for today's visit. Do not name the senior — say 'their visit'; never invent a name.`,
          fallback: `${appt.caregiverName} has arrived for today's visit.`,
        })
      : `${appt.caregiverName} has checked in but appears to be ${distStr}. They may be parking.`;
    await sendMessage(clientSnap.data()!.chatId, arrivedMsg);
  }

  return {
    validated: withinRadius,
    distanceMeters: Math.round(distanceMeters),
    checkinId: checkinRef.id,
    message: withinRadius
      ? "Checked in successfully. The family has been notified."
      : `Checked in, but you appear to be ${Math.round(distanceMeters)}m from the care address.`,
  };
});
