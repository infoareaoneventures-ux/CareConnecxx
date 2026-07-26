// ── Childcare provider eligibility (plan 2026-07-22-002, U5 / R28-R31) ───────
//
// evaluateChildcareProviderEligibility() is THE childcare-visibility gate:
// complete vertical profile AND required credentials AND current screening
// components AND manual approval AND current policy acceptance AND
// jurisdiction eligibility AND no active suspension AND membership/payout
// readiness where required (R28). Structured issue list mirrors
// jurisdictionPolicy's readiness evaluator; zero issues = eligible.
//
// INDEPENDENCE (R24/R31/AE9): nothing here reads or writes senior approval —
// senior bookability stays utils/caregiverEligibility.isCaregiverBookable
// (onboardingStatus + verificationStatus) and is untouched by every childcare
// state change. The ONLY parent-doc field this module writes is the namespaced
// derived summary `childcareProvider` (server-only; firestore.rules blocks
// caregiver self-writes), which feeds the public projection's per-vertical
// visibility labels (R30).
//
// RECHECK SEAM (R29): recheckChildcareProviderEligibility(uid, {context}) is
// what U6-U8 call at discovery, contact, application, interview, booking
// request, acceptance, substitution, check-in, and payout-sensitive
// transitions. Payout-sensitive contexts additionally require payout
// readiness.
//
// EVIDENCE LABELS (R30): public projections receive derived LABELS only —
// never raw reports, candidate PII, internal reasons, or universal safety
// language ("fully vetted", "guaranteed safe" are prohibited copy).

import * as admin from "firebase-admin";
import {
  evaluatePolicyReadiness,
  loadJurisdictionPolicy,
  normalizeStateCode,
  type JurisdictionCarePolicy,
  type ReadinessIssue,
} from "./jurisdictionPolicy";
import {
  evaluateScreeningEvidence,
  evaluateCredentialRequirements,
  loadChildcareScreening,
  childcareScreeningRef,
  computeScreeningRenewal,
  type ChildcareScreeningDoc,
  type ProviderCredential,
  type ScreeningRenewal,
} from "./screeningPolicy";

export const CAREGIVER_VERTICAL_PROFILES_SUBCOLLECTION = "vertical_profiles";
export const CHILD_VERTICAL_PROFILE_DOC_ID = "child";

/** Algorithm version stamped on every eligibility result (the R28 version stamp). */
export const CHILDCARE_PROVIDER_ELIGIBILITY_VERSION = "childcare-provider-eligibility-2026-07-23.1";

/** Namespaced parent-doc derived summary field (server-only; rules-blocked). */
export const CHILDCARE_PROVIDER_SUMMARY_FIELD = "childcareProvider";

// ── The vertical profile document (caregivers/{uid}/vertical_profiles/child) ─

export type ChildcareApprovalState = "none" | "approved" | "revoked";

export interface ChildcareVerticalProfileDoc {
  careVertical: "child";
  caregiverUid: string;
  /** Supported child age bands (R25) — provider capability, never child data. */
  ageBands: string[];
  /** Enableable service categories only (deferred categories hard-blocked). */
  services: string[];
  yearsChildcareExperience: number | null;
  /** Adult references (free text, bounded) — restricted evidence, never public. */
  references: string[];
  /** Jurisdiction-required credentials (screeningPolicy lifecycle). */
  credentials: ProviderCredential[];
  /** Childcare hourly rate — NEVER the senior hourlyRate field (R24). */
  hourlyRate: number | null;
  /** Availability overrides on top of the reused base availability (AE21). */
  availabilityOverrides: Record<string, unknown> | null;
  transport: { offersTransport: boolean };
  limitations: string[];
  jurisdictionState: string;
  /** R25 adult-age evidence: attestation + the Checkr identity gate. */
  adultAgeAttested: boolean;
  /** Current childcare policy acceptance (versioned — R23/R28). */
  acceptedPolicyVersion: string | null;
  acceptedPolicyAt: string | null;
  /** Manual operator decision (R28) — NEVER set by Checkr state (R27). */
  approval: {
    state: ChildcareApprovalState;
    decidedByUid: string | null;
    decidedAt: string | null;
    /** Machine-stable audit reference, never a narrative reason (R30/R57). */
    auditRef: string | null;
  };
  suspension: {
    active: boolean;
    code: string | null;
    suspendedByUid: string | null;
    suspendedAt: string | null;
  };
  profileVersion: number;
  createdAt: string;
  updatedAt: string;
}

// ── Base-profile reuse (AE21) ────────────────────────────────────────────────

/**
 * Adult base fields reused for childcare — an existing caregiver is NEVER
 * re-asked for these (AE21). Read-only reuse: childcare code never writes them.
 */
export const CHILDCARE_REUSED_BASE_FIELDS: readonly string[] = [
  "name", "email", "phone", "city", "state", "zipCode", "photo",
  "availability", "languages",
];

/** Childcare-specific required fields on the vertical profile (R25). */
export const CHILDCARE_PROFILE_REQUIRED_FIELDS: readonly string[] = [
  "ageBands", "services", "yearsChildcareExperience", "hourlyRate", "jurisdictionState",
];

function verticalFieldFilled(profile: Partial<ChildcareVerticalProfileDoc> | null | undefined, field: string): boolean {
  const v = (profile as Record<string, unknown> | null | undefined)?.[field];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export interface MissingChildcareFields {
  /** Base fields the adult profile already has — reused, never re-asked (AE21). */
  reusedBaseFields: string[];
  /** Base fields a NEW provider still owes (existing providers: usually []). */
  missingBaseFields: string[];
  /** Childcare-delta fields still owed on the vertical profile. */
  missingChildcareFields: string[];
}

/**
 * Compute what to ask a provider for: only childcare-delta fields for existing
 * providers, base-then-delta for new ones. Never re-asks a filled base field.
 */
export function computeMissingChildcareFields(
  caregiverDoc: Record<string, unknown> | null | undefined,
  verticalProfile: Partial<ChildcareVerticalProfileDoc> | null | undefined,
): MissingChildcareFields {
  const cg = caregiverDoc ?? {};
  const reusedBaseFields: string[] = [];
  const missingBaseFields: string[] = [];
  for (const field of CHILDCARE_REUSED_BASE_FIELDS) {
    const v = (cg as Record<string, unknown>)[field];
    const filled =
      v !== undefined && v !== null &&
      (typeof v !== "string" || v.trim().length > 0) &&
      (!Array.isArray(v) || v.length > 0);
    (filled ? reusedBaseFields : missingBaseFields).push(field);
  }
  const missingChildcareFields = CHILDCARE_PROFILE_REQUIRED_FIELDS.filter(
    (f) => !verticalFieldFilled(verticalProfile, f),
  );
  if (verticalProfile?.adultAgeAttested !== true) missingChildcareFields.push("adultAgeAttested");
  return { reusedBaseFields, missingBaseFields, missingChildcareFields };
}

// ── Eligibility evaluation (pure) ────────────────────────────────────────────

/** R29 recheck contexts. Payout-sensitive contexts require payout readiness.
 *  U7 adds "safety_read" (gated booking-safety/file reads by the assigned
 *  caregiver — eligibility-sensitive but not payout-sensitive). */
export type EligibilityRecheckContext =
  | "discovery"
  | "contact"
  | "application"
  | "interview"
  | "booking_request"
  | "acceptance"
  | "substitution"
  | "check_in"
  | "safety_read"
  | "payout";

const PAYOUT_SENSITIVE_CONTEXTS: ReadonlySet<EligibilityRecheckContext> = new Set([
  "acceptance", "substitution", "check_in", "payout",
]);

export interface ChildcareEligibilityInput {
  /** Parent caregiver doc (base account state + membership/payout mirrors). */
  caregiver: Record<string, unknown> | null | undefined;
  verticalProfile: Partial<ChildcareVerticalProfileDoc> | null | undefined;
  screening: Partial<ChildcareScreeningDoc> | null | undefined;
  policy: Partial<JurisdictionCarePolicy> | null | undefined;
  now?: Date;
  requirements?: {
    /** Caregiver membership required for visibility (default true). */
    membership?: boolean;
    /** Payout readiness required (default false; payout-sensitive rechecks pass true). */
    payoutReadiness?: boolean;
  };
}

export interface ChildcareEligibilityResult {
  eligible: boolean;
  issues: ReadinessIssue[];
  /** Algorithm version (R28 eligibility version stamp)... */
  eligibilityVersion: string;
  /** ...plus the per-doc evidence version the evaluation pinned. */
  evidenceVersion: number;
  /** Derived per-vertical capability — transport never blocks base eligibility (AE13). */
  capabilities: { transport: boolean };
  /** R30 public evidence LABELS — safe derived slugs only, no raw evidence,
   *  no internal reasons, no universal safety language. */
  evidenceLabels: string[];
  renewal: ScreeningRenewal;
}

function membershipActive(cg: Record<string, unknown>): boolean {
  return cg.membershipPaid === true || cg.membershipStatus === "active" || cg.subscriptionActive === true;
}

function payoutReady(cg: Record<string, unknown>): boolean {
  return typeof cg.stripeAccountId === "string" && cg.stripeAccountId.length > 0 && cg.payoutsEnabled === true;
}

/**
 * The R28 gate. Pure over already-loaded documents; zero issues = eligible.
 * Every issue carries a machine-stable code — remediation for the provider's
 * OWN view, never surfaced in public projections (R30).
 */
export function evaluateChildcareProviderEligibility(
  input: ChildcareEligibilityInput,
): ChildcareEligibilityResult {
  const now = input.now ?? new Date();
  const issues: ReadinessIssue[] = [];
  const add = (code: string, field: string, detail: string) => issues.push({ code, field, detail });
  const cg = (input.caregiver ?? {}) as Record<string, unknown>;
  const profile = input.verticalProfile;
  const policy = input.policy ?? null;
  const requirements = { membership: true, payoutReadiness: false, ...(input.requirements ?? {}) };

  // 1. Jurisdiction eligibility: the state's policy must be activatable (U1
  //    fail-closed evaluator — absent/expired/deferred/unapproved all block).
  const policyIssues = evaluatePolicyReadiness(policy, {
    now,
    expectedState: profile?.jurisdictionState ? normalizeStateCode(profile.jurisdictionState) : undefined,
  });
  if (policyIssues.length > 0) {
    add("jurisdiction_not_ready", "jurisdictionState",
      `Jurisdiction policy is not activatable (${policyIssues.length} readiness issue(s)).`);
  }

  // 2. Complete vertical profile (base fields reused, never re-checked here —
  //    AE21; missing BASE fields block completeness for new providers).
  if (!profile) {
    add("vertical_profile_missing", "(vertical_profile)", "No childcare vertical profile exists.");
  } else {
    const missing = computeMissingChildcareFields(cg, profile);
    for (const f of missing.missingChildcareFields) {
      add("profile_incomplete", f, `Childcare profile field "${f}" is missing.`);
    }
    for (const f of missing.missingBaseFields) {
      // Base identity/contact/photo gaps block childcare completeness too —
      // but they are collected ONCE on the base profile, never duplicated.
      if (f === "name" || f === "email" || f === "city" || f === "state") {
        add("base_profile_incomplete", f, `Base profile field "${f}" is missing.`);
      }
    }
  }

  // 3. Required credentials current (jurisdiction-driven lifecycle).
  issues.push(...evaluateCredentialRequirements(profile?.credentials ?? null, policy, { now }));

  // 4. Current screening components (amended R26 — evidence, never approval).
  const screeningEval = evaluateScreeningEvidence(input.screening, policy, { now });
  issues.push(...screeningEval.issues);

  // 5. Manual approval (R28) — an operator decision, never Checkr state (R27).
  const approvalState = profile?.approval?.state ?? "none";
  if (approvalState !== "approved") {
    add(
      approvalState === "revoked" ? "manual_approval_revoked" : "manual_approval_missing",
      "approval.state",
      approvalState === "revoked"
        ? "Childcare approval was revoked by an operator."
        : "Manual operator approval has not been granted.",
    );
  }

  // 6. Current policy acceptance (a policy-version change invalidates it).
  const currentPolicyVersion = typeof policy?.policyVersion === "string" ? policy.policyVersion : null;
  if (!profile?.acceptedPolicyVersion) {
    add("policy_acceptance_missing", "acceptedPolicyVersion", "The childcare policy has not been accepted.");
  } else if (currentPolicyVersion && profile.acceptedPolicyVersion !== currentPolicyVersion) {
    add(
      "policy_acceptance_stale",
      "acceptedPolicyVersion",
      `Accepted policy version "${profile.acceptedPolicyVersion}" is not the current "${currentPolicyVersion}" — re-acceptance required.`,
    );
  }

  // 7. No active suspension — childcare suspension AND base account pause both
  //    remove childcare visibility (neither touches senior eligibility here).
  if (profile?.suspension?.active === true) {
    add("suspension_active", "suspension", "Childcare visibility is suspended by an operator.");
  }
  if (cg.status === "paused") {
    add("base_account_paused", "status", "The caregiver account is paused.");
  }

  // 8. Membership / payout readiness where required (R28).
  if (requirements.membership && !membershipActive(cg)) {
    add("membership_inactive", "membershipStatus", "An active caregiver membership is required.");
  }
  if (requirements.payoutReadiness && !payoutReady(cg)) {
    add("payout_not_ready", "payoutsEnabled", "Payout readiness (Stripe Connect) is required for this transition.");
  }

  // Transport capability (AE13): derived, never blocking. Offering transport
  // without current MVR evidence (or in a transport-disabled jurisdiction)
  // just means the transport capability is withheld.
  const offersTransport = profile?.transport?.offersTransport === true;
  const transportPolicyEnabled = policy?.transport?.enabled === true;
  const mvrCurrent = cg.isApprovedDriver === true && cg.mvrStatus === "clear";
  const transport =
    offersTransport && transportPolicyEnabled && (policy?.transport?.requiresMvr === true ? mvrCurrent : true);

  const eligible = issues.length === 0;

  // R30 labels: derived, safe, non-narrative. Emitted only when the underlying
  // gate holds; the projection additionally publishes them only when visible.
  const evidenceLabels: string[] = [];
  if (screeningEval.current) evidenceLabels.push("background_check_current");
  if (approvalState === "approved") evidenceLabels.push("childcare_reviewed");
  if (profile?.acceptedPolicyVersion && (!currentPolicyVersion || profile.acceptedPolicyVersion === currentPolicyVersion)) {
    evidenceLabels.push("childcare_policy_accepted");
  }
  if (transport) evidenceLabels.push("transport_capable");

  return {
    eligible,
    issues,
    eligibilityVersion: CHILDCARE_PROVIDER_ELIGIBILITY_VERSION,
    evidenceVersion: screeningEval.evidenceVersion,
    capabilities: { transport },
    evidenceLabels,
    renewal: screeningEval.renewal,
  };
}

// ── Firestore access + derived visibility ────────────────────────────────────

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

export function childcareVerticalProfileRef(
  caregiverUid: string,
  db: FirestoreLike = admin.firestore(),
): FirebaseFirestore.DocumentReference {
  return db
    .collection("caregivers")
    .doc(caregiverUid)
    .collection(CAREGIVER_VERTICAL_PROFILES_SUBCOLLECTION)
    .doc(CHILD_VERTICAL_PROFILE_DOC_ID) as FirebaseFirestore.DocumentReference;
}

export async function loadChildcareVerticalProfile(
  caregiverUid: string,
  db: FirestoreLike = admin.firestore(),
): Promise<Partial<ChildcareVerticalProfileDoc> | null> {
  const snap = await childcareVerticalProfileRef(caregiverUid, db).get();
  if (!snap.exists) return null;
  return (snap.data() ?? {}) as Partial<ChildcareVerticalProfileDoc>;
}

async function loadEligibilityInputs(
  caregiverUid: string,
  db: FirestoreLike,
): Promise<{
  caregiver: Record<string, unknown> | null;
  verticalProfile: Partial<ChildcareVerticalProfileDoc> | null;
  screening: Partial<ChildcareScreeningDoc> | null;
  policy: Partial<JurisdictionCarePolicy> | null;
}> {
  const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
  const caregiver = cgSnap.exists ? ((cgSnap.data() ?? {}) as Record<string, unknown>) : null;
  const [verticalProfile, screening] = await Promise.all([
    loadChildcareVerticalProfile(caregiverUid, db),
    loadChildcareScreening(caregiverUid, db),
  ]);
  const state = verticalProfile?.jurisdictionState
    ? normalizeStateCode(verticalProfile.jurisdictionState)
    : null;
  const policy = state ? await loadJurisdictionPolicy(state, db) : null;
  return { caregiver, verticalProfile, screening, policy };
}

/**
 * THE recheck seam (R29) for U6-U8: load live documents and evaluate. Fails
 * closed — a missing caregiver, profile, screening, or policy yields an
 * ineligible result with issues, never a throw.
 */
export async function recheckChildcareProviderEligibility(
  caregiverUid: string,
  opts: { context: EligibilityRecheckContext; db?: FirestoreLike; now?: Date },
): Promise<ChildcareEligibilityResult> {
  const db = opts.db ?? admin.firestore();
  try {
    const inputs = await loadEligibilityInputs(caregiverUid, db);
    return evaluateChildcareProviderEligibility({
      ...inputs,
      now: opts.now,
      requirements: {
        membership: true,
        payoutReadiness: PAYOUT_SENSITIVE_CONTEXTS.has(opts.context),
      },
    });
  } catch (err) {
    console.error("[providerEligibility] recheck failed (fail closed):", err instanceof Error ? err.message : err);
    return {
      eligible: false,
      issues: [{ code: "recheck_error", field: "(recheck)", detail: "Eligibility recheck failed — fail closed." }],
      eligibilityVersion: CHILDCARE_PROVIDER_ELIGIBILITY_VERSION,
      evidenceVersion: 0,
      capabilities: { transport: false },
      evidenceLabels: [],
      renewal: { expiresAt: null, due: false, overdue: false },
    };
  }
}

/** Shape of the namespaced parent-doc derived summary (server-only field). */
export interface ChildcareProviderSummary {
  visible: boolean;
  evidenceLabels: string[];
  eligibilityVersion: string;
  evidenceVersion: number;
  evidenceStatus: string;
  approvalState: ChildcareApprovalState;
  screeningExpiresAt: string | null;
  transportCapable: boolean;
  evaluatedAt: string;
}

/**
 * Recompute + persist the derived childcare summary on the PARENT caregiver
 * doc (the only parent field childcare code writes — R24). Merge-only; never
 * touches senior fields. The caregivers onWrite projection trigger then
 * refreshes publicCaregiverProfiles with the derived per-vertical visibility.
 *
 * Returns the summary, or null when there is nothing to project (no vertical
 * profile AND no existing summary — a senior-only caregiver's doc stays
 * byte-identical, which is what the AE9 projection parity test pins).
 */
export async function recomputeChildcareProviderVisibility(
  caregiverUid: string,
  opts: { db?: FirestoreLike; now?: Date } = {},
): Promise<ChildcareProviderSummary | null> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const inputs = await loadEligibilityInputs(caregiverUid, db);
  if (!inputs.caregiver) return null;

  const hasExistingSummary =
    (inputs.caregiver as Record<string, unknown>)[CHILDCARE_PROVIDER_SUMMARY_FIELD] !== undefined;
  if (!inputs.verticalProfile && !inputs.screening && !hasExistingSummary) {
    // Senior-only caregiver: write NOTHING (AE9 byte-identical projection).
    return null;
  }

  const result = evaluateChildcareProviderEligibility({ ...inputs, now });
  const summary: ChildcareProviderSummary = {
    visible: result.eligible,
    evidenceLabels: result.evidenceLabels,
    eligibilityVersion: result.eligibilityVersion,
    evidenceVersion: result.evidenceVersion,
    evidenceStatus: String(inputs.screening?.evidenceStatus ?? "none"),
    approvalState: inputs.verticalProfile?.approval?.state ?? "none",
    screeningExpiresAt: result.renewal.expiresAt,
    transportCapable: result.capabilities.transport,
    evaluatedAt: now.toISOString(),
  };

  await db
    .collection("caregivers")
    .doc(caregiverUid)
    .set({ [CHILDCARE_PROVIDER_SUMMARY_FIELD]: summary }, { merge: true });
  return summary;
}

// ── Checkr webhook mirror seam (called from checkr.ts — additive, guarded) ───

/**
 * The single seam checkr.ts calls after its (unchanged) senior handling:
 * apply the event to the childcare screening doc (provider-ID matched,
 * doc-level idempotent) and, when evidence changed, recompute derived
 * visibility. NEVER throws; a childcare failure can never break the senior
 * webhook path.
 */
export async function mirrorCheckrEventToChildcareScreening(params: {
  caregiverUid: string;
  eventId: string | null;
  type: string;
  payload: Record<string, unknown>;
  db?: FirestoreLike;
  now?: Date;
}): Promise<void> {
  try {
    const { applyCheckrEventToChildcareScreening } = await import("./screeningPolicy");
    const result = await applyCheckrEventToChildcareScreening(params);
    if (result.applied) {
      await recomputeChildcareProviderVisibility(params.caregiverUid, {
        db: params.db,
        now: params.now,
      }).catch((err) =>
        console.error("[providerEligibility] visibility recompute after webhook failed:", err instanceof Error ? err.message : err),
      );
    }
  } catch (err) {
    console.error(
      "[providerEligibility] childcare webhook mirror error (senior path unaffected):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Scheduled expiry sweep (called from scheduled/backgroundCheckExpiry.ts) ──

export interface ChildcareExpirySweepResult {
  skipped: boolean;
  scanned: number;
  expired: number;
  renewalNotices: number;
}

/**
 * Guarded childcare screening expiry sweep (R31/AE9): expires stale childcare
 * evidence and removes childcare visibility WITHOUT touching any senior field.
 * Gated on the Firestore-resident childcare flags — and safe when skipped,
 * because evaluateScreeningEvidence computes report age LIVE, so a stale doc
 * can never grant eligibility even if this sweep never runs.
 *
 * Renewal notices use the existing notification patterns: a users/{uid}
 * notification row + an admin_alerts row; proactive SMS is deferred to the
 * classified childcare proactive sources (U10) and NOT sent here.
 */
export async function runChildcareScreeningExpirySweep(
  opts: { db?: FirestoreLike; now?: Date } = {},
): Promise<ChildcareExpirySweepResult> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result: ChildcareExpirySweepResult = { skipped: false, scanned: 0, expired: 0, renewalNotices: 0 };

  const { getChildcareFlags } = await import("../config/featureFlags");
  const flags = await getChildcareFlags({ db }).catch(() => null);
  if (!flags?.enabled) {
    result.skipped = true;
    return result;
  }

  // Equality-only parent-doc query (no composite index needed — mirrors the
  // senior sweep's shape); expiry itself is checked in memory.
  const snap = await db
    .collection("caregivers")
    .where(`${CHILDCARE_PROVIDER_SUMMARY_FIELD}.evidenceStatus`, "==", "clear")
    .get();

  for (const cgDoc of snap.docs) {
    result.scanned++;
    const caregiverUid = cgDoc.id;
    try {
      const screeningSnap = await childcareScreeningRef(caregiverUid, db).get();
      if (!screeningSnap.exists) continue;
      const screening = (screeningSnap.data() ?? {}) as Partial<ChildcareScreeningDoc>;
      if (screening.evidenceStatus !== "clear") continue;
      const renewal = computeScreeningRenewal(screening, now);

      if (renewal.overdue) {
        await childcareScreeningRef(caregiverUid, db).update({
          evidenceStatus: "expired",
          eligibilityVersion:
            (typeof screening.eligibilityVersion === "number" ? screening.eligibilityVersion : 0) + 1,
          updatedAt: nowIso,
        });
        await recomputeChildcareProviderVisibility(caregiverUid, { db, now });
        await db.collection("admin_alerts").add({
          type: "childcare_screening_expired",
          caregiverId: caregiverUid,
          expiresAt: renewal.expiresAt,
          createdAt: nowIso,
          resolved: false,
          priority: "high",
        });
        await db.collection("users").doc(caregiverUid).collection("notifications").add({
          title: "Childcare screening expired",
          body: "Your childcare background screening has expired, so your childcare profile is no longer visible to families. Renew it to restore visibility. Your senior-care status is unaffected.",
          type: "system",
          isRead: false,
          createdAt: nowIso,
        });
        result.expired++;
      } else if (renewal.due) {
        // 30-day renewal window: one notice per window (cooldown on the summary).
        const summary = ((cgDoc.data() ?? {}) as Record<string, unknown>)[CHILDCARE_PROVIDER_SUMMARY_FIELD] as
          | Record<string, unknown>
          | undefined;
        const lastNotice = typeof summary?.renewalNoticeSentAt === "string" ? summary.renewalNoticeSentAt : null;
        const cooldownIso = new Date(now.getTime() - SCREENING_RENEWAL_NOTICE_COOLDOWN_MS).toISOString();
        if (lastNotice && lastNotice > cooldownIso) continue;
        await db.collection("users").doc(caregiverUid).collection("notifications").add({
          title: "Childcare screening renewal due soon",
          body: "Your childcare background screening expires within 30 days. Renew it to keep your childcare profile visible to families.",
          type: "system",
          isRead: false,
          createdAt: nowIso,
        });
        await db
          .collection("caregivers")
          .doc(caregiverUid)
          .set(
            { [CHILDCARE_PROVIDER_SUMMARY_FIELD]: { renewalNoticeSentAt: nowIso } },
            { merge: true },
          );
        result.renewalNotices++;
      }
    } catch (err) {
      console.error(`[providerEligibility] expiry sweep error for ${caregiverUid} (continuing):`, err instanceof Error ? err.message : err);
    }
  }

  return result;
}

/** Renewal-notice cooldown: one notice per 30 days. */
export const SCREENING_RENEWAL_NOTICE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
