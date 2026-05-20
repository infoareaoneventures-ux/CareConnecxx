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
exports.handleCaregiverSwapRequest = handleCaregiverSwapRequest;
exports.handleSwapAcceptance = handleSwapAcceptance;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const db = admin.firestore();
async function handleCaregiverSwapRequest(caregiverId, caregiverName, caregiverPhone, text, session, chatId) {
    var _a, _b;
    const step = (_a = session.swapStep) !== null && _a !== void 0 ? _a : "identify_shift";
    if (step === "identify_shift") {
        // Find upcoming confirmed appointments for this caregiver
        const today = new Date().toISOString().split("T")[0];
        const snap = await db.collection("appointments")
            .where("caregiverId", "==", caregiverId)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .where("date", ">=", today)
            .orderBy("date", "asc")
            .limit(5)
            .get();
        if (snap.empty) {
            await (0, client_1.sendMessage)(chatId, "You don't have any upcoming shifts to swap.");
            return;
        }
        const shifts = snap.docs.map((d, i) => ({
            index: i + 1,
            id: d.id,
            date: d.data().date,
            time: d.data().time,
            clientName: d.data().clientName,
            clientId: d.data().clientId,
            duration: d.data().duration,
        }));
        await db.collection("agent_sessions").doc(caregiverPhone).update({
            swapStep: "confirm_shift",
            swapCandidates: JSON.stringify(shifts),
        });
        const list = shifts.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
        await (0, client_1.sendMessage)(chatId, `Which shift do you need covered?\n${list}\n\nReply with the number.`);
        return;
    }
    if (step === "confirm_shift") {
        const candidates = JSON.parse((_b = session.swapCandidates) !== null && _b !== void 0 ? _b : "[]");
        const pick = parseInt(text.trim(), 10);
        const shift = candidates.find((s) => s.index === pick);
        if (!shift) {
            await (0, client_1.sendMessage)(chatId, `Please reply with a number between 1 and ${candidates.length}.`);
            return;
        }
        await db.collection("agent_sessions").doc(caregiverPhone).update({
            swapStep: "broadcasting",
            swapShiftId: shift.id,
            swapShiftDate: shift.date,
            swapClientId: shift.clientId,
        });
        await (0, client_1.sendMessage)(chatId, `Got it — ${shift.date} at ${shift.time} with the ${shift.clientName} family. I'll find available caregivers now and reach out to them. I'll let you know when someone accepts.`);
        // Find available caregivers and broadcast
        await broadcastSwapRequest(caregiverId, caregiverName, shift, caregiverPhone, chatId);
        return;
    }
}
async function broadcastSwapRequest(fromCaregiverId, fromCaregiverName, shift, fromPhone, fromChatId) {
    var _a, _b, _c, _d, _e, _f, _g;
    // Query available caregivers
    const caregiverSnap = await db.collection("caregivers")
        .where("verified", "==", true)
        .limit(30)
        .get();
    const dayOfWeek = new Date(shift.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const [shiftHour] = ((_a = shift.time) !== null && _a !== void 0 ? _a : "09:00").split(":").map(Number);
    // Filter: not the requesting caregiver, available that day, not already booked
    const candidates = [];
    for (const doc of caregiverSnap.docs) {
        if (doc.id === fromCaregiverId)
            continue;
        const data = doc.data();
        // Check weekly availability
        const avail = (_b = data.weeklyAvailability) === null || _b === void 0 ? void 0 : _b[dayOfWeek];
        if (!(avail === null || avail === void 0 ? void 0 : avail.length))
            continue;
        const slotOk = avail.some(slot => {
            const startH = parseInt(slot.start.split(":")[0], 10);
            const endH = parseInt(slot.end.split(":")[0], 10);
            return shiftHour >= startH && shiftHour < endH;
        });
        if (!slotOk)
            continue;
        // Check not already booked
        const conflictSnap = await db.collection("appointments")
            .where("caregiverId", "==", doc.id)
            .where("date", "==", shift.date)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .limit(1)
            .get();
        if (!conflictSnap.empty)
            continue;
        candidates.push({ id: doc.id, name: (_d = (_c = data.name) !== null && _c !== void 0 ? _c : data.firstName) !== null && _d !== void 0 ? _d : "Caregiver", phone: data.phone, chatId: data.chatId });
        if (candidates.length >= 3)
            break;
    }
    if (candidates.length === 0) {
        await (0, client_1.sendMessage)(fromChatId, "I wasn't able to find any available caregivers for that shift. You may need to contact your coordinator or cancel the shift directly.");
        await db.collection("agent_sessions").doc(fromPhone).update({ swapStep: admin.firestore.FieldValue.delete() });
        return;
    }
    // Create swap request doc
    const swapRef = await db.collection("shift_swap_requests").add({
        appointmentId: shift.id,
        fromCaregiverId,
        fromCaregiverName,
        clientId: shift.clientId,
        date: shift.date,
        time: shift.time,
        duration: shift.duration,
        status: "open",
        candidatesContacted: candidates.map(c => c.id),
        candidateResponses: [],
        initiatedBy: "caregiver",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    // Text each candidate
    for (const candidate of candidates) {
        if (!candidate.chatId && !candidate.phone)
            continue;
        const targetChatId = (_e = candidate.chatId) !== null && _e !== void 0 ? _e : candidate.phone;
        const msg = `Hi ${candidate.name}, ${fromCaregiverName} is looking for coverage:\n📅 ${shift.date} at ${shift.time}\n👤 ${(_f = shift.clientName) !== null && _f !== void 0 ? _f : "a family"}\n\nAre you available? Reply ACCEPT or DECLINE.`;
        try {
            await (0, client_1.sendMessage)(targetChatId, msg);
            // Mark their session with the pending swap
            await db.collection("agent_sessions").doc((_g = candidate.phone) !== null && _g !== void 0 ? _g : candidate.id).set({ pendingSwapRequestId: swapRef.id, pendingSwapFromName: fromCaregiverName }, { merge: true });
        }
        catch (e) {
            console.error(`Failed to reach candidate ${candidate.id}:`, e);
        }
    }
}
async function handleSwapAcceptance(caregiverId, caregiverName, swapRequestId, chatId) {
    var _a, _b;
    const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
    const swapDoc = await swapRef.get();
    if (!swapDoc.exists) {
        await (0, client_1.sendMessage)(chatId, "That swap request is no longer available.");
        return;
    }
    const swap = swapDoc.data();
    if (swap.status !== "open") {
        await (0, client_1.sendMessage)(chatId, "This shift has already been filled. Thanks anyway!");
        return;
    }
    // Accept: update swap request + appointment
    await db.runTransaction(async (tx) => {
        tx.update(swapRef, {
            status: "accepted",
            toCaregiverId: caregiverId,
            toCaregiverName: caregiverName,
            acceptedAt: new Date().toISOString(),
        });
        tx.update(db.collection("appointments").doc(swap.appointmentId), {
            caregiverId,
            caregiverName,
            swappedFrom: swap.fromCaregiverId,
            swapNote: `Swapped from ${swap.fromCaregiverName} to ${caregiverName}`,
        });
    });
    // Confirm with accepting caregiver
    await (0, client_1.sendMessage)(chatId, `You've got it! The ${swap.date} shift is now yours. The family will be notified. Thank you!`);
    // Notify original caregiver
    const fromSnap = await db.collection("caregivers").doc(swap.fromCaregiverId).get();
    if (fromSnap.exists && ((_a = fromSnap.data()) === null || _a === void 0 ? void 0 : _a.chatId)) {
        await (0, client_1.sendMessage)(fromSnap.data().chatId, `Good news — ${caregiverName} has accepted coverage for your ${swap.date} shift. You're all set!`);
    }
    // Notify client
    const clientSnap = await db.collection("users").doc(swap.clientId).get();
    if (clientSnap.exists && ((_b = clientSnap.data()) === null || _b === void 0 ? void 0 : _b.chatId)) {
        await (0, client_1.sendMessage)(clientSnap.data().chatId, `Heads up — your caregiver for ${swap.date} has changed. ${caregiverName} will be covering that visit. Let me know if you have any questions.`);
    }
}
//# sourceMappingURL=caregiverSwapHandler.js.map