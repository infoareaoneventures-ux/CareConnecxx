// Service area gate — Evia currently serves Santa Clara County, CA ONLY.
// Used to decline + waitlist client and caregiver signups outside the county
// during onboarding (city/zip collection). Keep this as the single source of
// truth; widen the area by adding cities/zips here, no other code change needed.
//
// Coverage: the 15 incorporated SCC cities + common unincorporated communities,
// and their residential ZIP codes. PO-box-only and special-use ZIPs are omitted.
// Note a few edge ZIPs (e.g. 95033) straddle the Santa Cruz county line; they are
// included because part of the ZIP is in SCC.

// Normalized (lowercase, trimmed) city names that are in-area, incl. common aliases.
export const SANTA_CLARA_COUNTY_CITIES: ReadonlySet<string> = new Set([
  "san jose", "san josé", "sj",
  "sunnyvale",
  "santa clara",
  "mountain view",
  "milpitas",
  "palo alto",
  "cupertino",
  "gilroy",
  "morgan hill",
  "campbell",
  "los altos",
  "los altos hills",
  "los gatos",
  "saratoga",
  "monte sereno",
  // unincorporated / communities commonly typed by residents
  "alviso", "stanford", "alum rock", "cambrian park", "cambrian",
  "east foothills", "burbank", "fruitdale", "loyola", "san martin",
  "new almaden", "coyote", "mount hamilton", "mt hamilton", "redwood estates",
]);

// Residential ZIP codes in Santa Clara County.
export const SANTA_CLARA_COUNTY_ZIPS: ReadonlySet<string> = new Set([
  // Palo Alto / Stanford
  "94301", "94303", "94304", "94305", "94306",
  // Los Altos / Los Altos Hills
  "94022", "94024",
  // Mountain View
  "94035", "94040", "94041", "94043",
  // Sunnyvale
  "94085", "94086", "94087", "94089",
  // Santa Clara
  "95050", "95051", "95053", "95054",
  // Cupertino
  "95014",
  // Campbell
  "95008",
  // Los Gatos / Monte Sereno
  "95030", "95032", "95033",
  // Saratoga
  "95070",
  // Milpitas
  "95035",
  // Morgan Hill
  "95037",
  // Gilroy
  "95020",
  // San Martin
  "95046",
  // San Jose (residential)
  "95002", "95110", "95111", "95112", "95113", "95116", "95117", "95118",
  "95119", "95120", "95121", "95122", "95123", "95124", "95125", "95126",
  "95127", "95128", "95129", "95130", "95131", "95132", "95133", "95134",
  "95135", "95136", "95138", "95139", "95140", "95141", "95148",
  // unincorporated communities
  "95013", "95042", "95044",
]);

/** Normalize a free-text city for set lookup. */
export function normalizeCity(city: string | undefined | null): string {
  return (city ?? "")
    .toLowerCase()
    .replace(/[.,].*$/, "")        // drop ", CA 95110" style trailing detail
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract a 5-digit ZIP from free text (first match), or "" if none. */
export function extractZip(text: string | undefined | null): string {
  const m = (text ?? "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

/**
 * Is this location in Evia's service area (Santa Clara County)?
 * ZIP is authoritative when present; otherwise fall back to city name.
 * Returns true only on a positive match — unknown/blank is out of area.
 */
export function isInServiceArea(args: { city?: string | null; zip?: string | null }): boolean {
  const zip = extractZip(args.zip ?? "") || extractZip(args.city ?? "");
  if (zip) return SANTA_CLARA_COUNTY_ZIPS.has(zip);
  const city = normalizeCity(args.city);
  if (city) return SANTA_CLARA_COUNTY_CITIES.has(city);
  return false;
}

/**
 * Decide service-area status with a third "unknown" state, so callers can choose
 * to ask for clarification instead of declining when neither city nor zip is
 * recognizable (e.g. a typo) rather than clearly out of area.
 */
export function serviceAreaStatus(args: { city?: string | null; zip?: string | null }):
  "in_area" | "out_of_area" | "unknown" {
  const zip = extractZip(args.zip ?? "") || extractZip(args.city ?? "");
  if (zip) return SANTA_CLARA_COUNTY_ZIPS.has(zip) ? "in_area" : "out_of_area";
  const city = normalizeCity(args.city);
  if (!city) return "unknown";
  return SANTA_CLARA_COUNTY_CITIES.has(city) ? "in_area" : "out_of_area";
}

/**
 * Onboarding-gate verdict. Unlike serviceAreaStatus, an UNRECOGNIZED city with no
 * ZIP returns "need_zip" (not "out") so a typo or a city we just don't have in the
 * set asks for the authoritative ZIP instead of wrongly waitlisting someone.
 *   - ZIP present  → "in" / "out" (authoritative)
 *   - no ZIP, known in-area city → "in"
 *   - no ZIP, blank or unrecognized city → "need_zip"
 */
export function evaluateServiceArea(args: { city?: string | null; zip?: string | null }):
  "in" | "out" | "need_zip" {
  const zip = extractZip(args.zip ?? "") || extractZip(args.city ?? "");
  if (zip) return SANTA_CLARA_COUNTY_ZIPS.has(zip) ? "in" : "out";
  const city = normalizeCity(args.city);
  if (city && SANTA_CLARA_COUNTY_CITIES.has(city)) return "in";
  return "need_zip";
}
