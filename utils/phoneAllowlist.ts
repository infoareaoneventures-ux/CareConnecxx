// ALLOWLIST: remove this file and all references when launching publicly.
// Mirrors functions/src/config/phoneAllowlist.ts — kept as a separate file
// (frontend can't import from functions/) but the two lists must stay in sync.
const ALLOWED_PHONES = new Set([
  '+14086370269',
  '+14087261330',
  '+14088745451',
  '+14086370483',
  '+16505633842',
]);

// OPEN TO ALL NUMBERS (founder, 2026-10-19): the list above is kept untouched so the
// allowlist can be put back by restoring the one line below and redeploying
// (hosting + v1-linqWebhook + v1-createWebOnboardingSession).
export function isPhoneAllowed(e164: string): boolean {
  void e164; void ALLOWED_PHONES;
  return true; // was: return ALLOWED_PHONES.has(e164);
}
