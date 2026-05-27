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
exports.trySend = trySend;
exports.trySendViaCara = trySendViaCara;
const client_1 = require("../linq/client");
async function trySend(phone, message, source) {
    if (!phone) {
        return { sent: false, reason: "missing_phone" };
    }
    try {
        await (0, client_1.sendToPhone)(phone, message);
        return { sent: true };
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`toolNotify.trySend failed [${source}]`, { phone, errMsg });
        return { sent: false, reason: "linq_send_failed", error: errMsg.slice(0, 200) };
    }
}
// Variant that goes through sendViaInteractionAgent (caraAgent voice + DND +
// supervisor) rather than raw sendToPhone. Useful for tools where Cara should
// say it in her own voice rather than relay a verbatim caregiver/client line.
async function trySendViaCara(phone, content, source, opts = {}) {
    var _a, _b;
    if (!phone) {
        return { sent: false, reason: "missing_phone" };
    }
    try {
        const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("../agents/caraAgent")));
        await sendViaInteractionAgent(phone, {
            content,
            urgency: (_a = opts.urgency) !== null && _a !== void 0 ? _a : "standard",
            sourceAgent: source,
            canDrop: (_b = opts.canDrop) !== null && _b !== void 0 ? _b : false,
        });
        return { sent: true };
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`toolNotify.trySendViaCara failed [${source}]`, { phone, errMsg });
        return { sent: false, reason: "cara_send_failed", error: errMsg.slice(0, 200) };
    }
}
//# sourceMappingURL=toolNotify.js.map