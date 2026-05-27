import * as crypto from "crypto";

// Phone verification (OTP) — proves the inbound sender actually controls the
// number it appears to come from. Without this, an SMS gateway can spoof the
// FROM header and create sessions under any +1 number. The OTP loop closes
// that gap: the code we send is delivered to the real number owner via the
// carrier, so a spoofer never sees it and can't reply with it.

const OTP_TTL_MS  = 15 * 60 * 1000; // 15 min
const MAX_ATTEMPTS = 5;

export interface OtpState {
  code:        string;   // 6 digits
  expiresAt:   string;   // ISO
  attempts:    number;
  issuedAt:    string;   // ISO
}

export function generateOtp(): OtpState {
  // 6-digit zero-padded random code. crypto.randomInt is constant-time-ish and
  // pulls from the OS entropy pool, which is what we want for a one-shot token.
  const n = crypto.randomInt(0, 1_000_000);
  const code = String(n).padStart(6, "0");
  const now = Date.now();
  return {
    code,
    expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
    attempts:  0,
    issuedAt:  new Date(now).toISOString(),
  };
}

export type VerifyResult =
  | { status: "ok" }
  | { status: "expired" }
  | { status: "wrong"; attemptsLeft: number }
  | { status: "locked" }
  | { status: "no_state" };

export function verifyOtp(input: string, state: OtpState | undefined): VerifyResult {
  if (!state || !state.code) return { status: "no_state" };
  if (new Date(state.expiresAt) < new Date()) return { status: "expired" };
  if ((state.attempts ?? 0) >= MAX_ATTEMPTS) return { status: "locked" };

  const cleaned = input.replace(/[^0-9]/g, "").slice(0, 6);
  if (cleaned.length !== 6) {
    return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - (state.attempts ?? 0) - 1 };
  }
  // Constant-time compare — both buffers must be 6 bytes.
  const a = Buffer.from(cleaned);
  const b = Buffer.from(state.code);
  if (a.length !== b.length) {
    return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - (state.attempts ?? 0) - 1 };
  }
  if (crypto.timingSafeEqual(a, b)) return { status: "ok" };
  return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - (state.attempts ?? 0) - 1 };
}

export function formatOtpForDisplay(code: string): string {
  // "845290" → "845-290" — easier to read on a small screen.
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
