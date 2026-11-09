// Linq webhook signature verification — pure (crypto only), so it can be unit-tested on its own.
//
// Signature = HMAC-SHA256 over `{timestamp}.{rawBody}` (per Linq docs).
//
// 2026-11-09 (Wave 1, "text delivery receipts are thrown away"): live logs showed message.sent /
// message.delivered events rejected as "invalid signature" while message.received passed. We could
// not see Linq's dashboard from the code, so two things that commonly cause exactly that are now
// handled — neither weakens the check, because every accepted signature still has to be an HMAC made
// with a secret we hold:
//   1. More than one signing secret. A webhook subscription gets its OWN secret in Linq, so delivery
//      receipts subscribed separately sign with a different one. LINQ_WEBHOOK_SECRET stays the primary;
//      LINQ_WEBHOOK_SECRET_2 and LINQ_WEBHOOK_SECRETS (comma-separated) add more.
//   2. A scheme prefix on the header ("sha256=<sig>", "v1=<sig>", several comma-separated).
import * as crypto from "crypto";

/** Every signing secret we accept, primary first. Empty when none is configured (the caller fails closed). */
export function webhookSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => { const t = v?.trim(); if (t && !out.includes(t)) out.push(t); };
  add(env.LINQ_WEBHOOK_SECRET);
  add(env.LINQ_WEBHOOK_SECRET_2);
  for (const v of (env.LINQ_WEBHOOK_SECRETS ?? "").split(",")) add(v);
  return out;
}

/** "sha256=abc", "v1=abc,v1=def", "abc" → ["abc"], ["abc","def"], ["abc"]. */
export function signatureCandidates(header: string): string[] {
  return header
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/^(?:sha256|v\d+)=/i, ""))
    .filter((part) => part.length > 0);
}

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
};

function matchesOneSecret(rawBody: Buffer, timestamp: string, candidates: string[], secret: string): boolean {
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
  // Linq's docs don't pin down the secret's encoding or the signature's output encoding, so derive the
  // HMAC key both ways and compare against every common digest encoding.
  const keyCandidates: Buffer[] = [
    Buffer.from(secret, "utf8"),   // secret used as a raw string key (Stripe-style; most providers)
    Buffer.from(secret, "base64"), // secret used as base64-encoded key bytes
  ];
  for (const key of keyCandidates) {
    const hmac = crypto.createHmac("sha256", key).update(payload).digest();
    const expected = [hmac.toString("base64"), hmac.toString("base64url"), hmac.toString("hex")];
    for (const sig of candidates) {
      if (expected.some((e) => safeEqual(e, sig))) return true;
    }
  }
  return false;
}

/** True when the signature matches ANY configured secret. */
export function verifySignature(rawBody: Buffer, timestamp: string, signature: string, secrets: string | string[]): boolean {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => s.length > 0);
  const candidates = signatureCandidates(signature);
  if (list.length === 0 || candidates.length === 0) return false;
  return list.some((secret) => matchesOneSecret(rawBody, timestamp, candidates, secret));
}
