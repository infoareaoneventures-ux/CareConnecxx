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
exports.recordLatenessEvent = recordLatenessEvent;
exports.getCaregiver30dLatenessCount = getCaregiver30dLatenessCount;
exports.checkLatenessPattern = checkLatenessPattern;
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("./caraAgent");
const db = admin.firestore();
async function recordLatenessEvent(event) {
    await db.collection("caregiver_lateness_log").add(Object.assign(Object.assign({}, event), { createdAt: new Date().toISOString() }));
}
async function getCaregiver30dLatenessCount(caregiverId) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    const snap = await db.collection("caregiver_lateness_log")
        .where("caregiverId", "==", caregiverId)
        .where("date", ">=", thirtyDaysAgo)
        .get();
    return snap.size;
}
async function checkLatenessPattern(caregiverId, caregiverName) {
    var _a;
    const count = await getCaregiver30dLatenessCount(caregiverId);
    // Update denormalized count on caregiver doc
    await db.collection("caregivers").doc(caregiverId).update({
        latenessCount30d: count,
    }).catch(() => { });
    if (count < 3)
        return;
    // Check if we already sent an alert within 7 days
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const lastAlertSent = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.lastLatenessAlertSent;
    if (lastAlertSent) {
        const daysSince = (Date.now() - new Date(lastAlertSent).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < 7)
            return;
    }
    // Check for existing unresolved admin_alerts for this caregiver
    const existingAlert = await db.collection("admin_alerts")
        .where("type", "==", "chronic_lateness")
        .where("caregiverId", "==", caregiverId)
        .where("resolved", "==", false)
        .limit(1)
        .get();
    if (existingAlert.empty) {
        await db.collection("admin_alerts").add({
            type: "chronic_lateness",
            caregiverId,
            caregiverName,
            latenessCount: count,
            createdAt: new Date().toISOString(),
            resolved: false,
            priority: "medium",
        });
    }
    // Warn affected families with upcoming confirmed appointments for this caregiver
    const today = new Date().toISOString().slice(0, 10);
    const upcomingAppts = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("status", "==", "confirmed")
        .where("date", ">=", today)
        .limit(10)
        .get();
    const notifiedClients = new Set();
    for (const apptDoc of upcomingAppts.docs) {
        const appt = apptDoc.data();
        if (notifiedClients.has(appt.clientId))
            continue;
        notifiedClients.add(appt.clientId);
        // Get client phone
        const clientSessionSnap = await db.collection("agent_sessions")
            .where("userId", "==", appt.clientId)
            .limit(1)
            .get();
        if (clientSessionSnap.empty)
            continue;
        const clientPhone = clientSessionSnap.docs[0].id;
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: `Heads up — ${caregiverName} has been running late to visits a few times recently. ` +
                `Wanted to let you know before the ${appt.date} visit. ` +
                `Reply REPLACE if you'd like a different caregiver.`,
            urgency: "standard",
            sourceAgent: "lateness_tracker",
            canDrop: false,
        });
    }
    await db.collection("caregivers").doc(caregiverId).update({
        lastLatenessAlertSent: new Date().toISOString(),
    }).catch(() => { });
}
//# sourceMappingURL=latenessTracker.js.map