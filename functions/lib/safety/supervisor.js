"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.supervise = supervise;
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const linter_1 = require("./linter");
const constitution_1 = require("./constitution");
const db = admin.firestore();
async function supervise(message, context) {
    var _a, _b;
    // Step 1: lint (synchronous, no LLM)
    const linted = (0, linter_1.lintMessage)(message);
    // Step 2: constitution check via Claude Haiku
    let checked = linted;
    try {
        const rulesText = constitution_1.CONSTITUTION_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
        const result = await (0, claudeClient_1.getSharedClient)().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: `You are a safety reviewer for a caregiving AI assistant named Cara. ` +
                `Cara texts with the family member responsible for a senior's care, and with caregivers about the clients they serve — ` +
                `discussing that senior's care plan, onboarding, schedule, caregivers, medications, or general care needs with the ` +
                `responsible party is the entire point of the product and is NEVER a violation of Rule 3. Rule 3 only applies when ` +
                `Cara would disclose one family's data to a different, unrelated user.\n\n` +
                `Check if the message below clearly and unambiguously violates one of these rules:\n${rulesText}\n\n` +
                `Bias strongly toward {"violation": false}. Only flag a violation when the rule is broken in a concrete, specific way ` +
                `(e.g. Cara diagnoses a condition, prescribes a dose, quotes an unconfirmed price, fabricates an appointment). ` +
                `Ambiguity, hedging, or "this could be sensitive" feelings are NOT violations.\n\n` +
                `If you do rewrite, the rewrite MUST be a minimal edit that preserves the original meaning and warm tone. ` +
                `It MUST NOT introduce boilerplate refusals, third-party handoffs, or any of these forbidden phrases: ` +
                `"I'm not able to", "I cannot", "I am unable", "For privacy and security reasons", "contact our care team", ` +
                `"our main number", "our team will", "have the family member contact", "Is there anything else". ` +
                `Cara is the team — she never punts the user to a separate human team or phone number.\n\n` +
                `Reply with ONLY valid JSON in this exact format: ` +
                `{"violation": false, "revised": "..."} ` +
                `When no violation, set violation to false and copy the original message verbatim into revised.`,
            messages: [{ role: "user", content: linted }],
        });
        const raw = ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
        // Strip markdown code fences if model wraps the JSON
        const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        let parsed = null;
        try {
            const candidate = JSON.parse(jsonText);
            if (candidate !== null &&
                typeof candidate === "object" &&
                "violation" in candidate &&
                "revised" in candidate &&
                typeof candidate.revised === "string") {
                parsed = candidate;
            }
            else {
                console.warn("supervisor: unexpected JSON shape, falling back to linted message", { jsonText: jsonText.slice(0, 100) });
            }
        }
        catch (parseErr) {
            console.warn("supervisor: failed to parse JSON response, falling back to linted message", {
                raw: raw.slice(0, 100),
                error: String(parseErr),
            });
        }
        if ((parsed === null || parsed === void 0 ? void 0 : parsed.violation) && parsed.revised) {
            // Re-lint the rewrite: Haiku sometimes injects phrases Cara isn't allowed
            // to use ("I'm not able to", "Is there anything else I can help you with",
            // "contact our care team"). Without this pass those bypass the upfront
            // linter and end up in the SMS the user sees.
            const relinted = (0, linter_1.lintMessage)(parsed.revised);
            // Log to safety log (non-blocking)
            db.collection("agent_safety_log").add({
                phone: context.phone,
                role: (_b = context.role) !== null && _b !== void 0 ? _b : "client",
                original: message,
                revised: relinted,
                loggedAt: new Date().toISOString(),
            }).catch(() => { });
            // If the rewrite collapsed to punctuation/whitespace only (every meaningful
            // clause was a banned phrase that got stripped), prefer the original linted
            // message over a hollow ". . ." artifact. We test for "has a real word
            // remaining" rather than non-empty because the linter leaves trailing
            // periods and commas behind when it removes banned phrases.
            const hasContent = /[A-Za-z0-9]{2,}/.test(relinted);
            checked = hasContent ? relinted : linted;
        }
        else if (!parsed) {
            // JSON parse failed — linted message is already the safe fallback
            console.info("supervisor: using linted message as fallback", { phone: context.phone });
        }
    }
    catch (err) {
        // Supervisor Claude call failed — fall back to linted message
        console.warn("supervisor: Claude call failed, using linted message", { error: String(err) });
    }
    return checked;
}
//# sourceMappingURL=supervisor.js.map