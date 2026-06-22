# Caregiver MVR Opt-In & Add-Later — Requirements

**Date:** 2026-06-22
**Status:** Ready for planning
**Scope:** Standard (feature)

## Problem

MVR (Motor Vehicle Report / driver background check) exists today but isn't a real choice. In `components/caregiver/CaregiverMembership.tsx` it is auto-bundled whenever a caregiver lists "Transportation" as a service (`includeMVR = hasTransportation`), and the "checkbox" has no click handler — it's display-only. A caregiver can't opt in if they didn't list Transportation, and can't opt out if they did. There is also no way to add MVR after signup.

We want MVR to be a genuine, optional **Approved Driver** upgrade: pickable by any caregiver at signup, and addable later for a separate charge that runs a standalone MVR-only check — without ever putting their existing approval at risk.

## Goals

- Any caregiver can opt into MVR at signup as an optional add-on (real toggle, not auto-bundled, not display-only).
- An already-onboarded caregiver can add MVR later, self-serve (dashboard) or via Cara (SMS), which triggers a Stripe payment and a standalone MVR-only background check.
- An MVR result governs **only** the Approved Driver badge — it can never change a caregiver's core approval, `verified`, or `active` status.
- MVR can never be charged-without-delivered or shown-without-charged due to missing configuration.

## Non-Goals

- Refund / payment-reversal handling when an MVR check fails after payment.
- An admin UI to manually grant or revoke the driver badge.
- Any change to the core criminal background check flow.

## Users

- **Caregivers** who drive (or want to start driving) clients and need the Approved Driver badge to be visible to families that require a driver.
- **Families** who need a driver — they rely on the Approved Driver badge to filter caregivers.

## Behavior

### 1. MVR opt-in at signup
- The MVR add-on is offered to **all** caregivers during membership signup, regardless of services listed.
- It is presented as a real opt-in control the caregiver can toggle on or off; default is off.
- When selected, the MVR price is added to the Stripe checkout and the resulting payment triggers a background check that includes MVR (current bundled behavior, but now genuinely chosen).
- When not selected, only the base criminal check runs.

### 2. Add MVR later
- A caregiver who has already completed signup can add the Approved Driver upgrade later, from **either**:
  - **Dashboard self-serve** — a clearly labeled action (e.g. "Become an Approved Driver") on the caregiver dashboard / payments area.
  - **Cara over SMS** — the caregiver can ask Cara to add driver status; Cara sends a payment link and triggers the check on completion.
- Both paths: caregiver pays via Stripe → on successful payment, a **standalone MVR-only** background check is initiated.
- The later MVR check is independent of the original criminal check — it does not re-run or re-verify the core background check.

### 3. MVR result handling (the wall)
- An MVR check's result is tracked independently from the core background check result.
- When an MVR check clears: set the Approved Driver badge (`isApprovedDriver`).
- When an MVR check comes back adverse / needs-review / fails: the caregiver does **not** receive (or loses) the Approved Driver badge, and their core approval, `verified`, `verificationStatus`, and `status` fields are **left untouched**.
- This is the load-bearing requirement. Today the Checkr webhook (`functions/src/checkr.ts`) routes every report by the caregiver's single candidate ID and writes into the shared `verified` / `verificationStatus` / `status` fields on `report.completed` (and the adverse-action paths). MVR results must be routed and stored separately so they cannot flip those shared fields.

### 4. Configuration safety
- The MVR feature depends on environment configuration that is currently undocumented: `STRIPE_MVR_PRICE_ID` and the MVR Checkr package(s). Today, if `STRIPE_MVR_PRICE_ID` is unset the MVR add-on silently no-ops (no charge, no check), and `CHECKR_PACKAGE_MVR` defaults to the base package — so a misconfig can charge for MVR while running a non-MVR check.
- These must be documented (e.g. in `.env.example`) and validated so the two silent-failure modes are impossible: MVR shown/charged but no MVR check run, or MVR check run with no charge.

## Success Criteria

- A caregiver with no Transportation service can opt into MVR at signup and gets the Approved Driver badge after the check clears.
- A caregiver can decline MVR at signup and complete signup with only the base check.
- An already-approved caregiver can add MVR later from both the dashboard and Cara, is charged once, and an MVR-only check runs.
- An adverse MVR result removes/withholds only the driver badge; the caregiver's approved/active standing is unchanged and they remain bookable.
- With `STRIPE_MVR_PRICE_ID` or the MVR package misconfigured, the system refuses to charge or surfaces an error rather than silently delivering the wrong thing.

## Outstanding Questions (resolve during planning)

1. **Pricing & billing shape of the later MVR.** Same as signup MVR ($9.50)? One-time or recurring? Today's signup add-on rides a `subscription`-mode Stripe checkout, which conflicts with the existing "one-time charge" UI copy in `components/caregiver/CaregiverMembership.tsx`. The later, standalone purchase likely wants a one-time payment, not a subscription line item.
2. **Eligibility timing for adding later.** Can a caregiver add MVR before their base criminal check has cleared, or only once they're approved/active?
3. **MVR-only Checkr package.** Does the standalone later check need a distinct MVR-only Checkr package, separate from the bundled package used at signup? (Assumption: yes — to run MVR without re-running the criminal check.)

## Current-State References

- `components/caregiver/CaregiverMembership.tsx` — signup membership UI; today's auto-bundled, display-only MVR.
- `services/stripeService.ts` — `createCaregiverCheckoutSession` passes `includeMVR` to the checkout function.
- `functions/src/stripe.ts` — `createCheckoutSession` adds the MVR line item + `metadata.includeMVR`; `handleCheckoutSessionCompleted` selects the Checkr package and initiates the check.
- `functions/src/checkr.ts` — `initiateCheckrCandidate` (reads `mvrPaid`) and `checkrWebhook` (routes by candidate id; sets `isApprovedDriver` on clear; flips shared verification fields).

## Assumptions

- The Stripe and Checkr integrations remain the payment and background-check providers; no provider change is contemplated here.
- "Standalone MVR-only check" is achievable on Checkr (either an MVR-only package or an MVR screening added to the existing candidate) — to be confirmed in planning.
