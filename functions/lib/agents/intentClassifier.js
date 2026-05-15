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
// CANCEL is intentionally NOT here — it cancels a visit, not the account
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);
async function classifyIntent(text, hasPendingTask) {
    var _a;
    const trimmed = text.trim().toUpperCase();
    if (STOP_WORDS.has(trimmed))
        return "STOP";
    if (trimmed === "CANCEL")
        return "CANCEL_REQUEST";
    if (hasPendingTask && ["1", "2", "3"].includes(trimmed))
        return "TASK_REPLY";
    try {
        const response = await getClient().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 10,
            system: "You classify a message sent to an AI care assistant named Cara. " +
                "Reply with exactly one word from this list: STOP, TASK_REPLY, PERMISSION_UPDATE, REBOOK_REQUEST, CANCEL_REQUEST, MEMORY_QUERY, QUESTION.\n" +
                "STOP = opting out of all messages.\n" +
                "TASK_REPLY = responding to a numbered list or YES/NO approval.\n" +
                "PERMISSION_UPDATE = asking to stop/start/change a setting (e.g. 'stop weekly summaries').\n" +
                "REBOOK_REQUEST = asking to rebook a caregiver (e.g. 'book Maria again next week').\n" +
                "CANCEL_REQUEST = asking to cancel an upcoming visit (e.g. 'cancel Wednesday', 'cancel tomorrow's visit').\n" +
                "MEMORY_QUERY = asking what Cara knows or remembers (e.g. 'what do you know about mom', 'what have you remembered', 'what's in my file').\n" +
                "ADD_FAMILY_MEMBER = asking to add a family member to care updates (e.g. 'add my sister', 'include my brother John', 'add +1234567890 to updates').\n" +
                "QUESTION = anything else.",
            messages: [{ role: "user", content: text }],
        });
        const label = ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase();
        if (["STOP", "TASK_REPLY", "PERMISSION_UPDATE", "REBOOK_REQUEST", "CANCEL_REQUEST", "MEMORY_QUERY", "ADD_FAMILY_MEMBER", "QUESTION"].includes(label)) {
            return label;
        }
    }
    catch (err) {
        console.error("intentClassifier error:", err);
    }
    return "QUESTION";
}
//# sourceMappingURL=intentClassifier.js.map