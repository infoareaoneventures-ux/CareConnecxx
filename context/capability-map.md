# Cara Launch Action-Parity Map

> **Hand-generated mirror of `functions/src/agents/launchActionParity.ts`.** That
> TypeScript file (`LAUNCH_ACTION_PARITY`) is the source of truth. This table is
> generated-in-spirit from it — update both together.
>
> Enforcement lives in two test files:
> - `functions/src/agents/toolCapabilities.test.ts` — the `LAUNCH_ACTION_PARITY`
>   block: shipped rows must point at a real `MCP_TOOLS` tool; blocker rows must
>   carry no tool; every collection must be `n/a` or a key in
>   `CONTRACT_COLLECTIONS`; ids must be unique; every shipped row's tool must be
>   exposed to its prompt actor (core or capability-tagged); every non-shipped
>   row must carry an explanatory note.
> - `tests/contractCollections.test.ts` — asserts this file exists and lists the
>   Client / Caregiver / Admin actor sections.

**Status legend**

- **shipped** — tool exists in `MCP_TOOLS` today and writes the web-read Firestore shape.
- 🚧 **blocker** — launch-critical parity gap. **U2** (caregiver) and **U3** (admin) ship these.
- ⛔ **non-goal** — explicitly out of scope per the plan's Scope Boundaries.

**Prompt actor** — which prompt/tool-filter surface exposes the tool: `client`,
`caregiver`, `admin`, or `any` (cross-cutting). `—` means no tool is exposed yet
(blocker / non-goal).

## Client

| Actor | Action | Web surface | Collection | Cara tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| client | Search/match caregivers and request replacements | components/client/FindCaregivers.tsx | caregivers | `find_replacement_caregivers` | client | shipped |  |
| client | Book a caregiver | components/BookingModal.tsx | appointments | `request_booking` | client | shipped |  |
| client | Reschedule an existing appointment | components/client/AppointmentsPage.tsx | appointments | `reschedule_appointment` | client | shipped |  |
| client | Cancel an appointment | components/client/AppointmentsPage.tsx | appointments | `cancel_appointment` | client | shipped |  |
| client | Update the senior's care plan | components/client/CarePlan.tsx | carePlans | `update_care_plan` | client | shipped |  |
| client | Add a member to the family group | components/client/CareTeam.tsx | family_groups | `add_family_member` | client | shipped |  |
| client | Remove a member from the family group | components/client/CareTeam.tsx | family_groups | `remove_family_member` | client | shipped |  |
| client | Read the care journal / visit updates | components/client/CareJournalFeed.tsx | care_journal | `get_care_journal_client` | any | shipped |  |
| client | Comment on / like a care journal entry | components/client/CareJournalFeed.tsx | care_journal | `comment_on_journal_entry` | any | shipped |  |
| client | Message a caregiver | components/shared/MessagingPanel.tsx | threads | `send_caregiver_message` | client | shipped |  |
| client | Open a support ticket | components/shared/SupportWidget.tsx | support_tickets | `create_support_ticket` | any | shipped |  |
| client | Get a Stripe payment-method update link | components/client/BillingPage.tsx | n/a | `get_payment_update_link` | any | shipped | Raw card details are never captured in chat; Cara only hands off a Stripe-hosted link. |
| client | View invoice history and details | components/client/BillingPage.tsx | n/a | `get_invoice_history` | client | shipped | Invoices live in Stripe + billing summaries, not a registered Firestore contract collection. |
| client | View pending timesheets awaiting approval | components/client/TimesheetsPage.tsx | shiftHours | `get_pending_timesheets` | client | shipped |  |
| client | Approve/reject submitted shift hours | components/client/TimesheetsPage.tsx | shiftHours | `review_shift_hours` | client | shipped |  |
| client | Request a refund | components/client/BillingPage.tsx | admin_alerts | `create_refund_request` | client | shipped |  |
| client | Create a care reminder | components/client/RemindersPage.tsx | n/a | `create_reminder` | client | shipped | Reminders are scheduled triggers, not a registered contract collection. |
| client | Submit a caregiver review | components/client/ReviewModal.tsx | caregivers | `submit_review` | client | shipped |  |

## Caregiver

| Actor | Action | Web surface | Collection | Cara tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| caregiver | Update caregiver profile (rate/skills/bio) | components/caregiver/CaregiverProfilePage.tsx | caregivers | `update_caregiver_profile` | caregiver | shipped |  |
| caregiver | Update availability | components/caregiver/CaregiverCalendar.tsx | caregivers | `update_caregiver_availability` | caregiver | shipped |  |
| caregiver | Browse the job board | components/caregiver/JobBoard.tsx | job_posts | `browse_job_board` | caregiver | shipped |  |
| caregiver | Apply to a job post | components/caregiver/JobBoard.tsx | job_posts | `apply_to_job` | caregiver | shipped |  |
| caregiver | Withdraw a job application | components/caregiver/JobBoard.tsx | job_posts | _withdraw_job_application_ | — | 🚧 blocker | U2 — caregiver cannot withdraw an application via Cara today. |
| caregiver | Respond to an interview request | components/caregiver/CaregiverBookingsPage.tsx | appointments | `respond_to_interview_request` | caregiver | shipped |  |
| caregiver | Accept/decline a booking request | components/caregiver/CaregiverBookingsPage.tsx | appointments | _respond_to_booking_request_ | — | 🚧 blocker | U2 — AE1. Caregiver YES/NO to a booking request has no general Cara tool yet (shift_offers covers offer flow only). |
| caregiver | Start a shift / clock in | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | _start_shift_ | — | 🚧 blocker | U2 — submit_gps_checkin exists but there is no explicit start_shift lifecycle tool. |
| caregiver | Complete a shift / clock out | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | _complete_shift_ | — | 🚧 blocker | U2 — AE7. Must be idempotent on SMS retry. |
| caregiver | Toggle a visit task complete | components/caregiver/CaregiverHomeDashboard.tsx | appointments | _update_shift_task_ | — | 🚧 blocker | U2 — visit task checklist has no Cara tool yet. |
| caregiver | Send a photo/media care update | components/caregiver/CaregiverHomeDashboard.tsx | care_journal | _submit_media_update_ | — | 🚧 blocker | U2 — create_care_journal_entry exists for text; dedicated media-update tool pending. |
| caregiver | Create a care journal entry | components/caregiver/CareJournalEditor.tsx | care_journal | `create_care_journal_entry` | caregiver | shipped |  |
| caregiver | Submit shift hours / timesheet | components/caregiver/CaregiverHomeDashboard.tsx | shiftHours | `submit_shift_hours` | caregiver | shipped |  |
| caregiver | Respond to a shift-hour correction | components/caregiver/CaregiverPaymentsPage.tsx | shiftHours | _respond_to_shift_hour_correction_ | — | 🚧 blocker | U2 — caregiver cannot answer a client/admin hour correction via Cara today. |
| caregiver | Request an instant payout | components/caregiver/InstantPayoutModal.tsx | n/a | `request_instant_payout` | caregiver | shipped | Payout state is Stripe Connect; no registered Firestore contract collection. |
| caregiver | Request a standard payout | components/caregiver/CaregiverPaymentsPage.tsx | n/a | _request_standard_payout_ | — | 🚧 blocker | U2 — must not bypass Stripe/eligibility checks. Payout state is Stripe Connect. |
| caregiver | View earnings | components/caregiver/CaregiverPaymentsPage.tsx | n/a | `get_caregiver_earnings` | caregiver | shipped | Earnings are derived from Stripe/shiftHours; no dedicated contract collection. |
| caregiver | View tax summary | components/caregiver/CaregiverPaymentsPage.tsx | n/a | `get_tax_summary` | caregiver | shipped |  |
| caregiver | Message a client | components/shared/MessagingPanel.tsx | threads | `send_client_message` | caregiver | shipped |  |
| caregiver | Open a support ticket | components/shared/SupportWidget.tsx | support_tickets | `create_support_ticket` | any | shipped |  |
| caregiver | Check background check status | components/caregiver/OnboardingChecklist.tsx | caregivers | `get_background_check_status` | caregiver | shipped |  |

## Family (secondary members)

| Actor | Action | Web surface | Collection | Cara tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| family | Read care updates for the senior | components/client/CareJournalFeed.tsx | care_journal | `get_care_journal_client` | any | shipped |  |
| family | Add another family member to the group | components/client/CareTeam.tsx | family_groups | `add_family_member` | any | shipped | AE3 — added member receives a Linq welcome and the action is logged. |

## Admin (exception handling)

All admin exception tools are 🚧 **blockers** — U3 ships them as auth-gated callables. Today the admin can *see* these states but cannot *act* through Cara.

| Actor | Action | Web surface | Collection | Cara tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| admin | Resolve a Checkr consider/exception in the verification queue | components/admin/CaregiverVerificationDashboard.tsx | caregivers | _admin_review_caregiver_exception_ | — | 🚧 blocker | U3 — AE8. Must NOT mark bookable unless policy allows; Checkr clear is the auto-approval source. |
| admin | Approve/reject an uploaded caregiver document | components/admin/CaregiverVerificationDashboard.tsx | caregivers | _admin_review_document_ | — | 🚧 blocker | U3 — document review has no Cara/admin callable yet. |
| admin | Suspend a user (soft, audit-logged) | components/admin/UserManagement.tsx | users | _admin_suspend_user_ | — | 🚧 blocker | U3 — suspension is note-only today. |
| admin | Restore a suspended user | components/admin/UserManagement.tsx | users | _admin_restore_user_ | — | 🚧 blocker | U3 — counterpart to admin_suspend_user. |
| admin | Respond to a support ticket so the user sees the reply | components/admin/TicketManager.tsx | support_tickets | _admin_respond_support_ticket_ | — | 🚧 blocker | U3 — admin can read tickets but not respond through Cara. |
| admin | Resolve a shift-hour/payment dispute with audit log | components/admin/InvoicingTab.tsx | shiftHours | _admin_resolve_dispute_ | — | 🚧 blocker | U3 — dispute lifecycle rides on shiftHours; no dedicated disputes contract collection. |
| admin | Review an invoice exception (payment_failed, etc.) | components/admin/InvoicingTab.tsx | admin_alerts | _admin_review_invoice_exception_ | — | 🚧 blocker | U3 — invoice exceptions surface as admin_alerts; no invoices contract collection registered. |
| admin | Retry/replay a failed agent action from the ledger | components/admin/AdminCaraControlRoom.tsx | agent_action_ledger | _admin_retry_agent_action_ | — | 🚧 blocker | U3/U4 — AE5. Control Room retry is currently note-only, not backend-executable. |

## Non-goals (out of scope)

| Actor | Action | Web surface | Collection | Cara tool/handler | Prompt actor | Status | Notes |
|---|---|---|---|---|---|---|---|
| client | Diagnose, prescribe, or give medical advice | n/a | n/a | — | — | ⛔ non-goal | R7 — Cara avoids medical advice and routes emergencies to 911 guidance. |
| client | Collect raw card numbers / portal passwords in chat text | n/a | n/a | — | — | ⛔ non-goal | Out of scope — payment changes go through Stripe-hosted links only. |
| admin | Make a caregiver bookable without completed onboarding + Checkr clear | n/a | caregivers | — | — | ⛔ non-goal | R8 — bookability requires onboardingStatus profile_complete + verificationStatus approved. |
