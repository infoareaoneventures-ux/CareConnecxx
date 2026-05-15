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
            const cgFirstName = ((_a = caregiver.name) !== null && _a !== void 0 ? _a : "there").split(" ")[0];
            const seniorName = ((_c = (_b = senior === null || senior === void 0 ? void 0 : senior.seniorName) !== null && _b !== void 0 ? _b : appt.clientName) !== null && _c !== void 0 ? _c : "your client");
            const address = ((_e = (_d = appt.address) !== null && _d !== void 0 ? _d : appt.location) !== null && _e !== void 0 ? _e : "the client's home");
            const schedule = `${(_f = appt.startTime) !== null && _f !== void 0 ? _f : ""}${appt.endTime ? `–${appt.endTime}` : ""}`;
            const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
            // Fetch last journal entry for context
            const lastJournal = await db.collection("care_journal")
                .where("seniorId", "==", appt.clientId)
                .orderBy("timestamp", "desc")
                .limit(1)
                .get()
                .catch(() => null);
            const lastNotes = (lastJournal === null || lastJournal === void 0 ? void 0 : lastJournal.empty) ? null :
                (_g = lastJournal === null || lastJournal === void 0 ? void 0 : lastJournal.docs[0].data().notes) !== null && _g !== void 0 ? _g : null;
            // Build context note from last visit or care plan note
            const contextNote = lastNotes
                ? lastNotes.slice(0, 120)
                : ((carePlan === null || carePlan === void 0 ? void 0 : carePlan.notes) ? carePlan.notes.slice(0, 120) : null);
            // Medication line — only if there are meds
            const meds = (_h = carePlan === null || carePlan === void 0 ? void 0 : carePlan.medications) !== null && _h !== void 0 ? _h : [];
            const medLine = meds.length > 0
                ? `Medications: ${meds.slice(0, 2).join(", ")}.`
                : null;
            const lines = [
                `Morning ${cgFirstName}! ${seniorName} today${schedule ? ` — ${schedule}` : ""} at ${address}.`,
                mapsUrl,
                contextNote,
                medLine,
                `Reply ARRIVED when you get there.`,
            ].filter(Boolean);
            await (0, caraAgent_1.sendViaInteractionAgent)(caregiver.phone, {
                content: lines.join("\n\n"),
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