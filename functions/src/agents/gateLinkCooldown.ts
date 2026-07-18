// ── Gate-link resend cooldown (U9, R13 — 2026-07-17) ─────────────────────────
// A parked step's `other`-classified inbounds could re-blast the link card on
// EVERY text ("hm" → card, "ok but" → card, …). Per-step SetAt+TTL cooldown
// (the isFlowStale idiom, sessionState.ts): the first `other` resend stamps
// `gateLinkResentAt[step]`; within the 10-minute window further `other`
// inbounds get DETERMINISTIC, truthful copy that never claims a fresh send —
// an LLM reply briefed on the resend flow could improvise "just resent it",
// exactly the incident class this wave kills. A bare LINK reply (strict
// keyword, binary-protocol carve-out) bypasses the cooldown once per window,
// because classifyAwaitingReply classifies "send it again" as `other` AND
// defaults to `other` on classifier failure — a caregiver whose link was
// carrier-filtered must have a same-minute escape hatch. `ack`/`question`
// paths are untouched (questions still get answered AND their link follows).
// Missing/corrupt cooldown state fails OPEN: resend proceeds — never wedge a
// gate on bookkeeping.
//
// This module owns the cooldown STATE machinery (constants, window math, copy
// builders, per-step stamps) so every link-sending surface — the scripted
// `other` branches in onboardingConversation.ts, the stale-session nudge cron,
// and the MCP send_onboarding_link tool — shares ONE window per step. The
// orchestrating send paths (handleGateLinkKeyword, resendGateLink) stay in
// onboardingConversation.ts.

import * as admin from "firebase-admin";
import { isOnboardingDryRun, recordSideEffect } from "./onboardingDryRun";
import type { OnboardingLinkType } from "./onboardingConversation";

// Lazy so importing this module never races admin.initializeApp() (the stamp
// writers are the only firestore users here).
let _db: admin.firestore.Firestore | null = null;
function db(): admin.firestore.Firestore {
  if (!_db) _db = admin.firestore();
  return _db;
}

export const GATE_LINK_RESEND_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Minutes since the step's last cooldown-stamped link send, when inside the
 * 10-minute window; null when outside the window, never stamped, or the stamp
 * is corrupt (fail-open). When the LINK bypass resent more recently than the
 * window opener, minutes count from that LATEST send so the copy stays honest.
 */
export function gateLinkCooldownMinutes(
  sessionData: Record<string, unknown> | undefined | null,
  step:        string,
  nowMs:       number = Date.now(),
): number | null {
  try {
    const resentAt = (sessionData?.gateLinkResentAt as Record<string, unknown> | undefined)?.[step];
    if (typeof resentAt !== "string") return null;
    const setMs = Date.parse(resentAt);
    if (isNaN(setMs)) return null; // corrupt stamp → fail open (no cooldown)
    const age = nowMs - setMs;
    if (age < 0 || age >= GATE_LINK_RESEND_COOLDOWN_MS) return null;
    let latestMs = setMs;
    const bypassAt = (sessionData?.gateLinkBypassUsedAt as Record<string, unknown> | undefined)?.[step];
    if (typeof bypassAt === "string") {
      const bMs = Date.parse(bypassAt);
      if (!isNaN(bMs) && bMs > latestMs && bMs <= nowMs) latestMs = bMs;
    }
    return Math.max(1, Math.round((nowMs - latestMs) / 60_000));
  } catch {
    return null; // corrupt cooldown state must never wedge a gate
  }
}

/**
 * DETERMINISTIC in-cooldown reply — never LLM-generated, never a completed-
 * action claim ("just resent it"); the only forward promise is the LINK hatch.
 */
export function gateLinkCooldownCopy(minutes: number): string {
  return `I sent that link about ${minutes} minute${minutes === 1 ? "" : "s"} ago — if it hasn't come through, reply LINK and I'll resend it.`;
}

/**
 * DETERMINISTIC copy for when this window's LINK bypass is already spent —
 * gateLinkCooldownCopy would be UNTRUTHFUL here (it promises "reply LINK and
 * I'll resend it" right after LINK was consumed). This variant acknowledges
 * the recent resend and points at the window reset instead: no fresh-send
 * claim, no re-promise of an immediate LINK resend.
 */
export function gateLinkBypassSpentCopy(minutesSinceSend: number, minutesUntilReset: number): string {
  const since = `${minutesSinceSend} minute${minutesSinceSend === 1 ? "" : "s"}`;
  const reset = `${minutesUntilReset} minute${minutesUntilReset === 1 ? "" : "s"}`;
  return `I resent that link about ${since} ago — give it a couple of minutes to come through. ` +
    `If it still hasn't arrived, I can send it again in about ${reset}.`;
}

/**
 * Minutes until the step's cooldown window resets (the window opener stamp
 * ages past GATE_LINK_RESEND_COOLDOWN_MS). Only meaningful while in cooldown;
 * clamps to at least 1 and fails soft to 1 on missing/corrupt state.
 */
export function gateLinkCooldownResetMinutes(
  sessionData: Record<string, unknown> | undefined | null,
  step:        string,
  nowMs:       number = Date.now(),
): number {
  try {
    const resentAt = (sessionData?.gateLinkResentAt as Record<string, unknown> | undefined)?.[step];
    if (typeof resentAt !== "string") return 1;
    const setMs = Date.parse(resentAt);
    if (isNaN(setMs)) return 1;
    return Math.max(1, Math.ceil((GATE_LINK_RESEND_COOLDOWN_MS - (nowMs - setMs)) / 60_000));
  } catch {
    return 1;
  }
}

/**
 * The right deterministic in-cooldown reply for the step's current state:
 * gateLinkCooldownCopy while the LINK hatch is still available, the
 * bypass-spent variant once it's consumed — the "reply LINK" promise is only
 * ever made when a LINK would actually resend.
 */
export function gateLinkInCooldownReplyCopy(
  sessionData: Record<string, unknown> | undefined | null,
  step:        string,
  minutes:     number,
): string {
  return gateLinkBypassConsumed(sessionData, step)
    ? gateLinkBypassSpentCopy(minutes, gateLinkCooldownResetMinutes(sessionData, step))
    : gateLinkCooldownCopy(minutes);
}

/** True when this window's one LINK bypass is already spent. Fail-closed to false. */
export function gateLinkBypassConsumed(
  sessionData: Record<string, unknown> | undefined | null,
  step:        string,
  nowMs:       number = Date.now(),
): boolean {
  try {
    const resentAt = (sessionData?.gateLinkResentAt as Record<string, unknown> | undefined)?.[step];
    const bypassAt = (sessionData?.gateLinkBypassUsedAt as Record<string, unknown> | undefined)?.[step];
    if (typeof resentAt !== "string" || typeof bypassAt !== "string") return false;
    const setMs = Date.parse(resentAt);
    const bMs   = Date.parse(bypassAt);
    if (isNaN(setMs) || isNaN(bMs)) return false;
    // Consumed only within the CURRENT window: a bypass stamped before this
    // window's opener belongs to an old window and resets automatically.
    return bMs >= setMs && nowMs - setMs < GATE_LINK_RESEND_COOLDOWN_MS;
  } catch {
    return false;
  }
}

// Dotted-path session stamp write. Mirrors onboardingConversation's private
// updateSession EXACTLY: in a shadow/dry-run the live session doc is never
// mutated — the would-be write is recorded with the same kind + keys shape.
async function writeGateLinkStamp(phone: string, fieldPath: string): Promise<void> {
  // Best-effort bookkeeping — a failed stamp must never fail the turn.
  try {
    if (isOnboardingDryRun()) {
      recordSideEffect("firestore.update:agent_sessions", { phone, keys: [fieldPath] });
      return;
    }
    await db().collection("agent_sessions").doc(phone).update({ [fieldPath]: new Date().toISOString() });
  } catch { /* never wedge a gate on bookkeeping */ }
}

export async function stampGateLinkResent(phone: string, step: string): Promise<void> {
  await writeGateLinkStamp(phone, `gateLinkResentAt.${step}`);
}

export async function stampGateLinkBypassUsed(phone: string, step: string): Promise<void> {
  await writeGateLinkStamp(phone, `gateLinkBypassUsedAt.${step}`);
}

// The parked steps whose `other` branch resends via resendGateLink, with the
// same intro copy those branches use — the LINK keyword hatch is scoped to
// exactly these plus the membership/MVR checkout steps (handled bespoke in
// onboardingConversation because their resend lives in
// handleCaregiverResendMembership/Mvr).
export const GATE_LINK_KEYWORD_TARGETS: Record<string, { linkType: OnboardingLinkType; intro: string }> = {
  client_awaiting_identity:     { linkType: "client_identity",           intro: "Here's a fresh link for the quick 30-second identity check:" },
  client_awaiting_payment:      { linkType: "client_payment",            intro: "Here's your membership link again — it takes about 30 seconds:" },
  caregiver_awaiting_photo:     { linkType: "caregiver_photo",           intro: "Here's your photo upload link again — it opens right on your phone:" },
  caregiver_awaiting_documents: { linkType: "caregiver_documents",       intro: "Here's the certifications upload link again — and if you don't have any, just tell me to skip it:" },
  caregiver_awaiting_bgcheck:   { linkType: "caregiver_background_check", intro: "Here's your background-check link:" },
  caregiver_awaiting_stripe:    { linkType: "caregiver_payouts",         intro: "Here's a fresh payout-setup link:" },
};

/** Steps where a bare LINK reply is honored as the cooldown escape hatch. */
export function isGateLinkKeywordStep(step: string): boolean {
  return step in GATE_LINK_KEYWORD_TARGETS
    || step === "caregiver_awaiting_membership"
    || step === "caregiver_awaiting_mvr";
}

// ── Cross-surface helpers (stale-nudge cron, MCP send_onboarding_link) ───────

/**
 * The gate-awaiting step a given onboarding linkType parks the user at — the
 * step whose cooldown window a non-inbound send (cron nudge, agent tool call)
 * shares with the scripted resend path. null for link types with no parked
 * awaiting step.
 */
export function gateStepForLinkType(linkType: string): string | null {
  switch (linkType) {
    case "client_identity":            return "client_awaiting_identity";
    case "client_payment":             return "client_awaiting_payment";
    case "caregiver_photo":            return "caregiver_awaiting_photo";
    case "caregiver_documents":        return "caregiver_awaiting_documents";
    case "caregiver_background_check": return "caregiver_awaiting_bgcheck";
    case "caregiver_payouts":          return "caregiver_awaiting_stripe";
    case "caregiver_membership":       return "caregiver_awaiting_membership";
    default:                           return null;
  }
}

export interface GateLinkThrottleCheck {
  /** true = the session is parked at this linkType's gate step AND inside its cooldown window. */
  throttled:             boolean;
  step?:                 string;
  minutesSinceLastSend?: number;
}

/**
 * Should a non-inbound link send (MCP tool) be suppressed by the gate cooldown?
 * Throttles ONLY when the target session is parked at the linkType's own
 * gate-awaiting step and that step's window is open — a send for any other
 * linkType, a non-parked session, or missing/corrupt state proceeds untouched
 * (fail-open, same rule as the scripted path).
 */
export async function checkGateLinkThrottle(phone: string, linkType: string): Promise<GateLinkThrottleCheck> {
  const step = gateStepForLinkType(linkType);
  if (!step) return { throttled: false };
  try {
    const data = (await db().collection("agent_sessions").doc(phone).get()).data() as Record<string, unknown> | undefined;
    if (!data || data.onboardingStep !== step) return { throttled: false };
    const minutes = gateLinkCooldownMinutes(data, step);
    if (minutes === null) return { throttled: false };
    return { throttled: true, step, minutesSinceLastSend: minutes };
  } catch {
    return { throttled: false }; // fail-open: never wedge a link send on bookkeeping
  }
}

/**
 * After a REAL send of `linkType` to `phone`, open the cooldown window for the
 * matching gate step — but only when the session is actually parked there
 * (non-parked sessions keep their behavior unchanged; nothing to throttle).
 */
export async function stampGateLinkResentIfParked(phone: string, linkType: string): Promise<void> {
  const step = gateStepForLinkType(linkType);
  if (!step) return;
  try {
    const data = (await db().collection("agent_sessions").doc(phone).get()).data() as Record<string, unknown> | undefined;
    if (data?.onboardingStep !== step) return;
  } catch {
    return; // can't confirm parked-ness — don't invent a window
  }
  await stampGateLinkResent(phone, step);
}
