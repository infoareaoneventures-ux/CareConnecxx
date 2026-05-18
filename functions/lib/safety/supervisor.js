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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supervise = supervise;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const linter_1 = require("./linter");
const constitution_1 = require("./constitution");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function supervise(message, context) {
    var _a, _b;
    // Step 1: lint (synchronous, no LLM)
    const linted = (0, linter_1.lintMessage)(message);
    // Step 2: constitution check via Claude Haiku
    let checked = linted;
    try {
        const rulesText = constitution_1.CONSTITUTION_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
        const result = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: `You are a safety reviewer for a caregiving AI assistant named Cara. ` +
                `Check if the message below violates any of these rules:\n${rulesText}\n\n` +
                `Reply with ONLY valid JSON in this exact format: ` +
                `{"violation": false, "revised": "..."} ` +
                `If no violation, set violation to false and revised to the original message. ` +
                `If a violation, set violation to true and revised to a safe rewrite that still addresses the user's need. ` +
                `Never change the friendly tone or add formal language.`,
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
            // Log to safety log (non-blocking)
            db.collection("agent_safety_log").add({
                phone: context.phone,
                role: (_b = context.role) !== null && _b !== void 0 ? _b : "client",
                original: message,
                revised: parsed.revised,
                loggedAt: new Date().toISOString(),
            }).catch(() => { });
            checked = parsed.revised;
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