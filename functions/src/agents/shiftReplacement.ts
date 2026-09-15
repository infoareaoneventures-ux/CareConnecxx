// Shift-replacement candidate search — backend port of the website's own
// ReplacementPickerModal / fetchReplacementCandidates (components/client/
// ClientVisitsPage.tsx). Kept byte-close to that logic (same two tiers, same
// scoring/sort order, same MAX) so Evia's SMS "find me a replacement" ranks
// candidates identically to opening the site and clicking Find Replacement.
//
// 2026-09-14 (Hamse's call): built to replace get_callout_backups/
// select_callout_backup, which queried the legacy `appointments` collection —
// a data model no current booking (site or Evia) actually writes to anymore.
// This operates on `shifts`, the real collection a "Needs Replacement" card
// lives in.
import * as admin from "firebase-admin";
import { isCaregiverBookable, type CaregiverEligibilityFields } from "../utils/caregiverEligibility";
import { haversineDistanceMiles, skillsOverlap } from "./caregiverMatchScoring";

const db = admin.firestore();

export interface ReplacementCandidate {
  caregiverId: string;
  name: string;
  photoURL: string | null;
  hourlyRate: number | null;
  rating?: number;
  distanceMiles?: number | null;
  source: "care_team" | "match";
}

const MAX_CANDIDATES = 5;

// clientNeeds: this specific shift's care recipients' needs (not the client's
// needs in general) — same scoping the site uses, and the same signal that
// decides the hard transportation gate below.
export async function findReplacementCandidates(
  clientId: string,
  excludeCaregiverId: string,
  shift: { careRecipients?: Array<{ careNeeds?: string[] }> },
): Promise<ReplacementCandidate[]> {
  const candidates: ReplacementCandidate[] = [];
  const seenIds = new Set<string>([excludeCaregiverId]);

  const clientNeeds = [...new Set((shift.careRecipients || []).flatMap((r) => r.careNeeds || []))];
  const needsTransportation = clientNeeds.some((n) => /transport/i.test(n));

  // Tier 1: anyone the client has ever had a booking relationship with —
  // active Care Team AND past (completed/cancelled) bookings both count, one
  // candidate per caregiver, most recent booking wins.
  const careTeamSnap = await db.collection("booking_requests")
    .where("clientId", "==", clientId)
    .where("status", "in", ["accepted", "completed", "cancelled"])
    .get();
  const byCaregiver = new Map<string, { data: FirebaseFirestore.DocumentData; ts: number }>();
  careTeamSnap.docs.forEach((doc) => {
    const d = doc.data();
    if (!d.caregiverId) return;
    const ts = (d.updatedAt?.seconds ?? d.createdAt?.seconds ?? 0) as number;
    const existing = byCaregiver.get(d.caregiverId as string);
    if (!existing || ts > existing.ts) byCaregiver.set(d.caregiverId as string, { data: d, ts });
  });
  for (const [cgId, { data: d }] of byCaregiver) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (seenIds.has(cgId)) continue;
    // Care Team is an already-established relationship — the transportation
    // hard filter below only applies to tier 2 (strangers being suggested),
    // not to someone the family already knows and trusts.
    seenIds.add(cgId);
    candidates.push({
      caregiverId: cgId,
      name: (d.caregiverName as string) || "Caregiver",
      photoURL: (d.caregiverPhotoURL as string) || null,
      hourlyRate: (d.rate as number) ?? null,
      source: "care_team",
    });
  }

  if (candidates.length < MAX_CANDIDATES) {
    // The client's own location (for distance) — same geocoded pool
    // CarePlan.tsx's saveSection writes to on every save.
    const cpSnap = await db.collection("carePlans").doc(clientId).get().catch(() => null);
    const locationPool = (cpSnap?.data()?.locationPool as Array<{ lat?: number; lng?: number }> | undefined) || [];
    const clientLoc = locationPool.find((l) => l.lat != null && l.lng != null) || null;

    // caregivers is admin/owner-only for reads (firestore.rules) — clients
    // discover caregivers via publicCaregiverProfiles instead, same as
    // FindCaregivers.tsx / useNearbyCaregiversWithScores.
    const pool = await db.collection("publicCaregiverProfiles")
      .where("onboardingStatus", "==", "profile_complete")
      .limit(50)
      .get();
    const scored: any[] = pool.docs
      .map((d): any => ({ id: d.id, ...d.data() }))
      .filter((c: any) => !seenIds.has(c.id) && isCaregiverBookable(c as CaregiverEligibilityFields) && (!needsTransportation || c.hasValidTransportDocs))
      .map((c: any): any => {
        const cgLat = (c.lat ?? c.latitude ?? null) as number | null;
        const cgLng = (c.lng ?? c.longitude ?? null) as number | null;
        const distanceMiles = (clientLoc && cgLat != null && cgLng != null)
          ? Math.round(haversineDistanceMiles(clientLoc.lat!, clientLoc.lng!, cgLat, cgLng) * 10) / 10
          : null;
        return { ...c, _distanceMiles: distanceMiles, _skillsScore: skillsOverlap((c.skills || c.specializations || []) as string[], clientNeeds) };
      })
      .sort((a: any, b: any) => {
        const skillsDiff = b._skillsScore - a._skillsScore;
        if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
        if (a._distanceMiles != null && b._distanceMiles != null && a._distanceMiles !== b._distanceMiles) {
          return a._distanceMiles - b._distanceMiles;
        }
        return ((b.rating as number) || 0) - ((a.rating as number) || 0);
      });
    for (const c of scored) {
      if (candidates.length >= MAX_CANDIDATES) break;
      candidates.push({
        caregiverId: c.id,
        name: (c.name as string) || "Caregiver",
        photoURL: (c.photoURL ?? c.photo ?? c.profilePhoto ?? c.imageUrl ?? null) as string | null,
        hourlyRate: (c.hourlyRate as number) ?? null,
        rating: c.rating as number | undefined,
        distanceMiles: c._distanceMiles as number | null,
        source: "match",
      });
    }
  }
  return candidates;
}
