// ── Childcare screening policy (childcare marketplace plan 2026-07-22-002, U5) ──
//
// Evidence evaluation + credential lifecycle for the per-vertical screening
// record `caregivers/{uid}/screenings/{vertical}` (R26 as amended, R27, R31,
// AE10; KTD10).
//
// R26 AS AMENDED (founder decision 2026-07-22): the existing Checkr BASE
// package is SHARED across the senior and childcare verticals. This module
// encodes the shared package as the ONLY childcare-accepted package (via
// jurisdictionPolicy.resolveChildcareCheckrPackage → mvrConfig.basePackage()),
// while everything else stays independent per vertical:
//   • evaluation (exact components, jurisdiction, identity, report age,
//     expiry, policy version),
//   • manual approval (providerEligibility.ts / providerVerticalCallables.ts),
//   • renewal (annual default, jurisdictionPolicy.screeningRenewalMonths),
//   • adverse-action state,
//   • eligibility version.
// "Wrong package" scenarios are POLICY-MISMATCH scenarios: a report from any
// other package (including the bundled criminal+MVR signup package and the
// MVR-only package) is not childcare-accepted evidence.
//
// R27: Checkr states are EVIDENCE, never approval. `clear` here NEVER flips a
// visibility/approval flag — manual operator approval (R28) lives on the
// vertical profile and is combined in providerEligibility.ts. consider /
// dispute / adverse-action keep flowing through the existing human process
// (checkr.ts admin_alerts + checkrBadNewsNotify patterns) — this module only
// RECORDS the evidence state for the childcare vertical.
//
// R24 WALL: nothing in this module writes senior fields. The only Firestore
// writes are to caregivers/{uid}/screenings/child — never verified /
// verificationStatus / status / approvedAt / backgroundCheckStatus /
// backgroundCheckData on the parent doc.
//
// Webhook mapping (KTD10): a childcare screening doc updates ONLY from Checkr
// events matching its stored provider references (candidateId / invitationId /
// reportId / package slug). Doc-level idempotency (appliedEventIds) covers the
// settle("failed")-then-redelivery path that the event-level webhook ledger in
// checkr.ts deliberately re-opens; out-of-order events are handled by a
// report-derived-status precedence rule (an invitation event can never regress
// report-derived evidence).

import * as admin from "firebase-admin";
import {
  resolveChildcareCheckrPackage,
  screeningRenewalMonths,
  SHARED_BASE_CHECKR_PACKAGE_REF,
  type JurisdictionCarePolicy,
  type ReadinessIssue,
} from "./jurisdictionPolicy";

export const CAREGIVER_SCREENINGS_SUBCOLLECTION = "screenings";
export const CHILD_VERTICAL_DOC_ID = "child";

/** Algorithm/policy version stamped on every evaluation result (R26). */
export const CHILDCARE_SCREENING_POLICY_VERSION = "childcare-screening-2026-07-23.1";

/** Renewal warning window (days before expiry) for the renewal-due signal. */
export const SCREENING_RENEWAL_WARNING_DAYS = 30;

/** Bounded doc-level idempotency ledger size. */
export const MAX_APPLIED_EVENT_IDS = 25;

// ── Status vocabulary ────────────────────────────────────────────────────────

export type ChildcareEvidenceStatus =
  | "none"       // no evidence yet
  | "pending"    // invitation out / report in flight
  | "clear"      // report-derived clear (EVIDENCE, not approval — R27)
  | "consider"   // report-derived consider (human process)
  | "suspended"  // Checkr suspended the report
  | "disputed"   // candidate disputed the result
  | "canceled"   // report canceled
  | "expired";   // report older than the renewal window (R31)

export type ChildcareInvitationStatus = "none" | "sent" | "completed" | "expired" | "canceled";

/** FCRA-shaped adverse-action states (hooks for the existing human process). */
export type ChildcareAdverseActionState = "none" | "pre_adverse" | "dispute" | "post_adverse";

/** Evidence statuses that come from a REPORT — invitation events never regress these. */
export const REPORT_DERIVED_STATUSES: readonly ChildcareEvidenceStatus[] = [
  "clear", "consider", "suspended", "disputed", "canceled", "expired",
];

// ── The screening document ───────────────────────────────────────────────────

export interface ChildcareScreeningCheckrRefs {
  candidateId: string | null;
  invitationId: string | null;
  reportId: string | null;
  invitationStatus: ChildcareInvitationStatus;
  /** ISO expiry of the outstanding invitation, when known (Checkr default 7d). */
  invitationExpiresAt?: string | null;
}

export interface ChildcareScreeningDoc {
  careVertical: "child";
  caregiverUid: string;
  /** Resolved shared base package slug at creation time (R26 as amended). */
  packageSlug: string;
  /** Always the shared-base sentinel — pins the founder decision in data. */
  packageRef: typeof SHARED_BASE_CHECKR_PACKAGE_REF;
  /** Two-letter state whose jurisdiction policy governs this screening. */
  jurisdictionState: string;
  /** Components the policy required when this screening was created/adopted. */
  requiredComponents: string[];
  /** Renewal cadence captured at creation (policy override or annual default). */
  renewalMonths: number;
  /** Minimal provider references only — never raw report content (KTD10/R30). */
  checkr: ChildcareScreeningCheckrRefs;
  evidenceStatus: ChildcareEvidenceStatus;
  /** How the current evidence arrived. */
  evidenceSource: "shared_base_report_adoption" | "checkr_webhook" | null;
  /** ISO completion time of the accepted report (drives expiry). */
  reportCompletedAt: string | null;
  /** ISO expiry (= reportCompletedAt + renewalMonths). */
  expiresAt: string | null;
  adverseAction: {
    state: ChildcareAdverseActionState;
    updatedAt: string | null;
  };
  /** Jurisdiction policy version at creation (informational; evaluation always
   *  re-checks against the CURRENT policy). */
  policyVersion: string | null;
  /** Monotonic per-doc evidence version — bumped on every evidence change so
   *  downstream projections/rechecks (R29) can pin what they evaluated. */
  eligibilityVersion: number;
  /** Doc-level idempotency ledger (bounded, most-recent-last). */
  appliedEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Small utilities ──────────────────────────────────────────────────────────

export function addMonthsIso(iso: string, months: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

function isIsoPastOrNow(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}

// ── Evidence evaluation (pure — mirrors jurisdictionPolicy's evaluator) ──────

export interface ScreeningEvaluation {
  /** True ONLY when the issue list is empty — current, policy-matching,
   *  clear, unexpired, adverse-action-free evidence. NOT approval (R27). */
  current: boolean;
  issues: ReadinessIssue[];
  policyVersion: string;
  /** The per-doc evidence version this evaluation looked at (0 = no doc). */
  evidenceVersion: number;
  renewal: ScreeningRenewal;
}

export interface ScreeningRenewal {
  /** ISO expiry the evidence carries (null when no accepted report). */
  expiresAt: string | null;
  /** Inside the warning window (SCREENING_RENEWAL_WARNING_DAYS) or overdue. */
  due: boolean;
  /** Past expiry. */
  overdue: boolean;
}

export function computeScreeningRenewal(
  screening: Partial<ChildcareScreeningDoc> | null | undefined,
  now: Date,
): ScreeningRenewal {
  const expiresAt = typeof screening?.expiresAt === "string" ? screening.expiresAt : null;
  if (!expiresAt) return { expiresAt: null, due: false, overdue: false };
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return { expiresAt, due: false, overdue: false };
  const warnFrom = t - SCREENING_RENEWAL_WARNING_DAYS * 24 * 60 * 60 * 1000;
  return {
    expiresAt,
    due: now.getTime() >= warnFrom,
    overdue: now.getTime() >= t,
  };
}

/**
 * Pure evidence evaluation per amended R26. Defensive: a missing/partial doc
 * produces issues, never a throw — callers get the full remediation list.
 * "Current" means the evidence is usable; it NEVER implies visibility (that
 * needs manual approval + the rest of the R28 gates in providerEligibility).
 */
export function evaluateScreeningEvidence(
  screening: Partial<ChildcareScreeningDoc> | null | undefined,
  policy: Partial<JurisdictionCarePolicy> | null | undefined,
  opts: { now?: Date } = {},
): ScreeningEvaluation {
  const now = opts.now ?? new Date();
  const issues: ReadinessIssue[] = [];
  const add = (code: string, field: string, detail: string) => issues.push({ code, field, detail });
  const renewal = computeScreeningRenewal(screening, now);

  if (!screening) {
    add("screening_absent", "(document)", "No childcare screening record exists for this provider.");
    return {
      current: false,
      issues,
      policyVersion: CHILDCARE_SCREENING_POLICY_VERSION,
      evidenceVersion: 0,
      renewal,
    };
  }

  if (screening.careVertical !== "child") {
    add("vertical_mismatch", "careVertical", "Screening record is not stamped for the child vertical — fail closed.");
  }

  // Package: ONLY the shared base package is childcare-accepted (R26 amended).
  // Anything else — including the bundled criminal+MVR signup package — is a
  // policy mismatch, never silently accepted.
  const acceptedPackage = resolveChildcareCheckrPackage();
  if (screening.packageSlug !== acceptedPackage) {
    add(
      "package_policy_mismatch",
      "packageSlug",
      "Screening package is not the shared base package — policy mismatch (R26 as amended).",
    );
  }

  // Jurisdiction: the screening must be for the policy's state.
  const policyState = typeof policy?.state === "string" ? policy.state : null;
  if (!screening.jurisdictionState) {
    add("jurisdiction_missing", "jurisdictionState", "Screening carries no jurisdiction state.");
  } else if (policyState && screening.jurisdictionState !== policyState) {
    add(
      "jurisdiction_mismatch",
      "jurisdictionState",
      `Screening jurisdiction "${screening.jurisdictionState}" does not match the policy state "${policyState}".`,
    );
  }

  // Components: the CURRENT policy's required components must all be covered
  // by what was recorded at adoption. A policy-version change that adds a
  // component invalidates old evidence here — no separate version staleness
  // rule is needed (the component set IS the evaluated contract).
  const requiredNow = Array.isArray(policy?.screening?.components) ? policy!.screening!.components : [];
  const recorded = new Set(Array.isArray(screening.requiredComponents) ? screening.requiredComponents : []);
  for (const component of requiredNow) {
    if (!recorded.has(component)) {
      add(
        "component_missing",
        "requiredComponents",
        `Required screening component "${component}" is not covered by the recorded evidence — policy mismatch.`,
      );
    }
  }

  // Evidence status — each non-clear state gets its own machine-stable code so
  // remediation stays truthful (AE10: none of these auto-rejects publicly).
  const status = screening.evidenceStatus;
  if (status === "clear") {
    // Report age / expiry evaluated LIVE — a stale doc can never stay current.
    if (!screening.reportCompletedAt) {
      add("report_completed_at_missing", "reportCompletedAt", "Clear evidence has no completion timestamp.");
    } else if (renewal.overdue || isIsoPastOrNow(screening.expiresAt, now)) {
      add("report_expired", "expiresAt", `Screening report expired at ${screening.expiresAt ?? "(unknown)"} — renewal required (R31).`);
    }
  } else if (status === "pending") {
    add("evidence_pending", "evidenceStatus", "Screening is still in progress.");
    // Invitation expiry only matters while evidence is pending.
    if (screening.checkr?.invitationStatus === "expired") {
      add("invitation_expired", "checkr.invitationStatus", "The screening invitation expired — a new invitation is required.");
    } else if (screening.checkr?.invitationStatus === "canceled") {
      add("invitation_canceled", "checkr.invitationStatus", "The screening invitation was canceled — a new invitation is required.");
    } else if (isIsoPastOrNow(screening.checkr?.invitationExpiresAt, now)) {
      add("invitation_expired", "checkr.invitationExpiresAt", "The screening invitation expired — a new invitation is required.");
    }
  } else if (status === "consider") {
    add("evidence_consider", "evidenceStatus", "Screening returned consider — the human review process owns next steps (R27).");
  } else if (status === "suspended") {
    add("evidence_suspended", "evidenceStatus", "Screening is suspended pending more information from the candidate.");
  } else if (status === "disputed") {
    add("evidence_disputed", "evidenceStatus", "Screening result is under dispute — evidence is not current until resolved.");
  } else if (status === "canceled") {
    add("evidence_canceled", "evidenceStatus", "Screening was canceled — a new screening is required.");
  } else if (status === "expired") {
    add("report_expired", "evidenceStatus", "Screening evidence expired — renewal required (R31).");
  } else {
    add("evidence_none", "evidenceStatus", "No screening evidence exists yet.");
  }

  // Adverse action: ANY active adverse state blocks currency, independent of
  // the raw evidence status (R27 — human/legal process owns resolution).
  const adverse = screening.adverseAction?.state;
  if (adverse && adverse !== "none") {
    add(
      "adverse_action_active",
      "adverseAction.state",
      `Adverse-action state "${adverse}" is active — the approved human process owns this record.`,
    );
  }

  return {
    current: issues.length === 0,
    issues,
    policyVersion: CHILDCARE_SCREENING_POLICY_VERSION,
    evidenceVersion: typeof screening.eligibilityVersion === "number" ? screening.eligibilityVersion : 0,
    renewal,
  };
}

// ── Credential lifecycle (R25/R28 — jurisdiction-required credentials) ───────

export interface ProviderCredential {
  type: string;
  issuedOn?: string | null;
  expiresOn?: string | null;
  reference?: string | null;
}

/**
 * Evaluate jurisdiction-required credentials against what the vertical profile
 * carries. Expired or missing credentials are issues; unexpiring credentials
 * (expiresOn null) stay valid. The CA pilot policy currently requires none —
 * this is the lifecycle hook for jurisdictions that do.
 */
export function evaluateCredentialRequirements(
  credentials: ProviderCredential[] | null | undefined,
  policy: Partial<JurisdictionCarePolicy> | null | undefined,
  opts: { now?: Date } = {},
): ReadinessIssue[] {
  const now = opts.now ?? new Date();
  const issues: ReadinessIssue[] = [];
  const required = Array.isArray(policy?.credentialRules?.requiredCredentials)
    ? policy!.credentialRules!.requiredCredentials
    : [];
  const held = Array.isArray(credentials) ? credentials : [];

  for (const type of required) {
    const match = held.find((c) => c && c.type === type);
    if (!match) {
      issues.push({
        code: "credential_missing",
        field: "credentials",
        detail: `Required credential "${type}" is missing.`,
      });
      continue;
    }
    if (typeof match.expiresOn === "string" && match.expiresOn && isIsoPastOrNow(match.expiresOn, now)) {
      issues.push({
        code: "credential_expired",
        field: "credentials",
        detail: `Required credential "${type}" expired at ${match.expiresOn} — renewal required.`,
      });
    }
  }
  return issues;
}

// ── Adverse-action state machine hooks ───────────────────────────────────────

/**
 * Allowed adverse-action transitions, driven by Checkr report events. Invalid
 * transitions return the CURRENT state (never throw — webhook path). Resolution
 * back to "none" happens only through a fresh clear report (handled in the
 * event application below), mirroring the existing human process.
 */
export function nextAdverseActionState(
  current: ChildcareAdverseActionState,
  eventType: string,
): ChildcareAdverseActionState {
  switch (eventType) {
    case "report.pre_adverse_action":
      return current === "none" || current === "dispute" ? "pre_adverse" : current;
    case "report.post_adverse_action":
      return current === "pre_adverse" || current === "none" ? "post_adverse" : current;
    case "report.disputed":
      return "dispute";
    default:
      return current;
  }
}

// ── Doc builders ─────────────────────────────────────────────────────────────

export interface BuildScreeningParams {
  caregiverUid: string;
  jurisdictionState: string;
  policy: Partial<JurisdictionCarePolicy> | null;
  now?: Date;
}

function baseScreeningDoc(params: BuildScreeningParams): ChildcareScreeningDoc {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const policy = params.policy ?? {};
  return {
    careVertical: "child",
    caregiverUid: params.caregiverUid,
    packageSlug: resolveChildcareCheckrPackage(),
    packageRef: SHARED_BASE_CHECKR_PACKAGE_REF,
    jurisdictionState: params.jurisdictionState,
    requiredComponents: Array.isArray(policy.screening?.components) ? [...policy.screening!.components] : [],
    renewalMonths: screeningRenewalMonths(policy),
    checkr: {
      candidateId: null,
      invitationId: null,
      reportId: null,
      invitationStatus: "none",
      invitationExpiresAt: null,
    },
    evidenceStatus: "none",
    evidenceSource: null,
    reportCompletedAt: null,
    expiresAt: null,
    adverseAction: { state: "none", updatedAt: null },
    policyVersion: typeof policy.policyVersion === "string" ? policy.policyVersion : null,
    eligibilityVersion: 1,
    appliedEventIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Whether the caregiver's EXISTING senior-side base report can be adopted as
 * childcare evidence (AE21 — reuse exactly-verified evidence, never re-ask).
 * Adoptable ONLY when it is provably the shared base package: a clear,
 * in-window report NOT run under the bundled criminal+MVR package
 * (backgroundCheckData.mvrIncluded — different slug ⇒ policy mismatch under
 * amended R26; see the founder question in the U5 report).
 */
export function adoptableBaseEvidence(
  caregiverDoc: Record<string, unknown> | null | undefined,
  policy: Partial<JurisdictionCarePolicy> | null | undefined,
  opts: { now?: Date } = {},
): { adoptable: boolean; reason: string; candidateId: string | null; completedAt: string | null } {
  const now = opts.now ?? new Date();
  const bg = (caregiverDoc?.backgroundCheckData ?? {}) as Record<string, unknown>;
  const candidateId = typeof bg.checkrCandidateId === "string" ? bg.checkrCandidateId : null;
  const completedAt = typeof bg.completedAt === "string" ? bg.completedAt : null;

  if (bg.status !== "clear") {
    return { adoptable: false, reason: "base_evidence_not_clear", candidateId, completedAt };
  }
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
    return { adoptable: false, reason: "base_evidence_no_completed_at", candidateId, completedAt: null };
  }
  if (bg.mvrIncluded === true) {
    // Bundled criminal+MVR package ≠ shared base package slug ⇒ policy mismatch.
    return { adoptable: false, reason: "base_evidence_bundled_package_mismatch", candidateId, completedAt };
  }
  const renewalMonths = screeningRenewalMonths(policy ?? {});
  const expiresAt = addMonthsIso(completedAt, renewalMonths);
  if (!expiresAt || isIsoPastOrNow(expiresAt, now)) {
    return { adoptable: false, reason: "base_evidence_expired", candidateId, completedAt };
  }
  return { adoptable: true, reason: "adoptable", candidateId, completedAt };
}

/** Build a screening doc that adopts the caregiver's current base report. */
export function buildScreeningFromBaseEvidence(
  params: BuildScreeningParams & { candidateId: string | null; reportId: string | null; completedAt: string },
): ChildcareScreeningDoc {
  const doc = baseScreeningDoc(params);
  doc.checkr.candidateId = params.candidateId;
  doc.checkr.reportId = params.reportId;
  doc.checkr.invitationStatus = "completed";
  doc.evidenceStatus = "clear";
  doc.evidenceSource = "shared_base_report_adoption";
  doc.reportCompletedAt = params.completedAt;
  doc.expiresAt = addMonthsIso(params.completedAt, doc.renewalMonths);
  return doc;
}

/** Build a screening doc for a freshly minted Checkr invitation. */
export function buildScreeningForInvitation(
  params: BuildScreeningParams & { candidateId: string; invitationExpiresAt?: string | null },
): ChildcareScreeningDoc {
  const doc = baseScreeningDoc(params);
  doc.checkr.candidateId = params.candidateId;
  doc.checkr.invitationStatus = "sent";
  doc.checkr.invitationExpiresAt = params.invitationExpiresAt ?? null;
  doc.evidenceStatus = "pending";
  doc.evidenceSource = "checkr_webhook";
  return doc;
}

// ── Firestore access ─────────────────────────────────────────────────────────

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

export function childcareScreeningRef(
  caregiverUid: string,
  db: FirestoreLike = admin.firestore(),
): FirebaseFirestore.DocumentReference {
  return db
    .collection("caregivers")
    .doc(caregiverUid)
    .collection(CAREGIVER_SCREENINGS_SUBCOLLECTION)
    .doc(CHILD_VERTICAL_DOC_ID) as FirebaseFirestore.DocumentReference;
}

export async function loadChildcareScreening(
  caregiverUid: string,
  db: FirestoreLike = admin.firestore(),
): Promise<Partial<ChildcareScreeningDoc> | null> {
  const snap = await childcareScreeningRef(caregiverUid, db).get();
  if (!snap.exists) return null;
  return (snap.data() ?? {}) as Partial<ChildcareScreeningDoc>;
}

// ── Webhook event application (KTD10 mapping + idempotency) ─────────────────

/**
 * Pure matcher: does this Checkr event reference THIS screening's provider
 * IDs? Report events from any other package (MVR-only, bundled MVR, a senior
 * renewal on a changed slug) never match. Exported for tests.
 */
export function eventMatchesScreening(
  screening: Partial<ChildcareScreeningDoc>,
  type: string,
  payload: Record<string, unknown>,
): boolean {
  const checkr = screening.checkr ?? ({} as ChildcareScreeningCheckrRefs);
  const payloadId = typeof payload.id === "string" ? payload.id : null;
  const payloadCandidate = typeof payload.candidate_id === "string" ? payload.candidate_id : null;
  const payloadPackage = typeof payload.package === "string" ? payload.package : null;

  if (type.startsWith("candidate.")) {
    return !!payloadId && payloadId === checkr.candidateId;
  }
  if (type.startsWith("invitation.")) {
    if (payloadId && payloadId === checkr.invitationId) return true;
    // Adoption path: no invitation id stored yet — require BOTH the candidate
    // and the childcare package to match.
    return (
      !checkr.invitationId &&
      !!payloadCandidate &&
      payloadCandidate === checkr.candidateId &&
      !!payloadPackage &&
      payloadPackage === screening.packageSlug
    );
  }
  if (type.startsWith("report.") || type.startsWith("verification.")) {
    if (payloadId && payloadId === checkr.reportId) return true;
    return (
      !!payloadCandidate &&
      payloadCandidate === checkr.candidateId &&
      !!payloadPackage &&
      payloadPackage === screening.packageSlug
    );
  }
  return false;
}

/** Map a Checkr report payload to an evidence status (assessment-first, as checkr.ts). */
export function mapReportPayloadToEvidenceStatus(
  payload: Record<string, unknown>,
): ChildcareEvidenceStatus {
  if (payload.status === "suspended") return "suspended";
  const effective = (payload.assessment ?? payload.result) as string | undefined;
  if (effective === "clear" || effective === "eligible") return "clear";
  if (effective === "consider" || effective === "review" || effective === "escalated") return "consider";
  return "pending";
}

export interface ApplyCheckrEventResult {
  applied: boolean;
  reason:
    | "applied"
    | "no_screening_doc"
    | "no_provider_ref_match"
    | "duplicate_event"
    | "superseded_by_report_evidence"
    | "no_effect"
    | "error";
}

/**
 * Apply one verified Checkr webhook event to the caregiver's childcare
 * screening doc. NEVER throws (webhook path) and NEVER touches the parent
 * caregiver doc or any senior field. Callers (providerEligibility's mirror
 * seam) recompute derived visibility after an applied event.
 */
export async function applyCheckrEventToChildcareScreening(params: {
  caregiverUid: string;
  eventId: string | null;
  type: string;
  payload: Record<string, unknown>;
  db?: FirestoreLike;
  now?: Date;
}): Promise<ApplyCheckrEventResult> {
  const { caregiverUid, eventId, type, payload } = params;
  const db = params.db ?? admin.firestore();
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();

  try {
    const ref = childcareScreeningRef(caregiverUid, db);
    const snap = await ref.get();
    if (!snap.exists) return { applied: false, reason: "no_screening_doc" };
    const screening = (snap.data() ?? {}) as Partial<ChildcareScreeningDoc>;

    if (!eventMatchesScreening(screening, type, payload)) {
      return { applied: false, reason: "no_provider_ref_match" };
    }

    const appliedIds = Array.isArray(screening.appliedEventIds) ? screening.appliedEventIds : [];
    if (eventId && appliedIds.includes(eventId)) {
      return { applied: false, reason: "duplicate_event" };
    }

    const currentStatus = (screening.evidenceStatus ?? "none") as ChildcareEvidenceStatus;
    const reportDerived = REPORT_DERIVED_STATUSES.includes(currentStatus);
    const payloadId = typeof payload.id === "string" ? payload.id : null;
    const updates: Record<string, unknown> = {};
    let evidenceChanged = false;

    if (type.startsWith("invitation.")) {
      // Out-of-order guard: invitation events update invitation bookkeeping
      // but can never regress report-derived evidence.
      if (payloadId && !screening.checkr?.invitationId) updates["checkr.invitationId"] = payloadId;
      if (type === "invitation.created") {
        updates["checkr.invitationStatus"] = "sent";
        if (typeof payload.expires_at === "string") updates["checkr.invitationExpiresAt"] = payload.expires_at;
      } else if (type === "invitation.completed") {
        updates["checkr.invitationStatus"] = "completed";
      } else if (type === "invitation.expired") {
        updates["checkr.invitationStatus"] = "expired";
        if (!reportDerived) {
          updates["evidenceStatus"] = "pending"; // stays pending; evaluation reports invitation_expired
        }
      } else if (type === "invitation.deleted" || type === "invitation.cancelled") {
        updates["checkr.invitationStatus"] = "canceled";
      }
    } else if (type.startsWith("report.")) {
      // Renewal supersession: a COMPLETED report on the childcare package with
      // a new id replaces the stored report. Non-completed events for an
      // unknown report while current evidence is report-derived are ignored
      // (out-of-order / in-flight renewal must not clobber valid evidence).
      const knownReport = !!payloadId && payloadId === screening.checkr?.reportId;
      const adoptingNewReport =
        !!payloadId && !knownReport && (type === "report.completed" || !screening.checkr?.reportId);
      if (!knownReport && !adoptingNewReport && reportDerived) {
        return { applied: false, reason: "superseded_by_report_evidence" };
      }
      if (payloadId && (adoptingNewReport || !screening.checkr?.reportId)) {
        updates["checkr.reportId"] = payloadId;
      }

      if (type === "report.canceled") {
        updates["evidenceStatus"] = "canceled";
        evidenceChanged = true;
      } else if (type === "report.disputed") {
        updates["evidenceStatus"] = "disputed";
        updates["adverseAction"] = {
          state: nextAdverseActionState(screening.adverseAction?.state ?? "none", type),
          updatedAt: nowIso,
        };
        evidenceChanged = true;
      } else if (type === "report.pre_adverse_action" || type === "report.post_adverse_action") {
        updates["evidenceStatus"] = "consider";
        updates["adverseAction"] = {
          state: nextAdverseActionState(screening.adverseAction?.state ?? "none", type),
          updatedAt: nowIso,
        };
        evidenceChanged = true;
      } else if (type === "report.resumed") {
        updates["evidenceStatus"] = "pending";
        evidenceChanged = true;
      } else if (
        type === "report.created" ||
        type === "report.completed" ||
        type === "report.updated" ||
        type === "report.suspended" ||
        type === "report.engaged" ||
        type === "report.upgraded"
      ) {
        const status = mapReportPayloadToEvidenceStatus(payload);
        updates["evidenceStatus"] = status;
        evidenceChanged = true;
        if (type === "report.completed") {
          updates["reportCompletedAt"] = nowIso;
          const renewalMonths =
            typeof screening.renewalMonths === "number" && screening.renewalMonths > 0
              ? screening.renewalMonths
              : 12;
          updates["expiresAt"] = addMonthsIso(nowIso, renewalMonths);
          updates["evidenceSource"] = "checkr_webhook";
        }
        // A fresh CLEAR report resolves a dispute cycle back to none; it never
        // clears post_adverse (that stands until the human process says so).
        if (status === "clear" && screening.adverseAction?.state === "dispute") {
          updates["adverseAction"] = { state: "none", updatedAt: nowIso };
        }
      } else {
        return { applied: false, reason: "no_effect" };
      }
    } else if (type.startsWith("candidate.") || type.startsWith("verification.")) {
      // Informational only for the childcare mirror — the senior handler owns
      // candidate/verification notifications. Record nothing but idempotency.
      return { applied: false, reason: "no_effect" };
    } else {
      return { applied: false, reason: "no_effect" };
    }

    if (Object.keys(updates).length === 0) {
      return { applied: false, reason: "no_effect" };
    }

    updates["updatedAt"] = nowIso;
    if (evidenceChanged) {
      updates["eligibilityVersion"] =
        (typeof screening.eligibilityVersion === "number" ? screening.eligibilityVersion : 0) + 1;
    }
    if (eventId) {
      updates["appliedEventIds"] = [...appliedIds, eventId].slice(-MAX_APPLIED_EVENT_IDS);
    }

    await ref.update(updates);
    return { applied: true, reason: "applied" };
  } catch (err) {
    console.error(
      "[screeningPolicy] applyCheckrEventToChildcareScreening error (senior path unaffected):",
      err instanceof Error ? err.message : err,
    );
    return { applied: false, reason: "error" };
  }
}
