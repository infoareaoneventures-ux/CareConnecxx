// Service area — Evia serves Santa Clara County, CA only. Mirror of
// functions/src/config/serviceArea.ts (a functions test compares the two sets
// byte for byte); widen the area in BOTH files together.

export const SANTA_CLARA_COUNTY_CITIES: ReadonlySet<string> = new Set([
  'san jose', 'san josé', 'sj',
  'sunnyvale',
  'santa clara',
  'mountain view',
  'milpitas',
  'palo alto',
  'cupertino',
  'gilroy',
  'morgan hill',
  'campbell',
  'los altos',
  'los altos hills',
  'los gatos',
  'saratoga',
  'monte sereno',
  'alviso', 'stanford', 'alum rock', 'cambrian park', 'cambrian',
  'east foothills', 'burbank', 'fruitdale', 'loyola', 'san martin',
  'new almaden', 'coyote', 'mount hamilton', 'mt hamilton', 'redwood estates',
]);

export const SANTA_CLARA_COUNTY_ZIPS: ReadonlySet<string> = new Set([
  '94301', '94303', '94304', '94305', '94306',
  '94022', '94024',
  '94035', '94040', '94041', '94043',
  '94085', '94086', '94087', '94089',
  '95050', '95051', '95053', '95054',
  '95014',
  '95008',
  '95030', '95032', '95033',
  '95070',
  '95035',
  '95037',
  '95020',
  '95046',
  '95002', '95110', '95111', '95112', '95113', '95116', '95117', '95118',
  '95119', '95120', '95121', '95122', '95123', '95124', '95125', '95126',
  '95127', '95128', '95129', '95130', '95131', '95132', '95133', '95134',
  '95135', '95136', '95138', '95139', '95140', '95141', '95148',
  '95013', '95042', '95044',
]);

export function normalizeCity(city: string | undefined | null): string {
  return (city ?? '').toLowerCase().replace(/[.,].*$/, '').replace(/\s+/g, ' ').trim();
}

export function extractZip(text: string | undefined | null): string {
  const m = (text ?? '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}

/** ZIP is authoritative when present; a known in-area city passes; anything else needs a ZIP. */
export function evaluateServiceArea(args: { city?: string | null; zip?: string | null }): 'in' | 'out' | 'need_zip' {
  const zip = extractZip(args.zip ?? '') || extractZip(args.city ?? '');
  if (zip) return SANTA_CLARA_COUNTY_ZIPS.has(zip) ? 'in' : 'out';
  const city = normalizeCity(args.city);
  if (city && SANTA_CLARA_COUNTY_CITIES.has(city)) return 'in';
  return 'need_zip';
}

export const OUT_OF_AREA_MESSAGE =
  "We currently serve Santa Clara County only, so we can't set up care at this address yet. We'll reach out as soon as we expand to your area.";
