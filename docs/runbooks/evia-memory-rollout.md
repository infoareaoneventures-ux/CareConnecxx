# Evia Memory Hardening Rollout

Runbook for the memory-grounding hardening waves
(docs/plans/2026-07-17-002-fix-evia-memory-grounding-hardening-plan.md).
Firebase project: `careconnex-d4c8b`. This is a stub created by U2 — sections
marked `TODO (Ux)` are completed by later units. No secrets or user content
belong in this file.

## 1. Index-first deploy order (U2)

The nightly memory query and the U3 operation worker depend on composite
indexes. **Indexes deploy and reach READY before any dependent function.**

```
# From the repo root (sole deploy folder — CareConnecxx-main):
node_modules/.bin/firebase deploy --only firestore:indexes --project careconnex-d4c8b
```

Poll until READY (repeat until no CREATING rows remain):

```
node_modules/.bin/firebase firestore:indexes --project careconnex-d4c8b
# or, with gcloud:
gcloud firestore indexes composite list --project careconnex-d4c8b --format="table(name,state)"
```

Indexes this rollout requires:

- `agent_sessions`: `onboardingStep ASC, optedOut ASC, userType ASC, lastMessageAt DESC` (U2)
- `memory_operations`: `status ASC, nextRetryAt ASC` — TODO (U3)
- `memory_operations`: `status ASC, expiresAt ASC` — TODO (U3)

Only after every required index reports READY may Wave A functions deploy.

## 2. Activity backfill (U2, Backfill Gate)

Prerequisite: `npm --prefix functions run build` (the script imports the
compiled decision module from `functions/lib`).

1. Dry run against production:

   ```
   node scripts/backfill-agent-session-last-message-at.mjs
   ```

2. Review the aggregate counts (this is the ONLY output — no IDs, no content):
   `scanned`, `completed`, `explicit clients`, `caregivers excluded`,
   `ambiguous role`, `already populated`, `recent history`, `stale history`,
   `no history`, `would update`.

3. Record explicit production approval for the reviewed counts, then apply:

   ```
   node scripts/backfill-agent-session-last-message-at.mjs --apply
   ```

4. Re-run the dry run and require `would update = 0` (idempotency proof).

Notes: only evidence within the last 7 days is written; a missing `userType`
is repaired only from an explicit canonical role on `users/{userId}`;
ambiguous sessions stay excluded (counted under `ambiguous role`). The
backfill is never reversed on rollback — it records evidence-derived
timestamps only.

## 3. Zep UUID provider contract probe — TODO (U3)

Non-production probe proving deterministic message-UUID idempotency
(same UUID sent twice stores one message) per the plan's Provider Contract
Gate. Record counts and UUID hashes only; delete the synthetic thread.

## 4. Secret provisioning — TODO (U4/U9)

`MEMORY_FINGERPRINT_KEY` via Firebase Secret Manager, bound only to
tombstone-computing functions; key-rotation procedure with
`fingerprintKeyVersion` retention rules.

## 5. Wave A smokes — TODO (U3/U9)

Web/SMS parity, Zep empty vs unavailable, nightly selection with a synthetic
recent client (caregiver and opted-out client excluded), retry non-duplication.

## 6. Wave B smokes — TODO (U9)

Correction/forget, canonical profile, high-risk grounding, tool-offload TTL.

## 7. Monitoring — TODO (U9)

zepContextStatus distribution, turn-sync operation ages, nightly
eligible/attempted/succeeded/failed/skipped counts (aggregate-only; the U2
scheduler already logs `[consolidateMemoryNightly] memory batch` with these
counts), correction/forget pending ages, privacy assertion (no raw content in
any new log/metric).

## 8. Rollback — TODO (U9)

Revert implementation commits and redeploy the shared-module manifest from the
prior known-good SHA. Leave additive indexes and `lastMessageAt` fields in
place — old code ignores them. Do not reverse the activity backfill.

## 9. Force-resolve procedure for terminal operations — TODO (U9)

Inspect per-target statuses, force-finalize with a recorded accepted-risk
decision, verify suppression state afterward.
