// ── Child-profile + privacy-lifecycle callables (plan 2026-07-22-002, U3) ────
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   createChildProfile, updateChildProfile, appendChildSafetyVersion,
//   getChildProfile, listMyChildren, requestChildDataExport,
//   requestChildDataDeletion, getLifecycleRequestStatus
//
// Every callable stacks the R21 controls in the exact U2 order:
//   1. requireAppCheck (KTD22 — monitor/enforce via CHILDCARE_APPCHECK_MODE)
//   2. Firebase Auth (context.auth)
//   3. Childcare runtime flags (R61 — Firestore-resident; mutations need
//      writesEnabled, reads need enabled; everything dark until launch).
//      NOTE (design tension flagged for founder review): lifecycle
//      export/delete are DATA RIGHTS (R14) — once real child data exists,
//      an emergency-off that also blocks deletion requests needs an explicit
//      policy decision. For now the full U2 stack applies uniformly.
//   4. Rate limiting (fail-closed checkRateLimit)
//   5. Recent authentication on HIGH-RISK ops from the ID token's
//      server-checked auth_time claim (R18): creating a child profile
//      (guardian attestation), appending safety data, and requesting
//      deletion/redaction/export.
//   6. Input bounds + idempotency keys
//   7. Object-level authorization inside the repositories (checkAuthority is
//      THE primitive — the authorizedViewerUids cache is display-read only
//      and never consulted here; a stale cache entry cannot authorize).
//   8. Enumeration-safe errors: not-found and not-authorized are the SAME
//      generic permission-denied.
//
// Browser writes to child_profiles (and everything under it) and
// data_lifecycle_requests are denied by firestore.rules — these callables are
// the only mutation path (R11/KTD6). Browser READS are limited to the
// operational summary via the authorizedViewerUids rules check; the private
// zone has no browser path at all.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { requireRecentAuth } from "./authorityCallables";
import { checkAuthority, listAuthoritiesForAdult, GuardianAuthorityError } from "./guardianAuthority";
import {
  createChildProfileWithBootstrap,
  updateChildProfile as updateChildProfileTx,
  appendChildSafetyVersion as appendSafetyVersionTx,
  getChildProfile as getChildProfileDoc,
  ChildProfileError,
  type ChildProfileDoc,
} from "../data/childProfileRepository";
import {
  createLifecycleRequest,
  getLifecycleStatusForRequester,
  LifecycleError,
} from "../privacy/dataLifecycle";

// ── Shared guard helpers (U2 middleware stack) ───────────────────────────────

const CHILDCARE_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:mut:",
};
const CHILDCARE_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:read:",
};

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(kind: "read" | "write"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok = kind === "write" ? flags.writesEnabled : flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

/** Map internal typed errors to enumeration-safe HttpsErrors (R21). */
function mapChildError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ChildProfileError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    if (err.code === "already_adult") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Child profiles are for minors only.",
        { code: "already_adult" },
      );
    }
    if (err.code === "legal_hold_active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This record is under review and cannot be changed right now.",
        { code: "legal_hold_active" },
      );
    }
    if (err.code === "concurrent_change") {
      throw new functions.https.HttpsError(
        "aborted",
        "This profile changed while you were editing. Reload and try again.",
        { code: "concurrent_change" },
      );
    }
    // not_authorized / household_not_found / child_not_found / child_deleted /
    // immutable_version — deliberately indistinguishable.
    throw permissionDenied();
  }
  if (err instanceof LifecycleError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    if (err.code === "legal_hold_active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This record is under a legal hold and cannot be deleted yet.",
        { code: "legal_hold_active" },
      );
    }
    throw permissionDenied();
  }
  if (err instanceof GuardianAuthorityError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    throw permissionDenied();
  }
  console.error("[childProfileCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

/** Operational summary projection returned to browsers — NEVER the private zone. */
function summarize(profile: ChildProfileDoc): Record<string, unknown> {
  return {
    childId: profile.childId,
    householdId: profile.householdId,
    careVertical: profile.careVertical,
    displayLabel: profile.displayLabel,
    ageBand: profile.ageBand,
    careCategories: profile.careCategories,
    state: profile.state,
    safetyCurrentVersion: profile.safetyCurrentVersion,
    retentionPolicyVersion: profile.retentionPolicyVersion,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// ── createChildProfile ───────────────────────────────────────────────────────

export const createChildProfile = childcareOnCall("createChildProfile", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("createChildProfile", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // guardian attestation is high-risk (R18)

  const householdId = String(data?.householdId ?? "").trim();
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  // R23: guardian attestation is a versioned consent receipt, never a boolean.
  const guardianAttestationVersion = String(data?.guardianAttestationVersion ?? "").trim();
  if (!householdId || householdId.length > 200 || !idempotencyKey || idempotencyKey.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  if (!guardianAttestationVersion || guardianAttestationVersion.length > 64) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const result = await createChildProfileWithBootstrap({
      householdId,
      createdByUid: uid,
      displayLabel: data?.displayLabel,
      careCategories: data?.careCategories,
      safety: data?.safety,
      idempotencyKey,
      policyVersion: guardianAttestationVersion,
    });
    await logAudit({
      eventType: "child_profile_callable_create",
      userId: uid,
      data: {
        childId: result.profile.childId,
        householdId,
        guardianAttestationVersion,
        created: result.created,
      },
    }).catch(() => {});
    return {
      success: true,
      childId: result.profile.childId,
      created: result.created,
      profile: summarize(result.profile),
      authority: {
        authorityId: result.authority.authorityId,
        scopes: result.authority.scopes,
        accessVersion: result.authority.accessVersion,
      },
    };
  } catch (err) {
    mapChildError(err);
  }
});

// ── updateChildProfile ───────────────────────────────────────────────────────

export const updateChildProfile = childcareOnCall("updateChildProfile", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("updateChildProfile", uid, CHILDCARE_MUTATION_RATE);

  const childId = String(data?.childId ?? "").trim();
  if (!childId || childId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const profile = await updateChildProfileTx({
      actorUid: uid,
      childId,
      updates: {
        ...(data?.displayLabel !== undefined ? { displayLabel: data.displayLabel } : {}),
        ...(data?.careCategories !== undefined ? { careCategories: data.careCategories } : {}),
      },
      idempotencyKey: String(data?.idempotencyKey ?? "").trim() || null,
    });
    return { success: true, profile: summarize(profile) };
  } catch (err) {
    mapChildError(err);
  }
});

// ── appendChildSafetyVersion ─────────────────────────────────────────────────

export const appendChildSafetyVersion = childcareOnCall("appendChildSafetyVersion", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("appendChildSafetyVersion", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // restricted safety data is high-risk (R18)

  const childId = String(data?.childId ?? "").trim();
  if (!childId || childId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const result = await appendSafetyVersionTx({
      actorUid: uid,
      childId,
      safety: data?.safety,
      changeReason: typeof data?.changeReason === "string" ? data.changeReason : null,
      idempotencyKey: String(data?.idempotencyKey ?? "").trim() || null,
    });
    // Version NUMBER and pointer state only — never the restricted payload back.
    return {
      success: true,
      version: result.version.version,
      appended: result.appended,
    };
  } catch (err) {
    mapChildError(err);
  }
});

// ── getChildProfile ──────────────────────────────────────────────────────────

export const getChildProfile = childcareOnCall("getChildProfile", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getChildProfile", uid, CHILDCARE_READ_RATE);

  const childId = String(data?.childId ?? "").trim();
  if (!childId || childId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const db = admin.firestore();
    // Live authority — the derived viewer cache is NEVER consulted server-side
    // (R6: a stale cache that still lists a revoked adult cannot read here).
    const decision = await checkAuthority(uid, childId, "view", { db });
    if (!decision.allowed) throw permissionDenied();
    const profile = await getChildProfileDoc(childId, db);
    if (!profile || profile.state === "deleted") throw permissionDenied();
    return { success: true, profile: summarize(profile), myScopesVersion: decision.accessVersion };
  } catch (err) {
    mapChildError(err);
  }
});

// ── listMyChildren ───────────────────────────────────────────────────────────

export const listMyChildren = childcareOnCall("listMyChildren", async (_data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("listMyChildren", uid, CHILDCARE_READ_RATE);

  try {
    const db = admin.firestore();
    const authorities = await listAuthoritiesForAdult(uid, db);
    const children: Array<Record<string, unknown>> = [];
    for (const authority of authorities) {
      // Authority is the source: only ACTIVE, view-scoped rows surface a child.
      const decision = await checkAuthority(uid, authority.childId, "view", { db });
      if (!decision.allowed) continue;
      const profile = await getChildProfileDoc(authority.childId, db);
      if (!profile || profile.state === "deleted") continue;
      children.push({ ...summarize(profile), myScopes: authority.scopes });
    }
    return { success: true, children };
  } catch (err) {
    mapChildError(err);
  }
});

// ── requestChildDataExport ───────────────────────────────────────────────────

export const requestChildDataExport = childcareOnCall("requestChildDataExport", async (data, context) => {
  const uid = requireAuth(context);
  // Deliberately NOT gated on childcare flags: R14 data rights must remain
  // exercisable while childcare is disabled or emergency-off (the lifecycle
  // worker likewise runs ungated). Authority checks inside
  // createLifecycleRequest still apply.
  await enforceRateLimit("requestChildDataExport", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // exporting restricted child data is high-risk (R14/R18)

  const childId = String(data?.childId ?? "").trim();
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  if (!childId || childId.length > 128 || !idempotencyKey || idempotencyKey.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const request = await createLifecycleRequest({
      requesterUid: uid,
      childId,
      scope: "export",
      idempotencyKey,
    });
    return { success: true, requestId: request.requestId, state: request.state };
  } catch (err) {
    mapChildError(err);
  }
});

// ── requestChildDataDeletion ─────────────────────────────────────────────────

export const requestChildDataDeletion = childcareOnCall("requestChildDataDeletion", async (data, context) => {
  const uid = requireAuth(context);
  // Deliberately NOT gated on childcare flags: R15 deletion rights must remain
  // exercisable while childcare is disabled or emergency-off.
  await enforceRateLimit("requestChildDataDeletion", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // destructive — high-risk (R15/R18)

  const childId = String(data?.childId ?? "").trim();
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  const scope = data?.scope === "redact" ? "redact" : "delete";
  if (!childId || childId.length > 128 || !idempotencyKey || idempotencyKey.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const request = await createLifecycleRequest({
      requesterUid: uid,
      childId,
      scope,
      idempotencyKey,
    });
    return { success: true, requestId: request.requestId, state: request.state };
  } catch (err) {
    mapChildError(err);
  }
});

// ── getLifecycleRequestStatus ────────────────────────────────────────────────

export const getLifecycleRequestStatus = childcareOnCall("getLifecycleRequestStatus", async (data, context) => {
  const uid = requireAuth(context);
  // Deliberately NOT gated on childcare flags: requesters must be able to see
  // export/deletion progress while childcare is disabled or emergency-off.
  await enforceRateLimit("getLifecycleRequestStatus", uid, CHILDCARE_READ_RATE);

  const requestId = String(data?.requestId ?? "").trim();
  if (!requestId || requestId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const status = await getLifecycleStatusForRequester(uid, requestId);
    return { success: true, ...status };
  } catch (err) {
    mapChildError(err);
  }
});
