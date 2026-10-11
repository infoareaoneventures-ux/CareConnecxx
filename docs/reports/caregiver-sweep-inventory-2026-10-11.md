# Caregiver sweep — inventory (2026-10-11)

Four research passes over the caregiver side (every site page with its reads and buttons; everything Evia can do by text; every scheduled job, trigger and notification; onboarding parity and mid-flow conversation points). Standard: the eight parity goals — Evia is the other entry to the site: same collections and fields, live data before acting, every site button has a text twin landing in the same place, the site's own gates and timing, background jobs held to the live-data standard, and (new) every mid-flow answer grounded in what is on the person's screen.

Groups: **A** Evia-only (founder decides remove vs build on the site) · **B** the site does it, Evia cannot (build) · **C** both do it, differently (match the site; the few product calls are marked) · **D** mid-flow answers not grounded (fix all) · **E** straight bugs and dead code (fix without a decision).

## A — Evia-only (decide per row: REMOVE or BUILD ON THE SITE)

| # | What Evia does | Where | Note |
|---|---|---|---|
| A1 | Caregiver referral by text (REFER, invite text, `referrals` doc) | caregiverReferral, routeCaregiver.ts:52-140 | api.ts:2093 says "SMS/server-owned by product decision" — confirm or remove |
| A2 | Full Checkr report over text (request/verify/get_checkr_report, `checkr_mcp_sessions`) | server.ts:1922-1953 | no site twin |
| A3 | Morning briefing (model-worded), weekly workload text, weekly earnings digest | scheduled/morningBriefing.ts, weeklyDigest.ts | no site page, no bell; the digest promises "payments within 2 business days" the page never says; briefing reads care-plan meds/journal notes |
| A4 | Claude-scheduled follow-ups and "commitment" re-answers texted to caregivers | triggers/triggerEngine.ts:604, commitmentTracker.ts:368/414 | model-worded, no bell |
| A5 | Timesheet REPORT keyword (totals by range) | caregiverTimesheets.ts:742 | site has a Report panel + CSV; text sends totals only |
| A6 | PAUSE keyword pauses immediately with no confirm (tool/intent path asks YES/NO; site has a Pause card) | caregiverSettings.ts:164 | pick one behavior |
| A7 | LATE relay flow (which family → message → confirm) — final write IS the site's Inbox message | familyRelay.ts | site has no LATE button; keep as the Inbox twin or remove the wrapper |
| A8 | Onboarding nudges (stale-session, re-engagement) model-worded; bell only sometimes | staleSessionNudge.ts:249, onboardingReengagement.ts:110 | 9/26 ruling: KEEP but every nudge must also bell — currently caregivers can be nudged from a stale step after finishing on the site |
| A9 | iMessage tapbacks, memory tools, get_signup_completeness, visit-mode Q&A, arrival nudge | internal / text-only by nature | keep (no site equivalent possible) |

## B — the site does it, Evia cannot (BUILD)

| # | Site button | Gap | Where |
|---|---|---|---|
| B1 | Accept / decline the FAMILY's proposed new visit time (Active Bookings row) | tool `manage_shift_reschedule` is not on the caregiver tool list; notice says "reply here to confirm"; no parked decision | server.ts:2445-2528 vs :2578; notificationTriggers.ts:633 |
| B2 | Rates for 2 / 3+ seniors and max clients at signup (wizard asks, optional) | Evia never asks them | onboardingContract.ts |
| B3 | Jobs board filters (search, pay range, time of day, days, radius) | browse_job_board has no filters | jobBoardText.ts |
| B4 | Withdraw a reschedule proposal you sent | no twin | CaregiverBookingsPage.tsx:895-912 |
| B5 | Family declined the caregiver's proposed interview time | no notice on EITHER door (site gap too) | notificationTriggers.ts:106 |
| B6 | Replacement request expired (30 min) | caregiver never told; parked ACCEPT stays; nudge waits 2h so never fires | shiftGenerator.ts:236, pendingDecisionNudge |
| B7 | Account paused / reactivated | no notification event on either door | admin/queue paths |
| B8 | Monthly caregiver plan renewal | sends nothing (text only for annual) | stripe.ts |

## C — both do it, differently (MATCH THE SITE; ⚑ = product call)

| # | Divergence | Evia | Site | Fix |
|---|---|---|---|---|
| C1 ⚑ | "Membership active" rule — FOUR versions | gate: active/trialing/past_due/payment_failed; send_client_message + LATE: active/trialing; signup_completeness: membershipPaid \|\| users.status \|\| subscriptionActive | gate hook same as Evia's gate; ProgressCard + AccountStanding exclude past_due/payment_failed | ONE shared rule both doors (retry state = active per 10/06) |
| C2 | "Payouts live" rule | signup_completeness: payoutsEnabled OR stripeOnboardingComplete; siteSync same | page + get_payout_status: payouts AND charges | one rule |
| C3 | Bio saved by text reaches the record only at completion (save tool writes the session only) | server.ts:7093 | wizard saves per step | mirror per field like the site |
| C4 | Evia moves the wizard cursor BACKWARDS / overwrites site edits at payout completion | onboardingConversation.ts:399-408, :4577-4613 | — | never move back; merge, don't overwrite |
| C5 | Membership paid on the SITE → Evia sends a second consent link; sync counts membershipPaid even when canceled | caregiverSiteSync.ts:39, stripe.ts:62 | — | checkout carries the phone; sync uses the site's rule |
| C6 ⚑ | Service-area check: Evia blocks outside Santa Clara County (waitlist); caregiver wizard has NO check | server.ts:7114 | — | add the check to the wizard (client wizard has it) |
| C7 | Wizard vs profile editor field names: rateForTwo/rateForThree vs rateFor2Seniors/rateFor3PlusSeniors; jobTypes many vs one; photo storage paths; bio 150 vs none; wizard no geocode; site never writes `jobType` matching reads | both | both | one field set, one storage path, one bio rule |
| C8 | Lock release texts the CAREGIVER "a client cancelled… sorry" (cancelledBy 'system' misread); family of a >24h visit told nothing | caregiverAccountEvents.ts:112-141, notificationTriggers.ts:809-830 | — | 'system' branch: family told, caregiver not |
| C9 | Auto-approve / auto-accept timesheet jobs write on a stale snapshot (race with a family approval or caregiver counter) | shiftHours.ts:474, :522 | — | re-read in a transaction like approvalNoticeDispatcher |
| C10 | Bell routes wrong on BOTH maps: new_job, application accepted/declined → dashboard; membership → payments; bgcheck/mvr/renewal → dashboard; every shift/booking/amendment → Requests tab | notificationRoutes.ts + notificationsPage.ts | — | route to the page the body names; shifts → Active |
| C11 | Texts with no bell (30-min + day-before reminders, interview confirmed + Meet link, briefings, follow-ups); bells with no text (payout_initiated, legacy requests, every "text dropped" case) | pass 3 (C) | — | bell ⇄ text in lockstep; bell written only when the text went |
| C12 | Fixed caregiver texts rewritten by the safety reviewer at delivery; LLM SEND/WAIT gate (prompt says "to a family") can drop nudge texts while the bell goes | supervisor.ts:39, caraAgent.ts:77 | — | reviewer never rewrites fixed strings; gate role-aware or removed for caregivers |
| C13 | newJobNotice raw sendMessage bypasses the supervisor and the session opt-out | newJobNotice.ts | — | go through the interaction agent |
| C14 | Checkr clear advances the session before the record is written; late report.updated can regress status; Stripe subscription status mirrored from the payload | checkr.ts:499/616, stripe.ts | — | write record first; ordering guards; retrieve |
| C15 | Renewal lock decided on a snapshot (consent during the sweep can still be locked) | renewalRefresh.ts | — | re-read in the lock write |
| C16 | Transport badge job rule (services \|\| skills) disagrees with the trigger rule (services-when-non-empty-else-skills) | transportBadge.ts | utils/transportDocs.ts | one rule |
| C17 | generateRollingShifts creates visits for a LOCKED caregiver | shiftGenerator.ts:264 | — | check eligibility |
| C18 | shift_missed bell says "reply LOG"; paid bell missing "$"; amendment withdrawn bell/text wording differ; bgcheck_document_required can fire twice | pass 3 | — | copy fixes |
| C19 | Evia's "about 5 minutes" vs site "3 minutes"; photo 6 MB vs 5 MB; directive claims a texted photo is saved (it isn't); caregiver email never format-checked by the save tool; Done copy on the site ignores membership → bg → payouts | pass 4 | — | match |
| C20 | Keyword shadowing: TODAY/TOMORROW/WEEK/MONTH/PENDING/HISTORY/ACCOUNT/BILLING steal one-word answers to the agent's own questions; SCHEDULE opens the editor; REACTIVATE entry dead; ARRIVED alias | routeCaregiver.ts | — | keywords only when no question is parked |
| C21 | Two LLM classifier calls on nearly every caregiver text (referral intent + LATE) | routeCaregiver.ts:52, :513 | — | one classifier, or only when plausible |

## D — mid-flow answers not grounded (FIX ALL: brief the model with the on-screen text + the step's facts + audience; never claim a change)

| # | Where | Screen | What the model gets | Grade |
|---|---|---|---|---|
| D1 | caregiverProfileHandler.ts (13 steps: rates, services, languages, job type, travel, bio, pause ask/confirm) | each section's recap/confirm | one static sentence | No (pause: "will I lose bookings?") |
| D2 | caregiverCancelShiftHandler.ts:237, :268 | confirm text / numbered list | static sentence; list not given | No (could invent fees/24h policy) |
| D3 | caregiverTimesheets.ts:660 review-correction choice; :522 submit confirm; :500 later charge turns; :675/:683 | proposal / summary | no money facts | Partly (the "is the base correct" pattern) |
| D4 | caregiverTimesheets.ts:704-707 counter note | note question | NO question check — a question becomes the note | — |
| D5 | caregiverPastBookings.ts:320 tasks (list not given); :288 end; :331 note | log-hours steps | shortened question | No / Partly |
| D6 | caregiverJobFlows.ts:227 reschedule date ("when is it now?"); :254 time; :118 cover letter | — | question only | No / Partly |
| D7 | instantPayoutHandler.ts:104 | Cash Out modal (fee, net, timing) | reply line only | Partly |
| D8 | inShift.ts:292 closing-note step stays open after a question → next free text becomes the closing note; FINISH parks without expiry | — | — | fix |
| D9 | familyRelay.ts:151 "What should I tell X?" | — | any reply, even a question, relayed verbatim | fix |
| D10 | decisionNotices.ts:89 questions during a parked notice go to the agent with no notice context | — | — | brief the agent |
| D11 | humanReply.ts:27 shared answerer has no "never claim you changed anything" rule | — | — | add (one place) |

## E — straight bugs and dead code (FIX, no decision)

Evia: CASH OUT reply never confirms (keyword runs before the confirm); bare CANCEL inside Cash Out / profile edit / availability opens the cancel-shift flow; prompt advertises get_care_journal, availability via update_caregiver_profile, caregiver_documents link (none exist); get_senior_profile always denied for caregivers; get_upcoming_appointments reads any family (no relationship check); PAYOUTS throttle says "reply LINK" but LINK only works during onboarding; stale comments (onboardingContract.ts:12-23, webhooks.ts:1918, caregiverOnboardingDirective.ts:10-17, routeCaregiver.ts:144); unreachable correction re-asks (onboardingConversation.ts:1217-1231); processDndQueue has no writers.

Site: inbox `?client=` ignored (every Bookings Message button opens an empty inbox; Calendar/Dashboard pass nothing); gated caregivers see Propose/Reschedule buttons that open nothing; Calendar interview Accept and JobBoard "Accept new time" ungated; Accepted applications invisible in My Applications; Calendar availability save treats failure as success; wizard `verificationStatus` write silently stripped; dashboard Start uses the client clock and no updatedAt, End no updatedAt/try-catch; "Complete Verification" on the dashboard goes to itself; two wizards can stack; overdue query shows `pending` shifts as missed (Log Hours completes them); Payments live-patch subscribes to publicCaregiverProfiles not caregivers; /bgcheck success uses a constant LINQ_PHONE; `?membership=success` unhandled; BackgroundCheckModal dead error branches; dead code (BookingGroupCard amendments UI, dashboard actionLabel, ProfileApprovalBanner import, hasEngagement, Settings hasTransportation, JobBoard onJobAccepted, dbService.acceptJob/declineRecurringGroup/applyToJob/getMyApplications, /caregiver/video route); rules: no server-side enforcement of shift gates / start window / one-visit (UI only) ⚑ decide whether to enforce in rules or a callable.
