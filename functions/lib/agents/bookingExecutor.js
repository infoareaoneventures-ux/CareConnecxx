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
const auditLog_1 = require("../observability/auditLog");
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
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
            await (0, client_1.sendMessage)(sessionSnap.data().chatId, `The booking for ${task.caregiverName} timed out. Those expire after 2 hours to keep availability current.\n\n` +
                `Want me to start it again? Reply YES and I'll pull up where we left off.`);
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
    (0, auditLog_1.logBookingCreated)(task.clientId, task.caregiverId, task.appointments.map((a) => a.date)).catch(() => { });
    (0, notifications_1.notifyAdminBookingConfirmed)({
        taskId: taskId,
        caregiverName: task.caregiverName,
        clientPhone: clientPhone,
        appointmentCount: task.appointments.length,
        totalCost: task.totalCost,
    }).catch((err) => console.error("notifyAdminBookingConfirmed error:", err));
    const appUrl = (_a = process.env.APP_URL) !== null && _a !== void 0 ? _a : "https://cara.app";
    // Confirm to family
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (sessionSnap.exists) {
        const lines = task.appointments.map((a) => `📅 ${a.date} · ${a.startTime}–${a.endTime} · ${task.caregiverName} ✅`).join("\n");
        await (0, client_1.sendMessage)(sessionSnap.data().chatId, `✅ All booked! Here's your confirmed schedule:\n\n` +
            `${lines}\n\n` +
            `I'll text you when ${task.caregiverName} arrives for the first visit.\n` +
            `View your schedule: ${appUrl}/client/schedule\n\n` +
            `Any questions? Just text me.`);
        // Check if client has a payment method — if not, send a Stripe setup link
        try {
            const Stripe = (await Promise.resolve().then(() => __importStar(require("stripe")))).default;
            const stripeClient = new Stripe((_b = process.env.STRIPE_SECRET_KEY) !== null && _b !== void 0 ? _b : "");
            const clientSnap = await db.collection("users").doc((_c = task.clientId) !== null && _c !== void 0 ? _c : "").get();
            const stripeCustomerId = (_d = clientSnap.data()) === null || _d === void 0 ? void 0 : _d.stripeCustomerId;
            let hasPaymentMethod = false;
            if (stripeCustomerId) {
                const customer = await stripeClient.customers.retrieve(stripeCustomerId);
                hasPaymentMethod = !!(((_e = customer.invoice_settings) === null || _e === void 0 ? void 0 : _e.default_payment_method) ||
                    customer.default_source);
            }
            if (!hasPaymentMethod) {
                const { generateToken } = await Promise.resolve().then(() => __importStar(require("./tokenService")));
                const token = generateToken({ phone: clientPhone, task: "payment" });
                const setupUrl = `${appUrl}/done?task=payment&t=${token}`;
                await (0, client_1.sendMessage)(sessionSnap.data().chatId, `One more thing — to pay ${task.caregiverName} after each visit, ` +
                    `add a card on file (takes 30 seconds): ${setupUrl}`);
            }
        }
        catch (err) {
            console.error("bookingExecutor payment method check error:", err);
        }
    }
    // Notify caregiver
    const [caregiverSnap, clientSnap] = await Promise.all([
        db.collection("caregivers").doc(task.caregiverId).get(),
        db.collection("users").doc(task.clientId).get(),
    ]);
    const cgPhone = (_f = caregiverSnap.data()) === null || _f === void 0 ? void 0 : _f.phone;
    const seniorName = (_l = (_h = (_g = clientSnap.data()) === null || _g === void 0 ? void 0 : _g.seniorName) !== null && _h !== void 0 ? _h : (_k = (_j = clientSnap.data()) === null || _j === void 0 ? void 0 : _j.senior) === null || _k === void 0 ? void 0 : _k.name) !== null && _l !== void 0 ? _l : null;
    if (cgPhone) {
        const cgSession = await (0, client_1.getOrCreateSession)(cgPhone, { caregiverId: task.caregiverId });
        const firstAppt = task.appointments[0];
        const visitPay = (((_o = (_m = caregiverSnap.data()) === null || _m === void 0 ? void 0 : _m.hourlyRate) !== null && _o !== void 0 ? _o : 20) * firstAppt.durationHours).toFixed(2);
        const clientLabel = seniorName ? `with ${seniorName}` : "with your client";
        await (0, client_1.sendMessage)(cgSession.chatId, `You're booked ${clientLabel} starting ${firstAppt.date} at ${firstAppt.startTime}.\n\n` +
            `$${visitPay} per visit, paid automatically after each one.\n\n` +
            `I'll text you the care plan and directions the morning of every visit.`);
    }
}
// ── Create a booking task (called from webhooks/agents) ───────────────────────
async function createBookingTask(params) {
    var _a, _b, _c, _d;
    // Block booking if caregiver's background check is still pending
    const cgSnap = await db.collection("caregivers").doc(params.caregiverId).get();
    const cgStatus = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.status;
    if (cgStatus === "pending_review") {
        const submittedAt = (_c = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.backgroundCheckData) === null || _c === void 0 ? void 0 : _c.submittedAt;
        const daysInReview = submittedAt
            ? Math.ceil((Date.now() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24))
            : 0;
        const sessionSnap = await db.collection("agent_sessions").doc(params.clientPhone).get();
        const chatId = (_d = sessionSnap.data()) === null || _d === void 0 ? void 0 : _d.chatId;
        if (chatId) {
            await (0, client_1.sendMessage)(chatId, `${params.caregiverName}'s background check is still in progress ` +
                `(${daysInReview > 0 ? `${daysInReview} day${daysInReview !== 1 ? "s" : ""} in review` : "just submitted"}).\n\n` +
                `I'll notify you the moment it clears so you can book. Want me to find another available caregiver in the meantime?`);
        }
        return ""; // Early return — no booking written
    }
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