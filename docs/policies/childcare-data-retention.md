# Childcare Data Retention Policy — v `childcare-retention-2026-07-22.1`

Plan: `docs/plans/2026-07-22-002-...consolidated-implementation-plan.md` (R13; U1 skeleton, U3 implementation).
Referenced from `jurisdiction_care_policies/{state}.retentionPolicyVersion` — a policy doc naming a version that does not exist in this file's history is invalid.

**Status: SKELETON.** Purposes, stores, and deletion mechanics are fixed by the plan; concrete durations marked `POLICY-TBD` are **placeholders awaiting counsel/founder sign-off** and must be resolved before any production child data is collected (Stop Conditions). Placeholder durations are treated as *unset* — they do not authorize any retention behavior.

## Versioning rules

- This document is versioned (`childcare-retention-YYYY-MM-DD.N`). Any change to a purpose, duration, or deletion mechanism bumps the version, and the new version must be re-recorded in each state's policy doc (which invalidates approvals recorded against the old `policyVersion` where counsel requires re-review).
- TTL/cleanup workers (U3 `childcareLifecycleWorker`) stamp the retention version they enforced; proof-of-deletion records reference it.
- Legal hold always wins over TTL: a held record is exempt until the hold clears, then re-enters the normal schedule.

## Purpose-specific retention table (R13)

| # | Data class | Store(s) | Purpose | Retention duration | Deletion mechanism | Legal-hold aware |
|---|---|---|---|---|---|---|
| 1 | Child profile (summary + operational care requirements) | `child_profiles/{childId}` (U3) | Care coordination and matching | Life of household relationship + `POLICY-TBD` after account/profile closure | U3 lifecycle state machine (export → delete → tombstone), orphan scan | Yes |
| 2 | Child private safety versions | `child_profiles/{childId}/private/safety/versions/{v}` | Minimum booking safety projection source | Current version + superseded versions for `POLICY-TBD`; all versions removed with profile deletion | Versioned replace + revoke; lifecycle delete | Yes |
| 3 | Guardian authority records | `guardian_authorities/{authorityId}` (U2) | Authorization evidence | Duration of authority + `POLICY-TBD` after revocation/expiry (dispute/audit window) | Revocation keeps a redacted audit stub; lifecycle delete of full record | Yes |
| 4 | Booking safety projections | `childcare_booking_safety/{bookingId}/versions/{v}` (U7) | Time-bounded assigned-caregiver disclosure | Access revoked at booking end/substitution immediately; record retained `POLICY-TBD` for incident/dispute correlation | Access-version revocation (immediate) + TTL cleanup | Yes |
| 5 | Family–provider messages (childcare context rooms) | `chatRooms` / `threads` (vertical-scoped, U9) | Adult care coordination | `POLICY-TBD` after last booking/relationship end | Server-owned conversation deletion + revocation fan-out | Yes |
| 6 | Incident cases + evidence | `childcare_incidents/{incidentId}` (U12) | Safety, reporting obligations | `POLICY-TBD` — expected LONG retention per counsel (mandated-reporting/litigation); never routine-TTL'd | Case-owner-controlled disposition only; evidence holds | Yes (default-held) |
| 7 | Audit records (authority changes, operator access, action ledger) | `agent_audit_log`, `agent_action_ledger` | Accountability, access review | `POLICY-TBD` (≥ financial/dispute windows); redacted — no raw child PII by construction (R57) | Existing ledger lifecycle; no child-PII purge needed if R57 holds | Yes |
| 8 | Analytics / metrics / telemetry | ops counters, canary metrics (U13) | Release gating, ops health | Aggregates only, `POLICY-TBD`; **must contain no child PII at all** (R57) — retention is an ops concern, not a privacy one, if the assertions hold | Standard metric expiry | No (no PII permitted) |
| 9 | Provider evidence (childcare screening/credential references) | `caregivers/{uid}/screenings/child`, `caregivers/{uid}/vertical_profiles/child` (U5) | Eligibility evidence | Provider IDs + derived statuses only (raw reports stay provider-side, KTD10); retained while provider active + `POLICY-TBD` after departure (FCRA/adverse-action window) | Lifecycle delete + Checkr/Stripe redaction tasks tracked to completion | Yes |
| 10 | Consent receipts | `consent_receipts/{receiptId}` (U2/U4) | Proof of versioned consent (R23) | Duration of relationship + `POLICY-TBD` (consent-proof window) | Lifecycle delete after window; never mutated in place | Yes |
| 11 | Data-lifecycle requests (export/delete/redact) | `data_lifecycle_requests/{requestId}` (U3) | Deletion/export proof (terminal states) | Terminal proof retained `POLICY-TBD` (deletion must remain provable) | Self-expiring after proof window | Yes |

## Fixed rules (not placeholders)

- **No child facts in AI memory, ever** (R50/KTD17): Zep, learned facts, memory files, summaries, proactive reflection, eval/training captures are *prohibited stores* for child data — retention duration is therefore zero by construction; U10 memory-eligibility enforces it and U13 asserts it.
- **Approved financial, dispute, safety, and legal records are preserved** through any deletion request (R14); deletion produces tombstones + a retained-record reason list, never silent gaps.
- **Auth deletion alone is never account deletion** (R15) — retention/deletion always flows through the tracked U3 lifecycle workflow.
- **Storage files** follow the same class as their parent record (child files = class 1/2/4; provider evidence = class 9) and are deleted by the same lifecycle tasks with orphan scans.

## Open items (blockers for production child data)

- [ ] Counsel supplies every `POLICY-TBD` duration (classes 1–7, 9–11) — recorded here as v2, then re-referenced from `jurisdiction_care_policies/CA.retentionPolicyVersion`.
- [ ] Confirm incident-case retention and mandated-reporting interplay for CA (class 6).
- [ ] Confirm FCRA adverse-action retention window for provider evidence (class 9).
