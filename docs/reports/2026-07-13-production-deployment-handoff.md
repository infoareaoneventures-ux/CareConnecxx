# Production Deployment Handoff - 2026-07-13

## Executive status

The launch-blocker implementation is committed, pushed, and deployed to the
Firebase production project `careconnex-d4c8b`.

- Production website: https://www.eviacares.com - HTTP 200 verified
- Firebase Hosting: https://careconnex-d4c8b.web.app - HTTP 200 verified
- Source branch: `fix/launch-blocker-sweep-2026-07-12`
- Deployed branch head: `5c9f3a709458111352c38bbe4999dedf900507af`
- Remote branch head: `5c9f3a709458111352c38bbe4999dedf900507af`
- Pull request: https://github.com/infoareaoneventures-ux/CareConnecxx/pull/3
- GitHub Actions: CI run `#161` completed successfully for `5c9f3a7`
- Production was deployed from the feature branch. The branch has not been
  merged into `origin/main`.

## Code completed

### Launch-blocker implementation

Primary commit: `f46bc44952473636cc44874505bb7648585df638`

The implementation-ready launch plan was completed across these areas:

- Canonical appointment-backed shift creation and approval delivery
- Generation-aware payment and refund operations
- Membership activation and access-gate contracts
- Leased, retry-safe appointment side effects
- Canonical schedule fields and migration tooling
- Deterministic recurring work creation
- Private caregiver records and public caregiver projections
- Server-created video interview records
- Default-off medical actions and timesheet auto-approval
- Bounded authentication recovery and launch configuration checks
- Bounded caregiver matching and callout queries
- Deterministic post-visit feedback and dispute state handling
- Firestore, Storage, Hosting, and CORS hardening

CI follow-up commit: `570eab8316210f224552b6a68290e35773be14c4`

- Added valid CI-only launch configuration placeholders without weakening the
  production environment checks.

### Admin pager hardening

Commit: `5c9f3a709458111352c38bbe4999dedf900507af`

Files:

- `functions/src/triggers/adminAlertNotifier.ts`
- `functions/src/triggers/adminAlertNotifier.test.ts`

Completed behavior:

- Replaced the session-dependent Cara alert path with direct Linq delivery.
- Replaced the unconsumed email-queue-only path with direct Resend delivery.
- Retained deterministic `admin_email_queue/{alertId}` records as an audit log.
- Recorded email and SMS delivery states on each alert.
- Kept email and SMS independent so one provider failure does not block the
  other channel.
- Added HTML escaping for alert details.
- Added support for canonical `severity` as well as legacy `priority` fields.
- Added duplicate-email protection using the deterministic audit record.
- Added six focused regression tests covering delivery, failures, escaping,
  severity handling, idempotency, and below-threshold alerts.

## Verification completed

### Local and CI

- Root TypeScript check passed during the launch sweep.
- Full Vitest suite: 217 files passed, 2,453 tests passed, 8 skipped, 0 failed.
- Functions build: 319 files transpiled, 0 errors.
- Pager regression suite: 6 tests passed, 0 failed.
- GitHub Actions CI run `#161`: success.
- Before this report was created, the Git working tree was clean and matched
  the remote feature branch.

### Production data and migrations

Pre-migration production counts:

- `appointments`: 0
- `shifts`: 0
- `shiftHours`: 0
- `caregivers`: 8
- `publicCaregiverProfiles`: 0

Migration results:

- Appointment schedule migration: scanned 0, errors 0.
- Public caregiver projection: scanned 8, projected 8, errors 0.
- Private caregiver background migration: scanned 8, migrated 0, skipped 8,
  errors 0.
- Private payout migration: scanned 8, copied 0, skipped 8, errors 0.
- Final public profile verification: 8 profiles at projection version
  `2026-07-12-v1`, with no forbidden-field violations.

### Firebase production release

- Current source fleet: 194 `v1` functions active, 0 non-active.
- `v1-linqWebhook`: ACTIVE, Node 22, version 237.
- `v1-onAdminAlertCreated`: ACTIVE, Node 22, version 148.
- Firestore rules compiled and deployed.
- Firestore indexes deployed.
- Storage rules deployed.
- Storage CORS deployed and verified for Evia production, Firebase Hosting,
  CareConnecxx domains, and local development origins.
- Medical actions verified off.
- Timesheet auto-approval verified off.

Hosting release:

- Release: `1783964591295000`
- Version: `e396fa3d12596ee7`
- Release time: `2026-07-13T17:43:11.295Z`
- Status: FINALIZED
- File count: 306
- Version size: 13,173,461 bytes

## Incomplete or intentionally deferred

### 1. Pull request is not merged

PR `#3` remains open. Production currently runs code from the feature branch,
while `origin/main` does not contain these launch commits. The PR description
also still says the release has not been deployed, so its release-gate section
is stale and should be updated before merge.

### 2. Resend email domain is not verified

The `eviacares.com` domain was registered in Resend, but its status remains
`not_started`. Production admin-alert email attempts fail until these Bluehost
DNS records are added and Resend reports the domain as verified:

```text
TXT  resend._domainkey
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCkxW2SzyImnY3fT05I9lLRefv728WmmGGYX3TnEzAAndV7MdPhYoAH6j6xJYZgy+pbZMlSSeG1tTJQ68c5+jL9VDZGQIIjFNB1DeDS8lSABpP6F/EaSNXzFVd1zZlBCGSLtqhsxHBVEAwzp08vzu5Nzt8M6BLzzxpt6skmb5oR2wIDAQAB

MX   send   priority 10
feedback-smtp.us-east-1.amazonses.com

TXT  send
v=spf1 include:amazonses.com ~all
```

This does not block the web application or Firebase runtime, but admin-alert
email is not operational until verification succeeds.

### 3. Administrator SMS is intentionally deferred

The configured `ADMIN_PHONE` is the same number as the Linq sender. Linq
rejects sending a message to its own sender number with HTTP 400. The user
explicitly directed deployment to finish without resolving the administrator
mobile number, so SMS receipt is not a completion gate for this release.

### 4. Real two-sided production workflow smoke tests were not run

The database had no appointments, shifts, or shift-hour records during the
release. Migration and infrastructure verification passed, but the release did
not execute a real family-to-caregiver booking, payment, shift completion,
refund, or payout flow with production identities and production Stripe money.
Those workflows remain the highest-value post-deploy launch smoke tests.

### 5. Pre-existing orphan Cloud Functions were not deleted

The current `v1` source fleet is fully active. Older functions outside the
current source set remain in the Firebase project, including older Node 20 and
failed second-generation entries. They were intentionally left untouched
because deleting them requires a separate usage and ownership audit.

### 6. Firebase runtime configuration deprecation remains

Firebase reported that `functions.config()` and Cloud Runtime Config must be
migrated before March 2027. It did not block this deployment, but it is a
required future platform-maintenance item.

## Recommended closeout order

1. Run real family and caregiver booking/payment lifecycle smoke tests.
2. Add the Bluehost DNS records and verify an admin email receipt.
3. Update PR `#3` to reflect the completed production deployment.
4. Review and merge PR `#3` so `origin/main` matches production.
5. Audit and remove confirmed orphan functions in a separate change.
6. Plan the `functions.config()` migration before March 2027.

## Final assessment

The production platform and Hosting deployment are complete and live. The main
remaining launch risks are operational rather than undeployed code: production
has not been exercised with a real two-sided money flow, admin email awaits DNS
verification, production is ahead of `origin/main`, and old orphan functions
still require an ownership audit.
