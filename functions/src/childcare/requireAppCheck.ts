// ── App Check gate for childcare callables (plan 2026-07-22-002, KTD22/R21) ──
//
// App Check is GREENFIELD in this repo: no senior callable verifies
// context.app, and the client SDK only activates a provider when
// VITE_APPCHECK_SITE_KEY is present (lib/firebase.ts). Enforcement therefore
// scopes to the NEW childcare callables only — senior clients without tokens
// are untouched.
//
// Enforcement mode is env-driven (CHILDCARE_APPCHECK_MODE):
//   • "monitor" (default) — a missing/invalid App Check token is LOGGED but
//     the call proceeds. This is the shipping mode until the founder registers
//     the reCAPTCHA provider in the Firebase console and the client site key
//     is live in production; flipping to enforce before that would brick every
//     childcare callable.
//   • "enforce" — a missing token fails closed (failed-precondition).
//   • "off"     — no check (emergency escape hatch only).
//
// TODO(founder): register the App Check reCAPTCHA v3 provider for the web app
// in the Firebase console, set VITE_APPCHECK_SITE_KEY in the frontend .env,
// deploy, verify token issuance in monitor-mode logs, THEN set
// CHILDCARE_APPCHECK_MODE=enforce. Debug-token strategy for e2e runs is a
// founder-run deployment prerequisite (plan KTD22).
//
// v1 callable semantics: the Functions runtime verifies an App Check token
// when the client sends one and populates `context.app`; absent/invalid tokens
// leave context.app undefined. This helper only inspects that server-verified
// field — never a client-supplied header.

import * as functions from "firebase-functions/v1";

export type AppCheckEnforcementMode = "off" | "monitor" | "enforce";

export const CHILDCARE_APPCHECK_MODE_ENV = "CHILDCARE_APPCHECK_MODE";

/** Resolve the enforcement mode from env. Unknown values → monitor (with a warn). */
export function childcareAppCheckMode(): AppCheckEnforcementMode {
  const raw = String(process.env[CHILDCARE_APPCHECK_MODE_ENV] ?? "monitor").trim().toLowerCase();
  if (raw === "off" || raw === "monitor" || raw === "enforce") return raw;
  console.warn(
    `[requireAppCheck] unknown ${CHILDCARE_APPCHECK_MODE_ENV}="${raw}" — falling back to monitor`,
  );
  return "monitor";
}

/**
 * Gate a v1 callable on App Check (childcare callables only). Returns the
 * effective outcome so callers/tests can assert monitor-mode behavior.
 *
 * `callableName` is used only for the monitor-mode log line — no payload data
 * is ever logged.
 */
export function requireAppCheck(
  context: functions.https.CallableContext,
  callableName: string,
  opts: { mode?: AppCheckEnforcementMode; rejectConsumed?: boolean } = {},
): { verified: boolean; mode: AppCheckEnforcementMode; consumed: boolean } {
  const mode = opts.mode ?? childcareAppCheckMode();
  const consumed = context.app?.alreadyConsumed === true;
  if (mode === "off") return { verified: Boolean(context.app), mode, consumed };

  if (context.app) {
    if (opts.rejectConsumed && consumed) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "App verification token has already been used. Please retry the action.",
        { code: "app_check_replay" },
      );
    }
    return { verified: true, mode, consumed };
  }

  if (mode === "monitor") {
    console.warn(
      `[requireAppCheck] ${callableName}: missing App Check token (monitor mode — allowed)`,
      { uidPresent: Boolean(context.auth) },
    );
    return { verified: false, mode, consumed: false };
  }

  // enforce — fail closed with a generic, enumeration-safe message.
  throw new functions.https.HttpsError(
    "failed-precondition",
    "App verification failed. Please update the app and try again.",
  );
}
