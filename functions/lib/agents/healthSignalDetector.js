"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHealthSignals = detectHealthSignals;
const openaiClient_1 = require("../utils/openaiClient");
const jsonUtils_1 = require("../utils/jsonUtils");
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
    var _a;
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const raw = await (0, openaiClient_1.quickComplete)(SYSTEM_PROMPT, contextText, {
            maxTokens: 300,
            signal: controller.signal,
        });
        clearTimeout(timer);
        const parsed = (0, jsonUtils_1.safeParseJson)(raw, "detectHealthSignals", null, "object");
        if (!parsed)
            return fallback;
        if (!["none", "watch", "flag"].includes(parsed.severity)) {
            parsed.severity = "none";
        }
        parsed.signals = Array.isArray(parsed.signals) ? parsed.signals : [];
        parsed.summary = typeof parsed.summary === "string" ? parsed.summary : "";
        return parsed;
    }
    catch (err) {
        console.error("healthSignalDetector error:", err);
        return fallback;
    }
}
//# sourceMappingURL=healthSignalDetector.js.map