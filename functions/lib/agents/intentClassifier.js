"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIntent = classifyIntent;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
let _client = null;
function getClient() {
    if (!_client) {
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _client;
}
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "CANCEL", "END"]);
async function classifyIntent(text, hasPendingTask) {
    var _a;
    const trimmed = text.trim().toUpperCase();
    // Hard-coded STOP check — no Claude call needed
    if (STOP_WORDS.has(trimmed))
        return "STOP";
    // Hard-coded numeric reply check when a task is pending
    if (hasPendingTask && ["1", "2", "3"].includes(trimmed))
        return "TASK_REPLY";
    // Fast Claude classification for everything else
    try {
        const response = await getClient().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 10,
            system: "You classify a family member's text to a care assistant. " +
                'Reply with exactly one word: STOP, TASK_REPLY, or QUESTION. ' +
                "STOP = opting out. TASK_REPLY = responding to a numbered list. QUESTION = anything else.",
            messages: [{ role: "user", content: text }],
        });
        const label = ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase();
        if (["STOP", "TASK_REPLY", "QUESTION"].includes(label))
            return label;
    }
    catch (err) {
        console.error("intentClassifier error:", err);
    }
    return "QUESTION";
}
//# sourceMappingURL=intentClassifier.js.map