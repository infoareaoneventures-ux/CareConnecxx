# Firestore Index & Data-Integrity Hardening — Rollout Runbook (U8)

Companion to `docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md`.
Covers deploying the changes implemented on 2026-07-20. **Founder-run** — every step
here touches production (`careconnex-d4c8b`) and needs Firebase/gcloud credentials
this coding session does not have.

## What was implemented (code complete, tested, NOT deployed)

| Unit | State | Key files |
|---|---|---|
| U1 query contract + tooling | done | `firestore.query-contracts.json`, `scripts/audit-firestore-query-contracts.mjs`, `scripts/deploy-firestore-additive-indexes.mjs`, `tests/firestoreIndexCoverage.test.ts` |
| U5 core (24 composites + 3 alignments) | done | `firestore.indexes.json`, `modifyScheduleFlow.ts`, `issueEscalator.ts`, `latenessTracker.ts` |
| U2 billing | done | `mcp/server.ts` (get_billing_summary→clientId), `scheduled/proactiveReflection.ts` (canonical invoices+payments, data-minimized) |
| U4 legacy retirement | done | `services/api.ts`, `components/caregiver/CaregiverPayments.tsx`, `functions/src/notifications.ts`, `firestore.rules`, `firestore.indexes.json` |
| U6 TTL migration | done | `memory/memoryOperations.ts` (expiresAt→Timestamp), `scheduled/nightlyMemory.ts` (cleanup fn removed), `firestore.indexes.json` (TTL overrides) |
| U7 embedding exemptions | done | `firestore.indexes.json` (4 embedding `indexes:[]`), `firestore.rules` (linq_message_index deny) |
| U3 notification delivery (core) | done | `notifications/userNotification.ts`, `triggers/notificationTriggers.ts`, `index.ts` (onReviewWritten), 8 browser peer-writes removed, `firestore.rules` |

### Follow-ups — now implemented (2026-07-20, second pass)
- **U2 Linq provider-message map** ✅ — `functions/src/linq/providerMessageIndex.ts`
  (hashed key, reference-only, send-first/webhook-first convergence, 24h/365d TTL);
  `webhooks.ts` delivered/sent/edited rewritten to hashed direct lookups (no root
  `agent_conversations` query); send path (`client.ts` + `threadMirror.ts`)
  registers every provider part id against the canonical refs. Tests:
  `providerMessageIndex.test.ts` (8).
- **U5 state matrix** ✅ (functional) — error-vs-empty + retry in
  `useCaregiverCallout` (Q23), `CaregiverCareRequestsCard` (Q21), `AuditDashboard`
  (Q20) with `role="alert"` unavailable notices. Backend: the compound Q1–Q26
  queries already propagate errors (no false-empty); proactiveReflection billing
  reports unavailable vs empty.
- **U3 recurring-group owner** ✅ — `appointmentUpdated.ts` now notifies the CLIENT
  on booking-confirmed, keyed by `recurringGroupId` so the per-appointment trigger
  firings dedupe to ONE notification; `confirmRecurringGroup`/`declineRecurringGroup`
  browser peer-writes removed.

### Still remaining (deliberately deferred)
- **U5 admin client/caregiver detail (Q19/Q24)** state matrix in the components
  that consume `adminService.getClient/CaregiverAppointments` — same pattern as
  above, admin-only surfaces.
- **`failurePolicy:true` retry** on notification triggers + migrating the generic
  `dbService.createNotification` / `useNotifications` helpers to the server-owned
  idempotent writer. Enabling retry is safe ONLY once every `addNotification`
  call in a given trigger is idempotent (the new owners already are via
  `writeUserNotification`); the legacy `addNotification` `.add()` calls in
  `notificationTriggers.ts` / `notifications.ts` would duplicate on retry until
  migrated. Do that migration first, then flip `failurePolicy`.

## Pre-flight (do first, every time)

1. `git` — branch from current HEAD (`fix/memory-wave-hotfixes`; origin/main now == `4f3aa35`).
2. Re-run local↔live index compare; the 122/119 snapshot is stale (local is now 143 composites + 12 field overrides). Treat any LIVE-ONLY composite as a caller to hunt before the final-manifest deploy (which would delete it), not as noise.
3. Re-run production metadata counts (counts only, no doc bodies) to confirm the LEGACY collections are still zero: `timesheets`, `media_updates`, `peer_recognitions`, `caregiver_of_month`, `videoInterviews`, `billing_events`. A nonzero count on any stops only that slice. NOTE: `memory_operations` is NOT legacy — the live memory wave writes it every turn; expect it nonzero and run the U6 migration below instead.
4. Diff live Functions env VALUES against local `.env` before any full Functions deploy (a partial `.env` full deploy wipes secrets).
5. Build/test HEAD: `npm.cmd --prefix functions run build`; the focused vitest suite (see below). Note `tsc --noEmit` on `functions/` times out locally — rely on transpile + focused tests.

## Ordered deployment

### Step 1 — Additive indexes (create-only, safe)
```
node scripts/deploy-firestore-additive-indexes.mjs --project careconnex-d4c8b            # dry run, review Q1-Q26 create list
node scripts/deploy-firestore-additive-indexes.mjs --project careconnex-d4c8b --apply     # create missing composites
gcloud firestore indexes composite list --project careconnex-d4c8b                        # wait until ALL new indexes are READY
node scripts/audit-firestore-query-contracts.mjs --project careconnex-d4c8b --live        # planner sweep: every contract PASS
```
Do not proceed to dependent Functions until every Q1–Q26 index is `READY`.

### Step 2 — Functions (depends on READY composites + owns notifications)
Deploy with `FUNCTIONS_DISCOVERY_TIMEOUT` as plain seconds (no "s" suffix) and env parity.
This ships: the aligned queries (Q5 etc.), U2 billing, U6 memory_operations Timestamp
writes + removed cleanup, and U3 notification owners (onShiftStatusChanged extra-visit,
onReviewWritten review, userNotification writer).
Verify exact affected function update times after deploy.

**A1 ordering (memory_operations):** the code already (a) writes `expiresAt` as a
Timestamp and (b) removed `cleanupExpiredMemoryOperations`. The `(status, expiresAt)`
composite is already removed from the local manifest. Correct live order:
1. Deploy Functions (Timestamp writes live; cleanup fn gone). Do NOT run any
   `firebase deploy --only firestore:indexes` (which deletes the composite) before
   this — the still-deployed nightly sweep would throw failed-precondition.
2. Run the expiry migration: `node scripts/migrate-memory-operation-expiry.mjs
   --project careconnex-d4c8b` (dry run, review type-class counts), then `--apply`.
   The live memory wave writes this collection every turn, so completed docs with
   ISO-string `expiresAt` WILL exist — without migration they are TTL-immortal
   (TTL skips non-Timestamp fields and the manual sweep is gone).
3. Enable the `memory_operations.expiresAt` TTL policy (Step 4).
4. The composite is dropped in the final-manifest deploy (Step 5) — it is no longer
   queried by anything once the cleanup fn is gone, so removal is safe.

### Step 3 — Rules + Hosting (only AFTER notification owners are live)
- `firestore.rules`: notifications subcollection now denies owner hard-delete and
  cross-user create; timesheets rule removed; `linq_message_index` client-denied.
- Hosting: ships the browser bundle with the 8 peer-writes removed and the JobBoard
  misleading-toast fixed. Frontend build needs `NODE_OPTIONS=--max-old-space-size=8192`.
- Verify both domains: `careconnex-d4c8b.web.app` and `eviacares.com`.

### Step 4 — TTL policies (one at a time, after per-policy proof)
For EACH of the seven (`agent_audit_log.ttl`, `agent_action_ledger.ttl`,
`user_activity_feed.ttl`, `linq_outbound_queue.ttl`, `agent_imessage_retry.ttl`,
`memory_operations.expiresAt`, `linq_message_index.ttl`):

⚠️ `linq_message_index` is born with the FIRST webhook receipt after the Functions
deploy, and every unregistered send buffers a 24h unresolved doc there — without
its TTL policy the collection grows unbounded at outbound-message rate. Create
that policy IMMEDIATELY after first traffic (same discipline as the
missing-invoker IAM check) and verify with `gcloud firestore fields ttls list`.
TTL deletion also lags expiry by up to ~72h — a green policy is not yet a swept
collection.
1. Census the field TYPE in production (must be Timestamp) and project already-expired /
   24h / 7d / 30d counts. An unexpected type or already-expired population stops ONLY
   that policy (backup/export first).
2. Enable it (gcloud or console), verify with `gcloud firestore fields ttls list`.
Do not bulk-deploy `ttl:true` via the index file before this proof — enable per-policy
first so the final index deploy is a no-op for TTL.

### Step 5 — Final manifest (exact-diff, evidence-gated)
```
npx firebase-tools deploy --only "firestore:indexes,firestore:rules" --dry-run --project careconnex-d4c8b
```
Review the exact create/delete/override diff. It should show ONLY: the 4 embedding
exemptions, the (already-enabled) TTL overrides, and the stale-composite removals whose
preflight passed (memory_operations status+expiresAt, both camelCase videoInterviews).
It must NOT remove `facts.fingerprintKeyVersion` (Amendment A2 — load-bearing for the
key-rotation runbook). Then deploy for real.

## Verification / smokes (Step 6)
- Post-deploy planner sweep: `node scripts/audit-firestore-query-contracts.mjs --project careconnex-d4c8b --live` → all PASS.
- Client + caregiver flows create exactly one recipient notification each (booking,
  cancel, application, interview, message, review, extra-visit accept/decline —
  extra-visit decline now notifies the CLIENT, previously the caregiver).
- Billing summary shows invoices (clientId) + payments (userId).
- `gcloud firestore fields ttls list` shows the enabled policies on the right fields.
- 60-minute log watch (missing-index, permission-denied, notification retry/dup), 24h
  scheduled-path review, 7-day query-contract observation.
- Report local branch/SHA, remote branch/SHA, `origin/main` SHA, live function update
  times, Hosting release, and any deferred deployment.

## Focused test suite (run before any deploy — in TWO batches, one run OOMs)
```
# Batch 1
npx vitest run \
  tests/firestoreIndexCoverage.test.ts tests/firestoreCanonicalPaths.test.ts \
  tests/firestoreFieldOverrides.test.ts tests/firestoreTtlContract.test.ts \
  tests/contractCollections.test.ts \
  functions/src/notifications/__tests__/userNotification.test.ts
# Batch 2 (includes the two files broken-and-fixed by the expiresAt type change —
# memoryOperationWorker + learnedFacts MUST stay in this gate)
npx vitest run \
  functions/src/mcp/__tests__/billingPaymentFixes.test.ts \
  functions/src/scheduled/proactiveReflection.test.ts \
  functions/src/memory/memoryOperations.test.ts \
  functions/src/scheduled/nightlyMemory.test.ts \
  functions/src/scheduled/memoryOperationWorker.test.ts \
  functions/src/memory/learnedFacts.test.ts \
  functions/src/linq/__tests__/providerMessageIndex.test.ts \
  functions/src/linq/__tests__/outboundHistory.test.ts
node scripts/audit-firestore-query-contracts.mjs   # local --check
```
