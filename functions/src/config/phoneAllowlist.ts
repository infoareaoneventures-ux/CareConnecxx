// ALLOWLIST: remove this file and all references when launching publicly
const ALLOWED_PHONES = new Set([
  '+14086370269',
  '+14087261330',
  '+14088745451',
  '+14086370483',
]);

export function isPhoneAllowed(e164: string): boolean {
  return ALLOWED_PHONES.has(e164);
}
