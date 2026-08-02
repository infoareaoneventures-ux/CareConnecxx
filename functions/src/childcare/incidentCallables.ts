// ── Childcare incident + operator callables (plan 2026-07-22-002, U12 /
//    R53, R55-R57, AE18, AE24) ─────────────────────────────────────────────────
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   createChildcareIncident, listChildcareIncidents, getChildcareIncidentDetail,
//   updateChildcareIncidentStatus, assignChildcareIncident,
//   applyChildcareIncidentAction, resolveChildcareAuthorityDispute,
//   markProviderRedactionComplete
//
// Middleware stack (U2/U3 idiom) with TWO deliberate deviations:
//   1. NO childcare-flags gate: incident handling and operator access are
//      SAFETY operations and must work during emergency-off (the same
//      never-dark carve-out class as the U3 lifecycle worker). Everything else
//      (App Check, auth, rate limits, auth_time recent-auth, input bounds,
//      idempotency, enumeration-safe errors) applies unchanged.
//   2. Authorization is requireOperatorScope (R55 least privilege), NOT
//      requireAdmin: broad isAdmin alone never reads child-sensitive incident
//      detail (AE18). The queue row set is pinned sanitized (category/status/
//      timestamps — no child details); detail requires childSafetyOperator +
//      a recorded reason (R56) + recent auth.
//
// browser posture: childcare_incidents and childcare_operators are FULLY
// server-only in firestore.rules — even admins get no browser read; these
// callables are the only surface.

import * as functions from "firebase-functions/v1";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import {
  requireOperatorScope,
  requireAnyOperatorScope,
  OPERATOR_SCOPE_CHILD_SAFETY,
  OPERATOR_SCOPE_CHILD_SUPPORT,
} from "../admin/requireOperatorScope";
import {
  assignIncidentOwner,
  addIncidentEvidence,
  applyIncidentPayoutHold,
  createIncidentCaseFromMarker,
  createIncidentCaseFromReport,
  excludeSuspectedParty,
  getIncidentCase,
  isChildcareIncidentCategory,
  listIncidentCases,
  setIncidentLitigationHold,
  transitionIncidentStatus,
  ChildcareIncidentError,
  CHILDCARE_INCIDENT_STATUS_TRANSITIONS,
  type ChildcareIncidentStatus,
} from "./incidentPolicy";
import { resolveAuthorityDispute, GuardianAuthorityError } from "./guardianAuthority";
import { markProviderTaskComplete, LifecycleError } from "../privacy/dataLifecycle";

// ── Shared guard helpers ──────────────────────────────────────────────────────

const INCIDENT_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: "rl:childcare:incident:mut:",
};
const INCIDENT_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:incident:read:",
};

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** ONE generic error for every not-found/not-authorized shape (enumeration-safe). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

/** Map internal typed errors to enumeration-safe HttpsErrors (R21). */
function mapIncidentError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ChildcareIncidentError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    if (err.code === "invalid_transition") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "That status change is not allowed from the case's current state.",
        { code: "invalid_transition" },
      );
    }
    // case_not_found / marker_not_found — indistinguishable (enumeration-safe).
    throw permissionDenied();
  }
  console.error("[incidentCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

// ── createChildcareIncident (operator or system-from-marker) ─────────────────
//
// Open to BOTH pilot scopes: a generalOperator support person can FILE a case
// from a direct report (intake reveals nothing child-sensitive); reading the
// case back is childSafetyOperator work. Marker mode consumes U10's typed seam
// on the agent session; both modes dedupe deterministically (AE24).

export const createChildcareIncident = childcareOnCall("createChildcareIncident", async (data, context) => {
  const { operatorUid } = await requireAnyOperatorScope(
    context,
    [OPERATOR_SCOPE_CHILD_SAFETY, OPERATOR_SCOPE_CHILD_SUPPORT],
    { recentAuth: true },
  );
  await enforceRateLimit("createChildcareIncident", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    if (data?.fromMarker && typeof data.fromMarker === "object") {
      const phone = String((data.fromMarker as Record<string, unknown>).phone ?? "").trim();
      if (!phone || phone.length > 32) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
      }
      const { caseDoc, created } = await createIncidentCaseFromMarker({
        phone,
        actorUid: operatorUid,
      });
      return { success: true, caseId: caseDoc.caseId, created, duplicate: !created };
    }

    const category = String(data?.category ?? "").trim();
    const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
    if (!isChildcareIncidentCategory(category) || !idempotencyKey || idempotencyKey.length > 128) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    const { caseDoc, created } = await createIncidentCaseFromReport({
      category,
      reporterUid: operatorUid,
      idempotencyKey,
      bookingId: data?.bookingId != null ? String(data.bookingId) : null,
      sessionPhone: data?.sessionPhone != null ? String(data.sessionPhone) : null,
      householdId: data?.householdId != null ? String(data.householdId) : null,
      summary: data?.summary != null ? String(data.summary) : null,
    });
    return { success: true, caseId: caseDoc.caseId, created, duplicate: !created };
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── listChildcareIncidents (sanitized queue — AE18) ──────────────────────────
//
// Row set is the PINNED sanitized projection: category/status/timestamps/
// ownership + counts. NO child details, NO phone, NO booking id, NO summary.
// Open to both scopes (a billing/support operator sees nothing sensitive).

export const listChildcareIncidents = childcareOnCall("listChildcareIncidents", async (data, context) => {
  const { operatorUid } = await requireAnyOperatorScope(
    context,
    [OPERATOR_SCOPE_CHILD_SAFETY, OPERATOR_SCOPE_CHILD_SUPPORT],
    { recentAuth: false },
  );
  await enforceRateLimit("listChildcareIncidents", operatorUid, INCIDENT_READ_RATE);

  const rawStatus = data?.status != null ? String(data.status) : null;
  const status =
    rawStatus && Object.prototype.hasOwnProperty.call(CHILDCARE_INCIDENT_STATUS_TRANSITIONS, rawStatus)
      ? (rawStatus as ChildcareIncidentStatus)
      : null;
  if (rawStatus && !status) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const rows = await listIncidentCases({
      status,
      limit: Number(data?.limit ?? 50),
    });
    return { success: true, incidents: rows };
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── getChildcareIncidentDetail (childSafetyOperator + reason — R56/AE18) ─────

export const getChildcareIncidentDetail = childcareOnCall("getChildcareIncidentDetail", async (data, context) => {
  const caseId = String(data?.caseId ?? "").trim();
  if (!caseId || caseId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    access: {
      action: "incident_detail_read",
      objectRef: caseId,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("getChildcareIncidentDetail", operatorUid, INCIDENT_READ_RATE);

  try {
    const detail = await getIncidentCase(caseId);
    return { success: true, incident: detail };
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── updateChildcareIncidentStatus (deterministic workflow + appeal states) ───

export const updateChildcareIncidentStatus = childcareOnCall("updateChildcareIncidentStatus", async (data, context) => {
  const caseId = String(data?.caseId ?? "").trim();
  const to = String(data?.status ?? "").trim();
  if (
    !caseId ||
    caseId.length > 128 ||
    !Object.prototype.hasOwnProperty.call(CHILDCARE_INCIDENT_STATUS_TRANSITIONS, to)
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    access: {
      action: "incident_status_update",
      objectRef: caseId,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("updateChildcareIncidentStatus", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    const updated = await transitionIncidentStatus({
      caseId,
      to: to as ChildcareIncidentStatus,
      actorUid: operatorUid,
      note: data?.note != null ? String(data.note) : null,
    });
    return { success: true, caseId, status: updated.status };
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── assignChildcareIncident (case owner — deterministic ownership, R53) ──────

export const assignChildcareIncident = childcareOnCall("assignChildcareIncident", async (data, context) => {
  const caseId = String(data?.caseId ?? "").trim();
  const ownerUid = String(data?.ownerUid ?? "").trim();
  if (!caseId || caseId.length > 128 || !ownerUid || ownerUid.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    access: {
      action: "incident_assign",
      objectRef: caseId,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("assignChildcareIncident", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    const updated = await assignIncidentOwner({ caseId, ownerUid, actorUid: operatorUid });
    return { success: true, caseId, ownerUid: updated.ownerUid };
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── applyChildcareIncidentAction (evidence / exclusion / holds — R56) ────────
//
// The child-sensitive case ACTIONS, each requiring childSafetyOperator + a
// recorded reason: evidence references (never copies), suspected-party
// exclusion (feeds U9's excludedUids fan-out skip — AE24), U8 payout hold,
// and the U3 litigation hold (blocks delete/redact while active).

export const applyChildcareIncidentAction = childcareOnCall("applyChildcareIncidentAction", async (data, context) => {
  const caseId = String(data?.caseId ?? "").trim();
  const action = String(data?.action ?? "").trim();
  if (!caseId || caseId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    access: {
      action: `incident_action:${action.slice(0, 64)}`,
      objectRef: caseId,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("applyChildcareIncidentAction", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    switch (action) {
      case "add_evidence": {
        const updated = await addIncidentEvidence({
          caseId,
          kind: String(data?.kind ?? ""),
          ref: String(data?.ref ?? ""),
          actorUid: operatorUid,
        });
        return { success: true, caseId, evidenceCount: updated.evidenceRefs.length };
      }
      case "exclude_party": {
        const updated = await excludeSuspectedParty({
          caseId,
          suspectUid: String(data?.suspectUid ?? ""),
          bookingId: data?.bookingId != null ? String(data.bookingId) : null,
          actorUid: operatorUid,
        });
        return { success: true, caseId, suspectedPartyCount: updated.suspectedPartyUids.length };
      }
      case "payout_hold": {
        const result = await applyIncidentPayoutHold({
          caseId,
          appointmentId: String(data?.appointmentId ?? ""),
          actorUid: operatorUid,
        });
        return {
          success: true,
          caseId,
          held: result.held,
          alreadyPaidOut: result.alreadyPaidOut,
        };
      }
      case "litigation_hold":
      case "release_litigation_hold": {
        const updated = await setIncidentLitigationHold({
          caseId,
          childId: String(data?.childId ?? ""),
          active: action === "litigation_hold",
          actorUid: operatorUid,
        });
        return {
          success: true,
          caseId,
          litigationHoldActive: updated.litigationHolds.some((h) => h.active),
        };
      }
      default:
        throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
  } catch (err) {
    mapIncidentError(err);
  }
});

// ── resolveChildcareAuthorityDispute (surfaces U2's server function — R18) ───
//
// Custody/authority disputes are child-sensitive: childSafetyOperator + reason
// + recent auth. The server function (guardianAuthority.resolveAuthorityDispute)
// owns the transaction, versioning, and audit.

export const resolveChildcareAuthorityDispute = childcareOnCall("resolveChildcareAuthorityDispute", async (data, context) => {
  const childId = String(data?.childId ?? "").trim();
  const targetAdultUid = String(data?.targetAdultUid ?? "").trim();
  const resolution = data?.resolution === "restored" ? "restored" : data?.resolution === "applied" ? "applied" : null;
  if (!childId || childId.length > 128 || !targetAdultUid || targetAdultUid.length > 128 || !resolution) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    access: {
      action: "authority_dispute_resolve",
      objectRef: `${childId}__${targetAdultUid}`,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("resolveChildcareAuthorityDispute", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    const doc = await resolveAuthorityDispute({
      operatorUid,
      childId,
      targetAdultUid,
      resolution,
    });
    return { success: true, state: doc.state, accessVersion: doc.accessVersion };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    if (err instanceof GuardianAuthorityError) {
      if (err.code === "not_in_dispute") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "This authority is not under dispute review.",
          { code: "not_in_dispute" },
        );
      }
      throw permissionDenied(); // authority_not_found etc. — enumeration-safe
    }
    console.error("[incidentCallables] dispute resolution error:", err instanceof Error ? err.name : "Error");
    throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
  }
});

// ── markProviderRedactionComplete (surfaces U3's markProviderTaskComplete) ───
//
// The Stripe Identity redaction task is founder/provider-executed; completing
// the lifecycle task is billing/recovery work (generalOperator — it reads no
// child data), gated on recent auth because it closes a privacy workflow.

export const markProviderRedactionComplete = childcareOnCall("markProviderRedactionComplete", async (data, context) => {
  const requestId = String(data?.requestId ?? "").trim();
  const taskId = String(data?.taskId ?? "").trim();
  if (!requestId || requestId.length > 200 || !taskId || taskId.length > 200) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SUPPORT, {
    recentAuth: true,
    access: {
      action: "provider_redaction_complete",
      objectRef: requestId,
      reason: data?.reason,
    },
  });
  await enforceRateLimit("markProviderRedactionComplete", operatorUid, INCIDENT_MUTATION_RATE);

  try {
    const doc = await markProviderTaskComplete({
      requestId,
      taskId,
      operatorUid,
      providerRef: data?.providerRef != null ? String(data.providerRef) : null,
    });
    return { success: true, requestId, state: doc.state };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    if (err instanceof LifecycleError) throw permissionDenied(); // request_not_found — enumeration-safe
    console.error("[incidentCallables] provider-task error:", err instanceof Error ? err.name : "Error");
    throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
  }
});

// ── flag/remove childcare review moderation (generalOperator — U8 seam) ──────
//
// Lives here (not reviewCallables.ts) so ALL operator-gated childcare
// callables share one module; the moderationState field + aggregates-exclude-
// removed behavior shipped with U8 (reputationProjection).

export const flagChildcareReview = childcareOnCall("flagChildcareReview", async (data, context) => {
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    recentAuth: true,
  });
  await enforceRateLimit("flagChildcareReview", operatorUid, INCIDENT_MUTATION_RATE);
  return moderateChildcareReview(data, operatorUid, "flagged");
});

export const removeChildcareReview = childcareOnCall("removeChildcareReview", async (data, context) => {
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    recentAuth: true,
  });
  await enforceRateLimit("removeChildcareReview", operatorUid, INCIDENT_MUTATION_RATE);
  const reason = typeof data?.reason === "string" ? data.reason.trim() : "";
  if (!reason || reason.length > 500) {
    // Removal REASON is mandatory and audited (R56-adjacent moderation trail).
    throw new functions.https.HttpsError(
      "failed-precondition",
      "A removal reason is required.",
      { code: "removal_reason_required" },
    );
  }
  return moderateChildcareReview(data, operatorUid, "removed", reason);
});

async function moderateChildcareReview(
  data: unknown,
  operatorUid: string,
  moderationState: "flagged" | "removed",
  reason?: string,
): Promise<{ success: true; reviewId: string; moderationState: string }> {
  const payload = (data ?? {}) as Record<string, unknown>;
  const reviewId = String(payload.reviewId ?? "").trim();
  if (!reviewId || reviewId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  const adminSdk = await import("firebase-admin");
  const db = adminSdk.firestore();
  const ref = db.collection("reviews").doc(reviewId);
  const snap = await ref.get();
  const review = (snap.data() ?? {}) as Record<string, unknown>;
  // Childcare reviews ONLY — senior review moderation keeps its existing
  // admin surface (isPublic / delete). Enumeration-safe denial otherwise.
  if (!snap.exists || review.careVertical !== "child") throw permissionDenied();

  // ONLY the two pinned fields move (CHILDCARE_REVIEW_DOC_KEYS is the exact
  // world-readable key set — operator identity and reason belong in the audit
  // log, never on a public doc). U8's aggregates already exclude "removed".
  await ref.update({
    moderationState,
    isPublic: moderationState !== "removed",
  });

  await logAudit({
    eventType: "childcare_review_moderated",
    userId: operatorUid,
    data: { reviewId, moderationState, reason: reason ?? null },
  }).catch(() => {});

  return { success: true, reviewId, moderationState };
}
