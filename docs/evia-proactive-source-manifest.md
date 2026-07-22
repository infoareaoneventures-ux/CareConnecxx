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
| `scheduled/wowMomentsJob.ts` | daily warmth sends | pending |
| `scheduled/morningBriefing.ts` | briefing sends | pending |
| `scheduled/familySilenceCheckin.ts` | re-engagement | pending |
| `scheduled/familySatisfactionCheckin.ts` | satisfaction ask | pending |
| `scheduled/wellbeingCheckin.ts` | wellbeing ask | pending |
| `scheduled/staleSessionNudge.ts` | stale-session nudge | pending |
| `scheduled/staleApplicantNudge.ts` | family nudge on applicants | pending |
| `scheduled/onboardingReengagement.ts` | signup re-engagement | pending |
| `scheduled/paywallWinback.ts` | winback | pending |
| `scheduled/caregiverInactivityCheck.ts` | caregiver re-engagement | pending |
| `scheduled/firstVisitActivation.ts` | activation nudge | pending |
| `scheduled/locationRequestNudge.ts` | location ask | pending |
| `scheduled/inShiftUpdate.ts` | in-shift family updates | pending (kill switch IN_SHIFT_UPDATES_ENABLED) |
| `scheduled/weeklyDigest.ts` | weekly digest (perm-gated) | pending |
| `scheduled/healthTrends.ts` | monthly summary | pending |
| `scheduled/jobMatchNotifications.ts` | caregiver job matches | pending |
| `agents/caregiverReferral.ts` (outreach half) | referral invites | pending |
| `triggers/triggerEngine.ts` (non-safety triggers) | trigger sends | pending |

Migration contract per source (KTD15): submit a PolicyCandidate instead of
sending; the engine ranks per recipient per pass; losers get explicit
dispositions (`deferred` re-enters after `nextEligibleAt`); winners flow
through sendViaInteractionAgent as today. Health-pattern candidates require
`concerningInsights` evidence (U7) — an LLM hunch is not evidence (R42).
