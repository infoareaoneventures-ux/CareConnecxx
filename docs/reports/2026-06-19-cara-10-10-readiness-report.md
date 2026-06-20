# Cara 10/10 Readiness Report

Date: 2026-06-19
Scope: local implementation pass for `docs/plans/2026-06-19-001-feat-cara-10-10-readiness-plan.md`
Deploy: no
GitHub push: no
Git branch: feat/cara-healthcare-handler
Commit SHA: 2e70f6474f138f474536e5f9b9572783c0ded620
Dirty tree: yes (uncommitted changes present at time of report)

## Current State

Cara is materially stronger than a generic chatbot. This pass added:

- Admin Control Room recovery actions for failed actions and pending approvals.
- Scoped Firestore admin update rules for `agent_action_ledger` and `pending_actions`.
- MCP dispatcher ledger coverage for consequential tool execution.
- Richer operational context for caregiver status, shift/payment state, client visit state, care updates, family group state, and pending invoice/payment state.
- Additional messy-human golden transcripts for emergency fall, vague hours dispute, caregiver approval status, and caregiver referral partial-info flows.

## Local Gates Run

- `npm.cmd run typecheck`: passed
- `npm.cmd test -- --run tests/contractCollections.test.ts`: passed, 66 tests
- `npm.cmd --prefix functions exec tsc -- --noEmit --pretty false`: passed
- `npm.cmd test -- --run functions/src/mcp/__tests__/coverage-smoke.test.ts`: passed, 40 tests
- `npm.cmd test -- --run functions/src/agents/operationalContext.test.ts`: passed, 3 tests
- `npm.cmd test -- --run functions/src/agents/goldenTranscripts.test.ts`: passed, 30 tests
- `npm.cmd run build`: passed
- `npm.cmd --prefix functions run build`: passed
- `npm.cmd test -- --run`: passed
- `npm.cmd test -- --run functions/src/mcp/__tests__/seniorIsolation.test.ts`: passed, 15 tests

## Vendor / External Gates Not Run

These are still required before any launch claim:

- Linq real outbound to primary client.
- Linq real outbound to newly invited family member.
- Linq group participant add/update.
- Linq inbound from primary client, secondary family member, and caregiver.
- Stripe test charge and Connect transfer path.
- Stripe missing-payment-method failure path.
- Checkr test webhook `clear`.
- Checkr exception webhook such as `consider`.
- Firebase Functions deployed/staging callable smoke tests.
- Firestore rules/index verification against the deployed/staging project.

## Healthcare Actions

Real-world healthcare actions remain dark by default behind:

`FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS=true`

Do not enable this flag until all of these are complete:

- Compliance/consent review for portal credentials and healthcare data handling.
- Account-holder approval model accepted for committing appointment/refill actions.
- Supported launch portal list confirmed.
- Browserbase/portal automation reliability tested.
- Portal failure recovery runbook verified.

Current code posture:

- Appointment slot discovery is read-only.
- Appointment booking with a chosen slot requires pending approval.
- Pharmacy refill requires pending approval.
- Insurance check is read-only.
- Account-holder approval routing exists.
- Duplicate approval is claim-guarded.

## Residual Risks

- Control Room retry/re-open records durable operator recovery intent only. The operator UI now states explicitly that these controls record intent in the audit trail, do not resend Linq prompts or re-execute tools, and that actual replay must be performed manually on the backend — so operators can't mistake a recorded retry for an executed one. Automated server-side replay (for explicitly idempotent actions only) remains a tracked follow-up before this gap is fully closed.
- Real Linq group behavior may differ from mocks.
- Full Firestore rules unit coverage is still needed for client/caregiver/family/admin roles.
- Bundle-size/minifier warnings are present during frontend build; they are warnings, not failures.
- Healthcare actions should stay disabled until external gates are done.

## Recommendation

Not launch-ready for broad release yet.

Recommended status after this pass: continue local hardening, then run full local gates and real-vendor smoke tests. If those pass, the correct next stage is a limited pilot, not broad public launch.
