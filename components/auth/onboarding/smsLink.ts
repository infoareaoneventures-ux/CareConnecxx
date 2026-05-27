export const SMS_BODY = 'Hey Cara';

export function buildSmsHref(linqPhone: string): string {
  const body = encodeURIComponent(SMS_BODY);
  // The "?&" form is the iOS-compatible body separator that modern Android Chrome
  // also accepts. iOS opens the Messages "Open this page in Messages?" sheet from
  // a tap on this href; QR scanners on both iOS Camera and Android Lens treat it
  // as a deep-link.
  return `sms:${linqPhone}?&body=${body}`;
}

export function formatPhoneForDisplay(e164: string): string {
  if (/^\+1\d{10}$/.test(e164)) {
    return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  return e164;
}
