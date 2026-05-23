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
exports.dailyContactCardShare = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const sms_1 = require("../sms");
const db = admin.firestore();
// Runs every day at 10am ET (15:00 UTC).
// Best practice: re-share Cara's contact card daily so users who dismissed the
// "Add to contacts" prompt get another chance to save her name and photo.
exports.dailyContactCardShare = functions.pubsub
    .schedule("0 15 * * *")
    .timeZone("UTC")
    .onRun(async () => {
    // Refresh the contact card record first (no-op if already up to date)
    await (0, sms_1.setupCaraContactCard)().catch((err) => console.error("dailyContactCardShare: setupCaraContactCard failed", err));
    // Share to every active iMessage session (non-iMessage sessions don't support contact cards)
    const snap = await db
        .collection("agent_sessions")
        .where("optedOut", "==", false)
        .where("service", "==", "iMessage")
        .get();
    if (snap.empty) {
        console.info("dailyContactCardShare: no active iMessage sessions");
        return;
    }
    const results = await Promise.allSettled(snap.docs.map((doc) => {
        const { chatId } = doc.data();
        return (0, client_1.shareContactCard)(chatId);
    }));
    const failed = results.filter((r) => r.status === "rejected").length;
    console.info(`dailyContactCardShare: shared to ${snap.size} sessions, ${failed} failed`);
});
//# sourceMappingURL=dailyContactCardShare.js.map