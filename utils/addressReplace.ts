// Replace one saved care address by another inside a list of stored locations (2026-11-13, fix plan Wave 3: "editing a care
// location adds a second one"). A family's addresses live in four places (the job post's primary address, its saved
// locations, the care plan's location pool and each recipient's care-plan locations) and the location step merges them by
// address. Editing an address only rewrote some of them, so the untouched copy came back as a second location. This is
// the matching rule the save now applies to every place that holds the address.

export interface StoredAddress { street?: string; city?: string; state?: string; zipCode?: string; [k: string]: unknown }

/** The same key the location step uses to tell two addresses apart. */
export function addressKey(street?: string, zip?: string): string {
  return `${(street || '').toLowerCase().trim()}|${zip || ''}`;
}

/** Every entry holding `original` becomes `next` (other fields on the entry are kept; a moved address loses its saved point). */
export function replaceAddressIn<T extends StoredAddress>(
  list: T[] | undefined | null,
  original: { street?: string; zipCode?: string },
  next: { street: string; city: string; state: string; zipCode: string },
): { list: T[]; changed: boolean } {
  if (!Array.isArray(list)) return { list: [], changed: false };
  const want = addressKey(original.street, original.zipCode);
  const moved = want !== addressKey(next.street, next.zipCode);
  let changed = false;
  const out = list.map((entry) => {
    if (addressKey(entry?.street, entry?.zipCode) !== want) return entry;
    changed = true;
    const { lat, lng, latitude, longitude, geoPrecision, ...rest } = entry as StoredAddress;
    const kept = moved ? {} : { lat, lng, latitude, longitude, geoPrecision };
    const withKept = Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined));
    return { ...rest, ...withKept, street: next.street, city: next.city, state: next.state, zipCode: next.zipCode } as T;
  });
  return { list: out, changed };
}
