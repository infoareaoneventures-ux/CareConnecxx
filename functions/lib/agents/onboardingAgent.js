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
exports.markTaskComplete = void 0;
const functions = __importStar(require("firebase-functions/v1"));
// startSignup callable removed — new users are created in the webhook handler
// when they text "Hey Cara" first (MO consent). See linq/webhooks.ts handleInbound.
exports.markTaskComplete = functions.https.onCall(async (data) => {
    var _a, _b;
    const token = ((_a = data === null || data === void 0 ? void 0 : data.token) !== null && _a !== void 0 ? _a : "").toString().trim();
    const taskId = ((_b = data === null || data === void 0 ? void 0 : data.taskId) !== null && _b !== void 0 ? _b : "").toString().trim();
    if (!token)
        throw new functions.https.HttpsError("invalid-argument", "token required");
    const { verifyToken } = await Promise.resolve().then(() => __importStar(require("./tokenService")));
    const payload = verifyToken(token);
    if (!payload)
        throw new functions.https.HttpsError("unauthenticated", "invalid or expired token");
    const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require("./onboardingConversation")));
    await advanceOnboardingStep(payload.phone, payload.task, taskId !== null && taskId !== void 0 ? taskId : "");
    return { status: "ok" };
});
//# sourceMappingURL=onboardingAgent.js.map