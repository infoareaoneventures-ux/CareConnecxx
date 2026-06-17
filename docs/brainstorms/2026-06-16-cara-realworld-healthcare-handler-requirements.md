# Cara as the Family's Trusted Real-World Healthcare Handler — Requirements

**Created:** 2026-06-16
**Status:** Ready for planning
**Scope tier:** Deep — feature (extends existing product shape and infrastructure)

---

## Summary

Cara already has coded, autonomous browser actions that can act on real external healthcare sites on a family's behalf — book a doctor appointment, refill a prescription, check insurance authorization — using stored portal credentials (`functions/src/browser/careWebActions.ts`). This brainstorm converts that latent, **autonomous** capability into a **trustworthy, family-confirmed** one: Cara proposes the exact real-world action over SMS and only executes after the account holder approves. The product thesis is *Cara as the family's trusted real-world handler* — deepening the family relationship and the subscription's value without touching the vetted-caregiver moat.

---

## Problem Frame

Adult children managing an aging parent's care spend enormous effort on logistics that aren't medical decisions but are tedious, repetitive, and easy to drop: booking the follow-up, getting the refill in before it runs out, confirming a procedure is covered. CareConnex has invested in browser-automation infrastructure (Browserbase/Stagehand) plus an encrypted credential vault that already lets Cara perform these tasks — but two problems block it from being a trustworthy product:

1. **The actions commit autonomously.** `scheduleDoctorAppointment` logs in, picks a slot "closest to preferred date or as soon as possible," and submits — with no family approval of the specific date/time. For senior healthcare, a silently-committed appointment or refill is a liability and a trust breaker (wrong time, missed-appointment fees, an action the family never sanctioned).
2. **It's unclear the capability is exposed or governed.** There's no confirmation gate, no defined approver, and no defined failure behavior in front of these actions today.

The fix is not new capability — it's a **trust layer** over capability that already exists.

---

## Actors

- **A1 — Account holder / primary family member** (the paying adult-child, or whoever holds the CareConnex account). **The approver:** Cara routes every real-world action to this person for SMS confirmation before executing. *(Chosen this brainstorm.)*
- **A2 — Senior** the care recipient. Beneficiary of the action; not the approver in v1 (see Outstanding Questions for per-account flexibility).
- **A3 — Cara** the agent that proposes, executes (post-approval), and reports outcomes.
- **A4 — External portal** (MyChart/health system, CVS/Walgreens/Rite Aid pharmacy, insurer portal) — the real-world system Cara drives.

---

## Requirements

- **R1 — No autonomous commits.** Cara must never commit a real-world healthcare action (book, refill, submit) without explicit prior approval from the account holder (A1). Read-only lookups (e.g., checking insurance authorization status, listing available slots) may run without approval.
- **R2 — Propose with exact specifics.** The confirmation message must state the precise committed action: provider name, date/time, location for appointments; medication/Rx number and pharmacy for refills. The family approves *that specific thing*, not a vague intent.
- **R3 — Reuse the existing confirmation gate.** Route real-world actions through the rebuild's pending-action mechanism (`proposePendingAction` / `buildPendingActionStub` / approval handler) rather than inventing a parallel approval path.
- **R4 — Single approver = account holder.** The primary family member confirms. A confused or targeted senior cannot self-approve a committing action in v1.
- **R5 — Explicit, revocable credential consent.** Storing portal logins requires explicit family opt-in with clear scope ("Cara can use your MyChart login to book and view appointments"). Credentials stay in the existing encrypted vault and can be revoked.
- **R6 — Clear failure surfacing, never silent.** When a portal action fails or is ambiguous (portal changed, slot unavailable, multiple matching doctors/medications), Cara reports it plainly to the family and asks how to proceed — never silently fails and never silently picks for ambiguous matches.
- **R7 — No double-execution.** A confirmed action executes exactly once even if the confirmation or a retry is delivered twice (idempotency on the action, consistent with the webhook-ledger thinking elsewhere in the system).
- **R8 — Auditability.** Every proposed, approved, executed, and failed action is logged (extend existing `logBrowserSession`) so the family and admins can see what Cara did and when.
- **R9 — Three actions in v1.** Appointment booking, pharmacy refill, and insurance-authorization check are all in scope, each behind the same gate.

---

## Key Flows

- **F1 — Confirmed appointment booking.** Family/senior asks Cara to book a follow-up → Cara looks up availability (read-only) → Cara proposes "Dr. Lee, Tue Jun 23 at 2:30pm, Northside Clinic — book it?" → A1 replies YES → Cara executes via portal → Cara reports the confirmation number, or surfaces failure per R6.
- **F2 — Confirmed pharmacy refill.** Refill-due signal or family request → Cara proposes "Refill metformin (Rx #4471) at CVS Main St — confirm?" → A1 approves → Cara submits → reports pickup readiness or failure.
- **F3 — Insurance authorization check (read-only).** Family asks "is the MRI covered?" → Cara checks the insurer portal and reports status with no approval step (R1 read-only exception).
- **F4 — Credential onboarding.** First time an action needs a portal, Cara runs the consent + credential-collection flow (`startCredentialCollection`) before proposing any action.

---

## Acceptance Examples

- **AE1.** Family asks Cara to book a cardiology follow-up. Cara proposes a specific slot and waits. No reply / "no" → nothing is booked. *(Enforces R1, R2.)*
- **AE2.** Account holder replies YES to a proposed refill. The refill is submitted exactly once even though Cara receives a duplicate inbound. *(Enforces R7.)*
- **AE3.** The senior (A2), not the account holder, replies YES to a proposed appointment. Cara does **not** execute and routes the confirmation to the account holder. *(Enforces R4.)*
- **AE4.** The MyChart portal layout has changed and login fails. Cara tells the family it couldn't complete the booking and offers to refresh the login — it does not report success. *(Enforces R6.)*
- **AE5.** Family asks if a procedure is covered. Cara returns the authorization status without asking for approval. *(Enforces R1 read-only exception.)*

---

## Success Criteria

- Zero real-world actions committed without a logged prior approval from A1.
- Every committing action has a matching confirmation round-trip and an audit record.
- Ambiguous/failed portal actions result in a family-facing message 100% of the time (no silent failure).
- A family can complete an end-to-end confirmed booking or refill over SMS without leaving the conversation.

---

## Scope Boundaries

### In scope
Appointment booking, pharmacy refill, and insurance-authorization check — all governed by the propose→confirm→execute gate, single approver (account holder), consent-based revocable credentials, failure surfacing, idempotency, and audit logging.

### Deferred for later (follow-on work)
- **Scam-checker capability** — "forward it to Cara, is this a scam?" plus family alerting. The strong second face of *Cara as trusted real-world handler*; parked deliberately this round. Rides on existing SMS/media/vision infra; revisit as the next wedge.
- **Per-account approver configuration** — letting the family choose senior / adult-child / both-must-approve (R4 fixes the v1 default to account holder).
- **Proactive healthcare logistics** — Cara initiating refills/appointments from due-date signals rather than only on request.

### Outside this product's identity
- **Live phone-call blocking or screening** — carrier-level; not Cara's surface.
- **Bank-account / transaction monitoring** — requires Plaid-class integration and assumes liability CareConnex should not take on.
- **Off-platform *caregiver* sourcing/matching** — explicitly decided against in the prior brainstorm (dilutes the vetted-caregiver moat). This product is about Cara acting in the world *for* the family, not about importing un-vetted supply.

---

## Dependencies & Assumptions

- **Assumes** the existing pending-action confirmation gate can carry an arbitrary real-world-action payload (provider/date/Rx) and resume execution on approval. *(Verify at planning — `functions/src/agents/pendingActions.ts` and the MCP high-risk gate in `functions/src/mcp/server.ts`.)*
- **Assumes** Browserbase/Stagehand portal automation is reliable enough for production family-facing use; current code has a credential-refresh fallback but no defined retry/verification policy. *(Open question.)*
- **Depends on** the encrypted credential vault (`credentialVault.ts`) and credential-collection flow (`credentialCollector.ts`), both present.
- **Assumes** the family-group model can identify "the account holder / primary family member" for approval routing. *(Verify the primary/secondary member distinction at planning.)*

---

## Outstanding Questions

- **OQ1 (regulatory/liability).** Does Cara booking/refilling on a family's behalf, holding portal credentials, and touching health data raise HIPAA / state-specific consent obligations beyond the existing consent flow? Needs a compliance check before launch.
- **OQ2 (per-account approver).** Should families be able to designate the senior, the adult-child, or both as approver? Deferred; v1 is account-holder-only (R4).
- **OQ3 (portal reliability).** What's the acceptable success rate and the verification step that proves an action truly committed (e.g., re-reading the confirmation) before Cara reports success?
- **OQ4 (action coverage).** Which portals/providers are realistically supported at launch (MyChart + the three pharmacies are coded; insurer coverage varies)? Scope the launch portal list at planning.
- **OQ5 (cost).** Browserbase sessions per action have a real cost; what volume assumptions and guardrails are needed?
