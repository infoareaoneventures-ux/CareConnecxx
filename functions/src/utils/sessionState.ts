import * as admin from "firebase-admin";

export const STATE_MACHINE_FLAGS = [
  "pendingMatches",
  "awaitingCareNotes",
  "awaitingLateMinutes",
  "awaitingIssueDescription",
  "caregiverRescheduling",
  "awaitingJobResponse",
  "awaitingAvailabilityConfirmation",
  "pendingShiftApproval",
  "collectingCredential",
  "collectingCredentialSetAt",
  "stateExpiresAt",
  "jobPostingStep",
  "jobPostingData",
  // Scripted booking flow (bookingFlow.ts, 2026-09-13)
  "bookingFlowStep",
  "bookingFlowData",
  // Scripted shift-replacement flow (replacementFlow.ts, 2026-09-14) — the
  // website's Find Replacement modal, step for step.
  "replacementFlowStep",
  "replacementFlowData",
  // Scripted visit-reschedule flow (rescheduleFlow.ts, 2026-09-15) — the
  // website's Reschedule button on an upcoming shift, step for step.
  "rescheduleFlowStep",
  "rescheduleFlowData",
  // Scripted cancel flow (cancelFlow.ts, 2026-09-17) — the My Bookings page's
  // cancel buttons, step for step. Replaced the legacy pending-cancel confirm flag.
  "cancelFlowStep",
  "cancelFlowData",
  // Scripted Request Visit flow (visitRequestFlow.ts, 2026-09-16) — the
  // website's Calendar "+ Request Visit" modal, step for step.
  "visitRequestFlowStep",
  "visitRequestFlowData",
  // Scripted timesheet-correction flow (correctionFlow.ts, 2026-09-18) — the
  // Timesheets "Review submitted hours" modal, step for step.
  "correctionFlowStep",
  "correctionFlowData",
  // Scripted interview-scheduling flow (interviewFlow.ts, 2026-09-13)
  "interviewFlowStep",
  "interviewFlowData",
  // Scripted Leave a Review flow (reviewFlow.ts, 2026-09-19) — the site's review modal, step for step.
  "reviewFlowStep",
  "reviewFlowData",
  // Mid-shift task acknowledgment flow
  "awaitingTaskAck",
  // Day-before shift confirmation from caregiver
  "pendingShiftConfirmation",
  // Healthcare agentic flows (provider search, appointment booking, Rx refill, new Rx)
  "healthcareFlowStep",
  "healthcareFlowData",
  // Availability update flow
  "availabilityStep",
  "pendingAvailability",
  // Caregiver-initiated shift cancellation flow
  "cancelStep",
  "cancelCandidates",
  "cancelShiftId",
  "cancelShiftDate",
  "cancelShiftClientId",
  "cancelReason",
  // Caregiver profile update flow (rate / skills / bio / photo / pause / reactivate)
  "profileUpdateStep",
  "profileUpdateField",
  "profileUpdateValue",
  // PAYOUT instant-payout confirmation
  "pendingInstantPayoutConfirm",
  // Context flags that route follow-up replies to qaAgent with rich context
  "pendingPayoutNotificationAck",
  "pendingPayoutNotificationAckSetAt",
  "pendingBgCheckAck",
  "pendingBgCheckAckSetAt",
  // Onboarding resume checkpoint (NOT cleared — intentionally kept for resume)
] as const;

export type StateFlag = typeof STATE_MACHINE_FLAGS[number];
// ── High-stakes confirmation freshness ───────────────────────────────────────
// A high-stakes confirm flag is one the YES/NO router acts on. A stale flag can intercept
// a YES meant for a newer question, and the global stateExpiresAt sweep only
// fires when a stateExpiresAt is present — a flag set without one never expires.
// Each set-site now stamps a `<flag>SetAt`; the router clears any flag older
// than this TTL (or present with no stamp — the never-expires case) before
// acting. Kept pure here so the staleness rule is unit-testable in isolation.
// 2026-09-17: empty — the last member (awaitingRecurringConfirmation, the
// Evia-only "make it weekly?" follow-up after a booking) went with the retired
// agent-task booking pipeline. The sweep stays so a future flag registers here.
export const HIGH_STAKES_CONFIRM_FLAGS: ReadonlyArray<StateFlag> = [];

export const CONFIRM_FLAG_TTL_MS = 60 * 60 * 1000;

/**
 * Return the names of high-stakes confirmation flags on `session` that are
 * stale and should be cleared before the YES/NO router acts on them — older
 * than the TTL, or set with no age stamp at all (the dangerous never-expires
 * case). Pure: performs no IO and does not mutate `session`. The caller applies
 * the Firestore delete (also deleting the companion `<flag>SetAt`) and clears
 * the in-memory copy.
 */
export function staleConfirmFlags(
  session: Record<string, unknown>,
  nowMs: number = Date.now(),
): string[] {
  const cutoff = new Date(nowMs - CONFIRM_FLAG_TTL_MS).toISOString();
  const stale: string[] = [];
  for (const flag of HIGH_STAKES_CONFIRM_FLAGS) {
    if (!session[flag]) continue;
    const setAt = session[`${flag}SetAt`] as string | undefined;
    if (!setAt || setAt < cutoff) stale.push(flag);
  }
  return stale;
}

// ── Job-invite freshness ─────────────────────────────────────────────────────
// awaitingJobResponse / awaitingAvailabilityConfirmation are checked at the
// TOP of routeCaregiverMessage (and in the webhooks permissions-step bypass),
// so a stale invite would intercept EVERYTHING — including ARRIVED at a shift
// (hazard created when the 07-15 reorder fixed the referral hijack). The
// senders stamp pendingJobSentAt; nothing read it until this gate. Missing
// stamp counts as stale — the dangerous never-expires case, same semantics as
// staleConfirmFlags.
export const JOB_INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * True when the session's job-invite state should no longer own inbound
 * replies: either flag is set and the pendingJobSentAt stamp is missing or
 * older than JOB_INVITE_TTL_MS. Pure — the caller clears the flags and falls
 * through to normal routing.
 */
export function isJobInviteStale(
  session: Record<string, unknown> | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!session) return false;
  if (!session.awaitingJobResponse && !session.awaitingAvailabilityConfirmation) return false;
  const sentAt = session.pendingJobSentAt as string | undefined;
  if (!sentAt) return true;
  return sentAt < new Date(nowMs - JOB_INVITE_TTL_MS).toISOString();
}

/** The full field set to delete when a stale job invite is cleared. */
export const JOB_INVITE_FLAGS = [
  "awaitingJobResponse",
  "awaitingAvailabilityConfirmation",
  "pendingJobId",
  "pendingJobSentAt",
] as const;

// ── Multi-step flow freshness ────────────────────────────────────────────────
// Flows that collect over several turns (credentials, shift approvals) stamp a
// per-flag SetAt and their consumers clear the flow when it's older than the
// TTL — or when the stamp is missing (never-expires guard). Deliberately NOT
// the shared stateExpiresAt field: it is shared across every flow and
// deleting it while another flag is active is a known collision hazard.
export const CREDENTIAL_FLOW_TTL_MS = 30 * 60 * 1000;      // password collection: strictest
export const MULTI_STEP_FLOW_TTL_MS = 24 * 60 * 60 * 1000; // stamped multi-step flows

/**
 * True when a flow flag is set but its SetAt stamp is missing or older than
 * ttlMs. Pure; callers clear the flow's fields and fall through.
 */
export function isFlowStale(
  session: Record<string, unknown> | undefined | null,
  flag: string,
  setAtField: string,
  ttlMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!session || !session[flag]) return false;
  const setAt = session[setAtField] as string | undefined;
  if (!setAt) return true;
  return setAt < new Date(nowMs - ttlMs).toISOString();
}

// ── Interrupted-flow descriptions ────────────────────────────────────────────
// When the expiry sweep clears a mid-flow state machine, the user used to be
// dropped silently — they'd started a booking/dispute/cancellation and never heard
// another word about it. This map names the flows worth a resume nudge, in
// user language. Passive ack/confirmation flags (pendingShiftConfirmation,
// awaitingTaskAck, pendingBgCheckAck, …) are deliberately absent: they have
// their own reminder flows or are too low-stakes to re-ping.
export const RESUMABLE_FLOW_DESCRIPTIONS: ReadonlyArray<[StateFlag, string]> = [
  ["jobPostingStep",          "posting your care job"],
  ["bookingFlowStep",         "sending your booking request"],
  ["replacementFlowStep",     "finding a replacement for your visit"],
  ["rescheduleFlowStep",      "moving your visit to a new day/time"],
  ["cancelFlowStep",          "cancelling that visit or request"],
  ["visitRequestFlowStep",    "requesting an extra visit"],
  ["correctionFlowStep",      "correcting a caregiver's timesheet"],
  ["interviewFlowStep",       "setting up your interview request"],
  ["reviewFlowStep",          "leaving your review"],
  ["healthcareFlowStep",      "that healthcare request"],
  ["awaitingIssueDescription", "the issue you started telling me about"],
  ["cancelStep",              "cancelling that shift"],
  ["availabilityStep",        "updating your availability"],
  ["profileUpdateStep",       "updating your profile"],
  ["collectingCredential",    "your credential upload"],
];

/**
 * If the session has an interrupted flow worth resuming, return its
 * user-facing description; else null. Pure — used by the expiry sweep to
 * decide whether clearing state deserves a nudge instead of silence.
 */
export function describeInterruptedFlow(
  session: Record<string, unknown> | undefined | null,
): string | null {
  if (!session) return null;
  for (const [flag, description] of RESUMABLE_FLOW_DESCRIPTIONS) {
    const v = session[flag];
    if (v !== undefined && v !== null && v !== false && v !== "") return description;
  }
  return null;
}

export async function clearAllStateFlags(
  phone: string,
  db: admin.firestore.Firestore
): Promise<void> {
  const update: Record<string, admin.firestore.FieldValue> = {};
  for (const flag of STATE_MACHINE_FLAGS) {
    update[flag] = admin.firestore.FieldValue.delete();
  }
  await db.collection("agent_sessions").doc(phone).update(update);
}

// ── Validated flag access (U8) ───────────────────────────────────────────────
// The routing spine reads session flags through `(session as any).flag` and
// destructures the result without a shape guard — so a malformed flag
// (a confirm flag present but missing its id) crashes or
// silently produces `undefined.doc(undefined)`. These helpers give the routers
// ONE validated, typed door to the session, replacing the unguarded casts.

/**
 * Read a session flag with an optional shape guard. Returns the typed value, or
 * `null` if the flag is absent OR fails validation — never a half-formed object
 * the caller will blindly destructure. Pure: no Firestore access.
 */
export function readFlag<T = unknown>(
  // `object` so both AgentSession (an interface, no index signature) and plain
  // records pass without a call-site cast.
  session: object | undefined | null,
  name: StateFlag,
  validate?: (v: unknown) => boolean,
): T | null {
  const v = (session as Record<string, unknown> | null | undefined)?.[name];
  if (v === undefined || v === null) return null;
  if (validate && !validate(v)) return null;
  return v as T;
}

/**
 * True when the session's current state machine has passed its `stateExpiresAt`
 * deadline (stored as an ISO string). Centralizes the
 * `new Date(stateExpiresAt) < new Date()` check copied across the routers. Pure.
 */
export function isStateExpired(
  session: object | undefined | null,
  now: Date = new Date(),
): boolean {
  const exp = (session as Record<string, unknown> | null | undefined)?.stateExpiresAt;
  if (typeof exp !== "string" || exp === "") return false; // no deadline set → not expired
  const when = new Date(exp);
  return !isNaN(when.getTime()) && when < now;
}

// ── Web-turn guard: is a fresh SMS state-machine flow mid-flight? ────────────
// The web chat path must defer to an in-flight SMS flow rather than run a
// parallel agent turn that clobbers session flags (the split-brain hazard).
// `hasActiveSmsFlow` is a READ-ONLY predicate, DENY-BY-DEFAULT: every primary
// STATE_MACHINE_FLAGS flag is guarded UNLESS it is explicitly listed passive
// or as a data companion below — so money flags (pendingInstantPayoutConfirm,
// pendingShiftApproval) and any FUTURE flag defer by
// default rather than fall through an allow-list. Each guarded flag is composed
// with its staleness helper (confirm/invite/stamped-step/generic), so a stale
// flag never defers a web turn. The web path NEVER clears or stamps flags —
// flag lifecycle stays SMS-router-owned. A drift test (sessionState.test.ts)
// asserts GUARDED_SMS_FLAGS and PASSIVE_SMS_FLAGS partition STATE_MACHINE_FLAGS,
// so a newly-added flag fails the build until it is categorized here.
type WebGuardStrategy =
  | "confirm"
  | "invite"
  | "stampedStep"
  | "generic"
  // Per-flag explicit stamp: the flag was set alongside `setAtField` (an ISO
  // string) and its SMS-side consumer clears it after `ttlMs`. Missing stamp ⇒
  // stale (same isFlowStale semantics as "stampedStep") — a stamp-less write of
  // one of these flags must never wedge the web surface forever.
  | { setAtField: string; ttlMs: number }
  // The flag's VALUE is itself the ISO timestamp (e.g. pendingInstantPayoutConfirm,
  // instantPayoutHandler.ts). Stale when the parsed value is older than `ttlMs`;
  // an unparseable value is treated as STALE (the SMS router clears this flow
  // aggressively — a 10-min money confirm must not wedge web turns).
  | { valueStampTtlMs: number };

// pendingMatches parity: routeIntent.ts clears pendingMatches when
// pendingMatchesSetAt is older than 2h (the "stale list" rule).
export const PENDING_MATCHES_TTL_MS = 2 * 60 * 60 * 1000;
// pendingInstantPayoutConfirm parity: routeCaregiver.ts clears the confirm when
// its ISO value is older than 10 minutes.
export const INSTANT_PAYOUT_CONFIRM_TTL_MS = 10 * 60 * 1000;

/**
 * Guarded primary flags → the staleness strategy used to decide whether an
 * instance of the flag is still "active" (defers a web turn) or stale (ignored):
 *  - "confirm":     staleConfirmFlags (1h TTL; missing stamp = stale)
 *  - "invite":      isJobInviteStale (48h TTL on pendingJobSentAt)
 *  - "stampedStep": isFlowStale on `${flag}SetAt` (24h MULTI_STEP TTL)
 *  - {setAtField, ttlMs}: isFlowStale on an EXPLICIT stamp field + TTL
 *                   (missing stamp = stale) — used where the SMS side already
 *                   stamps a differently-named field or a non-24h TTL.
 *  - {valueStampTtlMs}: the flag VALUE is the ISO stamp; stale past the TTL or
 *                   unparseable.
 *  - "generic":     stamp-less flow — stale only when stateExpiresAt is present
 *                   AND passed; ABSENT stateExpiresAt ⇒ active (deny-by-default).
 */
export const GUARDED_SMS_FLAGS: ReadonlyArray<[StateFlag, WebGuardStrategy]> = [
  // Set by matchingAgent.ts alongside pendingMatchesSetAt; routeIntent.ts
  // treats the list as stale after 2h. Without this stamp strategy a web
  // matching turn (find_nearby_caregivers / get_callout_backups) would wedge every subsequent
  // web turn forever (pendingMatches carries no stateExpiresAt).
  ["pendingMatches", { setAtField: "pendingMatchesSetAt", ttlMs: PENDING_MATCHES_TTL_MS }],
  ["awaitingCareNotes", "generic"],
  ["awaitingLateMinutes", "generic"],
  ["awaitingIssueDescription", "generic"],
  ["caregiverRescheduling", "generic"],
  ["awaitingJobResponse", "invite"],
  ["awaitingAvailabilityConfirmation", "invite"],
  // Set by approvalNoticeDispatcher.ts alongside pendingShiftApprovalSetAt.
  ["pendingShiftApproval", { setAtField: "pendingShiftApprovalSetAt", ttlMs: MULTI_STEP_FLOW_TTL_MS }],
  // SMS router parity: credentialCollector.ts clears this flow after
  // CREDENTIAL_FLOW_TTL_MS (30 min), not the 24h multi-step TTL.
  ["collectingCredential", { setAtField: "collectingCredentialSetAt", ttlMs: CREDENTIAL_FLOW_TTL_MS }],
  ["jobPostingStep", "generic"],
  ["bookingFlowStep", "generic"],
  ["replacementFlowStep", "generic"],
  ["rescheduleFlowStep", "generic"],
  ["cancelFlowStep", "generic"],
  ["visitRequestFlowStep", "generic"],
  ["correctionFlowStep", "generic"],
  ["interviewFlowStep", "generic"],
  ["reviewFlowStep", "generic"],
  ["healthcareFlowStep", "generic"],
  ["availabilityStep", "generic"],
  ["cancelStep", "generic"],
  ["profileUpdateStep", "generic"],
  // instantPayoutHandler.ts writes the ISO timestamp AS the flag value;
  // routeCaregiver.ts clears it after 10 minutes.
  ["pendingInstantPayoutConfirm", { valueStampTtlMs: INSTANT_PAYOUT_CONFIRM_TTL_MS }],
];

/**
 * Explicitly-excluded entries: SetAt stamps, per-flow data companions, the
 * shared `stateExpiresAt` deadline field, and PASSIVE ack / check-in flags that
 * have their own reminder flows and are too low-stakes to defer a web turn
 * (payout/bg-check acks, mid-shift task ack, day-before shift confirmations,
 * pre-shift check-in). These are never treated as an active flow by the guard.
 */
export const PASSIVE_SMS_FLAGS: ReadonlySet<StateFlag> = new Set<StateFlag>([
  "collectingCredentialSetAt",
  "stateExpiresAt",
  "jobPostingData",
  "bookingFlowData",
  "replacementFlowData",
  "rescheduleFlowData",
  "cancelFlowData",
  "visitRequestFlowData",
  "correctionFlowData",
  "interviewFlowData",
  "reviewFlowData",
  "awaitingTaskAck",
  "pendingShiftConfirmation",
  "healthcareFlowData",
  "pendingAvailability",
  "cancelCandidates",
  "cancelShiftId",
  "cancelShiftDate",
  "cancelShiftClientId",
  "cancelReason",
  "profileUpdateField",
  "profileUpdateValue",
  "pendingPayoutNotificationAck",
  "pendingPayoutNotificationAckSetAt",
  "pendingBgCheckAck",
  "pendingBgCheckAckSetAt",
]);

/**
 * True when `session` has a FRESH (non-stale) SMS state-machine flow in flight —
 * the web path should defer rather than run a parallel agent turn. Pure: no IO,
 * no mutation. See the block comment above for the deny-by-default contract.
 */
export function hasActiveSmsFlow(
  session: Record<string, unknown> | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!session) return false;
  for (const [flag, strategy] of GUARDED_SMS_FLAGS) {
    if (!session[flag]) continue;
    if (typeof strategy === "object") {
      if ("valueStampTtlMs" in strategy) {
        // The flag value IS the ISO stamp. Unparseable ⇒ stale (never wedge).
        const v = session[flag];
        if (typeof v !== "string") continue;
        const setMs = Date.parse(v);
        if (isNaN(setMs)) continue;
        if (setMs >= nowMs - strategy.valueStampTtlMs) return true;
      } else {
        // Explicit per-flag stamp + TTL; missing stamp ⇒ stale (isFlowStale).
        if (!isFlowStale(session, flag, strategy.setAtField, strategy.ttlMs, nowMs)) return true;
      }
      continue;
    }
    switch (strategy) {
      case "confirm":
        if (!staleConfirmFlags(session, nowMs).includes(flag)) return true;
        break;
      case "invite":
        if (!isJobInviteStale(session, nowMs)) return true;
        break;
      case "stampedStep":
        if (!isFlowStale(session, flag, `${flag}SetAt`, MULTI_STEP_FLOW_TTL_MS, nowMs)) return true;
        break;
      case "generic":
        // Stamp-less flow: stale only when a stateExpiresAt deadline is present
        // AND passed. Absent deadline ⇒ active (deny-by-default → defer).
        if (!isStateExpired(session, new Date(nowMs))) return true;
        break;
    }
  }
  return false;
}

/** Write one or more flags in a single update. */
export async function setFlags(
  phone: string,
  db: admin.firestore.Firestore,
  updates: Partial<Record<StateFlag, unknown>>,
): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update(updates as Record<string, unknown>);
}

/**
 * Delete a SUBSET of state flags in one update (vs. clearAllStateFlags which
 * wipes everything). Collapses the copy-pasted
 * `{ flagA: delete(), stateExpiresAt: delete() }` expiry-cleanup blocks.
 */
export async function clearFlags(
  phone: string,
  db: admin.firestore.Firestore,
  names: StateFlag[],
): Promise<void> {
  const update: Record<string, admin.firestore.FieldValue> = {};
  for (const n of names) update[n] = admin.firestore.FieldValue.delete();
  await db.collection("agent_sessions").doc(phone).update(update);
}

// ── Per-phone inbound serialization ──────────────────────────────────────────
// Linq is at-least-once AND a user can fire several messages in quick
// succession; each lands in its own function instance and races on the same
// session doc. event_id dedup stops DUPLICATES but not distinct concurrent
// messages, so two near-simultaneous texts can read the same session snapshot
// and write conflicting flags (the root cause of wedged state / double-books).
// A transactional per-phone claim serializes them. A TTL lets a crashed holder
// self-heal so the lock can never wedge a conversation permanently.
export const INBOUND_LOCK_TTL_MS = 90_000;

const inboundLockRef = (phone: string, db: admin.firestore.Firestore) =>
  db.collection("agent_inbound_locks").doc(phone);

/**
 * Try to claim the per-phone inbound lock. Returns true if acquired (free, or
 * a stale claim past the TTL from a crashed holder), false if a live claim is
 * held by another in-flight message. Fails OPEN (returns true) on transaction
 * error — dropping a user's message is a worse failure than a rare race.
 */
export async function claimInboundProcessing(
  phone: string,
  db: admin.firestore.Firestore,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const ref = inboundLockRef(phone, db);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const lockedAt = (snap.data() as { lockedAt?: number } | undefined)?.lockedAt ?? 0;
      if (snap.exists && nowMs - lockedAt < INBOUND_LOCK_TTL_MS) return false;
      tx.set(ref, { lockedAt: nowMs });
      return true;
    });
  } catch {
    return true;
  }
}

/** Release the per-phone inbound lock. Best-effort — TTL covers any miss. */
export async function releaseInboundProcessing(
  phone: string,
  db: admin.firestore.Firestore,
): Promise<void> {
  await inboundLockRef(phone, db).delete().catch(() => {});
}
