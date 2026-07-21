# Evia Intelligence Rollout Runbook

Plan: `docs/plans/2026-07-18-001-feat-evia-evidence-driven-intelligence-plan.md`
Owner: founder (imran@angelicare.com). Status: **U0 in progress, U1 implemented (awaiting deploy)**.

## Baseline Record (U0)

| Item | Value |
|---|---|
| Frozen source baseline | `9f4adf8` (post-Firestore-hardening; plan frontmatter updated) |
| U1 implemented at | `42c7b70` — tri-state care signals + future-safe next appointment |
| Prerequisites | Memory hardening DEPLOYED 07-20 (completion report); Firestore hardening DEPLOYED 07-21 (143 composites READY, planner 26/26, 7 TTLs ACTIVE) |
| Functions semantic typecheck | `npm --prefix functions run typecheck` — **GREEN on all shipped code** (repaired 07-21: all 38 production-source errors fixed; gate = zero errors via `tsconfig.typecheck.json`, which excludes test files). `npm run typecheck:all` includes tests and carries 128 legacy mock-idiom errors as tracked burn-down debt — those files execute under vitest/esbuild and never ship. |
| Test gate | Vitest; broad suite must run as two shards (`--shard=1/2`, `--shard=2/2`, `--pool=forks --no-file-parallelism`) — full single-run OOMs. |

## Control Plane (U0 — implemented)

### Rollout policies — `evia_rollout_policies/{capability}`

Server-only (client access denied by the rules catch-all). Written by founder tooling only.
Modes: `off | shadow | canary | partial | full`. `canary`/`partial` REQUIRE `expiresAt`
and use deterministic cohorts (`cohortPercent`, `cohortSeed`). Everything about a missing,
malformed, expired, or unreadable policy **fails closed to off** (`functions/src/config/rolloutPolicy.ts`).

Capability slugs (initial): `care_situation` (U2), `objective_ledger` (U3), `turn_lifecycle` (U4),
`action_evidence` (U5), `tool_packs` (U6), `temporal_evidence` (U7), `proactive_engine` (U8),
`eval_flywheel` (U9), `reasoning_escalation` (U10), `routing_convergence` (U11).

### Emergency controls

- **Global kill switch:** set env `EVIA_INTELLIGENCE_EMERGENCY_OFF=true` on affected functions and redeploy config. Checked on EVERY call, never cached — beats any Firestore policy.
- **Per-capability disable:** `EVIA_INTELLIGENCE_DISABLE=cap1,cap2`.
- Environment can only turn capabilities OFF; enabling requires the Firestore policy. No umbrella enable flag exists.

### Rollback SLA

Policy cache TTL is 60s (`ROLLOUT_CACHE_TTL_MS`): flipping a policy to `off` propagates to
warm instances within 60s, cold instances immediately. Admin tooling that writes a policy
should also call `invalidateRolloutCache(capability)` in-process where applicable.
Emergency-off env propagates on the next request after config deploy.

### Eval environment guard

`functions/src/evals/evalEnvironmentGuard.ts` — `assertSafeEvalEnvironment()` must be the
FIRST call in every write-capable eval/trajectory entry point. Refuses production project
`careconnex-d4c8b`, live Stripe keys, production database URLs, and any environment without
a provable project id. **No bypass flag exists; do not add one.**

### Telemetry pseudonyms

`functions/src/observability/intelligencePseudonym.ts` — dedicated `INTELLIGENCE_TELEMETRY_KEY`
secret (versioned, purpose-separated HMAC-SHA256; NEVER `MEMORY_FINGERPRINT_KEY`).
Provision before first telemetry consumer deploys:
`firebase functions:secrets:set INTELLIGENCE_TELEMETRY_KEY` (32+ random bytes).
Every consuming deployed function binds it via `runWith({ secrets: [INTELLIGENCE_TELEMETRY_KEY_SECRET] })`;
`functions/src/__tests__/intelligenceTelemetrySecretBindings.test.ts` fails the build when a
consumer forgets. Key unavailable ⇒ telemetry record is DROPPED, never emitted unhashed.

## Firestore Index Workflow

Every new/changed compound query follows the plan's "Firestore Index And Query Workflow"
section verbatim: contract entry + additive index edit in the same commit → `node
scripts/audit-firestore-query-contracts.mjs` + `tests/firestoreIndexCoverage.test.ts` green →
at deploy: additive dry-run → `--apply` → poll READY → `--live` planner PASS → functions.
Full `firestore:indexes` replacement is prohibited outside a founder-reviewed preflight.
U1 registered Q27 (appointments clientId+status+date ASC — composite already live).

## Behavioral Rubric v0.1 — DRAFT (founder must ratify before U2+ tuning)

Rubric changes after ratification require a new version and cannot retroactively approve a wave.

| Capability slice | Weight | Floor (non-negotiable) | Measured by |
|---|---|---|---|
| Wellness factuality | 12% | 100% tri-state fixtures; zero unknown-as-negative canaries | U1 suites + production canary |
| Cross-channel memory/state | 12% | 100% synthetic parity; ≥95% context resolution | U2 suites + smokes |
| Clarification quality | 8% | ≥95% one-question cases | U3 suites |
| Tool selection | 10% | ≥90% required-tool trajectories; zero authority leaks (floor) | U6 shadow + evals |
| Multi-step completion | 14% | ≥90% verified final-state success; zero duplicate writes (floor) | U4/U5 replay + evals |
| High-risk grounding | 12% | Zero unsupported high-risk claims (floor) | existing verifier + U10 |
| Proactive precision | 6% | ≥80% reviewer approval; zero DND/opt-out breaches (floor) | U8 calibration |
| Proactive recipient value | 6% | Positive outcomes ≥ frozen category baseline | U8 production window |
| Caregiver marketplace flow | — | NON-COMPENSABLE FLOOR: signup→eligible→visible→bookable green | synthetic E2E |
| Family marketplace flow | — | NON-COMPENSABLE FLOOR: need→match→book→paid green, no authority leak | synthetic E2E |
| Adaptive reasoning | 5% | Credible gain within latency/cost ceiling, else stays dark | U10 slices |
| Conversation quality | 15% | Golden transcripts + repeat/handoff rates hold or improve | existing suites + turn metrics |

Score = weighted sum mapped 0-10; **target achieved** requires ≥9.0 AND every floor green AND
both marketplace floors green over the production observation window (`intelligenceScorecard.ts`
computes rows honestly: skips never pass, retries never inflate fixtures, insufficient ≠ green).

## U2-U12 Build/Defer Decisions (U0 exit requirement — PENDING founder review)

| Unit | Expected user outcome | Recommendation (draft) |
|---|---|---|
| U2 care situation | No stale/conflicting facts in prompts | build |
| U3 objective ledger | Cross-turn goals survive; one clarification | build |
| U4 lifecycle checkpoints | No duplicate writes on retries | build (highest risk — bridge one flow at a time) |
| U5 action evidence | No false "done" claims | build |
| U6 tool packs | Fewer wrong-tool turns | build after U2/U3 measured |
| U7 temporal/funnel evidence | Trends only from real observations | partial — careEvidence exists; defer funnel analytics until baseline shows need |
| U8 proactive engine | One valuable message, not noise | build after U3 |
| U9 eval flywheel | Failures become fixtures | build minimal intake first; defer KMS export until intake proves volume |
| U10 reasoning escalation | Hard turns improve | defer until U9 baseline exists |
| U11 routing convergence | Fewer split-brain routes | defer until U4 proven |
| U12 staged proof | Safe rollout + honest scorecard | build incrementally with each wave |

## Wave Deploy Checklist (every wave)

1. Tree clean at recorded SHA; targeted suites + both broad shards green; no new typecheck errors in touched files.
2. Index workflow steps 4-7 (dry-run → apply → READY → `--live` PASS) for any touched contract.
3. Deploy only functions consuming changed modules; record update times + source SHA.
4. Verify rollout policy fail-closed state (capability still `off`/`shadow` post-deploy).
5. Production smokes from the plan's smoke matrix for the wave; document results.
6. Enable via policy document one mode step at a time; watch hold signals; rollback = policy `off` (+ emergency env if needed), then revert code only if required.

## U0 Exit — remaining items

- [ ] Founder ratifies rubric v0.1 (or amends → v0.2) and the build/defer table.
- [x] Repair Functions semantic typecheck baseline to green — DONE 07-21 for all shipped code (38 production errors fixed; 128 test-file errors tracked under `typecheck:all` as non-shipping debt).
- [ ] Fresh `--live` planner sweep re-run at next deploy gate.
- [ ] Provision `INTELLIGENCE_TELEMETRY_KEY` secret (founder, before first telemetry consumer).
- [ ] Retention/deletion matrix sign-off (defaults live in the plan appendix).
- [ ] U1 deployed to production + smoke matrix rows: unknown wellness, same-day next visit.
