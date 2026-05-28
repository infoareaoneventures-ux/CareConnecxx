// Per-turn telemetry for Cara's two reply pathways (full QA agent + quick fast path).
//
// Every turn emits one structured log line so we can measure the four complaint
// dimensions from the roadmap: latency, memory recall, voice consistency, and
// correctness. Cloud Logging stores the lines for free and they can be exported
// to BigQuery via a logs router later if we need ad-hoc analytics.
//
// Design choices:
//   - No Firestore writes per turn. Per-turn doc adds cost that doesn't pay back
//     until we have a real product analytics need. Cloud Logging is queryable
//     enough for sprint-1 tuning.
//   - Stable field names so dashboard queries don't break. Add new fields freely;
//     do not rename existing ones.
//   - No PII. Phone is a stable identifier already logged elsewhere. Message
//     text and tool inputs/outputs are never included.
//   - Both pathways emit `cara.turn` with `pathway` distinguishing them, so a
//     single Cloud Logging filter (`jsonPayload.event="cara.turn"`) sees both.

export type TurnPathway = "qa" | "quick";

export interface TurnMetrics {
  // Identity (no PII beyond phone, which is already the routing key in logs)
  phone:    string;
  userId?:  string;
  userType: "client" | "caregiver";

  // Pathway + entry conditions
  pathway:       TurnPathway;
  isRetry?:      boolean;
  inputChannel?: "USER" | "TRIGGER" | "AGENT" | "SYSTEM";

  // Performance
  startedAt:      number;     // ms epoch — used by emitTurnMetrics to compute durationMs
  durationMs?:    number;     // filled by emit
  contextLoadMs?: number;     // wall-clock for the parallel context fetch

  // Tool-use loop (qa pathway)
  iterations?:     number;    // final iteration count when loop exited
  toolCalls?:      number;    // total successful tool invocations across iterations
  toolNames?:      string[];  // distinct tool names called (deduped at emit)
  toolErrors?:     number;    // tool returns with _toolError === true
  truncations?:    number;    // stop_reason === "max_tokens" with tool_use present
  patchedOrphans?: number;    // placeholders injected by patchDanglingToolCalls
  toolArgsTruncated?: number; // tool_use input args clipped by truncateOldToolCallArgs
  exhausted?:      boolean;   // loop exited the for-block without producing reply text
  recoveryFired?:  boolean;   // recovery sub-agent fired after 2+ consecutive error iterations

  // Quality signals
  prefetchHit?:             boolean;
  zepUnavailable?:          boolean;
  groundingTriggered?:      boolean;  // grounding pass fired (detected hedging+medical)
  formatRevisionTriggered?: boolean;  // format pass fired (detected list-shape)
  postProcessModified?:     boolean;  // ANY post-process rewrite changed the reply (derived)

  // Sprint 8: discrete "did the rewrite actually change the text?" flags. The
  // *Triggered flags above record that a pass FIRED; these record that it
  // MODIFIED. postProcessModified is now derived = grounding||format||supervisor.
  groundingRewriteApplied?:   boolean;
  formatRewriteApplied?:      boolean;
  supervisorRewriteApplied?:  boolean;

  // Conversational state
  emotionalContext?: "calm" | "anxious" | "grieving" | "frustrated" | "rushed" | "celebratory";
  emotionalTopic?:   "health" | "logistics" | "general"; // Sprint 8
  skill?:            string;  // name of the Agent Skill injected this turn, if any

  // Sprint 8: log-only conversational-quality detectors. No reply rewriting
  // attached to these flags; we measure baseline rates first, then decide
  // whether the false-positive rate is low enough to add an auto-rewrite.
  confidenceClaimDetected?:  boolean; // unattributed proper-name + factual claim
  promiseWithoutToolCall?:   boolean; // "let me check" with metrics.toolCalls === 0

  // Sprint 8: tone-warmth-v1 adherence proxy. True when the reply opens with an
  // empathy reflection AND the turn was non-calm. Lets us measure whether the
  // experiment's treatment arm actually changed behavior.
  warmthReflectionIncluded?: boolean;

  // Sprint 8: which memory tier supplied context this turn, and how many
  // learned facts were retrieved. Lets us measure recall health over time.
  memoryRecallTier?:     "zep" | "memoryFiles" | "learnedFacts" | "none";
  memoryFactsRetrieved?: number;

  // Sprint 8: turn checkpoint resume. resumedFromCheckpoint is true when this
  // turn skipped the tool loop and resumed a prior crashed turn's reply.
  resumedFromCheckpoint?: boolean;
  checkpointPhase?:       string;

  // Prompt-augmentation pipeline (Sprint 7).
  // augmentersApplied — kebab-case names of every PromptAugmenter that emitted a non-empty directive.
  // experiments      — experimentKey → variantName for each active A/B experiment the user is in.
  augmentersApplied?: string[];
  experiments?:       Record<string, string>;

  // Output
  replyLength?: number;
  replyEmpty?:  boolean;

  // Error path
  errored?:    boolean;
  errorClass?: string;
}

export function createTurnMetrics(init: {
  phone:         string;
  userId?:       string;
  userType:      "client" | "caregiver";
  pathway:       TurnPathway;
  isRetry?:      boolean;
  inputChannel?: TurnMetrics["inputChannel"];
}): TurnMetrics {
  return {
    phone:        init.phone,
    userId:       init.userId,
    userType:     init.userType,
    pathway:      init.pathway,
    isRetry:      init.isRetry,
    inputChannel: init.inputChannel,
    startedAt:    Date.now(),
  };
}

// Single log emission. Pass the reply text so we can record length without
// keeping PII around in callers' metrics objects. Pass an error to flag the
// error path; the catch site is the right place to call this once.
//
// Emits in the codebase-conventional shape:
//   console.info("cara.turn", { ...fields })
// Matches the existing `console.info("qaAgent.toolUse", {...})` pattern so
// Cloud Logging filters built on label string + jsonPayload work for both.
export function emitTurnMetrics(metrics: TurnMetrics, opts: { reply?: string; error?: unknown } = {}): void {
  const durationMs = Date.now() - metrics.startedAt;
  const reply = opts.reply ?? "";

  // Dedupe toolNames defensively. Callers may push the same name multiple times
  // across iterations; we want a compact, distinct list for log readability.
  const toolNames = metrics.toolNames ? Array.from(new Set(metrics.toolNames)) : undefined;

  const payload: Record<string, unknown> = {
    ...metrics,
    toolNames,
    durationMs,
    replyLength: reply.length,
    replyEmpty: !reply.trim(),
  };

  if (opts.error) {
    payload.errored = true;
    payload.errorClass = opts.error instanceof Error ? opts.error.constructor.name : typeof opts.error;
  }

  // startedAt isn't useful for downstream queries — durationMs supersedes it.
  delete (payload as { startedAt?: number }).startedAt;

  console.info("cara.turn", payload);
}
