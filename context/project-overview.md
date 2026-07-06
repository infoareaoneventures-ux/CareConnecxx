# Evia — Project Overview

> Single source of truth for *what* we are building and *what "done" means*.
> For *how* (stack, standards, workflow), see [CLAUDE.md](../CLAUDE.md) and the other `context/` files.

## Overview

Evia is a SaaS platform that connects families with vetted caregivers for in-home senior care. Families subscribe, describe the care they need, get AI/ML-matched to caregivers, interview, book, and pay — all in one place. Caregivers onboard conversationally through **Evia** (an AI SMS assistant), get background-checked, and receive payouts via Stripe Connect. It is a React + TypeScript SPA on Firebase, with Stripe (payments), Checkr (background checks), Google Meet links for interviews (generated server-side, texted to both parties by Evia), and a hybrid Claude/OpenAI agent layer.

## Goals

1. A family can go from sign-up to a booked, paid visit with a matched caregiver without leaving the product.
2. A caregiver can complete onboarding end-to-end over SMS (no app install) and become bookable.
3. Matching surfaces genuinely suitable caregivers (proximity + services + availability + ML score), not noise.
4. Money movement (subscriptions, booking charges, caregiver payouts) is correct, auditable, and compliant.

## Core User Flows

**Family (client)**
1. Sign up → $29.95/mo Stripe subscription (`VITE_STRIPE_PRICE_ID`).
2. Describe care need (job request, parsed by Evia/LLM).
3. Get matched (AI + ML scoring) → browse caregivers in `FindCaregivers`.
4. Interview (Google Meet link coordinated by Evia) → book → pay.
5. Ongoing: shift notes, care team, messaging, disputes.

**Caregiver**
1. Web entry `/start?role=caregiver` → phone verification → handoff to Evia over SMS.
2. Evia SMS onboarding (canonical): name → location → experience → specialties → profile → availability → job type → rate → email → bio → photo → documents → MVR opt-in → membership ($24.95/yr) → background check (Checkr) → Stripe Connect payout setup.
3. On completion the caregiver doc is finalized `status: "active"` **and** `onboardingStatus: "profile_complete"` — which makes them visible in family search.
4. Ongoing: jobs board, bookings, calendar, payouts, instant payout.

## Scope

### In scope
- Two roles (client, caregiver) on one Firebase Auth.
- Evia AI agent for onboarding + Q&A + booking assistance over SMS/iMessage (LINQ).
- AI + ML caregiver matching.
- Stripe subscriptions + Stripe Connect payouts; Checkr background checks; Google Meet link interviews coordinated by Evia.

### Out of scope (today)
- Native mobile apps (the product is a responsive SPA + SMS).
- Non-US geographies / non-USD payouts (Stripe Connect is `country: "US"`).
- Insurance claims / direct medical record integration.

## Success Criteria (measurable, release-gating)

> These are the conditions a release must satisfy. Each should be verifiable by running the product or a test — not by inspection of code.

1. A caregiver who completes the **entire Evia SMS onboarding** appears in a matching family's `FindCaregivers` results. *(Regression guard: this silently failed before — Evia wasn't setting `onboardingStatus: 'profile_complete'`.)*
2. A signed-up, subscribed family can complete: describe need → see ≥1 ranked match → book → successful payment, with the booking persisted.
3. Every caregiver-only route requires caregiver auth (no caregiver page renders for an unauthenticated/non-caregiver user).
4. Stripe webhooks (subscription, Connect, membership) and Checkr webhooks each advance the correct onboarding/booking state exactly once (idempotent).
5. `npm run build` **and** `npm run typecheck` both pass with zero errors.
6. No free-form user SMS intent is parsed by regex/keyword matching (per the Evia rules in CLAUDE.md) — understanding goes through an LLM.

## Open Questions

Tracked in [progress-tracker.md](./progress-tracker.md) under "Open Questions."
