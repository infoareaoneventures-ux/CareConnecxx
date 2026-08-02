import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as https from "https";
import { geocodeCityOrZip } from "../utils/geocode";

const db = admin.firestore();

async function nominatimFullAddress(query: string): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
    https.get(url, { headers: { "User-Agent": "Evia/1.0 (eviacares.com)", "Accept-Language": "en" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(Array.isArray(data) && data.length > 0 ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// Geocode caregiver address server-side whenever city/state/zip changes or coords are missing.
// Tries full street address (Nominatim) first for precision, falls back to ZIP → city.
// Writes all four coord fields so every read path agrees.
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

    // Try full street address first (most precise), fall back to ZIP → city centroid
    const fullQuery = [street, city, state, zipCode].filter(Boolean).join(", ");
    const coords = (fullQuery ? await nominatimFullAddress(fullQuery) : null)
      ?? await geocodeCityOrZip(city, zipCode, state);

    if (!coords) {
      console.warn(`geocodeCaregiverDoc: geocoding returned null for uid=${context.params.uid} query="${fullQuery}"`);
      return;
    }

    await db.collection("caregivers").doc(context.params.uid).update({
      lat: coords.lat,
      lng: coords.lng,
      latitude: coords.lat,
      longitude: coords.lng,
    });
    console.log(`geocodeCaregiverDoc: uid=${context.params.uid} geocoded to ${coords.lat},${coords.lng}`);
  });
