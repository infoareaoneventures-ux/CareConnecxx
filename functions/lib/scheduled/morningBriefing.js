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
exports.sendMorningBriefings = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
// Runs every day at 7am local (12:00 UTC covers most US time zones at 7am)
exports.sendMorningBriefings = functions.pubsub
    .schedule("0 12 * * *")
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const today = new Date().toISOString().slice(0, 10);
    // Find all confirmed appointments for today
    const snap = await db.collection("appointments")
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const caregiverId = appt.caregiverId;
        if (!caregiverId)
            continue;
        try {
            const [cgSnap, clientSnap, carePlanSnap] = await Promise.all([
                db.collection("caregivers").doc(caregiverId).get(),
                db.collection("users").doc(appt.clientId).get(),
                db.collection("care_plans").doc(appt.clientId).get(),
            ]);
            const caregiver = cgSnap.data();
            if (!(caregiver === null || caregiver === void 0 ? void 0 : caregiver.phone))
                continue;
            const cgSession = await db.collection("agent_sessions").doc(caregiver.phone).get();
            if (!cgSession.exists)
                continue;
            const senior = clientSnap.data();
            const carePlan = carePlanSnap.data();
            const name = (_a = caregiver.name) !== null && _a !== void 0 ? _a : "there";
            const seniorName = ((_c = (_b = senior === null || senior === void 0 ? void 0 : senior.seniorName) !== null && _b !== void 0 ? _b : appt.clientName) !== null && _c !== void 0 ? _c : "your client");
            const address = ((_e = (_d = appt.address) !== null && _d !== void 0 ? _d : appt.location) !== null && _e !== void 0 ? _e : "the client's home");
            // Build care plan highlights
            const highlights = [];
            if ((_f = carePlan === null || carePlan === void 0 ? void 0 : carePlan.medications) === null || _f === void 0 ? void 0 : _f.length) {
                highlights.push(`· Medications: ${carePlan.medications.slice(0, 2).join(", ")}`);
            }
            if (carePlan === null || carePlan === void 0 ? void 0 : carePlan.notes) {
                highlights.push(`· Notes: ${carePlan.notes.slice(0, 100)}`);
            }
            if (!highlights.length)
                highlights.push("· No special notes for today");
            const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
            await (0, caraAgent_1.sendViaInteractionAgent)(caregiver.phone, {
                content: `Good morning ${name}! Here's your day:\n\n` +
                    `👤 ${seniorName}\n` +
                    `📍 ${address}\n` +
                    `   ${mapsUrl}\n` +
                    `⏰ ${(_g = appt.startTime) !== null && _g !== void 0 ? _g : ""}–${(_h = appt.endTime) !== null && _h !== void 0 ? _h : ""}\n\n` +
                    `Care plan highlights:\n` +
                    highlights.join("\n") +
                    `\n\nReply ARRIVED when you get there. 💙`,
                urgency: "standard",
                sourceAgent: "morning_briefing",
                canDrop: true,
            });
        }
        catch (err) {
            console.error("morningBriefing error for appt", doc.id, err);
        }
    }
});
//# sourceMappingURL=morningBriefing.js.map