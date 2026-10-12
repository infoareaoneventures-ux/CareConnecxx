import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { geocodeAddress } from "../utils/geocode";

const db = admin.firestore();

// When a client completes intake, geocode their address and write lat/lng to
// users/{uid} so FindCaregivers can build clientLocations without geocoding in the browser.
// Same geocoder as every other server writer (utils/geocode.ts geocodeAddress,
// street first) since 2026-10-11.
export const geocodeClientIntake = functions.firestore
  .document("clientIntakes/{uid}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const data = change.after.data() as Record<string, unknown>;

    const street = (data.streetAddress ?? "") as string;
    const city = (data.city ?? "") as string;
    const state = (data.state ?? "") as string;
    const zipCode = (data.zipCode ?? "") as string;
    if (!street && !city && !zipCode) return;

    // Check if users doc already has coords to avoid redundant geocoding
    const userDoc = await db.collection("users").doc(context.params.uid).get();
    const existing = userDoc.exists ? (userDoc.data() as Record<string, unknown>) : {};
    if (existing.latitude != null && existing.longitude != null) return;

    const point = await geocodeAddress({ street, city, state, zipCode });
    if (!point) {
      console.warn(`geocodeClientIntake: geocoding returned null for uid=${context.params.uid}`);
      return;
    }

    await db.collection("users").doc(context.params.uid).set({
      latitude: point.lat,
      longitude: point.lng,
      geoPrecision: point.geoPrecision,
    }, { merge: true });
    console.log(`geocodeClientIntake: uid=${context.params.uid} geocoded (${point.geoPrecision}) to ${point.lat},${point.lng}`);
  });
