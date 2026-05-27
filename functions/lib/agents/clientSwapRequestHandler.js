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
exports.handleClientSwapRequest = handleClientSwapRequest;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const openaiClient_1 = require("../utils/openaiClient");
const db = admin.firestore();
async function isQuestionOrOther(text) {
    try {
        const result = await (0, openaiClient_1.quickComplete)("The user was shown a numbered list of upcoming visits and asked to pick one to swap the caregiver for. " +
            "Reply YES if their reply is a question or off-topic comment (about swap fees, timing, caregivers in general). " +
            "Reply NO if it is a selection (a number).", text, { maxTokens: 5 });
        return result.trim().toUpperCase().startsWith("Y");
    }
    catch (_a) {
        return false;
    }
}
async function answerSwapQuestion(text) {
    try {
        return await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A family member was just shown their upcoming visits and asked to " +
            "pick one to swap the caregiver for. Instead they asked a question. Answer briefly (1–2 sentences). " +
            "Do NOT ask them to pick a visit — that prompt comes next.", text, { maxTokens: 180 });
    }
    catch (_a) {
        return "Sorry, I'm having trouble pulling that up right now.";
    }
}
async function handleClientSwapRequest(clientId, clientPhone, text, session, chatId) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const step = (_a = session.clientSwapStep) !== null && _a !== void 0 ? _a : "identify_appointment";
    if (step === "identify_appointment") {
        const today = new Date().toISOString().split("T")[0];
        const snap = await db.collection("appointments")
            .where("clientId", "==", clientId)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .where("date", ">=", today)
            .orderBy("date", "asc")
            .limit(5)
            .get();
        if (snap.empty) {
            await (0, client_1.sendMessage)(chatId, "I don't see any upcoming visits to swap the caregiver for.");
            return;
        }
        const visits = snap.docs.map((d, i) => ({
            index: i + 1,
            id: d.id,
            date: d.data().date,
            time: d.data().time,
            caregiverName: d.data().caregiverName,
            caregiverId: d.data().caregiverId,
            duration: d.data().duration,
        }));
        await db.collection("agent_sessions").doc(clientPhone).update({
            clientSwapStep: "select_appointment",
            clientSwapVisits: JSON.stringify(visits),
        });
        const list = visits.map(v => `${v.index}. ${v.date} at ${v.time} with ${v.caregiverName}`).join("\n");
        await (0, client_1.sendMessage)(chatId, `Which visit do you want to swap the caregiver for?\n${list}\n\nReply with the number.`);
        return;
    }
    if (step === "select_appointment") {
        let visits = [];
        try {
            visits = JSON.parse((_b = session.clientSwapVisits) !== null && _b !== void 0 ? _b : "[]");
        }
        catch (_j) {
            await (0, client_1.sendMessage)(chatId, "Something went wrong — let me start over. Which visit do you want to swap the caregiver for?");
            await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: "identify_appointment", clientSwapVisits: admin.firestore.FieldValue.delete() });
            return;
        }
        // Question guard — "what's a swap?" / "will I keep my schedule?" used to
        // get parsed as a number and rejected with "reply with a number".
        if (await isQuestionOrOther(text)) {
            const answer = await answerSwapQuestion(text);
            await (0, client_1.sendMessage)(chatId, answer);
            const list = visits.map(v => `${v.index}. ${v.date} at ${v.time} with ${v.caregiverName}`).join("\n");
            await (0, client_1.sendMessage)(chatId, `When you're ready, which visit do you want to swap?\n${list}\n\nReply with the number.`);
            return;
        }
        const pick = parseInt(text.trim(), 10);
        const visit = visits.find((v) => v.index === pick);
        if (!visit) {
            await (0, client_1.sendMessage)(chatId, `Reply with a number between 1 and ${visits.length}.`);
            return;
        }
        // Find available replacement caregivers
        const dayOfWeek = new Date(visit.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
        const [shiftHour] = ((_c = visit.time) !== null && _c !== void 0 ? _c : "09:00").split(":").map(Number);
        const caregiverSnap = await db.collection("caregivers")
            .where("verified", "==", true)
            .limit(30)
            .get();
        const options = [];
        for (const doc of caregiverSnap.docs) {
            if (doc.id === visit.caregiverId)
                continue;
            const data = doc.data();
            const avail = (_d = data.weeklyAvailability) === null || _d === void 0 ? void 0 : _d[dayOfWeek];
            if (!(avail === null || avail === void 0 ? void 0 : avail.length))
                continue;
            const slotOk = avail.some(slot => {
                const startH = parseInt(slot.start.split(":")[0], 10);
                const endH = parseInt(slot.end.split(":")[0], 10);
                return shiftHour >= startH && shiftHour < endH;
            });
            if (!slotOk)
                continue;
            const conflict = await db.collection("appointments")
                .where("caregiverId", "==", doc.id)
                .where("date", "==", visit.date)
                .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
                .limit(1).get();
            if (!conflict.empty)
                continue;
            options.push({ id: doc.id, name: (_f = (_e = data.name) !== null && _e !== void 0 ? _e : data.firstName) !== null && _f !== void 0 ? _f : "Caregiver", rate: data.hourlyRate });
            if (options.length >= 3)
                break;
        }
        if (options.length === 0) {
            await (0, client_1.sendMessage)(chatId, `I wasn't able to find an available replacement caregiver for ${visit.date}. Would you like me to create a support ticket instead?`);
            await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });
            return;
        }
        await db.collection("agent_sessions").doc(clientPhone).update({
            clientSwapStep: "select_caregiver",
            clientSwapAppointmentId: visit.id,
            clientSwapDate: visit.date,
            clientSwapOptions: JSON.stringify(options),
        });
        const list = options.map((o, i) => `${i + 1}. ${o.name}${o.rate ? ` — $${o.rate}/hr` : ""}`).join("\n");
        await (0, client_1.sendMessage)(chatId, `Here are available caregivers for ${visit.date}:\n${list}\n\nWhich one would you like? Reply with the number, or say CANCEL to keep your current caregiver.`);
        return;
    }
    if (step === "select_caregiver") {
        if (text.trim().toUpperCase() === "CANCEL") {
            await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });
            await (0, client_1.sendMessage)(chatId, "No problem — keeping your current caregiver for that visit.");
            return;
        }
        let options = [];
        try {
            options = JSON.parse((_g = session.clientSwapOptions) !== null && _g !== void 0 ? _g : "[]");
        }
        catch (_k) {
            await (0, client_1.sendMessage)(chatId, "Something went wrong — let me start over. Which visit do you want to swap the caregiver for?");
            await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: "identify_appointment", clientSwapOptions: admin.firestore.FieldValue.delete() });
            return;
        }
        const pick = parseInt(text.trim(), 10);
        const chosen = options[pick - 1];
        if (!chosen) {
            await (0, client_1.sendMessage)(chatId, `Reply with a number between 1 and ${options.length}, or CANCEL.`);
            return;
        }
        const appointmentId = session.clientSwapAppointmentId;
        await db.collection("appointments").doc(appointmentId).update({
            caregiverId: chosen.id,
            caregiverName: chosen.name,
            swapNote: `Client-requested caregiver swap`,
        });
        await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });
        // Notify new caregiver
        const newCgSnap = await db.collection("caregivers").doc(chosen.id).get();
        if (newCgSnap.exists && ((_h = newCgSnap.data()) === null || _h === void 0 ? void 0 : _h.chatId)) {
            await (0, client_1.sendMessage)(newCgSnap.data().chatId, `Hi ${chosen.name}, you've been assigned a new visit on ${session.clientSwapDate}. Cara will send you more details soon.`);
        }
        await (0, client_1.sendMessage)(chatId, `Done — ${chosen.name} is now set for ${session.clientSwapDate}. I'll notify them. Let me know if you need anything else.`);
    }
}
//# sourceMappingURL=clientSwapRequestHandler.js.map