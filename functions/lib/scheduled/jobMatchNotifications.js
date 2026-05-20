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
exports.sendJobMatchNotifications = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const jobMatchRecommender_1 = require("../agents/jobMatchRecommender");
const client_1 = require("../linq/client");
const db = admin.firestore();
// Runs daily — texts caregivers when a new job has >75% match
exports.sendJobMatchNotifications = functions.pubsub
    .schedule("0 10 * * *") // 10am daily
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a;
    // Find jobs posted in last 24 hours
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const newJobsSnap = await db.collection("job_posts")
        .where("status", "==", "open")
        .where("createdAt", ">=", yesterday)
        .get();
    if (newJobsSnap.empty) {
        console.log("[sendJobMatchNotifications] No new jobs posted in last 24h");
        return;
    }
    console.log(`[sendJobMatchNotifications] Found ${newJobsSnap.size} new job(s)`);
    // Get all verified active caregivers
    const caregiverSnap = await db.collection("caregivers")
        .where("verified", "==", true)
        .limit(100)
        .get();
    console.log(`[sendJobMatchNotifications] Checking ${caregiverSnap.size} verified caregivers`);
    for (const cgDoc of caregiverSnap.docs) {
        const cg = cgDoc.data();
        if (!cg.chatId && !cg.phone)
            continue;
        try {
            const recs = await (0, jobMatchRecommender_1.getJobRecommendationsForCaregiver)(cgDoc.id, 3);
            const highMatch = recs.filter(r => r.matchScore >= 75);
            if (!highMatch.length)
                continue;
            const chatId = (_a = cg.chatId) !== null && _a !== void 0 ? _a : cg.phone;
            const top = highMatch[0];
            const msg = `New job match for you! ${top.careTypes.join(", ")} — ${top.schedule}, ` +
                `$${top.rate}/hr (${top.matchScore}% match). Reply "jobs" to see details.`;
            await (0, client_1.sendMessage)(chatId, msg);
            console.log(`[sendJobMatchNotifications] Notified ${cgDoc.id} — ${top.matchScore}% match`);
        }
        catch (e) {
            console.error(`[sendJobMatchNotifications] Failed for ${cgDoc.id}:`, e);
        }
    }
});
//# sourceMappingURL=jobMatchNotifications.js.map