# Background-Check Bad-News Delivery: Session-less Caregiver Fallback — Plan (2026-07-07)

Source: adversarial review of the caregiver-signup fixes wave (2026-07-07), finding F5
(`[P2] (confidence 8/10) caraAgent.ts:186`). Status: **IMPLEMENTED 2026-07-07 (build clean, tests green). NOT deployed.**

Implementation notes (as-built):
- Helper `sendBgcheckNoticeToCaregiver(phone, caregiverUid, content)` added to `functions/src/checkr.ts` after `findCaregiverUidByCandidateId`.
- All three branches (consider/suspended/disputed) route through it; the ack-flag `.update()` calls now run AFTER the send so they also land on a session the sendToPhone fallback just created.
- `GuardedSendOutcome` union verified = `"sent" | "queued" | "dropped" | "skipped_opt_out"`; delivered-or-queued = `sent`/`queued`, else high-severity `admin_alerts` `bgcheck_notice_undelivered`.
- Tests: extended `functions/src/checkrBadNewsNotify.test.ts` — 6 tests (session-present ×3 still assert sendViaInteractionAgent + canDrop:false/immediate; session-less → sendToPhone called, no interaction agent; session-less + skipped_opt_out → undelivered admin_alert; sendToPhone THROW → outcome:"send_error" alert). All green. Full suite 2001 passed / 3 known onboardingReplay failures.
- Post-implementation cold verification (2026-07-07): independent verifier confirmed all 10 plan requirements with quoted evidence, traced test non-vacuity, and found one gap fixed same-day: `sendToPhone` RETHROWS chat-creation failures (linq/client.ts:1075 — the session-less path has no dead-letter), which would have died in the branch's outer console.error catch with no page; the helper now catches, maps to `outcome:"send_error"`, and writes the same `bgcheck_notice_undelivered` alert. Known accepted asymmetry: a session-PRESENT opted-out caregiver still exits silently inside sendViaInteractionAgent (consent_audit_log only, no page) — by design, since this plan forbids touching that function.

## Problem

Fix 3 of `docs/plans/caregiver-signup-fixes-2026-07-07-plan.md` made the caregiver-facing
notifications in the `consider` / `suspended` / `disputed` branches of `functions/src/checkr.ts`
undroppable (`urgency: "immediate"`, `canDrop: false`). That correctly bypasses the wait-tool
suppression and the daily proactive cap inside `sendViaInteractionAgent` — but only if the send
path is reached at all. `sendViaInteractionAgent` (functions/src/agents/caraAgent.ts:186-187)
begins with:

```ts
const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
if (!sessionSnap.exists) return;
```

A caregiver with **no `agent_sessions` doc** (never texted Evia — the legacy web-onboarded
cohort) silently gets nothing: the early return happens before the urgency/canDrop flags are
ever read. No log, no fallback. Remaining channels today: the `admin_alerts` doc (written
unconditionally in all three branches before the send), the in-app notification
(`users/{uid}/notifications` via `notificationPayload`), and Checkr's own email to the candidate.

Cohort size: likely zero real users (Evia SMS is the sole signup path; the 2026-07-06
`rekeyLegacyCaregiverDocs` prod dry-run found only 6 demo docs with fake 555 phones). This fix
is insurance for annual-renewal reports on any legacy caregiver that surfaces later.

## Fix

Add a small delivery helper in `functions/src/checkr.ts` and route the three bad-news sends
through it. Do NOT modify `sendViaInteractionAgent` itself — it has many callers and its
early-return contract is relied on elsewhere.

```ts
// checkr.ts — near the other helpers
// Bad-news background-check texts are compliance-adjacent and must reach the
// caregiver even when no agent session exists (legacy web-onboarded cohort).
// Session present → interaction agent (supervisor + audit + immediate/canDrop
// flags). No session → sendToPhone, which creates the chat and seeds the
// session; it also enforces opt-out itself. Any non-delivered outcome pages ops.
async function sendBgcheckNoticeToCaregiver(phone: string, caregiverUid: string, content: string): Promise<void> {
  const sessSnap = await db.collection("agent_sessions").doc(phone).get();
  if (sessSnap.exists) {
    const { sendViaInteractionAgent } = await import("./agents/caraAgent");
    await sendViaInteractionAgent(phone, {
      content,
      urgency:     "immediate",
      sourceAgent: "checkr_status",
      canDrop:     false,
    });
    return;
  }
  const { sendToPhone } = await import("./linq/client");
  const outcome = await sendToPhone(phone, content);
  if (outcome !== "sent" && !outcome.startsWith("queued")) {
    await db.collection("admin_alerts").add({
      type:        "bgcheck_notice_undelivered",
      caregiverId: caregiverUid,
      phone,
      outcome,                       // e.g. "skipped_opt_out", "dropped_*"
      preview:     content.slice(0, 120),
      createdAt:   new Date().toISOString(),
      resolved:    false,
      severity:    "high",
    });
  }
}
```

Then in each of the three branches (`consider` ~line 660, `suspended` ~line 700,
`disputed` ~line 755), replace the inline `sendViaInteractionAgent(cgData.phone, {...})` call
with `await sendBgcheckNoticeToCaregiver(cgData.phone, caregiverUid, <same content string>)`.

### Details / constraints

- **Verify the `GuardedSendOutcome` union before writing the outcome check** —
  `functions/src/linq/client.ts` (~line 1020 and the `SendOptions`/outcome types above it).
  The check above assumes `"sent"` and `"queued_*"` count as delivered-or-will-deliver
  (the dead-letter queue drains `send_failed` entries); adjust to the real union members.
- **`skipped_opt_out` is deliberate**: a caregiver who texted STOP must not be messaged
  (carrier compliance beats delivery preference). The admin_alert is the correct escape —
  a human follows up out-of-band.
- Keep the existing `admin_alerts` writes and `notificationPayload` in-app notifications in
  all three branches untouched — the helper is additive delivery, not a replacement.
- Keep the `pendingBgCheckAck` session-flag writes where they exist (consider/suspended
  branches) — but note they are `.update()` on a possibly-missing session doc with
  `.catch(() => {})`; after a `sendToPhone` fallback the session NOW exists (sendToPhone
  creates it), so consider moving those writes after the helper call so the ack flag lands
  on the freshly created session too. Low stakes; implementer's judgment.
- Do NOT touch the `clear`-path sends, the family notifications, or `invitation.expired`
  copy — different message classes, different urgency semantics.
- No new env vars, no rules changes.

### Why not alternatives

- **Changing `sendViaInteractionAgent` to create sessions or return an outcome**: shared
  machinery with many call sites; the silent early return is load-bearing for proactive
  sends where a missing session legitimately means "don't start a conversation".
- **`sendToPhone` for all three sends unconditionally**: loses supervisor linting, audit
  logging, and content-hash dedup that the interaction agent provides for the (vastly
  dominant) session-present case.

## Acceptance

- Unit test: consider report for a caregiver whose phone has NO agent_sessions doc →
  `sendToPhone` called with the notice content; `sendViaInteractionAgent` NOT called.
- Unit test: same, but `sendToPhone` resolves `"skipped_opt_out"` → `admin_alerts` write with
  `type: "bgcheck_notice_undelivered"`.
- Unit test (regression): session EXISTS → `sendViaInteractionAgent` still called with
  `canDrop: false` + `urgency: "immediate"` (extend `functions/src/checkrBadNewsNotify.test.ts` —
  its harness already drives all three branches; the existing three tests must stay green).
- `npm --prefix functions run build` clean; `npx vitest run src/checkrBadNewsNotify.test.ts` green.

## Verification (whole plan)

1. Build + targeted tests as above.
2. Full `npm --prefix functions test` — only the 3 known pre-existing `onboardingReplay`
   failures allowed.
3. Deploy rules from CLAUDE.md apply if/when shipped (repo-root `node_modules/.bin/firebase`,
   `FUNCTIONS_DISCOVERY_TIMEOUT=60`, verify `functions/.env` completeness first).
