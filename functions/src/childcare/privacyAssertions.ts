// ── Childcare privacy assertions (plan 2026-07-22-002, U13 / R57) ────────────
//
// THE canonical, reusable privacy-assertion library. Consolidates the ad-hoc
// `assertChildSafeOutboundPayload` (U6 matchingEligibility) and template-scan
// patterns (U9 notificationPolicy) into ONE set of assertions plus a recursive
// scanner. Every telemetry/outbound surface delegates here so the R57 rule —
// "logs, analytics, alerts, traces, error payloads, provider metadata, exports,
// prompts, eval fixtures, and outbound templates prohibit raw child PII" — has a
// single implementation that cannot drift per call site.
//
// TWO kinds of check:
//   1. KEY scan (assertNoChildPii): rejects an OBJECT that carries a
//      child-sensitive KEY at any depth (exact DOB/address/custody/pickup/
//      health/emergency-contact/identity-image/screening-narrative fields).
//   2. STRING scan (assertNoChildPiiInString): rejects a STRING that embeds a
//      child-sensitive VALUE shape (exact DOB, SSN) — for prompt/template text
//      where the danger is an interpolated value, not a field name.
//
// SAFE fields (never rejected): opaque IDs (bookingId, householdId, childId as
// an opaque doc id — never a name), age BANDS, approximate area labels,
// jurisdiction state, counts, timestamps, statuses, severities, and generic
// display strings. These are the only shapes childcare telemetry may carry.
//
// This module is PURE (no firebase-admin, no Firestore) so it is import-safe
// from the CLI eval runner, browser-adjacent code, and every server path.

import { redactChildSensitiveForLog } from "../safety/redactPii";

export class ChildPrivacyAssertionError extends Error {
  readonly context: string;
  readonly offendingKey?: string;
  constructor(message: string, context: string, offendingKey?: string) {
    super(message);
    this.name = "ChildPrivacyAssertionError";
    this.context = context;
    this.offendingKey = offendingKey;
  }
}

/**
 * Canonical child-sensitive KEY names — lowercased, exact-key match, recursive.
 * This is the single source of truth the U6 outbound-payload guard now delegates
 * to (matchingEligibility.assertChildSafeOutboundPayload). Kept BYTE-COMPATIBLE
 * with the former U6 set so the delegation is a no-behavior-change refactor;
 * additions here tighten every delegating call site at once.
 */
export const PROHIBITED_CHILD_FIELD_KEYS: ReadonlySet<string> = new Set([
  // names / identity
  "childname", "childnames", "firstname", "lastname", "fullname", "displaylabel",
  "dateofbirth", "dob", "birthdate", "ssn",
  // exact location
  "address", "streetaddress", "street", "addressline1", "addressline2",
  "exactaddress", "homeaddress", "apartment", "unit",
  // custody / pickup / emergency
  "custody", "custodynotes", "custodyevidence", "pickup", "pickupnotes",
  "authorizedpickup", "emergencycontact", "emergencycontacts",
  // health
  "allergies", "allergy", "medications", "medication", "diagnosis",
  "healthnotes", "medicalnotes", "healthdetails", "safetynotes",
  // child contact / school
  "school", "schoolname", "childphone", "phone", "phonenumber", "email",
  // U13 additions — identity image refs + screening narrative (R57) that the
  // U6 outbound set never named but telemetry/metadata must also reject.
  "identitydocument", "identityimage", "identityimageurl", "idimage", "selfie",
  "screeningnarrative", "screeningnotes", "backgroundnarrative", "adjudication",
  "adjudicationnotes", "incidentnarrative", "incidentdetail",
]);

/**
 * The ONLY key shapes childcare metric/telemetry payloads may carry. Used by the
 * metric-contract test (every metric shape must be a subset of this) and by the
 * strict-mode assertion. Deliberately excludes `displayLabel`/names — telemetry
 * never carries a child's display label, even though an authenticated VIEW may.
 */
export const SAFE_TELEMETRY_FIELD_KEYS: ReadonlySet<string> = new Set([
  // metric envelope
  "metric", "signal", "severity", "count", "value", "threshold", "window",
  "windowstart", "windowend", "amber", "red", "owner", "held", "reasons",
  "reason", "detail", "status", "type", "createdat", "updatedat", "resolvedat",
  // opaque correlation IDs (never names)
  "bookingid", "householdid", "childid", "jobid", "applicationid", "caregiverid",
  "providerid", "shiftid", "incidentid", "requestid", "eventid", "sourcepath",
  "paymentgeneration", "chargeid", "transferid", "refundid", "policyversion",
  // safe abstractions
  "ageband", "agebands", "arealabel", "approxlat", "approxlng",
  "jurisdictionstate", "carevertical", "disclosurephase",
]);

interface AssertOpts {
  /** Override the prohibited key set (defaults to the canonical set). */
  prohibitedKeys?: ReadonlySet<string>;
  /** When set, ALSO reject any key not present in this allowlist (strict). */
  allowlistKeys?: ReadonlySet<string>;
}

/**
 * Recursively reject any object/array that carries a child-sensitive KEY. Throws
 * ChildPrivacyAssertionError. The thrown message always contains the literal
 * substring "prohibited key" (the U6 contract every delegating test pins).
 * Primitives and null pass (a string VALUE is checked by
 * assertNoChildPiiInString, not here).
 */
export function assertNoChildPii(payload: unknown, context: string, opts: AssertOpts = {}): void {
  const prohibited = opts.prohibitedKeys ?? PROHIBITED_CHILD_FIELD_KEYS;
  const allowlist = opts.allowlistKeys;
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (prohibited.has(lower)) {
        throw new ChildPrivacyAssertionError(
          `[childcare] ${context} carries prohibited key "${key}" — child PII is banned from this surface (R57).`,
          context,
          key,
        );
      }
      if (allowlist && !allowlist.has(lower)) {
        throw new ChildPrivacyAssertionError(
          `[childcare] ${context} carries non-allowlisted key "${key}" — telemetry may only use safe fields (R57).`,
          context,
          key,
        );
      }
      visit(value);
    }
  };
  visit(payload);
}

// Value-shape detectors for STRING scanning. Exact DOB and SSN are the value
// leaks that survive a key scan (e.g. a generic `note: "born 03/04/2016"`).
const DOB_ANY = /\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](19|20)\d\d\b|\b(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const SSN_ANY = /\b\d{3}-\d{2}-\d{4}\b/;
// Explicit street-address shape: number + street word (kept narrow to avoid
// matching "Suite 200" style tokens). Log/template only.
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl|terrace|circle|cir)\b/i;

/**
 * Reject a STRING that embeds a child-sensitive value shape (exact DOB, SSN, or
 * an explicit street address). For prompt strings and outbound template text.
 */
export function assertNoChildPiiInString(text: unknown, context: string): void {
  if (typeof text !== "string" || text.length === 0) return;
  if (DOB_ANY.test(text)) {
    throw new ChildPrivacyAssertionError(
      `[childcare] ${context} embeds an exact date of birth — prohibited in this surface (R57).`,
      context,
    );
  }
  if (SSN_ANY.test(text)) {
    throw new ChildPrivacyAssertionError(
      `[childcare] ${context} embeds an SSN — prohibited in this surface (R57).`,
      context,
    );
  }
  if (STREET_ADDRESS.test(text)) {
    throw new ChildPrivacyAssertionError(
      `[childcare] ${context} embeds an exact street address — prohibited in this surface (R57).`,
      context,
    );
  }
}

// ── Surface-specific wrappers ────────────────────────────────────────────────
// One named entry point per R57 surface so call sites read intent and future
// per-surface policy has a home.

/** Log / error / trace payloads. */
export function assertLogPayloadChildSafe(payload: unknown, site: string): void {
  assertNoChildPii(payload, `log:${site}`);
}

/**
 * Metric / analytics payloads. Rejects prohibited child keys at every depth AND
 * requires the top-level ENVELOPE keys to be drawn from SAFE_TELEMETRY_FIELD_KEYS
 * (dynamic `detail` sub-maps may key by safe status/tool names, so the allowlist
 * is enforced only on the envelope, not recursively).
 */
export function assertMetricPayloadChildSafe(payload: unknown, site: string): void {
  assertNoChildPii(payload, `metric:${site}`);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of Object.keys(payload as Record<string, unknown>)) {
      if (!SAFE_TELEMETRY_FIELD_KEYS.has(key.toLowerCase())) {
        throw new ChildPrivacyAssertionError(
          `[childcare] metric:${site} envelope carries non-allowlisted key "${key}" — metric fields must be safe telemetry shapes (R57).`,
          `metric:${site}`,
          key,
        );
      }
    }
  }
}

/** Provider metadata (Stripe/Checkr/third-party) — opaque refs only. */
export function assertProviderMetadataChildSafe(payload: unknown, site: string): void {
  assertNoChildPii(payload, `provider-metadata:${site}`);
}

/** Prompt strings interpolated into a model context. */
export function assertPromptChildSafe(value: unknown, site: string): void {
  assertNoChildPii(value, `prompt:${site}`);
  assertNoChildPiiInString(value, `prompt:${site}`);
}

/** Eval / training fixtures destined for telemetry (NOT raw synthetic input text). */
export function assertEvalFixtureChildSafe(payload: unknown, site: string): void {
  assertNoChildPii(payload, `eval-fixture:${site}`);
}

/** Outbound notification / push / email / SMS / calendar template strings + inputs. */
export function assertOutboundTemplateChildSafe(payload: unknown, site: string): void {
  assertNoChildPii(payload, `template:${site}`);
  const scanStrings = (node: unknown): void => {
    if (typeof node === "string") { assertNoChildPiiInString(node, `template:${site}`); return; }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) scanStrings(v);
    }
  };
  scanStrings(payload);
}

// ── Redaction helper (defense-in-depth for log sinks) ────────────────────────

export interface ChildLogRedaction {
  value: Record<string, unknown> | unknown[];
  redactedKeys: string[];
  /** True if the string redactor failed internally on any node (canary signal). */
  redactorFailed: boolean;
}

/**
 * Return a scrubbed COPY of a payload safe to log: prohibited keys are dropped
 * (replaced with "[redacted]"), and every string value is passed through the
 * child-sensitive string redactor. NEVER throws — the log path must not crash.
 * Prefer asserting at the source; use this only where a payload of unknown
 * provenance must be logged anyway.
 */
export function redactChildFieldsForLog(payload: unknown): ChildLogRedaction {
  const redactedKeys: string[] = [];
  let redactorFailed = false;
  const scrub = (node: unknown): unknown => {
    if (typeof node === "string") {
      const r = redactChildSensitiveForLog(node);
      if (r.failed) redactorFailed = true;
      return r.text;
    }
    if (Array.isArray(node)) return node.map(scrub);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (PROHIBITED_CHILD_FIELD_KEYS.has(k.toLowerCase())) {
          redactedKeys.push(k);
          out[k] = "[redacted]";
        } else {
          out[k] = scrub(v);
        }
      }
      return out;
    }
    return node;
  };
  const value = scrub(payload);
  return {
    value: (value && typeof value === "object" ? value : { value }) as Record<string, unknown> | unknown[],
    redactedKeys,
    redactorFailed,
  };
}

// ── Synthetic-identifier assertion for canary state (R63 / U13) ──────────────
//
// The canary's own persisted state must never embed a real child/household id —
// synthetic identifiers only. A synthetic id is one carrying an explicit
// synthetic marker; anything else is rejected so a real id can never leak into
// canary fixtures or hold-signal reasons.
const SYNTHETIC_MARKERS = ["synthetic", "canary", "test", "fixture", "seed", "codex-"];

export function isSyntheticIdentifier(id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const lower = id.toLowerCase();
  return SYNTHETIC_MARKERS.some((m) => lower.includes(m));
}

export function assertSyntheticIdentifier(id: unknown, context: string): void {
  if (!isSyntheticIdentifier(id)) {
    throw new ChildPrivacyAssertionError(
      `[childcare] ${context}: canary state must use SYNTHETIC identifiers only — "${String(id)}" is not marked synthetic (R63).`,
      context,
    );
  }
}
