# Cara Agent-Native Launch Completion — Readiness Report

Date: 2026-06-20
Scope: local implementation pass for `docs/plans/2026-06-20-001-feat-cara-agent-native-launch-completion-plan.md` (Units U1–U12)
Deploy: no
GitHub push: no
Git branch: `feat/cara-healthcare-handler`
Dirty tree: changes committed incrementally per unit during this pass

## Summary

This pass closed the remaining launch gaps from the agent-native audit: action
parity (client/caregiver/admin), executable admin recovery, shared-workspace
contract + rules coverage, healthcare safety hardening, capability discovery,
messy-human regression coverage, coded-flow characterization, CRUD/lifecycle
coverage, and payment/invoice/shift-hour audit invariants. All work is local;
no deploy or push was performed (R18).

## Local Gates Run (all green)

| Gate | Command | Result |
|---|---|---|
| Functions typecheck | `npm.cmd --prefix functions exec tsc -- --noEmit` | passed (exit 0) |
| Frontend typecheck | `npm.cmd run typecheck` | passed (exit 0) |
| Functions build | `npm.cmd --prefix functions run build` | passed — 211 files, 0 errors |
| Frontend build | `npm.cmd run build` | passed (bundle-size warnings only) |
| Full unit suite | `npm.cmd test -- --run` | **1306 passed / 1306** (106 files) |
| Cara eval | `npm.cmd --prefix functions run eval` | **229/229 (100%)** |
| Contract collections | `tests/contractCollections.test.ts` | passed |
| Entity lifecycle / delete-protection | `tests/entityLifecycle.test.ts` | passed |
| Callable v1- prefix guard | `tests/callablePrefix.test.ts` | passed |

The full-suite run initially surfaced one real regression — 15 new admin /
quick-confirm callable references in the frontend were missing the `v1-` deploy
prefix and would have failed at runtime with `functions/not-found`. The
callable-prefix guard caught it; it is now fixed and the suite is fully green.

## Per-Unit Outcomes

- **U1** — Launch action-parity registry (`launchActionParity.ts`, 52 actions: 33 shipped, 16 blockers→shipped as U2/U3 landed, 3 non-goals), human-readable `capability-map.md`, enforced by `toolCapabilities.test.ts` + `contractCollections.test.ts`.
- **U2** — 8 caregiver action tools (withdraw/respond-to-booking/start/complete shift, update task, media update, hour-correction response, standard payout); ownership-checked, idempotent on SMS retry (complete_shift keyed on the `shiftHours` billable record per AE7), eligibility-gated payout.
- **U3** — 8 admin-gated callables behind `requireAdmin` (also retrofitted onto the previously auth-only `adminAlerts` callables). `admin_review_caregiver_exception` enforces AE8/R8: approving never makes a caregiver bookable unless `onboardingStatus==profile_complete && verificationStatus==approved`, and never fabricates a Checkr clear.
- **U4** — 5 executable Control Room recovery callables (Linq-delivery retry, pending-action replay, cancel, assign-owner, mark-complete); high-risk replays require explicit confirmation, idempotency-keyed, fail visibly via `admin_alerts`. UI disclaimer rewritten to be truthful.
- **U5** — Registered `agent_tasks`/`agent_tasks_active`/`agent_approvals` in the contract + locked-down rules; **fixed a public-route security gap** (QuickConfirmPage wrote agent collections directly → now token-scoped Admin-SDK callables); added a scanner that fails on any unregistered Cara-written shared collection.
- **U6** — Verified all 6 healthcare launch scenarios; hardened the medical-emergency path to raise an admin-visible `admin_alerts` doc (R7); per-phone inbound lock now fails closed and the webhook returns 500 on failure (R6/R16). Real-world healthcare actions remain **dark behind the feature flag**.
- **U7** — Role-aware capability discovery derived from the parity registry; `HELP` carrier keyword + natural-language LLM path; secondary-family members never get payment-approval authority (AE4); contextual web empty-state hints.
- **U8** — +7 messy-human golden transcripts (vague charge, secondary-member payment denial, background-check question, ambiguous yes, memory correction, medical-advice refusal, photo); fixed a generic-helper-prompt violation in the sticker ack.
- **U9** — Characterization tests locking current coded-flow behavior (incl. duplicate-inbound/double-bill idempotency) + a projection-contract shadow harness. **No production routing changed** (launch-safe, per KTD3).
- **U10** — Registered the 19 pre-registry web-read collections; destructive-delete protection enforced + tested on audit/payment/health entities; `context/entity-lifecycle.md` documents per-entity lifecycle. No new lifecycle tools were needed.
- **U11** — Pinned payment audit invariants with tests: owner-scoped approval (LLM cannot spoof actor id — it is session-injected), missing-payment-method → `payment_failed`, duplicate approval never double-charges (status precondition + Stripe idempotency keys), refund-request creates admin-visible state, payout failure is ledgered + Control-Room visible. Fee constants consolidated (values unchanged).
- **U12** — This report + the full local gate run above.

## Vendor / External Gates NOT Run (still required before any launch claim)

These need a deployed/staging environment and live vendor credentials:

- Linq real outbound/inbound (primary client, secondary family member, caregiver; group add/update).
- Stripe test charge + Connect transfer; missing-payment-method failure path; standard & instant payout.
- Checkr `clear` webhook (auto-approve) and exception webhook (`consider` stays unbookable).
- Deployed Firebase callable smoke tests (every new `v1-`-prefixed admin/quick-confirm callable).
- Firestore rules verified against the deployed project (no local rules-unit harness exists — rules are currently guarded statically by `contractCollections` + `entityLifecycle` tests, not an emulator).

## Residual Risks

- **No executable Firestore rules tests.** Rules correctness is enforced statically (contract + lifecycle scanners), not by an emulator harness. A deployed rules smoke test is recommended before launch.
- **Healthcare actions must stay disabled** until the runbook pre-launch gates (compliance/consent, supported-portal list, SIM-swap/approver-identity mitigation, portal reliability) are complete. The flag is OFF by default.
- **Email delivery status** for invoice/dunning/payout emails is not persisted per-send (failures throw rather than silently succeed, so this is a visibility gap, not a correctness one).
- **Coded-flow migration is characterized but not switched** — production still runs the coded SMS state machines; agent-composed flows remain a tested-but-dormant follow-up.
- Frontend build emits bundle-size/minifier warnings (warnings, not failures).

## Recommendation

All local gates pass and the launch-critical parity, safety, contract, and audit
gaps from the plan are closed and test-enforced. **Not yet ready for broad public
launch**: the vendor/external gates above and a deployed Firestore-rules smoke
test must pass first. The correct next stage is a deploy to staging, the live
vendor smoke tests, and a limited pilot — not broad release.
