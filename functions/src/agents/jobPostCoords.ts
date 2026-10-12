// The ONE rule for a job post's point (2026-10-11), both doors:
//
//   1. the family's Care Plan location (carePlans.locationPool entry matching
//      street + zip) when it already carries STREET-level coords
//      (geoPrecision 'street' — written by the Care Plan page, the site's
//      Post Job step 2, Evia's care-plan tools and this finalizer);
//   2. else geocode the street now (utils/geocode.ts geocodeAddress — the one
//      server geocoder — Nominatim on the full address);
//   3. last resort the ZIP centroid, then the city.
//
// The post stores lat/lng + city/state/zip + geoPrecision — NEVER the street
// (jobPostContract.ts keeps streetAddress out of job_posts). The site's
// services/api.ts createJobPost follows the same three steps with the site's
// utils/geocode.ts geocodeAddress.
import { geocodeAddress, GeoPrecision } from "../utils/geocode";

export interface JobPostAddress { street?: string | null; city?: string | null; state?: string | null; zipCode?: string | null }
export interface JobPostPoint { lat: number; lng: number; geoPrecision: GeoPrecision }

const poolKey = (street: unknown, zip: unknown): string =>
  `${String(street ?? "").toLowerCase().trim()}|${String(zip ?? "").trim()}`;

/** The matching pool entry's coords, only when they are street-level. */
export function poolEntryStreetPoint(pool: unknown, street?: string | null, zipCode?: string | null): JobPostPoint | null {
  if (!street || !Array.isArray(pool)) return null;
  const key = poolKey(street, zipCode);
  for (const raw of pool as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (poolKey(l.street, l.zipCode) !== key) continue;
    if (l.geoPrecision !== "street") return null;
    const lat = l.lat ?? l.latitude;
    const lng = l.lng ?? l.longitude;
    if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, geoPrecision: "street" };
    }
    return null;
  }
  return null;
}

export async function resolveJobPostPoint(pool: unknown, addr: JobPostAddress): Promise<JobPostPoint | null> {
  const fromPool = poolEntryStreetPoint(pool, addr.street, addr.zipCode);
  if (fromPool) return fromPool;
  return geocodeAddress(addr);
}
