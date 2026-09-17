import axios from "axios";

// Shared US geocoding for job posts AND caregiver docs — proximity matching
// (notifyAreaCaregivers / caregiverJobMatch / aiMatching) is dead for any doc
// without lat/lng, so every writer that knows a city or ZIP should call these.
// Extracted from buildJobPost.ts 2026-07-14 when caregiver onboarding gained
// geocoding (SMS-onboarded caregivers had NO coords — radius matching skipped
// them entirely).

// zippopotam.us — free, no API key.
export async function geocodeZip(zipCode: string): Promise<{ lat: number; lng: number } | null> {
  if (!zipCode || zipCode.length < 5) return null;
  try {
    const resp = await axios.get(`https://api.zippopotam.us/us/${zipCode}`, { timeout: 5000 });
    const place = resp.data?.places?.[0];
    if (place?.latitude && place?.longitude) {
      return { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) };
    }
  } catch {
    // Non-critical — callers fall through to city geocoding / no coords.
  }
  return null;
}

// Zip → city/state lookup (2026-08-22) — mirrors ClientJobPostingWizard.tsx's
// handleHomeZip/handleCustomZip exactly (same api.zippopotam.us call, same
// `place['place name']`/`place['state abbreviation']` fields), so the SMS
// side derives city/state from a zip the identical way the website does,
// instead of asking the family for a city (or letting a model extraction
// guess one from a street name — the live bug this closes: a street named
// "Campbell Ave" got mistaken for the city "Campbell").
export interface ZipPlace { lat: number; lng: number; city: string; state: string }

export async function lookupZipPlace(zipCode: string): Promise<ZipPlace | null> {
  if (!zipCode || zipCode.length !== 5) return null;
  try {
    const resp = await axios.get(`https://api.zippopotam.us/us/${zipCode}`, { timeout: 5000 });
    const place = resp.data?.places?.[0];
    if (place?.latitude && place?.longitude) {
      return {
        lat:   parseFloat(place.latitude),
        lng:   parseFloat(place.longitude),
        city:  place["place name"] ?? "",
        state: place["state abbreviation"] ?? "",
      };
    }
  } catch {
    // Non-critical — caller proceeds without auto-populated city/state.
  }
  return null;
}

// City-name fallback (OpenStreetMap Nominatim — free, no key). The
// conversational intake captures a CITY ("Santa Clara") but usually no ZIP.
// State defaults to California (service area is Santa Clara County) when the
// caller didn't capture one, so a bare city name isn't ambiguous across states.
export async function geocodeCity(city: string, state?: string): Promise<{ lat: number; lng: number } | null> {
  if (!city || !city.trim()) return null;
  try {
    const resp = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { format: "json", country: "USA", state: state || "California", city: city.trim(), limit: 1 },
      headers: { "User-Agent": "EviaCares/1.0 (support@eviacares.com)" },
      timeout: 5000,
    });
    const place = resp.data?.[0];
    if (place?.lat && place?.lon) {
      return { lat: parseFloat(place.lat), lng: parseFloat(place.lon) };
    }
  } catch {
    // Non-critical — caller proceeds without coords (city-string match nets remain).
  }
  return null;
}

// ZIP first (more precise), city-name fallback.
export async function geocodeCityOrZip(
  city?: string, zipCode?: string, state?: string,
): Promise<{ lat: number; lng: number } | null> {
  return (await geocodeZip(zipCode ?? "")) ?? (await geocodeCity(city ?? "", state));
}

// The website's utils/geocode.ts geocodeToLatLng, server-side: Nominatim on
// the full street address, so a care location saved through Evia carries the
// same lat/lng a location saved on the Care Plan page would (2026-09-17).
export async function geocodeStreetAddress(
  street?: string, city?: string, state?: string, zipCode?: string,
): Promise<{ lat: number; lng: number } | null> {
  const query = [street, city, state, zipCode].filter(Boolean).join(", ");
  if (!query) return null;
  try {
    const resp = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { q: query, format: "json", limit: 1, countrycodes: "us" },
      headers: { "Accept-Language": "en", "User-Agent": "Evia/1.0 (eviacares.com)" },
      timeout: 6000,
    });
    const data = resp.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}
