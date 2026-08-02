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

/**
 * Childcare U5 (plan 2026-07-22-002, R30): the derived evidence LABELS a
 * public projection may carry. Anything outside this allowlist — raw statuses,
 * report data, candidate PII, internal denial reasons, or universal safety
 * language — never reaches the projection.
 */
export const PUBLIC_CHILDCARE_EVIDENCE_LABELS: readonly string[] = [
  "background_check_current",
  "childcare_reviewed",
  "childcare_policy_accepted",
  "transport_capable",
];

/** Exported for unit tests: strip a caregiver doc down to the public subset. */
export function toPublicProfile(id: string, cg: Record<string, unknown>): Record<string, unknown> {
  const pick = (...keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (cg[k] !== undefined && cg[k] !== null) out[k] = cg[k];
    return out;
  };
  const profile: Record<string, unknown> = {
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
    ),
    location: [cg.city, cg.state].filter(value => typeof value === "string" && value).join(", "),
  };

  // ── Childcare U5 (R24/R30/AE9): derived per-vertical visibility ──────────
  // Emitted ONLY when the server-owned childcareProvider summary exists on the
  // source doc — a senior-only caregiver's projection stays BYTE-IDENTICAL to
  // the pre-childcare shape (pinned by publicCaregiverProfile parity tests).
  // When present: a visibility boolean + allowlisted evidence labels only.
  // Never the summary itself (it carries eligibility internals), never raw
  // screening state, never candidate identifiers.
  const summary = cg.childcareProvider as Record<string, unknown> | undefined;
  if (summary && typeof summary === "object") {
    const visible = summary.visible === true;
    profile.verticalVisibility = { child: visible };
    if (visible) {
      const labels = Array.isArray(summary.evidenceLabels) ? summary.evidenceLabels : [];
      profile.childcareEvidenceLabels = labels.filter(
        (l): l is string => typeof l === "string" && PUBLIC_CHILDCARE_EVIDENCE_LABELS.includes(l),
      );

      // ── Childcare U8 (R45): per-vertical reputation LABELS ────────────────
      // Numbers derived exclusively from childcare reviews/bookings
      // (caregivers.childcareReputationSummary, written by
      // childcare/reputationProjection.ts) — the senior rating/reviewCount
      // fields above stay the SENIOR aggregate. Emitted only while the
      // provider is childcare-visible; a deliberate additive extension of the
      // pinned projection key set.
      const rep = cg.childcareReputationSummary as Record<string, unknown> | undefined;
      if (rep && typeof rep === "object") {
        profile.childcareReputation = {
          ratingAvg: typeof rep.ratingAvg === "number" ? rep.ratingAvg : 0,
          ratingCount: typeof rep.ratingCount === "number" ? rep.ratingCount : 0,
          completedBookings: typeof rep.completedBookings === "number" ? rep.completedBookings : 0,
          repeatFamilies: typeof rep.repeatFamilies === "number" ? rep.repeatFamilies : 0,
        };
      }
    }
  }

  return profile;
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
