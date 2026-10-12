import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { geocodeAddress } from "../utils/geocode";

const db = admin.firestore();

// THE owner of a caregiver's coordinates (2026-10-11). Runs on every write of
// caregivers/{uid} and (re)geocodes whenever the address fields change or the
// coords are missing — street first, then ZIP, then city (utils/geocode.ts
// geocodeAddress, the one server geocoder), stamping `geoPrecision` so a
// backfill can find the ZIP-level points. Evia's text onboarding writes NO
// coords of its own any more (the ZIP-level ensureCaregiverCoords is gone);
// the site's Settings / wizard writes are street-level and re-derived here
// identically on the same write. Writes all four coord fields so every read
// path (lat/lng and latitude/longitude) agrees.
export const geocodeCaregiverDoc = functions.firestore
  .document("caregivers/{uid}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after = change.after.data() as Record<string, unknown>;
    const before = change.before.exists ? (change.before.data() as Record<string, unknown>) : {};

    // Re-geocode when address fields changed OR when coords are missing
    const addressChanged =
      after.city !== before.city ||
      after.state !== before.state ||
      after.zipCode !== before.zipCode ||
      after.street !== before.street;
    const coordsMissing = after.lat == null || after.lng == null;

    if (!addressChanged && !coordsMissing) return;

    const street = (after.street ?? "") as string;
    const city = (after.city ?? "") as string;
    const zipCode = (after.zipCode ?? "") as string;
    const state = (after.state ?? "") as string;

    if (!city && !zipCode) return;

    const point = await geocodeAddress({ street, city, state, zipCode });

    if (!point) {
      console.warn(`geocodeCaregiverDoc: geocoding returned null for uid=${context.params.uid} street=${street ? "yes" : "no"} zip="${zipCode}"`);
      return;
    }

    await db.collection("caregivers").doc(context.params.uid).update({
      lat: point.lat,
      lng: point.lng,
      latitude: point.lat,
      longitude: point.lng,
      geoPrecision: point.geoPrecision,
    });
    console.log(`geocodeCaregiverDoc: uid=${context.params.uid} geocoded (${point.geoPrecision}) to ${point.lat},${point.lng}`);
  });
