// Render-safe location label. Server writers and one-off repair scripts have
// historically stored `location` as an OBJECT ({ city, zipCode, lat, lng } or
// bare { lat, lng }) on job posts, job applications, and caregiver docs.
// Rendering that object in JSX throws React #31 and takes down the whole page
// (seen live 2026-07-15: /caregiver/jobs crashed on an application whose
// jobLocation was { lng, city, lat }). Every UI read of a location-ish field
// must go through this coercion — never render `.location` / `.jobLocation`
// raw.
export function locationLabel(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return [o.city, o.state, o.zipCode]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .join(', ');
  }
  return '';
}
