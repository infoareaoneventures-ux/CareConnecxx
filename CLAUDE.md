# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CareConnex is a SaaS platform connecting families with caregivers. It's a React + TypeScript SPA backed by Firebase, with Stripe for payments, AI/ML-powered caregiver matching, Twilio Video for interviews, and Checkr for background checks.

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
- **AI/ML**: Google GenAI (`@google/genai`) + TensorFlow.js for caregiver matching
- **Video**: Twilio Video for live caregiver interviews
- **Background checks**: Checkr via Cloud Functions webhooks
- **Error tracking**: Sentry (dsn via `VITE_SENTRY_DSN`)
- **Validation**: Zod schemas in `utils/validation.ts`
- **XSS protection**: DOMPurify in `utils/sanitize.ts`
- **Encryption**: CryptoJS in `utils/encryption.ts` for sensitive stored data

### Component Structure
Components are domain-driven:
- `components/ui/` — reusable primitives (Button, Input, Card, Modal, etc.)
- `components/client/` — client-facing features (dashboard, matching, payments, care team)
- `components/caregiver/` — caregiver features (onboarding checklist, calendar, payouts)
- `components/admin/` — admin panel (caregiver verification, finance, assignment manager)
- `components/ai/` — AI-driven components
- `components/landing/` — marketing/landing page
- `components/shared/` — cross-domain shared components

Top-level component files (e.g., `components/BookingModal.tsx`, `components/CaregiverDashboard.tsx`) are older; the canonical versions live in the domain subdirectories.

### Global State
`context/CareConnexContext.tsx` holds global state: current user (client or caregiver), appointments, caregivers list, toasts/notifications, and active view. Access via `useCareConnex()` hook.

### Service Layer
All Firebase and external API calls go through `services/`. Key files:
- `services/api.ts` — primary service (~128KB, large); wraps Firestore reads/writes for almost every entity
- `services/aiMatchingService.ts` — Google GenAI-powered matching
- `services/mlMatchScoring.ts` — TensorFlow.js scoring model
- `services/matchService.ts` — orchestrates AI + ML matching
- `services/chatService.ts`, `notificationService.ts`, `emailService.ts` — messaging/notifications

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
- **Caregivers**: $24.95/year membership (`VITE_STRIPE_CAREGIVER_ANNUAL`) + 8-step onboarding in `components/caregiver/signup/steps/`

### Caregiver Onboarding
8-step signup flow: `components/caregiver/signup/steps/Step1GetStarted.tsx` through Step 8. Steps include profile, credentials, background check (Checkr), intro video upload, and Stripe Connect setup.

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
- Sensitive fields use CryptoJS encryption before Firestore storage
- All user input going to Firestore should be sanitized via `utils/sanitize.ts`
- Stripe Connect is used for caregiver payouts; instant payouts are a separate flow via `components/caregiver/InstantPayoutModal.tsx`
- `services/api.ts` is the authoritative place to add new Firestore operations — avoid direct `db` calls in components
