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
exports.runNoVisitCheck = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
exports.runNoVisitCheck = functions.pubsub
    .schedule("0 14 * * *") // 9am ET / 14:00 UTC daily
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a, _b;
    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Find active recurring schedules
    const scheduleSnap = await db.collection("recurring_schedules")
        .where("status", "==", "active")
        .get();
    if (scheduleSnap.empty)
        return;
    for (const scheduleDoc of scheduleSnap.docs) {
        const schedule = scheduleDoc.data();
        const clientId = schedule.clientId;
        if (!clientId)
            continue;
        try {
            // Check if there's a completed visit in the last 7 days
            const recentVisit = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "completed")
                .where("date", ">=", sevenDaysAgo)
                .limit(1)
                .get();
            if (!recentVisit.empty)
                continue; // Has a recent visit — skip
            // Check if a visit is already booked for today or tomorrow
            const upcoming = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
                .where("date", ">=", today)
                .limit(1)
                .get();
            if (!upcoming.empty)
                continue; // Already has an upcoming visit
            // De-dup: check if we sent this alert within 7 days
            const lastAlert = schedule.noVisitAlertSentAt;
            if (lastAlert) {
                const daysSince = (Date.now() - new Date(lastAlert).getTime()) / (1000 * 60 * 60 * 24);
                if (daysSince < 7)
                    continue;
            }
            // Get client phone
            const clientSessionSnap = await db.collection("agent_sessions")
                .where("userId", "==", clientId)
                .limit(1)
                .get();
            if (clientSessionSnap.empty)
                continue;
            const clientPhone = clientSessionSnap.docs[0].id;
            const seniorName = (_a = clientSessionSnap.docs[0].data().seniorName) !== null && _a !== void 0 ? _a : "your loved one";
            const cgName = (_b = schedule.caregiverName) !== null && _b !== void 0 ? _b : "your caregiver";
            const noVisitMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Senior: ${seniorName}. ` +
                    (cgName !== "your caregiver" ? `Their regular caregiver: ${cgName}. ` : "") +
                    `${seniorName} hasn't had a visit in the past 7 days. ` +
                    "Gently flag this to the family and offer to check the caregiver's availability to book something this week. " +
                    "Keep it caring and helpful, not alarming.",
                fallback: `Just noticed ${seniorName} hasn't had a visit in the past 7 days. ` +
                    `Want me to check ${cgName}'s availability and book something this week?`,
                maxTokens: 80,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: noVisitMsg,
                urgency: "standard",
                sourceAgent: "no_visit_check",
                canDrop: true,
            });
            // Update the schedule with sent timestamp
            await scheduleDoc.ref.update({ noVisitAlertSentAt: new Date().toISOString() });
        }
        catch (err) {
            console.error(`[noVisitCheck] Error for schedule ${scheduleDoc.id}:`, err);
        }
    }
    console.log(`[noVisitCheck] Completed check for ${scheduleSnap.size} active schedules`);
});
//# sourceMappingURL=noVisitCheck.js.map