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
| Paper | `--color-paper-50..200` | Warm cream surfaces — landing page only. |
| Ink | `--color-ink-400/600/900` | Soft ink text (never pure black) — landing page only. |

## Landing page design language (2026-07-02 redesign)

The marketing landing (`components/landing/`, `LandingView.tsx`) uses a calm editorial style distinct from the app: paper cream backgrounds, **Fraunces** display serif for headlines (`.font-display`), hairline dividers (`.hairline`), numbered section markers (`.section-number`), and ONE CTA style — the dark `.btn-depth-primary` pill (`rounded-full`). Secondary actions are quiet text links ("… →"), never a second colored button. Body/UI text stays Plus Jakarta Sans.

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
- **Special button styles:** `.btn-depth-primary` / `.btn-depth-secondary` (depth-gradient buttons), `.bg-noise-overlay` (subtle texture).

## Rules

1. Use color **tokens** via Tailwind classes — no raw hex in components (define new tokens in `index.css` `@theme`).
2. Reuse `components/ui/` primitives and Lucide icons; don't hand-roll equivalents.
3. New cross-cutting CSS (animations, utilities) belongs in `index.css`, not inline `<style>`.
4. Keep mobile parity: any new interactive element must meet the 44px touch-target and 16px input-font rules.
