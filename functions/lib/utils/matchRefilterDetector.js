"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectMatchRefilter = detectMatchRefilter;
const openaiClient_1 = require("./openaiClient");
async function detectMatchRefilter(text, lastAssistantMessage) {
    var _a, _b;
    if (text.trim().length < 4)
        return null;
    // Context guard: if Cara's last message asked the family a question (e.g.
    // "What date and time works best for you?" while setting up an interview),
    // a reply like "Today at 11am" is ANSWERING that question, not changing the
    // search criteria. Give the model that prior turn so it doesn't misread a
    // scheduling/answer reply as a re-search request.
    const contextLine = lastAssistantMessage
        ? `\nFor context, Cara's previous message to them was:\n"""${lastAssistantMessage.slice(0, 500)}"""\n` +
            "If their reply is simply ANSWERING a question Cara just asked (for example Cara asked for a " +
            "preferred interview date/time and they replied with a time like \"Today at 11am\" or \"Tuesday afternoon\"), " +
            "that is NOT a refilter — reply {\"isRefilter\": false}.\n"
        : "";
    let raw = "";
    try {
        raw = await (0, openaiClient_1.quickComplete)("Cara just showed a family member 3 caregiver options. They replied — is their reply a request " +
            "to change the search criteria (e.g. \"cheaper\", \"any with dementia experience\", \"available Saturday\", " +
            "\"a woman\", \"Spanish-speaking\")?\n" +
            contextLine + "\n" +
            "If YES, reply with JSON ONLY in this exact shape:\n" +
            "{\n" +
            "  \"isRefilter\": true,\n" +
            "  \"rate\": {\"direction\": \"lower\"|\"higher\"} | null,\n" +
            "  \"skills\": [\"dementia\", \"mobility\", ...] | null,\n" +
            "  \"availability\": {\"days\": [\"monday\", ...] | null, \"timeOfDay\": \"morning\"|\"afternoon\"|\"evening\" | null} | null,\n" +
            "  \"genderPreference\": \"female\"|\"male\"|\"no_preference\" | null,\n" +
            "  \"languages\": [\"spanish\", ...] | null,\n" +
            "  \"distance\": {\"direction\": \"closer\"|\"wider\"} | null,\n" +
            "  \"experienceYears\": {\"min\": <number>} | null,\n" +
            "  \"summary\": \"one short phrase Cara can repeat back, e.g. 'cheaper ones with dementia experience'\"\n" +
            "}\n\n" +
            "If NO (selection like \"1\", question, off-topic), reply with: {\"isRefilter\": false}\n" +
            "Only include fields the user explicitly mentioned. Use null for fields they didn't mention. " +
            "Reply ONLY with the JSON object — no prose.", text, { maxTokens: 200 });
    }
    catch (_c) {
        return null;
    }
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!cleaned.startsWith("{"))
        return null;
    try {
        const parsed = JSON.parse(cleaned);
        if (parsed.isRefilter !== true)
            return null;
        if (!parsed.summary || typeof parsed.summary !== "string")
            return null;
        const intent = { summary: parsed.summary.slice(0, 200) };
        if (parsed.rate)
            intent.rate = parsed.rate;
        if (parsed.skills)
            intent.skills = parsed.skills;
        if (parsed.availability)
            intent.availability = parsed.availability;
        if (parsed.genderPreference)
            intent.genderPreference = parsed.genderPreference;
        if (parsed.languages)
            intent.languages = parsed.languages;
        if (parsed.distance)
            intent.distance = parsed.distance;
        if (parsed.experienceYears)
            intent.experienceYears = parsed.experienceYears;
        // Ignore objects that have isRefilter=true but no actionable changes
        const hasAny = !!(intent.rate || ((_a = intent.skills) === null || _a === void 0 ? void 0 : _a.length) || intent.availability ||
            intent.genderPreference || ((_b = intent.languages) === null || _b === void 0 ? void 0 : _b.length) || intent.distance ||
            intent.experienceYears);
        if (!hasAny)
            return null;
        return intent;
    }
    catch (_d) {
        return null;
    }
}
//# sourceMappingURL=matchRefilterDetector.js.map