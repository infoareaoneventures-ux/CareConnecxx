// Per-turn telemetry for Evia's two reply pathways (full QA agent + quick fast path).
//
// Every turn emits one structured log line so we can measure the four complaint
// dimensions from the roadmap: latency, memory recall, voice consistency, and
// correctness. Cloud Logging stores the lines for free and they can be exported
// to BigQuery via a logs router later if we need ad-hoc analytics.
//
// Design choices:
//   - No Firestore writes for clean baseline turns. Per-turn docs add cost that
//     doesn't pay back until we have a real product analytics need. Cloud
//     Logging is queryable enough for ordinary traffic; Firestore only mirrors
//     experiment-enrolled turns and quality/problem turns admins need to see.
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
  modelProvider?: "openai" | "anthropic";
  modelUsed?:     string;
  modelFallbackUsed?: boolean;

  // Flow class for this turn (from resolveLoopBudget, or "onboarding" when the
  // agent-native onboarding loop handled it). Lets canary dashboards filter the
  // onboarding cohort. Stable field — add-only.
  flowClass?:     string;
  // Onboarding canary signal: the loop produced a reply that re-greets /
  // re-introduces mid-conversation (banned by the onboarding directive). Detected
  // via onboardingEvalGraders.isReGreet on the final reply. Should be zero in
  // canary; a non-zero rate is a rollback trigger.
  onboardingReGreet?: boolean;

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
  // ch9 cost budget: token usage + estimated spend summed across the turn's
  // model calls, and whether the per-turn cost ceiling force-stopped the loop.
  inputTokens?:        number;
  outputTokens?:       number;
  costUsd?:            number;
  costBudgetExceeded?: boolean; // per-turn cost cap forced a final text reply

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
  conversationRepairTriggered?: boolean;
  conversationRepairApplied?:   boolean;
  supervisorRewriteApplied?:  boolean;

  // Conversational state
  emotionalContext?: "calm" | "anxious" | "grieving" | "frustrated" | "rushed" | "celebratory";
  emotionalTopic?:   "health" | "logistics" | "general"; // Sprint 8
  skill?:            string;  // name of the Agent Skill injected this turn, if any

  // Conversational-quality detectors. These record whether chatbot-like or
  // unsafe patterns remained visible around the final repair/supervision path.
  confidenceClaimDetected?:  boolean; // unattributed proper-name + factual claim
  promiseWithoutToolCall?:   boolean; // "let me check" with metrics.toolCalls === 0
  recipeWithoutBackingTool?: boolean; // advertised a recipe that has no shipped backing tool
  contextIgnoredWhenPresent?: boolean; // live ops context existed but reply stayed generic
  paymentAuthorityLeakDetected?: boolean; // payment approval/payment wording leaked to unauthorized family context
  multiQuestionDataCollection?: boolean; // asks for multiple intake fields in one reply
  supportDeflectionDetected?:   boolean; // punts to support/team/Evia instead of acting
  genericHelpAskDetected?:      boolean; // "what can I help with" style generic prompt
  medicationInstructionDetected?: boolean; // gives medication/dosing instruction instead of redirecting
  frustrationDetected?: boolean; // user shows explicit frustration with Evia/system
  rephraseLoopDetected?: boolean; // user repeats/rephrases a request from recent history
  repeatedGreetingDetected?: boolean; // user repeats a greeting because Evia did not move forward
  agentSelfRepeatDetected?: boolean; // EVIA about to send a near-duplicate of her own recent outbound (ch10 broken-record)
  agentSelfRepeatRewritten?: boolean; // the self-repeat guard produced a varied reply instead of resending
  humanHandoffTriggered?: boolean; // low-confidence gate handed the thread to a human (ch10 overcommitted-guess)
  humanHandoffSuppressed?: boolean; // handoff regex fired but the grounding check found the claim supported (FP candidate)

  // Sprint 8: tone-warmth-v1 adherence proxy. True when the reply opens with an
  // empathy reflection AND the turn was non-calm. Lets us measure whether the
  // experiment's treatment arm actually changed behavior.
  warmthReflectionIncluded?: boolean;

  // Sprint 8: which memory tier supplied context this turn, and how many
  // learned facts were retrieved. Lets us measure recall health over time.
  memoryRecallTier?:     "zep" | "memoryFiles" | "learnedFacts" | "none";
  memoryFactsRetrieved?: number;

  // U3: truncation/degradation telemetry — makes mechanical forgetting
  // measurable instead of silent. historyRolledUp is true when this turn's
  // background maybeRollUpHistory call actually folded messages into the
  // summary row (not just checked and no-opped). zepContextEmpty is true when
  // getZepContext resolved to "" (not the unavailable-marker case, which
  // zepUnavailable already covers — this is Zep responding but having nothing).
  // learnedFactsCount mirrors memoryFactsRetrieved's value at load time so it
  // survives independently of memoryRecallTier's derivation.
  historyRolledUp?:   boolean;
  zepContextEmpty?:   boolean;
  learnedFactsCount?: number;

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

const QUALITY_FLAG_MAP: Array<[keyof TurnMetrics, string]> = [
  ["conversationRepairTriggered", "conversation_repair_triggered"],
  ["conversationRepairApplied", "conversation_repair_applied"],
  ["supportDeflectionDetected", "support_deflection_detected"],
  ["genericHelpAskDetected", "generic_help_ask_detected"],
  ["medicationInstructionDetected", "medication_instruction_detected"],
  ["confidenceClaimDetected", "confidence_claim_detected"],
  ["promiseWithoutToolCall", "promise_without_tool_call"],
  ["recipeWithoutBackingTool", "recipe_without_backing_tool"],
  ["contextIgnoredWhenPresent", "context_ignored_when_present"],
  ["paymentAuthorityLeakDetected", "payment_authority_leak_detected"],
  ["multiQuestionDataCollection", "multi_question_data_collection"],
  ["frustrationDetected", "frustration_detected"],
  ["rephraseLoopDetected", "rephrase_loop_detected"],
  ["repeatedGreetingDetected", "repeated_greeting_detected"],
  ["agentSelfRepeatDetected", "agent_self_repeat_detected"],
  ["agentSelfRepeatRewritten", "agent_self_repeat_rewritten"],
  ["humanHandoffTriggered", "human_handoff_triggered"],
  ["humanHandoffSuppressed", "human_handoff_suppressed"],
  ["groundingTriggered", "grounding_triggered"],
  ["formatRevisionTriggered", "format_revision_triggered"],
  ["postProcessModified", "post_process_modified"],
  ["exhausted", "agent_loop_exhausted"],
  ["recoveryFired", "recovery_fired"],
  ["costBudgetExceeded", "cost_budget_exceeded"],
  ["resumedFromCheckpoint", "resumed_from_checkpoint"],
  ["onboardingReGreet", "onboarding_re_greet"],
];

function buildQualityFlags(metrics: TurnMetrics, payload: Record<string, unknown>): string[] {
  const flags = new Set<string>();

  for (const [field, flag] of QUALITY_FLAG_MAP) {
    if (metrics[field]) flags.add(flag);
  }

  if (payload.errored) flags.add("turn_errored");
  if (payload.replyEmpty) flags.add("reply_empty");
  if ((metrics.toolErrors ?? 0) > 0) flags.add("tool_error");
  if ((metrics.truncations ?? 0) > 0) flags.add("tool_truncation");

  return Array.from(flags).sort();
}

let turnMetricMirrorOverride: ((record: Record<string, unknown>) => void) | null = null;

export function setTurnMetricMirrorForTest(fn: ((record: Record<string, unknown>) => void) | null): void {
  turnMetricMirrorOverride = fn;
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
    quickReplyUsed: metrics.pathway === "quick",
    fallbackPathUsed: !!metrics.exhausted || !!metrics.recoveryFired,
  };

  if (opts.error) {
    payload.errored = true;
    payload.errorClass = opts.error instanceof Error ? opts.error.constructor.name : typeof opts.error;
    payload.fallbackPathUsed = true;
  }

  const qualityFlags = buildQualityFlags(metrics, payload);
  if (qualityFlags.length > 0) {
    payload.qualityFlags = qualityFlags;
  }

  // startedAt isn't useful for downstream queries — durationMs supersedes it.
  delete (payload as { startedAt?: number }).startedAt;

  console.info("cara.turn", payload);

  // Bounded Firestore mirror — ONLY for experiment-enrolled turns (a small
  // fraction of traffic), so the weekly experiment scorecard (experimentScorecard.ts)
  // can aggregate per-variant outcomes. This is the minimal store needed to
  // CLOSE the improvement loop; non-experiment turns still write nothing, so the
  // module's "no per-turn writes" cost stance holds for the common case.
  // Current policy: mirror experiments plus quality/problem turns; clean
  // baseline turns still skip Firestore writes.
  // Onboarding canary turns mirror UNCONDITIONALLY so the canary watch has the
  // full latency/completion distribution, not just flagged problems. This only
  // fires while ONBOARDING_AGENT_LOOP is on (flowClass is "onboarding" only in the
  // agent-native loop), so the "no per-turn writes for baseline traffic" stance
  // holds whenever the flag is off.
  const hasExperiments = !!metrics.experiments && Object.keys(metrics.experiments).length > 0;
  const isOnboardingTurn = metrics.flowClass === "onboarding";
  if (hasExperiments || qualityFlags.length > 0 || isOnboardingTurn) {
    mirrorTurnMetricRecord({
      source:                    "turn_metrics",
      at:                        new Date().toISOString(),
      phone:                     metrics.phone,
      userId:                    metrics.userId ?? null,
      userType:                  metrics.userType,
      inputChannel:              metrics.inputChannel ?? null,
      pathway:                   metrics.pathway,
      modelProvider:             metrics.modelProvider ?? null,
      modelUsed:                 metrics.modelUsed ?? null,
      modelFallbackUsed:         !!metrics.modelFallbackUsed,
      flowClass:                 metrics.flowClass ?? null,
      onboardingReGreet:         !!metrics.onboardingReGreet,
      iterations:                metrics.iterations ?? null,
      inputTokens:               metrics.inputTokens ?? null,
      outputTokens:              metrics.outputTokens ?? null,
      costUsd:                   metrics.costUsd ?? null,
      costBudgetExceeded:        !!metrics.costBudgetExceeded,
      exhausted:                 !!metrics.exhausted,
      experiments:               metrics.experiments ?? null,
      qualityFlags,
      errored:                   !!payload.errored,
      errorClass:                payload.errorClass ?? null,
      replyEmpty:                !!payload.replyEmpty,
      durationMs,
      quickReplyUsed:            metrics.pathway === "quick",
      fallbackPathUsed:          !!payload.fallbackPathUsed,
      toolErrors:                metrics.toolErrors ?? 0,
      toolNames:                 toolNames ?? [],
      warmthReflectionIncluded:  metrics.warmthReflectionIncluded ?? null,
      conversationRepairTriggered: !!metrics.conversationRepairTriggered,
      conversationRepairApplied:   !!metrics.conversationRepairApplied,
      supportDeflectionDetected:   !!metrics.supportDeflectionDetected,
      genericHelpAskDetected:      !!metrics.genericHelpAskDetected,
      medicationInstructionDetected: !!metrics.medicationInstructionDetected,
      confidenceClaimDetected:      !!metrics.confidenceClaimDetected,
      promiseWithoutToolCall:       !!metrics.promiseWithoutToolCall,
      recipeWithoutBackingTool:     !!metrics.recipeWithoutBackingTool,
      contextIgnoredWhenPresent:    !!metrics.contextIgnoredWhenPresent,
      paymentAuthorityLeakDetected: !!metrics.paymentAuthorityLeakDetected,
      multiQuestionDataCollection:  !!metrics.multiQuestionDataCollection,
      frustrationDetected:          !!metrics.frustrationDetected,
      rephraseLoopDetected:         !!metrics.rephraseLoopDetected,
      repeatedGreetingDetected:     !!metrics.repeatedGreetingDetected,
      agentSelfRepeatDetected:      !!metrics.agentSelfRepeatDetected,
      agentSelfRepeatRewritten:     !!metrics.agentSelfRepeatRewritten,
      humanHandoffTriggered:        !!metrics.humanHandoffTriggered,
      humanHandoffSuppressed:       !!metrics.humanHandoffSuppressed,
      historyRolledUp:              !!metrics.historyRolledUp,
      zepContextEmpty:              !!metrics.zepContextEmpty,
      learnedFactsCount:            metrics.learnedFactsCount ?? 0,
    });
  }
}

// Fire-and-forget, fully guarded so it never touches the hot path or throws
// into a caller (and stays harmless in tests without firebase-admin init).
function mirrorTurnMetricRecord(record: Record<string, unknown>): void {
  if (turnMetricMirrorOverride) {
    turnMetricMirrorOverride(record);
    return;
  }
  try {
    // Lazy require so module load never depends on admin being initialized.
    const admin = require("firebase-admin") as typeof import("firebase-admin");
    admin.firestore().collection("cara_turn_metrics").add(record).catch(() => {});
  } catch {
    /* no-op */
  }
}
