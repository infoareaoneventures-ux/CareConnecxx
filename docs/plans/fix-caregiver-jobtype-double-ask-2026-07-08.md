# Fix plan: caregiver onboarding asks the same question twice (job type)

**Status: DIAGNOSED, NOT FIXED. This doc is the implementation handoff.**

## Symptom (live, 2026-07-08 ~7:53 AM, founder test on iMessage)

Caregiver signup, agent-loop path. Evia asked:

> "Morning weekday availability is great. Are you looking for occasional, part-time, or full-time work?"

Caregiver replied **"Full time"**. Evia responded:

> "Got it. Are you looking for occasional, part-time, or full-time work?"

Identical question, back to back, immediately after acknowledging the answer.

## Which code path this is (important — NOT the scripted step runner)

`functions/.env` has `ONBOARDING_AGENT_LOOP=client,caregiver` (cohort 100%), so caregiver
conversational collection runs inside the **qaAgent loop** (`onboardingMode: true`), routed by
`shouldRouteOnboardingToLoop` in `functions/src/agents/onboardingContract.ts:160` from
`functions/src/linq/webhooks.ts:1813`. The scripted `CAREGIVER_STEPS.caregiver_ask_job_type`
runner (`onboardingSteps.caregiver.ts`) is NOT in play — don't fix it there.

Per turn, the loop:
1. Builds the directive from `session.onboardingData` (`qaAgent.ts:1729-1734` →
   `buildCaregiverOnboardingDirective` in `caregiverOnboardingDirective.ts`), which lists
   known vs STILL NEEDED fields (`missingRequiredFields`, `onboardingContract.ts:128`).
2. Relies on the MODEL (GPT-5.4) calling the `save_onboarding_field` MCP tool
   (`mcp/server.ts:6204`) to persist each answer.
3. Sends the reply from inside `runQaAgent`.
4. Only AFTER the reply is sent, the webhook's "persistence net"
   (`webhooks.ts:1905-1928`) runs `absorbCaregiverFields` (`caregiverFieldAbsorber.ts`) to
   deterministically rescue fields the model failed to save.

## Root cause chain (three stacked failures)

1. **The model turn didn't get `jobType` saved before composing its reply.** Either it never
   called `save_onboarding_field`, or the call was rejected (e.g. wrong `fieldName` like
   `job_type` fails `isAllowedField`, `mcp/server.ts:6215`). The directive at prompt-build time
   still listed jobType as the first STILL NEEDED item, and the directive's action line says
   "Ask for the SINGLE most natural next missing item — usually the first one listed" — so the
   model acknowledged ("Got it.") and re-asked jobType.
2. **The persistence safety net runs post-send** (`webhooks.ts:1905`). It silently rescues the
   data for the NEXT turn (so the flow recovers), but by design it cannot prevent the duplicate
   question the user already saw. The net is a data-loss guard, not a UX guard.
3. **The broken-record guard missed it.** `detectAgentSelfRepeat`
   (`frustrationSignals.ts:63`, send-site `qaAgent.ts:2732`) uses whole-message Jaccard
   token-set similarity with threshold 0.8. For this exact pair:
   prior ≈ {morning, weekday, availability, great, are, looking, occasional, part, time, full, work},
   candidate ≈ {got, are, looking, occasional, part, time, full, work} → intersection 7 / union 12
   ≈ **0.58 < 0.8** → no rewrite. A verbatim-identical question sentence hides behind a different
   intro sentence and sails under the whole-message threshold.

### Confirm before coding (5 min)

- Cloud Logging around the timestamp for this phone: `"webhooks: persistence net captured
  fields the loop skipped"` with `fields: ["jobType"]` ⇒ model skipped/failed the tool call
  (confirms cause 1). Also check `cara_turn_metrics` for that turn's `toolCalls` count, and
  `agent_uncertainty_log` (no `agentSelfRepeat` entry ⇒ confirms cause 3).

## The fix (in priority order)

### Fix 1 — Absorb fields PRE-turn so the directive can never re-ask a just-answered question (primary)

In the loop branch of `webhooks.ts` (before `runQaAgent` at :1870):

- Run the role-matched absorber (`absorbCaregiverFields` / `absorbClientFields`) on the inbound
  `text` against `session.onboardingData`.
- Persist the result to `agent_sessions/{phone}.onboardingData` (merge) AND mutate the
  in-memory `session.onboardingData` before calling `runQaAgent` — the directive is built from
  that in-memory object (`qaAgent.ts:1732`).
- Result: even if the model never calls the tool, the directive already shows
  `✓ jobType — already have it, do NOT ask again`, so the reply moves to the next item
  (hourlyRate). This is the same technique the pre-turn service-area gate already uses.
- **Dedupe with the existing location pre-gate** (`webhooks.ts:1833-1866`) — it already calls
  the absorber on location steps. Restructure so the absorber runs ONCE per turn and its output
  feeds both the service-area gate and the session merge. Preserve the gate's out-of-area /
  need_zip early-returns exactly.
- Keep the post-turn net (:1905) as backstop — it still covers the step-scoped bio capture
  (`webhooks.ts:1918`, deliberately not in the absorber) and anything the pre-turn parse missed.
  The absorbers only return not-already-filled fields, so double-write is impossible.
- The absorber is conservative (returns {} unless unambiguous), so mid-flow questions
  ("what does part-time mean?") won't produce spurious saves.
- Cost: one quick-tier LLM call before the model turn (~0.5s). Same call the post-turn net
  already makes when fields are missing; it mostly just moves earlier.

### Fix 2 — Catch acknowledgment+identical-question at the send site

`detectAgentSelfRepeat` should also do sentence-level matching: split candidate and recent
assistant messages into sentences; if a question sentence (ends in `?`, normalized) from the
candidate matches a question sentence in the last N=4 assistant messages verbatim-after-normalize
(or ≥0.9 Jaccard on the sentence alone), flag as repeated. Keep the 0.8 whole-message check.
The existing rewrite path (`qaAgent.ts:2745-2765`) then handles it; in `onboardingMode` the
rewrite prompt could additionally be told the answer was likely just given (accept-and-advance).
Add the exact screenshot pair as a regression test in `frustrationSignals.test.ts` — it must
detect `repeated: true`.

### Fix 3 — Normalize `jobType` (and validate enum-ish fields) in `save_onboarding_field`

`mcp/server.ts:6204` persists `fieldValue` raw. A model saving `"Full time"` stores that string;
`onboardingConversation.ts:267` (`copy("jobType", d.jobType)`) then copies it onto the caregiver
doc, where the scripted world guarantees `occasional|part_time|full_time`
(`onboardingSteps.caregiver.ts:194`, absorber `caregiverFieldAbsorber.ts:19`). Add a
normalization map in the tool handler for `jobType` (full time/full-time/FT → `full_time`, etc.;
unknown non-empty values → keep raw but log). Low risk, prevents downstream drift in matching.

## Guardrails / repo rules for the implementer

- NEVER add regex/keyword intent parsing of user text — this repo's CLAUDE.md mandates LLM
  parsing (`parseWithClaude`). Fix 2's sentence matching compares EVIA'S OWN outbound messages
  (allowed — same class as the existing Jaccard guard), not user intent.
- Do not re-add a context-free `isQuestionOrOther` copy anywhere (caused the 2026-07-06
  confirm-name loop).
- Don't touch the deterministic gates (photo/membership/Checkr/Stripe) or the scripted runner.
- Tests to run: `npm --prefix functions run build`, then the onboarding suites —
  `qaAgent.onboarding.test.ts`, `__tests__/onboardingContract.test.ts`,
  `__tests__/caregiverOnboardingDirective.test.ts`, `handleInbound.routing.test.ts`,
  `frustrationSignals.test.ts`. (onboardingReplay has 3 known pre-existing failures.)
- Deploy notes (from runbooks): deploy from `CareConnecxx-main` only; use the ROOT
  `node_modules/.bin/firebase` CLI; set `FUNCTIONS_DISCOVERY_TIMEOUT` (default 10s silently
  fails); verify the live env var count (69) is intact after deploy — a partial-.env full
  deploy wipes out-of-band secrets.
- Live re-test after deploy: fresh test number (`scripts/delete-phone.mjs <phone> --confirm`
  fully resets one), run caregiver signup to the job-type question, answer "Full time",
  confirm the next question is the hourly rate.
