// MEMORY_FINGERPRINT_KEY — server-only HMAC key for correction/forget
// tombstones (memory-grounding hardening plan 2026-07-17-002, U4 / KTD16 /
// R23, Data Changes "learned_facts").
//
// A completed forget strips a fact's plaintext and embedding but keeps a
// server-only HMAC-SHA256 fingerprint of the NORMALIZED fact text so passive
// extraction can never silently recreate it. The key lives in Firebase Secret
// Manager (never Firestore, never source) and is bound only to functions that
// compute/check tombstones. This is the repo's first Secret Manager binding:
// U4a defines the param + accessor; U4b binds it to the memory-operation
// worker (and any other tombstone-touching export) via
// `runWith({ secrets: [MEMORY_FINGERPRINT_KEY_SECRET] })`.
//
// Rotation (Data Changes): a new key version stamps NEW tombstones; existing
// tombstones keep verifying against their recorded `fingerprintKeyVersion`
// (recomputation is impossible without plaintext), and a key version is never
// retired while live tombstones still reference it.

import { createHmac } from "crypto";

export const MEMORY_FINGERPRINT_KEY_NAME = "MEMORY_FINGERPRINT_KEY";

/** Stamped as `fingerprintKeyVersion` beside every fingerprint this code writes. */
export const CURRENT_FINGERPRINT_KEY_VERSION = 1;

// defineSecret registers a functions param at module load. Guarded so test
// environments (or double registration across module graphs) can never crash
// module load — the runtime accessor below reads the injected env var, which
// is how Secret Manager values actually surface inside a bound function.
export let MEMORY_FINGERPRINT_KEY_SECRET: { name: string } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { defineSecret } = require("firebase-functions/params") as typeof import("firebase-functions/params");
  MEMORY_FINGERPRINT_KEY_SECRET = defineSecret(MEMORY_FINGERPRINT_KEY_NAME);
} catch {
  MEMORY_FINGERPRINT_KEY_SECRET = undefined;
}

let injectedKeyForTests: string | null = null;

/** Test seam only — inject deterministic key material without env mutation. */
export function __setFingerprintKeyForTests(key: string | null): void {
  injectedKeyForTests = key;
}

export interface FingerprintKeyMaterial {
  key: string;
  version: number;
}

/**
 * Returns the active key material or throws with a provisioning hint.
 * Bound functions see the secret as process.env.MEMORY_FINGERPRINT_KEY.
 */
export function getFingerprintKey(): FingerprintKeyMaterial {
  const key = injectedKeyForTests ?? process.env[MEMORY_FINGERPRINT_KEY_NAME] ?? "";
  if (!key) {
    throw new Error(
      `${MEMORY_FINGERPRINT_KEY_NAME} is not bound. Provision it in Firebase Secret Manager ` +
      `(firebase functions:secrets:set ${MEMORY_FINGERPRINT_KEY_NAME}) and bind it with ` +
      `runWith({ secrets: ["${MEMORY_FINGERPRINT_KEY_NAME}"] }) on every function that computes ` +
      `or checks memory tombstones.`,
    );
  }
  return { key, version: CURRENT_FINGERPRINT_KEY_VERSION };
}

/** Non-throwing accessor for fail-open call sites (staging before the secret ships). */
export function tryGetFingerprintKey(): FingerprintKeyMaterial | null {
  try {
    return getFingerprintKey();
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 over an ALREADY-NORMALIZED fact string. Callers must normalize
 * through learnedFacts.normalizeFactForFingerprint — the single shared
 * normalization used by BOTH tombstone writes and extraction checks (KTD16),
 * so the two can never drift.
 */
export function hmacFingerprint(normalizedFact: string, keyMaterial: FingerprintKeyMaterial): string {
  return createHmac("sha256", keyMaterial.key).update(normalizedFact).digest("hex");
}
