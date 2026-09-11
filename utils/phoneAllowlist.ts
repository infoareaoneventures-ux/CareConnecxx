// ALLOWLIST: remove this file and all references when launching publicly.
// Mirrors functions/src/config/phoneAllowlist.ts — kept as a separate file
// (frontend can't import from functions/) but the two lists must stay in sync.
const ALLOWED_PHONES = new Set([
  '+14086370269',
  '+14087261330',
  '+14088745451',
  '+14086370483',
  '+18302718687',
]);

export function isPhoneAllowed(e164: string): boolean {
  return ALLOWED_PHONES.has(e164);
}
