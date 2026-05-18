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
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'CareConnex/1.0' } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}
