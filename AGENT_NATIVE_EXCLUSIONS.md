# Agent-Native Exclusions

Single source of truth for items that are **intentionally N/A** in the agent-native
audit — deliberate design, not gaps. The `/ce-agent-native-audit` re-run (U15) drops
these from each principle's denominator via a reviewable manual re-baseline (Open Q1
resolved: the audit skill is external and not exclusion-aware, so this doc is the
authority and removals are traced to the rows below).

Entries are named precisely enough (exact tool/collection/action names) to match the
audit sub-agents' gap-list vocabulary. Vague entries break the match — keep them concrete.

Origin: `docs/plans/2026-06-24-001-feat-cara-100-agent-native-plan.md` (Track A).

---

## Action Parity / CRUD — auth & admin actions

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| Password change | Action Parity, CRUD | Auth-critical; never exposed to an SMS agent (account-takeover risk). |
| Account deletion | Action Parity, CRUD | Irreversible auth action; web + re-auth only. |
| Ban user | Action Parity | Admin moderation action; not an end-user agent capability. |
| Suspend user | Action Parity | Admin moderation action; not an end-user agent capability. |

## CRUD — immutable compliance records

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| Invoices (create/update/delete by agent) | CRUD | Financial records; create-only by the billing pipeline, immutable after. |
| Shift-hours / timesheets hard-delete | CRUD | Payroll/audit integrity; status transitions only, never deletion. |
| Audit logs (`agent_audit_log`, `agent_action_ledger`) mutate/delete | CRUD, Shared Workspace | Observability integrity; append-only, admin-read-only. |
| `care_journal` hard-delete | CRUD | Append-only care audit (firestore.rules: "never client-deletable"). Agent uses **soft-delete** (`delete_care_journal_entry` sets `status: hidden`) — the record is retained (U7). |
| Chat message edit/delete (`agent_conversations/{phone}/messages`, `threads/{threadId}/messages`) | CRUD | Chat immutability by design: the conversation IS the audit trail of what Evia and the user actually said (safety incidents, confirmations, disputes). No `edit_message`/`delete_message` tool ships; corrections are made by sending a new message, and memory corrections go through `edit_memory_file`/`delete_memory_file` instead (2026-07-03). |
| Care plan delete (`carePlans`, `senior_profiles/{uid}/care_plans`) | CRUD | Care-record retention: a care plan is clinical-adjacent history, never deleted. The full lifecycle is covered without deletion — `update_care_plan` (versioned), `get_care_plan_history`, and `restore_care_plan_version` (rollback). No `delete_care_plan` tool by design (2026-07-03). |
| `senior_profiles` hard-delete | CRUD | Care-record retention: when care ends the profile is **archived, not deleted** — `archive_senior_profile` sets `status:'archived'` and the record (diagnoses, care history back-references) is retained for compliance/continuity. No hard-delete tool ships for any actor (2026-07-03). |

## Action Parity — delivery channels by design

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| Referrals have no in-app surface (`referrals`, `send_referral` / `get_referral_status` / `create_caregiver_referral`) | Action Parity | Referral invites are delivered over SMS/email **by design** — the invitee is by definition not yet a user, so an in-app surface for them cannot exist. The sender's side IS agent-native (send + status tools); only the invite delivery channel is external. Not a parity gap (2026-07-03). |

## Shared Workspace — internal infrastructure (never user-visible)

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| `credential_vault` | Shared Workspace | Stored third-party portal credentials; server-only. |
| `browser_sessions` | Shared Workspace | Headless automation state; internal. |
| `agent_turn_checkpoints` | Shared Workspace | Mid-turn resume state; internal. |
| `processed_stripe_events`, `processed_checkr_events` | Shared Workspace | Webhook idempotency ledgers; server-only. |
| `dnd_queue` | Shared Workspace | SMS send-timing queue; server-only. |
| `linq_outbound_queue` | Shared Workspace | Durable retry queue for outbound sends blocked by the Linq circuit breaker / rate limiter; server-only (drained by `drainLinqOutboundQueue`). |
| `user_triggers`, `proactive_triggers`, `execution_agents` | Shared Workspace | Agent scheduling/lifecycle; server-only. |
| `agent_audit_log` / `agent_action_ledger` (admin-read-only) | Shared Workspace | Users see the filtered `user_activity_feed` projection, not raw logs. |

## Prompt-Native — CLAUDE.md-sanctioned deterministic paths

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| Crisis keyword fast-path (`crisisDetector`) | Prompt-Native | Life-safety latency; the LLM is a second gate, not the only one. |
| STOP / UNSUBSCRIBE / QUIT | Prompt-Native | SMS carrier opt-out protocol requirement. |
| Strict YES/NO when the system said "reply YES or NO" | Prompt-Native | Binary SMS protocol; deterministic by design. |
| Email-format regex (validation only) | Prompt-Native | Format validation, not intent parsing. |
| OTP generation / rate-limit constants | Prompt-Native | Security primitive; deterministic. |
| `isTrivialQuickReply` heuristic | Prompt-Native | Fast-path routing heuristic, not intent parsing. |
| `detectFrustrationSignals` heuristics (`frustrationSignals.ts`) | Prompt-Native | Telemetry-only quality classifier (sets `cara_turn_metrics` flags, never gates or shapes a reply). Regex/keyword by design: runs on every turn, an LLM call per turn for metrics would add latency/cost with no user-facing gain. Known trade-off: false positives on benign uses of "stop/wrong/human" inflate the admin severe queue — tune the pattern, don't LLM-ify it (2026-07-01). |

## Tools as Primitives — justified bundling / existing primitives (U8)

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| No generic `send_notification` tool | Tools as Primitives | The notification primitive already exists as `send_client_message` / `send_caregiver_message`, which enforce caregiver↔client engagement auth (IDOR prevention, `server.ts:3731+`). A generic `send_notification(phone, message)` exposed to the LLM would bypass that auth → spam/IDOR hole. **Rejected by design.** |
| `trySend` bundled in `cancel_appointment`, `schedule_interview`, `submit_gps_checkin`, `respond_to_job_application`, `send_caregiver_message` | Tools as Primitives | Each notifies the *already-authorized counterparty for that specific action*. This is intentional safe convenience (auto-notify-on-action), not a workflow-tool anti-pattern to decompose. |
| `manage_recurring_schedule` (action: pause/resume/cancel) left as one tool | Tools as Primitives | U15 punch-list. This is an **action-discriminated primitive**, not a workflow bundle — the same shape as `review_shift_hours(action)` / `respond_to_job_application(decision)`: one entity (a recurring schedule), one mutation surface, switched by an `action` enum. The finer `modify_recurring_schedule` / `get_recurring_schedule` cover the edit/read; splitting pause/resume/cancel into three near-identical tools adds surface with no composability gain. Intentional. |
| `find_replacement_caregivers` left composed (not split into read/filter/match sub-primitives) | Tools as Primitives | U9b. The tool is read-only (no irreversible effect) and **already parameterized** — the model shapes the search via `needs`/`nearZip`/`availabilityWindow`/`radiusMiles`. The body it wraps (`runMatchingForClient`: profile read → scoring → ranked async results) is tuned as a unit; exposing its internals as separate primitives would add round-trips and Sonnet-loop surface with no safety or capability gain. Sanctioned "leave composed" resolution per plan U9b line 286. The booking half of U9b WAS decomposed (`get_caregiver_booking_rate` + `quote_booking` extracted; `request_booking` commits via the same shared quote helper). |

## Real-world healthcare (flag-gated)

| Item | Principle(s) | Rationale |
|------|--------------|-----------|
| `perform_web_action` login actions (book appointment / Rx refill / insurance check) | Tools as Primitives, Action Parity | Gated behind `FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS` (dark in prod). Decomposition (U9) ships behind the same flag; real-model eval is required before the flag flips. |

---

## Privacy decision records

### PHI-in-prompt (U4, decided 2026-06-24)
The **full** client care plan (including diagnoses, medications, and doctor contacts)
is pre-injected into every client turn's Evia system prompt (`buildClientCoreContext`
in `functions/src/agents/qaAgent.ts`). This is a product decision trading higher PHI
exposure in LLM payloads/provider logs for richer default context and fewer tool
round-trips. **Mitigations:** care-team **phone numbers** are NOT pre-injected (kept
lazy via `get_care_team`); injection is confirmed-identity-only; the prompt hedges
when memory (Zep) is unavailable. Revisit if provider-side logging or the compliance
posture changes.

**Disclosure addendum (decided 2026-07-02, founder — explicit risk acceptance):**
the proactive conversational automation disclosure ("I'm automated…") was REMOVED
from Evia's first-contact messages by founder decision, against the standing
recommendation (CA B.O.T. Act exposure in a paid signup flow — validated review
finding, 2026-07-01). Remaining disclosure surfaces: (a) the web signup subtitle
"Evia is an automated coordinator backed by our care team" (`OnboardingFlow.tsx`),
and (b) the honest-answer-if-asked prompt rules in all three persona prompts —
Evia never denies being an AI when asked directly. Counsel must review this
posture before or shortly after launch; if counsel requires conversational
disclosure, restore the sentence in `webhooks.ts` coldIntro and `language.ts`
`otp_greeting` (git history 2026-07-02 has both wordings).

**Provider addendum (decided 2026-07-01, founder):** the agent tier runs on **OpenAI**
(`CARA_AGENT_PROVIDER=openai`, `CARA_AGENT_MODEL=gpt-5.4`) with Anthropic Sonnet as
runtime fallback — so the PHI-bearing prompt flows to OpenAI by default and to
Anthropic on fallback turns. Accepted for launch with no BAA yet in place on either
provider; a BAA request to **baa@openai.com** is being initiated (their API BAA
covers only Zero-Data-Retention-eligible endpoints — once signed, the API calls must
be reconfigured for ZDR). Rollback stays one env line (`CARA_AGENT_PROVIDER=anthropic`
+ redeploy of `v1-linqWebhook`). Revisit this record when the BAA is signed or the
provider changes again.
