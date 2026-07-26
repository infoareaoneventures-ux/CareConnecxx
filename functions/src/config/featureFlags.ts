// Env-driven feature flags. Default OFF — a flag is on only when its env var is
// exactly "true".
//
// (Exception: the CHILDCARE flags at the bottom of this file are
// Firestore-resident, NOT env vars — see the childcare section.)

import * as admin from "firebase-admin";

//
// realWorldHealthcareActions ships the propose→confirm→execute healthcare
// browser actions (appointment booking, pharmacy refill, insurance check) DARK
// until the pre-launch gate closes:
//   1. HIPAA/BAA compliance sign-off (GCP BAA in place + consent scope reviewed).
//   2. OQ6 — approver-identity decision: is phone-as-sole-identity acceptable for
//      committing healthcare actions, or is a second factor / CANCEL window /
//      out-of-band execution notice required first?
//   3. Supported launch-portal list confirmed (MyChart + CVS/Walgreens/RiteAid
//      + the generic insurer URL).
//   4. Browserbase per-action cost guardrails (the two-pass premium).
// See docs/runbooks/healthcare-action.md for the full checklist + recovery.

export function realWorldHealthcareActionsEnabled(): boolean {
  return process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS === "true";
}

// Launch billing kill switch. Auto-approval moves money without an explicit
// client action, so it stays fail-closed until the canonical appointment-backed
// timesheet and delivered-notice cutover has been verified in production.
export function timesheetAutoApprovalEnabled(): boolean {
  return process.env.TIMESHEET_AUTO_APPROVAL_ENABLED === "true";
}

// Post-payment care-plan interview (2026-07-15). After a family finishes
// onboarding, Evia interviews them to build the full care plan (task detail per
// recipient, medications, emergency contact) so caregivers know exactly what
// care is needed. Ships DARK until a fresh-number E2E through payment → interview
// → engaged-caregiver follow-up has run in prod. Reversible by clearing the env
// var — no data migration. See docs on the care-plan interview wave.
export function carePlanInterviewEnabled(): boolean {
  return process.env.CARE_PLAN_INTERVIEW_ENABLED === "true";
}

// Multi-recipient household scoping (2026-07-16). Default ON — this is a KILL
// switch, not a launch gate: off ("false") reverts update_care_plan /
// request_booking / create_care_journal_entry to their pre-wave account-level
// writes without a redeploy. Reads are fail-soft and unconditional (absent
// recipientMedical / recipient fields = account-level data is the answer), so
// flipping this off never hides data.
export function multiRecipientScopingEnabled(): boolean {
  return process.env.MULTI_RECIPIENT_SCOPING_ENABLED !== "false";
}

// Model-output guard on generateCaraMessage (hallucination hardening U1,
// 2026-07-17). Default ON — this is a KILL switch, not a launch gate: off
// ("false") reverts generateCaraMessage to delivering raw model output without
// a redeploy if the guard ever false-positives on legitimate copy. The guard
// itself is fail-open (never throws, never blocks on internal error); this
// switch only disables the meta-response/URL rejection → fallback behavior.
export function caraOutputGuardEnabled(): boolean {
  return process.env.CARA_OUTPUT_GUARD_ENABLED !== "false";
}

// Outbound history recording at the transport choke point (hallucination
// hardening U3, 2026-07-17). Default ON — this is a KILL switch, not a launch
// gate: off ("false") stops recordOutboundHistory from writing outbound sends
// into agent_conversations/{phone}/messages without a redeploy (e.g. if the
// expanded collection's redaction/retention posture needs a founder decision
// first). Recording is fire-and-forget and never blocks delivery either way.
export function outboundHistoryRecordEnabled(): boolean {
  return process.env.OUTBOUND_HISTORY_RECORD_ENABLED !== "false";
}

// U6: routing-convergence shadow comparison. OFF by default and scoped per flow:
// ROUTING_CONVERGENCE_SHADOW is a comma-separated list of flow keys for which the
// shadow harness runs (e.g. "reminder_management,modify_schedule"). A flow is
// only shadowed when its key is present — so convergence is measured one
// reversible flow at a time, never wholesale (spike + KTD-5/KTD-11).
export function routingShadowFlows(): ReadonlySet<string> {
  const raw = process.env.ROUTING_CONVERGENCE_SHADOW ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isRoutingShadowEnabled(flow: string): boolean {
  return routingShadowFlows().has(flow);
}

// U10: the convergence flip switch. CONVERGENCE_FLIPPED is a comma-separated list
// of flow keys whose LIVE handling has been flipped from the cascade state machine
// to the MCP tool loop — done per flow ONLY after its shadow data (U6/U7) shows
// parity. Off by default: a flow stays on its state machine until explicitly
// flipped. Retiring (deleting) the dead state machine is a later, post-flip cleanup
// — the flip is reversible by clearing the flag; deletion is not.
export function convergenceFlippedFlows(): ReadonlySet<string> {
  const raw = process.env.CONVERGENCE_FLIPPED ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// Flows cut over to the prompt-driven dispatcher BY DEFAULT. Reversible per-flow
// via CONVERGENCE_UNFLIPPED (a kill switch), no redeploy needed.
//
//   • job_posting / modify_schedule (U13) — no payment/Checkr/account-creation
//     side effects; plan-sanctioned cutover on conversational parity alone,
//     proven by the resolveJobStep / resolveScheduleStep parity tests.
//   • onboarding (U12) — held DARK by default in the cara-100 ↔ caregiver-mvr
//     integration build (2026-06-27). cara-100 had flipped it on, but its parity
//     was proven against cara's *own* legacy machine; the merge brings in the
//     caregiver-mvr onboarding handlers, so that parity is no longer established
//     for the combined code, and the recommended real-model eval (KTD-6) was
//     never run. The proven legacy step flow ships by default. The dispatcher
//     stays fully available + tested (onboardingReplay U12 flag-ON suite) and can
//     be flipped per-flow via CONVERGENCE_FLIPPED=onboarding once re-validated.
const DEFAULT_FLIPPED_FLOWS: ReadonlySet<string> = new Set(["job_posting", "modify_schedule"]);

function convergenceUnflippedFlows(): ReadonlySet<string> {
  const raw = process.env.CONVERGENCE_UNFLIPPED ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isConvergenceFlipped(flow: string): boolean {
  // Kill switch wins: explicitly unflip a default-on flow if it ever misbehaves.
  if (convergenceUnflippedFlows().has(flow)) return false;
  // Default-on (conversational-parity-validated, no side effects).
  if (DEFAULT_FLIPPED_FLOWS.has(flow)) return true;
  // Everything else (incl. onboarding, reminder_management) stays opt-in via env.
  return convergenceFlippedFlows().has(flow);
}

// NOTE: the ONBOARDING_AGENT_LOOP* flags (role gate + canary cohort scoping) were
// removed on 2026-07-08 when the agent loop became the SOLE onboarding collection
// path (loop-only). Routing is now unconditional for text turns at a collection
// step — see shouldRouteOnboardingToLoop in agents/onboardingContract.ts. The env
// vars ONBOARDING_AGENT_LOOP / _PHONES / _COHORT_PCT are no longer read.

// ═════════════════════════════════════════════════════════════════════════════
// Childcare flags (childcare marketplace plan 2026-07-22-002, U1 / R61)
// ═════════════════════════════════════════════════════════════════════════════
//
// UNLIKE every flag above, the childcare flags are FIRESTORE-RESIDENT and
// runtime-flippable — never process.env values requiring a functions redeploy.
// Emergency-off must take effect without a deploy (R61); the only latency is
// the short in-memory cache TTL below (~60s).
//
// Documents (contract: data/contract.ts → childcare_flags):
//   • childcare_flags/global   — platform-wide baseline
//   • childcare_flags/{STATE}  — per-state overlay (e.g. childcare_flags/CA)
//
// Semantics — ALL fail-closed (childcare is OPT-IN; note this is the OPPOSITE
// default from the senior kill switches above, which default ON):
//   • Absent doc, absent field, or any non-`true` value ⇒ OFF.
//   • A state-scoped read requires BOTH the global doc AND that state's
//     overlay doc to set the flag to exactly `true` — a state can only narrow
//     global, never widen it, and no state is on by implication.
//   • Sub-capabilities (discovery/writes/proactive) are additionally gated on
//     CHILDCARE_ENABLED — the master flag off means everything is off.
//   • `emergencyOff: true` in EITHER doc force-falses every childcare flag
//     for that scope, regardless of the other fields.
//
// Cache: per-doc in-memory cache with a 60s TTL so hot paths don't re-read
// Firestore per turn, plus bustChildcareFlagsCache() for tests/admin tooling
// that needs an immediate re-read (e.g. right after flipping emergency-off).
// (The firebase-admin import lives at the top of the file; every env-var flag
// above reads process.env only.)

export const CHILDCARE_FLAGS_COLLECTION = "childcare_flags";
export const CHILDCARE_GLOBAL_FLAGS_DOC = "global";
export const CHILDCARE_FLAGS_CACHE_TTL_MS = 60_000;

/** Firestore field names on the flag docs (exact-`true` semantics). */
export const CHILDCARE_FLAG_NAMES = [
  "CHILDCARE_ENABLED",
  "CHILDCARE_DISCOVERY_ENABLED",
  "CHILDCARE_WRITES_ENABLED",
  "CHILDCARE_PROACTIVE_ENABLED",
] as const;
export type ChildcareFlagName = (typeof CHILDCARE_FLAG_NAMES)[number];

export interface ChildcareFlags {
  /** Master flag — everything childcare requires it. */
  enabled: boolean;
  /** Discovery/search/matching surfaces. */
  discoveryEnabled: boolean;
  /** Child-sensitive mutations (profiles, jobs, bookings). */
  writesEnabled: boolean;
  /** Proactive/scheduled childcare messaging. */
  proactiveEnabled: boolean;
  /** True when either scope has emergencyOff set — everything above is forced false. */
  emergencyOff: boolean;
}

export type ChildcareAppCheckMode = "off" | "monitor" | "enforce";

export interface ChildcareAppCheckConfig {
  mode: ChildcareAppCheckMode;
  source: "firestore" | "environment" | "default";
  transitionRecorded: boolean;
  transitionAt: string | null;
  providerRegistrationVerified: boolean;
  debugTokensAllowed: boolean;
  verifiedDomains: string[];
}

const CHILDCARE_ALL_OFF: ChildcareFlags = {
  enabled: false,
  discoveryEnabled: false,
  writesEnabled: false,
  proactiveEnabled: false,
  emergencyOff: false,
};

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

interface FlagDocCacheEntry {
  data: Record<string, unknown> | null; // null = doc absent (cached too)
  fetchedAtMs: number;
}

const childcareFlagDocCache = new Map<string, FlagDocCacheEntry>();

/** Explicit cache-bust hook: next read hits Firestore (tests, admin flips). */
export function bustChildcareFlagsCache(): void {
  childcareFlagDocCache.clear();
}

async function readChildcareFlagDoc(
  docId: string,
  db: FirestoreLike,
): Promise<Record<string, unknown> | null> {
  const cached = childcareFlagDocCache.get(docId);
  const nowMs = Date.now();
  if (cached && nowMs - cached.fetchedAtMs < CHILDCARE_FLAGS_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const snap = await db.collection(CHILDCARE_FLAGS_COLLECTION).doc(docId).get();
    const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    childcareFlagDocCache.set(docId, { data, fetchedAtMs: nowMs });
    return data;
  } catch {
    // Fail closed on read error and do NOT cache the failure — the next call
    // retries immediately instead of pinning childcare off for a full TTL.
    return null;
  }
}

function normalizeChildcareStateDocId(state: string): string {
  return state.trim().toUpperCase();
}

export async function getChildcareAppCheckConfig(
  opts: { db?: FirestoreLike } = {},
): Promise<ChildcareAppCheckConfig> {
  const db = opts.db ?? admin.firestore();
  const globalDoc = await readChildcareFlagDoc(CHILDCARE_GLOBAL_FLAGS_DOC, db);
  const firestoreMode = String(globalDoc?.CHILDCARE_APPCHECK_MODE ?? "").trim().toLowerCase();
  const envMode = String(process.env.CHILDCARE_APPCHECK_MODE ?? "").trim().toLowerCase();
  const valid = (value: string): value is ChildcareAppCheckMode =>
    value === "off" || value === "monitor" || value === "enforce";
  const mode = valid(firestoreMode)
    ? firestoreMode
    : valid(envMode)
      ? envMode
      : "monitor";
  const source = valid(firestoreMode)
    ? "firestore"
    : valid(envMode)
      ? "environment"
      : "default";
  const verifiedDomains = Array.isArray(globalDoc?.CHILDCARE_APPCHECK_VERIFIED_DOMAINS)
    ? globalDoc.CHILDCARE_APPCHECK_VERIFIED_DOMAINS
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10)
    : [];

  return {
    mode,
    source,
    transitionRecorded: source === "firestore" && typeof globalDoc?.CHILDCARE_APPCHECK_TRANSITION_AT === "string",
    transitionAt:
      typeof globalDoc?.CHILDCARE_APPCHECK_TRANSITION_AT === "string"
        ? globalDoc.CHILDCARE_APPCHECK_TRANSITION_AT
        : null,
    providerRegistrationVerified:
      globalDoc?.CHILDCARE_APPCHECK_PROVIDER_VERIFIED === true,
    debugTokensAllowed:
      globalDoc?.CHILDCARE_APPCHECK_DEBUG_TOKENS_ALLOWED === true,
    verifiedDomains,
  };
}

/**
 * Read the effective childcare flags. Without `state`, returns the global
 * scope; with `state`, returns the AND-combined global+overlay scope for that
 * jurisdiction. `db` is injectable for tests (default: admin.firestore()).
 */
export async function getChildcareFlags(
  opts: { state?: string; db?: FirestoreLike } = {},
): Promise<ChildcareFlags> {
  const db = opts.db ?? admin.firestore();
  const globalDoc = await readChildcareFlagDoc(CHILDCARE_GLOBAL_FLAGS_DOC, db);
  const stateDoc =
    opts.state !== undefined
      ? await readChildcareFlagDoc(normalizeChildcareStateDocId(opts.state), db)
      : undefined;

  if (globalDoc?.emergencyOff === true || stateDoc?.emergencyOff === true) {
    return { ...CHILDCARE_ALL_OFF, emergencyOff: true };
  }

  const on = (name: ChildcareFlagName): boolean =>
    globalDoc?.[name] === true && (opts.state === undefined || stateDoc?.[name] === true);

  const enabled = on("CHILDCARE_ENABLED");
  return {
    enabled,
    discoveryEnabled: enabled && on("CHILDCARE_DISCOVERY_ENABLED"),
    writesEnabled: enabled && on("CHILDCARE_WRITES_ENABLED"),
    proactiveEnabled: enabled && on("CHILDCARE_PROACTIVE_ENABLED"),
    emergencyOff: false,
  };
}
