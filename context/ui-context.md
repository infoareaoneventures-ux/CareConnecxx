# Evia — UI Context

> The real design system. Source of truth for tokens is [`index.css`](../index.css) (`@theme` block). All colors must use these tokens (Tailwind classes like `bg-primary-600`, `text-neutral-900`) — no hardcoded hex in components.

## Theme

A **warm, friendly, light** consumer healthcare product (not dark mode). The feeling is trustworthy and approachable for families and caregivers: clean white/slate surfaces, a confident blue primary, and a warm peach accent for highlights and emotional moments. Some caregiver-facing surfaces use a deeper/indigo treatment.

## Typography

- **Font:** `Plus Jakarta Sans` (Google Fonts), fallback `system-ui, sans-serif`. Token: `--font-family-sans` → use `font-sans`.
- iOS guard: inputs/textareas/selects are forced to `font-size: 16px` to prevent auto-zoom.

## Colors (tokens — Tailwind 4 `@theme`)

| Role | Token family | Notes |
|------|--------------|-------|
| Primary | `--color-primary-50..900` | Blue (`#3b82f6` / 600 `#2563eb`). Primary actions, links, brand. |
| Neutral | `--color-neutral-50..900` | Slate. Text, surfaces, borders. |
| Accent | `--color-accent-50..700` | Warm peach (`500 #fa613a`). Highlights, emotional CTAs. |
| Success | `--color-success-50..800` | Green. |
| Warning | `--color-warning-50..700` | Amber. |
| Error | `--color-error-50..700` | Red. |
| Info | `--color-info-50..700` | Blue. |
| Emerald | `--color-emerald-50..700` | Reserved for high wellness/peace-of-mind scores. |
| Purple | `--color-purple-500` | Sparingly. |
| Paper | `--color-paper-50..200` | Warm cream page surfaces — platform-wide. |
| Ink | `--color-ink-400/600/900` | Soft ink text (never pure black) — platform-wide. |

## Platform design language (2026-07-02 redesign — landing first, extended platform-wide same day)

The whole product uses the calm editorial style introduced on the landing page: paper cream page backgrounds (`bg-paper-50`, alt `bg-paper-100`; cards stay white), **Fraunces** display serif for page-level headlines (`.font-display`), hairline dividers (`.hairline`), and ONE CTA style — the dark `.btn-depth-primary` pill (`rounded-full`), now baked into the `ui/Button` primitive (all variants). Secondary actions are quiet text links ("… →"), never a second colored button. Body/UI text stays Plus Jakarta Sans. Semantic status colors (success/warning/error) are kept for genuine status; iMessage blue only inside phone/chat UI. Numbered section markers (`.section-number`) are a landing-only flourish.

Common usage: page bg `bg-neutral-50`, surfaces `bg-white`, primary text `text-neutral-900`, muted `text-neutral-500`, borders `border-neutral-200`.

## Icons

- **Lucide React.** Stroke-based. Inline `h-4 w-4`; buttons/headers `h-5 w-5`.

## Components

- Reusable primitives live in [`components/ui/`](../components/ui/) (Button, Input, Card, Modal, etc.). **Reuse these before writing new ones.**
- Domain components are organized by area: `components/client/`, `components/caregiver/`, `components/admin/`, `components/ai/`, `components/landing/`, `components/shared/`.
- Top-level component files (e.g. `components/BookingModal.tsx`) are older; the canonical versions live in the domain subdirectories.

## Layout & interaction patterns

- **Modals/overlays:** centered overlay, often with a backdrop; multi-step wizards use a top progress bar (e.g. `CaregiverOnboardingWizard`).
- **Mobile-first:** min touch target 44×44px under 640px; safe-area insets for notched devices (`.safe-area-bottom`, `.safe-area-inset`); larger video controls on mobile.
- **Motion:** respects `prefers-reduced-motion`. Helpers: `.fade-in`, `.animate-slide-in`, `.skeleton` loading shimmer, `.mic-active` pulse for the voice interface.
- **Button variants:** `primary` (dark tactile pill), `secondary`, `outline`, and `brand` — the caregiver pages' blue `bg-primary-600` CTA (Apply Now on the dashboard and Jobs page match, 2026-09-30).
- **Tab pills + alert badges (both roles, 2026-09-30):** selected tab = `bg-primary-500 text-white` pill, selected sub-chip = `bg-primary-600`; a red `bg-red-500` number pill on a tab/chip means "something here waits on you", computed from LIVE data (pending requests, pending interviews, unsubmitted shifts, corrections to answer) — never a per-browser "new since last clicked" timestamp, never amber. Informational totals are plain `(n)` text, not a pill. Family side: Posts = applicants to review, Interviews = caregiver-proposed times, Timesheets = hours to approve / counters; My Bookings Requests has NO pill (those wait on the caregiver).
- **Special button styles:** `.btn-depth-primary` / `.btn-depth-secondary` (depth-gradient buttons), `.bg-noise-overlay` (subtle texture).

## Rules

1. Use color **tokens** via Tailwind classes — no raw hex in components (define new tokens in `index.css` `@theme`).
2. Reuse `components/ui/` primitives and Lucide icons; don't hand-roll equivalents.
3. New cross-cutting CSS (animations, utilities) belongs in `index.css`, not inline `<style>`.
4. Keep mobile parity: any new interactive element must meet the 44px touch-target and 16px input-font rules.
