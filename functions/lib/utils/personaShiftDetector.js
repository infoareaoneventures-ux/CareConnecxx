"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPersonaShift = detectPersonaShift;
const openaiClient_1 = require("./openaiClient");
async function detectPersonaShift(params) {
    var _a;
    const { text, sessionSenior, sessionRole } = params;
    if (!text.trim())
        return null;
    // Short messages with no entity content aren't worth an LLM call.
    if (text.trim().length < 12)
        return null;
    const sessionContext = [
        sessionSenior ? `Senior on file: ${sessionSenior}` : null,
        sessionRole ? `Role on file: ${sessionRole}` : null,
    ].filter(Boolean).join("\n") || "Session has no recorded senior name yet.";
    let raw = "";
    try {
        raw = await (0, openaiClient_1.quickComplete)("You are checking if an inbound SMS implies a different person is now texting from a shared phone. " +
            "Cara stores care plans keyed by phone number; if Mom shares a phone with Aunt and Aunt texts " +
            "about her own father, Cara would otherwise treat it as Mom's request.\n\n" +
            `Session context:\n${sessionContext}\n\n` +
            "Reply with JSON only:\n" +
            `{"kind": "different_senior" | "different_role" | "none", "evidence": "<short quote from message>"}\n` +
            "Use \"different_senior\" when the message clearly references a senior with a different name " +
            "than the one on file, or refers to a different parent (e.g. session is for the user's mom but " +
            "they say \"my dad just fell\"). Use \"different_role\" if the speaker says they are a caregiver " +
            "but session role is client (or vice versa). Otherwise reply {\"kind\": \"none\", \"evidence\": \"\"}.\n" +
            "Single mentions like \"my husband\" or \"my sister\" referring to other family members do NOT count " +
            "— only flag clear references to a different care recipient.", text, { maxTokens: 80 });
    }
    catch (_b) {
        return null;
    }
    // Strip fences if Claude/4o wrapped it
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!cleaned.startsWith("{"))
        return null;
    try {
        const parsed = JSON.parse(cleaned);
        if (parsed.kind !== "different_senior" && parsed.kind !== "different_role")
            return null;
        return {
            kind: parsed.kind,
            evidence: ((_a = parsed.evidence) !== null && _a !== void 0 ? _a : "").slice(0, 200),
            sessionSenior: sessionSenior,
        };
    }
    catch (_c) {
        return null;
    }
}
//# sourceMappingURL=personaShiftDetector.js.map