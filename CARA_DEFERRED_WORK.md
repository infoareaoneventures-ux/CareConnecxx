# Cara — Deferred Work (post-P2)

Items the audit surfaced that are real features or substantial scope changes rather than fixes. Each one needs a product decision before implementation, which is why I'm not building them blind.

Last updated: 2026-05-23

---

## B1 / B2 / B3 — Mid-conversation matching changes

**What's missing:** Once Cara has presented caregiver matches, the family can't say "actually show me cheaper ones" or "any who can also do mobility?" — there's no re-filter handler. They have to restart matching or use the qaAgent tool path indirectly.

**Why it's deferred:** A new conversational sub-flow with its own state machine (filter-change → re-score → re-present). Touches `matchingAgent.ts`, the execution agent, and adds a new step set. Not a bug — a feature.

**Decision needed:**
- Do you want a full re-filter sub-flow (chat-based slider adjustments), or is "restart matching with the new filter" acceptable for v1?
- If full sub-flow: which filters should be live (rate, skills, days, distance, language, gender preference)?

---

## E1 / E2 / E5 — Day-before client reminder + 30-min reminder

**What's missing:** `handleShiftConfirmation` is **caregiver-only**. There's no equivalent client-side flow where the family gets a "your visit tomorrow at 9am with Alice — reply CONFIRM if you're still on" / "CANCEL" / "QUESTION" path. 30-minute pre-shift client reminder also has no inbound handler.

**Why it's deferred:** Three new scheduled functions (or extensions to existing ones) + three new state-machine flags + three new handlers. Decision needed about whether to send them and what the cancellation path costs (does CANCEL trigger a refund? Does it auto-search a replacement?).

**Decision needed:**
- Should client get a day-before reminder at all? (Some families would view it as nagging.)
- If yes — does CANCEL initiate a refund + replacement search, or just notify the caregiver?
- 30-min reminder: useful, or annoying? Send when the caregiver leaves home, when they're 15 min away, on arrival?

---

## J5 — Non-English message support

**What's missing:** System prompts are English-only. Non-English messages get classified as QUESTION and Claude handles ad-hoc translation — workable but not designed.

**Why it's deferred:** i18n is a project, not a fix. Need language detection on inbound, localized system prompts, localized templates (SMS_TEMPLATES), localized crisis responses (911/988 wording differs by region/language), and probably a per-user `preferredLanguage` field.

**Decision needed:**
- Launch English-only and ship i18n in v1.1?
- If yes for v1.0: which languages? Spanish is the obvious first add (matches CareConnex demographics).

---

## K5 — Back-to-back inbound race

**What's missing:** If a user sends message A and B within ~500ms, the prefetch cache for A may be consumed when processing B. No documented evidence of actual misrouting; behavior depends on Firestore latency.

**Why it's deferred:** Hard to reproduce without instrumented load testing. Would need a synthetic test harness firing concurrent webhooks before deciding on a fix (locking? per-message keys?).

**Decision needed:** Add instrumentation first, decide based on data. Recommend lab-testing only if you see real evidence in production.

---

## D4 — Booking cancel flow

**Status:** Works via the qaAgent tool path (`cancel_appointment` MCP tool), not via a dedicated state-machine handler. So Claude has to call the tool every time. Currently functional but indirect — Claude could mis-route or fail silently if the tool-use loop times out.

**Decision needed:** Build a dedicated `clientCancelFlow.ts` (mirrors `clientSwapRequestHandler`), or trust the tool path and add monitoring? Recommendation: add metrics on cancellation success rate first; only build a dedicated flow if Claude is mis-handling >5% of attempts.

---

## Items already covered in the P0/P1 pass (FYI — no further action)

- A1 / A2 — Cold inbound and `initiateCara` paths now gated by OTP (A7 fix)
- A8 — Shared-phone collisions handled by persona-shift detector
- D5, H1, H2, I1, I2, J1, J2, J4, J6 — were ✅ working as intended; nothing to change
- L2 — OpenAI fallback paths are already correct

---

## Suggested sequencing for v1.1

1. **D4 + B1** (small, both already tool-callable) — wire dedicated flows and gain metrics
2. **E1/E2** — client reminders with simple CONFIRM/CANCEL (skip refund logic for v1.1)
3. **J5** — Spanish-language support (largest, schedule for v1.2)
4. **B2/B3** — re-filter mid-match (largest UX overhaul, schedule for v1.2)
5. **K5** — instrumentation first, decide based on data
