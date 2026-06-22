---
title: "refactor: Repo cleanup — dead code, unused deps, doc drift"
created: 2026-06-21
status: requirements
type: refactor
scope: standard
source: /ponytail-audit (whole-tree over-engineering audit, 2026-06-21)
---

# refactor: Repo cleanup — dead code, unused deps, doc drift

## Summary

A single low-risk cleanup pass that removes confirmed dead weight from the repo and corrects stale documentation, with **zero intended behavior change**. Scope was set by a whole-tree over-engineering audit and pared to the findings that are either provably unreferenced or mechanically equivalent. Roughly 6,700 lines of dead code, 26 archived report files, and 9 dependency entries come out. Every deletion is gated by a green build + test + typecheck so "unreferenced" is proven, not assumed.

---

## Problem Frame

The audit confirmed three classes of accumulated cruft:

1. **Dead code** — top-level components and services that nothing imports (verified against all import forms, not just path-prefix grep), plus one-off admin/debug scripts dumped in the repo root and a tracked `firestore.rules.temp` leftover.
2. **Unused dependencies** — packages declared in `package.json` that are imported nowhere, plus two deps doing what the Node 22 / browser platform already ships.
3. **Documentation drift** — `CLAUDE.md` asserts a Zod validation layer and CryptoJS encryption that no longer exist in the code, which actively misleads future contributors and AI agents navigating the repo.

Dead code and false docs carry no runtime cost but a real comprehension cost: they confuse contributors, mislead AI agents reading the tree, and inflate the surface that every future change has to reason about.

---

## Goals & Success Criteria

- **G1.** Remove all confirmed-dead code and unused dependencies without changing any observable behavior.
- **G2.** Bring `CLAUDE.md` back in sync with what the code actually does.
- **G3.** Prove safety mechanically — the deletion is complete only when the full verification gate is green.

**Success looks like:**
- `npm run build`, `npm test -- --run`, `tsc --noEmit`, and the functions build (`npm --prefix functions run build`) all pass after the changes.
- The named files no longer exist; the named deps are gone from both `package.json` files and lockfiles.
- `CLAUDE.md` no longer claims Zod or CryptoJS are in use.
- No new behavior, no new dependency, no public-surface change.

---

## Scope Boundaries

### In scope

**Dead code deletion** (provably unreferenced):
- 11 orphaned top-level components (~4,428 lines): `components/Agreement.tsx`, `components/CaregiverCalloutButton.tsx`, `components/CaregiverEarnings.tsx`, `components/CaregiverSignup.tsx`, `components/ChatInbox.tsx`, `components/ClientIntakeFlowV2.tsx`, `components/HireDecision.tsx`, `components/InterviewConfirmation.tsx`, `components/InterviewFeedbackModal.tsx`, `components/Interviews.tsx`, `components/JobPostModal.tsx`.
- 3 unreferenced matching services (~949 lines): `services/matchScoring.ts`, `services/matchingExamples.ts`, `services/trainingSimulation.ts`.
- 10 loose root one-off scripts / scratch HTML (~1,250 lines): `approve-caregiver.js`, `approve-caregiver-admin.js`, `check-job-posts.js`, `create-caregiver-account.js`, `get-chat-id.js`, `test-telegram.js`, `mass_rename.cjs`, `poke_html.html`, `poke_source.html`, `booking-demo.html`.
- `firestore.rules.temp` (tracked leftover copy of the rules).
- All 26 point-in-time report files in `docs/archive/`.

**Unused dependency removal** (imported nowhere):
- Frontend `package.json`: `zod`, `@google/genai`, `crypto-js`, `@types/crypto-js`, `@types/dompurify`.
- Functions `package.json`: `telegraf`.

**Trivial platform swaps** (mechanical, then drop the dep):
- `uuid` → `crypto.randomUUID()` across the 3 functions call sites; remove `uuid` + `@types/uuid`.
- Frontend `axios` → native `fetch` for the single call in `services/api.ts`; remove `axios` from the frontend `package.json`.

**Documentation:**
- Correct `CLAUDE.md`'s claims that Zod validation lives in `utils/validation.ts` (it is hand-rolled) and that CryptoJS encryption is in use (the wrappers were removed; `utils/encryption.ts` is now pure masking helpers).

### Out of scope (deliberately kept)

- **`framer-motion`** — a legitimate animation library wrapped by `components/ui/Motion.tsx` and used by 5 components. Replacing it with CSS is a 5-component rewrite with a real UX-quality trade-off; not worth churning to win one `package.json` line.
- **The 11 functions-side `axios` call sites** — entrenched enough that swapping to `fetch` is its own task with its own reverification cost.
- **`components/index.ts` barrel** (audit flagged as a thin 6-symbol re-export) and the `ml/` vs `services/ml*` overlap — correctness/architecture judgment calls, not pure-bloat deletions. Left for a separate review.

### Deferred to follow-up work

- If the team later decides `framer-motion`'s carrying cost outweighs its polish, the CSS swap can be its own scoped change.
- Functions-side `axios` → `fetch` migration as a dedicated pass.

---

## Requirements

Grouped; each is a discrete, independently verifiable removal.

- **R1.** Delete the 11 orphaned top-level components listed in scope. Each was verified unreferenced against all import forms (static, lazy, relative, and barrel re-export); `CaregiverSignup.tsx` corroborated dead by the documented retirement of the web signup path in favor of Cara.
- **R2.** Delete the 3 unreferenced matching services. The live, test-pinned matching stack (`mlMatchScoring`, `mlModel`, `mlTraining`) must remain untouched; `trainingSimulation.ts` is referenced only by an archived doc, not by code or tests.
- **R3.** Delete the 10 loose root one-off scripts and scratch HTML files.
- **R4.** Delete `firestore.rules.temp`. The canonical `firestore.rules` must remain.
- **R5.** Delete all 26 files in `docs/archive/`. Git history preserves them if ever needed.
- **R6.** Remove the never-imported deps (`zod`, `@google/genai`, `crypto-js`, `@types/crypto-js`, `@types/dompurify`, `telegraf`) from the relevant `package.json` and update the lockfiles.
- **R7.** Replace `uuid` v4 calls with `crypto.randomUUID()` at the 3 functions call sites, then remove `uuid` and `@types/uuid`.
- **R8.** Replace the single frontend `axios` call in `services/api.ts` with `fetch`, then remove `axios` from the frontend `package.json`. Preserve existing request/response behavior (headers, error handling, JSON parsing).
- **R9.** Update `CLAUDE.md` so the Validation and Encryption descriptions match reality (hand-rolled validation; masking-only encryption helpers).
- **R10.** The change set is complete only when `npm run build`, `npm test -- --run`, `tsc --noEmit`, and `npm --prefix functions run build` all pass.

---

## Key Decisions

- **Pure deletions over swaps.** The bulk of the win (dead code + unused deps) carries zero behavior risk; that is the priority. Only the two *mechanically equivalent* swaps (`uuid`, frontend `axios`) were folded in because they are deletions in disguise.
- **Keep `framer-motion`.** Removing a working animation library for a dependency-count win risks degrading product feel — explicitly rejected.
- **Build+test gate is the proof.** "Unreferenced" is asserted from import analysis but only *confirmed* by a green gate; the verification is part of the requirement, not an afterthought.
- **Git history is the archive.** Deleting `docs/archive/` and root scripts loses nothing recoverable — history retains them, and `CLAUDE.md` already directs status into the progress tracker, not standalone report files.

---

## Risks & Mitigations

- **A grep-confirmed orphan is actually reached dynamically** (string-keyed lazy import, test-only import). *Mitigation:* the full build + Vitest + typecheck gate (R10) catches any dangling reference before the change lands; deletions are reverted per-file if the gate goes red.
- **`axios` → `fetch` behavior drift** (axios auto-throws on non-2xx and auto-parses JSON; `fetch` does neither). *Mitigation:* preserve the exact prior behavior in the rewrite (explicit status check + `.json()`); it is one call site, so the blast radius is tiny.
- **A removed dep is a transitive peer something relies on at runtime.** *Mitigation:* all six removed deps were verified as having zero import sites; `playwright-core` was intentionally NOT removed because `@browserbasehq/stagehand` depends on it. Lockfile rebuild + functions build confirm resolution.

---

## Open Questions

None blocking. The framer-motion and functions-`axios` decisions are settled as "keep / defer."

---

## Handoff

Ready for `/ce-plan`. The natural implementation-unit split is one unit per requirement group (R1–R5 deletions, R6 dep removal, R7–R8 swaps, R9 doc fix), each landing as its own atomic commit with the R10 gate run between groups so a red gate localizes to the last change.
