// ── Childcare jurisdiction policy (childcare marketplace plan 2026-07-22-002, U1) ──
//
// Typed contract + server-side loader/validator for the versioned per-state
// policy record `jurisdiction_care_policies/{STATE}` (R23-R31, R40, R57-R63).
//
// THE RULE IS FAIL-CLOSED. A state is activatable ONLY when
// evaluateJurisdictionReadiness returns zero issues. Anything absent, expired,
// malformed, placeholder-valued, deferred, or version-stale produces a
// structured issue and blocks activation. Founder attestation (2026-07-22)
// that legal/insurance/jurisdiction approvals are complete does NOT populate
// this record — activation waits for the concrete approval references (dates,
// document/counsel/insurer identifiers) to be recorded here.
//
// Ownership boundaries:
//   • This module owns the schema, the readiness evaluation, and the deferred-
//     category hard block. It is read-only against Firestore.
//   • Writing/seeding policy docs is a founder-run migration (U14); nothing in
//     this module writes to production Firestore.
//   • Client mutation denial is Rules work (U2). Until then the collection is
//     server-only by default-deny (no firestore.rules block exists for it).
//   • Runtime on/off switching lives in config/featureFlags.ts
//     (childcare_flags, R61) — this record is the slower-moving approved
//     policy; the flags are the emergency levers.
//
// Human-readable mirror: docs/policies/childcare-jurisdictions.md (schema,
// fail-closed rules, and the founder checklist of approval references).

import * as admin from "firebase-admin";
import { basePackage } from "../mvrConfig";

export const JURISDICTION_CARE_POLICIES_COLLECTION = "jurisdiction_care_policies";

// ── Service categories ───────────────────────────────────────────────────────
//
// Scope Boundaries (plan): overnight care, medication administration, infant
// care, and specialized-needs categories are DEFERRED until each has an
// approved credential/policy package. They are hard-blocked here: a policy
// document listing one is invalid (deferred_category_enabled) and
// assertEnableableChildcareCategory throws. None is enabled by implication.

export const DEFERRED_CHILDCARE_CATEGORIES = [
  "overnight_care",
  "medication_administration",
  "infant_care",
  "specialized_needs_care",
] as const;
export type DeferredChildcareCategory = (typeof DEFERRED_CHILDCARE_CATEGORIES)[number];

/** Categories a jurisdiction policy MAY approve for the pilot release. */
export const ENABLEABLE_CHILDCARE_CATEGORIES = [
  "babysitting",
  "nanny_care",
  "after_school_care",
  "date_night_care",
  "weekend_daytime_care",
] as const;
export type EnableableChildcareCategory = (typeof ENABLEABLE_CHILDCARE_CATEGORIES)[number];

export function isDeferredChildcareCategory(category: string): boolean {
  return (DEFERRED_CHILDCARE_CATEGORIES as readonly string[]).includes(category);
}

export function isEnableableChildcareCategory(category: string): boolean {
  return (ENABLEABLE_CHILDCARE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The deferred-category hard block for later units (job creation, booking
 * adapters, discovery). Throws for deferred AND unknown categories — a
 * category is enableable only by being on the explicit allowlist.
 */
export function assertEnableableChildcareCategory(category: string): void {
  if (isDeferredChildcareCategory(category)) {
    throw new Error(
      `Childcare category "${category}" is DEFERRED (no approved credential/policy package) and cannot be enabled.`,
    );
  }
  if (!isEnableableChildcareCategory(category)) {
    throw new Error(`Unknown childcare category "${category}" — fail closed.`);
  }
}

// ── Screening (R26 as amended, founder decision 2026-07-22) ─────────────────
//
// The existing Checkr BASE package is SHARED across the senior and childcare
// verticals. Policy documents encode that with the sentinel below instead of a
// literal package ID so the accepted package can never drift from
// mvrConfig.basePackage(). Per-vertical evaluation, renewal, and
// adverse-action state remain fully independent (U5 screeningPolicy).

export const SHARED_BASE_CHECKR_PACKAGE_REF = "shared-base-package";

/** Resolve the childcare-accepted Checkr package: the shared base package. */
export function resolveChildcareCheckrPackage(): string {
  return basePackage();
}

/** Childcare screening renewal defaults to ANNUAL unless policy overrides. */
export const DEFAULT_SCREENING_RENEWAL_MONTHS = 12;

export function screeningRenewalMonths(policy: Partial<JurisdictionCarePolicy>): number {
  return policy.screening?.renewalMonths ?? DEFAULT_SCREENING_RENEWAL_MONTHS;
}

// ── Approval references ──────────────────────────────────────────────────────

/**
 * A concrete, verifiable approval record. NEVER a bare boolean — the whole
 * point of U1 is that "approved" is only claimable with an identifier a human
 * can chase down.
 */
export interface ApprovalReference {
  /** Counsel memo/doc ID, insurance certificate number, TrustLine confirmation number, … */
  referenceId: string;
  /** Who issued it: counsel firm, insurer, or agency identifier. */
  issuedBy: string;
  /** ISO date the approval was granted. */
  approvedOn: string;
  /** The policyVersion this approval covers — must equal the policy's current version. */
  policyVersion: string;
  /** ISO date the approval expires, or null when non-expiring. */
  expiresOn?: string | null;
}

export const REQUIRED_APPROVAL_KINDS = [
  "legalCounsel", // counsel sign-off doc reference
  "insurance", // certificate of insurance covering childcare operations
  "jurisdictionScreeningProgram", // state registry confirmation (CA: TrustLine)
] as const;
export type RequiredApprovalKind = (typeof REQUIRED_APPROVAL_KINDS)[number];

// ── Pricing / consent placeholder keys ───────────────────────────────────────

/**
 * R40: pricing fields EXIST but stay unset until founder-approved server
 * configuration lands. Any unpopulated ref blocks activation. Childcare
 * amounts are NEVER derived from senior defaults ($29.95/mo client,
 * $54.99/yr caregiver) — those numbers must not appear here.
 */
export const CHILDCARE_PRICING_REF_KEYS = [
  "familyEntitlementRef",
  "caregiverFeeRef",
  "screeningFeeRef",
  "siblingPolicyRef",
  "cancellationPolicyRef",
  "refundPolicyRef",
] as const;
export type ChildcarePricingRefKey = (typeof CHILDCARE_PRICING_REF_KEYS)[number];

/** R23: versioned consent receipts need versioned source documents. */
export const CHILDCARE_CONSENT_VERSION_KEYS = [
  "terms",
  "privacy",
  "screeningDisclosure",
  "guardianAttestation",
  "communicationConsent",
  "childcarePolicy",
] as const;
export type ChildcareConsentVersionKey = (typeof CHILDCARE_CONSENT_VERSION_KEYS)[number];

// ── The policy document ──────────────────────────────────────────────────────

export type JurisdictionPolicyStatus = "disabled" | "configured";

export interface JurisdictionCarePolicy {
  /** Two-letter state code (doc ID mirror). */
  state: string;
  /** "disabled" is an explicit off switch; "configured" still requires zero readiness issues. */
  status: JurisdictionPolicyStatus;
  /** Version stamp; every approval reference must name this exact version. */
  policyVersion: string;
  /** ISO date the policy takes effect (informational until activation). */
  effectiveOn: string | null;
  /** ISO date the policy expires; expired ⇒ not activatable. */
  expiresOn: string | null;
  /** Policy-level emergency off. The fast runtime lever is childcare_flags. */
  emergencyOff: boolean;
  /** Approved service categories — enableable list only; deferred are hard-blocked. */
  approvedServiceCategories: string[];
  /** Adult-provider floor; must be >= 18. */
  caregiverMinimumAge: number;
  screening: {
    /** SHARED_BASE_CHECKR_PACKAGE_REF (or the literal shared package id). */
    checkrPackageRef: string;
    /** Screening components the shared package must cover for this state. */
    components: string[];
    /** Renewal cadence override; absent ⇒ DEFAULT_SCREENING_RENEWAL_MONTHS. */
    renewalMonths?: number;
  };
  credentialRules: {
    /** Jurisdiction-required provider credentials (may be empty). */
    requiredCredentials: string[];
    /** Credential renewal cadence in months, when the jurisdiction sets one. */
    renewalMonths?: number;
  };
  transport: {
    /** Whether transport bookings may EVER be offered in this state. */
    enabled: boolean;
    /** When transport is enabled, current MVR evidence is mandatory (R25/AE13). */
    requiresMvr: boolean;
  };
  /** Approved guardian-verification process document reference. */
  guardianProcessRef: string | null;
  /** 24/7 incident escalation contacts (operator phone/email identifiers). */
  incidentContacts: string[];
  /** Counsel-recorded mandated-reporting obligations document reference (R58). */
  reportingObligationsRef: string | null;
  /** Certificate-of-insurance / evidence document references. */
  insuranceEvidenceRefs: string[];
  /** Version of docs/policies/childcare-data-retention.md in force (R13). */
  retentionPolicyVersion: string | null;
  /** Versions of the consent/terms documents families and providers accept. */
  consentVersions: Record<ChildcareConsentVersionKey, string | null>;
  /** R40 placeholders — unset pricing blocks activation. */
  pricing: Record<ChildcarePricingRefKey, string | null>;
  /** Concrete approval references; null = not yet populated ⇒ blocked. */
  approvals: Record<RequiredApprovalKind, ApprovalReference | null>;
}

// ── Readiness evaluation ─────────────────────────────────────────────────────

export interface ReadinessIssue {
  /** Machine-stable issue code. */
  code: string;
  /** Dotted field path the issue is about. */
  field: string;
  /** Human-readable remediation detail. */
  detail: string;
}

export interface JurisdictionReadiness {
  state: string;
  policyVersion: string | null;
  /** True ONLY when the issue list is empty. */
  activatable: boolean;
  /** Every missing/expired/incomplete item — the founder work list. */
  issues: ReadinessIssue[];
}

/** Unpopulated = null/undefined/empty/FILL_IN-prefixed (mvrConfig convention). */
function isUnpopulated(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const t = v.trim();
  return t.length === 0 || t.startsWith("FILL_IN");
}

function isPastOrNow(iso: string, now: Date): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Pure readiness evaluation over a (possibly partial/malformed) policy shape.
 * Defensive by design: a missing sub-object is reported as issues, never a
 * throw — the caller gets the complete work list in one pass.
 */
export function evaluatePolicyReadiness(
  policy: Partial<JurisdictionCarePolicy> | null | undefined,
  opts: { now?: Date; expectedState?: string } = {},
): ReadinessIssue[] {
  const now = opts.now ?? new Date();
  const issues: ReadinessIssue[] = [];
  const add = (code: string, field: string, detail: string) => issues.push({ code, field, detail });

  if (!policy) {
    add(
      "policy_absent",
      "(document)",
      `No jurisdiction_care_policies document exists${opts.expectedState ? ` for ${opts.expectedState}` : ""} — unknown states are disabled.`,
    );
    return issues;
  }

  if (opts.expectedState && policy.state !== opts.expectedState) {
    add("state_mismatch", "state", `Document state "${policy.state ?? ""}" does not match requested "${opts.expectedState}".`);
  }

  if (policy.status === "disabled") {
    add("policy_disabled", "status", "Policy is explicitly disabled.");
  } else if (policy.status !== "configured") {
    add("policy_status_invalid", "status", `Unknown status "${String(policy.status)}" — fail closed.`);
  }

  if (isUnpopulated(policy.policyVersion)) {
    add("policy_version_missing", "policyVersion", "Policy has no version stamp.");
  }

  if (typeof policy.expiresOn === "string" && policy.expiresOn && isPastOrNow(policy.expiresOn, now)) {
    add("policy_expired", "expiresOn", `Policy expired at ${policy.expiresOn}.`);
  }

  if (policy.emergencyOff === true) {
    add("emergency_off", "emergencyOff", "Policy-level emergency off is set.");
  }

  // Service categories: enableable allowlist only; deferred are hard-blocked.
  const categories = Array.isArray(policy.approvedServiceCategories) ? policy.approvedServiceCategories : null;
  if (!categories || categories.length === 0) {
    add("no_service_categories", "approvedServiceCategories", "No approved service categories.");
  } else {
    for (const c of categories) {
      if (isDeferredChildcareCategory(c)) {
        add(
          "deferred_category_enabled",
          "approvedServiceCategories",
          `"${c}" is a DEFERRED category (overnight/medication/infant/specialized) and cannot be enabled.`,
        );
      } else if (!isEnableableChildcareCategory(c)) {
        add("unknown_category", "approvedServiceCategories", `"${c}" is not a known enableable category.`);
      }
    }
  }

  if (typeof policy.caregiverMinimumAge !== "number" || policy.caregiverMinimumAge < 18) {
    add("caregiver_minimum_age_invalid", "caregiverMinimumAge", "Caregiver minimum age must be a number >= 18.");
  }

  // Screening: shared base package (founder decision 2026-07-22) + components.
  const screening = policy.screening;
  if (!screening) {
    add("screening_missing", "screening", "No screening configuration.");
  } else {
    const ref = screening.checkrPackageRef;
    if (ref !== SHARED_BASE_CHECKR_PACKAGE_REF && ref !== resolveChildcareCheckrPackage()) {
      add(
        "screening_package_mismatch",
        "screening.checkrPackageRef",
        `Package ref "${String(ref)}" is not the shared base package — policy mismatch (R26 as amended).`,
      );
    }
    if (!Array.isArray(screening.components) || screening.components.length === 0) {
      add("screening_components_missing", "screening.components", "No screening components listed.");
    }
    const renewal = screening.renewalMonths;
    if (renewal !== undefined && (!Number.isInteger(renewal) || renewal < 1)) {
      add("screening_renewal_invalid", "screening.renewalMonths", "Renewal override must be a positive integer number of months.");
    }
  }

  // Transport: enabled requires the MVR evidence requirement (AE13).
  if (policy.transport?.enabled === true && policy.transport?.requiresMvr !== true) {
    add("transport_without_mvr", "transport.requiresMvr", "Transport is enabled but MVR evidence is not required — blocked.");
  }

  if (isUnpopulated(policy.guardianProcessRef)) {
    add("guardian_process_missing", "guardianProcessRef", "No approved guardian-verification process reference.");
  }

  const contacts = Array.isArray(policy.incidentContacts) ? policy.incidentContacts.filter((c) => !isUnpopulated(c)) : [];
  if (contacts.length === 0) {
    add("incident_contacts_missing", "incidentContacts", "No populated 24/7 incident escalation contact.");
  }

  if (isUnpopulated(policy.reportingObligationsRef)) {
    add("reporting_obligations_missing", "reportingObligationsRef", "No counsel-recorded mandated-reporting obligations reference.");
  }

  const insurance = Array.isArray(policy.insuranceEvidenceRefs) ? policy.insuranceEvidenceRefs.filter((r) => !isUnpopulated(r)) : [];
  if (insurance.length === 0) {
    add("insurance_evidence_missing", "insuranceEvidenceRefs", "No populated insurance evidence reference.");
  }

  if (isUnpopulated(policy.retentionPolicyVersion)) {
    add("retention_policy_missing", "retentionPolicyVersion", "No retention policy version (docs/policies/childcare-data-retention.md).");
  }

  for (const key of CHILDCARE_CONSENT_VERSION_KEYS) {
    if (isUnpopulated(policy.consentVersions?.[key])) {
      add("consent_version_missing", `consentVersions.${key}`, `Consent/terms version "${key}" is not set.`);
    }
  }

  for (const key of CHILDCARE_PRICING_REF_KEYS) {
    if (isUnpopulated(policy.pricing?.[key])) {
      add("pricing_unset", `pricing.${key}`, `Pricing reference "${key}" is unset — unset pricing blocks activation (R40).`);
    }
  }

  for (const kind of REQUIRED_APPROVAL_KINDS) {
    const ref = policy.approvals?.[kind] ?? null;
    const field = `approvals.${kind}`;
    if (!ref || isUnpopulated(ref.referenceId) || isUnpopulated(ref.issuedBy) || isUnpopulated(ref.approvedOn)) {
      add(
        "approval_reference_missing",
        field,
        `Approval reference "${kind}" is unpopulated — a concrete identifier, issuer, and date are required.`,
      );
      continue;
    }
    if (!isUnpopulated(policy.policyVersion) && ref.policyVersion !== policy.policyVersion) {
      add(
        "approval_reference_stale_version",
        field,
        `Approval covers policyVersion "${ref.policyVersion}" but the policy is "${policy.policyVersion}" — re-approval required after a version transition.`,
      );
    }
    if (typeof ref.expiresOn === "string" && ref.expiresOn && isPastOrNow(ref.expiresOn, now)) {
      add("approval_reference_expired", field, `Approval reference "${kind}" expired at ${ref.expiresOn}.`);
    }
  }

  return issues;
}

// ── Loader ───────────────────────────────────────────────────────────────────

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

export function normalizeStateCode(state: string): string {
  return state.trim().toUpperCase();
}

/**
 * Read-only load of `jurisdiction_care_policies/{STATE}`. Returns null when
 * the document does not exist (unknown state ⇒ disabled). `db` is injectable
 * for tests, as in data/seniorProfileRepository.ts.
 */
export async function loadJurisdictionPolicy(
  state: string,
  db: FirestoreLike = admin.firestore(),
): Promise<Partial<JurisdictionCarePolicy> | null> {
  const code = normalizeStateCode(state);
  if (!code) return null;
  const snap = await db.collection(JURISDICTION_CARE_POLICIES_COLLECTION).doc(code).get();
  if (!snap.exists) return null;
  return (snap.data() ?? {}) as Partial<JurisdictionCarePolicy>;
}

/**
 * The server-side activation gate: load + evaluate. ANY incomplete item ⇒
 * not activatable. Later units (U4+ enrollment, U6 discovery, U7 booking)
 * call this before any state-scoped childcare capability turns on.
 */
export async function evaluateJurisdictionReadiness(
  state: string,
  opts: { db?: FirestoreLike; now?: Date } = {},
): Promise<JurisdictionReadiness> {
  const code = normalizeStateCode(state);
  const policy = await loadJurisdictionPolicy(code, opts.db ?? admin.firestore());
  const issues = evaluatePolicyReadiness(policy, { now: opts.now, expectedState: code });
  return {
    state: code,
    policyVersion: policy && !isUnpopulated(policy.policyVersion) ? (policy.policyVersion as string) : null,
    activatable: issues.length === 0,
    issues,
  };
}

// ── CA (California / Santa Clara pilot) seed SHAPE ───────────────────────────
//
// Typed constant used by tests and by the future U14 seeding migration. This
// module NEVER writes it to Firestore. Approval-reference, consent, guardian,
// incident, reporting, insurance, and pricing fields are EXPLICITLY
// unpopulated (null / FILL_IN placeholders): the founder attested the external
// approvals exist, but the record fails closed until the concrete identifiers
// are recorded (see docs/policies/childcare-jurisdictions.md for the exact
// checklist — counsel doc ID, insurance certificate ref, TrustLine
// confirmation for CA, consent versions, and the six pricing refs).
export const CA_PILOT_POLICY_SEED: JurisdictionCarePolicy = {
  state: "CA",
  status: "configured",
  policyVersion: "CA-2026-07-22.1",
  effectiveOn: null,
  expiresOn: null,
  emergencyOff: false,
  approvedServiceCategories: ["babysitting", "nanny_care", "after_school_care", "date_night_care"],
  caregiverMinimumAge: 18,
  screening: {
    checkrPackageRef: SHARED_BASE_CHECKR_PACKAGE_REF,
    components: [
      "ssn_trace",
      "national_criminal_search",
      "county_criminal_search",
      "sex_offender_search",
    ],
    renewalMonths: DEFAULT_SCREENING_RENEWAL_MONTHS, // annual default (plan amendment)
  },
  credentialRules: { requiredCredentials: [] }, // Evia is NON-MEDICAL; jurisdiction credentials recorded at counsel review
  transport: { enabled: false, requiresMvr: true }, // transport stays off for the pilot; MVR mandatory if ever enabled
  guardianProcessRef: null, // FILL: approved guardian-verification process doc
  incidentContacts: [], // FILL: 24/7 incident escalation contact(s)
  reportingObligationsRef: null, // FILL: counsel-recorded CA mandated-reporting doc
  insuranceEvidenceRefs: [], // FILL: certificate-of-insurance reference(s)
  retentionPolicyVersion: "childcare-retention-2026-07-22.1", // docs/policies/childcare-data-retention.md v1
  consentVersions: {
    terms: null,
    privacy: null,
    screeningDisclosure: null,
    guardianAttestation: null,
    communicationConsent: null,
    childcarePolicy: null,
  },
  pricing: {
    // R40: NO childcare pricing is invented. These stay null until founder-
    // approved configuration exists; unset pricing keeps activation blocked.
    familyEntitlementRef: null,
    caregiverFeeRef: null,
    screeningFeeRef: null,
    siblingPolicyRef: null,
    cancellationPolicyRef: null,
    refundPolicyRef: null,
  },
  approvals: {
    legalCounsel: null, // FILL: counsel doc/memo ID + firm + date + policyVersion
    insurance: null, // FILL: insurance certificate number + insurer + date (+ expiry)
    jurisdictionScreeningProgram: null, // FILL: CA TrustLine registration confirmation + date
  },
};
