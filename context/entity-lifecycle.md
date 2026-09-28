# Entity Lifecycle Policy (U10)

Derived from the real code: `functions/src/data/contract.ts`, `firestore.rules`,
`functions/src/agents/launchActionParity.ts`, `services/api.ts`, and the MCP
tools in `functions/src/mcp/server.ts`.

The governing rule: **audit-sensitive, payment, and health entities are never
destructively deletable by clients/caregivers.** They terminate via a soft
flag, a terminal status, or an admin-only (audited) hard delete. Soft-deleted or
terminal records drop out of user-active views but stay admin/audit-visible.

## Legend

- **Surface** — who performs the operation: Client / Caregiver / Admin / Evia
  (SMS) / Server (Cloud Functions, Admin SDK) / Stripe (webhook).
- **Terminal / delete** — how the entity ends its life. "soft" = flag or status;
  "admin hard-delete" = `allow delete: if isAdmin()` (audited); "no delete" =
  `allow delete: if false` (server/terminal only).

## Core entities

| Entity | Create | Read | Update | Terminal / Delete | Notes |
|---|---|---|---|---|---|
| `caregivers` | Caregiver (self, signup) / Evia onboarding finalize | Any authed (profile) + Admin | Caregiver (self, non-protected fields) / Admin / Server (Stripe/Checkr) | **Soft**: `status:'suspended'`/`inactive`, `verificationStatus`. Admin hard-delete only. | Protected. `admin_suspend_user` / `admin_review_caregiver_exception`. |
| `clientIntakes` | Client (own uid) / Evia onboarding | Owner + Admin | Owner / Admin | Admin hard-delete only | Matching triggers listen on create/update. |
| `senior_profiles` | Client (own uid) / Evia | Owner + Admin | Owner + Admin | (no explicit delete rule → owner/admin write governs) | Web senior store. `seniors` is a separate Evia/QA context store. |
| `carePlans` | Owner / Evia at payment | Owner + Admin | Owner + Admin | Admin hard-delete only | Versioned care plan also mirrored under `senior_profiles/{uid}/care_plans`. |
| `job_posts` | Client (own) | Public (open jobs) | Client (own) / Admin | **Terminal status** via `cancel_job_post` (Evia) / client update; client/admin delete allowed | Job board. |
| `job_postings` | Client (own uid) | Any authed | Client (own) | Admin delete only | Per-client wizard mirror of `job_posts`. |
| `appointments` | Any authed (booking) / Evia | Participants + Admin | Participants + Admin | **Terminal status** `cancelled`/`completed` via `cancel_appointment` / `reschedule_appointment`; admin hard-delete only | Protected from client delete. |
| `booking_requests` | Client (own) | Participants + Admin | Participants + Admin | Terminal status (accept/decline) | Evia's scripted booking flow writes this same doc (the former `agent_tasks` / `shift_offers` pipeline was removed 2026-09-17 / 2026-09-28). |
| `shiftHours` | Caregiver (self, `pending_client_review`) | Participants + Admin | Admin / Caregiver (cash-confirm only) | **Terminal status** approved/auto_approved/disputed/paid; admin hard-delete only | Protected. Payroll. `review_shift_hours`, `admin_resolve_dispute`. |
| `threads` | Participants | Participants | Participants | Admin hard-delete only | Evia conversations mirror into `threads` (`cara_{uid}`). |
| `admin_alerts` | Server only | Admin | Admin (mark resolved) | **Soft**: resolved flag; create/delete denied | Server-written escalations. |
| `care_journal` | Server (Evia/caregiver tools) | Participants + Admin | Server only | **No delete** (`allow delete: if false`) | Protected (health). Append-only visit journal. |
| `referrals` | Referrer / Admin / Server | Participants + Admin | Referrer / referred-claim / Admin | **No delete** (`allow delete: if false`) | Ownership fields immutable. |
| `agent_action_ledger` | Server only | Admin | Admin (restricted fields + status enum) | **No delete** (`create, delete: if false`) | Protected (audit). |
| `agent_audit_log` | Server only | Admin | — | **No delete** (`allow write: if false`) | Protected (audit). Append-only. |
| `pending_actions` | Server only | Admin | Admin (restricted fields + status enum) | **Terminal status** rejected/cancelled/executed/expired; create/delete denied | `admin_cancel_pending_action`, `admin_replay_pending_action`. |
| `invoices` | Server only | Admin + owning client/caregiver | Server only | **Admin hard-delete only** (audited via `onInvoiceDeleted`); create/update denied | Protected (payment). |
| `payments` | Stripe webhook | Owner | — | **No delete** (`allow delete: if false`); write denied | Protected (payment). Subscription ledger. |
| `payouts` | Server (instant/standard) | Caregiver (own) + Admin | — | **No delete** (`allow delete: if false`); write denied | Protected (payment). Top-level admin mirror + `caregivers/{uid}/payouts`. |
| `disputes` | Server only | Participants + Admin | Server only | **No delete** (`allow delete: if false`); create/update denied | Protected (audit/payment). SLA escalation. |

## Supporting / shared entities backfilled in U10

| Entity | Create | Read | Update | Terminal / Delete | Notes |
|---|---|---|---|---|---|
| `chatRooms` | Participants | Participants + Admin | Participants + Admin | Admin hard-delete only | 1:1 messaging. |
| `customers` (+`subscriptions`) | Stripe webhook | Owner | — | (write denied) | Stripe customer + subscription subcollection. |
| `hire_requests` | Client/Caregiver/Server | Participants + Admin | Client/Admin | Admin delete only | Post-interview hire. |
| `interviews` | Server only | Participants + Admin | Server only | Admin delete only; create/update denied | Scheduled interview record with Google Meet link + ICS. |
| `video_interviews` | Client/Server | Participants + Admin | Participants + Admin | Admin delete only | Google Meet link interview coordinated by Evia. |
| `job_applications` | Caregiver (own) | Participants + Admin | Client (status) / Caregiver (`withdrawn`) / Admin | **Terminal status** `withdrawn`/`accepted`/`rejected`; admin hard-delete | `withdraw_job_application` (Evia). |
| `reviews` | Client (own) | Public | Author | Admin delete only | Post-visit reviews. |
| `reports` | User (own) | Reporter + Admin | Admin | Admin delete only | Abuse/safety reports — not user-deletable. |
| `shifts` | Caregiver / Client (pending) / Server | Participants + Admin | Participants (status-scoped) / Admin | Admin delete only | GPS clock-in/out instances. |
| `notifications` (top-level) | User (own) / Admin / Server | Owner + Admin | Owner (mark read) | Admin delete only | Distinct from `users/{uid}/notifications`. |
| `web_onboarding_sessions` | Server (callable) | Owner (own doc) | — | (write denied) | Web phone↔SMS bridge, phone-keyed. |
| `seniors` | Server (Evia/QA context) | Server only | Server only | Server only | Evia seniorId-keyed context; NOT the web `senior_profiles` store. |

## Delete-protection invariant (enforced)

`tests/entityLifecycle.test.ts` statically scans `firestore.rules` and fails if
any of the protected entities grants a client-destructive delete. Protected set:
`caregivers`, `appointments`, `shiftHours`, `invoices`, `payments`, `payouts`,
`care_journal`, `agent_action_ledger`, `agent_audit_log`, `disputes`,
`allow delete: if isAdmin()` (audited hard-delete) — never a broader client
condition.
