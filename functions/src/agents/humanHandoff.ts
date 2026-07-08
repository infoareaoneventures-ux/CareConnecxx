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
  "(cached account, visit, and care data it was given), the RECENT CONVERSATION, the results of " +
  "any TOOLS it called THIS turn, and a DRAFT message it wants to send. Decide whether every " +
  "specific factual or action claim in the DRAFT (who is coming/available, what was " +
  "scheduled/confirmed/cancelled/paid, dates, times, amounts, medical facts) is supported by the " +
  "CONTEXT, the RECENT CONVERSATION, or the TOOL RESULTS. Paraphrase and warm framing are fine — " +
  "only flag claims whose substance appears NOWHERE in the provided material. " +
  "Reply with exactly one word: SUPPORTED or UNSUPPORTED.";

// Bound the payload so a huge system prompt can't blow up quick-tier cost.
const GROUNDING_CONTEXT_MAX_CHARS = 12_000;
// Tool observations from this turn are the freshest grounding source, but can be
// verbose (full care plans, message lists) — bound them separately.
const GROUNDING_TOOL_MAX_CHARS = 8_000;

export function buildHandoffGroundingPayload(
  systemContext: string,
  recentHistory: Array<{ role: "user" | "assistant"; content: string }>,
  draftReply: string,
  toolObservations = "",
): string {
  const historyTail = (recentHistory ?? [])
    .slice(-8)
    .map(row => `${row.role === "user" ? "USER" : "ASSISTANT"}: ${row.content}`)
    .join("\n");
  return [
    "CONTEXT:",
    (systemContext ?? "").slice(0, GROUNDING_CONTEXT_MAX_CHARS),
    "",
    "RECENT CONVERSATION:",
    historyTail || "(none)",
    "",
    "TOOL RESULTS THIS TURN:",
    (toolObservations ?? "").slice(0, GROUNDING_TOOL_MAX_CHARS) || "(none)",
    "",
    "DRAFT:",
    draftReply,
  ].join("\n");
}

// Only an explicit UNSUPPORTED hands off; anything else — SUPPORTED, an empty
// string, or model rambling — fails open to sending. The gate must earn the
// handoff, never default into it.
export function parseHandoffGroundingVerdict(raw: string): "supported" | "unsupported" {
  return /\bUNSUPPORTED\b/i.test(raw ?? "") ? "unsupported" : "supported";
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
