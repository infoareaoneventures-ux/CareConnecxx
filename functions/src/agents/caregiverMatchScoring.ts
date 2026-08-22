/**
 * Backend port of the website dashboard's "Nearby Caregivers" scoring logic
 * (hooks/useNearbyCaregiversWithScores.ts, repo root — frontend/browser-only,
 * can't be imported into functions/). Keep the scoring math (haversine,
 * skillsOverlap, availabilityOverlap, hard filters, sort order) byte-identical
 * to that file so Evia's SMS caregiver preview ranks candidates the same way
 * the client's own dashboard would.
 */

import { CaregiverEligibilityFields, isCaregiverBookable } from "../utils/caregiverEligibility";

export function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns 0–1: fraction of the client's needed days the caregiver covers.
export function availabilityOverlap(cgAvailability: unknown, clientSchedule: unknown): number {
  if (!clientSchedule) return 0;
  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  const neededDays = new Set<string>();
  if (Array.isArray(clientSchedule)) {
    clientSchedule.forEach((d: string) => neededDays.add(String(d).toLowerCase()));
  } else if (typeof clientSchedule === "object") {
    Object.entries(clientSchedule as Record<string, unknown>).forEach(([day, slots]) => {
      const hasSlots = Array.isArray(slots) ? slots.length > 0 : !!slots;
      if (hasSlots) neededDays.add(day.toLowerCase());
    });
  }
  if (neededDays.size === 0) return 0;

  const availDays = new Set<string>();
  if (cgAvailability && typeof cgAvailability === "object" && !Array.isArray(cgAvailability)) {
    const avail = cgAvailability as Record<string, unknown>;
    DAYS.forEach((day) => {
      const slots = avail[day];
      if (Array.isArray(slots) && slots.length > 0) availDays.add(day);
    });
  } else if (Array.isArray(cgAvailability)) {
    cgAvailability.forEach((d: string) => availDays.add(String(d).toLowerCase()));
  }
  if (availDays.size === 0) return 0;

  let matched = 0;
  neededDays.forEach((day) => { if (availDays.has(day)) matched++; });
  return matched / neededDays.size;
}

// Returns 0–1: fraction of the client's needed care types the caregiver's skills cover.
export function skillsOverlap(cgSkills: string[], clientNeeds: string[]): number {
  if (!clientNeeds.length || !cgSkills.length) return 0;
  const cgLower = cgSkills.map((s) => s.toLowerCase());
  let matched = 0;
  clientNeeds.forEach((need) => {
    const n = need.toLowerCase();
    if (cgLower.some((s) => s.includes(n) || n.includes(s))) matched++;
  });
  return matched / clientNeeds.length;
}

// Twin of utils/transportDocs.ts (repo root, frontend-only) — keep both in sync.
const TRANSPORT_DOC_TYPES = ["driversLicense", "insurance", "registration"] as const;

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-");
  return new Date(+y, +m - 1, +d);
}

export function hasValidTransportDocs(profile: Record<string, unknown> | null | undefined): boolean {
  if (!profile) return false;
  const services: string[] = [
    ...((profile.skills as string[]) || []),
    ...((profile.services as string[]) || []),
  ];
  if (!services.includes("Transportation")) return false;
  const docs = profile.documents as Record<string, { status?: string; expirationDate?: string }> | undefined;
  if (!docs) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isValid = (doc: { status?: string; expirationDate?: string } | undefined) =>
    doc?.status === "approved" && (!doc.expirationDate || parseLocalDate(doc.expirationDate) >= today);
  return TRANSPORT_DOC_TYPES.every((t) => isValid(docs[t]));
}

export interface ScoredCaregiver {
  id: string;
  data: Record<string, unknown>;
  distance: number;
  skillsScore: number;
  availScore: number;
}

export interface ScoreCaregiversOptions {
  clientLocations: { lat: number; lng: number }[];
  clientCareNeeds: string[];
  clientSchedule: unknown;
  needsTransportation: boolean;
  /** Undefined = no hard distance cap (used for the relaxed backup pass). */
  maxDistance?: number;
  /** false = score everything, skip the distance/serviceRadius/transport hard filters (backup pass). */
  applyHardFilters?: boolean;
  limit?: number;
}

/**
 * Scores and ranks a pool of already-fetched caregiver docs against a
 * client's real location/needs/schedule. Pure function — the caller owns the
 * Firestore fetch, matching this module's testability goals. Mirrors
 * useNearbyCaregiversWithScores steps 4-7 (score, hard-filter, sort).
 */
export function scoreAndRankCaregivers(
  rawDocs: Array<{ id: string; data: Record<string, unknown> }>,
  opts: ScoreCaregiversOptions,
): ScoredCaregiver[] {
  const {
    clientLocations, clientCareNeeds, clientSchedule, needsTransportation,
    maxDistance, applyHardFilters = true, limit = 5,
  } = opts;

  const scored: ScoredCaregiver[] = rawDocs
    .filter(({ data }) => isCaregiverBookable(data as CaregiverEligibilityFields))
    .map(({ id, data }) => {
      const cgLat = (data.lat ?? data.latitude ?? (data as any).location?.lat) as number | undefined;
      const cgLng = (data.lng ?? data.longitude ?? (data as any).location?.lng) as number | undefined;
      let dist = 0;
      if (cgLat != null && cgLng != null && clientLocations.length > 0) {
        dist = Math.min(...clientLocations.map((loc) => haversineDistanceMiles(loc.lat, loc.lng, Number(cgLat), Number(cgLng))));
        dist = Math.round(dist * 10) / 10;
      }
      const cgSkills: string[] = (data.skills as string[]) || (data.specializations as string[]) || [];
      const cgAvailability = data.weeklyAvailability ?? data.availability;
      return {
        id,
        data,
        distance: dist,
        skillsScore: skillsOverlap(cgSkills, clientCareNeeds),
        availScore: availabilityOverlap(cgAvailability, clientSchedule),
      };
    });

  let filtered = scored;
  if (applyHardFilters) {
    filtered = filtered.filter((c) => {
      const cgLat = c.data.lat ?? c.data.latitude ?? (c.data as any).location?.lat;
      if (cgLat == null || clientLocations.length === 0) return true;
      if (maxDistance != null && c.distance > maxDistance) return false;
      const sr = (c.data.serviceRadius ?? c.data.travelRadius) as number | undefined;
      if (sr != null && sr > 0 && c.distance > sr) return false;
      return true;
    });
  }
  // Transportation is a real capability requirement, not a soft distance
  // preference — a relaxed backup pass must never surface a caregiver who
  // can't actually provide the transportation the family said they need.
  if (needsTransportation) {
    filtered = filtered.filter((c) => hasValidTransportDocs(c.data));
  }

  return filtered
    .sort((a, b) => {
      const skillsDiff = b.skillsScore - a.skillsScore;
      if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
      const availDiff = b.availScore - a.availScore;
      if (Math.abs(availDiff) > 0.01) return availDiff;
      const ratingDiff = (Number(b.data.rating) || 0) - (Number(a.data.rating) || 0);
      if (ratingDiff !== 0) return ratingDiff;
      return a.distance - b.distance;
    })
    .slice(0, limit);
}
