# Onboarding agent-loop — release checklist

The feature is built, tested, and real-model-eval-passed **5/5**, committed on local
`main`, flag-ready in `functions/.env` (`ONBOARDING_AGENT_LOOP=client`,
`ONBOARDING_AGENT_LOOP_COHORT_PCT=10`). It is NOT deployed. Shipping it is a real
release, not a flag flip — read the three hazards first.

## Cara recipe/control-room pre-deploy gates

Do not deploy the current Cara recipe and Control Room work until these local
checks pass and the release scope is explicitly approved:

```powershell
npm.cmd test -- functions/src/agents/careRecipes.test.ts functions/src/agents/capabilityDiscovery.test.ts functions/src/agents/operationalContext.test.ts --run
npm.cmd test -- functions/src/agents/caraAgent.routing.test.ts functions/src/linq/__tests__/handleCareNotes.billing.test.ts functions/src/linq/__tests__/routeClient.test.ts functions/src/mcp/__tests__/family.test.ts --run
npm.cmd test -- functions/src/evals/caraTrainingDataset.test.ts functions/src/agents/goldenTranscripts.test.ts functions/src/agents/turnMetrics.test.ts --run
npm.cmd run typecheck
npm.cmd run build
npm.cmd --prefix functions run build
```

Before release, verify `components/admin/AdminCaraControlRoom.tsx` shows
recipe/family-group failures, failed Linq sends, pending approvals, and quality
flags. Payment approvals must remain private to the primary client; family group
updates may include care updates only.

## Hazards (why this is not a one-liner)

1. **210-commit divergence.** Local `main` is ~210 commits ahead of `origin`.
   Deploying ships all of it, not just onboarding. A single-function deploy
   (`linqWebhook` only) limits the blast radius but creates version skew (linqWebhook
   on new code, other functions on old). Decide: coordinated full release vs.
   single-function canary.
2. **`functions/.env` is an incomplete post-wipe restore template** (see its own
   header comment, "deployed function env was wiped 2026-06-28"). Many values are
   blank or wrong (`STRIPE_SECRET_KEY=mk_…` is not a valid Stripe key; all
   `STRIPE_PRICE_*`, `STRIPE_WEBHOOK_SECRET`, `CHECKR_*`, `RESEND_FROM_*`, `GOOGLE_*`,
   `JWT_SECRET` empty). A **full** `firebase deploy --only functions` from this file
   WIPES those values on every function. Only `BROWSERBASE_API_KEY`,
   `BROWSERBASE_PROJECT_ID`, `CREDENTIAL_VAULT_KEY` are Secret-Manager-backed and
   survive; everything else is a plain env var sourced from this file.
3. **Leaked / at-risk keys.** The Anthropic key in `.env` was pasted into a chat —
   rotate it. The whole file churned once already; treat all keys as at-risk and
   prefer migrating them to Secret Manager so `.env` deploys can never wipe them.

## Step 0 — rotate the leaked key (you, in the console)

console.anthropic.com → API keys → revoke the `sk-ant-api03-7oSLb2…` key → create a
new one → paste the new value into `functions/.env` (editor only, never chat).

## Step 1 — make the deploy env safe (choose ONE)

### Method A — rebuild `.env` from the LIVE function (recommended, no dashboard hunt)
The deployed `v1-linqWebhook` already has the correct values. Pull them, so the
deploy can't regress its own env. Secrets stay on your machine.

```powershell
gcloud functions describe v1-linqWebhook --region=us-central1 --format="json(environmentVariables)" > live-env.json
```
Then convert to `.env` lines (run from repo root):
```powershell
node -e "const e=require('./live-env.json').environmentVariables||{}; const fs=require('fs'); fs.writeFileSync('functions/.env.linqWebhook', Object.entries(e).map(([k,v])=>k+'='+v).join('\n')+'\nONBOARDING_AGENT_LOOP=client\nONBOARDING_AGENT_LOOP_COHORT_PCT=10\n'); console.log('wrote functions/.env.linqWebhook with', Object.keys(e).length, 'vars + 2 flags')"
```
Review `functions/.env.linqWebhook` — confirm no blanks for keys linqWebhook needs
(ANTHROPIC_API_KEY, OPENAI_API_KEY, LINQ_API_KEY, LINQ_WEBHOOK_SECRET, LINQ_BASE_URL,
ZEP_API_KEY, APP_URL). Put the ROTATED Anthropic key in. Then use this file as the
deploy `.env` (rename to `functions/.env` for the deploy, keeping a backup of the
current one).

### Method B — fill the blanks from dashboards (fallback)
| Var | Where to get it |
|-----|-----------------|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → endpoint → Signing secret (`whsec_…`) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Stripe → the Connect webhook endpoint → Signing secret |
| `STRIPE_PRICE_*`, `STRIPE_*_PRICE_ID` | Stripe → Products → each price (`price_…`) |
| `CHECKR_API_URL` | `https://api.checkr.com/v1` |
| `CHECKR_KEY`, `CHECKR_WEBHOOK_SECRET`, `CHECKR_PACKAGE*` | Checkr dashboard → API + packages |
| `RESEND_FROM_EMAIL` / `_NAME`, `INVOICE_EMAIL_FROM` | your verified Resend sending domain |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | Google Cloud console → APIs → Credentials |
| `JWT_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SUPPORT_PHONE`, `ADMIN_EMAIL`, `ADMIN_PHONE`, `CARA_AVATAR_URL` | your values |

Flags that are fine left blank (= off): `CARA_CHECKPOINT_RESUME`,
`CARA_EVAL_LIVE_INTENT`, `CONVERGENCE_FLIPPED`, `CONVERGENCE_UNFLIPPED`,
`WOW_MOMENTS_ENABLED`.

## Step 2 — deploy (single function = lower blast radius)

```powershell
firebase deploy --only functions:linqWebhook
```
(`firebase.json` prefix `v1` maps export `linqWebhook` → deployed `v1-linqWebhook`.
predeploy runs `npm --prefix functions run build`.) This redeploys only that
function's code + env; other functions are untouched, so their Stripe/Checkr env is
safe even if your `.env` is partial.

Verify after:
```powershell
gcloud functions describe v1-linqWebhook --region=us-central1 --format="value(environmentVariables.ONBOARDING_AGENT_LOOP,environmentVariables.ONBOARDING_AGENT_LOOP_COHORT_PCT)"
```
Should print: `client    10`.

## Step 3 — watch the canary

Text a real signup from a test phone, then:
```powershell
npm run canary:onboarding        # last 24h
npm run canary:onboarding 1      # last 1h
```
Watch: re-greets 0, P95 latency (ratify ≤15s for SMS), no errored/exhausted. Healthy
→ widen `ONBOARDING_AGENT_LOOP_COHORT_PCT` 10→25→50→100, redeploy each step.

## Rollback (instant, no data change)

Set `ONBOARDING_AGENT_LOOP=` (empty) in the deploy env and redeploy `linqWebhook`,
or revert the env var. `onboardingData` shape is identical on both paths, so no
migration either way.

## Do NOT
- Run a full `firebase deploy --only functions` until `.env` is fully restored
  (wipes other functions' env).
- Set the flag via `gcloud functions deploy … --update-env-vars` — gen1 redeploys
  code from local source and is not a clean env patch.
- Push 210 commits to `origin` as part of this without a separate review.
