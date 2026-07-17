# Evia platform-wide hallucination audit — 2026-07-17

Triggered by the live "Marcus" incident (Hamse, caregiver onboarding): Evia invented a client
name, leaked a raw meta-response ("I need the briefing context to write this message…"), then
denied ever saying it. Four parallel audits covered: (1) every raw-LLM-output-to-user path,
(2) all 253 `generateCaraMessage` call sites, (3) fact grounding in prompts, (4) amnesia surfaces.

## Root-cause chain of the incident

1. "Not at the moment" → MVR classifier scored `unclear` → re-ask via `generateCaraMessage`
   (`onboardingConversation.ts:2653`). Voice prompt commands "Be concrete — real names…" with a
   name-free briefing → Haiku invented "Marcus's intake".
2. "Who is Marcus's" → second `unclear` → default-no message (`:2663`) → Haiku replied to the
   briefing author instead of writing the message; `generateCaraMessage` has no output guard
   (fallback fires only on API error/empty) → meta-response sent verbatim, cut off at 60 tokens.
3. Scripted-flow sends are never written to `agent_conversations` (only `saveConversationTurn`
   in qaAgent writes it) → agent had no record of the Marcus message → "I haven't mentioned
   anything about Marcus."

## TIER 1 — Systemic fixes (each closes a whole class)

### T1.1 Anti-invention clause in both voice prompts — covers all 253 call sites
`functions/src/utils/caraMessage.ts:4-38` (CAREGIVER_VOICE + FAMILY_VOICE). "Be concrete — real
names…" actively pressures confabulation when the briefing has no name. Add:
"Use ONLY names, dates, times, and amounts that appear in this briefing. If a specific name or
number is not in the briefing, refer generically ('your visit', 'the caregiver') — NEVER invent one."
Template already in-repo: `onboardingConversation.ts:2481`, `inShiftUpdate.ts:107`, `carePlanInterview.ts:531`.
Same clause needed in the direct `messages.create` generators: `scheduled/morningBriefing.ts:107`,
`scheduled/weeklyDigest.ts:58`, `triggers/triggerEngine.ts:117`, `agents/jobPostingFlow.ts:60/82`.

### T1.2 Output guard in `generateCaraMessage` — meta-response leak
`utils/caraMessage.ts:64-74`. Guard model OUTPUT (ours, not user input — no-regex rule doesn't
apply): if output references the briefing/transcript, asks "who's the caregiver", asks for context,
or contains a URL → return `opts.fallback` (every one of the 253 sites ships one). Log a counter.

### T1.3 Outbound history recording at the transport choke point — kills amnesia everywhere
`linq/client.ts:574` `sendMessageDeliver`, sibling to the existing `mirrorToWebThread` block
(:586-598, which is the working template — resolves phone via `agent_sessions where chatId==X`,
5-min TTL cache in `threadMirror.resolveUserIds`). Write `{role:"assistant", content, timestamp}`
to `agent_conversations/{phone}/messages` (schema of `saveConversationTurn`, qaAgent.ts:231).
Required guards:
- QA-loop sends must skip (already saved by `saveConversationTurn`) — new `opts.skipHistoryRecord`
  or reuse `SendOptions.source`.
- Record once per logical message (not per split bubble) using the already-computed mirror text.
- Skip filler ("On it — one sec…", `signalThinking` client.ts:795), typing, attachment-only parts.
- Pre-session sends have no phone mapping — acceptable (precede any QA turn), same as mirror.
Coverage today: onboardingConversation (163 send sites), matchingAgent, shiftOffer(14),
issueEscalator, gpsCheckin, triggerEngine, jobNotifications(10), appointmentUpdated(6),
all scheduled/* nudges, stripe.ts, checkr.ts, toolNotify — ALL currently invisible to the agent.
Also: `fulfillNarratedLinkPromise` (qaAgent.ts:2864) delivers a link bubble AFTER
saveConversationTurn — currently unrecorded.

### T1.4 QA-agent prompt rule gaps
`agents/qaAgent.ts`:
- "Never invent" is scoped to locations only (:527, :1753). Extend to person names/relationships.
- Add: "Never assert you did or did not send a message you have no record of — offer to (re)send."
  (Currently a confident wrong denial is possible; only the inverse ONE-VOICE rule exists :502/:759.)
- Add global empty-tool-result rule: "empty/null result = none exist; say so, never invent entries"
  (today only get_signup_completeness/get_payout_status have per-tool 'answer ONLY from result').
- Caregiver prompt (`buildCaregiverSystemPrompt` :753-831) is far weaker than client: no
  KNOWLEDGE BOUNDARY, no _toolError rule, no never-invent, no memory-source priority. Bring to parity.
- `runQuickReply` grounding gate fails OPEN on checker error (:3195) — prefer deterministic
  fallback for fact-bearing quick replies when the checker errors.

## TIER 2 — Targeted grounding fixes

- **UNGROUNDED-NAME (Marcus analogues), 3 sites**: `agents/gpsCheckin.ts:128` (family arrival
  alert says "their loved one" while FAMILY_VOICE commands using the senior's name — interpolate
  seniorName or describeWhoIsWho); `linq/routeIntent.ts:426` and `:599` (cancellation notice to
  caregiver, no client name given — instruct "refer only to 'the visit on {date}'").
- **UNGROUNDED-FACT**: `onboardingConversation.ts:2338` — when `priceLabel` is empty the briefing
  still says "state the price" → model may invent a dollar amount. Branch the instruction.
- **Fabricated money defaults**: `qaAgent.ts:720/:765` `hourlyRate ?? 22` → asserts "$22/hr" as
  fact when rate unknown (omit line instead); `mcp/server.ts:87` request_booking rate→$20 silent
  fallback (require explicit rate).
- **Timing promises that contradict platform's own rule** ("never predict bg-check timing",
  caregiverOnboardingDirective.ts:116): "usually 1–3 days" in `onboardingConversation.ts:5124-5128`,
  `:5133`, `:5136-5137`. Replace with "Evia texts you the moment it clears."
- **Pricing single source of truth**: $29.95 / $54.99 / $11.50 are re-typed literals in
  `onboardingConversation.ts:5124-5152`, `caregiverOnboardingDirective.ts:105`,
  `mcp/server.ts:6429/6498`. Create shared `pricing.ts` consts (display strings next to price IDs);
  also dedupe the $18–28 fallback literal (`caregiverOnboardingDirective.ts:36` should import
  `marketRateRange.ts` FALLBACK_RANGE).

## TIER 3 — Policy compliance & hardening

- **describeWhoIsWho gaps (24 family-facing sites)** interpolating a senior/client name without
  the who-is-who line (rule from careRecipients.ts, 2026-07-17 wave). Priority order: proactive
  nudges first — firstVisitActivation:91, noVisitCheck:66, familySilenceCheckin:71,
  familySatisfactionCheckin:66, nextDayFamilyFeedback:69, preShiftFamilyCheckin:83,
  clientDayBeforeReminder:64, clientThirtyMinReminder:59, upcomingVisitReminder:50,
  morningBriefing:321; then webhooks:1929, routeClient:105/120, routeCaregiver:301/342,
  issueEscalator:112/333, jobApplicationTriggers:141, jobPostingFlow:133,
  permissionsConversation:294, onboardingConversation:2470, bereavement:78/94/103.
- **Gate-link resend cooldown**: `resendGateLink` (`onboardingConversation.ts:2796`) and
  `handleCaregiverResendMembership` (`:2900`) have NO throttle — any inbound classified
  actionable re-blasts intro + link card. Add a per-step lastResentAt (e.g. 10-min) window;
  within it, answer without re-sending.
- **Web-app AI paths have NO filter at all**: `services/ai.ts:51` generateShiftNote,
  `:72` searchCaregivers.responseText, `:151` conversationalBooking.response — rendered verbatim
  in the SPA (SMS lint/redact/supervise live only in the Linq transport).
- **Hallucinated brand-domain URLs pass `isCardSafeUrl`** → sent as dead tappable cards. The
  voice prompts ban URLs but there's no output-side check (T1.2 covers generateCaraMessage;
  qaAgent path relies on supervise).
- **Memory poisoning (indirect)**: nightlyMemory/memoryFiles/careMemory summaries are unguarded
  Haiku output re-injected as trusted grounding context later.
- **History window**: HISTORY_WINDOW=24 msgs, rollup at >30 summarizes to ≤200 words and deletes
  originals — a one-off name mention can age out even after T1.3. Follow-on: preserve named
  entities in the rollup prompt.
- Dead step `caregiver_awaiting_identity` has no live-gate-fact builder (harmless — handlers
  forward immediately) — delete the step to keep the invariant clean.

## Confirmed clean

- No stale prices ($66.49/$24.95 only in code comments), no user-facing Cara/CareConnex leaks in
  prompts, service area centralized, support@eviacares.com pinned with anti-invention rule.
- Live-gate-fact builders cover ALL active awaiting steps.
- Rate ranges properly use getMarketRateText() at every live call site.
- Extraction/classification paths (parseWithClaude, quickComplete classifiers, crisisDetector,
  intent/skill pickers, claudeMatching score clamps) validate against allowlists — low risk.
- qaAgent main loop is the best-guarded path (grounding revision, format revision, repair,
  supervise, low-confidence handoff gate) — though every gate fails open.
