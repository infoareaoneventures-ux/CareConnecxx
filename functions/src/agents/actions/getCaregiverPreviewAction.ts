import * as admin from "firebase-admin";
import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext } from "../actionNative/caraActionTypes";
import { scoreAndRankCaregivers } from "../caregiverMatchScoring";

const db = admin.firestore();

const caregiverPreviewInputSchema = z.object({
  city: z.string().optional().default(""),
  seniorName: z.string().optional().default("your loved one"),
  careNeeds: z.array(z.string()).optional().default([]),
  // When lat/lng are present, powers real distance + skills/availability
  // scoring — the same logic as the website dashboard's Nearby Caregivers
  // widget — instead of the plain exact-city-string match below.
  lat: z.number().optional(),
  lng: z.number().optional(),
  schedule: z.array(z.string()).optional(),
  needsTransportation: z.boolean().optional().default(false),
});

const caregiverPreviewItemSchema = z.object({
  /** Firestore doc id — powers the /p/{id} public profile link in the SMS gallery. */
  id: z.string().optional(),
  name: z.string(),
  yearsExperience: z.string().optional(),
  strongestFit: z.string().optional(),
  /** Headshot URL (same resolution chain the webapp uses) for the photo bubble. */
  photo: z.string().optional(),
});

const caregiverPreviewOutputSchema = z.object({
  available: z.boolean(),
  widened: z.boolean(),
  total: z.number(),
  locationLabel: z.string(),
  needsLabel: z.string(),
  items: z.array(caregiverPreviewItemSchema),
  message: z.string(),
});

export type CaregiverPreviewInput = z.infer<typeof caregiverPreviewInputSchema>;
export type CaregiverPreviewOutput = z.infer<typeof caregiverPreviewOutputSchema>;

type RawCaregiver = Record<string, unknown>;

/**
 * Test-seed caregivers (scripts/seed-test-caregivers.cjs) are tagged with
 * __seedTag so they can be cleaned up exactly. They must NEVER be shown to a
 * real family — the widened-city fallback below would otherwise defeat the
 * "uncommon city" mitigation the seed script relies on.
 */
export function isSeededCaregiver(caregiver: RawCaregiver): boolean {
  return Boolean(caregiver && (caregiver as Record<string, unknown>).__seedTag);
}

// The exact-city and widened-city lookups previously ignored
// needsTransportation entirely — only the scored (lat/lng) path applied it.
// hasValidTransportDocs is precomputed on publicCaregiverProfiles at
// projection-write time (publicCaregiverProfile.ts), so it's queryable
// directly here without a document read per candidate.
function applyTransportFilter(
  query: FirebaseFirestore.Query,
  needsTransportation: boolean | undefined,
): FirebaseFirestore.Query {
  return needsTransportation ? query.where("hasValidTransportDocs", "==", true) : query;
}

export const getCaregiverPreviewCaraAction = defineCaraAction({
  name: "get_caregiver_preview",
  description: "Read active caregivers and return a short curated preview for client onboarding.",
  inputSchema: caregiverPreviewInputSchema,
  outputSchema: caregiverPreviewOutputSchema,
  readOnly: true,
  modelVisible: true,
  webVisible: true,
  adminOnly: false,
  publicAllowed: false,
  allowedRoles: ["client", "admin", "system"],
  run: async input => {
    // Real coordinates unlock the same distance + skills/availability scoring
    // the website dashboard's Nearby Caregivers widget uses, instead of the
    // plain exact-city-string match below (kept as the fallback for callers
    // that don't have coordinates yet).
    if (input.lat != null && input.lng != null) {
      return runScoredCaregiverPreview(input as CaregiverPreviewInput & { lat: number; lng: number });
    }

    // Fetch a wider window than we show (15 vs 5): the seed filter runs
    // post-fetch, so a small limit could be consumed entirely by seeded docs
    // and starve real caregivers ranked just past it.
    // Read from the SAME collection the website's own caregiver-matching
    // surfaces read from (publicCaregiverProfiles, the filtered/projected
    // copy of caregivers — hooks/useNearbyCaregiversWithScores.ts,
    // components/FindCaregivers.tsx) instead of a separate query against the
    // raw caregivers collection, so a caregiver who's hidden from the site is
    // hidden from this preview too, automatically — no separate visibility
    // check needed here since the projection trigger already excludes them.
    // Mirror the dashboard's visibility contract: onboardingStatus='profile_complete'
    // AND verificationStatus='approved' — same pool clients see in FindCaregivers.
    // verificationStatus is set automatically by Checkr on a 'clear' result;
    // admin only intervenes on 'consider' exceptions.
    const localSnap = input.city
      ? await applyTransportFilter(
          db
            .collection("publicCaregiverProfiles")
            .where("onboardingStatus", "==", "profile_complete")
            .where("verificationStatus", "==", "approved")
            .where("city", "==", input.city),
          input.needsTransportation,
        )
          .limit(15)
          .get()
      : await emptyQuerySnapshot();

    const localCaregivers = localSnap.docs
      .map(doc => ({ ...doc.data(), id: doc.id }))
      .filter(c => !isSeededCaregiver(c))
      .slice(0, 5);

    if (localCaregivers.length > 0) {
      return buildCaregiverPreviewResult({
        caregivers: localCaregivers,
        widened: false,
        city: input.city,
        seniorName: input.seniorName,
        careNeeds: input.careNeeds,
      });
    }

    const widerSnap = await applyTransportFilter(
      db.collection("publicCaregiverProfiles")
        .where("onboardingStatus", "==", "profile_complete")
        .where("verificationStatus", "==", "approved"),
      input.needsTransportation,
    )
      .limit(15)
      .get();
    const widerCaregivers = widerSnap.docs
      .map(doc => ({ ...doc.data(), id: doc.id }))
      .filter(c => !isSeededCaregiver(c))
      .slice(0, 5);
    return buildCaregiverPreviewResult({
      caregivers: widerCaregivers,
      widened: widerCaregivers.length > 0,
      city: input.city,
      seniorName: input.seniorName,
      careNeeds: input.careNeeds,
    });
  },
});

export async function runGetCaregiverPreviewAction(
  input: unknown,
  ctx: CaraActionContext,
): Promise<CaregiverPreviewOutput> {
  return runCaraAction(getCaregiverPreviewCaraAction, input, ctx);
}

/**
 * Real distance + skills/availability scoring (mirrors the website dashboard's
 * Nearby Caregivers widget — hooks/useNearbyCaregiversWithScores.ts, ported
 * for the backend in caregiverMatchScoring.ts). Primary pass applies the same
 * hard filters the dashboard does (25mi radius / caregiver's own service
 * radius / transport docs if needed); if that finds nobody, a relaxed backup
 * pass re-ranks the SAME candidate pool with those filters dropped (still
 * sorted by skills → availability → rating → distance) rather than falling
 * back to an unordered "just grab whoever's active" query.
 */
async function runScoredCaregiverPreview(
  input: CaregiverPreviewInput & { lat: number; lng: number },
): Promise<CaregiverPreviewOutput> {
  // publicCaregiverProfiles — see the comment on the exact-city query above.
  const snap = await db.collection("publicCaregiverProfiles")
    .where("onboardingStatus", "==", "profile_complete")
    .limit(100)
    .get();
  const rawDocs = snap.docs
    .map(doc => ({ id: doc.id, data: { ...doc.data(), id: doc.id } }))
    .filter(({ data }) => !isSeededCaregiver(data));

  const scoreOpts = {
    clientLocations: [{ lat: input.lat, lng: input.lng }],
    clientCareNeeds: input.careNeeds,
    clientSchedule: input.schedule,
    needsTransportation: input.needsTransportation,
  };

  const primary = scoreAndRankCaregivers(rawDocs, { ...scoreOpts, maxDistance: 25, applyHardFilters: true });
  if (primary.length > 0) {
    return buildCaregiverPreviewResult({
      caregivers: primary.map(c => c.data),
      widened: false,
      city: input.city,
      seniorName: input.seniorName,
      careNeeds: input.careNeeds,
    });
  }

  const backup = scoreAndRankCaregivers(rawDocs, { ...scoreOpts, applyHardFilters: false });
  return buildCaregiverPreviewResult({
    caregivers: backup.map(c => c.data),
    widened: backup.length > 0,
    city: input.city,
    seniorName: input.seniorName,
    careNeeds: input.careNeeds,
  });
}

export function buildCaregiverPreviewResult(opts: {
  caregivers: RawCaregiver[];
  widened: boolean;
  city?: string;
  seniorName?: string;
  careNeeds?: string[];
}): CaregiverPreviewOutput {
  const city = (opts.city ?? "").trim();
  const seniorName = (opts.seniorName ?? "").trim() || "your loved one";
  const careNeeds = Array.isArray(opts.careNeeds) ? opts.careNeeds.filter(Boolean) : [];
  const locationLabel = city || "your area";
  const needsLabel = careNeeds.length > 0 ? careNeeds.slice(0, 2).join(" & ") : "care";
  const caregivers = opts.caregivers.slice(0, 5);
  const items = caregivers.slice(0, 3).map(toPreviewItem);

  if (caregivers.length === 0) {
    return {
      available: false,
      widened: false,
      total: 0,
      locationLabel,
      needsLabel,
      items: [],
      message:
        `I don't have caregivers available in ${locationLabel} just yet, but I've saved everything about ` +
        `${seniorName}'s care, and I'll text you the moment the right person is available. No charge until then.`,
    };
  }

  const previewText = joinCaregiverPreview(
    items.map(item =>
      `${item.name}${item.yearsExperience ? `, ${item.yearsExperience} yrs experience` : ""}` +
      `${item.strongestFit ? `, strongest fit for ${item.strongestFit}` : ""}`,
    ),
  );

  const message = opts.widened
    ? `I don't have caregivers right in ${locationLabel} yet, but I do have nearby options for ${seniorName}: ${previewText}. ` +
      "I would start with the best fit, confirm the schedule, and keep the family updated here."
    : `I found ${caregivers.length > 5 ? "6+" : caregivers.length} caregiver${caregivers.length !== 1 ? "s" : ""} near ${locationLabel} ` +
      `who can help with ${needsLabel}. ${previewText}. ` +
      "I would start with the best fit, confirm the schedule, and keep the family updated here.";

  return {
    available: true,
    widened: opts.widened,
    total: caregivers.length,
    locationLabel,
    needsLabel,
    items,
    message,
  };
}

function toPreviewItem(caregiver: RawCaregiver): z.infer<typeof caregiverPreviewItemSchema> {
  const id = stringValue(caregiver.id);
  const name = stringValue(caregiver.name) || "Caregiver";
  const experience = stringValue(caregiver.yearsExperience) || stringValue(caregiver.experience);
  const strongestFit =
    firstString(caregiver.specialties) ||
    firstServiceName(caregiver.primaryServices) ||
    firstString(caregiver.skills) ||
    firstString(caregiver.services);
  // Same photo resolution chain as the webapp readers (photo || imageUrl ||
  // profilePhoto || photoURL — see PublicCaregiverProfile.tsx).
  const photo =
    stringValue(caregiver.photo) ||
    stringValue(caregiver.imageUrl) ||
    stringValue((caregiver as Record<string, unknown>).profilePhoto) ||
    stringValue((caregiver as Record<string, unknown>).photoURL);
  return {
    ...(id ? { id } : {}),
    name,
    ...(experience ? { yearsExperience: experience } : {}),
    ...(strongestFit ? { strongestFit } : {}),
    ...(photo ? { photo } : {}),
  };
}

function joinCaregiverPreview(items: string[]): string {
  if (items.length === 0) return "I have a few options to review";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}`;
}

function stringValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function firstString(value: unknown): string {
  return Array.isArray(value) ? stringValue(value[0]) : "";
}

function firstServiceName(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const first = value[0];
  if (!first || typeof first !== "object") return "";
  return stringValue((first as Record<string, unknown>).name);
}

async function emptyQuerySnapshot(): Promise<{ empty: true; docs: []; size: 0 }> {
  return { empty: true, docs: [], size: 0 };
}
