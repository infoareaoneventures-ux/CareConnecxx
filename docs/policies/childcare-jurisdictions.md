# Childcare Jurisdiction Policy (`jurisdiction_care_policies/{state}`)

Plan: `docs/plans/2026-07-22-002-feat-childcare-marketplace-consolidated-implementation-plan.md` (U1; R23–R31, R40, R57–R63).
Code authority: `functions/src/childcare/jurisdictionPolicy.ts` (typed contract, loader, `evaluateJurisdictionReadiness`).
Runtime switches: `childcare_flags` — see `functions/src/config/featureFlags.ts` (R61).

## The fail-closed rule

A state is **activatable only when `evaluateJurisdictionReadiness(state)` returns zero issues.** There is no partial credit and no attestation shortcut:

- **Unknown state** (no `jurisdiction_care_policies/{STATE}` doc) → disabled (`policy_absent`).
- **`status: "disabled"`** or an unrecognized status → disabled.
- **Expired policy** (`expiresOn` in the past) → disabled.
- **Any unpopulated field** — `null`, empty string, or a `FILL_IN`-prefixed placeholder (the `mvrConfig` convention) — produces a structured issue naming the exact field.
- **Policy version transition:** every approval reference records the `policyVersion` it covers. Bumping `policyVersion` invalidates every approval (`approval_reference_stale_version`) until each is re-recorded — re-approval is a fact, not an assumption.
- **Emergency-off:** `emergencyOff: true` on the policy blocks activation; the *fast* runtime lever is `childcare_flags/{global,STATE}.emergencyOff`, which force-falses all childcare flags within the 60s cache TTL with **no redeploy**.
- **Founder attestation (2026-07-22) does not populate the record.** Legal/insurance/jurisdiction approvals were attested complete, but the policy stays blocked until the concrete references (dates, document/counsel/insurer identifiers) are written into `approvals` and the evidence fields below.

Client writes: `jurisdiction_care_policies` and `childcare_flags` are server-only. No firestore.rules block exists yet, so the rules catch-all default-denies browser access; **U2 owns the explicit Rules deny + emulator tests** (`tests/firestoreRules.childcare.test.ts`).

## Deferred-category hard block

Per the plan's Scope Boundaries, these categories are **DEFERRED** until each has an approved credential/policy package, and are hard-blocked in code (a policy listing one is invalid — `deferred_category_enabled` — and `assertEnableableChildcareCategory` throws):

| Deferred category | Constant |
|---|---|
| Overnight care | `overnight_care` |
| Medication administration | `medication_administration` |
| Infant care | `infant_care` |
| Specialized-needs care | `specialized_needs_care` |

Enableable categories are an **allowlist** (`ENABLEABLE_CHILDCARE_CATEGORIES`): `babysitting`, `nanny_care`, `after_school_care`, `date_night_care`, `weekend_daytime_care`. Unknown category strings fail closed (`unknown_category`) — a category is never enabled by implication.

## Document schema (summary)

One doc per state, keyed by the two-letter code (e.g. `jurisdiction_care_policies/CA`). Full types in `jurisdictionPolicy.ts`.

| Field | Meaning / rule |
|---|---|
| `state`, `status`, `policyVersion` | Status is `disabled` \| `configured`. Every approval must name the current `policyVersion`. |
| `effectiveOn`, `expiresOn` | Expired ⇒ blocked. |
| `emergencyOff` | Policy-level off switch (runtime lever is `childcare_flags`). |
| `approvedServiceCategories` | Enableable allowlist only; deferred hard-blocked. |
| `caregiverMinimumAge` | Must be ≥ 18. |
| `screening.checkrPackageRef` | **Founder decision 2026-07-22 (R26 as amended): the existing Checkr base package is SHARED across senior and childcare.** Encoded as the sentinel `shared-base-package` (or the literal shared package id); anything else is `screening_package_mismatch`. Per-vertical evaluation/renewal/adverse-action stay independent (U5 `screeningPolicy.ts`). |
| `screening.components`, `screening.renewalMonths` | Components required for the state; renewal defaults to **annual (12 months)** unless the policy overrides. |
| `credentialRules` | Jurisdiction-required provider credentials + renewal cadence. Evia is non-medical; no medical credential implies a medical service. |
| `transport` | If `enabled`, `requiresMvr` must be `true` (`transport_without_mvr` otherwise). CA pilot ships with transport **off**. |
| `guardianProcessRef` | Approved guardian-verification process document. |
| `incidentContacts` | ≥ 1 populated 24/7 escalation contact. |
| `reportingObligationsRef` | Counsel-recorded mandated-reporting obligations document. |
| `insuranceEvidenceRefs` | ≥ 1 certificate-of-insurance reference. |
| `retentionPolicyVersion` | Version of `docs/policies/childcare-data-retention.md` in force. |
| `consentVersions` (×6) | `terms`, `privacy`, `screeningDisclosure`, `guardianAttestation`, `communicationConsent`, `childcarePolicy` — versioned consent documents (receipts are versioned per R23, never mutable booleans). |
| `pricing` (×6 refs) | `familyEntitlementRef`, `caregiverFeeRef`, `screeningFeeRef`, `siblingPolicyRef`, `cancellationPolicyRef`, `refundPolicyRef`. **R40: fields exist but stay unset until approved server configuration lands; unset pricing keeps activation blocked. NEVER derived from senior pricing ($29.95/mo client, $54.99/yr caregiver).** |
| `approvals` (×3) | Concrete `ApprovalReference` records — see checklist below. |

## Founder checklist — approval references required to make CA activatable

The CA pilot seed (`CA_PILOT_POLICY_SEED`, policyVersion `CA-2026-07-22.1`) is structurally complete but deliberately **not activatable**. `evaluateJurisdictionReadiness("CA")` on the seed lists exactly these open items — populate each and the state activates; miss one and it stays blocked:

1. **`approvals.legalCounsel`** — counsel sign-off: memo/document ID, counsel firm identifier, approval date, and `policyVersion: "CA-2026-07-22.1"`.
2. **`approvals.insurance`** — certificate of insurance covering childcare operations: certificate/policy number, insurer identifier, approval date, expiry date.
3. **`approvals.jurisdictionScreeningProgram`** — **CA TrustLine registration confirmation**: confirmation number, issuing agency, confirmation date.
4. **`insuranceEvidenceRefs`** — at least one certificate-of-insurance document reference (may repeat the certificate number from #2).
5. **`guardianProcessRef`** — the approved guardian-verification process document reference.
6. **`incidentContacts`** — at least one 24/7 incident escalation contact (operator phone/email identifier).
7. **`reportingObligationsRef`** — counsel-recorded CA mandated-reporting obligations document reference.
8. **`consentVersions` (all six)** — versions of the childcare terms, privacy, screening disclosure, guardian attestation, communication consent, and childcare policy documents. Public copy ships with U11; versions are recorded here when that copy is approved.
9. **`pricing` (all six refs)** — approved Stripe price IDs / policy document IDs for family entitlement, caregiver fee, screening fee, sibling policy, cancellation policy, refund policy. **No amount may be invented or derived from senior pricing.**

Each `ApprovalReference` requires: `referenceId`, `issuedBy`, `approvedOn`, `policyVersion` (must equal the policy's current version), optional `expiresOn`.

Seeding is a founder-run U14 migration; nothing in U1 writes to production Firestore.

## Relationship to runtime flags

Readiness (`jurisdiction_care_policies`) and runtime flags (`childcare_flags`) are **independent AND gates**: a state serves childcare only when its policy is activatable *and* the global + state flags are on *and* no emergency-off is set anywhere. Flags are the fast lever (runtime-flippable, ≤60s); the policy record is the slow-moving approved configuration.
