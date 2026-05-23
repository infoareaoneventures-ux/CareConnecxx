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
exports.aiProxy = void 0;
const functions = __importStar(require("firebase-functions"));
const claudeClient_1 = require("./utils/claudeClient");
const rateLimit_1 = require("./rateLimit");
const ALLOWED_MODELS = new Set([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
]);
exports.aiProxy = functions.https.onCall(async (data, context) => {
    var _a, _b;
    if (!((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid)) {
        throw new functions.https.HttpsError("unauthenticated", "Login required");
    }
    const { system, user, model = "claude-haiku-4-5-20251001", maxTokens = 1000, } = data;
    if (!system || !user) {
        throw new functions.https.HttpsError("invalid-argument", "system and user are required");
    }
    if (!ALLOWED_MODELS.has(model)) {
        throw new functions.https.HttpsError("invalid-argument", `Model ${model} not allowed`);
    }
    const rateResult = await (0, rateLimit_1.checkRateLimit)(context.auth.uid, {
        windowMs: 60000,
        maxRequests: 30,
        keyPrefix: "rl:aiProxy:",
    });
    if (!rateResult.allowed) {
        throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded. Try again in a minute.");
    }
    let response;
    try {
        response = await (0, claudeClient_1.getSharedClient)().messages.create({
            model,
            max_tokens: Math.min(maxTokens, 4000),
            system,
            messages: [{ role: "user", content: user }],
        });
    }
    catch (err) {
        console.error("aiProxy: Anthropic API error", err);
        throw new functions.https.HttpsError("internal", "AI service unavailable. Please try again.");
    }
    return { text: (_b = response.content[0].text) !== null && _b !== void 0 ? _b : "" };
});
//# sourceMappingURL=aiProxy.js.map