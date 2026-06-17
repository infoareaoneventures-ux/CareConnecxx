# Runbook: Real-World Healthcare Actions

Cara can act on a family's behalf on healthcare portals — book a doctor
appointment, request a pharmacy refill, check insurance coverage — through a
**propose → confirm → execute** trust layer. This runbook covers the pre-launch
gate, the flag, and recovery for the failure modes the design accepts as
manual-for-v1.

Owner: founder/eng on-call. Related: `docs/plans/2026-06-16-002-feat-cara-realworld-healthcare-handler-plan.md`, `docs/runbooks/caregiver-callout.md`.

---

## Feature flag

The whole capability is **OFF by default**, gated by:

```
FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS=true
```

(`functions/src/config/featureFlags.ts` → `realWorldHealthcareActionsEnabled()`.)

Flag-off behavior: any `perform_web_action` portal call (loginAction
schedule_appointment / pharmacy_refill / insurance_check) and the conversational
healthcare flow return a "coming soon" message and **propose/commit nothing**.

**Do not flip the flag until every box below is checked.**

---

## Pre-launch gate (must all be true before `=true`)

- [ ] **Compliance sign-off (OQ1).** HIPAA coverage confirmed via the GCP BAA; the
      revocable credential-consent scope reviewed by whoever owns compliance.
- [ ] **OQ6 — approver identity.** Decide whether phone-as-sole-identity is
      acceptable for committing healthcare actions, or whether v1 requires a
      second factor / a CANCEL window / an out-of-band execution notice. A
      stolen/SIM-swapped account-holder phone can currently approve actions —
      the rollout flag and account-holder scoping limit blast radius but do NOT
      close this. **This is the highest-risk open item.**
- [ ] **Supported portals (OQ4).** Confirm the launch portal list and that
      `loginWithFieldFill` selectors + the Stagehand discovery/commit prompts
      work against each (MyChart, CVS, Walgreens, RiteAid, generic insurer URL).
      Per-portal selector tuning is expected — these were not live-verified at
      implementation time.
- [ ] **Cost guardrails (OQ5).** Per-action Browserbase budget set; the two-pass
      booking premium (~2 sessions/booking) is acceptable.
- [ ] **Credential-recording scrub.** Confirm Browserbase session-recording
      redaction is configured for credential input fields (H-U10 keeps the
      password out of LLM prompts; recording scrub is the second layer).

---

## Recovery procedures

### Stuck `executing` action (crash between claim and settle)

The exactly-once design (H-U5) claims `awaiting → executing` before dispatch and
settles after. A crash in between leaves a doc in `executing` that routing won't
re-surface. **v1 has no automated reconciliation** (accepted risk).

1. Query `pending_actions` for `status == "executing"` with an old
   `executingStartedAt`.
2. Use the portal verification read-back (the same `extract` the commit uses) to
   check whether the action actually committed (confirmation #, refill accepted).
3. If it committed → settle the doc `executed` and tell the account holder.
4. If it did NOT commit → settle `failed`; tell the account holder "I started
   this but couldn't confirm it went through — reply REFRESH" and re-propose.
   **Never blindly re-dispatch** — that risks a double booking/refill.

### Slot gone / ambiguous at commit (`slot_unavailable` / `slot_ambiguous`)

`bookAppointmentSlot` extract-verifies exactly one match before submitting; on 0
or >1 it returns without submitting and Cara offers to re-find. No action needed
beyond confirming the family was offered a re-find. Expect a real rate of
"that slot was taken" — this is correct, not a bug.

### Login failure / portal layout drift

Surfaces as `failed` with "reply 'update my <portal> login'". If it recurs
across users for one portal, the portal layout likely changed — update the
`loginWithFieldFill` selectors / Stagehand prompts for that portal and re-test.

### Session hang

`withSessionTimeout` force-closes the Browserbase session at 90s and returns a
failure (surfaced, never a silent success). A timed-out session may leave
Browserbase in an indeterminate billed state — known gap; monitor session costs.

### Refund / wrong action committed

If a wrong appointment/refill committed (e.g. portal mis-parse): cancel it on the
portal manually, tell the family, and file the incident. There is no automated
undo — the verification read-back + the confirmation gate are the prevention.

---

## Audit

Every lifecycle transition (proposed / confirmed / executed / failed) is logged
to `agent_action_ledger` via `logAgentAction`, PHI-minimized (only action codes —
`loginAction`, portal key, pending-action id — never provider or medication
names). PHI-carrying detail lives only in `browser_sessions` (function/admin-only).
Check the admin AuditTrail for the full lifecycle when investigating.
