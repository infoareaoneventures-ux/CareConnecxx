// A notification body without raw web addresses (2026-11-11, fix plan Wave 3: bells showed full links such as
// "Join from your Interviews tab: https://meet.google.com/…"). The link is still on the notification's own button /
// destination; the sentence just reads normally.
export function plainNotificationBody(body: unknown): string {
  if (typeof body !== 'string') return '';
  return body
    .replace(/\s*(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/:\s*$/, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
