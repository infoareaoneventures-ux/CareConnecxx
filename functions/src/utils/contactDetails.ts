// Contact details never go into public profile text or a job description.
//
// Wave 1 (2026-11-09): a job description is readable by every signed-in account and a care provider's
// bio is public, so a phone number, email or link typed there lets two people leave Evia — and with it
// the background check, the messaging record, the payment protection and the safety checks — before a
// single visit. Every save of those fields, on the site and over text, refuses it with the same one line.
// A stated fact ("she lives near the library", "I speak Spanish and English") passes: it carries no way
// to reach anyone.
//
// Deterministic on purpose (a safety gate, like medicationInstruction.ts and the crisis fast-path): fast,
// free, and a false block only costs the person a rephrase. Kept byte-identical on both sides by a parity
// test (functions/src/utils/__tests__/contactDetails.test.ts) — change both files together.

export const CONTACT_DETAILS_MESSAGE = "Phone numbers, emails and links can't go in here. Evia keeps everyone connected, so there's no need for them.";

// A US phone number: 10 digits with any mix of spaces, dots, dashes, brackets and an optional +1.
const PHONE_10 = /(?:\+?1[\s.\-]*)?(?:\(\s*\d{3}\s*\)|\b\d{3})[\s.\-]*\d{3}[\s.\-]*\d{4}\b/;
// A local 7-digit number written with a separator ("555-1234"); not part of a longer digit run or a $ range.
const PHONE_7 = /(?:^|[^\d$])\d{3}[\s.\-]\d{4}(?!\d)/; // no lookbehind: older Safari fails to parse it
// Digits spelled out: seven or more in a row ("four zero eight five five five one two one two").
const SPELLED_DIGITS = /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b[\s,.\-]*){7,}/i;
// An email, also written the way people dodge filters: "name at gmail dot com", "name (at) gmail (dot) com".
const EMAIL = /[A-Z0-9._%+\-]+\s*@\s*[A-Z0-9\-]+(?:\s*\.\s*[A-Z0-9\-]+)+/i;
const EMAIL_SPELLED = /[A-Z0-9._%+\-]+\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\bat\b)\s*[A-Z0-9\-]+\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\bdot\b|\.)\s*(?:com|net|org|edu|gov|io|co|us|info|biz|me)\b/i;
// A link: a scheme, www, or a bare domain on a common ending.
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[A-Z0-9\-]+\.(?:com|net|org|io|co|us|info|biz|me|app|ly|gl)\b/i;
// A social handle: @name.
const HANDLE = /(?:^|[\s(])@[A-Z0-9_.]{3,}/i;
// Apps people use to move the conversation or the money off Evia.
const OFF_PLATFORM = /\b(?:whatsapp|whats\s*app|telegram|snapchat|venmo|zelle|cash\s*app|cashapp|paypal)\b/i;

/** True when the text contains a phone number, an email, a link, a handle, or names an off-Evia contact or payment app. */
export function containsContactDetails(text: unknown): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  return (
    PHONE_10.test(text) ||
    PHONE_7.test(text) ||
    SPELLED_DIGITS.test(text) ||
    EMAIL.test(text) ||
    EMAIL_SPELLED.test(text) ||
    LINK.test(text) ||
    HANDLE.test(text) ||
    OFF_PLATFORM.test(text)
  );
}
