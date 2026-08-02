// ── Childcare provider vertical callables (plan 2026-07-22-002, U5) ──────────
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   upsertChildcareVerticalProfile, getMyChildcareProviderState,
//   acceptChildcarePolicy, startChildcareScreening,
//   approveChildcareProvider, suspendChildcareProvider
//
// Same R21 middleware stack as the U2/U3 callables (authorityCallables.ts):
//   1. requireAppCheck (KTD22)
//   2. Firebase Auth
//   3. Firestore-resident childcare flags (R61 — mutations need writesEnabled,
//      reads need enabled; everything dark until launch)
//   4. Fail-closed rate limits
//   5. auth_time recent-auth on high-risk ops (operator decisions)
//   6. Input bounds + idempotent effects (deterministic doc IDs, create-once
//      screening starts)
//   7. Object-level authorization (a caregiver touches only their OWN
//      subcollection docs; operator ops go through the scope stub below)
//   8. Enumeration-safe errors
//
// R24 STRUCTURAL WALL: these callables write ONLY
// caregivers/{uid}/vertical_profiles/child, caregivers/{uid}/screenings/child,
// and the namespaced derived summary via recomputeChildcareProviderVisibility.
// No senior field (services/rates/approval/reputation/verificationStatus/...)
// is ever written — pinned by providerVerticalCallables.test.ts.
//
// OPERATOR GATE (U12 — stub replaced): approveChildcareProvider /
// suspendChildcareProvider are gated on requireChildcareOperatorScope, now the
// REAL least-privilege gate (admin/requireOperatorScope.ts): screening review
// requires the childScreeningOperator scope; broad isAdmin alone is DENIED
// (R55/AE18). The callable contract is unchanged from U5.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import {
  requireOperatorScope,
  OPERATOR_SCOPE_CHILD_SCREENING,
} from "../admin/requireOperatorScope";
import {
  assertEnableableChildcareCategory,
  isEnableableChildcareCategory,
  loadJurisdictionPolicy,
  normalizeStateCode,
} from "./jurisdictionPolicy";
import {
  adoptableBaseEvidence,
  buildScreeningForInvitation,
  buildScreeningFromBaseEvidence,
  childcareScreeningRef,
  evaluateScreeningEvidence,
  loadChildcareScreening,
  type ProviderCredential,
} from "./screeningPolicy";
import {
  childcareVerticalProfileRef,
  computeMissingChildcareFields,
  evaluateChildcareProviderEligibility,
  loadChildcareVerticalProfile,
  recomputeChildcareProviderVisibility,
  type ChildcareVerticalProfileDoc,
} from "./providerEligibility";
import { writeChildcareConsentReceipts } from "./consentReceipts";

// ── Shared guard helpers (authorityCallables idiom) ──────────────────────────

const CHILDCARE_PROVIDER_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:provider:mut:",
};
const CHILDCARE_PROVIDER_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:provider:read:",
};

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  return context.auth.uid;
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

/** ONE generic error for every not-found/not-authorized shape (enumeration-safe). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

/**
 * U12 (replaces the U5 stub): childcare operator scope check — the real
 * least-privilege gate (admin/requireOperatorScope.ts, R55/AE18). Screening
 * review (approve/suspend) requires the dedicated childScreeningOperator
 * scope, and broad isAdmin alone NO LONGER satisfies it.
 * The callable contract is unchanged (same callers, same seam).
 */
export const CHILDCARE_SCREENING_OPERATOR_SCOPE = OPERATOR_SCOPE_CHILD_SCREENING;

export async function requireChildcareOperatorScope(
  context: functions.https.CallableContext,
  caregiverUid: string,
  reason: unknown,
): Promise<string> {
  return requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SCREENING, {
    recentAuth: true,
    access: {
      action: "childcare_screening_decision",
      objectRef: caregiverUid,
      reason,
    },
  });
}

// ── Input normalization (bounded, allowlisted) ───────────────────────────────

const MAX_LIST = 20;
const MAX_STR = 200;

/** Provider-capability age bands (mirror of the child profile bands, R25). */
export const CHILDCARE_PROVIDER_AGE_BANDS: readonly string[] = [
  "infant", "toddler", "preschool", "school_age", "preteen", "teen",
];

function cleanStringList(raw: unknown, allow?: (v: string) => boolean): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LIST) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > MAX_STR) return null;
    if (allow && !allow(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function cleanCredentials(raw: unknown): ProviderCredential[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LIST) return null;
  const out: ProviderCredential[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.trim() : "";
    if (!type || type.length > MAX_STR) return null;
    const iso = (v: unknown): string | null =>
      typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
    out.push({
      type,
      issuedOn: iso(e.issuedOn),
      expiresOn: iso(e.expiresOn),
      reference: typeof e.reference === "string" ? e.reference.trim().slice(0, MAX_STR) : null,
    });
  }
  return out;
}

// ── upsertChildcareVerticalProfile ───────────────────────────────────────────
//
// New providers: base profile first (existing web/SMS base signup), then this
// childcare delta. Existing providers: ONLY the childcare delta — the response
// names the reused base fields so no surface re-asks them (AE21).

export const upsertChildcareVerticalProfile = childcareOnCall("upsertChildcareVerticalProfile", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("upsertChildcareVerticalProfile", uid, CHILDCARE_PROVIDER_MUTATION_RATE);

  const db = admin.firestore();
  const cgSnap = await db.collection("caregivers").doc(uid).get();
  if (!cgSnap.exists) throw permissionDenied(); // caregiver base account required (same generic error)
  const caregiver = (cgSnap.data() ?? {}) as Record<string, unknown>;

  const jurisdictionState = normalizeStateCode(String(data?.jurisdictionState ?? ""));
  const ageBands = cleanStringList(data?.ageBands, (v) => CHILDCARE_PROVIDER_AGE_BANDS.includes(v));
  // Services: enableable categories ONLY — a deferred category (overnight /
  // medication / infant / specialized) or unknown value fails closed.
  const services = cleanStringList(data?.services, (v) => isEnableableChildcareCategory(v));
  const limitations = cleanStringList(data?.limitations);
  const references = cleanStringList(data?.references);
  const credentials = cleanCredentials(data?.credentials);
  const rawExperience = data?.yearsChildcareExperience;
  const yearsChildcareExperience =
    rawExperience === undefined || rawExperience === null
      ? null
      : Number.isFinite(Number(rawExperience)) && Number(rawExperience) >= 0 && Number(rawExperience) <= 80
        ? Number(rawExperience)
        : undefined;
  const rawRate = data?.hourlyRate;
  const hourlyRate =
    rawRate === undefined || rawRate === null
      ? null
      : Number.isFinite(Number(rawRate)) && Number(rawRate) >= 15 && Number(rawRate) <= 200
        ? Number(rawRate)
        : undefined;
  const offersTransport = data?.offersTransport === true;
  const adultAgeAttested = data?.adultAgeAttested === true;

  if (
    !jurisdictionState ||
    ageBands === null ||
    services === null ||
    limitations === null ||
    references === null ||
    credentials === null ||
    yearsChildcareExperience === undefined ||
    hourlyRate === undefined
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  // Redundant belt to the allowlist above: the deferred-category hard block.
  for (const service of services) assertEnableableChildcareCategory(service);

  const now = new Date();
  const nowIso = now.toISOString();
  const ref = childcareVerticalProfileRef(uid, db);
  const existingSnap = await ref.get();
  const existing = existingSnap.exists
    ? ((existingSnap.data() ?? {}) as Partial<ChildcareVerticalProfileDoc>)
    : null;

  const doc: ChildcareVerticalProfileDoc = {
    careVertical: "child",
    caregiverUid: uid,
    ageBands,
    services,
    yearsChildcareExperience,
    references,
    credentials,
    hourlyRate,
    availabilityOverrides:
      data?.availabilityOverrides && typeof data.availabilityOverrides === "object" && !Array.isArray(data.availabilityOverrides)
        ? (data.availabilityOverrides as Record<string, unknown>)
        : existing?.availabilityOverrides ?? null,
    transport: { offersTransport },
    limitations,
    jurisdictionState,
    adultAgeAttested: adultAgeAttested || existing?.adultAgeAttested === true,
    // Preserved server-owned fields — a profile upsert can never grant itself
    // policy acceptance, approval, or clear a suspension (R27/R28).
    acceptedPolicyVersion: existing?.acceptedPolicyVersion ?? null,
    acceptedPolicyAt: existing?.acceptedPolicyAt ?? null,
    approval: existing?.approval ?? { state: "none", decidedByUid: null, decidedAt: null, auditRef: null },
    suspension: existing?.suspension ?? { active: false, code: null, suspendedByUid: null, suspendedAt: null },
    profileVersion: (existing?.profileVersion ?? 0) + 1,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  await ref.set(doc);
  await recomputeChildcareProviderVisibility(uid, { db, now }).catch(() => {});

  const missing = computeMissingChildcareFields(caregiver, doc);
  await logAudit({
    eventType: "childcare_vertical_profile_upserted",
    userId: uid,
    data: {
      profileVersion: doc.profileVersion,
      missingChildcareFieldCount: missing.missingChildcareFields.length,
    },
  }).catch(() => {});

  return {
    success: true,
    profileVersion: doc.profileVersion,
    // AE21: base fields already on the adult profile are REUSED — callers must
    // only ask for what is listed as missing.
    reusedBaseFields: missing.reusedBaseFields,
    missingBaseFields: missing.missingBaseFields,
    missingChildcareFields: missing.missingChildcareFields,
  };
});

// ── getMyChildcareProviderState ──────────────────────────────────────────────

export const getMyChildcareProviderState = childcareOnCall("getMyChildcareProviderState", async (_data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getMyChildcareProviderState", uid, CHILDCARE_PROVIDER_READ_RATE);

  const db = admin.firestore();
  const cgSnap = await db.collection("caregivers").doc(uid).get();
  if (!cgSnap.exists) throw permissionDenied();
  const caregiver = (cgSnap.data() ?? {}) as Record<string, unknown>;

  const [verticalProfile, screening] = await Promise.all([
    loadChildcareVerticalProfile(uid, db),
    loadChildcareScreening(uid, db),
  ]);
  const state = verticalProfile?.jurisdictionState
    ? normalizeStateCode(verticalProfile.jurisdictionState)
    : null;
  const policy = state ? await loadJurisdictionPolicy(state, db) : null;

  const missing = computeMissingChildcareFields(caregiver, verticalProfile);
  const eligibility = evaluateChildcareProviderEligibility({
    caregiver, verticalProfile, screening, policy,
  });

  // OWN-state view: remediation issue codes are fine for the provider
  // themselves (R30 restricts PUBLIC projections, not self-service status).
  return {
    success: true,
    hasVerticalProfile: !!verticalProfile,
    verticalProfile: verticalProfile
      ? {
          ageBands: verticalProfile.ageBands ?? [],
          services: verticalProfile.services ?? [],
          yearsChildcareExperience: verticalProfile.yearsChildcareExperience ?? null,
          hourlyRate: verticalProfile.hourlyRate ?? null,
          transport: verticalProfile.transport ?? { offersTransport: false },
          limitations: verticalProfile.limitations ?? [],
          jurisdictionState: verticalProfile.jurisdictionState ?? null,
          adultAgeAttested: verticalProfile.adultAgeAttested === true,
          acceptedPolicyVersion: verticalProfile.acceptedPolicyVersion ?? null,
          approvalState: verticalProfile.approval?.state ?? "none",
          suspensionActive: verticalProfile.suspension?.active === true,
          profileVersion: verticalProfile.profileVersion ?? 0,
        }
      : null,
    screening: screening
      ? {
          evidenceStatus: screening.evidenceStatus ?? "none",
          invitationStatus: screening.checkr?.invitationStatus ?? "none",
          expiresAt: screening.expiresAt ?? null,
          adverseActionState: screening.adverseAction?.state ?? "none",
          evidenceVersion: screening.eligibilityVersion ?? 0,
        }
      : null,
    reusedBaseFields: missing.reusedBaseFields,
    missingBaseFields: missing.missingBaseFields,
    missingChildcareFields: missing.missingChildcareFields,
    eligibility: {
      eligible: eligibility.eligible,
      eligibilityVersion: eligibility.eligibilityVersion,
      evidenceVersion: eligibility.evidenceVersion,
      issues: eligibility.issues.map((i) => ({ code: i.code, field: i.field })),
      transportCapable: eligibility.capabilities.transport,
      renewalDue: eligibility.renewal.due,
    },
  };
});

// ── acceptChildcarePolicy ────────────────────────────────────────────────────

export const acceptChildcarePolicy = childcareOnCall("acceptChildcarePolicy", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("acceptChildcarePolicy", uid, CHILDCARE_PROVIDER_MUTATION_RATE);

  const db = admin.firestore();
  const ref = childcareVerticalProfileRef(uid, db);
  const snap = await ref.get();
  if (!snap.exists) throw permissionDenied(); // profile-before-policy; same generic error
  const profile = (snap.data() ?? {}) as Partial<ChildcareVerticalProfileDoc>;

  const state = profile.jurisdictionState ? normalizeStateCode(profile.jurisdictionState) : "";
  const policy = state ? await loadJurisdictionPolicy(state, db) : null;
  const policyVersion = typeof policy?.policyVersion === "string" ? policy.policyVersion.trim() : "";
  if (!policyVersion) {
    // Fail closed: acceptance of a versionless policy is meaningless (R23).
    throw new functions.https.HttpsError(
      "failed-precondition",
      "The childcare policy for your state is not ready to accept yet.",
      { code: "policy_version_unavailable" },
    );
  }

  const nowIso = new Date().toISOString();
  await ref.set(
    { acceptedPolicyVersion: policyVersion, acceptedPolicyAt: nowIso, updatedAt: nowIso },
    { merge: true },
  );

  // Versioned consent receipt (R23) — reuses the U4 receipts module.
  await writeChildcareConsentReceipts({
    adultUid: uid,
    jurisdictionState: state,
    channel: "web",
    source: "childcare_provider_policy_acceptance",
    policyTypes: ["childcarePolicy"],
    db,
  }).catch(() => {});

  await recomputeChildcareProviderVisibility(uid, { db }).catch(() => {});
  await logAudit({
    eventType: "childcare_policy_accepted",
    userId: uid,
    data: { policyVersion, jurisdiction: state },
  }).catch(() => {});

  return { success: true, acceptedPolicyVersion: policyVersion };
});

// ── startChildcareScreening ──────────────────────────────────────────────────
//
// Consent-first (never a pre-consent Checkr call), Checkr candidate reuse per
// the existing checkr.ts patterns, and shared-base-evidence adoption (AE21):
// a caregiver whose current base report already satisfies childcare policy
// gets it ADOPTED as childcare evidence — no duplicate check is run.

export const startChildcareScreening = childcareOnCall("startChildcareScreening", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("startChildcareScreening", uid, CHILDCARE_PROVIDER_MUTATION_RATE);

  if (data?.screeningConsent !== true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Screening consent is required before a background check can start.",
      { code: "consent_required" },
    );
  }

  const db = admin.firestore();
  const now = new Date();
  const cgSnap = await db.collection("caregivers").doc(uid).get();
  if (!cgSnap.exists) throw permissionDenied();
  const caregiver = (cgSnap.data() ?? {}) as Record<string, unknown>;

  const profile = await loadChildcareVerticalProfile(uid, db);
  if (!profile || !profile.jurisdictionState) throw permissionDenied(); // profile-before-screening
  const state = normalizeStateCode(profile.jurisdictionState);
  const policy = await loadJurisdictionPolicy(state, db);

  // Versioned screening-disclosure consent receipt (R23).
  await writeChildcareConsentReceipts({
    adultUid: uid,
    jurisdictionState: state,
    channel: "web",
    source: "childcare_provider_screening_consent",
    policyTypes: ["screeningDisclosure"],
    db,
  }).catch(() => {});

  // Idempotency 1: current usable evidence already exists — return it.
  const existing = await loadChildcareScreening(uid, db);
  if (existing) {
    const evaluation = evaluateScreeningEvidence(existing, policy, { now });
    if (evaluation.current) {
      return { success: true, mode: "already_current", evidenceStatus: existing.evidenceStatus };
    }
    if (existing.evidenceStatus === "pending" && existing.checkr?.invitationStatus === "sent") {
      // An invitation is already out — never mint a racing duplicate.
      return { success: true, mode: "invitation_outstanding", evidenceStatus: "pending" };
    }
  }

  const ref = childcareScreeningRef(uid, db);
  const nowIso = now.toISOString();

  // Evidence reuse (AE21 / amended R26): adopt the caregiver's current clear
  // base report when it is provably the shared base package and in-window.
  const adoption = adoptableBaseEvidence(caregiver, policy, { now });
  if (adoption.adoptable && adoption.completedAt) {
    const bg = (caregiver.backgroundCheckData ?? {}) as Record<string, unknown>;
    const doc = buildScreeningFromBaseEvidence({
      caregiverUid: uid,
      jurisdictionState: state,
      policy,
      now,
      candidateId: adoption.candidateId,
      reportId: typeof bg.checkrReportId === "string" ? bg.checkrReportId : null,
      completedAt: adoption.completedAt,
    });
    if (existing) {
      doc.createdAt = typeof existing.createdAt === "string" ? existing.createdAt : nowIso;
      doc.eligibilityVersion = (existing.eligibilityVersion ?? 0) + 1;
    }
    await ref.set(doc);
    await recomputeChildcareProviderVisibility(uid, { db, now }).catch(() => {});
    await logAudit({
      eventType: "childcare_screening_evidence_adopted",
      userId: uid,
      data: { jurisdiction: state, source: "shared_base_report_adoption" },
    }).catch(() => {});
    return { success: true, mode: "base_evidence_adopted", evidenceStatus: "clear" };
  }

  // Fresh invitation: reuse the existing Checkr candidate (checkr.ts pattern —
  // renewals never create duplicate candidates) and the shared base package.
  const bg = (caregiver.backgroundCheckData ?? {}) as Record<string, unknown>;
  const existingCandidateId =
    typeof bg.checkrCandidateId === "string" && bg.checkrCandidateId ? bg.checkrCandidateId : undefined;
  const email =
    (typeof context.auth?.token?.email === "string" && context.auth.token.email) ||
    (typeof caregiver.email === "string" ? caregiver.email : "");
  const name = typeof caregiver.name === "string" ? caregiver.name.trim() : "";
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(" ");
  if (!existingCandidateId && (!email || !firstName || !lastName)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Your profile needs a full name and email before a screening can start.",
      { code: "base_profile_incomplete" },
    );
  }

  try {
    const { createCheckrInvitation } = await import("../checkrApi");
    const { resolveChildcareCheckrPackage } = await import("./jurisdictionPolicy");
    const invitation = await createCheckrInvitation({
      firstName: firstName || "Caregiver",
      lastName: lastName || "Provider",
      email,
      packageSlug: resolveChildcareCheckrPackage(),
      customId: uid,
      candidateId: existingCandidateId,
      workState: state,
      workCity: typeof caregiver.city === "string" ? caregiver.city : undefined,
    });

    const doc = buildScreeningForInvitation({
      caregiverUid: uid,
      jurisdictionState: state,
      policy,
      now,
      candidateId: invitation.candidateId,
    });
    if (existing) {
      doc.createdAt = typeof existing.createdAt === "string" ? existing.createdAt : nowIso;
      doc.eligibilityVersion = (existing.eligibilityVersion ?? 0) + 1;
    }
    await ref.set(doc);
    await recomputeChildcareProviderVisibility(uid, { db, now }).catch(() => {});
    await logAudit({
      eventType: "childcare_screening_invitation_sent",
      userId: uid,
      data: { jurisdiction: state, candidateReused: !!existingCandidateId },
    }).catch(() => {});

    // The invitation URL is delivered to the caregiver themselves — it is their
    // own apply link, same exposure class as the senior flow's invitationUrl.
    return {
      success: true,
      mode: "invitation_sent",
      evidenceStatus: "pending",
      invitationUrl: invitation.invitationUrl,
    };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("[providerVerticalCallables] startChildcareScreening error:", err instanceof Error ? err.message : err);
    throw new functions.https.HttpsError("internal", "Screening could not be started. Please try again.");
  }
});

// ── approveChildcareProvider (operator seam — U12 replaces the scope gate) ───

export const approveChildcareProvider = childcareOnCall("approveChildcareProvider", async (data, context) => {
  const caregiverUid = String(data?.caregiverUid ?? "").trim();
  const decision = data?.decision === "revoked" ? "revoked" : data?.decision === "approved" ? "approved" : null;
  if (!caregiverUid || caregiverUid.length > 128 || !decision) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireChildcareOperatorScope(
    context,
    caregiverUid,
    data?.reason,
  );
  await requireChildcareFlags("write");
  await enforceRateLimit("approveChildcareProvider", operatorUid, CHILDCARE_PROVIDER_MUTATION_RATE);

  const db = admin.firestore();
  const ref = childcareVerticalProfileRef(caregiverUid, db);
  const snap = await ref.get();
  if (!snap.exists) throw permissionDenied();

  const nowIso = new Date().toISOString();
  const auditRef = `childcare_approval:${caregiverUid}:${nowIso}`;
  await ref.set(
    {
      approval: { state: decision, decidedByUid: operatorUid, decidedAt: nowIso, auditRef },
      updatedAt: nowIso,
    },
    { merge: true },
  );
  const summary = await recomputeChildcareProviderVisibility(caregiverUid, { db }).catch(() => null);

  // R28 audit: the manual decision, the operator, the scope stub, and the
  // eligibility snapshot it produced.
  await logAudit({
    eventType: decision === "approved" ? "childcare_provider_approved" : "childcare_provider_approval_revoked",
    userId: operatorUid,
    data: {
      caregiverId: caregiverUid,
      operatorScope: CHILDCARE_SCREENING_OPERATOR_SCOPE,
      auditRef,
      resultingVisibility: summary?.visible ?? false,
    },
  }).catch(() => {});

  return { success: true, decision, visible: summary?.visible ?? false };
});

// ── suspendChildcareProvider (operator seam — emergency visibility removal) ──

export const suspendChildcareProvider = childcareOnCall("suspendChildcareProvider", async (data, context) => {
  const caregiverUid = String(data?.caregiverUid ?? "").trim();
  const action = data?.action === "lift" ? "lift" : "suspend";
  const code = String(data?.code ?? "operator_suspension").trim().slice(0, 64);
  if (!caregiverUid || caregiverUid.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  const operatorUid = await requireChildcareOperatorScope(
    context,
    caregiverUid,
    data?.reason,
  );
  // Deliberately gated on ENABLED (not writesEnabled): suspension is a safety
  // REMOVAL and must work while ordinary childcare writes are frozen (R31).
  await requireChildcareFlags("read");
  await enforceRateLimit("suspendChildcareProvider", operatorUid, CHILDCARE_PROVIDER_MUTATION_RATE);

  const db = admin.firestore();
  const ref = childcareVerticalProfileRef(caregiverUid, db);
  const snap = await ref.get();
  if (!snap.exists) throw permissionDenied();

  const nowIso = new Date().toISOString();
  await ref.set(
    {
      suspension:
        action === "suspend"
          ? { active: true, code, suspendedByUid: operatorUid, suspendedAt: nowIso }
          : { active: false, code: null, suspendedByUid: null, suspendedAt: null },
      updatedAt: nowIso,
    },
    { merge: true },
  );
  const summary = await recomputeChildcareProviderVisibility(caregiverUid, { db }).catch(() => null);

  await logAudit({
    eventType: action === "suspend" ? "childcare_provider_suspended" : "childcare_provider_suspension_lifted",
    userId: operatorUid,
    data: {
      caregiverId: caregiverUid,
      operatorScope: CHILDCARE_SCREENING_OPERATOR_SCOPE,
      code: action === "suspend" ? code : null,
      resultingVisibility: summary?.visible ?? false,
    },
  }).catch(() => {});

  return { success: true, action, visible: summary?.visible ?? false };
});
