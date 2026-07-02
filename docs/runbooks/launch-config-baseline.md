# Launch Config Baseline — 2026-07-01

Deployed env of `v1-linqWebhook` (project `careconnex-d4c8b`) read via gcloud on 2026-07-01 and
diffed against the deploy source `functions/.env`. **Result: byte-identical on every key** —
full `firebase deploy --only functions` is safe again (the 2026-06-28 wipe is fully repaired
on the keys that have values). Values are never recorded here; only names and status.

## Resolved contradictions (this doc is now the authority)

| Question | Deployed reality | Notes |
|---|---|---|
| Agent-loop onboarding | `ONBOARDING_AGENT_LOOP` and `ONBOARDING_AGENT_LOOP_COHORT_PCT` both set — **agent-loop onboarding live at full rollout for clients** | Runbook headers and 10%-canary records are stale; update them from this row |
| Agent model | `CARA_AGENT_PROVIDER` and `CARA_AGENT_MODEL` set (OpenAI primary, current-generation model), `CARA_ESCALATION_MODEL` set, `CARA_AGENT_ANTHROPIC_FALLBACK` enabled | The env-var model IS active (the older code default is not in effect). PHI flows to OpenAI **today** → R18 decision required before launch |
| Checkpoint resume | `CARA_CHECKPOINT_RESUME` empty — **dark** | Stays dark through launch (plan KTD) |
| Zep memory | `ZEP_API_KEY` present | Long-term memory configured; U3 adds empty-context telemetry |
| Model ladder tiers | `CARA_ROUTER_MODEL`, `CARA_QUICK_MODEL`, `CARA_VISION_MODEL` set to the matching small-tier models | Matches local |

## Launch decisions needed (founder-owned)

| # | Item | Deployed state | Decision needed | Owner |
|---|---|---|---|---|
| D1 | `ADMIN_PHONE` / `ADMIN_EMAIL` | **empty** | Set before launch — U5 provider-failure SMS alerts and existing admin notifications have no destination | Founder |
| D2 | PHI → OpenAI (R18) | live today | **DECIDED 2026-07-01: stay on OpenAI for launch.** BAA request to baa@openai.com being sent (their API BAA requires Zero-Data-Retention endpoint config once signed). Recorded in the U4 provider addendum in `AGENT_NATIVE_EXCLUSIONS.md`; CLAUDE.md model sections reconciled. Rollback unchanged: `CARA_AGENT_PROVIDER=anthropic` + redeploy | Founder ✓ |
| D3 | `STRIPE_SECRET_KEY` has a non-standard prefix | matches local | Not the standard Stripe live secret-key shape — confirm Stripe is in the intended mode and a real charge/checkout succeeds before launch | Founder |
| D4 | `STRIPE_WEBHOOK_SECRET`, `STRIPE_MEMBERSHIP_PRICE_ID`, `STRIPE_PLAN_FAMILY_PRICE_ID`, all `STRIPE_PRICE_*`, `STRIPE_CAREGIVER_*`, `STRIPE_CONNECT_WEBHOOK_SECRET` | **all empty** | Confirm where checkout/price config actually comes from (code default or Firestore config) and whether Stripe webhook verification is needed for the client funnel; empty webhook secret means Stripe event processing is unverified or dead | Founder + next session |
| D5 | `FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS` | ON in prod (stale) | **DONE 2026-07-01: cleared in `functions/.env`** — takes effect at the next deploy of `v1-linqWebhook`, restoring the documented dark-in-prod posture | Founder ✓ |
| D6 | `CHECKR_WEBHOOK_SECRET` empty (API key present) | empty | Caregiver background-check webhook verification — caregiver onboarding is deferred, but existing caregiver events may be affected; confirm post-launch | Founder |
| D7 | `SUPPORT_PHONE`, `RESEND_FROM_EMAIL/NAME`, `INVOICE_EMAIL_FROM` | empty | Cosmetic/comms defaults — set when convenient | Founder |

## Rollback lines

- Model: flip `CARA_AGENT_PROVIDER` between `openai`/`anthropic` in `functions/.env`, redeploy `v1-linqWebhook` (fallback stays configured either way).
- Onboarding: clear `ONBOARDING_AGENT_LOOP` to return to the scripted path (no data migration; `onboardingData` identical on both paths).

## Deploy discipline (standing rules)

- Diff live env against `functions/.env` before any full deploy (this doc's generation command).
- `FUNCTIONS_DISCOVERY_TIMEOUT=120` on every deploy (`deploy.ps1` sets it; `npm run deploy` does not).
- Prefer `npx firebase-tools deploy --only functions:v1-linqWebhook`; never `--force`.
