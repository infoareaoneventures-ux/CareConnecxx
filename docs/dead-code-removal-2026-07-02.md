# Dead code removal — 2026-07-02 (pre-release cleanup)

Import-graph analysis (TypeScript parser, BFS from `index.tsx`, `functions/src/index.ts`,
config files, `scripts/`, `ml/`, and all test entry points). A file is listed only if
**nothing** — app, functions, tooling, or tests — imports it, statically or dynamically.

**Backup:** every file below was copied to `d:\CareConnecxx-main (1)\removed-dead-code-backup-2026-07-02\`
(and `...zip`) before deletion. Restore = copy back into place.

## Verification notes

- `utils/performance.tsx` is a stale twin — the app resolves `./utils/performance` to
  `utils/performance.ts` (Vite prefers `.ts`), so the `.tsx` copy is shadowed and unused.
- The `components/ui/Card.tsx` / `ui/Motion.tsx` importers are all themselves dead files
  (a closed dead cluster: old dashboard/family components).
- Top-level `components/ClientDashboard.tsx`, `Chat.tsx`, `BookingModal.tsx`, etc. are the
  pre-domain-folder versions; canonical versions live in `components/client|caregiver/...`
  (matches the note in CLAUDE.md).
- `functions/src/migrations/fixAcceptedCounterPay.ts` — one-time migration; `index.ts:231`
  comment says "already executed — not exported".
- `functions/src/agents/onboardingShadowTap.ts` — shadow-mode tap retired after agent-loop
  went to 100%.
- `functions/lib/**` (compiled output) and `dist/` were **not** touched — regenerated on build.
- Kept (used only by tests, not deleted): `constants/caraCapabilities.ts`,
  `functions/src/agents/actionNative/caraActionRegistry.ts`, `.../toolCallJournal.ts`,
  `functions/src/data/contract.ts`, `functions/src/mcp/runTool.ts`, `services/mlModel.ts`,
  `services/trainingData.ts`, `utils/encryption.ts`.
- `functions/src/agents/launchActionParity.ts` mentions a few of these components in
  descriptive strings (docs-as-data) — not code references; several were already stale paths.

## Removed files (91)

### Frontend — legacy top-level components (superseded by domain folders)
- components/AiSearchAgent.tsx
- components/BookingModal.tsx
- components/CallSupport.tsx
- components/CancellationModal.tsx
- components/Chat.tsx
- components/ClientDashboard.tsx
- components/EmergencySOS.tsx
- components/InlineCaregiverCard.tsx
- components/LiveCareUpdates.tsx
- components/NotificationBell.tsx
- components/Review.tsx
- components/ReviewModal.tsx
- components/SimpleSearchWizard.tsx
- components/SupportModal.tsx
- components/VideoInterviewRoom.tsx
- components/index.ts (unused barrel)

### Frontend — unused domain components
- components/admin/FinanceDashboard.tsx
- components/ai/MLMatchInsights.tsx
- components/ai/MatchScoreBadge.tsx
- components/appointments/AppointmentWithReview.tsx
- components/caregiver/AvailabilityCalendar.tsx
- components/caregiver/CaregiverBookingRequests.tsx
- components/caregiver/CaregiverInterviewManager.tsx
- components/caregiver/CaregiverSchedule.tsx
- components/caregiver/DragSelectWeekGrid.tsx
- components/caregiver/EarningsPanel.tsx
- components/caregiver/GetRecommendationsSidebar.tsx
- components/caregiver/MyApplicationsList.tsx
- components/caregiver/OnboardingChecklist.tsx
- components/caregiver/RateSuggestion.tsx
- components/caregiver/RecognitionCenter.tsx
- components/caregiver/ShiftAssistant.tsx
- components/caregiver/ShiftCheckin.tsx
- components/caregiver/SkillsSelector.tsx
- components/caregiver/VideoUpdateUploader.tsx
- components/client/CareRequestConfirmModal.tsx
- components/client/CaregiverProfileModal.tsx (top-level version is the live one)
- components/client/CaregiverSearch.tsx
- components/client/ClientJobPostingWizard.tsx
- components/client/ClientMatchingView.tsx
- components/client/CompleteIntake.tsx
- components/client/IntakeModal.tsx
- components/client/PostJobModal.tsx
- components/dashboard/AiCommandCenter.tsx
- components/dashboard/AiJobMatchCard.tsx
- components/dashboard/CareCalendar.tsx
- components/dashboard/CaregiverAiPanel.tsx
- components/dashboard/DashboardHeader.tsx
- components/dashboard/InterviewHistory.tsx
- components/dashboard/MatchCarousel.tsx
- components/family/CareTeam.tsx
- components/family/MediaGallery.tsx
- components/family/PeaceOfMindScore.tsx
- components/family/SmartCarePlan.tsx
- components/family/WellnessScore.tsx
- components/landing/AffordabilitySection.tsx
- components/landing/HowItWorksSection.tsx
- components/landing/PricingComparisonSection.tsx
- components/landing/TrustStrip.tsx
- components/payroll/index.ts (unused barrel; payroll components themselves are live)
- components/referral/ReferralProgram.tsx
- components/shared/TrustBadge.tsx
- components/ui/Card.tsx
- components/ui/DocumentUpload.tsx
- components/ui/LocationInput.tsx
- components/ui/Motion.tsx
- components/ui/OptimizedImage.tsx

### Frontend — unused hooks/services/utils
- hooks/index.ts (unused barrel)
- hooks/useAiJobMatch.ts
- hooks/useAppointmentCarePlan.ts
- hooks/useBookingFlow.ts
- hooks/useMobileGestures.ts
- hooks/usePushNotifications.ts
- hooks/useSmartMatch.ts
- services/emailService.ts
- services/jobMatchService.ts
- services/matchTracking.ts
- services/mlMatchScoring.ts
- services/mlTraining.ts
- services/ratingService.ts
- utils/performance.tsx (shadowed by utils/performance.ts)

### Cloud Functions — unreferenced source
- functions/add-caregivers.js (old seed script)
- functions/aiMatching.js (stale root copy; live one is functions/src/aiMatching.ts)
- functions/src/agents/healthSignalDetector.ts
- functions/src/agents/onboardingShadowTap.ts
- functions/src/agents/seniorSelector.ts
- functions/src/agents/voiceSummary.ts
- functions/src/billing/visitBilling.ts
- functions/src/linq/subscriptions.ts
- functions/src/migrations/fixAcceptedCounterPay.ts

### Junk
- tsc_output.txt (stray compiler log at repo root)

## Post-deletion verification — results
1. `npm run build` (tsc --noEmit + vite build) — **PASS** (2088 modules, built in 1m10s)
2. `npm --prefix functions run build` — **PASS** (exit 0)
3. Vitest suite — **2017 passed / 3 failed** after cleanup-related test updates:
   - `tests/matchingStackWired.test.ts` — updated: its pinned mlMatchScoring "consumer"
     (top-level ClientDashboard) was itself unreachable from any route; test now
     tombstones the removed module and pins matchingEngine's live api.ts consumer. PASSES.
   - `tests/noDirectDbInComponents.test.ts` — removed the 7 deleted files from the
     KNOWN_OFFENDERS ratchet baseline (the ratchet shrank, as designed). PASSES.
   - `functions/src/agents/onboardingReplay.test.ts` — 3 failures are **pre-existing**:
     verified by restoring all 9 deleted functions files from backup and re-running;
     the same 3 tests fail identically with the files present. Unrelated to cleanup.

## Package changes
- Removed unused deps: `twilio-video`, `@stripe/react-stripe-js`, `framer-motion`
  (only consumers were deleted files). `package-lock.json` regenerated (30 packages pruned).
- Kept: `@tensorflow/tfjs` (used by test-only `services/mlModel.ts`), `qrcode` (QRCanvas),
  `@stripe/stripe-js` (stripeService).
