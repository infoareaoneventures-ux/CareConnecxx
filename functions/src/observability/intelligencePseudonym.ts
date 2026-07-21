// INTELLIGENCE_TELEMETRY_KEY — dedicated, purpose-separated HMAC key for
// intelligence telemetry pseudonyms (plan 2026-07-18-001 U0, KTD24 / R52).
//
// Intelligence telemetry (objective metrics, checkpoint health, proactive
// decisions, eval candidates, scorecards) must never store raw user/actor
// identifiers, and must never reuse MEMORY_FINGERPRINT_KEY — key compromise
// or rotation in one domain must not ripple into the other. Modeled on
// functions/src/memory/fingerprintKey.ts.
//
// Fail-closed contract: when the key is unbound, callers get null (or a
// throw) and MUST drop the telemetry record. There is no unhashed fallback —
// emitting a raw identifier because the key was missing is the exact failure
// this module exists to prevent.
//
// Every deployed function that computes these pseudonyms must bind the secret
// via runWith({ secrets: [INTELLIGENCE_TELEMETRY_KEY_SECRET] }) and appear in
// the binding manifest test (intelligenceTelemetrySecretBindings.test.ts).
//
// Rotation: bump CURRENT_INTELLIGENCE_TELEMETRY_KEY_VERSION with the new
// secret value; records carry their keyVersion, aggregation jobs may bridge a
// bounded overlap window, then the prior version is retired.

import { createHmac } from "crypto";

export const INTELLIGENCE_TELEMETRY_KEY_NAME = "INTELLIGENCE_TELEMETRY_KEY";

/** Stamped as `keyVersion` beside every pseudonym this code writes. */
export const CURRENT_INTELLIGENCE_TELEMETRY_KEY_VERSION = 1;

// Purposes are part of the HMAC input, so the same subject yields UNLINKABLE
// pseudonyms across purposes — a joined identity graph across telemetry
// domains cannot be reconstructed from stored records.
export type TelemetryPurpose =
  | "objective"
  | "checkpoint"
  | "proactive"
  | "eval_candidate"
  | "scorecard";

export let INTELLIGENCE_TELEMETRY_KEY_SECRET: { name: string } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { defineSecret } = require("firebase-functions/params") as typeof import("firebase-functions/params");
  INTELLIGENCE_TELEMETRY_KEY_SECRET = defineSecret(INTELLIGENCE_TELEMETRY_KEY_NAME);
} catch {
  INTELLIGENCE_TELEMETRY_KEY_SECRET = undefined;
}

let injectedKeyForTests: string | null = null;

/** Test seam only — inject deterministic key material without env mutation. */
export function __setTelemetryKeyForTests(key: string | null): void {
  injectedKeyForTests = key;
}

export interface IntelligencePseudonym {
  pseudonym: string;
  keyVersion: number;
  purpose: TelemetryPurpose;
}

/**
 * HMAC-SHA256 pseudonym for a subject id under a declared purpose. Throws when
 * the key is unbound — callers that can tolerate missing telemetry use
 * tryIntelligencePseudonym and DROP the record on null.
 */
export function intelligencePseudonym(purpose: TelemetryPurpose, subjectId: string): IntelligencePseudonym {
  const key = injectedKeyForTests ?? process.env[INTELLIGENCE_TELEMETRY_KEY_NAME] ?? "";
  if (!key) {
    throw new Error(
      `${INTELLIGENCE_TELEMETRY_KEY_NAME} is not bound. Provision it in Firebase Secret Manager ` +
      `(firebase functions:secrets:set ${INTELLIGENCE_TELEMETRY_KEY_NAME}) and bind it with ` +
      `runWith({ secrets: ["${INTELLIGENCE_TELEMETRY_KEY_NAME}"] }) on every consuming function. ` +
      `Never fall back to an unhashed identifier.`,
    );
  }
  return {
    pseudonym: createHmac("sha256", key).update(`${purpose}:${subjectId}`).digest("hex"),
    keyVersion: CURRENT_INTELLIGENCE_TELEMETRY_KEY_VERSION,
    purpose,
  };
}

/** Null when the key is unbound — the caller must drop the telemetry record. */
export function tryIntelligencePseudonym(
  purpose: TelemetryPurpose,
  subjectId: string,
): IntelligencePseudonym | null {
  try {
    return intelligencePseudonym(purpose, subjectId);
  } catch {
    return null;
  }
}
