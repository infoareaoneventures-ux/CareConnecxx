# Handoff — Evia Memory Continuity & Grounding Hardening

**Purpose:** hand this implementation off to another agent (e.g. GPT 5.6) to finish.

## Completion update - 2026-07-19 PT / 2026-07-20 UTC

This handoff has been completed to the implementation and production-deployment boundary. The original snapshot below is preserved for audit history, but its branch, push, review, and deploy status is superseded by this section.

- Review findings and owed code follow-ups were revalidated and resolved in implementation commit `1f5dd741485558a4b7eb1c2dcc0b3ae9fbd7be3c`.
- The feature branch and `origin/main` were pushed to that implementation commit before completion documentation.
- The Zep provider contract passed after strict idempotency and facts-only template fixes.
- The `lastMessageAt` backfill completed and converged to zero remaining updates.
- All three required Firestore indexes are `READY`.
- The exact fingerprint secret is enabled and bound to the three consumers.
- The generated 151-function deployment completed; all 151 are `ACTIVE`.
- The one-minute memory worker is enabled and healthy.
- A live synthetic forget operation passed through the real scheduled worker and proved masking, cross-store deletion, tombstone retention, reconciliation, audit, and cleanup.
- Hosting was not deployed because no frontend artifact changed, as required by the rollout runbook.
- The only remaining plan acceptance item is a fresh-number SMS correction/forget/recall and multi-recipient disambiguation test. It requires a designated test phone/account and is not a code or deployment blocker.

Full evidence and the separate production issues found during final monitoring are recorded in [`docs/reports/2026-07-20-evia-memory-grounding-hardening-completion.md`](../reports/2026-07-20-evia-memory-grounding-hardening-completion.md).
**Original plan (authoritative spec):** [`docs/plans/2026-07-17-002-fix-evia-memory-grounding-hardening-plan.md`](2026-07-17-002-fix-evia-memory-grounding-hardening-plan.md) — read it in full first; it defines requirements R1–R23, decisions KTD1–KTD16, units U1–U9, and the verification/deployment/rollback contract. This handoff only tracks *state and remaining work* against that spec.

**Date:** 2026-07-19
**Branch:** `fix/evia-memory-grounding-hardening`
**HEAD:** `2a351be8acc6fe50a081fc5c6921e0255e8caae1`
**Base:** `ea843eff108825d7731379509d7c3390a3f4849e` (== origin/main at start; the plan's `reviewed_against_commit`)
**Pushed?** No. 13 commits ahead of `origin/main`, nothing pushed. Nothing deployed. No production change.
**Firebase project:** `careconnex-d4c8b`

---

## ⚠️ Read first: working-tree anomaly

The working tree is **NOT clean**. Three files are modified but uncommitted, and they were **not** produced by the implementation commits below or by the code review (reviewers are read-only):

- `functions/src/memory/learnedFacts.ts` — substantive change: imports `unwrapJson` from a new `../utils/jsonUtils`, and rewrites `findBlockingFactDoc` to check the deterministic doc id, a legacy `_norm` query, and a `forgottenFingerprint` query in parallel.
- `functions/src/linq/__tests__/routeIntent.characterization.test.ts` — 3-line change.
- `scripts/generate-deploy-manifest.mjs` — large rewrite (~203 lines changed).

Two untracked plan docs from another session are also present:
`docs/plans/2026-07-18-001-feat-evia-evidence-driven-intelligence-plan.md`,
`docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md`.

**A concurrent session/agent has been editing this repo.** Before doing anything, the finishing agent must: (1) decide whether those three uncommitted edits are wanted (they may depend on `../utils/jsonUtils`, which must exist and build), (2) run `npm --prefix functions run build` to confirm they compile, and (3) either commit or revert them so the tree is in a known state. Do **not** blindly `git add .`.

---

## What is DONE (committed on the branch)

All 9 implementation units are implemented and committed. Each was verified (targeted vitest + `functions` build) before commit.

| Commit | Unit | Summary |
|---|---|---|
| `3b4d02a` | U1 | Typed Zep outcomes (`loaded`/`empty`/`unavailable`/`timeout`); cleared timeout timer + SDK `abortSignal`; strict vs. best-effort write adapters; privacy-safe Zep logs |
| `ccbde58` | U2 | `lastMessageAt` server-timestamp at verified ingress; client-only nightly selection via composite index; per-user failure isolation; dry-run-first backfill script; runbook stub |
| `e7f1103` | U3a | `memory_operations` ledger on the reused `externalSideEffect` lease engine; 1-min retry worker; deterministic turn persistence; learned-fact idempotency; compression skips unsynced rows |
| `8d1ceeb` | U3b | Web/SMS completed turns routed through one `persistCompletedTurn` owner (adopt-existing-rows mode); duplicate `routeIntent` tail removed; onboarding/business writes preserved (source-scan pinned) |
| `e9cb6cd` | U4a | Correction/forget detection + staging; reader-level suppression (all shared readers); HMAC tombstones + shared normalization; in-turn re-remember confirmation; KTD10 copy |
| `fe945bd` | U4b | Cross-store propagation (Storage/embeddings/Zep edges+episodes); MCP delete/edit identity validation; durable `agent_audit_log` events; caregiver-branch masking closed |
| `2232a8d` | U5 | Topic-aware `getRelevantFacts(userId, text)`; honest prompt label; identity gating preserved |
| `03fe808` | U6 | Canonical `senior_profiles` repository, `seniors` fallback only; prefetch writer + MCP reads unified; briefing can't override canonical; isolation intact |
| `c389449` | U7 | Risk-tier grounding: pure claim classifier, typed `supported/unsupported/indeterminate` verifier, current-inbound evidence block, fail-closed neutral copy, telemetry redaction, `GROUNDING_RISK_TIERS_ENABLED` kill switch |
| `8bd5a22` | U8 | Transient tool-file isolation (`memoryClass=transient_tool` + `expiresAt`); nightly 24h cleanup; excluded from all default retrieval; repaired 46 pre-existing broken-mock tests |
| `636221a` | — | Golden replay harness answers grounding verifier `SUPPORTED` (grounded controls) |
| `2a351be` | U9 | Rollout runbook completed; sustained-outage + aged-op dedup alerts; nightly completed-op cleanup; `scripts/generate-deploy-manifest.mjs` |
| `f6c0377` | — | The reviewed plan doc itself |

### Quality gates — all PASSED
- **Broad regression** (run in two halves — full-tree run OOMs): shard 1 = **1693 passed**; shard 2 = **1649 passed / 8 skipped**. One flake (`permissionsConversation.test.ts`, pre-existing 2026-07-15 test, outside this change) passed clean on immediate rerun.
- **Root typecheck** clean. **Root build** clean with `NODE_OPTIONS=--max-old-space-size=8192`. **Functions build** clean (337 files, 0 errors).

---

## What is LEFT

### 1. Finish the Tier-2 code review (BLOCKED on usage limit, resets 6:10 PM PT 2026-07-19)
Run ID `20260719-124757-939a6efd`. Artifacts dir: `C:\Users\Anahi\AppData\Local\Temp\compound-engineering\ce-code-review\20260719-124757-939a6efd\` (ephemeral — may be gone; re-run if absent).

- **Completed (4):** testing, maintainability, reliability, performance — findings below.
- **NOT finished (7):** correctness, security, adversarial, data-migration, project-standards, agent-native, learnings — all hit the session usage limit before writing artifacts. **These are the highest-value reviewers** (correctness/security/adversarial) for a change touching PHI forget-semantics and a payment-claim grounding gate. Re-run them: `Skill ce-code-review` with `mode:agent plan:docs/plans/2026-07-17-002-fix-evia-memory-grounding-hardening-plan.md base:ea843eff108825d7731379509d7c3390a3f4849e`, or dispatch those 7 personas directly against the diff `git diff ea843eff10`.

### 2. Address completed-reviewer findings (none are P0; all verified real)
- **[P1, testing]** `functions/src/agents/qaAgent.ts` re-remember confirmation branch (~L1679) has only source-scan coverage — add behavioral tests (seed `pendingReRememberFactId` session; assert confirm→`RE_REMEMBER_CONFIRMED_COPY`, reconciliation-pending→blocked copy, decline→turn continues, expired→classifier not called).
- **[P1, testing]** Full-path `GROUNDING_RISK_TIERS_ENABLED=false` fallback (~qaAgent L3015) never executed by a test — add a behavioral kill-switch-off test mirroring the quick-path one.
- **[P2, reliability+performance]** `cleanupExpiredTransientToolFiles` (`memoryFiles.ts`) lists the entire Storage `memory/` prefix unpaginated nightly — bound it with `maxResults`/`pageToken` like the paginated nightly consolidation.
- **[P2, reliability]** Sustained Zep-outage alert window is per-instance in-memory (`caraOpsAlerts.ts`) — cold starts/fan-out can wipe it before it fires; consider a Firestore per-minute counter.
- **[P2, reliability+perf]** Per-user `turn_sync` ordering query in `memoryOperationWorker.ts` is unbounded — add `.limit()` matching `LEGACY_SOURCE_SCAN_LIMIT`, alert when a user's backlog exceeds cap.
- **[P2, performance]** `detectAndStageFactChange` now runs on every confirmed-identity user turn (up to 200-fact scan + larger LLM call) serially ahead of the `Promise.all`; `FACT_CORRECTION` turns pay it twice (routeIntent + qaAgent). Consider gating/parallelizing.
- **[P2, maintainability]** `errorClassOf` ternary reimplemented in ~9 files — extract one `functions/src/utils/errorClass.ts`.
- **[P3, maintainability]** `addAssistantMessageToZep` legacy alias has no remaining caller after the routeIntent tail removal — delete or document.

### 3. Owed follow-ups flagged during implementation (from unit reports)
- **`functions/src/agents/caraAgent.ts` `extractAndStoreFacts`** (legacy memory-agent path) takes a `zepUserId` and has no turn-key provenance — review against R8/KTD8 (was outside U3b/U4 scope but inventoried by the one-owner source scan).
- **Fresh-number end-to-end** (the recurring "OWED" item across prior waves): a real correction/forget + recall E2E on a new phone number, and mom-and-dad multi-recipient forget disambiguation.

### 4. Synthesize → validate → apply (ce-work Phase 3)
After the 7 reviewers finish: merge/dedup/confidence-gate, run the per-finding validation pass, apply confirmed fixes, re-run affected tests. Then the Residual Work Gate.

### 5. Ship
- `ce-commit-push-pr` (or `ce-commit`) — final commit + push the branch. **Not yet pushed.**
- PR body must include the **Post-Deploy Monitoring & Validation** section (metrics/log queries/rollback triggers).

### 6. Deploy — STOP for explicit human approval first (per plan Stop Conditions)
Follow [`docs/runbooks/evia-memory-rollout.md`](../runbooks/evia-memory-rollout.md) exactly, in order:
1. **Predeploy:** branch/SHA/origin check; **diff `.env` VALUES** (partial-.env full deploy wipes secrets); project `careconnex-d4c8b`.
2. **Indexes first:** deploy `firestore:indexes`, poll all 3 new composite indexes to `READY` before functions.
3. **Zep provider contract probe** (non-prod): same-UUID-twice idempotency + edge-invalidation/episode-deletion verification. **This gate blocks the exactly-once claim** — run it before Wave B.
4. **`MEMORY_FINGERPRINT_KEY`:** provision via Secret Manager (repo's first `defineSecret`) before Wave B; forgets stay safely masked-and-retryable until it exists. Rotation procedure is in the runbook.
5. **Backfill:** `node scripts/backfill-agent-session-last-message-at.mjs` dry-run → review counts → `--apply` → re-dry-run (`would update = 0`).
6. **Deploy manifest:** `node scripts/generate-deploy-manifest.mjs` → deploy the listed functions (142 affected; incl. `linqWebhook`, `chatWithCara`, `consolidateMemoryNightly`, `memoryOperationWorker`, `runTriggerEngine`). Set `FUNCTIONS_DISCOVERY_TIMEOUT` (plain seconds). Verify `allUsers` invoker on any newly-created callable (past 403 gotcha).
7. **Wave A smokes** → observe metrics → **Wave B smokes** (correction, forget incl. no-resurrection pass, canonical profile, grounding neutralization, tool-offload TTL).
8. Do **not** deploy Hosting unless frontend artifacts changed (they didn't).

---

## Verification commands (this machine's known-good invocations)
- Targeted tests: `npx vitest run <paths>` or `npm test -- --run <paths>` (add `--pool=forks --no-file-parallelism` if worker-spawn timeouts).
- **Never** run the full suite in one shot — it OOMs. Two halves: `npm test -- --run --shard=1/2 --pool=forks --no-file-parallelism` then `--shard=2/2`.
- Functions build: `npm --prefix functions run build`.
- Root safety: `npm run typecheck` then `NODE_OPTIONS=--max-old-space-size=8192 npm run build`.
- Known pre-existing flake: `permissionsConversation.test.ts` (rerun to confirm green).

## Definition of Done (from the plan — verify all before closing)
R1–R23 satisfied; nightly no longer depends on an unwritten field and can't process caregivers; Zep states distinct; web/SMS parity; retries don't duplicate rows/facts/Zep messages (provider contract proven out-of-prod); onboarding memory + business events intact; corrections below top-10 selectable; pending correction/forget masks stale sources immediately; completed forget leaves no plaintext anywhere but the tombstone; corrected/forgotten facts not recreated by extraction/compression/nightly; topic retrieval wired + honest label; `senior_profiles` canonical + MCP isolation intact; high-risk unsupported claims neutralized, grounded ones pass; transient files never enter default memory + cleaned at 24h; telemetry content-free; indexes `READY` before dependent functions; backfill evidence recorded; Wave A/B smokes pass; final report states local/remote/origin SHAs, deployed fn update times, index state, smoke results, and every deferred item.
