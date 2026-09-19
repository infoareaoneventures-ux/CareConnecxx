# Evia Proactive Source Manifest (plan 2026-07-18-001 U8, KTD15/R40)

Frozen 2026-07-22. Every path that can SEND to a user, classified. Class rules:
- **reply** — responds to an inbound turn (not proactive; out of engine scope)
- **mandatory** — transactional/contracted: user expects it as part of an
  in-flight operation (reminders for booked visits, payment notices, gate
  links). Retains direct send; must keep its own dedupe + DND handling.
- **emergency** — safety: bypasses everything, documented here.
- **optional** — discretionary outreach: MUST route through the proactive
  decision engine (proactiveDecisionEngine.ts) as a candidate. Migration is
  per-source; unmigrated optional sources are listed as `pending` below.

Delivery/guard layers (not sources): `linq/client.ts`, `linq/outboundQueue.ts`,
`utils/dndGuard.ts` + `scheduled/dndQueueProcessor.ts` (DND queue),
`agents/proactiveCap.ts` (per-phone caps), `scheduled/proactiveBudget.ts`
(daily/weekly budgets), `agents/caraAgent.ts sendViaInteractionAgent` (ONE
VOICE interaction agent — all optional sends flow through it).

## Reply paths (engine-exempt)
`linq/routeIntent|routeClient|routeCaregiver|webhooks|webChat|inShiftPraise`,
`agents/qaAgent|matchingAgent|schedulingHandler|modifyScheduleFlow|
healthcareHandler|familyGroupManager|replacementAgent|clientShiftConfirmHandler|
issueEscalator (reply half)|caregiverReferral (reply half)`.

## Emergency (direct send, documented bypass — R40)
- `triggers/familyEmergency.ts` — emergency alert fan-out.
- `triggers/checkinAlert.ts` — missed-checkin safety alert.
- `scheduled/opsAnomalyWatch.ts`, `triggers/adminAlertNotifier.ts` — ops pages
  (to founder/admin, not families).

## Mandatory transactional (direct send retained; own dedupe/DND)
- Visit lifecycle reminders: `clientDayBeforeReminder`, `clientThirtyMinReminder`,
  `dayBeforeShiftReminder`, `thirtyMinShiftReminder`, `upcomingVisitReminder`,
  `preShiftFamilyCheckin`, `shiftTaskNudges`, `noVisitCheck` (booked-visit risk),
  `recurringScheduler` (schedule materialization notices).
- Money/legal: `pendingTimesheetNudge` (caregiver pay depends on it),
  `triggers/refundProcessor`, `triggers/disputeResolution`,
  `scheduled/backgroundCheckExpiry` (compliance), `triggers/appointmentUpdated`
  (booked-visit change notices), `triggers/jobApplicationTriggers` +
  `triggers/jobNotifications` (in-flight application/job responses).
- In-flight operation continuations: `agents/commitmentTracker` (promised
  follow-ups — recordCommitment contract), `agents/latenessTracker`,
  `agents/feedbackAggregator` (post-visit review request), gate-link resends.

## Optional discretionary (engine-owned; migration status)
| Source | Today | Engine status |
|---|---|---|
| `scheduled/proactiveReflection.ts` | review-first drafts | **submits candidates (slice 2)** |
| `scheduled/wowMomentsJob.ts` | daily warmth sends | **gated (engineGate.ts)** |
| `scheduled/morningBriefing.ts` | briefing sends | **gated (engineGate.ts)** |
| `scheduled/familySilenceCheckin.ts` | re-engagement | **gated (engineGate.ts)** |
| ~~`scheduled/familySatisfactionCheckin.ts`~~ | satisfaction ask | **removed 2026-09-18** — Evia-only question that treated the next reply as its answer; no site equivalent |
| ~~`scheduled/nextDayFamilyFeedback.ts`~~ | next-day "how did the visit go?" | **removed 2026-09-18** — same reason; the inbound intercept and `feedbackExpiry` went with it |
| `scheduled/wellbeingCheckin.ts` | wellbeing ask | **gated (engineGate.ts)** |
| `scheduled/staleSessionNudge.ts` | stale-session nudge | **gated (engineGate.ts)** |
| `scheduled/staleApplicantNudge.ts` | family nudge on applicants | **gated (engineGate.ts)** |
| `scheduled/onboardingReengagement.ts` | signup re-engagement | **gated (engineGate.ts)** |
| `scheduled/paywallWinback.ts` | winback | **gated (engineGate.ts)** |
| `scheduled/caregiverInactivityCheck.ts` | caregiver re-engagement | **gated (engineGate.ts)** — both sends (caregiver nudge + family warn, distinct dedupe keys) |
| `scheduled/firstVisitActivation.ts` | activation nudge | **gated (engineGate.ts)** |
| `scheduled/locationRequestNudge.ts` | location ask | **gated (engineGate.ts)** |
| `scheduled/inShiftUpdate.ts` | in-shift family updates | RECLASSIFIED mandatory-transactional (audited 2026-07-22: active in-progress shift only, per-family pause + cadence override, kill switch IN_SHIFT_UPDATES_ENABLED, bypassDailyCap by design — ≤1/day budget would break multiple-updates-per-shift) |
| `scheduled/weeklyDigest.ts` | weekly digest (perm-gated) | RECLASSIFIED mandatory (opted-in report: per-send `canSendWeeklyDigest` check, user-controllable unsubscribe, delivery-layer send; caveat: flag is default-granted, and the `weekly_digests` marker is written but never read — cron cadence is the only run-dedupe) |
| `scheduled/healthTrends.ts` | monthly summary | RECLASSIFIED mandatory (opted-in report) after 2026-07-22 repair: added missing per-send `canSendHealthAlerts` check + one-report-per-senior-per-month dedupe read (both were absent); still sends via raw transport (no DND/cap) — acceptable for a monthly opted-in report |
| `scheduled/jobMatchNotifications.ts` | caregiver job matches | **gated (engineGate.ts)** — per (caregiver, job) key, 7-day TTL; the gate is this source's ONLY dedupe (audit found none) |
| `agents/caregiverReferral.ts` (outreach half) | referral invites | reply-triggered only — engine-exempt (audited 2026-07-22: sole callers are `linq/routeCaregiver.ts` REFER flow + `mcp/server.ts create_caregiver_referral`, both inbound-turn paths; no scheduled/trigger caller) |
| `triggers/triggerEngine.ts` (non-safety triggers) | trigger sends | **gated (engineGate.ts)** |

Migration contract per source (KTD15): submit a PolicyCandidate instead of
sending; the engine ranks per recipient per pass; losers get explicit
dispositions (`deferred` re-enters after `nextEligibleAt`); winners flow
through sendViaInteractionAgent as today. Health-pattern candidates require
`concerningInsights` evidence (U7) — an LLM hunch is not evidence (R42).

Shared seam: `scheduled/engineGate.ts` `gateOptionalSend()` — loads recipient
state (daily tally, muted categories), runs the pure policy, persists an
explicit disposition to `proactive_decisions/{sha256(intent)}` (enums/counts
only, doc-id-keyed so cross-source dedupe needs no composite index), fails
OPEN on infra errors, honors policy decisions strictly. DND/opt-out/global
cap/supervisor stay owned by the delivery layer — the gate never
double-blocks them.
