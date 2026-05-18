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
exports.sendIfNotDND = sendIfNotDND;
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const preferences_1 = require("../memory/preferences");
const db = admin.firestore();
async function sendIfNotDND(phone, output, urgency = "normal") {
    var _a, _b, _c;
    // critical always bypasses DND (crisis, 911, emergency)
    if (urgency === "critical") {
        return (0, caraAgent_1.sendViaInteractionAgent)(phone, output);
    }
    const prefs = await (0, preferences_1.getPreferences)(phone).catch(() => null);
    if (!prefs || !(0, preferences_1.isInDND)(prefs)) {
        return (0, caraAgent_1.sendViaInteractionAgent)(phone, output);
    }
    // In DND — compute when DND window ends and queue
    const dndEnd = (_a = prefs.dndEnd) !== null && _a !== void 0 ? _a : "08:00";
    const timezone = (_b = prefs.timezone) !== null && _b !== void 0 ? _b : "America/New_York";
    const sendAfter = computeDndEndTime(dndEnd, timezone);
    await db.collection("agent_dnd_queue").add({
        phone,
        content: output.content,
        urgency: output.urgency,
        sourceAgent: output.sourceAgent,
        canDrop: (_c = output.canDrop) !== null && _c !== void 0 ? _c : true,
        queuedAt: new Date().toISOString(),
        sendAfter,
        sentAt: null,
        dndUrgency: urgency,
    });
}
function computeDndEndTime(dndEnd, timezone) {
    var _a, _b, _c, _d;
    const [h, m] = dndEnd.split(":").map(Number);
    const now = new Date();
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone,
        }).formatToParts(now);
        const localH = parseInt((_b = (_a = parts.find(p => p.type === "hour")) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : "0");
        const localM = parseInt((_d = (_c = parts.find(p => p.type === "minute")) === null || _c === void 0 ? void 0 : _c.value) !== null && _d !== void 0 ? _d : "0");
        const localMinutes = localH * 60 + localM;
        const targetMinutes = h * 60 + m;
        const minutesUntilEnd = targetMinutes > localMinutes
            ? targetMinutes - localMinutes
            : 1440 - localMinutes + targetMinutes;
        return new Date(now.getTime() + minutesUntilEnd * 60 * 1000).toISOString();
    }
    catch (_e) {
        // Fallback: 8 hours from now
        return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
    }
}
//# sourceMappingURL=dndGuard.js.map