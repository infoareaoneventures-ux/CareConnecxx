import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { geocodeAddress } from "../utils/geocode";

const db = admin.firestore();

// Safety net only (2026-10-11): every writer of job_posts (the site's
// createJobPost, Evia's buildAndSaveJobPost, the MCP create_job_post tool)
// resolves street-level coords from the family's Care Plan location BEFORE the
// write. A post that still lands without coords gets the ZIP/city centroid
// here — the public post never carries the street, so this can only ever be
// coarse — and is marked `geoPrecision: 'zip' | 'city'` for the backfill
// (scripts/backfill-job-post-coords.mjs) to re-derive from the Care Plan.
export const geocodeJobPost = functions.firestore
  .document("job_posts/{postId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const data = change.after.data() as Record<string, unknown>;

    // Skip if coords already present
    if (data.lat != null && data.lng != null) return;

    const city = (data.city ?? "") as string;
    const state = (data.state ?? "") as string;
    const zipCode = (data.zipCode ?? "") as string;
    // Legacy docs only: the WhatsNext auto-post once stored streetAddress on
    // the post (createJobPost strips it since 2026-10-11).
    const street = (data.streetAddress ?? "") as string;
    if (!street && !city && !zipCode && !data.location) return;

    // Oldest docs only carry the display string "City, ST, ZIP" (buildWebJobPostDoc's locationStr).
    const [locCity = "", locState = "", locZip = ""] = typeof data.location === "string"
      ? data.location.split(",").map((s) => s.trim()) : [];
    const point = await geocodeAddress({ street, city, state, zipCode })
      ?? (locCity || locZip ? await geocodeAddress({ city: locCity, state: locState, zipCode: locZip }) : null);
    if (!point) {
      console.warn(`geocodeJobPost: geocoding returned null for postId=${context.params.postId} city="${city}" zip="${zipCode}"`);
      return;
    }

    await db.collection("job_posts").doc(context.params.postId).update({
      lat: point.lat,
      lng: point.lng,
      geoPrecision: point.geoPrecision,
    });
    console.log(`geocodeJobPost: postId=${context.params.postId} geocoded (${point.geoPrecision}) to ${point.lat},${point.lng}`);
  });
