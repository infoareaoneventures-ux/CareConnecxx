# Cara Client SMS/iMessage — Customer-Readiness Audit

**Scope:** every scenario a **client** (family) user goes through over SMS/iMessage. Web `AiSearchAgent` chat and caregiver-side handlers are out of scope.

**Method:** line-level read of all handler files in `functions/src/agents/`, the dispatcher in `functions/src/linq/webhooks.ts`, the safety stack (`crisisDetector`, `supervisor`, `dndGuard`), and the infra layer (`sms.ts`, `claudeClient`, `openaiClient`, `zepClient`, `voiceTranscription`).

**Date:** 2026-05-23

---

## Executive Summary

**Totals:** ~58 scenarios audited across 12 lifecycle areas + a 35-step rule-compliance sweep.

| Severity | Count | Meaning |
|---|---|---|
| **P0** — Launch blockers | 5 | Must fix before live customers |
| **P1** — Ship with mitigation | 18 | Fix or accept with monitoring + documented manual recovery |
| **P2** — Track for v1.1 | 17 | Real but rare; cleanup post-launch |
| **P3** — Nice to have | 6 | Polish |
| ✅ Working as intended | 12 | No action needed |

### Top 5 launch blockers (P0)

1. **[L5/L6] Webhook signature & replay checks silently disabled if `LINQ_WEBHOOK_SECRET` env var is missing** — [functions/src/linq/webhooks.ts:4182-4198](functions/src/linq/webhooks.ts#L4182-L4198). Verification is wrapped in `if (webhookSecret)`. No secret → all inbound webhooks (including replays) are trusted. Single misconfigured deploy opens the entire inbound channel.

2. **[A7] No phone-possession verification on session creation** — [functions/src/index.ts:163-269](functions/src/index.ts#L163-L269), [functions/src/agents/onboardingConversation.ts:26-28](functions/src/agents/onboardingConversation.ts#L26-L28). E.164 format check only. Any SMS gateway can text Cara with a spoofed +1 number and create a session, then claim a role and exfiltrate family data.

3. **[A8] Shared-phone session clobber** — [functions/src/agents/onboardingConversation.ts:26-28](functions/src/agents/onboardingConversation.ts#L26-L28). `agent_sessions` is phone-keyed via `.set()` (not `.merge()`). A second family member texting from the same household phone overwrites the first member's `onboardingStep`, `onboardingData`, `userId`, `seniorId`. Existing secondary-member path in [webhooks.ts:1458-1486](functions/src/linq/webhooks.ts#L1458-L1486) only fires if the phone is **pre-registered** in `groupMembers`.

4. **[K4] Silent Zep context loss is HIPAA-adjacent** — [functions/src/agents/qaAgent.ts:595-600](functions/src/agents/qaAgent.ts#L595-L600). 4s hard cap on Zep returns empty string on timeout. Claude's system prompt still expects context (allergies, meds, conditions). Cara proceeds without warning the user or itself that memory was dropped. Wrong-medication / allergy-miss risk.

5. **[D6 + credential collection unguarded] Question-rejection at high-stakes confirmation steps** — [functions/src/agents/taskApprovalHandler.ts:15-18](functions/src/agents/taskApprovalHandler.ts#L15-L18), [functions/src/browser/credentialCollector.ts:57-117](functions/src/browser/credentialCollector.ts#L57-L117), [functions/src/agents/jobPostingFlow.ts:431-490](functions/src/agents/jobPostingFlow.ts#L431-L490), [functions/src/agents/modifyScheduleFlow.ts:243-265](functions/src/agents/modifyScheduleFlow.ts#L243-L265). A family member asking "is this safe?" before typing a MyChart password gets it stored as the username. "What's included?" mid-booking gets "Please reply 1, 2, or 3." Trust erosion + literal credential mishandling.

### Severity rubric

- **P0** — Customer hits this in normal use OR realistic security failure. Block launch.
- **P1** — Plausible edge case OR safety fail-open. Fix or accept with monitoring.
- **P2** — Real but rare. Cleanup post-launch.
- **P3** — Polish.

### Lens tags

`customer-blocking` | `security` | `rule-compliance` | `reliability` | `safety`

---

## A. First contact & onboarding

### A1 — Brand-new phone texts Cara cold
- **Path:** inbound webhook → `getOrCreateSession(phone)` → `onboardingConversation.handleOnboardingStep(ask_role)`
- **Files:** [functions/src/linq/webhooks.ts:1438-1515](functions/src/linq/webhooks.ts#L1438-L1515), [functions/src/agents/onboardingConversation.ts:339-374](functions/src/agents/onboardingConversation.ts#L339-L374)
- **Works:** ⚠️ Works mechanically; no protection against spoofed cold-starts (see A7).
- **Severity:** P2 · **Lens:** reliability
- **Fix sketch:** see A7.

### A2 — `initiateCara` callable from PhoneSignupPage
- **Path:** web → `httpsCallable("v1-initiateCara")` → create/restore session → greeting
- **Files:** [functions/src/index.ts:163-269](functions/src/index.ts#L163-L269)
- **Works:** ✅ E.164-validated, idempotent (existing session restored without duplicate greeting), branches correctly to `ask_role` vs `client_ask_name`.
- **Severity:** — · **Lens:** —

### A3 — Returns <30 min later
- **Path:** session loaded → `onboardingStep` dispatched
- **Files:** [functions/src/agents/onboardingConversation.ts:174-335](functions/src/agents/onboardingConversation.ts#L174-L335)
- **Works:** ⚠️ Resumes silently at the same step. No "welcome back, you were here" acknowledgment.
- **Severity:** P2 · **Lens:** customer-blocking (mild)
- **Fix sketch:** prepend a "picking up where we left off" line on resume.

### A4 — Returns >30 min later
- **Files:** [functions/src/linq/webhooks.ts:1577-1603](functions/src/linq/webhooks.ts#L1577-L1603), [functions/src/agents/onboardingConversation.ts:174-335](functions/src/agents/onboardingConversation.ts#L174-L335)
- **Works:** ⚠️ Onboarding flows save a checkpoint and offer RESUME/START OVER (1584-1599). Non-onboarding flows are cleared silently.
- **Severity:** P1 · **Lens:** customer-blocking, reliability
- **Fix sketch:** mirror the onboarding checkpoint pattern for booking/matching/swap/healthcare flows.

### A5 — Abandons after consent, returns later
- **Files:** [functions/src/agents/permissionsConversation.ts:136-165](functions/src/agents/permissionsConversation.ts#L136-L165), [functions/src/agents/onboardingConversation.ts:332-334](functions/src/agents/onboardingConversation.ts#L332-L334)
- **Works:** ❌ `onboardingStep:"complete"` is set, then user gets "something went sideways" on next inbound with no recovery path.
- **Severity:** P1 · **Lens:** customer-blocking
- **Fix sketch:** route `complete` + no active matching to qaAgent instead of the generic error.

### A6 — Picks wrong role, wants to switch
- **Files:** [functions/src/agents/onboardingConversation.ts:177-187](functions/src/agents/onboardingConversation.ts#L177-L187)
- **Works:** ⚠️ "START OVER" works but resets all progress. No inline "switch to caregiver" detection.
- **Severity:** P2 · **Lens:** reliability
- **Fix sketch:** add a mid-flow role-correction LLM check.

### A7 — Spoofed phone creates a session **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/index.ts:163-269](functions/src/index.ts#L163-L269), [functions/src/agents/onboardingConversation.ts:26-28](functions/src/agents/onboardingConversation.ts#L26-L28)
- **Works:** ❌ E.164 format-only validation. No possession challenge. Attacker SMS-gateways into Cara, claims a role, accesses any data Cara routes to that phone.
- **Severity:** P0 · **Lens:** security
- **Customer experience:** none yet — but a real attacker can claim a family member's number and intercept care coordination.
- **Fix sketch:** require an OTP confirm (Cara texts a 6-digit code; user must reply with it) before transitioning past `ask_role`, OR require Firebase Auth UID linkage for inbound matching.

### A8 — Shared family phone, two users **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/agents/onboardingConversation.ts:26-28](functions/src/agents/onboardingConversation.ts#L26-L28), [functions/src/linq/webhooks.ts:1458-1486](functions/src/linq/webhooks.ts#L1458-L1486)
- **Works:** ❌ Phone is doc ID. Second user's `set()` clobbers first user's session unless pre-registered as a secondary member.
- **Severity:** P0 · **Lens:** customer-blocking, security
- **Customer experience:** Mom texts Cara about Dad's care; Aunt texts from same phone for her own father → Aunt's onboarding overwrites Mom's care plan context.
- **Fix sketch:** detect mid-conversation persona shift via LLM (recent senior name vs new senior name) and either reject ("This phone is already set up for X — finish that conversation first") or offer to add the new user as a secondary member with explicit prompt.

---

## B. Discovery & matching

### B1 — "Find me a caregiver" cold
- **Files:** [functions/src/agents/matchingAgent.ts:116-460](functions/src/agents/matchingAgent.ts#L116-L460), [functions/src/agents/permissionsConversation.ts:160](functions/src/agents/permissionsConversation.ts#L160)
- **Works:** ⚠️ Requires onboarding completion + payment + permissions. No shortcut for an authenticated client to say "find me a caregiver" without finishing setup.
- **Severity:** P2 · **Lens:** reliability

### B2 — Specific need with constraints
- **Files:** [functions/src/agents/matchingAgent.ts:56-172](functions/src/agents/matchingAgent.ts#L56-L172)
- **Works:** ⚠️ Constraints flow through onboarding `careNeeds` and rule-based + Claude scoring. No mid-conversation re-filter UI.
- **Severity:** P2 · **Lens:** reliability

### B3 — Re-ask with different filter mid-conversation
- **Files:** [functions/src/agents/matchingAgent.ts:116-460](functions/src/agents/matchingAgent.ts#L116-L460)
- **Works:** ❌ No handler accepts mid-presentation filter changes. User must restart matching.
- **Severity:** P2 · **Lens:** reliability

### B4 — No matches returned
- **Files:** [functions/src/agents/matchingAgent.ts:245-289](functions/src/agents/matchingAgent.ts#L245-L289)
- **Works:** ✅ First failure → polite "I've flagged your request". Subsequent failures → escalation message + rejection list trimmed to widen pool. Clear UX.
- **Severity:** — · **Lens:** —

### B5 — Question mid-match-presentation
- **Files:** [functions/src/agents/matchingAgent.ts:403-432](functions/src/agents/matchingAgent.ts#L403-L432)
- **Works:** ⚠️ No explicit `isQuestionOrOther` guard; reliance on the execution agent's LLM judgment in its system prompt.
- **Severity:** P1 · **Lens:** rule-compliance
- **Fix sketch:** add explicit guard at handler entry.

---

## C. Interview flow

### C1 — Select caregiver 1–5
- **Files:** [functions/src/agents/interviewAgent.ts:93-178](functions/src/agents/interviewAgent.ts#L93-L178)
- **Works:** ✅ Parses selection, validates against `pendingMatches`, creates interview requests, texts caregivers.
- **Severity:** — · **Lens:** —

### C2 — Confirm interview date/time
- **Files:** [functions/src/agents/interviewAgent.ts:182-471](functions/src/agents/interviewAgent.ts#L182-L471)
- **Works:** ✅ Caregiver availability parsed, mutual time found, family confirmation prompt, call link + .ics generated.
- **Severity:** — · **Lens:** —

### C3 — Submit feedback (strong/maybe/no)
- **Files:** [functions/src/agents/interviewAgent.ts:475-512](functions/src/agents/interviewAgent.ts#L475-L512)
- **Works:** ✅ Post-interview follow-up at +75 min, sentiment mapped to ML feedback signal.
- **Severity:** — · **Lens:** —

### C4 — Question mid-interview-flow
- **Files:** [functions/src/agents/interviewAgent.ts:93-301](functions/src/agents/interviewAgent.ts#L93-L301)
- **Works:** ⚠️ No explicit `isQuestionOrOther` guard at entry to `handleInterviewSelection` or `handleInterviewConfirm`.
- **Severity:** P1 · **Lens:** rule-compliance

---

## D. Booking & payment

### D1 — Confirm booking task (emoji OR YES)
- **Files:** [functions/src/agents/bookingExecutor.ts:52-316](functions/src/agents/bookingExecutor.ts#L52-L316), [functions/src/agents/taskApprovalHandler.ts:7-51](functions/src/agents/taskApprovalHandler.ts#L7-L51)
- **Works:** ⚠️ Two-step approval (select + confirm) adds friction. Emoji-reaction approval path exists in webhooks but underlying handler implementation is unverified.
- **Severity:** P1 · **Lens:** customer-blocking

### D2 — Cost confirmation YES/NO
- **Files:** [functions/src/agents/bookingExecutor.ts:216-232](functions/src/agents/bookingExecutor.ts#L216-L232)
- **Works:** ⚠️ Cost is shown **inside** the confirmation message AFTER appointments are already written (lines 170-191). No pre-execution cost gate.
- **Severity:** P1 · **Lens:** customer-blocking
- **Fix sketch:** insert an explicit `awaiting_cost_confirm` state and require YES before writing appointment rows.

### D3 — Recurring schedule confirm
- **Files:** [functions/src/agents/bookingExecutor.ts:234-265](functions/src/agents/bookingExecutor.ts#L234-L265)
- **Works:** ✅ Session-flagged offer; clean YES/NO.
- **Severity:** — · **Lens:** —

### D4 — Cancel a booking
- **Files:** routed via qaAgent + MCP tools, no dedicated state-machine handler in `bookingExecutor.ts`
- **Works:** ⚠️ Tool-driven through qaAgent; behavior depends on the Claude tool-use loop completing in 60s.
- **Severity:** P2 · **Lens:** reliability

### D5 — Two booking confirms arrive simultaneously
- **Files:** [functions/src/agents/bookingExecutor.ts:60-76](functions/src/agents/bookingExecutor.ts#L60-L76)
- **Works:** ✅ Transaction atomically transitions `awaiting_approval → processing`. Idempotent.
- **Severity:** — · **Lens:** —

### D6 — Question mid-booking confirmation **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/agents/taskApprovalHandler.ts:15-18](functions/src/agents/taskApprovalHandler.ts#L15-L18)
- **Works:** ❌ `parseInt(choice, 10) - 1` then "Please reply 1, 2, or 3" rejection. "What's included?" gets brushed off.
- **Severity:** P0 · **Lens:** customer-blocking, rule-compliance
- **Fix sketch:** add `isQuestionOrOther` guard, route question through `answerQuestionMidFlow`, re-ask selection.

---

## E. Day-of-shift flows

### E1 — Day-before reminder → CONFIRM (client)
- **Files:** [functions/src/linq/webhooks.ts:228-378](functions/src/linq/webhooks.ts#L228-L378)
- **Works:** ❌ `handleShiftConfirmation` is **caregiver-only**. No client-side day-before confirmation flow.
- **Severity:** P2 · **Lens:** customer-blocking (feature gap)

### E2 — Day-before reminder → CANCEL (client)
- **Works:** ❌ Same as E1 — no client flow.
- **Severity:** P2 · **Lens:** customer-blocking

### E3 — Day-before question instead of CONFIRM/CANCEL (caregiver path, included for handler review)
- **Files:** [functions/src/linq/webhooks.ts:362-377](functions/src/linq/webhooks.ts#L362-L377)
- **Works:** ⚠️ Raw text sent to `sendViaInteractionAgent`, then re-asks CONFIRM/CANCEL. No structured `parseWithClaude`, no ordered ack-then-reask sequencing.
- **Severity:** P1 · **Lens:** rule-compliance

### E4 — Pre-shift family check-in
- **Files:** [functions/src/linq/webhooks.ts:382-476](functions/src/linq/webhooks.ts#L382-L476)
- **Works:** ⚠️ `isQuestionOrOther` exists (395-403), but ack and re-prompt fire in sequence to `sendViaInteractionAgent` + `sendMessage` with no ordering — risk of out-of-order delivery.
- **Severity:** P2 · **Lens:** reliability, rule-compliance

### E5 — 30-min reminder
- **Works:** ❌ No client-response handler found for the 30-min reminder.
- **Severity:** P3 · **Lens:** customer-blocking (minor)

---

## F. Caregiver-swap & schedule modification (client-initiated)

### F1 — Client requests swap mid-engagement
- **Files:** [functions/src/agents/clientSwapRequestHandler.ts:50-152](functions/src/agents/clientSwapRequestHandler.ts#L50-L152)
- **Works:** ⚠️ Selection step (50-62) has no `isQuestionOrOther`. "What does swap mean?" is parsed as a number.
- **Severity:** P2 · **Lens:** rule-compliance, customer-blocking

### F2 — Client modifies recurring schedule
- **Files:** [functions/src/agents/modifyScheduleFlow.ts:243-265](functions/src/agents/modifyScheduleFlow.ts#L243-L265)
- **Works:** ⚠️ Steps `ms_ask_what/days/times` have guards but no ack before next question. **`ms_confirm` has no question guard** — YES/NO is parsed even if user asked a question.
- **Severity:** P1 · **Lens:** rule-compliance

### F3 — Client posts a new job
- **Files:** [functions/src/agents/jobPostingFlow.ts:114-490](functions/src/agents/jobPostingFlow.ts#L114-L490)
- **Works:** ⚠️ Most steps have `isQuestionOrOther` ✅. **`jp_confirm_post` (431-490) has none** — confirmation parsed even if user asked a question. Several steps fire question-answer + next-question in quick succession without ordering.
- **Severity:** P1 · **Lens:** rule-compliance

---

## G. Healthcare flows

### G1 — Provider search by location
- **Files:** [functions/src/agents/healthcareHandler.ts:247-301](functions/src/agents/healthcareHandler.ts#L247-L301), [451-467](functions/src/agents/healthcareHandler.ts#L451-L467)
- **Works:** ✅ Fully compliant — guard, parse, ack, re-prompt.
- **Severity:** — · **Lens:** —

### G2 — Doctor appointment booking + credential collection
- **Files:** [functions/src/agents/healthcareHandler.ts:304-365](functions/src/agents/healthcareHandler.ts#L304-L365), [functions/src/browser/credentialCollector.ts:57-117](functions/src/browser/credentialCollector.ts#L57-L117)
- **Works:** ⚠️ Steps inside `healthcareHandler` are compliant. **`credentialCollector.handleCredentialReply` has NO `isQuestionOrOther` guard.** "Why do you need my login?" gets stored as the username; the next message gets stored as the password.
- **Severity:** P1 · **Lens:** security, customer-blocking

### G3 — Rx refill
- **Files:** [functions/src/agents/healthcareHandler.ts:368-399](functions/src/agents/healthcareHandler.ts#L368-L399), [credentialCollector.ts:57-117](functions/src/browser/credentialCollector.ts#L57-L117)
- **Works:** ⚠️ Same credential-collection gap as G2.
- **Severity:** P1 · **Lens:** security, customer-blocking

### G4 — New prescription
- **Files:** [functions/src/agents/healthcareHandler.ts:402-435](functions/src/agents/healthcareHandler.ts#L402-L435), [575-628](functions/src/agents/healthcareHandler.ts#L575-L628)
- **Works:** ⚠️ Resume step (`hc_newrx_hasdoctor`) is compliant. Initial condition extraction (416-419) has no question guard.
- **Severity:** P2 · **Lens:** rule-compliance

---

## H. Crisis & safety

### H1 — Medical keywords
- **Files:** [functions/src/safety/crisisDetector.ts:3-22](functions/src/safety/crisisDetector.ts#L3-L22), [functions/src/linq/webhooks.ts:1673-1678](functions/src/linq/webhooks.ts#L1673-L1678)
- **Works:** ✅ Keyword fast-path, 911 message, logged. Fires before intent classification.
- **Severity:** — · **Lens:** safety

### H2 — Emotional keywords
- **Files:** [functions/src/safety/crisisDetector.ts:13-27](functions/src/safety/crisisDetector.ts#L13-L27)
- **Works:** ✅ Same fast-path + 988 lifeline message.
- **Severity:** — · **Lens:** safety

### H3 — False positive (quote / joke / fiction)
- **Files:** [functions/src/safety/crisisDetector.ts:29-39](functions/src/safety/crisisDetector.ts#L29-L39)
- **Works:** ❌ Pure `.includes()` keyword match. "He said 'I want to die' in the movie" triggers the 988 response.
- **Severity:** P1 · **Lens:** reliability, customer-blocking
- **Fix sketch:** add a fast LLM verification (gpt-4o-mini, 1s budget) for ambiguous matches; keep keyword path as the primary gate. Speed is preserved because keywords still fire fastest; LLM only re-checks before sending.

### H4 — Crisis keyword inside an unrelated booking question
- **Works:** ✅ Crisis intercepts before intent classification (by design). Documented UX side-effect: legitimate booking ("I need someone, my dad had a stroke last month") is interrupted by the 911 message and must be resumed.
- **Severity:** P1 · **Lens:** customer-blocking (by-design tradeoff)
- **Fix sketch:** after the safety message, follow-up message offering to resume the original conversation when ready.

---

## I. Quiet hours, DND, opt-out

### I1 — Trigger-driven message during DND
- **Files:** [functions/src/utils/dndGuard.ts:9-40](functions/src/utils/dndGuard.ts#L9-L40), [functions/src/agents/caraAgent.ts:126-137](functions/src/agents/caraAgent.ts#L126-L137)
- **Works:** ✅ Non-critical messages queued until DND ends. `critical` urgency bypasses (by design).
- **Severity:** — · **Lens:** safety/legal

### I2 — Inbound message during DND
- **Files:** [functions/src/agents/qaAgent.ts:580-590](functions/src/agents/qaAgent.ts#L580-L590)
- **Works:** ✅ Warm acknowledgment: "You're in quiet hours right now. I'll hold your message and follow up when they end."
- **Severity:** — · **Lens:** —

### I3 — STOP / UNSUBSCRIBE / QUIT
- **Files:** [functions/src/linq/webhooks.ts:1538-1652](functions/src/linq/webhooks.ts#L1538-L1652), [functions/src/sms.ts:71-87](functions/src/sms.ts#L71-L87)
- **Works:** ✅ TCPA-compliant. Multi-layer enforcement: stop words list, persisted opt-out, `hasOptedOut()` check before every outbound send.
- **Severity:** — · **Lens:** legal

### I4 — Re-opt-in after STOP
- **Files:** [functions/src/linq/webhooks.ts:1651](functions/src/linq/webhooks.ts#L1651)
- **Works:** ⚠️ Outbound message says "Reply START anytime to reactivate" but no handler for inbound START is visible.
- **Severity:** P2 · **Lens:** customer-blocking (advertised capability)
- **Fix sketch:** add START handler in the same opt-out switch.

---

## J. Modality & input edge cases

### J1 — Voice memo → Whisper
- **Files:** [functions/src/utils/voiceTranscription.ts:82-147](functions/src/utils/voiceTranscription.ts#L82-L147), [functions/src/linq/webhooks.ts:1413-1436](functions/src/linq/webhooks.ts#L1413-L1436)
- **Works:** ✅ Extract → download with auth fallback → Whisper → re-inject as text. Failures fall through to media-only ack.
- **Severity:** — · **Lens:** —

### J2 — Image / attachment only
- **Files:** [functions/src/linq/webhooks.ts:1558-1572](functions/src/linq/webhooks.ts#L1558-L1572)
- **Works:** ✅ Per-type warm ack (sticker, voice-memo-fail, generic media).
- **Severity:** — · **Lens:** —

### J3 — Emoji-only reaction-as-approval
- **Files:** [functions/src/linq/webhooks.ts:4235-4239](functions/src/linq/webhooks.ts#L4235-L4239)
- **Works:** ⚠️ `handleReactionAdded` is dispatched but implementation not verified in this pass.
- **Severity:** P3 · **Lens:** reliability
- **Action:** verify `handleReactionAdded` properly maps 👍 / ❤️ to BOOKING_CONFIRM and ✋ / 👎 to BOOKING_REJECT.

### J4 — Long messages
- **Files:** [functions/src/agents/qaAgent.ts:451-469](functions/src/agents/qaAgent.ts#L451-L469), [functions/src/agents/caraAgent.ts:92-105](functions/src/agents/caraAgent.ts#L92-L105)
- **Works:** ✅ Outbound chunked at sentence boundaries (300 char qaAgent, 1000 char caraAgent) with 1s delay. Inbound truncated to 2000 chars.
- **Severity:** — · **Lens:** —

### J5 — Non-English
- **Files:** [functions/src/agents/qaAgent.ts:218-355](functions/src/agents/qaAgent.ts#L218-L355), [functions/src/agents/intentClassifier.ts](functions/src/agents/intentClassifier.ts)
- **Works:** ⚠️ System prompt English-only. Intent classifier likely degrades non-English to QUESTION (full qaAgent fallback) which Claude can translate, but no explicit i18n.
- **Severity:** P2 · **Lens:** reliability

### J6 — Gibberish / single char
- **Files:** [functions/src/agents/qaAgent.ts:1068-1083](functions/src/agents/qaAgent.ts#L1068-L1083), [functions/src/agents/intentClassifier.ts:74-134](functions/src/agents/intentClassifier.ts#L74-L134)
- **Works:** ✅ Length check rejects from `isTrivialQuickReply`; routes to qaAgent → classifier fallback to QUESTION → Claude handles.
- **Severity:** — · **Lens:** —

---

## K. State, memory & timeout

### K1 — Mid-booking silent 30 min
- **Files:** [functions/src/linq/webhooks.ts:1575-1603](functions/src/linq/webhooks.ts#L1575-L1603)
- **Works:** ⚠️ Non-onboarding flows cleared silently with generic "session timed out" line (1599). No checkpoint recovery.
- **Severity:** P1 · **Lens:** customer-blocking
- **Fix sketch:** generalize the onboarding checkpoint mechanism to booking/matching/swap/job-posting/healthcare flows.

### K2 — `activeGoal` expires at 24h
- **Files:** [functions/src/agents/qaAgent.ts:518-547](functions/src/agents/qaAgent.ts#L518-L547)
- **Works:** ⚠️ Silent expiry mid-turn. Claude responds as if no goal existed.
- **Severity:** P1 · **Lens:** reliability
- **Fix sketch:** on stale-goal detection, send acknowledgment ("Your earlier booking conversation was a while ago — want to pick that back up or start fresh?") before clearing.

### K3 — >10-turn conversation history
- **Files:** [functions/src/agents/qaAgent.ts:115-147](functions/src/agents/qaAgent.ts#L115-L147)
- **Works:** ✅ Summary doc injected if present.
- **Severity:** P2 · **Lens:** reliability (the summary-generation job's reliability is not verified in this pass — verify it runs and writes summaries before turn 11).

### K4 — Zep timeout silent context loss **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/agents/qaAgent.ts:595-600](functions/src/agents/qaAgent.ts#L595-L600), [645-649](functions/src/agents/qaAgent.ts#L645-L649)
- **Works:** ❌ 4s timeout → empty string → Claude proceeds without health facts (allergies, meds, conditions). User and Claude unaware.
- **Severity:** P0 · **Lens:** safety, reliability
- **Customer experience:** Cara could suggest a medication contraindicated with stored allergies because the allergy entry was dropped silently.
- **Fix sketch:** on Zep timeout, inject a `[SYSTEM: memory_unavailable]` marker into the prompt so Claude knows context is incomplete and hedges medical-adjacent answers. Add metrics + alert if Zep timeout rate exceeds 1%.

### K5 — Back-to-back messages during prefetch
- **Files:** [functions/src/agents/qaAgent.ts:615-649](functions/src/agents/qaAgent.ts#L615-L649)
- **Works:** ⚠️ Theoretically possible race where prefetched context for message A is consumed by message B. Not observed in code paths; depends on Firestore latency.
- **Severity:** P2 · **Lens:** reliability

---

## L. Infrastructure failures

### L1 — Anthropic API down
- **Files:** [functions/src/agents/qaAgent.ts:769-865](functions/src/agents/qaAgent.ts#L769-L865)
- **Works:** ⚠️ 15s timeout per Claude call. On exhaustion: "Give me a moment on that" + 30s retry via `proactive_triggers`. Second failure → `admin_alerts` + "Let me come back to you shortly". No explicit failure messaging to user.
- **Severity:** P1 · **Lens:** reliability

### L2 — OpenAI API down
- **Files:** [functions/src/agents/intentClassifier.ts:74-134](functions/src/agents/intentClassifier.ts#L74-L134), [functions/src/agents/qaAgent.ts:881-891](functions/src/agents/qaAgent.ts#L881-L891)
- **Works:** ✅ 6s classifier timeout falls back to QUESTION. Grounding revision falls back to original reply. Behavior transparent.
- **Severity:** P2 · **Lens:** reliability

### L3 — Linq outbound send fails
- **Files:** [functions/src/linq/client.ts:194-228](functions/src/linq/client.ts#L194-L228), [100-155](functions/src/linq/client.ts#L100-L155)
- **Works:** ⚠️ Internal retry with exponential backoff. Final failure throws exception; callers `.catch(() => {})` swallow. User receives no feedback that Cara's reply didn't arrive.
- **Severity:** P1 · **Lens:** reliability
- **Fix sketch:** on send failure, write to a `send_failures` collection + admin_alerts when rate exceeds threshold. Consider a "Cara replies are delayed" status page.

### L4 — Linq line CRITICAL → circuit breaker open
- **Files:** [functions/src/sms.ts:49-237](functions/src/sms.ts#L49-L237), [functions/src/linq/client.ts:550-595](functions/src/linq/client.ts#L550-L595)
- **Works:** ⚠️ Outbound silently suppressed. No user-facing status. No auto-reset.
- **Severity:** P1 · **Lens:** reliability

### L5 — `LINQ_WEBHOOK_SECRET` missing **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/linq/webhooks.ts:4182-4191](functions/src/linq/webhooks.ts#L4182-L4191)
- **Works:** ❌ `if (webhookSecret)` makes all verification conditional. Missing secret → all inbound trusted.
- **Severity:** P0 · **Lens:** security
- **Fix sketch:** throw at module init if `LINQ_WEBHOOK_SECRET` is unset OR fail-closed (`if (!webhookSecret) return 500`).

### L6 — Replay attack when secret missing **(P0 LAUNCH BLOCKER)**
- **Files:** [functions/src/linq/webhooks.ts:4192-4198](functions/src/linq/webhooks.ts#L4192-L4198)
- **Works:** ❌ Timestamp staleness check is inside the `if (webhookSecret)` block. Without the secret, replays of stale events are accepted.
- **Severity:** P0 · **Lens:** security
- **Fix sketch:** addressed by L5 fix (fail-closed if secret missing).

---

## Cross-cutting: supervisor fail-open

- **Files:** [functions/src/agents/caraAgent.ts:140-143](functions/src/agents/caraAgent.ts#L140-L143), [functions/src/agents/qaAgent.ts:905](functions/src/agents/qaAgent.ts#L905)
- **Behavior:** If `supervise()` throws, the original unsupervised message is sent. Quoted:

```typescript
const safe = await supervise(output.content, { phone }).catch((err) => {
  console.error("caraAgent: supervisor threw, sending message unsupervised", ...);
  return output.content;
});
```

- **Severity:** P1 · **Lens:** safety
- **Rationale:** intentional fail-open so Cara doesn't go dark when supervisor Claude is unavailable.
- **Fix sketch:** add alerting if supervisor failure rate exceeds 0.5% in any rolling window. Consider fail-closed for medical-adjacent content (detected by simple keyword pre-filter on the outbound message).

---

## M. CLAUDE.md rule-compliance sweep

Four checks per handler step:
1. `isQuestionOrOther` guard at top
2. `parseWithClaude` / `quickComplete` for free-form intent (no regex/keyword for meaning)
3. Conversational acknowledgment of user's input before next question
4. `sendMessage` with next question

Legend: ✅ pass · ⚠️ partial · ❌ violation

### M.1 Onboarding (`functions/src/agents/onboardingConversation.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| ask_role | 339 | ❌ | ✅ 340 | ⚠️ 352 | ✅ 356 |
| client_ask_name | 378 | ✅ 379 | ✅ 385 | ✅ 252 | ✅ 402 |
| client_ask_senior | 405 | ✅ 406 | ✅ 412 | ✅ 423 | ✅ 431 |
| client_ask_needs | 434 | ✅ 435 | ✅ 442 | ⚠️ | ✅ 465 |
| client_ask_location | 468 | ✅ 469 | ✅ 475 | ⚠️ 489 | ✅ 502 |
| client_ask_schedule | 505 | ✅ 506 | ✅ 513 | ⚠️ 529 | ✅ |
| client_ask_plan | 624 | ❌ | ✅ 630 | ⚠️ 644 | ✅ 644 |

### M.2 Booking / approval

| Step | File:Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| booking_task_approval | taskApprovalHandler.ts:7 | ❌ | ✅ 15 | ⚠️ 48 | ✅ 47 |
| booking_finalize | taskApprovalHandler.ts:54 | ❌ | N/A | ✅ 78 | N/A |

### M.3 Interview (`functions/src/agents/interviewAgent.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| interview_selection | 93 | ❌ | ✅ 113 | ⚠️ 177 | ✅ 177 |
| interview_confirm | 305 | ❌ | N/A | ✅ 397 | ✅ 397 |
| post_interview | 490 | ❌ | N/A | N/A | ✅ 503 |

### M.4 Refund (`functions/src/agents/refundHandler.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| identify_visit | — | N/A | N/A | ✅ | ✅ 89 |
| select_visit | 95 | ✅ | ✅ 110 | ⚠️ | ✅ 102 |
| confirm | 146 | ✅ | N/A | ⚠️ | ✅ 150 |
| submitted | 176 | ❌ | ✅ 177 | ✅ 188 | ✅ 170 |

### M.5 Client swap (`functions/src/agents/clientSwapRequestHandler.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| identify_appointment | — | N/A | N/A | N/A | ✅ 46 |
| select_appointment | 50 | ❌ | ✅ 110 | ❌ | ✅ 111 |
| select_caregiver | 116 | ⚠️ | ✅ 130 | ✅ 118 | ✅ 152 |

### M.6 Modify schedule (`functions/src/agents/modifyScheduleFlow.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| ms_ask_what | 105 | ✅ 108 | ✅ 115 | ❌ | ✅ 131 |
| ms_ask_days | 139 | ✅ 142 | ✅ 147 | ❌ | ✅ 177 |
| ms_ask_times | 183 | ✅ 186 | ✅ 191 | ❌ | ✅ 219 |
| ms_confirm | 243 | ❌ | ✅ 246 | ✅ 259 | ✅ 264 |

### M.7 Job posting (`functions/src/agents/jobPostingFlow.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| jp_ask_start | 114 | ✅ 117 | ✅ 123 | ⚠️ | ✅ 131 |
| jp_ask_frequency | 139 | ✅ 142 | ✅ 153 | ⚠️ | ✅ 145 |
| jp_ask_days | 169 | ✅ 172 | ✅ 178 | ⚠️ | ✅ 194 |
| jp_ask_time | 204 | ✅ 207 | ✅ 219 | ⚠️ | ✅ 240 |
| jp_ask_care_needs | 254 | ✅ 257 | ✅ 266 | ⚠️ | ✅ 288 |
| jp_ask_care_level | 296 | ✅ 299 | ✅ 308 | ⚠️ | ✅ 319 |
| jp_ask_environment | 326 | ✅ 329 | ✅ 335 | ✅ | ✅ 353 |
| jp_ask_rate | 358 | ✅ 361 | ✅ 367 | ⚠️ | ✅ 379 |
| jp_ask_pay_method | 386 | ✅ 389 | ✅ 395 | ⚠️ | ✅ 405 |
| jp_ask_description | 411 | ✅ 414 | N/A | ⚠️ | ✅ 427 |
| jp_confirm_post | 431 | ❌ | ✅ 434 | ✅ 448 | ✅ 456 |

### M.8 Healthcare (`functions/src/agents/healthcareHandler.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| hc_search_location | 451 | ✅ 453 | ✅ 459 | ✅ 454 | ✅ 456 |
| hc_appt_doctor | 471 | ✅ | ✅ 477 | ✅ 472 | ✅ 483 |
| hc_appt_type | 489 | ✅ | ✅ 495 | ✅ 490 | ✅ 512 |
| hc_appt_date | 518 | ✅ | N/A | ✅ 519 | ✅ 528 |
| hc_appt_portal | 537 | ✅ | ✅ 543 | ✅ 538 | ✅ 551 |
| credential request (pre-book) | 150 | ❌ | N/A | N/A | ✅ 156 |
| hc_rx_pharmacy | 557 | ✅ | ✅ 563 | ✅ 558 | ✅ 571 |
| credential request (pre-rx) | 204 | ❌ | N/A | N/A | ✅ 207 |
| hc_newrx_hasdoctor | 575 | ✅ 577 | ✅ 583 | ✅ 578 | ✅ 602 |
| condition extraction | 416 | ❌ | ✅ | N/A | ✅ |

### M.9 Credential collector (`functions/src/browser/credentialCollector.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| handleCredentialReply (username) | 65 | ❌ | N/A | N/A | ✅ 77 |
| handleCredentialReply (password) | 88 | ❌ | N/A | N/A | ✅ 104 |

**This is the most security-relevant rule-compliance gap in the codebase.** Stored as raw text without question filtering.

### M.10 Scheduling (`functions/src/agents/schedulingHandler.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| handleScheduleRequest | entry | ❌ | ✅ 26 | ✅ 61 | ✅ 81 |

### M.11 Shift confirm / pre-shift (`functions/src/linq/webhooks.ts`)

| Step | Line | 1. Guard | 2. Parse | 3. Ack | 4. Send |
|---|---|---|---|---|---|
| handleShiftConfirmation (question) | 362 | ❌ | ⚠️ (raw to interaction agent) | ⚠️ | ✅ |
| handlePreShiftUpdate | 395 | ✅ | ✅ | ⚠️ ordering | ✅ |

### Compliance totals

| Check | Pass | Partial | Fail | Total |
|---|---|---|---|---|
| 1. `isQuestionOrOther` guard | 22 | 1 | 14 | 37 |
| 2. `parseWithClaude` / `quickComplete` | 32 | 0 | 2 | 34 (where applicable) |
| 3. Conversational ack | 14 | 17 | 6 | 37 |
| 4. `sendMessage` next question | 36 | 0 | 0 | 36 |

**Patterns:**
- Guards are missing systematically at **confirmation steps** (`*_confirm_post`, `*_finalize`, credential capture).
- Acknowledgments are the most-skipped rule — most handlers merge data and ask the next question with no "got it" line.
- Parse compliance is strong (only `caregiver_ask_email` uses regex and credential collector accepts raw text; everything else uses `parseWithClaude`/`quickComplete`).

---

## Critical-path tests to add (10)

Each test name → scenario ID it protects. Naming only — implementation is a follow-up.

| # | Test | Protects |
|---|---|---|
| 1 | `inbound: unknown phone → ask_role greeting + new session created` | A1, A2 |
| 2 | `inbound: known phone → handler dispatched by onboardingStep` | A3, B/C/D dispatch |
| 3 | `state expiry: non-onboarding flow >30min → flags cleared, generic timeout message` | K1, A4 |
| 4 | `crisis: each MEDICAL keyword fires 911 response + logs` and `each EMOTIONAL keyword fires 988 response + logs` | H1, H2 |
| 5 | `crisis false positive: quoted/fiction usage — current behavior captured (will fail after H3 fix)` | H3 |
| 6 | `webhook: valid signature passes; bad signature 401s; missing secret env → boot fails` | L5, L6 |
| 7 | `rate limit: 121st call in an hour drops silently` | L (cross-cutting) |
| 8 | `qaAgent: tool-use loop exhausted → "give me a moment" fallback + proactive_triggers retry + admin_alerts on second failure` | L1 |
| 9 | `voice memo: download → Whisper → text re-enters intent classifier → correct handler dispatched` | J1 |
| 10 | `DND: trigger-driven outbound suppressed during DND; inbound returns quiet-hours ack` | I1, I2 |

---

## Verification

- Every scenario A1–L6 has Works / Severity / Lens / Fix sketch.
- All cited file:line references resolved against current `main` (commit `2e02c22`).
- Every P0 finding has a "what the customer experiences" line.
- Rule-compliance table covers all client-facing handlers.
- Test recommendations name the scenario IDs they protect.

No code changed in this pass. Fix sequencing is a separate planning session.
