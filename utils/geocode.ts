export async function geocodeToLatLng(
  street?: string,
  city?: string,
  state?: string,
  zipCode?: string
): Promise<{ lat: number; lng: number } | null> {
  const query = [street, city, state, zipCode].filter(Boolean).join(', ');
  if (!query) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'Evia/1.0' } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

// ── ONE geocoding rule, street-level first (2026-10-11) ─────────────────────
// Distance between a family's post/visit and a caregiver is a haversine
// between stored points, so both ends must be the STREET, not the ZIP centroid.
// Every site writer of a point (Post Job, the Care Plan location pool, the
// caregiver's Settings / wizard address) resolves it here — the full street
// address via Nominatim when a street is known, else the ZIP centroid
// (zippopotam, the same lookup the ZIP fields use), else the city — and says
// which one it got (`geoPrecision`), so a job post can reuse a saved
// street-level point as is and a backfill can target the coarse ones. The
// server twin is functions/src/utils/geocode.ts geocodeAddress.
export type GeoPrecision = 'street' | 'zip' | 'city';
export interface GeocodedPoint { lat: number; lng: number; geoPrecision: GeoPrecision }
export interface GeocodeAddressInput { street?: string | null; city?: string | null; state?: string | null; zipCode?: string | null }

async function geocodeZipCentroid(zipCode: string): Promise<{ lat: number; lng: number } | null> {
  if (!/^\d{5}$/.test(zipCode)) return null;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zipCode}`);
    if (!res.ok) return null;
    const json = await res.json();
    const place = json?.places?.[0];
    if (place?.latitude && place?.longitude) return { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) };
  } catch { /* fall through */ }
  return null;
}

export async function geocodeAddress(addr: GeocodeAddressInput): Promise<GeocodedPoint | null> {
  const street  = (addr.street  ?? '').toString().trim();
  const city    = (addr.city    ?? '').toString().trim();
  const state   = (addr.state   ?? '').toString().trim();
  const zipCode = (addr.zipCode ?? '').toString().trim();
  if (street) {
    const hit = await geocodeToLatLng(street, city, state, zipCode);
    if (hit) return { ...hit, geoPrecision: 'street' };
  }
  const zipHit = await geocodeZipCentroid(zipCode);
  if (zipHit) return { ...zipHit, geoPrecision: 'zip' };
  if (city) {
    const cityHit = await geocodeToLatLng(undefined, city, state || undefined, undefined);
    if (cityHit) return { ...cityHit, geoPrecision: 'city' };
  }
  return null;
}

/** A stored point only when it is street-level (what a job post may reuse without geocoding again). */
export function streetPointOf(entry: unknown): GeocodedPoint | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (e.geoPrecision !== 'street') return null;
  const lat = e.lat ?? e.latitude;
  const lng = e.lng ?? e.longitude;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, geoPrecision: 'street' };
  }
  return null;
}
