# Childcare Consumer Manifest

Human-readable rendering of `functions/src/data/childcareConsumerManifest.ts`
(childcare marketplace plan `docs/plans/2026-07-22-002`, Unit U0). The TypeScript
module is canonical; this document is the summary. If they disagree, fix the
module and regenerate the counts here.

## The System-Wide Consumer Rule

Every reader/writer/trigger/scheduler/browser surface/agent tool that touches a
shared collection must name exactly one disposition before childcare
enablement. **Zero UNCLASSIFIED consumers.** The manifest currently registers
**254 consumers** across 38 watched collections.

### Disposition scheme

| Disposition | Meaning | Count |
|---|---|---|
| `shared-vertical-aware` | Serves both verticals through a typed adapter; must branch on `careVertical` (or the typed recipient union) before touching vertical-specific fields. | 198 |
| `senior-only-explicit-skip` | Senior-vertical only. Must explicitly skip child-vertical records, with a characterization test in its owning unit — never processes them by accident. | 52 |
| `child-specific` | Childcare-only consumer with server authorization and privacy tests. First entries added by U1 (`functions/src/childcare/jurisdictionPolicy.ts`, `functions/src/config/featureFlags.ts` — the `jurisdiction_care_policies` loader and the Firestore-resident `childcare_flags` reader); recipient-data consumers arrive with U3+. | 2 |
| `legacy-compat-remove-after-migration` | Legacy compatibility reader/writer removed once its replacement migrates (currently: the phone-keyed `family_groups` reader in `functions/src/agents/familyGroupManager.ts`). | 1 |
| `disabled-before-childcare` | Must be disabled before childcare enablement (currently: the browser-resident `services/server/matchingEngine.ts`, which stays outside the security boundary). | 1 |

Owner-unit spread: U1×3, U2×3, U3×2, U4×6, U5×12, U6×32, U7×25, U8×34, U9×18,
U10×55, U11×24, U12×18, U13×10, U14×12.

## The `careVertical` cutoff rule

Defined in `functions/src/data/contract.ts` (`CareVertical`,
`CARE_VERTICAL_MIGRATION_CUTOFF`, `CARE_VERTICAL_COLLECTIONS`):

- After migration, every record in the 22 `CARE_VERTICAL_COLLECTIONS` carries
  `careVertical: "senior" | "child"`.
- Records created **before** the cutoff with an absent `careVertical` may be
  resolved to `"senior"` (everything that predates the childcare launch is a
  senior record by construction).
- Records created **at/after** the cutoff with a missing or invalid
  `careVertical` **fail closed** — explicit error state, never silently senior.
- `"child"` is never inferred from record content; only an explicit stamp by a
  U3+ childcare writer makes a record child-vertical.
- `CARE_VERTICAL_MIGRATION_CUTOFF` is a placeholder until U14 runs the
  migration; while it is the placeholder, the backfill
  (`functions/src/migrations/backfillCareVertical.ts`, not yet deployed —
  wired in U14) refuses apply mode and runs dry-run only.

## Running the audit

```
npm run audit:childcare-consumers
```

`scripts/audit-childcare-consumers.mjs` scans `functions/src`, `services`,
`components`, and `hooks` for `collection('…')` / `collectionGroup("…")` /
`doc(db, '…')` literals naming a shared collection, and fails (exit 1) with a
listed diff when a consuming file is not registered in the manifest. Tests,
type declarations, and compiled output are excluded; genuine false positives go
in the script's commented `ALLOWLIST`. Structural validity (real files, unique
names, valid dispositions/owners) is enforced by
`functions/src/data/childcareConsumerManifest.test.ts`.

When you add a new file that touches a shared collection, the audit fails until
you register it with a disposition and owner unit. That is the point — pick the
disposition deliberately, and if the consumer is genuinely ambiguous, use
`shared-vertical-aware` with a note rather than guessing `disabled`.

## Consumers per collection (counts by disposition)

| Collection | shared | senior-skip | child | legacy-compat | disabled | total |
|---|---|---|---|---|---|---|
| `admin_alerts` | 43 | 6 | 0 | 0 | 0 | 49 |
| `agent_action_ledger` | 7 | 0 | 0 | 0 | 0 | 7 |
| `agent_audit_log` | 3 | 0 | 0 | 0 | 0 | 3 |
| `agent_conversations` | 6 | 7 | 0 | 0 | 0 | 13 |
| `appointments` | 46 | 15 | 0 | 0 | 0 | 61 |
| `booking_requests` | 15 | 0 | 0 | 0 | 0 | 15 |
| `caregiver_reputation` | 1 | 0 | 0 | 0 | 0 | 1 |
| `caregivers` | 81 | 14 | 0 | 0 | 1 | 96 |
| `chatRooms` | 5 | 0 | 0 | 0 | 0 | 5 |
| `childcare_flags` | 0 | 0 | 1 | 0 | 0 | 1 |
| `disputes` | 1 | 0 | 0 | 0 | 0 | 1 |
| `family_group_members` | 4 | 0 | 0 | 1 | 0 | 5 |
| `family_groups` | 2 | 0 | 0 | 1 | 0 | 3 |
| `hire_requests` | 3 | 0 | 0 | 0 | 0 | 3 |
| `interview_requests` | 12 | 0 | 0 | 0 | 0 | 12 |
| `interviews` | 2 | 0 | 0 | 0 | 0 | 2 |
| `invoices` | 5 | 1 | 0 | 0 | 0 | 6 |
| `job_applications` | 10 | 1 | 0 | 0 | 0 | 11 |
| `job_postings` | 10 | 1 | 0 | 0 | 0 | 11 |
| `job_posts` | 25 | 2 | 0 | 0 | 0 | 27 |
| `jurisdiction_care_policies` | 0 | 0 | 1 | 0 | 0 | 1 |
| `learned_facts` | 0 | 1 | 0 | 0 | 0 | 1 |
| `match_history` | 4 | 0 | 0 | 0 | 0 | 4 |
| `memory_embeddings` | 0 | 1 | 0 | 0 | 0 | 1 |
| `notifications` | 15 | 0 | 0 | 0 | 0 | 15 |
| `payments` | 2 | 1 | 0 | 0 | 0 | 3 |
| `payouts` | 5 | 1 | 0 | 0 | 0 | 6 |
| `publicCaregiverProfiles` | 17 | 0 | 0 | 0 | 0 | 17 |
| `reports` | 4 | 0 | 0 | 0 | 0 | 4 |
| `reviews` | 6 | 0 | 0 | 0 | 0 | 6 |
| `senior_profiles` | 12 | 11 | 0 | 1 | 0 | 24 |
| `shiftHours` | 17 | 1 | 0 | 0 | 0 | 18 |
| `shifts` | 19 | 0 | 0 | 0 | 0 | 19 |
| `threads` | 5 | 0 | 0 | 0 | 0 | 5 |
| `users` | 77 | 13 | 0 | 1 | 0 | 91 |
| `video_interviews` | 14 | 0 | 0 | 0 | 0 | 14 |

Collections watched but with no direct-literal consumer at HEAD (guarded for
the future): `memory_operations`, `memory_reconciliation` — their consumers go
through `memory/memoryOperations.ts` internals, which is registered.

## High-risk seams (review-named — must stay registered explicitly)

These are pinned by `childcareConsumerManifest.test.ts`; deleting or renaming
any of them requires re-classification:

| Seam | Disposition | Owner | Why it is high-risk |
|---|---|---|---|
| `functions/src/utils/appointmentDoc.ts` | shared-vertical-aware | U7 | `canonicalApptFields` — every server appointment writer spreads it; the vertical/typed-recipient fields land here. |
| `functions/src/linq/routeIntent.ts` | shared-vertical-aware | U7 | SMS intent router; must branch on session vertical before senior-only flows run. |
| `functions/src/linq/inboundHelpers.ts` | shared-vertical-aware | U7 | Inbound helpers read appointments for parked-step decisions. |
| `functions/src/agents/careRecipients.ts` | shared-vertical-aware | U2 | `resolveRecipientKey` / `describeWhoIsWho` / `recipientMedical`; U2 extends it with the typed recipient union — no parallel resolution seam. |
| `functions/src/ai/caregiverReputation.ts` | shared-vertical-aware | U6 | `caregiver_reputation` aggregates must become per-vertical. |
| `functions/src/ai/feedback.ts` | shared-vertical-aware | U6 | `match_history` feedback writes need a vertical stamp so learning never crosses verticals. |
| `functions/src/ai/outcomeAnalytics.ts` | shared-vertical-aware | U6 | Outcome analytics over caregivers/matches; per-vertical aggregation. |
| `services/server/matchingEngine.ts` | **disabled-before-childcare** | U6 | Browser-resident "simulated server" matching; stays outside the security boundary — child matching is server-callable only. |
| `functions/src/agents/familyGroupManager.ts` | **legacy-compat-remove-after-migration** | U2 | Phone-keyed family groups: a recycled phone number satisfies the phone-in-list rule, so these readers stay senior-only until U2 replaces them with membership-record authority. |

Additionally, every `functions/src/scheduled/*` and `functions/src/triggers/*`
module is registered (including the ones with no direct collection literal),
so no scheduled job or trigger can reach childcare enablement unclassified —
the proactive senior jobs (health trends, briefings, family check-ins, memory
consolidation, etc.) are all `senior-only-explicit-skip` owned by U10.
