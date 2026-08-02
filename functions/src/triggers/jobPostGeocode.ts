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

export const geocodeJobPost = functions.firestore
  .document("job_posts/{postId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const data = change.after.data() as Record<string, unknown>;

    // Skip if coords already present
    if (data.lat != null && data.lng != null) return;

    const query = [data.streetAddress, data.city, data.state, data.zipCode]
      .filter(Boolean)
      .join(", ") as string || (data.location as string) || "";

    if (!query) return;

    const coords = await nominatimGeocode(query);
    if (!coords) {
      console.warn(`geocodeJobPost: Nominatim returned null for postId=${context.params.postId} query="${query}"`);
      return;
    }

    await db.collection("job_posts").doc(context.params.postId).update({
      lat: coords.lat,
      lng: coords.lng,
    });
    console.log(`geocodeJobPost: postId=${context.params.postId} geocoded to ${coords.lat},${coords.lng}`);
  });
