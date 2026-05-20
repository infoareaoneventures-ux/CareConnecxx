import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

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
  const { caregiverId, appointmentId, latitude, longitude } = data as {
    caregiverId: string;
    appointmentId: string;
    latitude: number;
    longitude: number;
  };

  if (!caregiverId || !appointmentId || latitude == null || longitude == null) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "caregiverId, appointmentId, latitude, and longitude are required"
    );
  }

  // Get appointment
  const apptSnap = await db.collection("appointments").doc(appointmentId).get();
  if (!apptSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Appointment not found");
  }
  const appt = apptSnap.data()!;

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
    const msg = withinRadius
      ? `${appt.caregiverName} has arrived for today's visit.`
      : `${appt.caregiverName} has checked in but appears to be ${distStr}. They may be parking.`;
    await sendMessage(clientSnap.data()!.chatId, msg);
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
