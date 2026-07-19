// Low-confidence human handoff (ch10 "overcommitted guess" gate).
//
// When Evia is about to assert an action/fact she has NOT backed with a tool
// this turn, that's the confident-wrong-answer failure mode. Rather than send
// the guess, she hands the thread to a teammate, pauses herself, and pages ops.
//
// NOTE ON VOICE: Evia's default persona never punts the user to a "team"
// (safety/supervisor.ts bans that phrasing). This gate is a deliberate,
// founder-approved exception for the low-confidence case — the copy here is the
// ONE sanctioned handoff line, and it is applied AFTER supervise() so the lint
// doesn't strip it. It is kill-switchable at runtime (CARA_CONFIDENCE_HANDOFF
// =false) and self-healing (the hold auto-expires so a thread is never stranded
// if no human picks it up).
//
// This module stays pure (copy + predicates + TTL) so the trigger logic is unit
// testable without Firestore; qaAgent owns the session write + ops-alert calls.

import {
  type GroundingClaim,
  type GroundingClaimCategory,
} from "./groundingClaims";

// The one sanctioned handoff line. Warm, first-person, sets the expectation
// without a robotic "our support team will contact you" punt.
export const HUMAN_HANDOFF_COPY =
  "I want to get this exactly right, so I'm looping in a teammate to double-check — they'll follow up with you shortly. 💙";

// Shown on the WEB chat surface while a thread is held (SMS stays silent so we
// don't re-text the same hold every message — and don't trip the self-repeat
// guard). The initial handoff line already set expectations for SMS users.
export const HUMAN_HANDOFF_HELD_COPY =
  "My teammate still has this one — they'll be in touch. I'll jump back in if you need anything else in the meantime.";

// How long a held thread stays paused before Evia resumes automatically. This
// is the fail-safe: with no live human-takeover surface, a permanent pause would
// strand the user, so the hold self-expires. Overridable via env.
export function handoffTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CARA_HUMAN_HANDOFF_TTL_MIN;
  const parsed = raw ? Number(raw) : NaN;
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return minutes * 60_000;
}

// The gate is ON by default (founder decision). Flip CARA_CONFIDENCE_HANDOFF
// =false to disable instantly without a redeploy if it over-triggers.
export function isHandoffGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CARA_CONFIDENCE_HANDOFF ?? "").trim().toLowerCase() !== "false";
}

// Is THIS reply a CANDIDATE for handoff — i.e. worth running the context-aware
// grounding check on? True when Evia makes a confidence claim (asserted
// availability, an action like "I confirmed…", a name/role/date/amount, or a
// medical fact). Never during onboarding (its own flow owns confirmation) or on
// non-user channels (triggers/agent relays aren't answering a person).
//
// NOTE (2026-07-07): we no longer gate on `toolCallsThisTurn === 0`. A tool
// CALL doesn't prove the claim is backed — Evia can call a tool and then
// embellish beyond what it returned (tool gives a date, she invents a time).
// So tool-backed turns are candidates too; the grounding check below decides,
// with THIS turn's tool observations fed into its payload so genuinely-backed
// claims read as SUPPORTED. `toolCallsThisTurn` is retained for telemetry only.
export function shouldHandOffToHuman(args: {
  confidenceClaimDetected: boolean;
  toolCallsThisTurn?: number;
  onboardingMode: boolean;
  isUserChannel: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  if (!isHandoffGateEnabled(args.env)) return false;
  if (args.onboardingMode || !args.isUserChannel) return false;
  return args.confidenceClaimDetected;
}

// ── Grounding check (FP guard, 2026-07-06 follow-up) ─────────────────────────
// The regex trigger (detectConfidenceClaim + 0 tool calls) over-fires on the
// MAINLINE flow: core context pre-injects visit/care-team facts precisely so
// Evia answers WITHOUT tools ("Maria is coming Tuesday" from cached context),
// and "I scheduled that yesterday" legitimately references a PRIOR turn's tool
// run. A claim isn't "unbacked" when it's derivable from the injected context
// or conversation — so before handing off, a quick-tier LLM verdict checks
// supportedness. UNSUPPORTED → hand off (the true invented-fact case).
// SUPPORTED, garbage, or checker error → send normally (fail-open to the
// pre-gate behavior) and log the candidate for tuning.

export const HANDOFF_GROUNDING_SYSTEM_PROMPT =
  "You are a fact-check gate for an SMS care assistant. You get the assistant's CONTEXT " +
  "(cached account, visit, and care data it was given), the RECENT CONVERSATION, the user's " +
  "CURRENT MESSAGE (the message being replied to right now), the results of " +
  "any TOOLS it called THIS turn, and a DRAFT message it wants to send. Decide whether every " +
  "specific factual or action claim in the DRAFT (who is coming/available, what was " +
  "scheduled/confirmed/cancelled/paid, dates, times, amounts, medical facts, ages, locations, " +
  "relationships) is supported by the CONTEXT, the RECENT CONVERSATION, the CURRENT MESSAGE, " +
  "or the TOOL RESULTS. A draft that truthfully repeats or confirms a fact the user just shared " +
  "in the CURRENT MESSAGE is SUPPORTED. Paraphrase and warm framing are fine — " +
  "only flag claims whose substance appears NOWHERE in the provided material. " +
  "Reply with exactly one word: SUPPORTED or UNSUPPORTED.";

// Bound the payload so a huge system prompt can't blow up quick-tier cost.
const GROUNDING_CONTEXT_MAX_CHARS = 12_000;
// Tool observations from this turn are the freshest grounding source, but can be
// verbose (full care plans, message lists) — bound them separately.
const GROUNDING_TOOL_MAX_CHARS = 8_000;
// The current inbound is one SMS/web message; bound defensively anyway.
const GROUNDING_INBOUND_MAX_CHARS = 2_000;

// Head+tail slice for the cost caps above. The facts that back a claim can sit
// ANYWHERE in the material (core context up front, care plan / snapshot appended
// near the end; a claim usually cites the LAST tool called) — so a head-only
// `slice(0, max)` could cut off exactly the section that supports the claim,
// turning a true fact into an UNSUPPORTED verdict and a false human hold. Keep
// both ends with an elision marker instead, at the same cost cap.
export function headTailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[…middle truncated…]\n${text.slice(text.length - tail)}`;
}

// R19: the CURRENT USER MESSAGE is its own explicit evidence block. Prior
// history alone is not enough — a draft that truthfully repeats a fact the
// user shared IN THIS TURN ("my mom is 82" → "Got it, since she's 82…") must
// read as SUPPORTED, and `recentHistory` only carries turns persisted BEFORE
// this one.
export function buildHandoffGroundingPayload(
  systemContext: string,
  recentHistory: Array<{ role: "user" | "assistant"; content: string }>,
  draftReply: string,
  toolObservations = "",
  currentInbound = "",
): string {
  const historyTail = (recentHistory ?? [])
    .slice(-8)
    .map(row => `${row.role === "user" ? "USER" : "ASSISTANT"}: ${row.content}`)
    .join("\n");
  return [
    "CONTEXT:",
    headTailSlice(systemContext ?? "", GROUNDING_CONTEXT_MAX_CHARS),
    "",
    "RECENT CONVERSATION:",
    historyTail || "(none)",
    "",
    "CURRENT USER MESSAGE:",
    headTailSlice(currentInbound ?? "", GROUNDING_INBOUND_MAX_CHARS) || "(none)",
    "",
    "TOOL RESULTS THIS TURN:",
    headTailSlice(toolObservations ?? "", GROUNDING_TOOL_MAX_CHARS) || "(none)",
    "",
    "DRAFT:",
    draftReply,
  ].join("\n");
}

// LEGACY (pre-U7) verdict parse — only an explicit UNSUPPORTED hands off;
// anything else — SUPPORTED, an empty string, or model rambling — fails open to
// sending. Kept callable as the documented fallback path used when the
// GROUNDING_RISK_TIERS_ENABLED kill switch is OFF (rollout can restore the
// exact pre-U7 fail-open behavior instantly, no redeploy).
export function parseHandoffGroundingVerdict(raw: string): "supported" | "unsupported" {
  return /\bUNSUPPORTED\b/i.test(raw ?? "") ? "unsupported" : "supported";
}

// ── U7: risk-tier grounding (R18/R19/R21) ─────────────────────────────────────

export type GroundingVerdict = "supported" | "unsupported" | "indeterminate";

// Typed, STRICT verdict parse. Unlike the legacy parse above, garbage, empty
// output, a timeout, or model rambling is `indeterminate` — never silently
// `supported`. The gate then decides by risk tier: high-risk indeterminate
// fails CLOSED to deterministic neutral copy; low-risk keeps the documented
// fail-open fallback. (\bSUPPORTED\b cannot match inside "UNSUPPORTED" — no
// word boundary before the S.)
export function parseGroundingVerdictTyped(raw: unknown): GroundingVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (/\bUNSUPPORTED\b/i.test(s)) return "unsupported";
  if (/\bSUPPORTED\b/i.test(s)) return "supported";
  return "indeterminate";
}

// Kill switch for the risk-tier gate. Default ON (absent = on); set
// GROUNDING_RISK_TIERS_ENABLED=false to fall back to the pre-U7 detector +
// fail-open verdict path instantly without a redeploy. Same style as
// CARA_CONFIDENCE_HANDOFF above / multiRecipientScopingEnabled.
export function isRiskTierGroundingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.GROUNDING_RISK_TIERS_ENABLED ?? "").trim().toLowerCase() !== "false";
}

// Deterministic category-specific neutral copy for HIGH-RISK claims whose
// verification came back indeterminate (garbage verdict, checker error, or
// timeout). Honest "let me double-check" in Evia's warm first-person voice —
// no invented facts, no punt to a "team" (that phrasing is reserved for the
// sanctioned HUMAN_HANDOFF_COPY above). These strings are deterministic safety
// copy: they must never themselves classify as grounding claims (tested), so
// the gate can't loop on its own output.
export type NeutralCopyCategory = "medical" | "identity" | "action" | "payment";

export const GROUNDING_NEUTRAL_COPY: Record<NeutralCopyCategory, string> = {
  medical:
    "I want to be extra careful with health details, so let me double-check that before I say anything for certain. I'll follow up with you shortly. 💙",
  identity:
    "I want to make sure I have the right person and details before I confirm that — let me double-check and follow up with you shortly.",
  action:
    "I don't want to tell you something's done unless I'm completely sure — let me verify it and follow up with you shortly.",
  payment:
    "Money details need to be exact, so let me double-check that before I confirm anything. I'll follow up with you shortly.",
};

// Claim category → neutral-copy family. Medical outranks payment outranks
// action outranks identity when a draft carries several high-risk categories —
// health copy is the most conservative thing to say.
const NEUTRAL_COPY_FAMILY: Partial<Record<GroundingClaimCategory, NeutralCopyCategory>> = {
  medical_condition: "medical",
  allergy: "medical",
  medical_event: "medical",
  money_payment: "payment",
  action_authorization: "action",
  relationship_identity: "identity",
};

const NEUTRAL_COPY_PRIORITY: ReadonlyArray<NeutralCopyCategory> = ["medical", "payment", "action", "identity"];

export function neutralCopyForClaims(claims: ReadonlyArray<GroundingClaim>): string | null {
  const families = new Set<NeutralCopyCategory>();
  for (const claim of claims) {
    if (claim.risk !== "high") continue;
    const family = NEUTRAL_COPY_FAMILY[claim.category];
    if (family) families.add(family);
  }
  for (const family of NEUTRAL_COPY_PRIORITY) {
    if (families.has(family)) return GROUNDING_NEUTRAL_COPY[family];
  }
  return null;
}

// Pure gate decision for a claim-bearing draft, given the typed verdict:
//   unsupported            → handoff   (the true invented-fact case — existing
//                                       behavior: HUMAN_HANDOFF_COPY + hold)
//   supported              → send      (grounded claims pass unchanged)
//   indeterminate + high   → neutralize (fail CLOSED to deterministic
//                                        category-specific neutral copy; a
//                                        checker outage must not ship an
//                                        unverifiable medical/identity/action/
//                                        payment claim — and must not page a
//                                        human either)
//   indeterminate + low    → send      (DOCUMENTED FALLBACK: pre-U7 fail-open
//                                       behavior preserved — the downside is a
//                                       possibly-wrong schedule/availability/
//                                       age/location detail, logged for tuning,
//                                       never a stranded thread)
// With the kill switch off the caller never reaches indeterminate (legacy
// parse maps garbage → supported), but resolve defensively to "send" anyway.
export type GroundingGateAction = "send" | "neutralize" | "handoff";

export function resolveGroundingGateAction(args: {
  verdict: GroundingVerdict;
  claims: ReadonlyArray<GroundingClaim>;
  riskTiersEnabled: boolean;
}): GroundingGateAction {
  if (args.verdict === "unsupported") return "handoff";
  if (args.verdict === "supported") return "send";
  if (args.riskTiersEnabled && neutralCopyForClaims(args.claims)) return "neutralize";
  return "send";
}

// Is this session currently in an active (non-expired) human hold?
export function isHandoffActive(
  session: Record<string, unknown> | undefined,
  nowMs: number,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!session || session.handedToHuman !== true) return false;
  const atRaw = session.handedToHumanAt;
  const at = typeof atRaw === "string" ? Date.parse(atRaw) : typeof atRaw === "number" ? atRaw : NaN;
  if (!Number.isFinite(at)) return false; // no/garbled timestamp → treat as expired (fail-open to answering)
  return nowMs - at < handoffTtlMs(env);
}
