# Caregiver PII → private subcollection migration

**Status:** planned (2026-07-11). Storage-rules holes already fixed + deployed (`dc366cf`); this plan covers the remaining firestore exposure.

## Problem

`caregivers/{id}` is world-readable — `firestore.rules:119` `allow read: if isAuthenticated()` — and clients read it **directly via the client SDK** all over the app (`BrowseCaregivers`, `BookingFlow`, `MyCareTeam`, `ClientDashboard`, `LeaveReviewModal`, …). So the collection read **cannot** be tightened. But the doc also carries fields that must NOT be readable by every authenticated user:

- **Financial:** `stripeAccountId`, `chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`, `stripeOnboardingComplete`, `stripeOnboardingCompletedAt`
- **PII (bg check):** `backgroundCheckData` (legal name, DOB, SSN last-4, Checkr candidate/report IDs, invitation URL)
- **MVR:** `isApprovedDriver`, `mvrPaid`, `mvrReportId`, `mvrStatus`

Goal: move these into `caregivers/{id}/private/{doc}` with `allow read: if isOwner || isAdmin; allow write: if false` (functions use Admin SDK, which bypasses rules). Public profile fields (name, bio, services, rate, photo, location, `verified`, `verificationStatus`, `backgroundCheckStatus`) stay on the parent.

## Blocker to handle

`services/api.ts:2325` — `getCaregiversForVerification('exceptions')` runs
`col.where('backgroundCheckData.status', 'in', UNBOOKABLE_BG_STATUSES)` on the **parent** collection. A Firestore query can't reach a subcollection field, so moving `backgroundCheckData` silently empties this query and breaks the admin exceptions queue.

**Fix:** denormalize a non-PII `backgroundCheckStatus` string onto the parent (it already exists in the rules' webhook-only field list at `firestore.rules:142`), rewrite the query to `where('backgroundCheckStatus', 'in', …)`, and make every bg-check writer set both `private/background.backgroundCheckData` AND parent `backgroundCheckStatus` in the same write.

## Writers (all Admin SDK, functions/)

- `stripeConnect.ts` — `createStripeConnectAccount`, `syncAccountStatus` → `private/financial`
- `stripe.ts` — annual-renewal Checkr block (`handleInvoicePaymentSucceeded`) → `private/background` + parent `backgroundCheckStatus`
- `checkr.ts`, `checkrApi.ts` — webhook status updates → `private/background` + parent `backgroundCheckStatus`
- `agents/onboardingAgent.ts` `confirmBgcheckConsent` — initial candidate/invitation → `private/background`
- MVR writer (grep `mvrStatus`/`isApprovedDriver` assignments) → `private/background`

## Readers to switch (client)

- `services/stripeService.ts:282` — owner reads own `stripeAccountId` → read `private/financial`
- `components/admin/AdminCaregiverManager.tsx` (~711-766) — `backgroundCheckData.*` → read `private/background`
- `components/admin/CaregiverVerificationDashboard.tsx` — `backgroundCheckData.status` → parent `backgroundCheckStatus` for the badge; `private/background` for detail
- `services/api.ts:2309-2325` — sort key + exceptions query → parent `backgroundCheckStatus`

## Phased rollout (zero-downtime; each phase its own deploy + verify)

1. **Dual-write.** Writers write BOTH parent (as today) and `private/*`. Parent `backgroundCheckStatus` kept in sync. Add subcollection rules (`read: isOwner||isAdmin`, `write: false`). Deploy functions + rules. → nothing reads the new location yet; pure additive.
2. **Backfill.** New `functions/src/migrations/backfillCaregiverPrivate.ts` (match `backfillCaregiverServiceAvailability` pattern: `x-admin-secret`, `?dryRun=1`, idempotent, per-doc before/after). Dry-run → eyeball → live-run. Copies the private fields on every existing caregiver doc into `private/*` and sets parent `backgroundCheckStatus`.
3. **Switch reads.** Point the readers above at `private/*` / parent `backgroundCheckStatus`. Rewrite the `api.ts:2325` query. Deploy hosting + functions. Verify: caregiver payout page, admin verification queue (incl. exceptions), booking, browse.
4. **Strip parent.** Writers STOP writing the private fields to the parent. Cleanup migration deletes them from every parent doc (dry-run first). Deploy + run. → fields now GONE from the world-readable doc; exposure closed.

## Verification per phase

- After 1: create a caregiver, confirm `private/*` populated alongside parent; confirm no read regressions.
- After 2: dry-run diff sane; live-run 0 errors; spot-check founder doc has `private/financial` + `private/background`.
- After 3: E2E — caregiver sees own Connect status; admin exceptions queue still lists unbookable caregivers; client browse/book unaffected.
- After 4: raw client-SDK read of another caregiver's doc no longer returns `stripeAccountId`/`backgroundCheckData`/MVR; payout + bg-check webhooks still update state.

## Rollback

Each phase is independently revertible. Phases 1-3 are additive/read-switch (revert code). Phase 4 is the only destructive step — keep the backfill's copied data; a reverse migration can re-denormalize onto the parent if a missed reader surfaces.
