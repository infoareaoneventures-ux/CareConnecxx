"use strict";
// Handles inbound family/caregiver replies when a pending irreversible
// action is awaiting confirmation. Runs BEFORE the main intent classifier
// in the webhook dispatch order, because once Cara has proposed
// "cancel Tuesday's visit — yes or no?", the natural-language flexibility
// of the reply ("yeah", "go ahead", "actually no", "wait what time was
// it") needs a focused classifier instead of the 50-intent generalist.
//
// Returns "handled" when the message was a clear YES or NO (the caller
// should NOT continue to the QA agent). Returns "fallthrough" when the
// reply isn't a clear decision (e.g. a follow-up question) so the caller
// can run the normal QA agent path with the pending action surfaced as
// system context.
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyApproval = classifyApproval;
exports.handlePendingApproval = handlePendingApproval;
const openaiClient_1 = require("../utils/openaiClient");
const client_1 = require("../linq/client");
const pendingActions_1 = require("./pendingActions");
const server_1 = require("../mcp/server");
// Trivial fast paths — common single-word answers we can classify without
// an LLM call. Saves 300–500ms on the common case.
const TRIVIAL_YES = new Set(["YES", "Y", "YEAH", "YEP", "YUP", "OK", "OKAY", "SURE", "CONFIRM", "CONFIRMED", "GO AHEAD", "DO IT", "GO", "PROCEED", "APPROVED"]);
const TRIVIAL_NO = new Set(["NO", "N", "NOPE", "NAH", "STOP", "WAIT", "CANCEL", "DON'T", "DONT", "NEVER MIND", "NEVERMIND", "ACTUALLY NO", "FORGET IT"]);
async function classifyApproval(text, actionPreview) {
    const trimmed = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
    if (TRIVIAL_YES.has(trimmed))
        return "YES";
    if (TRIVIAL_NO.has(trimmed))
        return "NO";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const raw = await (0, openaiClient_1.quickComplete)("You classify a family member's reply to a confirmation prompt from a care assistant. " +
            `The assistant asked them to confirm this irreversible action: "${actionPreview}". ` +
            "Reply with exactly one word: YES, NO, or QUESTION. " +
            "YES = clear approval to proceed (e.g. 'yes', 'go ahead', 'sounds right', 'do it'). " +
            "NO = clear refusal or change of mind (e.g. 'no', 'wait', 'actually don't', 'never mind'). " +
            "QUESTION = anything else, including clarifying questions, hedged replies, off-topic messages, " +
            "or requests for more info. If you are unsure, prefer QUESTION over YES — confirming an irreversible " +
            "action by accident is much worse than asking again.", text, { maxTokens: 5, signal: controller.signal });
        clearTimeout(timer);
        const label = raw.trim().toUpperCase();
        if (label === "YES" || label === "NO" || label === "QUESTION")
            return label;
        return "QUESTION";
    }
    catch (err) {
        clearTimeout(timer);
        console.warn("classifyApproval: error, defaulting to QUESTION", err instanceof Error ? err.message : err);
        return "QUESTION"; // fail-safe — never auto-execute on classifier failure
    }
}
// Main entry point. Loads or accepts the pending action, classifies the
// reply, and executes / rejects / falls through as appropriate.
async function handlePendingApproval(params) {
    const { phone, chatId, text, userId, userType = "client", pending } = params;
    const decision = await classifyApproval(text, pending.preview);
    if (decision === "QUESTION") {
        // Don't resolve the pending action — let the QA agent answer the question
        // and re-prompt for confirmation. The webhook caller treats this as a
        // normal QA turn but should inject context about the pending action
        // so Cara knows what's still awaiting confirmation.
        return { outcome: "fallthrough", reason: "question" };
    }
    if (decision === "NO") {
        await (0, pendingActions_1.resolvePendingAction)(pending.id, "rejected");
        await (0, client_1.sendMessage)(chatId, "Got it — leaving things as they are.").catch((err) => {
            console.error("handlePendingApproval: sendMessage (NO) failed", err);
        });
        return { outcome: "handled" };
    }
    // decision === "YES" — execute the tool with the bypass flag set.
    console.info("approvalHandler.execute", {
        phone,
        actionId: pending.id,
        toolName: pending.toolName,
    });
    const dispatch = userType === "caregiver" ? server_1.handleToolCallForCaregiver : server_1.handleToolCall;
    // Inject identifiers + the bypass flag so the MCP gate executes instead of
    // re-proposing. _confirmedActionId is read by the MCP gate; see mcp/server.ts.
    const enrichedInput = Object.assign(Object.assign(Object.assign(Object.assign({}, pending.toolInput), { phone,
        chatId }), (userId ? { clientId: userId, userId } : {})), { _confirmedActionId: pending.id });
    let executionPreview = "";
    let succeeded = false;
    try {
        const result = await dispatch(pending.toolName, enrichedInput);
        succeeded = !(result === null || result === void 0 ? void 0 : result._toolError) &&
            !(result === null || result === void 0 ? void 0 : result.error);
        executionPreview = JSON.stringify(result).slice(0, 500);
    }
    catch (err) {
        console.error("approvalHandler: tool execution failed", { actionId: pending.id, err });
        executionPreview = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    }
    await (0, pendingActions_1.resolvePendingAction)(pending.id, succeeded ? "executed" : "failed", { executionPreview });
    // Acknowledge to the family. Keep it short — the tool itself may have
    // already sent richer downstream notifications (e.g. caregiver SMS).
    const ackMessage = succeeded
        ? "Done."
        : "I tried to do that but ran into a problem — give me a moment and I'll try again.";
    await (0, client_1.sendMessage)(chatId, ackMessage).catch((err) => {
        console.error("handlePendingApproval: sendMessage (YES) failed", err);
    });
    return { outcome: "handled" };
}
//# sourceMappingURL=approvalHandler.js.map