# Fix plan: code-review findings on the job-post/identity bug-fix wave

**Date:** 2026-07-14
**Status:** APPROVED — ready to implement
**Origin:** Two-axis code review (Standards + Spec) of the uncommitted A–D implementation
(city-geocode fallback, honest notify copy, pay-rate step, $0/hr fix, identity UX).
Findings numbered 1–7 are the Spec axis; S1–S4 are the Standards axis (founder opted
to include the cleanups). All fixes stay LOCAL — deploy and the Anahi/Rosy live
recovery remain HELD pending founder go.

**Founder decisions baked in:**
- Include the standards cleanups in the same pass.
- Pay-rate fallback policy: re-ask ONCE on unparseable/out-of-range input; if the
  second reply still doesn't parse, set flexible and explicitly say so (never a
  silent coercion). Valid custom range stays $5–$200.

---

## Fix 1 — "$0/hr" still renderable in My Applications rows (B5 gap)

**Files:** `components/caregiver/JobBoard.tsx` (~:904, ~:1046)
`app.jobRate != null` guards null but not 0, so applications to flexible jobs
(snapshot stores `jobRate: job.rate ?? null` = 0) render "$0/hr".

- Change both application-row badges to render via the rate label logic:
  `jobRate > 0 ? `$${app.jobRate}/hr` : 'Flexible'` (keep the badge; a small
  `appRateLabel(app.jobRate)` local or reuse `rateLabel({rate: app.jobRate})`).
- Sweep the file for any other `jobRate`/`rate` interpolations not yet covered.
- Optional hardening (same fix class): `functions/src/utils/jobApplicationDoc.ts`
  snapshot also copies `jobRateFlexible: !!job.rateFlexible` so future UI can
  distinguish "flexible" from "unknown". Display fix alone is sufficient; do the
  snapshot addition since we're here (additive, no reader breaks).

## Fix 2 — "Still reviewing" button should return to messages (C6 gap)

**File:** `components/client/IdentityCallback.tsx` (timeout block ~:150)
The copy promises "head back to your messages" but the button navigates to
`next` (`/client/find-caregivers`).

- Mirror the verified-state pattern: when `showBackBtn` (source=cara + mobile +
  caraPhone), render the primary action as `<a href={`sms:${caraPhone}`}>` "Go back
  to messages" with the secondary "Continue in the app" link; otherwise keep the
  existing `navigate(next)` button labeled "Continue".

## Fix 3 — clarify the `location`-string city fallback (scope-creep finding)

**File:** `functions/src/triggers/jobNotifications.ts` (cityRaw chain)
`intakeData.location ?? ""` is actually justified — `job_posts.location` IS a string
in the web contract ("City, State, Zip" joined) — but it's opaque and a joined
string would fail the equality match.

- Keep the fallback, but when it's used, take only the segment before the first
  comma (`location.split(",")[0]`) and add a comment citing the contract
  (`jobPostContract.ts` `locationStr`). This turns unasked scope creep into a
  correct, documented behavior.

## Fix 4 — stale comment in recovery script

**File:** `scripts/recover-anahi-job.mjs`
- Delete the "carePlans locationPool" claim from the mirror comment (code only
  mirrors job_postings — comment must match).
- Also fix the ZIP-clobber hazard flagged by Standards: write
  `location.lat/lng/city` via dotted-path update semantics or read-merge the
  existing `location` object instead of replacing it with one containing
  `zipCode: ''`.

## Fix 5 — pay-rate step: no silent flexible coercion (B4 gap)

**File:** `functions/src/agents/onboardingConversation.ts` (`handleJobAskPayRate`)
Per founder decision:

- Parse as today. If the reply parses to a valid number (5–200) or an explicit
  "flexible" → store and continue to the summary (explicit flexible is NOT a
  failure; no re-ask).
- If unparseable or out-of-range AND this is the first failure → re-ask once:
  "No rush — just need a number: $22, $26, $30, another amount, or say flexible."
  Track with a session flag (e.g. `onboardingData.rateReaskUsed: true`; clear it
  when the step completes).
- If the re-ask also fails → store flexible AND acknowledge it in the message
  before the summary: "I'll keep the rate flexible for now — you can change it
  anytime." (Coercion is visible, never silent.)
- Distinguish "explicit flexible" from "defaulted": have parseWithClaude return
  a third token (e.g. `unclear`) for replies that are neither a number nor an
  explicit flexible, instead of mapping everything unknown to flexible.

## Fix 6 — identity-cleared confirmation respects preferredLanguage (C7 gap)

**File:** `functions/src/agents/onboardingConversation.ts` (identity task ~:3869)
- Replace the hardcoded English line with a language ternary matching neighboring
  sends: es → "¡Tu verificación de identidad se aprobó — estás verificado! ✅",
  en → current copy. Keep it deterministic (no generateCaraMessage — this is a
  precise status confirmation, and the step must never fail-open to a hallucinated
  status line).

## Fix 7 — re-engagement label for the new step

**File:** `functions/src/scheduled/onboardingReengagement.ts` (`humanLabelForStep`)
- Add `job_ask_pay_rate: "choosing what you'll pay per hour"` next to
  `job_confirm_prefill`.
- Check `staleSessionNudge.ts`: its generic client `else` branch covers the new
  step acceptably — no change required there (confirm only).

## S1 — deduplicate the notified-count phrase (Standards: Duplicated Code)

**Files:** `functions/src/agents/buildJobPost.ts`, `functions/src/agents/jobPostingFlow.ts`
- Export a tiny `notifiedOutcomePhrase(city: string | null, count: number): string`
  from buildJobPost.ts (or have `jobLiveMessage` build on it); jobPostingFlow's
  `outcome` string uses it instead of re-implementing the pluralization ternary.

## S2 — kill the "your area" magic-string sentinel (Standards: Primitive Obsession)

**Files:** buildJobPost.ts (`jobLiveMessage`), onboardingConversation.ts (2 call
sites), jobPostingFlow.ts (1 call site)
- Change signature to `jobLiveMessage(city: string | null | undefined, count)`;
  callers pass the raw city (no `?? "your area"`); the function owns the
  "no city → 'in your area'" fallback internally. Delete the `city !== "your area"`
  comparison.

## S3 — progress tracker update (Standards: HARD violation)

**File:** `context/progress-tracker.md`
- Record this wave: notification-reach fixes (geocode fallback + city match +
  honest copy), pay-rate step, $0/hr display fix, identity UX fixes, and the HELD
  status of deploy + Anahi/Rosy recovery.

## S4 — (folded into Fix 4) recovery-script ZIP clobber

Covered under Fix 4 second bullet.

---

## Verification

1. `npm --prefix functions run build` (transpile, 0 errors) and
   `npx tsc --noEmit` filtered to touched files (repo has ~30 pre-existing
   unrelated errors — only new ones block).
2. Frontend `npx tsc --noEmit` filtered to JobBoard/IdentityCallback.
3. Targeted vitest if any existing suites cover jobNotifications/buildJobPost
   (run in two halves if OOM — known repo issue).
4. Manual trace of the pay-rate re-ask path: first bad reply → re-ask; second bad
   reply → flexible + acknowledgment + summary; explicit "flexible" → straight to
   summary with NO re-ask.
5. Re-run the two-axis review deltas mentally against each finding before handing
   back.

## Explicitly out of scope (unchanged holds)

- `npm run deploy` — HELD for founder go.
- `scripts/recover-anahi-job.mjs --confirm` (live SMS to ~7 caregivers) — HELD.
- Detailed edit-flow rate question — untouched per original spec.
