"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHealthSignals = detectHealthSignals;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
let _client = null;
function getClient() {
    if (!_client)
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _client;
}
const SYSTEM_PROMPT = `You are a health signal detector reviewing a caregiver's visit notes for a senior.

Extract any concerning health observations and classify severity.

Respond with valid JSON only, no markdown:
{
  "signals": ["list of specific health observations, empty if none"],
  "severity": "none | watch | flag",
  "summary": "1-2 sentence warm summary suitable to send to a family member"
}

Severity guide:
- none: normal visit, no health concerns
- watch: mild concern worth monitoring (e.g. lighter appetite, mild fatigue)
- flag: notable concern worth mentioning to a doctor (e.g. pain, confusion, fall, medication refusal, significant mood change)

Never diagnose. Never use clinical language. Write summary as if texting a caring friend.`;
async function detectHealthSignals(notes, wellness, activities) {
    var _a, _b;
    const fallback = {
        signals: [],
        severity: "none",
        summary: "",
    };
    if (!(notes === null || notes === void 0 ? void 0 : notes.trim()) && !wellness)
        return fallback;
    const contextText = [
        notes ? `Caregiver notes: ${notes}` : "",
        `Wellness: ate well=${wellness === null || wellness === void 0 ? void 0 : wellness.ateWell}, took meds=${wellness === null || wellness === void 0 ? void 0 : wellness.tookMeds}, was active=${wellness === null || wellness === void 0 ? void 0 : wellness.wasActive}, mood=${(_a = wellness === null || wellness === void 0 ? void 0 : wellness.mood) !== null && _a !== void 0 ? _a : "unknown"}`,
        (activities === null || activities === void 0 ? void 0 : activities.length) ? `Activities: ${activities.join(", ")}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    try {
        const response = await getClient().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: contextText }],
        }, { signal: AbortSignal.timeout(8000) });
        const raw = ((_b = response.content[0].text) !== null && _b !== void 0 ? _b : "").trim();
        const parsed = JSON.parse(raw);
        if (!["none", "watch", "flag"].includes(parsed.severity)) {
            parsed.severity = "none";
        }
        return parsed;
    }
    catch (err) {
        console.error("healthSignalDetector error:", err);
        return fallback;
    }
}
//# sourceMappingURL=healthSignalDetector.js.map