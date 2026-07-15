# Evia Launch Action-Parity Map

> Generated mirror of `functions/src/agents/launchActionParity.ts`.
> `LAUNCH_ACTION_PARITY` is the source of truth; update this file whenever that registry changes.
>
> Enforcement lives in:
> - `functions/src/agents/toolCapabilities.test.ts`: shipped rows point at real tools/callables, blockers carry no tool, collections are registered, ids are unique, and caregiver tools are prompt-reachable.
> - `tests/contractCollections.test.ts`: shared Firestore collections stay aligned with web and rules usage.

**Status legend**

- **shipped**: tool/callable exists today and writes or reads the web-facing shape.
- **blocker**: launch-critical parity gap; tool must be null and notes must explain the gap.
- **non-goal**: explicitly out of scope.

**Prompt actor**: which prompt/tool-filter surface exposes the tool: `client`, `caregiver`, `admin`, or `any`. `--` means no tool is exposed yet.

## Client

| Actor | Action | Web surface | Collection | Evia tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| client | Search/match caregivers and request replacements | components/FindCaregivers.tsx | caregivers | `find_replacement_caregivers` | client | shipped |  |
| client | Book a caregiver (creates pending_caregiver_confirmation appointment) | components/client/booking/BookingFlow.tsx | appointments | `request_booking` | client | shipped |  |
| client | Reschedule an existing appointment | components/client/ClientVisitsPage.tsx | appointments | `reschedule_appointment` | client | shipped |  |
| client | Cancel an appointment | components/client/ClientVisitsPage.tsx | appointments | `cancel_appointment` | client | shipped |  |
| client | Update the senior's care plan | components/CarePlan.tsx | carePlans | `update_care_plan` | client | shipped |  |
| client | Record per-recipient day-to-day care tasks by category (care-plan interview / Step3CareNeeds parity) | components/client/postJob/Step3CareNeeds.tsx | carePlans | `save_care_task_detail` | client | shipped | Added 2026-07-15 with the post-payment care-plan interview; writes recipientPlans.{key}.careNeedDetails in the exact shape CarePlan.tsx renders. |
| client | Add a member to the family group | components/client/MyCareTeam.tsx | family_groups | `add_family_member` | client | shipped |  |
| client | Remove a member from the family group | components/client/MyCareTeam.tsx | family_groups | `remove_family_member` | client | shipped |  |
| client | Read the care journal / visit updates | components/client/CareJournalFeed.tsx | care_journal | `get_care_journal_client` | any | shipped |  |
| client | Comment on / like a care journal entry | components/client/CareJournalFeed.tsx | care_journal | `comment_on_journal_entry` | any | shipped |  |
| client | Message a caregiver | components/InboxView.tsx | threads | `send_caregiver_message` | client | shipped |  |
| client | Open a support ticket | components/shared/SupportChatModal.tsx | support_tickets | `create_support_ticket` | any | shipped |  |
| client | Get a Stripe payment-method update link | components/client/Payments.tsx | n/a | `get_payment_update_link` | any | shipped | Raw card details are never captured in chat; Evia only hands off a Stripe-hosted link. |
| client | View invoice history and details | components/client/Payments.tsx | n/a | `get_invoice_history` | client | shipped | Invoices live in Stripe + billing summaries, not a registered Firestore contract collection. |
| client | View pending timesheets awaiting approval | components/client/Payments.tsx | shiftHours | `get_pending_timesheets` | client | shipped |  |
| client | Approve/reject submitted shift hours | components/payroll/ReviewShiftHoursModal.tsx | shiftHours | `review_shift_hours` | client | shipped |  |
| client | Request a refund (creates admin-visible state) | components/client/Payments.tsx | admin_alerts | `create_refund_request` | client | shipped |  |
| client | Retry a failed shift payment | components/client/Payments.tsx | shiftHours | `retry_shift_payment` | client | shipped | Parity audit 2026-07-06: agent mirror of v1-retryShiftPayment — resets payment_failed → approved so the charge trigger re-fires. Owner-scoped; naturally idempotent. |
| client | Switch a confirmed booking's payment method (credit ↔ cash/venmo/zelle) | n/a | appointments | `update_booking_payment_method` | client | shipped | Parity audit 2026-07-06: the v1-updateBookingPaymentMethod callable had NO UI caller (reverse orphan) — agent-first. Same guards: owner only, status 'confirmed', not yet started. |
| client | Create a care reminder | n/a | n/a | `create_reminder` | client | shipped | Reminders are scheduled triggers, not a registered contract collection. SMS-first — the legacy RemindersPage web surface was removed 2026-07-02. |
| client | Submit a caregiver review | components/client/LeaveReviewModal.tsx | caregivers | `submit_review` | client | shipped |  |
| client | Read upcoming appointments | components/client/ClientVisitsPage.tsx | appointments | `get_upcoming_appointments` | any | shipped | Used by Evia recipe discovery for next-visit briefing and visit confirmation context. |
| client | Read the client's care team | components/client/MyCareTeam.tsx | caregivers | `get_care_team` | any | shipped | Used by Evia recipe discovery for next-visit and who-is-coming answers. |
| client | Review what Evia remembers | n/a | n/a | `cara_knows` | any | shipped | Memory is derived from scoped memory files, Zep context, learned facts, and live tool data; hidden prompt context is not exposed. |
| client | Correct or update Evia memory | n/a | n/a | `update_memory_file` | any | shipped | Fresh corrections outrank stale memory and learned facts. |
| client | See everything Evia has in flight (open promises, tasks, matches, to-dos) | n/a | n/a | `get_work_in_progress` | any | shipped | Unified WIP view over pending_commitments, agent_tasks(_active), and session todos/pendingMatches — agentic-reliability wave 2026-07. |
| client | Archive (soft-delete) a senior profile when care ends | n/a | senior_profiles | `archive_senior_profile` | client | shipped | Soft status flag only (status:'archived'); the care record is retained. Hard delete is an intentional exclusion (AGENT_NATIVE_EXCLUSIONS.md). |
| client | Edit a family group member's name/role/relationship/notifications | components/client/MyCareTeam.tsx | family_group_members | `update_family_member` | client | shipped | Ownership scoped by the userId+memberPhone query — only the caller's own membership docs are reachable. |
| client | List scheduled/pending interviews | n/a | video_interviews + interviews | `list_interviews` | any | shipped | Caller-scoped read (clientId OR caregiverId) across BOTH interview collections (web/MCP + SMS flow); results carry source + callUrl. |
| client | Cancel a scheduled interview | n/a | video_interviews + interviews | `cancel_interview` | any | shipped | Either participant can cancel their own interview; routes to whichever collection holds the doc; the counterpart is notified (trySend for caregivers, Linq session/clientPhone for clients). |
| client | Delete an Evia memory file (content + search index) | n/a | n/a | `delete_memory_file` | any | shipped | Memory files live in Storage (memory/{userId}/), not a Firestore contract collection; block embeddings are purged with the file. |
| client | List blocked users | components/InboxView.tsx | users | `list_blocked_users` | client | shipped | Read primitive over users.{uid}.blockedUsers (the array block_user/unblock_user maintain). |

## Caregiver

| Actor | Action | Web surface | Collection | Evia tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| caregiver | Update caregiver profile (rate/skills/bio) | components/CaregiverProfile.tsx | caregivers | `update_caregiver_profile` | caregiver | shipped |  |
| caregiver | Update availability | components/caregiver/CaregiverCalendarPage.tsx | caregivers | `update_caregiver_availability` | caregiver | shipped |  |
| caregiver | Browse the job board | components/caregiver/JobBoard.tsx | job_posts | `browse_job_board` | caregiver | shipped |  |
| caregiver | Apply to a job post | components/caregiver/JobBoard.tsx | job_posts | `apply_to_job` | caregiver | shipped |  |
| caregiver | Withdraw a job application | components/caregiver/JobBoard.tsx | job_posts | `withdraw_job_application` | caregiver | shipped | Sets job_applications.{id}.status='withdrawn' (the shape the client/admin applicant views read). |
| caregiver | Respond to an interview request | components/caregiver/CaregiverCalendarPage.tsx | video_interviews | `respond_to_interview_request` | caregiver | shipped | Accept notifies the client with the Google Meet join link (callUrl). |
| client | Schedule a video interview with a caregiver | components/ScheduleInterviewModal.tsx | video_interviews | `schedule_interview` | client | shipped | Generates the Meet link inline (callUrl in the create payload) and texts it to the caregiver; interviewLinkTrigger covers the web-modal path. |
| caregiver | Accept/decline a booking request | components/caregiver/CaregiverBookingsPage.tsx | appointments | `respond_to_booking_request` | caregiver | shipped | AE1. Accept drives the same appointment-confirmation path (status='confirmed', caregiverConfirmed) the web/shift-offer flow uses. |
| caregiver | Start a shift / clock in | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | `start_shift` | caregiver | shipped | Marks the visit in-progress + startedAt on the appointments (in_progress) or shifts (in-progress) doc the dashboard reads. |
| caregiver | Complete a shift / clock out | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | `complete_shift` | caregiver | shipped | AE7. Idempotent on SMS retry — an existing shiftHours record (or already-completed status) returns a no-op success, never double-billing. |
| caregiver | Toggle a visit task complete | components/caregiver/CaregiverHomeDashboard.tsx | appointments | `update_shift_task` | caregiver | shipped | Toggles shifts.{id}.tasksCompleted (recipient_careNeed[_subtask] keys) — the exact array the caregiver/family visit views read. |
| caregiver | Send a photo/media care update | components/caregiver/CaregiverHomeDashboard.tsx | care_journal | `submit_media_update` | caregiver | shipped | Writes a care_journal entry (entryType='media', media[]) the family care-journal/live-updates feed reads. |
| caregiver | Create a care journal entry | components/caregiver/CaregiverHomeDashboard.tsx | care_journal | `create_care_journal_entry` | caregiver | shipped |  |
| caregiver | Submit shift hours / timesheet | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | `submit_shift_hours` | caregiver | shipped |  |
| caregiver | Respond to a shift-hour correction | components/caregiver/CaregiverPaymentsPage.tsx | shiftHours | `respond_to_shift_hour_correction` | caregiver | shipped | Transitions shiftHours from correction_requested/disputed: accept → pending_client_review with corrected hours; pushback → disputed + admin_alert. |
| caregiver | Request an instant payout | components/caregiver/InstantPayoutModal.tsx | payouts (caregivers/{id}/payouts) | `request_instant_payout` | caregiver | shipped | Free (platform absorbs Stripe's instant fee — decision 2026-07-06). All paths (app callable, MCP tool, SMS PAYOUT) share payoutCommon.executeInstantPayout: balance-based, replay-guarded, Stripe idempotency key. |
| caregiver | Standard payout (automatic) | n/a — no user action | payouts (caregivers/{id}/payouts) | n/a — tool removed 2026-07-06 | caregiver | shipped | Standard payouts are automatic: Stripe's daily schedule sweeps the Connect balance to the bank (~2 business days after each shift payment). `request_standard_payout` was removed — Stripe rejects manual standard payouts on automatic schedules. The Connect webhook records automatic payouts to the ledger on payout.paid. |
| caregiver | View earnings | components/caregiver/CaregiverPaymentsPage.tsx | n/a | `get_caregiver_earnings` | caregiver | shipped | Earnings are derived from Stripe/shiftHours; no dedicated contract collection. |
| caregiver | View tax summary | components/caregiver/CaregiverPaymentsPage.tsx | n/a | `get_tax_summary` | caregiver | shipped |  |
| caregiver | Message a client | components/InboxView.tsx | threads | `send_client_message` | caregiver | shipped |  |
| caregiver | Refer another caregiver | n/a | referrals | `create_caregiver_referral` | caregiver | shipped | Writes non-bookable caregiver referrals, sends the SMS invite, and keeps bookability gated on onboardingStatus='profile_complete', verificationStatus='approved', and Checkr clear. |
| caregiver | Open a support ticket | components/shared/SupportChatModal.tsx | support_tickets | `create_support_ticket` | any | shipped |  |
| caregiver | Check background check status | components/caregiver/CaregiverOnboardingDashboard.tsx | caregivers | `get_background_check_status` | caregiver | shipped |  |
| caregiver | Upload an intro video to the caregiver profile (intended tool: update to update_caregiver_profile or a media pipeline route into caregivers.introVideoUrl) | components/caregiver/CaregiverIntroVideo.tsx | caregivers | -- | -- | blocker | Parity audit 2026-07-06: web-only write to caregivers.introVideoUrl — update_caregiver_profile excludes it and no SMS media pipeline routes a texted video there. Should-have (not launch-critical): needs a Storage upload path for SMS media first. |
| caregiver | List active shift swap requests and open peer offers | components/caregiver/CaregiverBookingsPage.tsx | shift_swap_requests | `list_shift_swaps` | caregiver | shipped | Read primitive over the collection request_shift_swap/accept_shift_swap write: the caller's own requests plus unexpired open offers from peers. |
| caregiver | Confirm cash payment received for an approved shift | components/caregiver/CaregiverPaymentsPage.tsx | shiftHours | `confirm_cash_received` | caregiver | shipped | Mirror of services/api.ts confirmCashReceived: caregiver-owned cash shift, approved/auto_approved -> paid (paidMethod:'cash'). Idempotent on retry (already-paid returns no-op success). |

## Family (Secondary Members)

| Actor | Action | Web surface | Collection | Evia tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| family | Read care updates for the senior | components/client/CareJournalFeed.tsx | care_journal | `get_care_journal_client` | any | shipped |  |
| family | Add another family member to the group | components/client/MyCareTeam.tsx | family_groups | `add_family_member` | any | shipped | AE3 — added member receives a Linq welcome and the action is logged. |

## Admin

| Actor | Action | Web surface | Collection | Evia tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| admin | Resolve a Checkr consider/exception in the verification queue | components/admin/CaregiverVerificationDashboard.tsx | caregivers | `admin_review_caregiver_exception` | admin | shipped | U3 — AE8/R8. Admin-gated callable. A manual approve sets verificationStatus but only flips status:'active' (bookable) when onboardingStatus profile_complete AND verificationStatus approved both hold; never fabricates a Checkr clear. |
| admin | Approve/reject an uploaded caregiver document | components/admin/CaregiverVerificationDashboard.tsx | caregivers | `admin_review_document` | admin | shipped | U3 — admin-gated callable; sets documents.{type}.status approved/rejected. |
| admin | Suspend a user (soft, audit-logged) | components/admin/AdminClientManager.tsx | users | `admin_suspend_user` | admin | shipped | U3 — admin-gated callable; soft accountStatus:'suspended' (never destructive delete), audit-logged. |
| admin | Restore a suspended user | components/admin/AdminClientManager.tsx | users | `admin_restore_user` | admin | shipped | U3 — counterpart callable; clears suspension (accountStatus:'active'). |
| admin | Respond to a support ticket so the user sees the reply | components/admin/TicketManager.tsx | support_tickets | `admin_respond_support_ticket` | admin | shipped | U3 — admin-gated callable; writes the user-visible responses subcollection + notifies via Linq/notifications. |
| admin | Resolve a shift-hour/payment dispute with audit log | components/admin/InvoicingTab.tsx | shiftHours | `admin_resolve_dispute` | admin | shipped | U3 — admin-gated callable; transitions shiftHours to terminal approved/rejected + correctionHistory + audit. |
| admin | Review an invoice exception (payment_failed, etc.) | components/admin/InvoicingTab.tsx | admin_alerts | `admin_review_invoice_exception` | admin | shipped | U3 — admin-gated callable; invoice exceptions surface as admin_alerts; records resolution + audit. |
| admin | Retry/replay a failed agent action from the ledger | components/admin/AdminCaraControlRoom.tsx | agent_action_ledger | `admin_retry_agent_action` | admin | shipped | U3/U4 — AE5. Admin-gated callable; re-dispatches the recorded tool, marks the ledger executed/failed (never false success), idempotency-keyed against double-retry. |
| admin | Re-attempt a failed Linq outbound delivery | components/admin/AdminCaraControlRoom.tsx | agent_action_ledger | `admin_retry_linq_delivery` | admin | shipped | U4 — AE5/R16. Admin-gated callable; reuses the production Linq send path, transitions the ledger failed→executed on success, raises admin_alerts on failure (no false success), idempotency-keyed. |
| admin | Replay a safe pending action via the MCP executor | components/admin/AdminCaraControlRoom.tsx | pending_actions | `admin_replay_pending_action` | admin | shipped | U4 — R6/R16. Admin-gated callable; re-runs the tool through handleToolCall. High-risk replays (isHighRisk) require confirm:true; idempotency-keyed against double-execute; fails visibly with admin_alerts. |
| admin | Cancel a stale pending action without executing it | components/admin/AdminCaraControlRoom.tsx | pending_actions | `admin_cancel_pending_action` | admin | shipped | U4 — R16. Admin-gated callable; transitions to terminal rejected/cancelled WITHOUT calling the underlying tool; reason required; idempotent on already-terminal docs. |
| admin | Assign a recovery owner on a ledger/alert doc | components/admin/AdminCaraControlRoom.tsx | agent_action_ledger | `admin_assign_recovery_owner` | admin | shipped | U4 — R16. Admin-gated callable; sets owner/assignee on agent_action_ledger or admin_alerts for operator accountability; no tool execution. |
| admin | Mark manual recovery complete on a ledger/alert doc | components/admin/AdminCaraControlRoom.tsx | agent_action_ledger | `admin_mark_recovery_complete` | admin | shipped | U4 — R16. Admin-gated callable; reason REQUIRED (invalid-argument otherwise); marks ledger handled/cancelled or resolves the alert; no tool execution. |

## Non-Goals

| Actor | Action | Web surface | Collection | Evia tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| client | Diagnose, prescribe, or give medical advice | n/a | n/a | -- | -- | non-goal | R7 — Evia avoids medical advice and routes emergencies to 911 guidance. |
| client | Collect raw card numbers / portal passwords in chat text | n/a | n/a | -- | -- | non-goal | Out of scope — payment changes go through Stripe-hosted links only. |
| admin | Make a caregiver bookable without completed onboarding + Checkr clear | n/a | caregivers | -- | -- | non-goal | R8 — bookability requires onboardingStatus profile_complete + verificationStatus approved. |
