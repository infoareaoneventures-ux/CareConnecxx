# Runbook: Real-World Healthcare Actions

Cara can act on a family's behalf on healthcare portals — book a doctor
appointment, request a pharmacy refill, check insurance coverage — through a
**propose → confirm → execute** trust layer. This runbook covers the pre-launch
gate, the flag, and recovery for the failure modes the design accepts as
manual-for-v1.

Owner: founder/eng on-call. Related: `docs/plans/2026-06-16-002-feat-cara-realworld-healthcare-handler-plan.md`, `docs/runbooks/caregiver-callout.md`.

---

## Read-only discovery vs. commit boundary (the core safety line)

There are two classes of healthcare action, and the boundary is enforced in
**code**, not prompt discipline:

| Class | Examples | Login? | Gated? | Commits anything? |
|---|---|---|---|---|
| **Read-only discovery** | provider search, pharmacy info, page fetch, `findAppointmentSlots` (PASS 1), `insurance_check` | search/fetch: no · slot-find/insurance: yes (read-only portal read) | **No** | **No** — never submits a form |
| **Commit action** | `bookAppointmentSlot` (PASS 2, carries the approved `chosenSlot`), `requestPharmacyRefill` | Yes | **Yes** | Yes — submits on a third-party portal |

The predicate that draws this line lives in `pendingActions.ts → isHighRisk` /
`CONDITIONAL_CONFIRM.perform_web_action`:

- `loginAction === "pharmacy_refill"` → **always gated**.
- `loginAction === "schedule_appointment"` → gated **only when `chosenSlot` is
  present** (the commit). The first call (no `chosenSlot`) is read-only slot
  discovery and stays ungated.
- `loginAction === "insurance_check"` → **never gated** (account-holder-scoped read).

A gated action is routed to the **account holder** (`resolvePrimaryPhone`,
fail-closed if unresolvable), approved by an explicit YES, then committed via
`approvalHandler → executeConfirmedAction` with `_confirmedActionId`. The commit
re-verifies the exact approved slot (`matchCount === 1`) before submitting and
reports `verified_success` only on a confirmation read-back — `unverified`,
`slot_unavailable`, `slot_ambiguous`, and `failed` never claim success.

Tests pinning this: `agents/healthcareActionGate.test.ts`,
`agents/healthcareScenarios.test.ts`, `browser/__tests__/appointmentTwoPass.test.ts`,
`agents/healthcareApproval.test.ts`, `agents/approvalHandler.test.ts`.

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
- [ ] **OQ6 — approver identity.** At least ONE concrete mitigation control
      against the SIM-swap / stolen-phone threat is **implemented and tested**
      before the flag is enabled — e.g. a time-delayed execution window with an
      SMS CANCEL code, out-of-band confirmation via a verified email, step-up
      authentication for healthcare actions, or per-phone-number rate limiting.
      Deciding "the risk is acceptable" is **not sufficient** to check this box.
      A stolen/SIM-swapped account-holder phone can currently approve actions;
      the rollout flag and account-holder scoping limit blast radius but are
      **NOT adequate mitigation** for this threat on their own — an additional
      control layer must be built and verified. **This is the highest-risk open
      item.**
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

## Medical emergencies (never a healthcare action)

A message that reads as a medical emergency is intercepted **before** any
healthcare flow by the crisis fast-path in `linq/webhooks.ts` (keyword scan
`safety/crisisDetector.ts` + LLM verify/multilingual classify). On a confirmed
medical crisis Cara:

1. Sends the 911 / ER guidance (`tr.crisis_medical`) and returns immediately —
   the QA tool loop and every healthcare flow are skipped (no booking, no refill).
2. Writes a HIPAA audit entry (`logCrisisDetected` → `agent_audit_log`).
3. Raises an **admin-visible safety alert** (`createCaraOpsAlert` →
   `admin_alerts`, type `cara_medical_emergency`, severity `critical`) so the
   Control Room sees it. PHI-minimized: only a 200-char text preview. Best-effort
   — a failed alert never delays the 911 message.
4. Arms a `NOTIFY` follow-up so the family can opt to page the care team.

Cara never diagnoses, prescribes, or advises on dosing (R7) — the new-prescription
flow collects condition + prescribing-doctor context and books/searches a provider;
it never invents clinical content. Pinned by `agents/goldenTranscripts.test.ts`,
`linq/__tests__/handleInbound.routing.test.ts`, `safety/crisisDetector.test.ts`.

## Audit

Every lifecycle transition (proposed / confirmed / executed / failed) is logged
to `agent_action_ledger` via `logAgentAction`, PHI-minimized (only action codes —
`loginAction`, portal key, pending-action id — never provider or medication
names). PHI-carrying detail lives only in `browser_sessions` (function/admin-only).
Check the admin AuditTrail for the full lifecycle when investigating.
