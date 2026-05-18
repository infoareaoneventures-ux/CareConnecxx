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
exports.upcomingVisitReminder = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
exports.upcomingVisitReminder = functions.pubsub
    .schedule("*/30 * * * *")
    .onRun(async () => {
    var _a, _b, _c, _d;
    const now = new Date();
    const nowIso = now.toISOString();
    const plus90min = new Date(now.getTime() + 90 * 60 * 1000).toISOString();
    const snap = await db.collection("appointments")
        .where("status", "==", "confirmed")
        .where("startDateTime", ">=", nowIso)
        .where("startDateTime", "<=", plus90min)
        .where("preVisitReminderSent", "!=", true)
        .get();
    if (snap.empty)
        return;
    console.log(`[upcomingVisitReminder] Processing ${snap.size} upcoming appointments`);
    for (const doc of snap.docs) {
        const appt = doc.data();
        try {
            const userSnap = await db.collection("users").doc(appt.clientId).get();
            const phone = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
            if (!phone)
                continue;
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            if (!sessionSnap.exists)
                continue;
            const session = sessionSnap.data();
            if (session.optedOut)
                continue;
            const cgName = ((_b = appt.caregiverName) !== null && _b !== void 0 ? _b : "Your caregiver");
            const time = ((_d = (_c = appt.startTime) !== null && _c !== void 0 ? _c : appt.time) !== null && _d !== void 0 ? _d : "");
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `Just a heads up — ${cgName} is confirmed for your ${time} visit today. ` +
                    `Reply CANCEL if plans change and I'll handle it.`,
                urgency: "standard",
                sourceAgent: "upcoming_visit_reminder",
                canDrop: false,
            });
            await doc.ref.update({ preVisitReminderSent: true });
        }
        catch (err) {
            console.error(`[upcomingVisitReminder] Error for appointment ${doc.id}:`, err);
        }
    }
});
//# sourceMappingURL=upcomingVisitReminder.js.map