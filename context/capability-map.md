# Cara Capability Map

The source-of-truth inventory of **what users/handlers can do on the platform** and
**whether Cara's agent loop can do it too** (action parity). Maintained by hand;
enforced by `functions/src/mcp/__tests__/parity.test.ts`, which asserts every `✅`
tool actually exists in `MCP_TOOLS` (or the caregiver subset) and is named in the
relevant system-prompt builder in `functions/src/agents/qaAgent.ts`.

Status legend:
- ✅ **Done** — the agent has a tool for this and it's documented in the system prompt.
- ⚠️ **Missing** — a UI/handler action with no agent equivalent yet (allowed, but tracked).
- 🚫 **N/A** — intentionally not an agent action (e.g. PCI card entry, video call).

> This map replaces the stale "83-tool" figure in CLAUDE.md. The live tool count is
> whatever `MCP_TOOLS.length` reports; do not hardcode it.

---

## Caregiver side

| Action | Where (UI / handler) | Agent tool | Status |
|--------|----------------------|------------|--------|
| Update rate / bio / phone / city / availability | `CaregiverAccountSettings.tsx`, `caregiverProfileHandler` | `update_caregiver_profile` | ✅ |
| Pause account / vacation mode | `caregiverProfileHandler.handlePauseAccount` | `pause_account` | ✅ (U1) |
| Reactivate after pause | `caregiverProfileHandler.handleReactivate` | `reactivate_account` | ✅ (U1) |
| Accept a shift offer | offer reply (`handleShiftOfferReply`) | `accept_shift` | ✅ (U2) |
| Decline a shift offer | offer reply (`handleShiftOfferReply`) | `decline_shift` | ✅ (U2) |
| Set weekly availability | `AvailabilityCalendar.tsx`, `availabilityHandler` | `update_caregiver_availability` | ✅ |
| View upcoming shifts | `CaregiverCalendarPage.tsx` | `get_caregiver_appointments` | ✅ |
| GPS check-in to a shift | `ShiftCheckin.tsx` | `submit_gps_checkin` | ✅ |
| Submit shift hours | `ShiftAssistant.tsx` | `submit_shift_hours` | ✅ |
| Request instant payout | `InstantPayoutModal.tsx` | `request_instant_payout` | ✅ |
| View earnings / payout history / tax summary | `CaregiverPayoutPage.tsx` | `get_caregiver_earnings`, `get_payout_history`, `get_tax_summary` | ✅ |
| Apply to a job / browse jobs / view applications | `JobBoard.tsx`, `MyApplicationsList.tsx` | `apply_to_job`, `browse_job_board`, `get_my_applications`, `get_job_recommendations` | ✅ |
| Respond to an interview request | `CaregiverInterviewManager.tsx` | `respond_to_interview_request` | ✅ |
| Message a family / read messages | messaging UI | `send_client_message`, `get_recent_messages` | ✅ |
| Create a care-journal entry | `ShiftAssistant.tsx` | `create_care_journal_entry` | ✅ |
| Request / accept / cancel a shift swap | swap UI | `request_shift_swap`, `accept_shift_swap`, `cancel_shift_swap` | ✅ |
| Record a video intro | `CaregiverIntroVideo.tsx` | — | ⚠️ Missing (media capture; low agent demand) |
| Recognition / badges | `RecognitionCenter.tsx` | — | ⚠️ Missing (display-only) |

## Client / family side

| Action | Where (UI / handler) | Agent tool | Status |
|--------|----------------------|------------|--------|
| Find / match caregivers | `CaregiverSearch.tsx`, `matchingAgent` | `find_replacement_caregivers` | ✅ |
| Quote a booking's cost before committing | `BookingModal.tsx` (price preview) | `quote_booking`, `get_caregiver_booking_rate` | ✅ (U9b — read-only primitives extracted from `request_booking`) |
| Request a booking | `BookingModal.tsx` | `request_booking` | ✅ |
| View / cancel / reschedule appointments | `ClientVisitsPage.tsx` | `get_upcoming_appointments`, `cancel_appointment`, `reschedule_appointment` | ✅ |
| Manage recurring schedule | `modifyScheduleFlow` | `manage_recurring_schedule`, `modify_recurring_schedule`, `get_recurring_schedule` | ✅ |
| Approve / dispute timesheet hours | `Payments.tsx`, `timesheetHandler` | `review_shift_hours`, `get_pending_timesheets` | ✅ |
| Request a refund | `Payments.tsx`, `refundHandler` | `create_refund_request` | ✅ |
| View invoices / billing summary | `Payments.tsx` | `get_invoice_history`, `get_invoice_details`, `get_billing_summary` | ✅ |
| Update payment method (card) | `Payments.tsx` → Stripe portal | `get_payment_update_link` (link only) | 🚫 In-conversation card entry — PCI; link-only by design |
| Leave a review | `LeaveReviewModal.tsx` | `submit_review` | ✅ |
| View care journal / care plan | `CareJournalFeed.tsx`, `CarePlan.tsx` | `get_care_journal`, `get_care_journal_client`, `get_care_plan` | ✅ |
| Update care plan | `CarePlan.tsx` | `update_care_plan` | ✅ |
| Add / remove family member | `AccountSettings.tsx` | `add_family_member`, `remove_family_member` | ✅ |
| Update account profile (name/phone/address) | `AccountSettings.tsx` | `update_user_profile`, `update_senior_profile` | ✅ |
| Add another care recipient (senior) to the household | `FamilyManager.tsx` / multi-senior intake | `create_senior_profile` | ✅ (U6) |
| Schedule interview / submit feedback | `ScheduleInterviewModal.tsx` | `schedule_interview`, `submit_interview_feedback` | ✅ |
| Respond to a job application | `ClientDashboard.tsx` | `respond_to_job_application` | ✅ |
| Post / edit / cancel a job | `ClientJobPostingWizard.tsx`, `jobPostingFlow` | `create_job_post`, `list_client_jobs`, `edit_job_post`, `cancel_job_post` | ✅ (create U7) |
| Delete a review left for a caregiver | `Reviews` UI | `delete_review` | ✅ (U7) |
| Remove an incorrect care-journal entry (soft-delete) | care journal UI | `delete_care_journal_entry` | ✅ (U7) |
| View / follow-up / reopen own support tickets | `SupportModal.tsx` | `get_support_ticket`, `list_support_tickets`, `update_support_ticket` | ✅ (U7) |
| Log qualitative match feedback | match UI / `matchFeedback` | `log_match_feedback` | ✅ (U7) |
| See / cancel Cara's pending proactive messages | (agent-managed) | `list_proactive_drafts`, `cancel_proactive_draft` | ✅ (U7) |
| Manage reminders / follow-ups | reminder UI | `list_user_reminders`, `create_reminder`, `delete_reminder`, `schedule_followup`, `cancel_followup` | ✅ |
| Cancel / reactivate subscription | `Subscription.tsx` | `cancel_subscription`, `reactivate_subscription` | ✅ |
| Block / report / unblock a user | safety UI | `block_user`, `report_user`, `unblock_user` | ✅ |
| Twilio Video interview (live call) | `VideoInterviewRoom.tsx` | — | 🚫 Live video is a UI-only surface |

## Real-world (healthcare handler — flag-gated)

| Action | Where | Agent tool | Status |
|--------|-------|------------|--------|
| Public web lookup (search / fetch / browse, no login) | `careWebActions` | `search_healthcare_provider`, `fetch_web_page`, `browse_web` | ✅ (U9 — decomposed from perform_web_action) |
| Book appointment / refill Rx / check insurance | `healthcareHandler`, `careWebActions` | `perform_web_action` (login-only; propose→confirm→execute) | ✅ behind `FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS` (on locally, not shipped) |

---

## Maintenance

When you add a UI/handler action or an MCP tool, add or update its row here in the
same PR. The parity test fails if a `✅` row's tool is missing from the code or not
documented in the system prompt. `⚠️`/`🚫` rows are informational and never fail the build.
