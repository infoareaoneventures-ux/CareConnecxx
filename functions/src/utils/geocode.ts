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
