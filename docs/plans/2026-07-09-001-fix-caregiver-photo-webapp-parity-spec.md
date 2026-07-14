# Spec: Caregiver profile-photo → webapp parity (fix implemented, deploy + follow-ups owed)

**Date:** 2026-07-09
**Trigger:** Founder test signup +14087261330 (Imran, caregiver flow). Photo taken on phone and uploaded via Evia's `/upload/photo` link never appeared on the webapp profile.
**Status:** Root-caused and FIXED IN CODE this session (4 files, builds clean, gate-walk tests 3/3 green). **NOT deployed.** This spec is the handoff for deploy + the follow-up items found during verification.

---

## 1. Account verification result (+14087261330) — read-only inspection, 2026-07-09

Inspected with the new `scripts/inspect-phone.mjs` (read-only counterpart of `delete-phone.mjs`; kept in the repo).

**Pipeline is healthy.** Everything Evia collected landed where the webapp reads it:

| Store | State |
|---|---|
| Firebase Auth | uid `NdqUXibmLLUkvW4MRqvrkiFQbPN2`, phone provider, created 07-09 04:45, last sign-in 15:09 |
| `users/{uid}` | name Imran, phone, userType caregiver ✓ |
| `caregivers/{uid}` | name, bio, city Santa Clara, email, rate $24, 12 yrs experience, specialties+skills, availability, jobType, embedding — all mirrored ✓. `status: pending_review`, `onboardingStatus: in_progress` (correct for mid-flow) |
| `agent_sessions/{+1408…}` | userType caregiver, step `caregiver_awaiting_bgcheck`, membership paid (`processedWebhookTasks: ["membership"]`), Checkr candidate `5f738666661fbf6d603d314e` + invitation URL present, FCRA consent recorded 12:28 in webapp shape ✓ |
| Storage | Photo EXISTS and is publicly fetchable: HTTP 200, image/jpeg, 256 KB at `profile_photos/onboarding/14087261330_1783572620426.jpg` (bucket `careconnex-d4c8b.firebasestorage.app`) |
| `caregivers/{uid}` photo fields | `profilePhoto` ✓ and `photoURL` ✓ both set to that URL |

So the upload worked, the mirror worked, the URL is on the caregiver doc. The photo was invisible **only because of a field-name mismatch on the webapp read side**.

## 2. Root cause

The webapp's canonical `Caregiver` photo field is **`photo`** (`types.ts:142`; `imageUrl` is legacy). The webapp's own AvatarUpload writes `photo` (`components/CaregiverProfile.tsx:146`). Evia's mirror (`buildCaregiverProfileMirror`, `functions/src/agents/onboardingConversation.ts`) wrote only `profilePhoto` + `photoURL` — never `photo`.

Readers that tolerate all variants (FindCaregivers.tsx:283, ClientCaregiverProfile.tsx:60, CaregiverProfileModal.tsx:147, caregiverProfileMeta.ts:120) rendered fine. But the three caregiver-facing surfaces read only `photo || imageUrl` and showed blank:

- `components/CaregiverProfile.tsx:225` — the `/caregiver/profile` page (what Imran looked at)
- `components/caregiver/CaregiverUserMenu.tsx:69` — nav avatar
- `components/caregiver/PublicCaregiverProfile.tsx:62` — public share page

Same bug class as the 2026-07-07 "client name orphaned" finding (write-side and read-side disagree on field name).

## 3. Changes made this session (NOT deployed)

1. **Write side** — `functions/src/agents/onboardingConversation.ts` `buildCaregiverProfileMirror`: when `profilePhoto` is set, also write `photo`. One fix covers all three write sites (incremental mirror, gate pre-create, finalization) AND the MCP `UPDATE_PHOTO` flow, since all photo paths converge on `advanceOnboardingStep("photo_upload") → mergeOnboardingData → mirror`.
2. **Read side** (so existing docs like Imran's render without a backfill): appended `profilePhoto || photoURL` to the fallback chains in `CaregiverProfile.tsx:225`, `CaregiverUserMenu.tsx:69`, `PublicCaregiverProfile.tsx:62`.
3. **Bonus bug found & fixed — photo-update step regression:** `advanceOnboardingStep case "photo_upload"` unconditionally set the session back to `caregiver_send_documents` and re-sent the documents ask. An **active** caregiver using Evia's profile photo-update flow (`caregiverProfileHandler.handlePhotoUpdate` reuses the same `photo_upload` token) would be dragged back into onboarding. Now guarded: flow only advances when the session is at `caregiver_send_photo`/`caregiver_awaiting_photo`; otherwise Evia sends a short `generateCaraMessage` confirmation ("new photo saved") and leaves the step alone.
4. **New tool** — `scripts/inspect-phone.mjs`: read-only per-phone dump (Auth, session+onboardingData, users/caregivers docs, phone-field orphans, web_onboarding_sessions, Storage, last messages).

**Verification done:** functions transpile 291 files / 0 errors; webapp `npm run build` exit 0; `caraGateWalk.test.ts` 3/3 green (onboarding-path photo_upload still advances to documents — the guard doesn't change onboarding behavior).

## 4. Work for the next agent (in order)

### 4.1 Deploy (functions + hosting)
- Full deploy per the standing protocol: deploy from `CareConnecxx-main` ONLY; **diff `functions/.env` VALUES (not just names) against live before deploying** (69 vars expected; empty-value regression = the JWT_SECRET incident); use ROOT `node_modules/.bin/firebase`; raise `FUNCTIONS_DISCOVERY_TIMEOUT`; commits authored as imran@angelicare.com.
- Both targets needed: functions (mirror + photo_upload guard) and hosting (read-side chains).
- Post-deploy probes: webhook endpoints 405, hosting 200.

### 4.2 Live E2E (the actual acceptance test)
- Imran logs into the webapp with 408-726-1330 → avatar must show in the top-nav menu and on `/caregiver/profile`. (Read-side fix alone makes this work — his doc already has `profilePhoto`/`photoURL`.)
- After he finishes onboarding: photo visible on client-facing surfaces (FindCaregivers card, profile modal, `/p/{id}` share page).
- Post-onboarding photo-update re-test: as an ACTIVE caregiver, text Evia to change photo, upload, confirm (a) new photo shows in webapp, (b) session step does NOT regress to `caregiver_send_documents`, (c) Evia sends the one-line confirmation.

### 4.3 Backfill existing Evia-onboarded caregivers (small, do with founder OK)
Docs written before this fix have `profilePhoto`/`photoURL` but no `photo`. The three patched components now tolerate that, but `photo`-only readers remain (e.g. `JobBoard.tsx:282`, `BookingFlow.tsx:826,1016`, `ClientDashboard.tsx:453` avatar chains, `Step2WhoWhere.tsx:457`). One-time backfill: for every `caregivers` doc where `photo` is missing and `profilePhoto` (or `photoURL`) is a string URL, set `photo` to it. Model on `scripts/backfill-applicant-count.mjs`; dry-run first.

### 4.4 Flagged findings — decisions needed, do NOT fix silently
- **Confidence-score fail-open:** `functions/src/agents/confidenceScore.ts:50` (and `matchingAgent.ts:535`) treat a MISSING `backgroundCheckStatus` as `"clear"`. Imran's doc got `confidenceScore: 35` + signal `"background check cleared"` stamped at FCRA-consent time, while the check is actually still pending. Not user-facing today (bookability is gated on `onboardingStatus === "profile_complete"` + `verificationStatus === "approved"`, `utils/caregiverEligibility.ts`), but the stored signal is false and would mislead admin/agent surfaces. Proposed: treat missing status as `"pending"` unless `verificationStatus === "approved"` (legacy docs predating the field are exactly the ones that were approved — verify that assumption before changing scoring).
- **`documents` shape mismatch:** Evia's mirror writes `documents: string[]` (bare URLs); the webapp types `documents?: CaregiverDocuments` (keyed objects: driversLicense/insurance/…, each `{url, status…}`), and `hasValidTransportDocs()` reads the keyed shape. SMS-uploaded certifications likely don't surface in the webapp's document/transport UI at all. Needs its own small parity design (which webapp slot do SMS docs map to? admin review status?). Not touched this session.
- **MVR add-on:** session has `wantsMvr: true` but `backgroundCheckData.mvrIncluded: false` and no `mvr_payment` in `processedWebhookTasks`. Verify the MVR add-on offer/payment actually fires at the intended point in the flow for this account.

### 4.5 Current account state (for the E2E tester)
Imran's number is parked at `caregiver_awaiting_bgcheck`: Checkr invitation created 07-09 12:28, completion link arrives by EMAIL from Checkr (imranzaved10@gmail.com). Remaining steps: Checkr form → clear → Stripe Connect payouts → finalization (`status: active`, `onboardingStatus: profile_complete`).

## 5. Constraints (standing, from CLAUDE.md + runbooks)
- Never re-add a pre-consent Checkr call; consent page is the only Checkr-invitation creator on the SMS path.
- Gate first-asks go through `generateCaraMessage` (fail-open to fallback copy, never emits URLs) — the new photo-update confirmation follows this pattern.
- No context-free intent classifiers; `parseWithClaude` for free-text meaning.
- `CARA_*` env names, `careconnex-d4c8b` project id, and internal Cara identifiers stay (rebrand is user-facing copy only).
