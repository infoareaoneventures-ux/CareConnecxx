# Evia Memory Continuity and Grounding Hardening - Completion Report

**Local date:** 2026-07-19 PT
**Deployment date:** 2026-07-20 UTC
**Firebase project:** `careconnex-d4c8b`
**Implementation commit:** `1f5dd741485558a4b7eb1c2dcc0b3ae9fbd7be3c`

## Verdict

The U1-U9 implementation, review fixes, production data preflights, Firestore indexes, and affected Cloud Functions are complete and deployed. The live cross-store forget path passed with synthetic data through the real scheduled worker.

One acceptance item remains operational rather than code-blocking: a fresh-number SMS correction/forget/recall test, including mom-and-dad disambiguation, needs a designated test phone/account. No arbitrary production user was used.

## Delivered Scope

- Typed Zep `loaded`, `empty`, `unavailable`, and `timeout` outcomes with strict write behavior.
- Verified activity timestamps, client-only nightly selection, and dry-run-first backfill.
- Durable `memory_operations` ledger, ordered retries, exactly-once turn/fact behavior, and bounded backlog handling.
- Shared web/SMS completed-turn persistence.
- Correction and forget staging, immediate reader masking, keyed tombstones, re-remember confirmation, and reconciliation.
- Cross-store deletion for Firestore, Storage, embeddings, and Zep edges/episodes.
- Topic-aware learned-fact retrieval and honest prompt labels.
- Canonical `senior_profiles` reads with legacy fallback only.
- Risk-tier grounding with fail-closed neutralization and a rollout kill switch.
- Transient tool-file isolation and paginated 24-hour cleanup.
- Firestore-backed Zep outage aggregation, bounded worker scans, durable audits, and deployment manifest generation.
- Review fixes for create-on-claim side-effect leases, rate-limit activity stamping, secret bindings, rollup masking, paginated cleanup, reconciliation overflow, direct memory-file reads, dual-active facts, and shared error classification.
- Provider fixes for Zep message idempotency and forgotten-fact resurrection through summary/template context.

## Verification

- Focused final regression suite: 17 files, all passed.
- Zep adapter and worker tests: 74 passed.
- MCP and memory-pipeline tests: 74 passed.
- Source-contract tests: 30 passed.
- Functions build: 338 files transpiled, 0 errors.
- Root `npm run typecheck`: passed.
- Root production build with an 8 GB Node heap: passed.
- `git diff --check`: passed.
- Broad regression shards were green except one pre-existing timing flake that passed on immediate isolated rerun; one stale MCP fixture was corrected and its 74-test suite passed.

## Provider and Data Gates

The isolated Zep contract probe passed:

- User copies after duplicate UUID write: 1.
- Assistant copies after duplicate UUID write: 1.
- Total messages: 2.
- Edge count before forget: 1.
- Episodes deleted: 1.
- Matching edges after forget: 0.
- Forgotten fact returned by context after forget: false.
- Synthetic provider resources deleted: yes.

The `agent_sessions.lastMessageAt` backfill completed:

- Initial dry run: 7 scanned, 2 explicit clients, 3 caregivers excluded, 2 ambiguous, 3 would update.
- Apply: 3 updated.
- Final dry run: 3 already populated, 0 would update.

## Production Deployment Proof

Three required composite indexes are `READY`:

- `agent_sessions`: `onboardingStep ASC`, `optedOut ASC`, `userType ASC`, `lastMessageAt DESC`.
- `memory_operations`: `status ASC`, `nextRetryAt ASC`.
- `memory_operations`: `status ASC`, `expiresAt ASC`.

The generated manifest selected 151 affected functions. All 151 were found `ACTIVE` after deployment. Update times ranged from `2026-07-20T01:37:33.5455895Z` to `2026-07-20T01:42:41.4370000Z`.

Critical function evidence:

| Function | State | Update time (UTC) |
|---|---|---|
| `v1-chatWithCara` | ACTIVE | `2026-07-20T01:40:39.476Z` |
| `v1-linqWebhook` | ACTIVE | `2026-07-20T01:42:28.221Z` |
| `v1-consolidateMemoryNightly` | ACTIVE | `2026-07-20T01:38:45.821Z` |
| `v1-memoryOperationWorker` | ACTIVE | `2026-07-20T01:37:33.545589475Z` |
| `v1-runTriggerEngine` | ACTIVE | `2026-07-20T01:40:59.627Z` |
| `v1-drainLinqOutboundQueue` | ACTIVE | `2026-07-20T01:39:06.211Z` |

`v1-MEMORY_FINGERPRINT_KEY` version 1 is enabled and bound to `v1-chatWithCara`, `v1-linqWebhook`, and `v1-memoryOperationWorker`. No secret value is recorded here.

The memory worker scheduler is `ENABLED`, runs every minute in `America/Los_Angeles`, and continued completing with status `ok` after the smoke test. No severity `ERROR` entries were found for the six critical functions in the post-deploy 30-minute window.

## Live Forget Smoke

An isolated synthetic production operation was processed by the real scheduled worker in 90.6 seconds:

- Operation completed on attempt 1.
- Every target completed or safely skipped.
- Plaintext removed and key-version-1 fingerprint retained.
- Storage fact absent.
- Zep matching edges: 0.
- Zep context did not return the forgotten fact.
- Reconciliation flag cleared.
- Durable audit entry written.
- Synthetic Firestore, Storage, audit, embedding, thread, and Zep resources cleaned up.

## Hosting and Remaining Operations

Hosting was intentionally not deployed because this rollout contains no frontend artifact changes and the runbook explicitly excludes Hosting. The live channel's last release remains `2026-07-17 22:18:31`.

Remaining acceptance work:

- Run fresh-number correction, forget, later recall, and multi-recipient disambiguation through real SMS once a designated test number/account is available.
- Monitor memory-operation retry age, Zep outage counters, and grounding neutralizations during normal traffic.

Separate production debt discovered during the final broad log sweep:

- `v1-processDndQueue` is failing on a missing `agent_dnd_queue(sentAt ASC, sendAfter ASC)` composite index. This belongs to the separate Firestore index/data-integrity hardening scope, not this memory rollout.
- Upgrade the outdated `firebase-functions` dependency and migrate away from deprecated `functions.config` before March 2027.
