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
    ),
    location: [cg.city, cg.state].filter(value => typeof value === "string" && value).join(", "),
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
