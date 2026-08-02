import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as https from "https";

const db = admin.firestore();

async function nominatimGeocode(query: string): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
    const options = {
      headers: {
        "User-Agent": "Evia/1.0 (eviacares.com)",
        "Accept-Language": "en",
      },
    };
    https.get(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data) && data.length > 0) {
            resolve({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

// When a client completes intake, geocode their address and write lat/lng to
// users/{uid} so FindCaregivers can build clientLocations without geocoding in the browser.
export const geocodeClientIntake = functions.firestore
  .document("clientIntakes/{uid}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const data = change.after.data() as Record<string, unknown>;

    const query = [data.streetAddress, data.city, data.state, data.zipCode]
      .filter(Boolean)
      .join(", ") as string;

    if (!query) return;

    // Check if users doc already has coords to avoid redundant geocoding
    const userDoc = await db.collection("users").doc(context.params.uid).get();
    const existing = userDoc.exists ? (userDoc.data() as Record<string, unknown>) : {};
    if (existing.latitude != null && existing.longitude != null) return;

    const coords = await nominatimGeocode(query);
    if (!coords) {
      console.warn(`geocodeClientIntake: Nominatim returned null for uid=${context.params.uid} query="${query}"`);
      return;
    }

    await db.collection("users").doc(context.params.uid).set({
      latitude: coords.lat,
      longitude: coords.lng,
    }, { merge: true });
    console.log(`geocodeClientIntake: uid=${context.params.uid} geocoded to ${coords.lat},${coords.lng}`);
  });
