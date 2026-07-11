# Spec: In-Shift Family Updates + Arrival Capture

Status: implemented 2026-07-10 (uncommitted). Ships ON behind `IN_SHIFT_UPDATES_ENABLED`.
Owner decisions: founder grilling session 2026-07-10 (see memory `in-shift-updates-decisions-2026-07-10`).

**Review round (same day, two-axis code review → all findings fixed):**
- The session flag/handler pair is named `awaitingInShiftUpdate` / `handleInShiftUpdateReply` (not "hourly" — the cadence is a tunable ladder), with the shared `AwaitingInShiftUpdate` interface exported from the policy module.
- `sendViaInteractionAgent` now returns `Promise<boolean>` (true only on a real transport hand-off); the per-shift ceiling and the `care_update_shared` audit count only real deliveries — DND-skipped or undeliverable sends no longer burn ceiling slots.
- `handleDone` clears `awaitingInShiftUpdate` (a DONE mid-prompt can't leave the care-notes reply to be swallowed), the dispatch checks `awaitingCareNotes` BEFORE the in-shift flag, and `shiftTaskNudges` skips caregivers with an open in-shift prompt (mutual exclusion both directions).
- `noShowPolicy` takes `canPing`: an unreachable caregiver (no phone) escalates to replacement after the combined ping+wait budget (25 min) instead of being stuck at "ping" forever.
- The silence escalation alert is one per appointment (`inShiftSilenceAlerted` flag), and the caregiver prompt only records state when the send actually went out.
- `ateWell`/`wasActive` are judged by the extraction LLM directly (tri-state true/false/null) — no keyword regex on user-derived text (CLAUDE.md rule).
- **Cadence override is now conversational end-to-end:** new client-only MCP tool `set_visit_update_frequency` (frequencyMinutes 30–480, or mode "default"/"off") writes `inShiftUpdateCadence` / `inShiftUpdatesPaused` on the client session; the sweep honors both (paused families get no mid-visit prompts at all). Registered per the new-tool checklist (MCP_TOOLS def + executor case, TOOL_CAPABILITIES "messaging", client system-prompt line; client-only — CLIENT_TOOLS at 124/128).

## Problem Statement

Once a caregiver arrives for a visit, the family hears nothing from Evia until the
shift-end summary — unless the senior's care plan happens to have a timed task that
the caregiver acks (`shiftTaskNudges`). A quiet visit with no scheduled tasks
produces **zero** family touchpoints between arrival and check-out. Families paying
for peace of mind experience the invisible hours as silence.

Separately, a caregiver who arrives on time but forgets to text ARRIVED is treated
as a no-show 20 minutes after start, and the family is told their caregiver "had to
cancel" — a false alarm that directly undermines trust.

## Solution

During an active visit, Evia periodically asks the caregiver one short, contextual
question ("Did Dorothy eat much for lunch?"), structures the reply, and relays the
substance to the family in warm, PHI-safe language — so the family stays aware
without texting the caregiver directly. If the caregiver is quiet, the family still
gets a facts-only heartbeat. And before any no-show escalation, Evia sends the
caregiver an arrival-capture ping so a forgotten ARRIVED never reads as a
cancellation.

Everything ships in the base $29.95 plan.

## User Stories

1. As a family member, I want periodic updates while my parent is being cared for, so that I don't have to interrupt the caregiver to know how things are going.
2. As a family member, I want updates to carry real substance ("ate a good lunch"), so that I get reassurance, not just a pulse.
3. As a family member, I want to still hear something if the caregiver is busy, so that silence never means I'm left wondering.
4. As a family member, I want to tune how often I hear ("hourly please" / "only if something's wrong"), so that updates match my anxiety level.
5. As a family member, I want updates to stop overnight during my quiet hours, so that a 1am note about a night shift doesn't wake me.
6. As a family member, I never want to be told something about my parent's wellbeing that wasn't actually observed, so that I can trust every message.
7. As a family member, I never want to be falsely told my caregiver cancelled, so that a missed text doesn't trigger panic.
8. As a caregiver, I want Evia to handle updating the family, so that I'm not fielding texts from relatives while I'm providing care.
9. As a caregiver, I want the check-in to be one short question, so that answering takes seconds.
10. As a caregiver, I want to hear when the family appreciated an update, so that I feel recognized.
11. As a caregiver on a night shift, I want the check-in to reach me while I'm working, so that quiet hours don't suppress a message meant for me.
12. As a caregiver, I want a nudge if I forgot to text ARRIVED, so that I'm not wrongly marked a no-show.
13. As a caregiver, I don't want to be penalized for not replying while I'm hands-on with a client, so that the tool feels like support, not surveillance.
14. As an operator, I want repeated caregiver silence during a shift surfaced internally, so that I can follow up without alarming the family.
15. As an operator, I want a per-shift ceiling on family messages, so that a bug can never machine-gun a family.
16. As an operator, I want a kill switch, so that I can disable the feature without a deploy.
17. As the business, I want each caregiver reply captured as structured wellness data, so that longitudinal trend detection becomes possible later.
18. As the business, I want in-shift updates exempt from the daily proactive cap, so that a long shift doesn't silently stop updating mid-afternoon.
19. As a family member with siblings, I want updates to reach the family group thread when one exists, so that everyone stays informed (existing group-thread routing).

## Implementation Decisions

- **New scheduled job `sendInShiftUpdates`** (`scheduled/inShiftUpdate.ts`, cron `*/15 * * * *`), registered in `index.ts`. Sweeps `appointments` where `status == "in-progress"` and `completedAt` absent — the same query shape as `shiftTaskNudges`.
- **Ladder cadence** (pure, `scheduled/inShiftUpdatePolicy.ts`): no update for shifts ≤ 90 min; first prompt 60 min after the arrival anchor; then every `cadenceMinutes` (default 120, family-overridable); suppressed within 45 min of scheduled end; hard ceiling of 6 family updates per shift. Anchor = `arrivedAt`, falling back to scheduled start.
- **Family cadence override**: read from the client session field `inShiftUpdateCadence` (minutes). Set conversationally later; the job already honors it.
- **Rotating question** (pure `pickRotatingQuestion`): care-plan/time-of-day aware; medication-confirmation folded in as one rotation when the plan has meds. Free-text reply; the question only sets the topic.
- **Caregiver reply handling** (`routeCaregiver.ts` `handleHourlyUpdate`, dispatched off session flag `awaitingHourlyUpdate`): LLM-structures the reply into a wellness snapshot written to the **new `in_shift_updates` collection** (deliberately separate from `care_journal` so it never trips the shift-end journal's one-per-appointment dedup), then relays the substance to the family and warmly acks the caregiver (buffer framing).
- **Family relay + heartbeat** go through `sendViaInteractionAgent`. Two new source agents `in_shift_update` and `in_shift_heartbeat` are added to `GROUP_SOURCE_AGENTS` (group-thread routing).
- **Cap policy** (`agents/caraAgent.ts`): new optional `AgentOutput.bypassDailyCap`. When set, the send still passes the quiet-hours/DND check (`shouldSend`, i.e. family DND = skip-not-queue) but is exempt from the 3/day `evaluateProactiveCap`. The weekly family budget is not invoked by this feature, so exemption there is automatic. The caregiver-facing question uses `canDrop: false` so it reaches a working caregiver regardless of quiet hours.
- **Facts-only heartbeat**: built from known facts only (names + arrival time); prompt explicitly forbids asserting wellbeing or saying the caregiver is unresponsive, with a deterministic fallback.
- **Internal escalation**: `inShiftUnansweredCount` on the appointment; ≥ 2 consecutive unanswered prompts writes a low-severity `admin_alerts` doc (deduped per appointment). Non-punitive; no matching/payment impact.
- **Arrival capture** (pure `triggers/noShowPolicy.ts`, wired into `triggerEngine.ts` no-show block): at start + 10 min with no arrival, send the caregiver a capture ping (`sourceAgent: "arrival_capture"`) and record `arrivalPingSentAt`; run `runEmergencyReplacement` only if the ping is unanswered for 15 min (and the caregiver hasn't replied since). The no-show scan window lower bound moved from 20 min to 8 min to catch ping candidates.
- **New appointment fields**: `inShiftLastPromptAt`, `inShiftPromptCount`, `inShiftFamilyUpdateCount`, `inShiftUnansweredCount`, `inShiftMedsPrompted`, `arrivalPingSentAt`. New session field: `awaitingHourlyUpdate` (+ `stateExpiresAt`).
- **Kill switch**: `IN_SHIFT_UPDATES_ENABLED` — ships ON, disable with `"false"`.

## Testing Decisions

- Good tests here assert **external decisions**, not internals: given a shift's timing/state, does the policy say prompt / skip / heartbeat / ping / replace? The cadence and escalation logic is isolated in two pure modules (`inShiftUpdatePolicy.ts`, `noShowPolicy.ts`) so every edge case is covered without Firestore.
- Prior art: `scheduled/__tests__/pendingTimesheetNudge.test.ts` tests exported pure decision functions the same way; that is the established seam for this repo's nudges.
- Covered: first-delay, cadence spacing, family override, end-of-shift suppression, per-shift ceiling, short-shift skip, no-anchor skip, don't-double-ask; heartbeat wait window + ceiling; arrival-capture grace window, ping, replace-after-unanswered, hold-if-engaged, never-touch-arrived. (26 cases.)
- The Firestore-coupled job body and the `routeCaregiver` reply handler are intentionally thin orchestration over the tested pure functions and existing send/relay helpers, matching how `shiftTaskNudges` + `handleTaskAck` are structured (not separately unit-tested).

**Completion round (same day — remaining Q7 decisions built + adversarial bug pass):**
- **Unprompted passthrough**: a spontaneous caregiver status text during an in-progress visit (LLM-classified; complaints/questions/interpersonal excluded) flows through the same structure→persist→relay pipeline via a shared `processInShiftUpdate` core, counts as the slot's update (pushes the next prompt out a full interval), and is tracked separately in `inShiftStats.unprompted`. Runs as the LAST check in caregiver routing so it can never shadow ARRIVED/DONE/ISSUE or any state machine.
- **Praise loop** (`linq/inShiftPraise.ts`): a family tapback or appreciative text within 1h of an in-shift update relays the warmth to the caregiver (`sourceAgent: in_shift_praise`, low urgency). One-shot per update via a transactional claim keyed on the stamp's `sentAt` (concurrent text+tapback can't double-praise; a newer update aborts the claim rather than mis-attributing). Both hooks are fire-and-forget side effects — the family's message still gets its normal routing/answer.
- **First-time framing**: the first-ever prompt to a caregiver carries the honest buffer pitch (Evia fields the family; documented visits approve hours faster); `inShiftIntroSent` on the session.
- **Concern consumption**: `concern: true` now writes a low-severity `in_shift_concern` admin alert and the family relay mentions it calmly (watched, not alarming).
- **Reply-rate rollup**: `caregivers/{id}.inShiftStats.{prompts,replies,unprompted}` — the non-punitive signal the 60-day badge decision reads.

**Adversarial bug pass (9 findings, 8 fixed, 1 accepted):**
1. CRITICAL — UTC-vs-Pacific date rollover: `handleArrived` now uses `businessTodayStr()`; `handleDone` and the unprompted hook drop the date clause entirely (caregiverId + status equality only — also lets a forgotten yesterday shift complete). Previously an evening-PT DONE missed the appointment and the sweep messaged the family about a finished visit until the ceiling.
2. The sweep's blocking-flag skip list now includes `pendingShiftConfirmation`/`pendingClientShiftConfirm`/`pendingCaregiverReferral`, and every path that clears `awaitingInShiftUpdate` leaves the SHARED `stateExpiresAt` alone when any other flow's flag is set (deleting it made those flows immortal).
3. The post-prompt appointment stamp + session flag are one atomic batch (a crash between them silently lost the slot: no re-ask for a full interval AND no heartbeat).
4. Praise one-shot made transactional (above).
5. Heartbeat's unanswered counter uses `FieldValue.increment` so a concurrently-processing reply's reset isn't clobbered by the sweep's stale read.
6. `arrivalPingSentAt` is stamped only when the ping actually sent; an undeliverable ping (no session/opted-out caregiver) falls back to the plain 25-min timeout instead of starting a 15-min clock on a message that never existed.
7. An explicit family cadence governs the FIRST prompt too ("every 8 hours" no longer produces a 60-min first update; "every 45 min" no longer waits an hour). +2 policy tests.
8. ACCEPTED RISK: no overlap guard on the */15 sweep — two overlapping runs could double-prompt. At SCC launch volume (handfuls of concurrent visits) a run finishing in >15 min is implausible; revisit with a per-appointment claim if visit volume grows 100x.
9. The family-relay fallback (LLM failure) no longer includes raw caregiver text or fabricated wellbeing — facts-only ("checked in — full picture in the end-of-visit summary").

## Out of Scope

- Sibling circle (add-a-relative to updates) — roadmapped next.
- Anomaly/deviation alerts from the accumulated `in_shift_updates` data — roadmapped after ~30–60 days of data.
- Post-hospital "transition protocol" denser cadence — later.
- Caregiver retention nudges / enabling the dormant `WOW_MOMENTS_ENABLED` — later.
- A visible caregiver communication score/badge — reply rate is logged but drives nothing punitive in v1.
- Family live-view web page.

## Further Notes

- Depends on `arrivedAt` / `status: "in-progress"`, set when the caregiver texts ARRIVED (or the app flips it). The arrival-capture ping is the mitigation for forgotten ARRIVED, but a caregiver who never responds at all still won't enter the hourly loop (they route to no-show replacement instead).
- Metrics to watch from day one: caregiver reply rate (< 50% ⇒ rethink question format), family opt-down rate (> 10% ⇒ too chatty), timesheet-approval latency, 60-day churn, and `in_shift_updates` volume. Stop-ship: any fabricated-wellbeing message or false "cancelled" alarm.
- Owed: fresh-number live E2E (this repo's standing verification gate) before calling it verified; commit.
