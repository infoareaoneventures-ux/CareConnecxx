# Evia Memory Hardening Rollout

Runbook for the memory-grounding hardening waves
(docs/plans/2026-07-17-002-fix-evia-memory-grounding-hardening-plan.md, U1–U9).
Firebase project: `careconnex-d4c8b`. Branch: `fix/evia-memory-grounding-hardening`.

Rules that apply to every step in this file:

- **No secrets or user content** are ever pasted into this runbook, into logs,
  or into alert docs. Every proof below is counts, enums, hashes, timestamps,
  or function names.
- All commands run **from the repo root** (`CareConnecxx-main` — the sole
  deploy folder). The deploy CLI is always `node_modules/.bin/firebase`.
- Deploys ship the **working tree**, not HEAD — "uncommitted" is not
  "not live". Step 1 requires a clean tree for exactly this reason.

## 0. Local gates (run before anything touches production)

```
# Targeted suites (one invocation each — see the plan's Verification Contract):
npm test -- --run functions/src/memory/zepClient.test.ts functions/src/memory/conversationMemory.test.ts functions/src/memory/memoryOperations.test.ts functions/src/memory/learnedFacts.test.ts functions/src/memory/memoryFiles.test.ts functions/src/memory/memoryFiles.reconcile.test.ts
npm test -- --run functions/src/scheduled/nightlyMemory.test.ts functions/src/scheduled/memoryOperationWorker.test.ts
npm test -- --run functions/src/linq/webChat.test.ts "functions/src/linq/__tests__/routeIntent.characterization.test.ts" functions/src/agents/qaAgent.history.test.ts
npm test -- --run functions/src/agents/qaAgent.test.ts functions/src/agents/humanHandoff.test.ts functions/src/agents/groundingClaims.test.ts functions/src/agents/turnMetrics.test.ts functions/src/agents/goldenTranscripts.test.ts
npm test -- --run functions/src/data/seniorProfileRepository.test.ts "functions/src/mcp/__tests__/seniorIsolation.test.ts" "functions/src/agents/__tests__/profileBriefing.test.ts"
npm test -- --run "functions/src/observability/__tests__/caraOpsAlerts.test.ts"

# Functions transpile (must print "0 errors" and exit zero):
npm --prefix functions run build

# Root typecheck + frontend build (frontend OOMs at the default heap):
npm run typecheck
NODE_OPTIONS=--max-old-space-size=8192 npm run build
```

Broad regression: the full vitest tree **OOMs in a single run on this
machine** — run it as TWO path-partitioned halves (e.g.
`npm test -- --run functions/src/agents functions/src/linq` then a second run
covering the remaining paths: `functions/src/memory functions/src/scheduled
functions/src/mcp functions/src/observability functions/src/data …`). Any
pre-existing flake is re-run and documented, never ignored.

## 1. Predeploy checks (Deployment Gate steps 1–2)

```
git status --short             # must be clean apart from the intended change set
git branch --show-current      # fix/evia-memory-grounding-hardening
git rev-parse HEAD             # record: local SHA
git rev-parse origin/fix/evia-memory-grounding-hardening   # record: remote branch SHA
git rev-parse origin/main      # record: origin/main SHA
node_modules/.bin/firebase use # must print: careconnex-d4c8b
```

- If HEAD has moved past the plan's review ref (`ea843ef`), re-read the changed
  seams before deploying (Deployment Gate step 1).
- **Env VALUES diff (mandatory):** a full functions deploy with a partial
  `functions/.env` **wipes the missing values in production**. Before any
  deploy, diff every key AND value in `functions/.env` against the live
  configuration (compare against the last known-good deploy-machine copy).
  Missing keys = stop. This is a standing repo rule.
- `FUNCTIONS_DISCOVERY_TIMEOUT` is **plain seconds, no "s" suffix**
  (e.g. `FUNCTIONS_DISCOVERY_TIMEOUT=120`). Without it large deploys can fail
  silently at discovery.
- Hosting is **not** deployed in this rollout: the wave changed no frontend
  artifacts. If a frontend diff appears, stop and re-review scope first.

## 2. Index-first deploy order (Deployment Gate step 3)

The nightly memory query, the operation worker sweep, and the completed-
operation cleanup all depend on composite indexes. **Indexes deploy and reach
READY before any dependent function.**

```
node_modules/.bin/firebase deploy --only firestore:indexes --project careconnex-d4c8b
```

Poll until READY (repeat until no CREATING rows remain):

```
node_modules/.bin/firebase firestore:indexes --project careconnex-d4c8b
# or, with gcloud:
gcloud firestore indexes composite list --project careconnex-d4c8b --format="table(name,state)"
```

Indexes this rollout requires (all three are in `firestore.indexes.json`):

- `agent_sessions`: `onboardingStep ASC, optedOut ASC, userType ASC, lastMessageAt DESC`
  (U2 — nightly client selection)
- `memory_operations`: `status ASC, nextRetryAt ASC`
  (U3 — worker due/lease-expired sweep)
- `memory_operations`: `status ASC, expiresAt ASC`
  (U9 — bounded completed-operation cleanup, section 11)

Only after every required index reports READY may Wave A functions deploy.

## 3. Zep UUID provider contract probe (Provider Contract Gate)

Prove — outside production data — that (a) the same client message UUID sent
twice stores ONE message (or the duplicate response is one our adapter treats
as success), and (b) edge invalidation / episode deletion actually remove a
fact from `graph.search` and `getUserContext`. **Do not rely on deterministic
UUIDs or ship U4-dependent behavior until this passes.**

Prerequisites: `npm --prefix functions run build` (the probe imports compiled
adapters), `functions/serviceAccountKey.json` present, `ZEP_API_KEY` in
`functions/.env`.

Save the following as `zep-contract-probe.mjs` in a temp directory (NOT
committed), run it from the repo root, record its JSON output, then delete the
file:

```js
// Usage: node --env-file=functions/.env zep-contract-probe.mjs   (from repo root)
// Output: counts + sha256 UUID hashes ONLY. Deletes the synthetic thread/user.
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const admin = require('./functions/node_modules/firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(
  JSON.parse(readFileSync('./functions/serviceAccountKey.json', 'utf8'))) });
const { ZepClient } = require('./functions/node_modules/@getzep/zep-cloud');
const { deriveZepMessageUuid } = require('./functions/lib/memory/memoryOperations.js');
const { addUserMessageToZepStrict, addAssistantMessageToZepStrict,
        findZepEdgesMatchingFact, invalidateZepEdgeStrict, deleteZepEdgeStrict,
        deleteZepEpisodeStrict } = require('./functions/lib/memory/zepClient.js');
const { isZepDuplicateError } = require('./functions/lib/scheduled/memoryOperationWorker.js');

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const zep = new ZepClient({ apiKey: process.env.ZEP_API_KEY });
const userId = `evia-contract-probe-${Date.now()}`;
const threadId = `${userId}-thread`;
const FACT = 'Probe subject is allergic to zylophran'; // synthetic, never real

await zep.user.add({ userId, firstName: 'Probe' });
await zep.thread.create({ threadId, userId });

// Gate steps 1+2: same USER uuid twice → one stored message (or duplicate-success)
const uUuid = deriveZepMessageUuid('web', 'probe-turn-1', 'user');
const send = (fn) => fn().then(() => 'ok', (e) => isZepDuplicateError(e) ? 'duplicate-success' : Promise.reject(e));
const u1 = await send(() => addUserMessageToZepStrict({ threadId, content: FACT, userName: 'Probe', sentAt: new Date(), uuid: uUuid }));
const u2 = await send(() => addUserMessageToZepStrict({ threadId, content: FACT, userName: 'Probe', sentAt: new Date(), uuid: uUuid }));
// Gate step 4: repeat for the ASSISTANT role uuid
const aUuid = deriveZepMessageUuid('web', 'probe-turn-1', 'assistant');
const a1 = await send(() => addAssistantMessageToZepStrict({ threadId, content: 'Noted (probe).', sentAt: new Date(), uuid: aUuid }));
const a2 = await send(() => addAssistantMessageToZepStrict({ threadId, content: 'Noted (probe).', sentAt: new Date(), uuid: aUuid }));
// Gate step 3: fetch the thread and count stored copies per uuid
const thread = await zep.thread.get(threadId);
const msgs = thread.messages ?? [];
const userCopies = msgs.filter(m => m.uuid === uUuid).length;
const assistantCopies = msgs.filter(m => m.uuid === aUuid).length;
console.log(JSON.stringify({ step: 'uuid-idempotency', userUuidHash: h(uUuid), assistantUuidHash: h(aUuid),
  firstSend: [u1, a1], secondSend: [u2, a2], userCopies, assistantCopies, totalMessages: msgs.length }));

// Gate step 6: edge invalidation + episode deletion (graph extraction is async — poll)
let edges = [];
for (let i = 0; i < 24 && edges.length === 0; i++) {          // up to ~4 min
  await new Promise(r => setTimeout(r, 10_000));
  edges = await findZepEdgesMatchingFact({ zepUserId: userId, factText: FACT });
}
console.log(JSON.stringify({ step: 'edges-found', edgeCount: edges.length,
  edgeUuidHashes: edges.map(e => h(e.uuid)) }));
if (edges.length > 0) {
  await invalidateZepEdgeStrict({ edgeUuid: edges[0].uuid, invalidAt: new Date().toISOString() });
  const episodeUuids = [...new Set(edges.flatMap(e => e.episodes))];
  for (const ep of episodeUuids) await deleteZepEpisodeStrict(ep);
  for (const e of edges) await deleteZepEdgeStrict(e.uuid);
  await new Promise(r => setTimeout(r, 20_000));
  const after = await findZepEdgesMatchingFact({ zepUserId: userId, factText: FACT });
  const ctx = await zep.thread.getUserContext(threadId).catch(() => null);
  const ctxHasFact = !!ctx && JSON.stringify(ctx).toLowerCase().includes('zylophran');
  console.log(JSON.stringify({ step: 'invalidation-deletion',
    edgesInvalidatedOrDeleted: edges.length, episodesDeleted: episodeUuids.length,
    edgesRemainingAfter: after.length, contextStillReturnsFact: ctxHasFact }));
}

// Gate step 7: cleanup — delete the synthetic thread AND user
await zep.thread.delete(threadId).catch(() => {});
await zep.user.delete(userId).catch(() => {});
console.log(JSON.stringify({ step: 'cleanup', deleted: true }));
```

**Pass criteria (record the JSON lines as evidence):**

- `uuid-idempotency`: `userCopies == 1` and `assistantCopies == 1`, OR the
  second send reports `duplicate-success` — either satisfies KTD5. If both
  copies land (`userCopies == 2`), deterministic-UUID idempotency is NOT
  honored: stop, implement/verify `thread.get` read-before-retry
  reconciliation in the worker, and re-run this gate (Gate step 5).
- `invalidation-deletion`: `edgesRemainingAfter == 0` and
  `contextStillReturnsFact == false`. If the provider still returns the fact,
  **stop the Wave B (U4) rollout for product/privacy review** — do not delete
  or rebuild any production thread as a workaround.
- Nothing but counts and hashes is recorded. Delete the probe file afterwards.

## 4. MEMORY_FINGERPRINT_KEY provisioning and rotation (before Wave B)

Forget-tombstones are HMAC fingerprints keyed by this Secret Manager secret
(`functions/src/memory/fingerprintKey.ts`). The worker binds it via
`runWith({ secrets: [MEMORY_FINGERPRINT_KEY] })`; forget finalization is a
**retryable failure** until the secret is bound, so provision it BEFORE the
Wave B smokes.

Provision (generate ≥32 random bytes; paste the value when prompted — never
into `.env`, Firestore, or this file):

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
node_modules/.bin/firebase functions:secrets:set MEMORY_FINGERPRINT_KEY --project careconnex-d4c8b
# paste the generated value at the prompt, then clear the terminal scrollback
node_modules/.bin/firebase functions:secrets:access MEMORY_FINGERPRINT_KEY --project careconnex-d4c8b > /dev/null && echo BOUND-OK
```

The secret takes effect on the NEXT deploy of the bound function(s)
(`v1.memoryOperationWorker`). Verify after deploy: trigger a synthetic forget
(section 7, B2) and confirm the operation completes rather than cycling
`retryable_failed` with a fingerprint-key error class.

**Key rotation** (Data Changes / KTD16 rules):

1. `firebase functions:secrets:set MEMORY_FINGERPRINT_KEY` again — this creates
   a NEW VERSION of the same secret. Old versions remain stored in Secret
   Manager.
2. Rotation is a **code-accompanied change**: bump
   `CURRENT_FINGERPRINT_KEY_VERSION` in `functions/src/memory/fingerprintKey.ts`
   and extend the tombstone CHECK path to verify against every retained key
   version (current code verifies with the single bound version). New
   tombstones are stamped with the new `fingerprintKeyVersion`; existing
   tombstones keep their recorded version (recomputation is impossible without
   plaintext).
3. **Never destroy/disable a secret version while live tombstones reference
   it.** Before pruning any version N, confirm zero references: a
   `learned_facts` collection-group query on `fingerprintKeyVersion == N`
   must return empty.
4. Redeploy the bound function(s) so the new version is picked up.

## 5. Activity backfill (Backfill Gate — Deployment Gate step 4)

Prerequisite: `npm --prefix functions run build` (the script imports the
compiled decision module from `functions/lib`).

1. Dry run against production:

   ```
   node scripts/backfill-agent-session-last-message-at.mjs
   ```

2. Review the aggregate counts (this is the ONLY output — no IDs, no content).
   Exact vocabulary printed by the script: `scanned`, `completed`,
   `explicit clients`, `caregivers excluded`, `ambiguous role`,
   `already populated`, `recent history`, `stale history`, `no history`,
   `would update` (and `updated` in apply mode).

3. Record explicit production approval for the reviewed counts, then apply:

   ```
   node scripts/backfill-agent-session-last-message-at.mjs --apply
   ```

4. Re-run the dry run and require `would update: 0` (idempotency proof).

Notes: only evidence within the last 7 days is written; a missing `userType`
is repaired only from an explicit canonical role on `users/{userId}`;
ambiguous sessions stay excluded (counted under `ambiguous role`). The
backfill is never reversed on rollback — it records evidence-derived
timestamps only.

## 6. Deployment manifest + Wave A (Deployment Gate steps 5–6)

### 6.1 Generate the manifest

```
node scripts/generate-deploy-manifest.mjs
```

The script statically walks the `functions/src` import graph (static imports,
`export … from`, `require()`, dynamic `import()`) and lists EVERY deployed
export whose graph transitively includes a changed shared module (zepClient,
conversationMemory, memoryOperations, learnedFacts, memoryFiles,
fingerprintKey, qaAgent, humanHandoff, groundingClaims, contextManagement,
profileBriefing, turnMetrics, seniorProfileRepository, caraOpsAlerts,
routeIntent, webhooks, webChat, nightlyMemory, memoryOperationWorker,
externalSideEffect, mcp/server). It exits non-zero if any of the five
plan-required functions is missing (`linqWebhook`, `chatWithCara`,
`consolidateMemoryNightly`, `memoryOperationWorker`, `runTriggerEngine`) —
that would mean the walk broke, not that they are unaffected.

As of this writing it reports **142 affected functions of 196 deployed
exports** and prints the exact
`node_modules/.bin/firebase deploy --only "functions:v1.…" --project careconnex-d4c8b`
command. Always regenerate at deploy time — never reuse a stale list.

### 6.2 Wave A vs Wave B — what "waves" mean for this branch

All units (U1–U8) ship in ONE source tree, so both waves deploy the **same
manifest**; there is no code split between them. The wave separation is a
**verification gate**, not a second deploy:

- **Wave A gate** = deploy the manifest, then hold at section 6.4's smokes and
  section 8's metrics until healthy (typed Zep, activity/nightly selection,
  deterministic turn persistence, web/SMS parity, retry/idempotency).
- **Wave B gate** = only after Wave A is healthy AND the fingerprint secret is
  bound (section 4) AND the Provider Contract Gate passed (section 3), run
  section 7's smokes (correction/forget, canonical profile, grounding,
  tool-offload TTL).
- Wave-A-critical functions (watch these first): `v1.linqWebhook`,
  `v1.chatWithCara`, `v1.consolidateMemoryNightly`, `v1.memoryOperationWorker`,
  `v1.runTriggerEngine`, `v1.drainLinqOutboundQueue`.
- Wave-B-critical functions (same archives, exercised by Wave B behavior):
  `v1.linqWebhook`, `v1.chatWithCara`, `v1.memoryOperationWorker`, plus the
  scheduled surfaces that inherit reconciliation suppression
  (`v1.sendMorningBriefings`, `v1.sendWeeklyDigests`, `v1.runTriggerEngine`).
- Deviating from the manifest toward a full `--only functions` deploy is
  acceptable ONLY as a reviewed decision with the env-VALUES diff from
  section 1 re-confirmed (a full deploy with a partial .env wipes secrets).

### 6.3 Deploy

```
FUNCTIONS_DISCOVERY_TIMEOUT=120 node_modules/.bin/firebase deploy \
  --only "<paste the functions:v1.… list from the manifest output>" \
  --project careconnex-d4c8b
```

Verify update times afterwards (every manifest function must show a fresh
update timestamp):

```
gcloud functions list --project careconnex-d4c8b --format="table(name,updateTime)" | sort -k2 | tail -30
```

This wave creates **no new callable** (the only new export,
`v1.memoryOperationWorker`, is a Pub/Sub schedule) — but per the standing
missing-invoker rule, if any deploy ever CREATES a callable, verify its
invoker with an unauthenticated curl before calling it done.

### 6.4 Wave A production smokes (synthetic data only)

Use a designated test phone/account. Expected proofs are exact.

| # | Scenario | Steps | Expected proof |
|---|---|---|---|
| A1 | Web → SMS preference parity | Send a durable preference in web chat ("I prefer Tuesday visits" from the test client), then ask over SMS what day was preferred. | ONE `learned_facts` doc for the fact; ONE user/assistant Zep message pair (deterministic UUIDs) in the thread; the SMS reply recalls the preference. `memory_operations` shows one `turn_sync_…` doc with `status: "completed"`. |
| A2 | SMS → web parity | State a second synthetic preference over SMS, then ask on web. | Web reply recalls it; still exactly one learned fact — no duplicate. |
| A3 | Zep empty | Use a fresh test session whose Zep thread has no context. Send any message. | `cara.turn` log line has `zepContextStatus:"empty"`; NO `zep_sustained_outage` alert in `admin_alerts`; no delayed timeout warning ≥6s later. |
| A4 | Zep unavailable | Exercise the failure path with a TEST-ONLY invocation (e.g. the section 3 probe user with an invalid key) — never break the production env value. | `zepContextStatus:"unavailable"` or `"timeout"`; the reply hedges instead of asserting memory; the `zep_failure` log line carries `operation`/`error_class`/`correlation` only — no thread IDs, no query text. |
| A5 | Nightly selection | Ensure the test client has `lastMessageAt` within 7 days; a test caregiver and an opted-out client exist. Wait for the 06:00 UTC run (or force-run the scheduled job from the Cloud console). | `[consolidateMemoryNightly] memory batch` log shows `eligible ≥ 1, attempted ≥ 1, succeeded ≥ 1`; verify via Firestore reads that the caregiver's and opted-out client's memory files did NOT change (the log itself is aggregate-only by design). |
| A6 | Retry idempotency | Re-send the same web turn with the SAME `clientMessageId` (dev-tools replay of the `chatWithCara` call). | No new Firestore message rows, no new learned fact, no new Zep messages, no second `memory_operations` doc — the `turn_sync_<hash>` ID is deterministic. Worker log may show `zepDuplicates ≥ 1` (reconciled duplicate = success). |

Log filters (Cloud Logging):

```
resource.type="cloud_function" "cara.turn" "zepContextStatus"
resource.type="cloud_function" "memory_operation_worker"
resource.type="cloud_function" "[consolidateMemoryNightly] memory batch"
```

Hold at Wave A until section 8's Wave A metrics are in range for at least one
nightly cycle.

## 7. Wave B smokes (Deployment Gate step 7 — synthetic data only)

Prerequisites: sections 3 and 4 passed; Wave A healthy.

| # | Scenario | Steps | Expected proof |
|---|---|---|---|
| B1 | Correction | Seed a synthetic fact via the test client ("Mom is allergic to amoxicillin"), then correct it ("Actually it's penicillin, not amoxicillin"). | Reply acknowledges the correction (pending-acknowledgement wording is allowed — KTD10). Old fact doc gains `pendingCorrectionOperationId` then finalizes superseded; `memory_operations` has one `correction_…` doc reaching `completed`; `agent_audit_log` gains a `memory_fact_corrected` entry (no fact text); asking again returns ONLY the corrected value. |
| B2 | Forget + no-resurrection | Ask Evia to forget the synthetic allergy. Immediately ask about it; after the operation completes, ask again; then send a message restating the fact; finally wait for the next nightly run. | Immediate ask: Evia does not use the fact and does NOT claim deletion is complete while pending. After completion: fact absent from `learned_facts` plaintext (tombstone doc has `forgottenFingerprint`, no `fact` field), memory files, embeddings, Zep edges/episodes; the operation doc contains references only. Restating the fact triggers the explicit re-remember confirmation (not silent re-learning; `tombstone_refusals`/`reRememberAsked` telemetry fires). The nightly run does NOT recreate it. |
| B3 | Canonical profile | Create a synthetic senior with `senior_profiles/{id}` and a CONFLICTING legacy `seniors/{id}` doc. Ask about the senior. | Reply uses the canonical name/location/age; a cross-household MCP `get_senior_profile` read for that ID is denied. |
| B4 | High-risk grounding | Drive a draft containing an unsupported claim (ask a question whose truthful answer isn't in any store, on a medical/location/payment topic). Then repeat with the fact actually present in context. | Unsupported: reply is the deterministic neutral copy (or handoff); `cara.turn` shows `groundingVerdict:"unsupported"` or `"indeterminate"` + `groundingNeutralized:true`; any handoff/grounding alert context carries hashes/enums only. Supported: claim passes, `groundingVerdict:"supported"`. |
| B5 | Tool offload TTL | Trigger a large tool-result offload (e.g. an applicant/invoice listing) in a turn. | The active loop reads it by exact pointer; a later unrelated turn's context/search does NOT surface it; after 24h the nightly `transient tool-file cleanup` log shows `deleted ≥ 1` and its embeddings are gone. |

## 8. Monitoring (Production Monitoring section of the plan)

All series are Cloud Logging structured lines (no new per-turn Firestore metric
writes; alerts land in `admin_alerts`). Everything is aggregate/enum/hash —
the standing privacy assertion: **no new metric, alert, or Zep failure log
contains raw user messages, fact text, phones, Zep IDs, or prompt/reply
previews.** Spot-check this on every new alert type seen in production.

### 8.1 Per-turn (`cara.turn` lines, both `qa` and `quick` pathways)

| Field | Healthy | Alert / action |
|---|---|---|
| `zepContextStatus` distribution | ≥95% `loaded`/`empty`; `unavailable`+`timeout` <5% | Sustained ≥50% failures over ≥5 samples in a 10-min window ⇒ automatic `zep_sustained_outage` alert (deduped, one per 30-min bucket). `empty` NEVER alerts. Constants: `ZEP_OUTAGE_*` in `functions/src/observability/caraOpsAlerts.ts`. |
| `zepContextLatencyMs` | p95 < 6000 (the internal cap) | Rising toward the cap predicts timeouts — investigate Zep before the outage alert fires. |
| `memoryReconciliationPending` | rare, short-lived bursts around corrections/forgets | Sustained `true` for one user ⇒ stuck operation ⇒ section 10. |
| `factChangeOutcome` / `factChangeKind` | mostly `not_correction`; occasional `pending` → later `completed` | Any `failed` ⇒ inspect the matching `memory_operations` doc. |
| `tombstoneRefusals`, `reRememberAsked`, `reRememberConfirmed` | near zero; refusal spikes only right after a forget | Refusals WITHOUT a preceding forget ⇒ investigate extraction. |
| `groundingClaimCategories` / `groundingClaimRisk` / `groundingVerdict` / `groundingNeutralized` / `groundingVerifierIndeterminate` / `groundingVerifierLatencyMs` | neutralized+handoff on a small % of turns; `indeterminate` <2%; verifier p95 < ~3s | `indeterminate` spike = verifier outage (high-risk claims fail CLOSED — users see neutral copy, not errors); the kill switch (section 9) is a reviewed last resort. |
| `humanHandoffTriggered` | matches the pre-rollout baseline rate | A jump after deploy = grounding false positives; see section 9. |

### 8.2 Worker (`memory_operation_worker` JSON line, every minute)

| Counter | Healthy | Alert / action |
|---|---|---|
| `due` / `completed` | due drains within a few sweeps; completed ≈ due over time | Persistent `due > 0` with `completed = 0` ⇒ worker wedged. |
| `retryable` | occasional | Sustained growth ⇒ provider outage; the retry policy absorbs it — watch the aged alert. |
| `terminal` | 0 | Each terminal writes a deduped `memory_operation_terminal_failure` alert ⇒ section 10. |
| `blockedByOlder` | transient | Persistent ⇒ one old operation is starving a user's turn queue ⇒ section 10. |
| `zepDuplicates` | ~0; small numbers after worker restarts | Steady nonzero without crashes ⇒ investigate UUID reuse. |
| `agedPending` / `oldestDueAgeMs` | 0 / < 3,600,000 | Any due operation older than `AGED_MEMORY_OPERATION_ALERT_MS` (1 hour) auto-writes a deduped `memory_operation_aged` alert (one per operation) ⇒ section 10. |
| `factChangesCompleted`, `sourceRowsExcluded`, `claimMissed`, `unsupportedKind` | informational | `unsupportedKind > 0` ⇒ a writer created a kind the worker cannot process. |

### 8.3 Nightly (`consolidateMemoryNightly` / `[nightlyMemory] …` lines)

| Log line | Counters | Healthy |
|---|---|---|
| `[consolidateMemoryNightly] memory batch` | `eligible/attempted/succeeded/failed/skipped` | `eligible` tracks 7-day-active clients; `failed` near 0; `eligible: 0` for multiple nights on a live product = selection regression (check `lastMessageAt` writers). |
| `[nightlyMemory] compression` | `conversations/compressedMessages/skippedPendingSync/agedPendingRows/failed` | `agedPendingRows` = source rows unresolved > 24h ⇒ worker health (mirrors the aged alert). |
| `[nightlyMemory] transient tool-file cleanup` | `scanned/retained/deleted/malformed/failed` | `failed` 0; `malformed` counted-but-retained is expected for legacy slugs. |
| `[nightlyMemory] memory-operation cleanup` | `scanned/deleted/failed` | `deleted` starts near 0 and rises after day 30; `failed` 0. |

### 8.4 Other structured lines

- `zep_failure` (zepClient): `operation/error_code/error_class/correlation`
  only. Set a log-based metric on `zep_failure` for the outage dashboard.
- `learned_fact_write_refused` (learnedFacts): `tombstone_refusals` + reason
  enums — pairs with smoke B2.
- `re_remember_confirmed` (learnedFacts): counts explicit tombstone clears.
- `memory_turn_persistence_failed` / `memory_turn_persistence_skipped`
  (conversationMemory / webChat): a typed persistence failure is observable but
  never re-drives a committed user turn. Sustained nonzero ⇒ investigate.
  `…_skipped` also counts missing/invalid web `clientMessageId` traffic
  (Implementation-Time Checks) — should be ~0.
- `memory_reconciliation_check_failed` (memoryOperations): fail-open reads of
  the suppression flag — should be ~0.

### 8.5 `admin_alerts` types introduced/used by this rollout

| type | Source | Dedupe |
|---|---|---|
| `zep_sustained_outage` | turn metrics → caraOpsAlerts | deterministic ID per 30-min bucket |
| `memory_operation_aged` | worker sweep → caraOpsAlerts | deterministic ID per operation |
| `memory_operation_terminal_failure` | leased-operation engine | deterministic ID per operation |
| `human_handoff_*` / `grounding_*` | qaAgent / humanHandoff | context sanitized to a hash/enum allowlist by the sink |

## 9. Kill switches

- **`GROUNDING_RISK_TIERS_ENABLED`** (functions env var, read per turn):
  - Unset or any value other than `false` ⇒ **ON** (default): the U7 risk-tier
    claim classifier + typed verifier gate high-risk claims and fail closed to
    deterministic neutral copy.
  - `GROUNDING_RISK_TIERS_ENABLED=false` (case/whitespace-insensitive) ⇒ OFF:
    falls back to the pre-U7 detector + verifier behavior. Use if grounding
    causes false handoffs or latency spikes that cannot wait for a fix.
  - Changing it requires an env edit in `functions/.env` (with the section 1
    VALUES diff) and a redeploy of the qaAgent-bearing functions (the manifest
    list). It does NOT require rolling back code.
- There is **no kill switch for the memory worker or turn persistence** —
  disabling those is a rollback (section 12). Pausing the worker alone (Cloud
  Scheduler pause on its job) stops retries but leaves suppression masking in
  place: safe for privacy, but it degrades memory context for affected users —
  prefer fixing forward.

## 10. Force-resolve procedure for terminally failed operations

Trigger: a `memory_operation_terminal_failure` or `memory_operation_aged`
alert. A terminal correction/forget operation keeps the user's Zep/Storage
context masked (by design — privacy outranks recall) until resolved.

1. **Inspect** per-target statuses (read-only; uses the `operationId` from the
   alert):

   ```
   node --env-file=functions/.env -e "
   const admin=require('./functions/node_modules/firebase-admin');
   admin.initializeApp({credential:admin.credential.cert(require('./functions/serviceAccountKey.json'))});
   admin.firestore().doc('memory_operations/OPERATION_ID').get().then(s=>{
     const d=s.data();
     console.log(JSON.stringify({status:d.status,kind:d.kind,attempts:d.attempts,
       targets:Object.fromEntries(Object.entries(d.targets).map(([k,v])=>[k,v.status+(v.errorClass?(':'+v.errorClass):'')])),
       createdAt:d.createdAt,updatedAt:d.updatedAt},null,2));process.exit(0);});"
   ```

2. **Fix forward first.** If a target failed for a transient reason (Zep
   outage, unbound secret), fix the cause and requeue instead of forcing: set
   `status` to `retryable_failed` and `nextRetryAt` to now — the next sweep
   retries ONLY the unfinished targets (per-target progress is honored).

3. **Force-finalize** ONLY with a founder/operator accepted-risk decision
   recorded in the doc itself (name who accepted what risk, e.g. "Zep edge
   deletion unverifiable; accepted that the Zep layer may retain the
   assertion; learned-fact + Storage layers confirmed clean"). For a forget,
   NEVER force while the `learnedFacts` target is unresolved — the tombstone
   is the resurrection guard:

   ```
   node --env-file=functions/.env -e "
   const admin=require('./functions/node_modules/firebase-admin');
   admin.initializeApp({credential:admin.credential.cert(require('./functions/serviceAccountKey.json'))});
   const db=admin.firestore();const now=new Date().toISOString();
   const opId='OPERATION_ID';const userId='USER_ID';
   db.doc('memory_operations/'+opId).update({
     status:'completed',completedAt:now,updatedAt:now,
     expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString(),
     forcedResolution:{at:now,by:'OPERATOR_NAME',acceptedRisk:'REASON_TEXT'},
   }).then(()=>db.doc('memory_reconciliation/'+userId).update({
     ['pendingOperations.'+opId]:admin.firestore.FieldValue.delete(),updatedAt:now,
   })).then(()=>{console.log('force-resolved');process.exit(0);});"
   ```

4. **Verify suppression cleared:** the user's next turn no longer logs
   `memoryReconciliationPending:true`, and
   `memory_reconciliation/{userId}.pendingOperations` no longer contains the
   operation ID (the reader also self-heals completed entries).

5. Resolve the admin alert (admin UI / `v1.resolveAdminAlert`) with a note
   pointing at the `forcedResolution` field.

## 11. Completed-operation cleanup

Automatic: `consolidateMemoryNightly` runs `cleanupExpiredMemoryOperations()`
(functions/src/scheduled/nightlyMemory.ts) every night — it deletes up to 500
`memory_operations` docs with `status == "completed"` AND `expiresAt <= now`
via the `(status ASC, expiresAt ASC)` composite index, and logs
`[nightlyMemory] memory-operation cleanup {scanned, deleted, failed}`.

Guarantees:

- Failed/unresolved operations never carry `expiresAt` and are additionally
  excluded by the status filter — pending forget/correction suppression can
  never be cleaned away.
- The durable `agent_audit_log` entry is written at completion, BEFORE the
  operation becomes expiry-eligible, so accountability outlives the ledger row.
- Deleting expired completed docs is what keeps the reconciliation reader's
  self-heal correct ("a missing operation doc can only mean prior completion").

No manual action needed. If a backlog ever exceeds 500/night, run the nightly
job again on demand from the Cloud console (it is idempotent and bounded per
run).

## 12. Rollback

1. Identify the prior known-good SHA (the commit deployed before this wave —
   recorded in section 1).
2. Check it out in a CLEAN worktree (deploys ship the working tree):

   ```
   git worktree add ../rollback-evia-memory <PRIOR_SHA>
   cd ../rollback-evia-memory && npm ci && npm --prefix functions ci
   ```

3. Redeploy **every function in the generated manifest** (section 6.1 — the
   list generated from THIS branch, since those are the functions that
   received new code) from the prior SHA, with the same env-VALUES diff
   discipline:

   ```
   FUNCTIONS_DISCOVERY_TIMEOUT=120 node_modules/.bin/firebase deploy \
     --only "<manifest list>" --project careconnex-d4c8b
   ```

4. **Leave in place** (old code ignores them):
   - the three composite indexes;
   - `agent_sessions.lastMessageAt` (never reverse the backfill);
   - `memory_operations`, `memory_reconciliation`, and tombstoned
     `learned_facts` docs.
5. **Do NOT**:
   - delete unresolved correction/forget operation docs or clear pending
     suppression flags until their contents are exported for repair;
   - unmask pending forget facts — privacy state must not regress during a
     rollback (a forgotten-but-unpropagated fact stays suppressed);
   - deploy Hosting (nothing frontend changed);
   - run `functions:secrets:destroy` on `MEMORY_FINGERPRINT_KEY`.
6. If a future wave changes the operation schema incompatibly, pause the
   worker's Cloud Scheduler job BEFORE deploying old code so old workers never
   claim new-schema operations.
7. **Verify rollback:**
   - `gcloud functions list --project careconnex-d4c8b --format="table(name,updateTime)"`
     shows fresh update times on every manifest function;
   - a basic web turn and a basic SMS turn both reply;
   - metric shape matches the pre-rollout baseline (missing `zepContextStatus`
     fields on `cara.turn` is EXPECTED on pre-U1 code);
   - the operation lease count is not growing: the number of
     `memory_operations` docs with `status == "processing"` trends to a stable
     small number, not upward (old code never claims them; a climb means
     something is still writing).
8. Record: rollback SHA, deploy time, verification evidence, and the list of
   unresolved operations left masked for repair.
