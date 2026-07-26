// ── Least-privilege operator scopes (childcare marketplace plan 2026-07-22-002,
//    U12 / R55-R56, KTD20, AE18) ────────────────────────────────────────────────
//
// requireAdmin.ts stays UNTOUCHED for its existing consumers (broad senior
// admin surface). New childcare admin callables gate on THIS module instead.
//
// PILOT STAGING DECISION (binding, 2026-07-22 review): TWO operator roles —
//   • childSafetyOperator — screening review, incident cases, authority
//     disputes, child-data access with a recorded reason (R56).
//   • generalOperator     — billing, support, recovery: everything the current
//     broad isAdmin does EXCEPT child-sensitive reads (AE18).
// Scopes are STRINGS (not booleans) so the six-role split (KTD20: trust/safety,
// screening, incident, billing, support, system) can be added later without
// changing any call site — new scope constants + operator-doc grants only.
//
// STORAGE PATTERN: Firestore-resident, matching how isAdmin works today
// (requireAdmin.ts reads users/{uid}.userType/isAdmin from Firestore — this
// repo has no custom-claims machinery). Operator grants live in
//   childcare_operators/{uid} = {
//     operatorUid, scopes: string[], active: boolean,
//     grantedByUid, grantedAt, revokedAt, updatedAt
//   }
// The collection is FULLY server-only in firestore.rules (reads denied even to
// admins) and founder-provisioned via an Admin SDK script (never a callable —
// scope self-grant must be impossible from any client path).
//
// SEMANTICS (R55/AE18):
//   • childSafetyOperator is satisfied ONLY by an active operator grant that
//     carries the scope. Broad isAdmin alone NEVER satisfies it.
//   • generalOperator is satisfied by an active grant with the scope OR by
//     broad isAdmin (users/{uid}.userType === 'admin' || isAdmin === true) —
//     the pilot decision keeps existing admin billing/support/recovery
//     workflows working without re-provisioning every admin.
//   • Removing/deactivating the operator doc revokes access immediately (the
//     grant is read live per call — no cache).
//   • Denials are enumeration-safe: unauthenticated, no grant, inactive grant,
//     and missing scope all produce the SAME generic permission-denied.
//
// SENSITIVE ACCESS (R56): callers pass `access: { action, objectRef, reason }`
// for child-sensitive reads/operations. The reason is REQUIRED (missing ⇒
// failed-precondition after the scope check, so only authorized operators ever
// learn a reason was expected), and the access record — actor, scope, action,
// object, reason, timestamp — is written to the immutable audit log
// (agent_audit_log, server-only, 6y TTL) FAIL-CLOSED: if the audit row cannot
// be written, access is denied. This is deliberately stricter than logAudit
// (which is fail-open) — an unrecorded sensitive access must not happen.
//
// RECENT AUTH (R18/R56): child-sensitive operations verify the ID token's
// server-checked auth_time claim (childcare/authorityCallables.requireRecentAuth).
// Default ON for childSafetyOperator, opt-out per call via recentAuth: false;
// opt-in for generalOperator via recentAuth: true.
//
// EMERGENCY-OFF: this gate NEVER consults the childcare runtime flags — safety
// operations are never dark (same carve-out class as the U3 lifecycle worker).

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireRecentAuth } from "../childcare/authorityCallables";

export const CHILDCARE_OPERATORS_COLLECTION = "childcare_operators";

/** Pilot scopes. Six-role split later = more constants here, no API change. */
export const OPERATOR_SCOPE_CHILD_SAFETY = "childSafetyOperator";
export const OPERATOR_SCOPE_GENERAL = "generalOperator";
export const OPERATOR_SCOPE_CHILD_BILLING = "childBillingOperator";
export const OPERATOR_SCOPE_CHILD_SUPPORT = "childSupportOperator";
export const OPERATOR_SCOPE_CHILD_SCREENING = "childScreeningOperator";

export const OPERATOR_SCOPES = [
  OPERATOR_SCOPE_CHILD_SAFETY,
  OPERATOR_SCOPE_GENERAL,
  OPERATOR_SCOPE_CHILD_BILLING,
  OPERATOR_SCOPE_CHILD_SUPPORT,
  OPERATOR_SCOPE_CHILD_SCREENING,
] as const;

export const CHILDCARE_OPERATOR_ACCESS_REASON_CODES = [
  "incident_triage",
  "incident_investigation",
  "safety_review",
  "authority_dispute_review",
  "billing_reconciliation",
  "refund_review",
  "payout_hold_review",
  "privacy_request",
  "screening_review",
  "support_case",
  "moderation_queue_review",
  "approve_safe",
  "reject_child_pii",
  "reject_abuse",
  "reject_irrelevant",
  "unpublish_policy",
  "delete_retention",
] as const;

/** Scope strings — deliberately open for the future six-role split (KTD20). */
export type OperatorScope = string;

export interface OperatorGrantDoc {
  operatorUid: string;
  scopes: string[];
  active: boolean;
  grantedByUid?: string | null;
  grantedAt?: string | null;
  revokedAt?: string | null;
  updatedAt?: string | null;
}

type Db = Pick<admin.firestore.Firestore, "collection">;

function defaultDb(): Db {
  return admin.firestore();
}

/** R56 sensitive-access descriptor — presence makes the reason REQUIRED. */
export interface OperatorAccessContext {
  /** What is being done (e.g. "incident_detail_read"). */
  action: string;
  /** Opaque object reference (case id, child id, authority id) — never PII. */
  objectRef: string;
  /** Client-supplied reason-for-access (validated + audited). */
  reason?: unknown;
}

export interface RequireOperatorScopeOptions {
  db?: Db;
  now?: Date;
  /** Sensitive read/operation: reason required + immutably audited (R56). */
  access?: OperatorAccessContext;
  /**
   * auth_time recent-auth (R18/R56). Default: true for childSafetyOperator,
   * false for generalOperator.
   */
  recentAuth?: boolean;
  maxAuthAgeSeconds?: number;
}

/** ONE generic denial for every unauthorized shape (enumeration-safe, R21). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

/**
 * Pure decision helper (unit-testable without Firestore): does the caller's
 * grant set satisfy the required scope?
 *
 *   • childSafetyOperator: explicit grant ONLY (R55/AE18 — broad admin never
 *     implies it).
 * Every scope requires an explicit live grant. Broad admin is never an
 * operator grant and cannot satisfy any child-bearing access boundary.
 */
export function operatorScopeSatisfied(
  scope: OperatorScope,
  grantedScopes: readonly string[],
  _isBroadAdmin = false,
): boolean {
  return grantedScopes.includes(scope);
}

/** Read the caller's ACTIVE operator grant scopes (live — no cache, so grant removal revokes immediately). */
export async function getActiveOperatorScopes(uid: string, db: Db): Promise<string[]> {
  const snap = await db.collection(CHILDCARE_OPERATORS_COLLECTION).doc(uid).get();
  if (!snap.exists) return [];
  const data = (snap.data() ?? {}) as Partial<OperatorGrantDoc>;
  if (data.active !== true) return [];
  return Array.isArray(data.scopes)
    ? data.scopes.map((s) => String(s ?? "").trim()).filter(Boolean)
    : [];
}

const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;
const SAFE_AUDIT_TOKEN = /^[a-z0-9_.:-]{1,256}$/i;

/**
 * R56 immutable access record — FAIL-CLOSED direct write to agent_audit_log
 * (rules-denied to all clients; 6y TTL like every audit row). Unlike logAudit,
 * a write failure here THROWS: an unrecorded sensitive access is a denial.
 */
async function recordSensitiveAccessOrDeny(params: {
  db: Db;
  operatorUid: string;
  scope: OperatorScope;
  access: OperatorAccessContext;
  reasonCode: string;
  now: Date;
}): Promise<void> {
  const ts = params.now.toISOString();
  const timestampCtor = (admin.firestore as unknown as {
    Timestamp?: { fromMillis?: (ms: number) => unknown };
  })?.Timestamp;
  const ttl = timestampCtor?.fromMillis
    ? timestampCtor.fromMillis(params.now.getTime() + SIX_YEARS_MS)
    : null;
  try {
    await params.db.collection("agent_audit_log").add({
      schemaVersion: "childcare-operator-access-v2",
      careVertical: "child",
      eventType: "childcare_operator_access",
      userId: params.operatorUid,
      data: {
        scope: params.scope,
        action: params.access.action,
        objectRef: params.access.objectRef,
        reasonCode: params.reasonCode,
      },
      timestamp: ts,
      retentionClass: "security_six_year",
      legalHold: false,
      ttl,
    });
  } catch (err) {
    console.error(
      "[requireOperatorScope] sensitive-access audit write failed — denying access:",
      err instanceof Error ? err.message.slice(0, 160) : "unknown",
    );
    throw new functions.https.HttpsError(
      "internal",
      "This action could not be recorded and was not performed. Please try again.",
    );
  }
}

/**
 * Gate a callable on a least-privilege operator scope (R55). Resolves to the
 * operator's uid for audit attribution. Check order (enumeration safety):
 *   1. auth → generic permission-denied
 *   2. scope (live grant read) → generic permission-denied
 *   3. recent auth (authorized operators only see this) → failed-precondition
 *   4. reason presence for sensitive access → failed-precondition
 *   5. immutable access record (fail-closed) → internal on write failure
 */
export async function requireOperatorScope(
  context: functions.https.CallableContext,
  scope: OperatorScope,
  opts: RequireOperatorScopeOptions = {},
): Promise<string> {
  if (!context.auth) throw permissionDenied();
  const uid = context.auth.uid;
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();

  const grantedScopes = await getActiveOperatorScopes(uid, db);
  if (!operatorScopeSatisfied(scope, grantedScopes)) {
    throw permissionDenied();
  }

  const recentAuthRequired =
    opts.recentAuth ?? scope === OPERATOR_SCOPE_CHILD_SAFETY;
  if (recentAuthRequired) {
    requireRecentAuth(context, {
      maxAgeSeconds: opts.maxAuthAgeSeconds,
      now,
    });
  }

  if (opts.access) {
    const rawReason = opts.access.reason;
    const reasonCode = typeof rawReason === "string" ? rawReason.trim() : "";
    const action = String(opts.access.action ?? "").trim();
    const objectRef = String(opts.access.objectRef ?? "").trim();
    if (
      !(CHILDCARE_OPERATOR_ACCESS_REASON_CODES as readonly string[]).includes(reasonCode) ||
      !SAFE_AUDIT_TOKEN.test(action) ||
      !SAFE_AUDIT_TOKEN.test(objectRef)
    ) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "A valid reason code is required for this action.",
        { code: "access_reason_required" },
      );
    }
    await recordSensitiveAccessOrDeny({
      db,
      operatorUid: uid,
      scope,
      access: opts.access,
      reasonCode,
      now,
    });
  }

  return uid;
}

/**
 * First-satisfied scope wins (e.g. incident creation is open to BOTH pilot
 * roles). Same enumeration-safe denial when none match.
 */
export async function requireAnyOperatorScope(
  context: functions.https.CallableContext,
  scopes: readonly OperatorScope[],
  opts: RequireOperatorScopeOptions = {},
): Promise<{ operatorUid: string; scope: OperatorScope }> {
  if (!context.auth) throw permissionDenied();
  const uid = context.auth.uid;
  const db = opts.db ?? defaultDb();

  const grantedScopes = await getActiveOperatorScopes(uid, db);
  let matched: OperatorScope | null = null;
  for (const scope of scopes) {
    if (operatorScopeSatisfied(scope, grantedScopes, false)) {
      matched = scope;
      break;
    }
  }
  if (!matched) throw permissionDenied();

  // Delegate the recent-auth / reason / audit steps to the single-scope gate
  // (grant re-read is cheap and keeps one code path authoritative).
  const operatorUid = await requireOperatorScope(context, matched, opts);
  return { operatorUid, scope: matched };
}
