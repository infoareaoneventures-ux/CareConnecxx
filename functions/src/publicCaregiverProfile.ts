/**
 * Public caregiver profile data for the shareable /p/{id} page.
 *
 * PublicCaregiverProfile.tsx used to read caregivers/{id} + users/{id}
 * straight from Firestore, but both are rules-gated (caregivers requires
 * auth; users per-doc get is owner/admin-only) — so every visitor arriving
 * from a texted /p/{id} link saw "Profile not found" even though the OG
 * card unfurled fine (the meta function reads server-side). This callable is
 * the page's data source instead: unauthenticated-allowed, returns ONLY the
 * safe public subset (never phone/email/address/Stripe/Checkr fields), and
 * honors profileVisibility.
 */
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { hasValidTransportDocs } from "./agents/caregiverMatchScoring";

const db = admin.firestore();

/** Exported for unit tests: strip a caregiver doc down to the public subset. */
export function toPublicProfile(id: string, cg: Record<string, unknown>): Record<string, unknown> {
  const pick = (...keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (cg[k] !== undefined && cg[k] !== null) out[k] = cg[k];
    return out;
  };
  return {
    id,
    ...pick(
      "name", "firstName", "lastName", "bio", "city", "state",
      "rating", "reviewCount", "verified", "backgroundCheckStatus",
      "backgroundCheckComplete", "verificationStatus", "onboardingStatus",
      "yearsExperience", "experience", "specializations", "specialties", "skills",
      "primaryServices", "services", "languages", "certifications",
      "hourlyRate", "availability", "weeklyAvailability", "jobTypes", "isAvailable",
      "photo", "imageUrl", "profilePhoto", "photoURL",
      "lookingFor", "preferredSchedule", "isApprovedDriver", "travelRadius", "serviceRadius",
      "lat", "lng", "latitude", "longitude",
      // 2026-09-06: isCaregiverBookable() now checks these — must be present on
      // the projection or every consumer that reads publicCaregiverProfiles
      // (Dashboard widget, Browse Caregivers, find_nearby_caregivers) would
      // silently never see them and keep showing paused/opted-out caregivers
      // as bookable. optedOut itself is a mirror of the real SMS opt-out
      // (agent_sessions.optedOut) — see triggers/caregiverOptOutMirror.ts.
      "pausedUntil", "optedOut",
      // 2026-09-06: matchingAgent.ts (Evia's SMS "find a caregiver" flow) was
      // migrated from raw `caregivers` onto this projection so it reads the
      // same pool as the site — these three were only ever on the raw doc
      // and are needed for its soft budget/gender/driving-preference scoring
      // and its zip-prefix distance fallback. Not sensitive.
      "zipCode", "gender", "canDrive",
      // Internal test-data marker (scripts/seed-test-caregivers.cjs) — not
      // sensitive, but must pass through so isSeededCaregiver() still works
      // for any consumer reading this projection instead of raw caregivers.
      "__seedTag",
    ),
    location: [cg.city, cg.state].filter(value => typeof value === "string" && value).join(", "),
    // A precomputed yes/no signal, never the raw document data (background
    // check files, license scans) — this doc is meant to be publicly
    // readable, so the underlying documents themselves must never land here.
    hasValidTransportDocs: hasValidTransportDocs(cg),
  };
}

export const publicCaregiverProfile = functions.https.onCall(async (data) => {
  const id = typeof data?.id === "string" ? data.id.trim() : "";
  if (!id || id.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "id is required");
  }
  const projection = await db.collection("publicCaregiverProfiles").doc(id).get();
  if (projection.exists) return { found: true, profile: projection.data() };

  const source = await db.collection("caregivers").doc(id).get();
  if (!source.exists) return { found: false };
  const cg = source.data() as Record<string, unknown>;
  if (cg.profileVisibility === "hidden") return { found: false, hidden: true };
  console.warn(`publicCaregiverProfile: projection missing for ${id}`);
  return { found: true, profile: toPublicProfile(id, cg) };
});
