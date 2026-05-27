# Cara — Deploy Plan

Everything from this session is in `functions/`. The frontend was not touched. Deploy is `npm run deploy --prefix functions` (or `firebase deploy --only functions`). Nothing has been pushed to Firebase yet.

---

## 0. Pre-flight (do these BEFORE deploying)

These are not optional — one of them (LINQ_WEBHOOK_SECRET) will break the webhook completely if missing in production.

### 0.1 Verify environment variables in the target project

```bash
firebase functions:config:get          # legacy v1 config
firebase functions:secrets:access LINQ_WEBHOOK_SECRET   # secret manager
firebase functions:secrets:access ANTHROPIC_API_KEY
firebase functions:secrets:access OPENAI_API_KEY
firebase functions:secrets:access LINQ_API_KEY
```

**Critical:** `LINQ_WEBHOOK_SECRET` is now fail-closed. If it is unset in production, every inbound webhook returns 500 and Cara goes dark. **Confirm the value is present and matches what Linq is signing with before deploying.**

If you're unsure: check Linq's webhook config UI for the signing secret, compare against the value Firebase has.

Other env vars used (already required pre-deploy):
- `ANTHROPIC_API_KEY` — Claude (Sonnet for qaAgent tool loop)
- `OPENAI_API_KEY` — gpt-4o-mini (parseWithClaude, quickComplete, intent classifier, language detector, persona shift, crisis verification, refilter detector)
- `LINQ_API_KEY`, `LINQ_PHONE_NUMBER` — Linq messaging
- `ZEP_API_KEY` — memory (graceful degradation if unset)
- `STRIPE_SECRET_KEY` — billing
- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `CREDENTIAL_VAULT_KEY` — already wired as secrets via `runWith` on `linqWebhook`

No new env vars were added in this session.

### 0.2 Build locally one more time

```bash
cd functions && npm run build
```

Must report: `Transpiled 144 files, 0 errors.`

### 0.3 Run the test suite

```bash
npx vitest run functions/src/    # from repo root
```

Must report: `Test Files 17 passed, Tests 189 passed`.

### 0.4 Confirm Firestore composite indexes

Two new query patterns were added. Most should reuse existing indexes; flag the ones that may need new ones.

Likely-already-indexed (pre-existing query shapes):
- `appointments where(clientId == X).where(status in [...]).orderBy(date)` — used by `send_client_message` IDOR check
- `reviews where(caregiverId == X).orderBy(createdAt desc)` — pre-existing, just enhanced
- `appointments where(date == X).where(status == confirmed).where(clientDayBeforeReminderSent != true)` — **new pattern**, may need a composite index

If you see Firestore "needs an index" errors after deploy, click the auto-link in the error log and Firebase will create the index for you.

---

## 1. What gets pushed

### 1.1 Cloud Functions — modified

All deploy together as one revision per function. The full list of source files that changed:

| File | What changed |
|---|---|
| `functions/src/linq/webhooks.ts` | LINQ_WEBHOOK_SECRET fail-closed, OTP cold-inbound, persona shift detection + resolve, mid-match refilter, language detection, crisis LLM verification, localized strings, START opt-in, contextual timeout messages, day-before client confirm handler routing, soft-resume ack, orphan session recovery |
| `functions/src/agents/qaAgent.ts` | Zep timeout marker, supervisor fail-open alerting, expired-goal marker, system prompt rewrite (12 new tools + 9 previously-undocumented tools + notification directive + language directive), prefetch hit/miss logging, cancel_appointment + cancel_subscription metrics |
| `functions/src/agents/caraAgent.ts` | Supervisor fail-open alerting |
| `functions/src/agents/onboardingConversation.ts` | `verify_phone` step, role-switch detection, language-aware OTP messages |
| `functions/src/agents/taskApprovalHandler.ts` | Question guard on booking selection |
| `functions/src/agents/refundHandler.ts` | Question guard at confirmation |
| `functions/src/agents/modifyScheduleFlow.ts` | Question guard at confirmation |
| `functions/src/agents/jobPostingFlow.ts` | Question guard at confirmation |
| `functions/src/agents/healthcareHandler.ts` | `hc_newrx_condition` step |
| `functions/src/agents/clientSwapRequestHandler.ts` | Question guard at selection |
| `functions/src/browser/credentialCollector.ts` | Question guard on username + password (regex + LLM, fail-closed) |
| `functions/src/safety/crisisDetector.ts` | LLM verification for keyword hits |
| `functions/src/sms.ts` | `optInPhoneNumber`, admin_alert on circuit breaker open |
| `functions/src/linq/client.ts` | `admin_alerts` write on send failure |
| `functions/src/utils/sessionState.ts` | `pendingPersonaResolve`, `pendingClientShiftConfirm` flags |
| `functions/src/utils/caraMessage.ts` | `language` parameter |
| `functions/src/scheduled/nightlyMemory.ts` | Conversation-summary threshold lowered from 30 to 15 |
| `functions/src/mcp/server.ts` | IDOR fix on `send_client_message`, 12 new tools, notification surfacing across 10 tools, `get_caregiver_reviews` enhanced, parser-ambiguity fixes |
| `functions/src/index.ts` | Export new scheduled functions, OTP gate on `initiateCara` |

### 1.2 Cloud Functions — new files (deployed automatically)

| File | Purpose |
|---|---|
| `functions/src/utils/phoneVerification.ts` | OTP generation + constant-time compare |
| `functions/src/utils/personaShiftDetector.ts` | Detects different-senior / different-role messages |
| `functions/src/utils/language.ts` | English/Spanish detector + message bank |
| `functions/src/utils/matchRefilterDetector.ts` | Mid-match LLM intent detector |
| `functions/src/utils/toolNotify.ts` | `trySend` helper for structured notification outcomes |
| `functions/src/agents/clientShiftConfirmHandler.ts` | Day-before CONFIRM/CANCEL/question handler |
| `functions/src/scheduled/clientDayBeforeReminder.ts` | New scheduled function (see §1.3) |
| `functions/src/scheduled/clientThirtyMinReminder.ts` | New scheduled function (see §1.3) |

### 1.3 New scheduled functions (Cloud Scheduler will auto-create cron jobs)

These exports in `functions/src/index.ts` cause Firebase to register new Cloud Scheduler jobs on first deploy:

- **`sendClientDayBeforeReminders`** — runs daily at 8 PM ET (`0 0 * * *` UTC with timezone `America/New_York`). Sends day-before heads-up to families with confirmed appointments tomorrow; sets `pendingClientShiftConfirm` session flag.
- **`sendClientThirtyMinReminders`** — runs every 15 minutes (`*/15 * * * *`). Sends on-the-way notification 25–40 minutes before shift start.

Both fire automatically after deploy. **The first day-before run will text every confirmed appointment for tomorrow** — that's the expected behavior, but worth knowing so you're not surprised.

### 1.4 Test files (NOT deployed)

`scripts/transpile.js` excludes `*.test.ts` and `*.spec.ts` from the build output. These ship to git only:

- `functions/src/utils/{phoneVerification,language,matchRefilterDetector,personaShiftDetector}.test.ts`
- `functions/src/safety/crisisDetector.test.ts`
- `functions/src/browser/credentialCollector.test.ts`
- `functions/src/agents/{taskApprovalHandler,clientShiftConfirmHandler,bereavement}.test.ts`
- `functions/src/mcp/__tests__/{profile,discovery,safety,journal,communication,booking,family,coverage-smoke}.test.ts`

### 1.5 Documentation (NOT deployed, repo-only)

- `CARA_CLIENT_SMS_AUDIT.md` — original audit
- `CARA_DEFERRED_WORK.md` — what's not in this round
- `CARA_DEPLOY_PLAN.md` — this file

### 1.6 New Firestore collections (created on first write, no schema deploy)

- `email_change_requests/` — pending email verifications
- `reports/` — abuse reports from `report_user`
- `client_cancel_requests/` — client-initiated cancellations from day-before flow
- `agent_tool_metrics/` — instrumentation for cancel_appointment / cancel_subscription success rate

Firestore creates these on first write. **No manual setup required.** But check that your security rules allow writes from Cloud Functions (default deny + admin SDK bypass is the standard pattern; should already be in place).

---

## 2. Deploy command

From the project root:

```bash
# Full functions deploy
npm run deploy --prefix functions

# OR equivalently from the functions/ dir
firebase deploy --only functions
```

This pushes every function in one shot. Firebase Functions doesn't support partial code deploys of a single revision, so it's all-or-nothing.

**Expected duration:** 3–8 minutes depending on cold-deploy plumbing.

**FUNCTIONS_DISCOVERY_TIMEOUT:** Per [memory/project_functions_discovery_timeout.md](functions/src/), this codebase needs `FUNCTIONS_DISCOVERY_TIMEOUT=120` set or the analyzer times out at 10s. If you've deployed recently and it worked, this is probably already configured.

If using `npm run deploy` doesn't include the timeout, run:

```bash
FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions
```

---

## 3. Post-deploy verification (first 30 minutes)

### 3.1 Smoke probes

Send these messages to Cara's Linq number from a phone that already has a complete session (not a brand-new one — those will hit OTP):

| Test | Expected response | Tests |
|---|---|---|
| "What time is my next visit?" | Cara reads from cached context or calls `get_upcoming_appointments` | qaAgent baseline |
| "What do other families say about [a real caregiver's name]?" | Cara calls `get_caregiver_reviews`, summarises | New tool surfaced in prompt |
| "Save [caregiver] as a favorite" | Cara confirms + calls `save_caregiver_favorite` | New tool |
| "Change my address to 123 Test St, Brooklyn, NY 11201" | Cara reads back, confirms, then calls `update_user_profile` | New tool |
| "Cancel my visit tomorrow" → "yes confirm" | Response includes a notification status; if caregiver was reached Cara says so, if not she names it | Trust fix |
| Reply STOP, then reply START | Goes silent after STOP; reactivates after START | I4 fix |

### 3.2 Brand-new phone (OTP gate)

From a phone that doesn't exist in `agent_sessions`:

1. Text Cara from a fresh number → expect *"Quick security check first: please reply with the code XXX-XXX..."*
2. Reply with the code → expect role question
3. Reply with `RESEND` between codes → expect "give it a moment" if <30s, else fresh code

### 3.3 Cold inbound from spoofed-looking number

You can't easily test this without an SMS gateway, but verify in logs:

```bash
firebase functions:log --only linqWebhook
```

Look for `linqWebhook: LINQ_WEBHOOK_SECRET is not set` — if you see this, deploy failed-closed; restore the secret.

### 3.4 Watch admin_alerts (first 24 hours)

```javascript
// In Firestore console or via gcloud:
db.collection("admin_alerts")
  .where("createdAt", ">", "2026-05-23T00:00:00Z")
  .orderBy("createdAt", "desc")
  .limit(50)
```

Things you might see (and what they mean):
| Alert type | Severity | Meaning |
|---|---|---|
| `linq_send_failure` | high | A downstream notification didn't go through. Bursts = Linq outage. |
| `linq_circuit_breaker_opened` | critical | Linq phone health went CRITICAL. Investigate immediately. |
| `supervisor_fail_open` | high | Cara sent a message unsupervised because the safety check failed. Bursts = supervisor outage. |
| `user_blocked` / `user_reported` | medium | Family used the new safety tools. Triage normally. |
| `qa_agent_failure` / `qa_loop_exhausted` | medium | Pre-existing alert types, watch for any uptick after deploy. |

If you see >5 `supervisor_fail_open` or `linq_send_failure` alerts per hour sustained, that's a real outage signal — not a deploy artifact.

### 3.5 First day-before reminder run

The first `sendClientDayBeforeReminders` execution happens at 8 PM ET the day after deploy. Watch logs:

```bash
firebase functions:log --only sendClientDayBeforeReminders
```

Look for `[sendClientDayBeforeReminders] Error for appointment` lines — those are appointments that failed to send a reminder. Counts above a few per night warrant investigation.

### 3.6 First 30-min reminder run

Within 15 minutes of any confirmed appointment that day:

```bash
firebase functions:log --only sendClientThirtyMinReminders
```

Should see a hit if any appointments are 25–40 minutes out.

---

## 4. Rollback plan

If something is materially wrong (Cara going silent, mass IDOR errors blocking legitimate caregivers, wrong-language responses), roll back:

### 4.1 Find the previous revision

```bash
firebase functions:list                    # see deployed functions
gcloud functions describe linqWebhook \    # see deployment history
  --region=us-central1 --format=json | jq '.versionId'
```

### 4.2 Roll back via git + redeploy

The most reliable rollback path:

```bash
git log --oneline -10                      # find the commit before this session's work
git checkout <previous-commit> -- functions/src/
cd functions && npm run build              # transpile previous source
npm run deploy --prefix functions          # deploy previous code
```

**Do not** try to manipulate `lib/` directly to roll back — it's downstream of source and won't be picked up by Cloud Build cleanly.

### 4.3 Partial rollback (less common)

If only one feature is broken (e.g., the new day-before reminders), you can:

1. Comment out the export in `functions/src/index.ts`:
   ```ts
   // export { sendClientDayBeforeReminders } from './scheduled/clientDayBeforeReminder';
   ```
2. Rebuild + redeploy.

This stops the scheduled function from running. The other changes stay in place.

### 4.4 Emergency: kill the webhook

If `linqWebhook` is misbehaving and you need it offline immediately while you investigate:

```bash
gcloud functions delete linqWebhook --region=us-central1
```

This stops all inbound message processing. Linq's retries will queue for a while; redeploying restores service.

---

## 5. Risk ranking (so you know what to watch)

| Change | Risk | Why |
|---|---|---|
| **LINQ_WEBHOOK_SECRET fail-closed** | HIGH if secret missing, NONE otherwise | A single env-var misconfig takes Cara fully offline. Verify before deploying. |
| **System prompt rewrite** | MEDIUM | Changes Claude's behavior across every conversation. Tests pass but real-world phrasing might surprise users. |
| **send_client_message IDOR fix** | MEDIUM | Could block legitimate caregivers if the "active relationship" heuristic is wrong (e.g., a caregiver whose only appointment was completed 31 days ago is now blocked). Worst case: caregiver gets a "no active engagement" error and contacts support. |
| **trySend / notification surfacing** | LOW | Adds structured outcomes; existing happy paths unchanged. |
| **12 new tools** | LOW | Additive. Claude can ignore them if she wants. |
| **OTP gate on new phones** | LOW | Only affects brand-new sessions, which already had no users to break. |
| **New scheduled functions** | LOW | New cron jobs, first run starts ~24h after deploy (for day-before) or within 15min (for 30-min). |
| **Conversation-summary threshold change (30 → 15)** | LOW | Slightly more frequent nightly compression jobs. |
| **Crisis LLM verification** | LOW | Fail-safe to crisis, so worst case is the previous behavior. |

---

## 6. Suggested rollout

For lowest blast radius:

1. **Deploy to staging Firebase project** if you have one. Walk through §3 probes there first.
2. **Verify staging logs are clean** for 1 hour before promoting to production.
3. **Deploy to production** during a low-traffic window (e.g., late evening Pacific).
4. **Stay on call** for the first hour after deploy. Watch `admin_alerts` and `linqWebhook` logs.
5. **Re-run §3 smoke probes** against production.

If no staging project exists, the same flow applies to production with extra attention to §3.4 admin alerts during the first 24 hours.

---

## 7. What is NOT deployed (yet, deferred)

From [CARA_DEFERRED_WORK.md](CARA_DEFERRED_WORK.md) — items the audit surfaced that need product decisions:
- Race conditions on `accept_shift_swap` / `request_instant_payout` / `submit_shift_hours`
- Browserbase explicit timeout
- Input validation (HH:MM, dates, ranges)
- Spanish UI on the web (only the SMS path is bilingual)

None of these are deploy blockers — they're tracked work for the next round.

---

## 8. After deploy — communication

Consider:
- A short note to the team that Cara is now bilingual, has the new client reminders, and that admin_alerts will start seeing `user_blocked` / `user_reported` rows from the new safety tools.
- A heads-up to support that families may start using SMS for things they previously used the web for (address updates, blocking, favorites).
- No customer-facing announcement needed — most of this is silent quality + capability.
