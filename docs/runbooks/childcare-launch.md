# Childcare Launch Runbook

Plan: `docs/plans/2026-07-22-002-feat-childcare-marketplace-consolidated-implementation-plan.md` — Deployment Gate + Rollback Contract. Created by U1, monitoring added by U13, and the staged-deploy machinery + proof template completed by U14. **U14 wrote the machinery but did NOT execute any real deploy or production migration** — every step below is founder-run against production; the migrations/smokes/rollback drill only ever ran against emulator/synthetic data.

**Nothing in this runbook may be executed while any unit U2–U13 is incomplete, any release gate is red, or any `jurisdiction_care_policies` readiness issue is open.** Childcare flags stay OFF (absent = off; they are opt-in, fail-closed).

## U14 tooling (the machinery this runbook drives)

| Purpose | Entry point | Notes |
|---|---|---|
| Dry-run deploy planner | `npm run childcare:deploy-plan [-- --signals <file.json>]` | Runs both audits, prints the 10-step plan + gate states, REFUSES on any red gate. Authoritative gate logic: `functions/src/childcare/deployGate.ts` (`evaluateDeploymentGate`). |
| App Check policy audit | `npm run audit:childcare-app-check` | Proves every deployed childcare callable has matching server/client policy and no direct callable bypass. |
| careVertical backfill (U0) | `v1-backfillCareVertical` (HTTP, `x-admin-secret`; `?apply=true`) | Stamps legacy records senior. Apply refused until the cutoff is set AND non-production env. |
| Household migration | `v1-migrateHouseholds` (HTTP; `?apply=true&startAfterDoc=&maxDocs=`) | Legacy family → households + memberships (phone-only → provisional; quarantine/orphan). Dry-run default; apply refuses off the non-production project. |
| Provider base/senior split | `v1-backfillProviderVerticalProfiles` (HTTP; `?apply=true&...`) | Senior vertical marker only — never a child profile/approval. |
| Rollback drill | `functions/src/childcare/rollbackDrill.ts` (`runRollbackDrill`) | Rehearses the Rollback Contract order against synthetic state; asserts senior behavior unchanged. |
| Synthetic smoke matrix | `functions/src/childcare/productionSmokeMatrix.ts` (`runProductionSmokeMatrix`) | The 14 smokes, synthetic-only, auto-cleanup, hard non-production guard. |
| Production proof recorder | `functions/src/childcare/productionProofRecorder.ts` (`buildProductionProofBundle` / `recordProductionProof`) | Validates + persists the R62 evidence bundle to `childcare_canary_state/deployment_proof`. |
| Hard non-production guard | `functions/src/migrations/nonProductionGuard.ts` | Reused by every write-capable migration/smoke/drill — no bypass; refuses the production project. |
| Interim R2 bake trigger | `interimBackfill{Appointment,ChatRoom,Review,BookingRequest}Vertical` | DARK; `CARE_VERTICAL_INTERIM_BACKFILL_ENABLED=true` during the Rules bake window only. |

## Migration cutoff (founder-set at run time — REQUIRED before any apply)

`CARE_VERTICAL_MIGRATION_CUTOFF` in `functions/src/data/contract.ts` is a **far-future placeholder**. While it is the placeholder, `isCareVerticalCutoffSet()` is false, `v1-backfillCareVertical` refuses `apply`, and the deploy planner refuses (`cutoff_unset`). **At the real staged-deploy (Gate step 6), the founder edits that constant to the exact ISO timestamp of the code cutover** (the moment new writers begin stamping `careVertical`), commits it, and redeploys Functions. Every record created before that instant with no vertical is legacy-senior; every record at/after it without a valid vertical fails closed. This value is deliberately NOT set in the repo — it is stamped at actual-run time so the legacy-grace rule can never be evaluated against a meaningless boundary.

## Control surfaces (live as of U1)

- **Policy gate:** `jurisdiction_care_policies/{STATE}` — `evaluateJurisdictionReadiness(state)` must return `activatable: true` (see `docs/policies/childcare-jurisdictions.md` for the founder checklist).
- **Runtime flags:** `childcare_flags/global` + `childcare_flags/{STATE}` — fields `CHILDCARE_ENABLED`, `CHILDCARE_DISCOVERY_ENABLED`, `CHILDCARE_WRITES_ENABLED`, `CHILDCARE_PROACTIVE_ENABLED`, `emergencyOff`. Firestore-resident and runtime-flippable (R61): flips take effect within the 60s cache TTL, **no redeploy**. A state is on only when BOTH global and its overlay set a flag `true`.
- **EMERGENCY OFF (memorize this):** set `emergencyOff: true` on `childcare_flags/global` → every childcare flag force-falses platform-wide within ≤60s while senior behavior continues untouched. Per-state: set it on `childcare_flags/{STATE}`. Optionally call `bustChildcareFlagsCache()` via admin tooling for immediate effect in a warm instance.

## Deferrals noted by U1

App Check rollout state is stored in `childcare_flags/global` using
`CHILDCARE_APPCHECK_MODE`, `CHILDCARE_APPCHECK_TRANSITION_AT`,
`CHILDCARE_APPCHECK_PROVIDER_VERIFIED`,
`CHILDCARE_APPCHECK_DEBUG_TOKENS_ALLOWED`, and
`CHILDCARE_APPCHECK_VERIFIED_DOMAINS`. Start in `monitor`. Before any pilot,
record the transition to `enforce`, verify the provider, prohibit production
debug tokens, and verify both canonical Hosting domains. Limited-use tokens
are mandatory for authority, child-record, file, booking, financial, dispute,
and operator mutations.

- [ ] **Public legal/help copy (LegalDocs, PrivacyPolicyPage, TermsOfServicePage, TrustAndSafetyPage, HelpPage, FamilyFAQ, Subscription/stripeService pricing surfaces) is deliberately NOT edited in U1.** It ships with U11 when there is a product to describe; the six `consentVersions` in the CA policy are recorded at that point. No public copy may contain a safety guarantee.
- [ ] Childcare pricing: fields exist, all unset (R40). Founder supplies approved refs; never derived from senior $29.95/mo / caregiver $54.99/yr.

## Pre-flight (before Gate step 1)

- [ ] All release gates green (plan §Release Gates); zero unclassified consumers (`npm run audit:childcare-consumers`). Evidence: __________
- [ ] `evaluateJurisdictionReadiness("CA")` → `activatable: true`. Evidence (issue list empty, timestamp): __________
- [ ] Retention policy `POLICY-TBD` durations resolved (docs/policies/childcare-data-retention.md v2+). Evidence: __________
- [ ] Provider sandbox gate + migration rehearsal gate passed (plan §Verification Contract). Evidence: __________

## Deployment Gate (mirrors plan steps 1–10)

1. [ ] **Scope + SHA.** Clean implementation scope, exact commit SHA recorded; U0 manifest re-run if source moved.
   Evidence (SHA, audit output): __________
2. [ ] **Environment + App Check.** Confirm the production project/CLI identity and required secrets/config (diff env VALUES pre-deploy before a full deploy). Register the web provider, set `VITE_APPCHECK_SITE_KEY`, and prove both `careconnex-d4c8b.web.app` and `careconnex-d4c8b.firebaseapp.com` mint normal tokens. Record the Firestore transition to `enforce`; production debug tokens must be disabled. For each domain, prove the probe accepts a normal token and denies absent, invalid, expired, debug, and replayed limited-use tokens. Seed a short-lived `childcare_appcheck_probe_challenges/{id}` document with Admin SDK tooling, invoke `v1-appCheckReplayProbe` twice with the same token, and retain the first bounded success plus second `app_check_replay` denial. Also confirm Stripe/Checkr webhook destinations and approved pilot policy.
   Evidence (mode transition, provider, domain token minting, six probe outcomes per domain): __________
3. [ ] **Indexes.** Deploy additive Firestore indexes; wait until READY.
   Evidence (index states): __________
4. [ ] **Rules.** Deploy Firestore Rules + Storage Rules with childcare paths denied or server-only while flags remain off.
   Evidence (release IDs): __________
5. [ ] **Functions dark.** Deploy Functions with childcare callables/triggers/schedulers dark; verify deployed names + update times against the Git SHA; verify invoker IAM on any NEW callable (curl — new callables can be born without allUsers invoker).
   Evidence (update times, invoker checks): __________
6. [ ] **Migration.** SET the real `CARE_VERTICAL_MIGRATION_CUTOFF` (see above) and redeploy Functions. Then, IN ORDER, for each of `v1-backfillCareVertical`, `v1-migrateHouseholds`, `v1-backfillProviderVerticalProfiles`: dry run first → review reconciliation counts → bounded apply (`?apply=true`, resume via `?startAfterDoc=&maxDocs=` on interruption) → confirm reconciliation and **zero unresolved/quarantined/orphan** records. The reconciliation report lands in `childcare_canary_state/migration_report`; the canary's `migration_count_mismatch` signal holds rollout on any nonzero `unresolved`.
   Evidence (per migration — old/migrated/provisional/quarantined/orphan/unresolved): __________
7. [ ] **Hosting.** Deploy only after local desktop/mobile browser verification of profile, signup, callback, childcare routes; verify BOTH production domains serve the expected bundle. If Rules still require a `careVertical` bake window, set `CARE_VERTICAL_INTERIM_BACKFILL_ENABLED=true` (interim onCreate trigger) until Rules enforce the field, then clear it.
   Evidence (bundle hash per domain): __________
8. [ ] **Synthetic smokes.** Run the 14-row synthetic smoke matrix (`runProductionSmokeMatrix`) — no real child identity, no real Checkr/Stripe effect, automatic cleanup proof; the hard non-production guard refuses the production project for any write-capable harness. All 14 pass + `clean: true`.
   Evidence (smoke IDs, cleanup proof): __________
9. [ ] **Cohort enablement.** Enable internal cohort first, then ONE pilot jurisdiction/cohort (`childcare_flags/global` + `childcare_flags/CA`); observe the approved window before expansion.
   Evidence (flag flip timestamps, observation window results): __________
10. [ ] **Record proof.** Hosting release, Functions update times, Rules/Storage Rules releases, index state, scheduler state, flag state, migration counts, smoke IDs, monitoring health, rollback drill.
    Evidence bundle location: __________

Smoke matrix: use the plan's §Production Smoke Matrix as the checklist for step 8/9 — each row needs an evidence slot in the step-10 bundle.

## Rollback Contract (mirrors plan)

Execute IN ORDER — flags before code:

1. [ ] **Flags first.** Disable childcare discovery, contact, mutations, proactive sources, and new external provider actions via `childcare_flags` (emergencyOff for full stop). Effect ≤60s, no deploy.
   Evidence: __________
2. [ ] **Preserve money state.** Keep accepted payment/booking state for controlled reconciliation — never blindly delete or reverse ledgers.
   Evidence (open bookings/payments inventory): __________
3. [ ] **Revoke stale access.** Safety/chat/file access without a current booking or authority is revoked.
   Evidence: __________
4. [ ] **Freeze migration.** Stop migration batches at a recorded cursor; compatibility adapters keep reading already-migrated records.
   Evidence (cursor): __________
5. [ ] **Code rollback last.** Roll back Hosting/Functions only after flags contain user impact; Rules stay at the stricter compatible version unless a tested rollback requires otherwise.
   Evidence: __________
6. [ ] **Senior smokes + residue.** Run senior production smokes before AND after rollback; document every residual child record, pending payment, incident, provider task, and lifecycle task.
   Evidence: __________

## Rollback drill (rehearse BEFORE go-live)

Run `runRollbackDrill` against emulator/synthetic state to prove the Rollback Contract order is correct and non-destructive. It executes: (1) flags off first, (2) preserve payment/booking ledgers, (3) revoke stale safety/chat/file access, (4) freeze migration at a recorded cursor, (5) code rollback last, (6) senior smoke before+after. The drill asserts `seniorSmokeUnchanged === true`, `ledgerPreserved === true`, and `codeRolledBackAfterFlags === true`. Record `ranAt` + the unchanged senior-smoke snapshot in the proof bundle.

## Production proof (R62 / AE30 — record before cohort enablement)

Capture ONE Git SHA and the matching evidence into `childcare_canary_state/deployment_proof` via `buildProductionProofBundle(...)` → `recordProductionProof(db, ...)`. The builder refuses (lists `missing`) unless every field below is present and clean; `complete: true` is the record that enablement was authorized.

| Evidence | Fill in |
|---|---|
| Git SHA (the single SHA all artifacts map to) | __________ |
| Firebase project | __________ |
| Functions update times (per childcare function → ISO) | __________ |
| Hosting release | __________ |
| Firestore Rules release | __________ |
| Storage Rules release | __________ |
| Index states (each required index → READY) | __________ |
| Scheduler states (`childcareCanaryWatch`, lifecycle worker, expiry sweep) | __________ |
| Flag states (`childcare_flags/global` + pilot state) | __________ |
| Migration counts (old/migrated/provisional/quarantined/orphan/**unresolved=0**) | __________ |
| Smoke IDs (all 14 Production Smoke Matrix ids) | __________ |
| Monitoring health (`rolloutHeld=false`, `redSignals=0`) | __________ |
| Rollback drill (`ranAt` + `seniorSmokeUnchanged=true`) | __________ |

### Dark-deploy record — 2026-07-28 (infrastructure only; NOT an enablement authorization)

The code is deployed to production with every childcare flag off. This is the
evidence captured for that deploy. It is deliberately NOT a `complete: true`
proof bundle — the rows left blank above are the ones that gate *enablement*,
and none of them is satisfied yet.

| Evidence | Value |
|---|---|
| Git SHA | `93aafca` (branch `feat/childcare-marketplace`, PR #4) |
| Firebase project | `careconnex-d4c8b` |
| Deploy order | indexes → **polled to 46/46 READY** → rules → functions → hosting |
| Index states | 46/46 contracts PASS via `audit-firestore-query-contracts.mjs --live` (progression 32 → 39 → 46; `code=9` = still building) |
| Firestore + Storage Rules | both released; verified backward-compatible first — all 51 childcare guards use the defaulted `.get('careVertical','senior')`, zero bare-field refs, so legacy senior docs pass unchanged |
| Functions | 205 → **291** (86 created, **0 deleted** — deployed WITHOUT `--force`) |
| Hosting | released; `careconnex-d4c8b.web.app`, `.firebaseapp.com`, and `eviacares.com` (apex 301 → www) all serve `assets/index-zsdJvo4t.js`, matching the local build |
| Invoker check | new callables return **401, not 403** → `allUsers` invoker present; no `gcloud add-iam-policy-binding` needed |
| Senior smoke | callables 401 (reachable + auth guard), `linqWebhook`/`checkrWebhook` 405 (POST-only), `stripeWebhook` 400 (no signature). **No 403s, no 5xx.** |
| Flag state | `childcare_flags/global` **never created** → absent = OFF for every childcare flag |
| Migrations | **NOT RUN.** `CARE_VERTICAL_MIGRATION_CUTOFF` is still the placeholder, so apply refuses with HTTP 412 |
| Scan pipeline | `dispatchChildFileScanOnFinalize` + `consumeChildFileScanResultMessage` deliberately UNEXPORTED (`93aafca`) — see that commit for why; `reconcileChildFileScans` is deployed |
| Smokes / rollback drill / monitoring | not executed against production |

**Known gaps at deploy time, all blocking enablement:** no full test-suite run has
completed on this tree (the authoring machine wedged on memory); no human code
review or funnel QA; pricing configs unseeded; jurisdiction legal/insurance/
TrustLine references and consent versions absent; App Check in monitor mode with
no provider registered; no operators provisioned; Stripe
`charge.dispute.created` not subscribed.

**Emergency-off remains a Firestore flag flip — no redeploy required.**

## Founder-run go-live checklist (the culminating deliverable)

Every real-world action to actually go live, IN ORDER. None was executed by U14.

1. [ ] **External approvals recorded.** Counsel sign-off, insurance certificate, and CA TrustLine confirmation entered as concrete `approvals.*` references in `jurisdiction_care_policies/CA` (+ the six `pricing.*` refs, `consentVersions.*`, `guardianProcessRef`, `incidentContacts`, `reportingObligationsRef`, `insuranceEvidenceRefs`). Verify `evaluateJurisdictionReadiness("CA").activatable === true`.
2. [ ] **All release gates green** (plan §Release Gates); full focused suites + both broad shards + `npm run eval` pass with no skipped childcare-safety case.
3. [ ] **Audits green:** `npm run audit:childcare-consumers`, `npm run audit:childcare-app-check`, and `npm run audit:indexes` all PASS.
4. [ ] **Typecheck/build green:** `npm run typecheck`, `npm --prefix functions run typecheck`, `npm run build`, `npm --prefix functions run build` (frontend build needs `NODE_OPTIONS=--max-old-space-size=8192`).
5. [ ] **Provider sandbox + migration rehearsal gates passed** against emulator/copied non-production data (Stripe/Checkr test artifacts; zero unresolved migration records).
6. [ ] **Rollback drill rehearsed** (`runRollbackDrill`) — senior behavior unchanged.
7. [ ] **Dry-run the planner:** `npm run childcare:deploy-plan -- --signals <live.json>` → VERDICT PROCEED (exit 0). Any red gate blocks — resolve before continuing.
8. [ ] **Deployment Gate steps 1–10** above, in order. Confirm invoker IAM (curl) on every NEW callable after step 5 (new callables can be born without `allUsers` invoker → gateway 403). Diff env VALUES before any full deploy (partial-.env wipes secrets).
9. [ ] **Set the migration cutoff** (edit `CARE_VERTICAL_MIGRATION_CUTOFF`, commit, redeploy) and run the three migrations to zero-unresolved (step 6).
10. [ ] **Synthetic production smokes** (step 8) — 14/14 + clean.
11. [ ] **Record proof** (`recordProductionProof`) — `complete: true`.
12. [ ] **Enable internal cohort** (`childcare_flags/global`), observe; then **ONE pilot jurisdiction** (`childcare_flags/global` + `childcare_flags/CA`). Do NOT advance a wave while `childcare_canary_state/rollout_hold.held === true`.
13. [ ] **Watch the observation window.** On any red hold-signal, or on demand, execute the Rollback Contract (flags first via `emergencyOff`, code last).

## Observability & Canaries (U13)

Filled in by U13. Every critical childcare promise has a privacy-safe metric, a threshold, an escalation owner, and a rollout response — **no child PII ever enters telemetry** (R57). Source of truth: `functions/src/childcare/childcareMetrics.ts` (metric contract), `functions/src/config/slaConstants.ts` (thresholds/owners/hold-signals), `functions/src/childcare/childcareCanaryWatch.ts` (watcher).

### Privacy contract (R57)

- **`functions/src/childcare/privacyAssertions.ts`** is the canonical library that REJECTS raw child fields (exact DOB, exact address, custody/pickup detail, health/allergy, emergency-contact PII, identity-image refs, screening narrative) from logs, metrics, provider metadata, prompts, eval fixtures, and outbound templates. The U6 `assertChildSafeOutboundPayload` delegates to it; U8 Stripe metadata stays on its own exact-key contract (`assertChildSafeStripeMetadata`).
- **Static gate:** `childcareTelemetryScan.test.ts` scans template registries + telemetry emitters + log call sites for interpolated child-field identifiers.
- **Redaction:** `safety/redactPii.ts` `redactChildSensitiveForLog` scrubs DOB/SSN shapes from log strings (fail-safe; a redactor throw surfaces as the `redactor_failure` canary signal). NOT wired into the outbound transport (senior copy legitimately carries dates/addresses).

### Canary watcher

`childcareCanaryWatch` runs hourly at `:35 UTC`, **DARK** — it no-ops unless `CHILDCARE_ENABLED` is on (so emergency-off parks it too). It collects privacy-safe COUNTS (single-field scans, no compound queries, no new index contracts), grades them, writes **deduped content-free** `admin_alerts` (`type: "childcare_canary"`, one per signal per UTC day), and sets/clears the rollout-hold signal.

### Metrics, thresholds, owners, rollout response

| Signal | Family | Amber / Red | Owner | Holds rollout on RED |
|---|---|---|---|---|
| `enrollment_funnel_stall` | funnel | 5 / 20 | generalOperator | no |
| `authority_denial_spike` | denials | 20 / 50 | childSafetyOperator | no |
| `provider_expiry_visible` | expiry | 0 / 1 (zero-tol) | childSafetyOperator | **yes** |
| `matching_eligibility_drop` | matching | 10 / 25 | generalOperator | no |
| `booking_transition_anomaly` | booking | 5 / 15 | generalOperator | no |
| `payment_reconciliation_mismatch` | payment | 0 / 1 (zero-tol) | generalOperator | **yes** |
| `message_disclosure_violation` | disclosure | 0 / 1 (zero-tol) | childSafetyOperator | **yes** |
| `memory_denial_breach` | memory | 0 / 1 (zero-tol) | childSafetyOperator | **yes** |
| `incident_sla_miss` | incident | 1 / 2 | childSafetyOperator | **yes** |
| `lifecycle_task_stuck` | lifecycle | 3 / 10 | childSafetyOperator | no |
| `migration_count_mismatch` | migration | 0 / 1 (zero-tol) | generalOperator | **yes** |
| `source_manifest_drift` | manifest | 0 / 1 (zero-tol) | generalOperator | **yes** |
| `redactor_failure` | observability | 0 / 1 (zero-tol) | childSafetyOperator | **yes** |

Incident SLA: amber ≥ 1h open, red ≥ 4h open. Lifecycle stuck: amber ≥ 2h, red ≥ 6h. A **missing metric** (a signal absent from the reading) raises its own critical alert — a metric that stops reporting can hide a red signal (R63).

### Rollout-hold signal (read by the U14 deploy gate + rollback)

`childcare_canary_state/rollout_hold` = `{ held, reasons[], syntheticOnly: true, updatedAt }`. Any RED hold-signal SETS it; a clean sweep CLEARS it. Read via `isChildcareRolloutHeld(db)`, which **fails SAFE (assume held)** when the state is unreadable. `reasons` are signal NAMES only. **Rule: do not advance a cohort wave (Gate step 9) or complete a deploy while `held === true`.**

### Dashboard slices

Filter `admin_alerts` by `type == "childcare_canary"`, then by `signal`, `severity` (`high`=red / `medium`=amber), `priority`, and `owner`. Suggested panels: (1) zero-tolerance board (any row = incident) — expiry / payment / disclosure / memory / migration / manifest / redactor; (2) graded trend — denials / matching / booking / funnel / lifecycle / incident-SLA; (3) rollout-hold status tile from `childcare_canary_state/rollout_hold`.

### Evals (R63)

`npm run eval` deterministically evaluates the U10 `childcare_safety` cases **plus** the U13 cases `cc_safety_privacy_log_leak`, `cc_safety_metric_no_pii`, `cc_safety_canary_zero_tolerance` (synthetic only — no real childcare turn is ever captured; `caraTrainingDataset.assertTrainingExampleCaptureAllowed` enforces this). No childcare-safety case is silently skipped.

## Contacts / ownership

- System operator (flags, rollback): founder (imran@angelicare.com) until U12 operator roles exist.
- Incident escalation: `jurisdiction_care_policies/CA.incidentContacts` (unpopulated at U1 — must be filled before any enablement).

## Go-live sequence (2026-07-28)

Three writes take childcare from dark to functional. **Order is load-bearing** —
flags before pricing/policy opens a signup funnel that cannot take a payment or
produce a match, so a family would onboard into a dead end.

```bash
npm run childcare:go-live-plan                                    # dry-run all three
node scripts/childcare-go-live.mjs --apply --project=careconnex-d4c8b
```

The orchestrator runs, in order: `seed-childcare-pricing.mjs` →
`seed-childcare-jurisdiction.mjs` → `seed-childcare-flags.mjs`, aborting the
chain on the first failure (exit 1). Step 3 independently re-verifies steps 1
and 2 against live Firestore — policy exists, `status === "configured"`,
`policyVersion` present, categories non-empty, all six pricing refs set AND
each pointing at a `childcare_pricing_configs` doc that really exists — and
exits 3 without enabling anything if not. A partial go-live is not reachable.

**Rollback** (always works, skips prerequisite checks):
```bash
node scripts/seed-childcare-flags.mjs --emergency-off --apply --project=careconnex-d4c8b
```
Flag reads cache 60s (`CHILDCARE_FLAGS_CACHE_TTL_MS`), so allow a minute in
either direction.

`CHILDCARE_PROACTIVE_ENABLED` is **off** in the default `--on` set. It is not
needed to go live. It governs proactive outbound childcare SMS — the only
irreversible surface here, since a flag can be switched back but a delivered
text cannot be recalled. Add `,proactive` to `--on` deliberately.

### Founder-approved pricing (2026-07-28)

Sibling surcharge **+$3.00/hr** per additional child (market: +$3.63/hr observed
for a 2nd child, $3–4/hr per additional — this is the low end). Cancellation
**≥24h → 100%, inside 24h → 50%, provider no-show → 100%**. Refund window **72h
post-shift, partial allowed, max 100%** — far more generous than the market
leader (UrbanSitter terms: "ALL FEES AND CHARGES ARE NONREFUNDABLE"), a
deliberate launch trust investment.

### Known tension: enabling with governance refs unpopulated

The Contacts section above states `incidentContacts` **must be filled before any
enablement**. Nothing in the code enforces that. `evaluatePolicyReadiness` — the
only thing that checks `incidentContacts`, `approvals.*`, and `consentVersions.*`
— is consulted **exclusively** by `childcare/deployGate.ts`, the launch
checklist. No runtime request path calls it. So childcare will operate with all
13 external references empty, and `npm run childcare:deploy-plan` will keep
reporting `jurisdiction_incomplete`. Both statements are true simultaneously;
neither is a malfunction.

The concrete exposure of enabling without them: a caregiver reporting a child
injury escalates to an **empty contact list**. The incident is recorded and
classified, but no human is paged. That is a business/duty-of-care decision, not
a technical one — recorded here so it is a choice on the record rather than an
oversight. Fill them via
`docs/runbooks/childcare-ca-approvals.template.json` →
`node scripts/seed-childcare-jurisdiction.mjs --values=<file> --apply --project=<id>`.

### TrustLine — FOUNDER DECISION 2026-07-28: not required

Evia does **not** use TrustLine. The approved CA screening program is the shared
Checkr base package with annual renewal (same package as senior care).

Basis: [HSC §1596.66] compels TrustLine only for license-exempt providers paid
from public subsidy funds (Alternative Payment / CalWORKs / CCDBG), excepting
grandparents/aunts/uncles. Evia is private-pay, so it is not compelled.

Recorded here because it was raised and decided, not overlooked. The
counter-consideration that was weighed: UrbanSitter also skips TrustLine, but
does so while disclaiming in its Terms that it is "NOT A REFERRAL, MATCHING OR
PLACEMENT SERVICE" — a disclaimer Evia cannot make while shipping a matching
engine. Founder decided this does not change the conclusion. Closed.

**Remaining trigger to watch:** if Evia ever accepts subsidy-funded families
(Alternative Payment / CalWORKs / CCDBG), TrustLine becomes **mandatory** for
those caregivers. That is a statutory condition on the funding source, not a
policy preference — revisit only if the payment model changes.
