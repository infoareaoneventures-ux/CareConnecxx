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
exports.executeBookings = executeBookings;
exports.createBookingTask = createBookingTask;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const notifications_1 = require("../notifications");
async function hasConflict(caregiverId, date, startTime, endTime) {
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", date)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .get();
    return snap.docs.some((doc) => {
        const d = doc.data();
        return d.startTime < endTime && d.endTime > startTime;
    });
}
const db = admin.firestore();
async function executeBookings(taskId, clientPhone) {
    var _a, _b, _c, _d;
    const taskRef = db.collection("agent_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists)
        throw new Error(`agent_tasks/${taskId} not found`);
    const task = taskSnap.data();
    if (task.status !== "awaiting_approval")
        return; // Already processed
    if (new Date(task.expiresAt) < new Date()) {
        await taskRef.update({ status: "expired" });
        const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
        if (sessionSnap.exists) {
            await (0, client_1.sendMessage)(sessionSnap.data().chatId, "That booking request expired. Text me anytime to book again! 💙");
        }
        return;
    }
    const now = new Date().toISOString();
    // Check for scheduling conflicts before writing anything
    for (const appt of task.appointments) {
        if (await hasConflict(task.caregiverId, appt.date, appt.startTime, appt.endTime)) {
            await taskRef.update({ status: "conflict_detected" });
            const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
            if (sessionSnap.exists) {
                await (0, client_1.sendMessage)(sessionSnap.data().chatId, `⚠️ I couldn't complete the booking — ${task.caregiverName} already has a visit at that time.\n\n` +
                    `Reply YES and I'll search for a different caregiver. 🔍`);
            }
            await db.collection("admin_alerts").add({
                type: "booking_conflict",
                caregiverId: task.caregiverId,
                caregiverName: task.caregiverName,
                clientPhone,
                date: appt.date,
                startTime: appt.startTime,
                endTime: appt.endTime,
                createdAt: now,
                resolved: false,
            });
            return;
        }
    }
    // Write each appointment — this is the ONLY place appointments are written by the agent
    const batch = db.batch();
    const apptRefs = [];
    for (const appt of task.appointments) {
        const ref = db.collection("appointments").doc();
        apptRefs.push(ref);
        batch.set(ref, {
            clientId: task.clientId,
            caregiverId: task.caregiverId,
            caregiverName: task.caregiverName,
            date: appt.date,
            startTime: appt.startTime,
            endTime: appt.endTime,
            durationHours: appt.durationHours,
            status: "confirmed",
            createdByAgent: true,
            agentTaskId: taskId,
            humanApproved: true,
            approvedAt: now,
            createdAt: now,
        });
    }
    batch.update(taskRef, { status: "approved", humanApproved: true, approvedAt: now });
    await batch.commit();
    (0, notifications_1.notifyAdminBookingConfirmed)({
        taskId: taskId,
        caregiverName: task.caregiverName,
        clientPhone: clientPhone,
        appointmentCount: task.appointments.length,
        totalCost: task.totalCost,
    }).catch((err) => console.error("notifyAdminBookingConfirmed error:", err));
    const appUrl = (_a = process.env.APP_URL) !== null && _a !== void 0 ? _a : "https://app.careconnecxx.com";
    // Confirm to family
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (sessionSnap.exists) {
        const lines = task.appointments.map((a) => `📅 ${a.date} · ${a.startTime}–${a.endTime} · ${task.caregiverName} ✅`).join("\n");
        await (0, client_1.sendMessage)(sessionSnap.data().chatId, `✅ All booked! Here's your confirmed schedule:\n\n` +
            `${lines}\n\n` +
            `I'll text you when ${task.caregiverName} arrives for the first visit.\n` +
            `View your schedule: ${appUrl}/client/schedule\n\n` +
            `Any questions? Just text me. 💙`);
    }
    // Notify caregiver
    const caregiverSnap = await db.collection("caregivers").doc(task.caregiverId).get();
    const cgPhone = (_b = caregiverSnap.data()) === null || _b === void 0 ? void 0 : _b.phone;
    if (cgPhone) {
        const cgSession = await (0, client_1.getOrCreateSession)(cgPhone, { caregiverId: task.caregiverId });
        const firstAppt = task.appointments[0];
        await (0, client_1.sendMessage)(cgSession.chatId, `New booking confirmed! 🎉\n\n` +
            `Client: A family who needs care in your area\n` +
            `📅 Starting ${firstAppt.date} at ${firstAppt.startTime}\n` +
            `💰 $${(((_d = (_c = caregiverSnap.data()) === null || _c === void 0 ? void 0 : _c.hourlyRate) !== null && _d !== void 0 ? _d : 20) * firstAppt.durationHours).toFixed(2)} per visit\n\n` +
            `I'll send you the care plan and directions the morning of each visit.\n\n` +
            `Reply CONFIRM to accept or ISSUE if something's wrong.`);
    }
}
// ── Create a booking task (called from webhooks/agents) ───────────────────────
async function createBookingTask(params) {
    const totalCost = params.appointments.reduce((sum, a) => sum + params.hourlyRate * a.durationHours, 0);
    const now = new Date();
    const ref = await db.collection("agent_tasks").add({
        type: "booking_confirmation",
        clientPhone: params.clientPhone,
        clientId: params.clientId,
        caregiverId: params.caregiverId,
        caregiverName: params.caregiverName,
        appointments: params.appointments,
        totalCost,
        status: "awaiting_approval",
        humanApproved: false,
        expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        createdAt: now.toISOString(),
    });
    return ref.id;
}
//# sourceMappingURL=bookingExecutor.js.map