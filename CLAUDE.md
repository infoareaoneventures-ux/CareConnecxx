# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context Files (read before any architectural decision)

CLAUDE.md is the canonical guide for *how* the code works (stack, conventions, Evia rules). The `context/` directory holds the living product spec — read these first:

1. [`context/project-overview.md`](context/project-overview.md) — what we're building, goals, scope, and **release-gating success criteria**.
2. [`context/ui-context.md`](context/ui-context.md) — theme, color tokens, typography, component conventions.
3. [`context/progress-tracker.md`](context/progress-tracker.md) — current phase, completed work, ranked backlog, open questions.

**Update `context/progress-tracker.md` after every meaningful implementation change.** If a change alters architecture, scope, or standards, update the relevant context file (or CLAUDE.md) before continuing. Do not add new point-in-time report files to the repo root — record status in the progress tracker.

## Project Overview

Evia is a SaaS platform connecting families with caregivers. It's a React + TypeScript SPA backed by Firebase, with Stripe for payments, AI/ML-powered caregiver matching, Google Meet links for interviews (generated server-side, texted to both parties by Evia), and Checkr for background checks.

### Naming (Evia rebrand, 2026-07-02)

The product and its AI agent were renamed **Cara / CareConnex → Evia** (public domain: **eviacares.com**). Only user-facing text changed. The following intentionally KEEP the legacy names — do NOT rename them:
- **Code identifiers and file names**: `CaraChat.tsx`, `caraAgent.ts`, `useCaraUnread`, `CareConnexContext.tsx`, `useCareConnex()`, `CARA_CAPABILITIES`, etc.
- **Env var names**: everything prefixed `CARA_` (`CARA_AGENT_MODEL`, `CARA_AVATAR_URL`, …) — the live function env depends on them.
- **Persisted Firestore values and contracts**: `senderId: 'cara'`, `source: 'cara_sms'`, `threads/cara_{uid}`, `isCaraThread`, the `source=cara` URL param, firestore.rules checks — existing prod data uses these.
- **Firebase project/hosting**: `careconnex-d4c8b` / `https://careconnex-d4c8b.web.app` stays the live test URL until eviacares.com is linked to Firebase Hosting (not yet done). Marketing/SEO/legal URLs already point at eviacares.com.
- Historical docs (`docs/plans/`, `docs/reports/`, `docs/brainstorms/`) still say Cara/CareConnex — they are dated records, leave them.

## Commands

```bash
npm run dev          # Dev server on port 5173
npm run build        # Production build → dist/
npm run preview      # Preview production build locally
npm run deploy       # Build + deploy to Firebase Hosting + Functions
npm test -- --run    # Run all Vitest unit tests (non-watch)
npm test -- --run src/path/to/file.test.tsx  # Single test file
npx playwright test  # E2E tests (requires running dev server)
vite build --mode analyze  # Bundle visualization
npm run migrate:predictive:dry  # Dry-run Firestore data migration

# Cloud Functions (separate npm workspace under /functions)
npm --prefix functions ci && npm --prefix functions run build
```

## Architecture

### Tech Stack
- **Frontend**: React 18, TypeScript, Vite 5, Tailwind CSS 4
- **Backend**: Firebase (Auth, Firestore, Cloud Functions, Storage, Messaging)
- **Payments**: Stripe subscriptions (clients) + Stripe Connect (caregiver payouts)
- **AI**: Anthropic Claude (unified — both frontend and backend)
  - Frontend calls via `aiProxy` Firebase Function (server-side key, auth-gated, rate-limited)
  - Claude Haiku (`claude-haiku-4-5-20251001`): parseJobRequest, generateShiftNote, suggestRate, intent classification, health signals
  - Claude Sonnet (`claude-sonnet-4-6`): conversationalBooking, searchCaregivers, weekly digest, dispute analysis
- **ML**: TensorFlow.js (`services/mlModel.ts`) — currently exercised only by tests; the in-app scoring service was removed in the 2026-07-02 cleanup
- **SMS/voice**: Twilio server-side in `functions/` (the frontend `twilio-video` interview room was removed 2026-07-02)
- **Interviews**: Google Meet links generated via the Meet REST API (`functions/src/agents/interviewLinks.ts`) and delivered over SMS by Evia to both family and caregiver — no in-app video room
- **Background checks**: Checkr via Cloud Functions webhooks
- **Error tracking**: Sentry (dsn via `VITE_SENTRY_DSN`)
- **Validation**: Hand-rolled runtime validators in `utils/validation.ts` (`ValidationError` + format/normalization helpers; not Zod). Zod is used only server-side in `functions/`.
- **XSS protection**: DOMPurify in `utils/sanitize.ts`
- **PII helpers**: `utils/encryption.ts` provides pure client-side masking helpers (e.g., `maskSSN`, `maskPhone`). It does NOT encrypt — the former CryptoJS-based wrappers were removed; real encryption, if needed, must be reintroduced as deployed Cloud Functions.

### Component Structure
Components are domain-driven:
- `components/ui/` — reusable primitives (Button, Input, Card, Modal, etc.)
- `components/client/` — client-facing features (dashboard, matching, payments, care team)
- `components/caregiver/` — caregiver features (onboarding checklist, calendar, payouts)
- `components/admin/` — admin panel (caregiver verification, finance, assignment manager)
- `components/ai/` — AI-driven components
- `components/landing/` — marketing/landing page
- `components/shared/` — cross-domain shared components

Legacy top-level duplicates (BookingModal, Chat, ClientDashboard, etc.) were removed in the 2026-07-02 dead-code cleanup (see `docs/dead-code-removal-2026-07-02.md`). The remaining top-level components (`components/CaregiverDashboard.tsx`, `components/CaregiverProfileModal.tsx`, ...) are the live, routed versions.

### Global State
`context/CareConnexContext.tsx` holds global state: current user (client or caregiver), appointments, caregivers list, toasts/notifications, and active view. Access via `useCareConnex()` hook.

### Service Layer
All Firebase and external API calls go through `services/`. Key files:
- `services/api.ts` — primary service (~128KB, large); wraps Firestore reads/writes for almost every entity
- `services/aiMatchingService.ts` — Google GenAI-powered matching
- `services/matchService.ts` — orchestrates AI matching
- `services/chatService.ts`, `notificationService.ts` — messaging/notifications

### Firebase Cloud Functions
Backend lives in `functions/src/`. Functions handle:
- Stripe webhooks (subscriptions, Connect payouts, instant payouts)
- Checkr background check webhooks
- Transactional emails
- Server-side Stripe operations (creating Connect accounts, initiating payouts)

Functions are deployed with a `v1` prefix. Environment variables for functions (Stripe secret key, Checkr API key, webhook secrets) are set via Firebase Functions config, not `.env`.

### Routing
React Router v6 in `App.tsx`. Landing page and critical auth routes are eagerly loaded; all dashboard/feature routes are lazy-loaded with `React.lazy()`.

### User Roles
Two distinct user roles share the same Firebase Auth:
- **Clients** (families): $29.95/month Stripe subscription (`VITE_STRIPE_PRICE_ID`)
- **Caregivers**: $54.99/year membership (covers the required criminal-only Checkr background check, package `complete_background_check`; `VITE_STRIPE_CAREGIVER_ANNUAL` → price_1TtBYw…, repriced from $66.49 on 2026-07-14 — the old price/product are archived but legacy subscriptions still bill on them), onboarded conversationally via Evia over SMS. Optional **Approved Driver (MVR)** add-on: $11.50 one-time (`STRIPE_MVR_PRICE_ID` → price_1TtBZ9…) charged in the same signup checkout when opted in; Checkr then runs `checkrdirect_essential_criminal` (criminal + MVR, `CHECKR_PACKAGE_MVR`) instead of the base package; the later standalone add-on runs the `mvr` package (`CHECKR_PACKAGE_MVR_ONLY`).

### Caregiver Onboarding
Evia's SMS conversation is the **sole** caregiver onboarding path. Every signup CTA routes to `/start?role=caregiver` (`components/auth/onboarding/OnboardingFlow.tsx`), which verifies the phone then hands off to Evia via SMS. Evia collects profile → credentials → photo/document upload → membership (Stripe) → background check (Checkr) → Stripe Connect payout setup, and finalizes the `caregivers` doc with `status: 'active'`, `onboardingStatus: 'profile_complete'` (gates visibility in `FindCaregivers`), and `verificationStatus: 'submitted'` (puts it in the admin verification queue). The old web signup form was retired — `/caregiver/apply` now redirects into the Evia flow. `components/caregiver/CaregiverOnboardingWizard.tsx` is kept ONLY as a recovery tool for legacy/web accounts left at `onboardingStatus: 'incomplete'` (it is not a signup path).

**Collection is loop-only (Deploy B, 2026-07-08).** Conversational field collection (both roles) runs INSIDE the qaAgent loop (`onboardingMode`, `functions/src/agents/qaAgent.ts`), routed by `shouldRouteOnboardingToLoop` (`onboardingContract.ts`) — any text turn at a collection step goes to the loop, unconditionally (the `ONBOARDING_AGENT_LOOP*` flags were removed). The scripted `client_ask_*` / `caregiver_ask_*` collection handlers in `onboardingConversation.ts` were **deleted** — that file now owns only the KEPT deterministic path: `verify_phone`, `ask_role`, `client_confirm_name` / `caregiver_confirm_name` (which hand a substantive non-name answer to the loop via `dispatchOnboardingToLoop`), the post-collection client intake steps (`client_ask_start/preferences/budget/confirm_intake`, still table-driven via `conversationStep.ts` + `onboardingSteps.client.ts`), `handleInboundMedia`, and all gate/awaiting steps (photo/documents/MVR/membership/Checkr/Stripe Connect + `advanceOnboardingStep`). The loop's field contract + persistence net live in `onboardingContract.ts` (single source of truth), `caregiverFieldAbsorber.ts`, and `absorbClientFields`. Rollback: `git checkout pre-deletion` (the Deploy A tag) + redeploy.

**Background check (webapp parity, 2026-07-08):** the SMS flow mirrors the webapp's Checkr flow. After membership payment Evia texts a token-authenticated `/bgcheck` consent page (FCRA disclosure + authorization, legal name/ZIP/state — `BgcheckConsentPage.tsx`, same content as the webapp's `BackgroundCheckModal`); its callable `v1-confirmBgcheckOnboarding` → `confirmBgcheckConsent` is the ONLY place the SMS flow creates the Checkr candidate + invitation (consent recorded on the caregiver doc in the webapp's shape). Checkr then EMAILS the caregiver the secure completion link (SSN/DOB entered on Checkr's site). Session step between link and consent: `caregiver_awaiting_bgcheck_consent`. Never re-add a pre-consent Checkr call to `handleCaregiverSendBgcheck` or `sendOnboardingLink`.

**Identity model (unified):** Caregivers get a Firebase Auth account during onboarding — at `/start` OTP verification (web entry path) or, for the cold-SMS path, when the caregiver doc is first created (photo/bg-check step via `createFirebaseAuthAccount`). The identity model is unified: `caregivers/{uid}` = `users/{uid}` = Auth uid. Legacy phone-keyed random-ID docs were migrated by the `rekeyLegacyCaregiverDocs` migration (already run in prod). Evia's Firestore writes land where the web reads.

## Environment Variables

Only `VITE_` prefixed vars are available client-side (via Vite). The critical ones:
```
VITE_STRIPE_PUBLISHABLE_KEY   # Stripe public key
VITE_STRIPE_PRICE_ID          # Client monthly subscription price ID
VITE_STRIPE_CAREGIVER_ANNUAL  # Caregiver annual membership price ID
VITE_SENTRY_DSN               # Leave empty in dev
```

Firebase config is typically embedded via `lib/firebase.ts` (check for hardcoded config or env vars there).

## Testing

- Unit tests: Vitest + Testing Library, jsdom environment, config in `vitest.config.ts`
- E2E: Playwright in `tests/e2e/` and `e2e/`
- CI: GitHub Actions (`.github/workflows/ci.yml`), Node 20, mocks Firebase env vars

## Key Conventions

- Geolocation (lat/lng) is stored on caregiver documents for proximity-based matching
- Sensitive fields (e.g., SSN, phone) are masked for display via `utils/encryption.ts` helpers; there is no client-side at-rest encryption today
- All user input going to Firestore should be sanitized via `utils/sanitize.ts`
- Stripe Connect is used for caregiver payouts; instant payouts are a separate flow via `components/caregiver/InstantPayoutModal.tsx`
- `services/api.ts` is the authoritative place to add new Firestore operations — avoid direct `db` calls in components

## Evia — AI-Agentic Rules (MANDATORY)

Evia is a fully AI-agentic assistant. Every piece of code that touches Evia MUST follow these rules.

### Hybrid LLM architecture (model ladder — source of truth: `functions/src/config/caraModels.ts`)
Evia's models are resolved per **tier** by `resolveCaraModelConfig(tier)` with env overrides:
- **Agent tier** (the QA agent's multi-turn tool-use loop in `functions/src/agents/qaAgent.ts`, via the `runAgentModelTurn` seam in `agentModelTurn.ts`): provider set by `CARA_AGENT_PROVIDER`, model by `CARA_AGENT_MODEL`. **Prod decision (founder, 2026-07-01): OpenAI `gpt-5.4` primary with automatic Anthropic Sonnet fallback** (`CARA_AGENT_ANTHROPIC_FALLBACK=true`). The code default when env vars are absent is `gpt-4o` — always set `CARA_AGENT_MODEL` in the deployed env. Any future provider/model change goes through the spend-gated eval (`npm run eval:onboarding`) per the launch plan's model-gate protocol, and updates the PHI provider addendum in `AGENT_NATIVE_EXCLUSIONS.md`.
- **Quick/router/vision tiers** (single-shot calls: intent classification, YES/NO, structured extraction, `parseWithClaude`, trivial-greeting bypass): `CARA_QUICK_MODEL` / `CARA_ROUTER_MODEL` / `CARA_VISION_MODEL` (prod: gpt-5.4-mini / gpt-5.4-nano / gpt-5.4-mini). Route through `functions/src/utils/openaiClient.ts` (`getOpenAIClient`, `quickComplete`).
- **Escalation tier** (`CARA_ESCALATION_MODEL`): defined but not yet wired to a caller.

Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` must be set in the function env (the fallback path needs Anthropic live even when OpenAI is primary).

### Always use an LLM for user input understanding
- **NEVER** use regex, hardcoded keyword arrays, `.includes()`, or string equality to parse the MEANING or INTENT of free-form user SMS text
- **ALWAYS** call `parseWithClaude(systemPrompt, userText)` to extract structured values from any natural language input. (Despite the name, this helper now uses gpt-4o-mini under the hood — public API and behavior unchanged.)
- **ALWAYS** add an `isQuestionOrOther(text)` check at the top of every conversational handler so Evia can answer mid-flow questions before re-asking the current question

### The `parseWithClaude` pattern (use this in every handler)
```typescript
const raw = await parseWithClaude(
  '"1" or "basic" or "cheapest" → basic. "2" or "family" → family. ...',
  text
);
const validated = ["basic","family","premium"].includes(raw) ? raw : "basic";
```

For new ad-hoc single-shot calls (not via parseWithClaude), use `quickComplete(systemPrompt, userText, { maxTokens })` from `utils/openaiClient.ts`. Do NOT call `getSharedClient().messages.create()` for new fast-path code — that pathway is reserved for the QA agent.

### What IS allowed without an LLM
- `norm === "YES" || norm === "NO"` when the system explicitly said "Reply YES or NO" (strict binary SMS protocol)
- Email format regex for validation (not intent parsing)
- STOP/UNSUBSCRIBE/QUIT keywords (SMS carrier opt-out protocol requirement)
- Safety/crisis keyword fast-path in `crisisDetector.ts` (speed is life-critical; the LLM can't be the only gate)
- `isTrivialQuickReply(text)` heuristic in qaAgent.ts (length + entity-marker check used to choose between runQuickReply and runQaAgent — not intent parsing)

### New Evia handlers checklist
Every new conversational step handler must have:
1. `isQuestionOrOther` check → answer question → re-ask current question
2. `parseWithClaude` for all user input → validate the returned value → store
3. Conversational acknowledgment of what the user said before moving to the next question
4. `sendMessage` with the next question

### Model selection cheat-sheet
- Single-shot classify / YES-NO / JSON extraction → `quickComplete` or `parseWithClaude` (quick tier, `CARA_QUICK_MODEL`)
- Multi-turn reasoning with MCP tools → `runQaAgent` (agent tier via `runAgentModelTurn` — OpenAI primary, Sonnet fallback; see Hybrid LLM architecture)
- Trivial greeting / acknowledgment fast path → `runQuickReply` (quick tier, no tools)
