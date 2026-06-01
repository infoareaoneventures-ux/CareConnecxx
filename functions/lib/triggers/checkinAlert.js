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
exports.onCheckinCreated = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
const STATUS_EMOJI = {
    all_good: "✅",
    needs_attention: "⚠️",
    medication_given: "💊",
    meal_prepared: "🍽️",
};
exports.onCheckinCreated = functions.firestore
    .document("shift_checkins/{checkinId}")
    .onCreate(async (snap) => {
    var _a;
    const data = snap.data();
    const { clientId, caregiverName, status, notes, timestamp } = data;
    if (!clientId)
        return;
    const sessionSnap = await db
        .collection("agent_sessions")
        .where("userId", "==", clientId)
        .limit(1)
        .get();
    if (sessionSnap.empty)
        return;
    const phone = sessionSnap.docs[0].id;
    const time = new Date(timestamp).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
    });
    const emoji = (_a = STATUS_EMOJI[status]) !== null && _a !== void 0 ? _a : "📋";
    const label = status.replace(/_/g, " ");
    const noteText = notes ? `\n"${notes}"` : "";
    await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
        content: `${emoji} ${caregiverName} check-in at ${time}: ${label}${noteText}`,
        urgency: "standard",
        sourceAgent: "arrival_notification",
        canDrop: false,
    });
});
//# sourceMappingURL=checkinAlert.js.map