---
title: "fix: Launch-Blocker Bug Sweep"
type: fix
status: implemented-release-blocked
date: 2026-07-12
source: docs/plans/2026-07-12-001-fix-launch-blocker-bug-sweep-plan-revised.md
implementation_authority: this-file
---

# fix: Launch-Blocker Bug Sweep

## Execution Status

This is the sole implementation authority for the launch-blocker sweep. The source review is
retained as audit evidence, but its base/A-unit pairs, superseded commit groups, alternatives,
and conflicting deployment instructions are not executable requirements.

The engineering implementation is complete. Production deployment remains blocked until
the release owner supplies and verifies the real support and pager contacts listed in Preflight.
Those values are deployment inputs, not architecture decisions.

As of 2026-07-13, U0-U13 are implemented on `fix/launch-blocker-sweep-2026-07-12`.
Frontend typecheck and the full Functions transpile pass (319 files, 0 errors); the final full
Vitest run passes 2,453 tests across 217 files with 8 skipped and 0 failed. The release is not
complete: `VITE_SUPPORT_PHONE`, `ADMIN_PHONE`, and
`ADMIN_EMAIL` are still empty in the trusted production environment. The empty frontend Stripe
publishable key is not a blocker because the webapp has no `getStripe()` callers and uses
server-created hosted Checkout URLs. Migration dry-runs, live identity smoke tests, the pager
receipt, and Firebase deployment evidence remain outstanding.

## Goal

Ship CareConnecxx with trustworthy billing, idempotent appointment side effects, enforceable Evia
privacy boundaries, non-medical launch behavior, reliable user recovery, and a reproducible
Firebase release.

## Scope

In scope:

- All CRITICAL, HIGH, and MEDIUM findings from the launch audit.
- The explicitly listed LOW cleanup batch.
- Required migrations, indexes, rules, operational controls, and release evidence.

Out of scope:

- New product features or medical capabilities.
- Pricing-model changes beyond enforcing the booked rate.
- Geo-sharding or matching-scale work beyond the bounded callout query.
- Removal of legacy fallbacks whose existing grace period has not expired.

## Launch Policy Defaults

These defaults are authoritative for implementation. Changing them requires a documented product
decision and updated tests.

| Policy | Launch value |
| --- | --- |
| Currency | USD, represented as integer cents |
| Time calculation | Exact elapsed minutes; final money rounded once to nearest cent |
| Maximum submitted visit | 24 hours and no time outside the booked appointment window |
| Maximum billable amount | $2,500 per appointment |
| Explicit client approval | Required above $500; no `autoApproveAt` |
| Caregiver hourly-rate input | Numeric $15-$150; display/profile only, never billing authority |
| Manual-review reminders | 24 and 48 hours after submission |
| Manual-review timeout | 72 hours, then `requires_admin_review` |
| Refund authority | Client may request; an administrator approves and executes |
| Refund eligibility | Captured and settled payment, up to the server-calculated remaining balance |
| Medical flows | Disabled by default for launch |

Caregiver-entered line items are descriptive only. A chargeable line item must come from a
server-owned catalog or an administrator-approved adjustment. The server derives every amount;
no caregiver or client payload is financial authority.

## Preflight

Complete these before coding the dependent unit:

1. Inventory every direct writer of `shiftHours`, every legacy `shifts` writer, every reader of
   canonical `caregivers`, and every creator of appointment side effects. Save the inventory in
   the PR description and fail the cutover if an unknown writer remains.
2. Sample production data for appointment-to-timesheet cardinality, legacy shift linkage,
   schedule-field convertibility, and payment-method location. Produce counts, not anecdotes.
3. Add non-secret `VITE_SUPPORT_PHONE` and support email to the production Hosting build
   environment. Add pager phone/email to the Functions runtime secret/config system. Never commit
   these values or a production `.env` file.
4. Name the release owner, billing-review operator, privacy/support operator, and rollback owner.
5. Capture the existing Storage CORS policy, Firebase project/targets, branch, local SHA, and
   `origin/main` SHA before changing production.

## System Contracts

### Billing Source Of Truth

`appointments/{appointmentId}` is canonical for client, caregiver, booked rate, payment method,
scheduled window, and completion state. `shiftHours/{appointmentId}` is a derived financial
record. One appointment may have at most one active timesheet.

Legacy `shifts/{shiftId}` records must persist `appointmentId` after a verified migration. An
unlinked or multiply-linked legacy record is non-chargeable and moves to `requires_admin_review`.
The migration must report collisions and never choose a link heuristically.

All web, SMS/care-note, MCP, agent, and recurring paths call the server-only
`createValidatedShiftHours`. It transactionally:

1. Reads the appointment and verifies authenticated actor, assigned caregiver, client, billable
   completion state, and uniqueness.
2. Derives the interval, booked rate, payment method reference, allowed adjustments, total, and
   review state.
3. Creates `shiftHours/{appointmentId}` and its approval-notice outbox record atomically.
4. Returns the existing record for an identical retry and rejects a conflicting duplicate.

Firestore rules deny client create/delete of `shiftHours` and all direct mutation of financial
fields. The existing narrowly scoped cash-receipt acknowledgement may remain only if rules tests
prove it cannot mutate amount, identity, payment, review, or settlement state.

### Approval Notice Outbox

Use a deterministic record keyed by `appointmentId:approval-request:v1`. Required fields:

`appointmentId`, `recipientUid`, `recipientPhoneHash`, `templateVersion`, `payloadSnapshot`,
`state`, `attemptCount`, `nextAttemptAt`, `leaseOwner`, `leaseExpiresAt`, `providerMessageId`,
`providerStatus`, `createdAt`, `updatedAt`, and `lastErrorCode`.

States are `pending`, `processing`, `delivered`, `retryable_failed`, and `terminal_failed`.
Workers claim a pending/retryable record transactionally with a five-minute lease. Expired leases
are reclaimable. Provider delivery callbacks, bound to the provider message ID, set `delivered`.
Retries use capped exponential backoff and stop after five attempts, then alert an administrator.

Auto-approval requires `approvalNoticeState == delivered`. Provider acceptance alone is not
delivery proof. A delivery failure or missing receipt keeps the shift in client/manual review and
can never make it chargeable.

### External Side-Effect State Machine

Cancellation workflows, recurring summaries, approval notices, transfers, reversals, refunds,
and feedback writes use a shared claim shape:

`operationKey`, `state`, `attemptCount`, `nextAttemptAt`, `leaseOwner`, `leaseExpiresAt`,
`providerOperationId`, `completedAt`, and `lastErrorCode`.

States are `pending`, `processing`, `completed`, `retryable_failed`, and `terminal_failed`.
Claim-before-send is not sufficient: leases expire, retries reclaim work, provider idempotency
keys remain stable for one operation, and a reconciler resolves uncertain outcomes before retry.
Sibling triggers do not need to read the claim; they must early-return by the documented event
ownership table. Only the elected owner creates or advances the claim.

### Payment Generations

Each timesheet stores a transactionally claimed payment generation containing its generation
number, funding PaymentIntent, transfer ID, reversal ID, refund total, and terminal marker.
Transfer, reversal, and refund idempotency keys include appointment ID and generation.

New records start at generation zero. A legacy record with no generation retains its legacy key
until a transaction establishes its first new generation; it is never silently defaulted to zero.
A webhook whose PaymentIntent does not match the claimed generation is a no-op.

The payment-method reference is snapshotted from the appointment when the validated timesheet is
created. If it is absent or no longer usable, the shift requires client action; the system must
not silently select another saved card.

### Security And Privacy

The public caregiver projection has this exact allowlist:

- `caregiverId`, `firstName`, `photoUrl`, `city`, and `serviceArea`
- `languages`, `specialties`, `yearsExperience`, and `availabilitySummary`
- `hourlyRateDisplay`, `rating`, `reviewCount`, and non-sensitive verification badges

It excludes phone, email, exact address, date of birth, legal name, payment identifiers,
verification documents, recipient photos, internal notes, and Storage paths. Canonical caregiver
documents and verification media are owner/admin/server only. Existing readers must move to the
projection with a backfill and dual-read observation period before rules are tightened.

Roles use verified custom claims:

- `admin`: financial and privacy administration.
- `billing_reviewer`: read and resolve manual billing review; no secret/config administration.
- `support`: read user-visible support state; no financial mutation or private verification data.

All new outbox, operation, review, feedback, and reconciliation collections are client-write
denied. Reads are least-privilege by role. Store phone hashes where routing does not require the
raw value, define a 90-day retention/TTL for completed operational records, and retain financial
ledger records according to the existing accounting policy.

Reserved `cara_<uid>` threads are server-created. Participants and type are immutable. A client
message must bind `senderId` to the authenticated UID. `match_outcomes` is server-write-only.
Video interview creation and feedback capture use authenticated endpoints that verify the
appointment relationship and bind the sender to its client.

### Deployment Controls

Add a server-side `TIMESHEET_AUTO_APPROVAL_ENABLED` runtime flag, default `false`. The sweep exits
without charging when false. This is the operational kill switch and must have a focused test.
Medical actions use `MEDICAL_FLOWS_ENABLED`, also default `false`.

Configuration validation must fail a production build/deploy when required public support values
or runtime pager configuration are absent. Development and staging may use clearly labeled test
values. No code fallback may invent a production phone or email.

## Implementation Units

### Phase 0: Foundations

#### U0. Inventory, data sample, configuration, and schemas

**Dependencies:** none.

**Files:** migration/report scripts, Functions runtime configuration, Hosting build validation,
`functions/src/billing/config.ts`, Firestore rules/indexes, release runbook.

**Work:** Complete Preflight; encode policy defaults; define the timesheet, outbox, operation,
payment-generation, refund, public-profile, and role contracts; implement both kill switches.

**Exit:** Inventories are complete, data exceptions have administrator dispositions, production
config validation exists, and schema/rules tests cover every new collection.

### Phase 1: Additive Financial Safety

#### U1. Canonical validated timesheet creation and approval outbox

**Dependencies:** U0.

**Files:** `functions/src/billing/createValidatedShiftHours.ts` (new),
`functions/src/billing/approvalNoticeDispatcher.ts` (new), `functions/src/index.ts`,
`functions/src/shiftHours.ts`, `functions/src/linq/routeCaregiver.ts`,
`functions/src/mcp/server.ts`, `functions/src/agents/bookingExecutor.ts`,
`functions/src/scheduled/recurringScheduler.ts`, the existing client payment-review surface,
`firestore.rules`, and focused tests.

**Work:** Implement the Billing Source Of Truth and Approval Notice Outbox contracts. Export the
scheduled dispatcher and provider-status callback from `functions/src/index.ts`. Migrate all
writers to the shared creator. Enforce the launch limits and valid overnight behavior. Bill care
notes at the booked appointment rate. The client payment-review surface shows appointment date,
hours, booked rate, server-approved line items, total, notice/review status, and Approve, Request
correction, and Dispute actions. High-value items have no auto-approval timestamp. The operations
surface shows retry, terminal-delivery, and `requires_admin_review` queues without exposing
provider secrets.

**Exit:** Writer inventory reports zero direct financial creates; duplicate submissions create one
timesheet/outbox pair; failed delivery cannot charge; arbitrary line items and amounts are ignored
or rejected.

#### U2. Payment, transfer, reversal, refund, and reconciliation state machines

**Dependencies:** U1.

**Files:** `functions/src/stripe.ts`, `functions/src/shiftHours.ts`,
`functions/src/triggers/refundProcessor.ts`, refund request endpoint, existing client payment
detail surface, administrator billing-review surface, rules, alerting, and tests.

**Work:** Implement payment generations and stale-intent rejection. Make transfer, reversal, and
refund operations leased and idempotent. Refund requests are server-authorized, use the persisted
PaymentIntent/transfer, and cannot exceed remaining balance. The client can request a refund from
an eligible payment and sees `requested`, `under_review`, `approved`, `processing`, `refunded`, or
`declined` with a support route. Only an administrator can approve, decline, or retry; the admin
surface shows the original charge, prior refunds, remaining balance, transfer impact, reason, and
audit actor. Reconcile bounded pages of stale `charge_pending` records using per-record
`nextAttemptAt`; no global cursor is required. Use five attempts with capped backoff, then terminal
administrator review. Notify client and caregiver of final charge failure. Rethrow onboarding
advancement failures so Stripe redelivers.

**Exit:** Two complete pay/reverse/re-pay cycles, duplicate and out-of-order webhooks, missed
webhooks, partial refunds, and replayed refund requests converge without duplicate money movement.

#### U3. Membership checkout consistency

**Dependencies:** U0.

**Files:** `functions/src/agents/onboardingConversation.ts`,
`functions/src/agents/linkPromiseNet.ts`, `functions/src/stripe.ts`,
`functions/src/agents/commitmentTracker.ts`, and tests.

**Work:** Make resent `client_payment` links use subscription mode and the resolved client price.
Never mark membership active without a persisted subscription ID.

**Exit:** Main and resent checkout paths produce identical subscription state; setup sessions do
not activate membership.

### Phase 2: Idempotent Appointment Events

#### U4. Cancellation ownership and recoverable side effects

**Dependencies:** U0.

**Files:** `functions/src/triggers/appointmentUpdated.ts`,
`functions/src/caregiverCallout.ts`, `functions/src/notifications.ts`, and tests.

**Work:** Elect `appointmentUpdated` as sole owner of caregiver cancellation variants. Sibling
handlers early-return. The owner uses the External Side-Effect State Machine keyed by appointment
and transition version before replacement tasks, offers, or messages.

**Exit:** Every caregiver cancellation variant produces one replacement workflow and one coherent
family notification under duplicate and concurrent delivery; client cancellation remains intact.

#### U5. Schedule migration and completion sweep

**Dependencies:** U0. The migration and index deploy before the query change.

**Files:** `functions/src/appointmentCompletion.ts`,
`functions/src/migrations/backfillAppointmentScheduleFields.ts` (new),
`functions/src/agents/bookingExecutor.ts`, `functions/src/scheduled/recurringScheduler.ts`,
`firestore.indexes.json`, and tests.

**Work:** Canonicalize Pacific `date`, `time`, and `duration`; retain `isoDate` only as a legacy
fallback. Add a dry-run-by-default backfill with explicit `apply=true`. Report unconvertible rows
without completing them. Deploy `appointments(status,date)` before switching the sweep.

**Exit:** Web, agent, recurring, and legacy appointments complete; no eligible sampled record is
silently skipped.

#### U6. Recurring notification summaries and reminders

**Dependencies:** U4.

**Files:** `functions/src/notifications.ts`,
`functions/src/scheduled/recurringScheduler.ts`, and tests.

**Work:** Skip premature confirmation for agent-created pending appointments. Use deterministic,
leased summary operations keyed by recurring group/task and party. Query reminder candidates by
status/date and filter `reminderSent === true` in code.

**Exit:** A concurrent 12-visit booking sends one request/summary per party, no premature client
confirmation, and one one-hour reminder per eligible appointment.

### Phase 3: Evia Security And Medical Boundary

#### U7. Authorization, public caregiver projection, and operational rules

**Dependencies:** U0 and completed reader inventory/backfill.

**Files:** `functions/src/linq/webChat.ts`, `functions/src/email.ts`, `firestore.rules`,
`storage.rules`, `services/api.ts`, projection writers/readers, and emulator tests.

**Work:** Bind web-chat session phone/user to Firebase Auth; enforce the Security And Privacy
contract; close cross-user notification writes and the open mailer; reserve Evia threads; protect
matching outcomes; throttle and relationship-check interview creation. Use the projection in
dual-read mode, compare results, then tighten canonical caregiver rules.

**Exit:** Emulator tests deny every cross-user, forged-thread, forged-sender, global-outcome,
private-profile, and unbounded-SMS path while public caregiver cards still render.

#### U8. Non-medical launch behavior

**Dependencies:** U0.

**Files:** `functions/src/agents/healthcareHandler.ts`,
`functions/src/agents/intentClassifier.ts`, `functions/src/ai/claudeMatching.ts`,
`functions/src/agents/caregiverProfileHandler.ts`, healthcare action tests, and fixtures.

**Work:** Deflect prescription refill, new prescription, provider search, and symptom-adjacent
requests before tools are exposed when the switch is off. State that Evia coordinates
non-medical care; direct prescription needs to a pharmacy/licensed provider. For emergency or
immediate danger only, direct the user to 911 or local emergency services. Do not diagnose or
triage. Remove clinical-procedure-as-standard-care language from matching.

**Exit:** Default configuration exposes no medical action path and invokes no healthcare/browser
tool for disabled intents.

### Phase 4: Frontend Trust And Launch Configuration

#### U9. Support contacts and reconnect behavior

**Dependencies:** U0 production configuration.

**Files:** `components/auth/onboarding/OnboardingFlow.tsx`,
`components/pages/JoinFamilyPage.tsx`, `context/CareConnexContext.tsx`,
`components/auth/LoginPage.tsx`, build validation, and tests.

**Work:** Remove fictional numbers and render verified configuration. Missing production support
config fails the build. On profile-read failure, never default to client: use UID-bound last-known
role only as a temporary hint, bounded exponential retries (three attempts over at most 15
seconds), then a terminal recoverable state with accessible status, Retry, and Sign out. Distinguish
offline, unauthenticated, unauthorized, and unavailable failures.

**Exit:** No 555 value renders; a caregiver never sees a client surface; keyboard and screen-reader
tests cover reconnect and terminal recovery.

#### U10. CORS, portable builds, runtime fallback, and committed release source

**Dependencies:** U0.

**Files:** `cors.json`, `package.json`, lockfile, CI/deploy wrapper,
`functions/src/sms.ts`, Git history, and release runbook.

**Work:** Add `eviacares.com` and `www.eviacares.com` while retaining every currently served
Hosting origin. Use a Node build wrapper or `cross-env` so standard `npm run build` sets
`NODE_OPTIONS=--max-old-space-size=8192` on Windows and CI. Treat empty `CARA_AVATAR_URL` as absent
in code. Commit only an explicit manifest of deployed source, including imported untracked modules;
never stage `.env`. Verify from a fresh worktree at the candidate commit.

**Exit:** Upload succeeds from every live origin; standard builds need no manual environment
export; contact cards have an avatar; release source is reproducible from one SHA.

### Phase 5: Reliability And Cleanup

#### U11. Bounded caregiver callout

**Dependencies:** U4.

**Files:** `functions/src/aiMatching.ts`, `functions/src/caregiverCallout.ts`, and tests.

**Work:** Bound candidates geographically with `limit()` and replace per-caregiver booking checks
with one day-appointments query filtered in memory.

**Exit:** Booked-check query count is O(1) and roster size is capped.

#### U12. Trigger cancellation, dispute vocabulary, and feedback capture

**Dependencies:** U0.

**Files:** `functions/src/triggers/triggerEngine.ts`, bereavement/reply consumers,
`functions/src/mcp/server.ts`, `functions/src/shiftHours.ts`,
`functions/src/scheduled/nextDayFamilyFeedback.ts`, `functions/src/linq/webhooks.ts`, indexes,
rules, and tests.

**Work:** Initialize `firedAt` and `cancelledAt` to null. Standardize disputes on
`correction_proposed`. Use one deterministic `post_visit_feedback` trigger per appointment with
client/caregiver/expiry. The authenticated inbound client claims it, writes one signal, returns
before generic routing, and receives success, expired, or retryable-failure acknowledgement.

**Exit:** Bereavement/replies cancel pending triggers; web/SMS disputes converge; duplicate,
forged, or expired feedback cannot create extra reputation signals.

#### U13. Low-risk cleanup batch

**Dependencies:** relevant unit tests green.

**Files:** `functions/src/mcp/server.ts`, `services/stripeService.ts`,
`components/PaymentSuccess.tsx`, `App.tsx`,
`functions/src/agents/onboardingConversation.ts`,
`functions/src/agents/permissionsConversation.ts`, and onboarding routing.

**Work:** Fix self-delivery detection for caregiver messages; delete phantom subscription writers;
remove the vestigial payment-success prop or wire the real action; replace mojibake; ensure silent
permission returns have caller fallbacks; remove or redirect `caregiver_awaiting_identity`.

**Exit:** Focused tests and grep prove each listed defect is removed without changing unrelated
onboarding behavior.

## Source Traceability

This consolidation preserves the reviewed scope as follows:

| Active unit | Source-review units absorbed |
| --- | --- |
| U0 | Launch Decisions, system contracts, release controls |
| U1 | U1, U1A, U3, U3A, U4 |
| U2 | U2, U2A, U21, U21A, U23, U23A |
| U3 | U5 |
| U4 | U6, U6A |
| U5 | U7, U7A |
| U6 | U8, U8A, U9 |
| U7 | U10, U10A |
| U8 | U12, U12A |
| U9 | U13, U13A, U14, U14A |
| U10 | U15, U15A, U16, U16A, U17, U18, U19, U19A |
| U11 | U11 |
| U12 | U20, U22, U24, U24A |
| U13 | U25 |

## Expand-Contract Release Sequence

Firebase activation is not atomic. Every step must tolerate the previous and next application
version.

1. Deploy additive indexes, new collections/rules, outbox/operation workers, kill switches off,
   and shared creator without removing old reads. Verify workers idle safely.
2. Run schedule, legacy-shift, and public-profile migrations in dry-run mode. Review exceptions,
   then apply in bounded batches. Keep dual reads and compare results.
3. Deploy all writers using `createValidatedShiftHours`, payment generations, event ownership,
   and medical deflection. Keep auto-approval disabled.
4. Verify telemetry shows no unknown writer, direct billable write, duplicate operation, unmapped
   shift, missing notice receipt, or privacy-reader mismatch for the observation window.
5. Tighten `shiftHours`, caregiver, Evia thread, notification, feedback, and Storage rules. Verify
   denial and legitimate paths in production-safe smoke tests.
6. Enable auto-approval only after delivered approval notices and payment generations are visible.
   High-value and uncertain records remain manual. Deploy Hosting after Functions/config contracts
   are live, then verify both fresh caregiver and family identities.
7. Apply additive Storage CORS and verify each served origin. Do not remove the old origin in this
   release.

Rollback keeps restrictive rules in place, disables auto-approval, stops new side-effect leases,
and routes uncertain work to `requires_admin_review`. Never restore direct financial writes,
broad data access, or medical actions.

## Verification Contract

The release candidate fails unless all applicable checks pass with zero production-source type
errors. Diagnostics may not be waived as "separately tracked" for this release.

- `npm.cmd run build` from a clean install on Windows and CI.
- `npm.cmd --prefix functions run build` and a strict Functions `tsc --noEmit` check.
- Targeted Vitest suites for each changed billing, trigger, Evia, healthcare, and frontend module;
  run bounded groups if the full suite exceeds memory.
- Firebase Emulator rules tests for every denied and allowed path introduced here.
- Stripe test-mode replay for stale failure after success, duplicate/out-of-order events, two
  generations, missed-webhook reconciliation, partial refund, and refund replay.
- Migration dry-run/apply evidence with scanned, changed, skipped, collision, and error counts.
- Fresh caregiver and family identities covering booking, completion, timesheet review, approval,
  cancellation/replacement, payment, dispute, feedback, reconnect, and support visibility.
- Browser upload from each live Hosting origin and default-off medical-action proof.

Release evidence records the candidate local SHA, remote branch SHA, `origin/main` SHA, Firebase
project and targets, Functions names/update times, Hosting release/version, rules/index deploy,
Storage bucket/CORS policy, runtime-config validation, and received test pager alert. Generic deploy
logs are not proof.

## Commit Groups

1. `fix(billing): add canonical timesheets and durable approval delivery` (U0, U1)
2. `fix(billing): make payment lifecycle transactional and recoverable` (U2)
3. `fix(membership): align checkout and activation state` (U3)
4. `fix(triggers): make appointment side effects idempotent` (U4-U6)
5. `fix(security): enforce Evia identity and caregiver privacy` (U7)
6. `fix(safety): disable medical actions at the tool boundary` (U8)
7. `fix(web): require real support config and safe role recovery` (U9)
8. `chore(launch): make build, CORS, runtime config, and source reproducible` (U10)
9. `fix(reliability): bound callouts and converge trigger feedback flows` (U11-U12)
10. `chore(cleanup): remove verified low-risk defects` (U13)

U0 schema/config work may be split when required, but no commit may leave an enabled production
path depending on a schema, index, secret, rule, or worker that is not yet deployed.

## Definition Of Done

- Every implementation unit meets its exit criteria.
- No client-controlled identity, amount, line item, payment method, or sender field crosses a
  financial or Evia trust boundary.
- Every external side effect is leased, retryable, reconcilable, and idempotent.
- Every migration is measurable and reversible; mixed-version operation is tested.
- Production source compiles with zero type errors and required focused suites pass.
- Fresh end-to-end identities pass both sides of the marketplace.
- The deployed release is proven from a committed SHA with exact Firebase and Hosting evidence.
- Auto-approval and medical actions remain off unless their explicit enablement gates are met.
