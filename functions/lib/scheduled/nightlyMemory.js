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
exports.consolidateMemoryNightly = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const memoryFiles_1 = require("../memory/memoryFiles");
const db = admin.firestore();
// Runs nightly at 10 PM PT (06:00 UTC next day)
exports.consolidateMemoryNightly = functions.pubsub
    .schedule("0 6 * * *")
    .onRun(async () => {
    var _a;
    // Find all active sessions updated in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const snap = await db
        .collection("agent_sessions")
        .where("onboardingStep", "==", "complete")
        .where("optedOut", "==", false)
        .get();
    const userIds = [];
    for (const doc of snap.docs) {
        const data = doc.data();
        // Only process users who had recent activity
        if (data.lastMessageAt && data.lastMessageAt >= sevenDaysAgo) {
            const userId = (_a = data.userId) !== null && _a !== void 0 ? _a : doc.id;
            if (userId)
                userIds.push(userId);
        }
    }
    console.log(`consolidateMemoryNightly: processing ${userIds.length} users`);
    // Process in batches to avoid timeout
    for (const userId of userIds) {
        await (0, memoryFiles_1.consolidateMemoryForUser)(userId).catch((err) => console.error(`memory consolidation error for ${userId}:`, err));
    }
});
//# sourceMappingURL=nightlyMemory.js.map