"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTurnMetrics = createTurnMetrics;
exports.emitTurnMetrics = emitTurnMetrics;
function createTurnMetrics(init) {
    return {
        phone: init.phone,
        userId: init.userId,
        userType: init.userType,
        pathway: init.pathway,
        isRetry: init.isRetry,
        inputChannel: init.inputChannel,
        startedAt: Date.now(),
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
function emitTurnMetrics(metrics, opts = {}) {
    var _a;
    const durationMs = Date.now() - metrics.startedAt;
    const reply = (_a = opts.reply) !== null && _a !== void 0 ? _a : "";
    // Dedupe toolNames defensively. Callers may push the same name multiple times
    // across iterations; we want a compact, distinct list for log readability.
    const toolNames = metrics.toolNames ? Array.from(new Set(metrics.toolNames)) : undefined;
    const payload = Object.assign(Object.assign({}, metrics), { toolNames,
        durationMs, replyLength: reply.length, replyEmpty: !reply.trim() });
    if (opts.error) {
        payload.errored = true;
        payload.errorClass = opts.error instanceof Error ? opts.error.constructor.name : typeof opts.error;
    }
    // startedAt isn't useful for downstream queries — durationMs supersedes it.
    delete payload.startedAt;
    console.info("cara.turn", payload);
}
//# sourceMappingURL=turnMetrics.js.map