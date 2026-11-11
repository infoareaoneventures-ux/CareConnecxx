// A quick format check before an email is sent anywhere (2026-11-11, fix plan Wave 3: an invalid address went all the
// way to the server and came back as a generic "Failed to send the link"). Format only; the server still decides
// whether the address can receive mail.
export const EMAIL_FORMAT_MESSAGE = 'Enter a valid email address, like name@example.com.';

export function looksLikeEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}
