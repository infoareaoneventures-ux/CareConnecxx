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
const jobNotifications_1 = require("../triggers/jobNotifications");
async function hasConflict(caregiverId, date, startTime, endTime) {
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", date)
        .where("status", "in", ["confirmed", "in-progress", "pending_caregiver_confirmation"])
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
    // Atomically claim the task — prevents duplicate execution from concurrent YES replies.
    // Transitions: awaiting_approval → processing (success) | expired (timed out) | no-op (already claimed).
    let task = null;
    let didExpire = false;
    await db.runTransaction(async (t) => {
        const snap = await t.get(taskRef);
        if (!snap.exists)
            throw new Error(`agent_tasks/${taskId} not found`);
        const data = snap.data();
        if (data.status !== "awaiting_approval")
            return; // Already claimed or processed — no-op
        if (new Date(data.expiresAt) < new Date()) {
            t.update(taskRef, { status: "expired" });
            task = data;
            didExpire = true;
            return;
        }
        t.update(taskRef, { status: "processing" });
        task = data;
    });
    if (!task)
        return; // Already processed by a concurrent caller
    if (didExpire) {
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
            // Mark this caregiver as rejected so matching skips them in the retry
            await db.collection("agent_sessions").doc(clientPhone).update({
                rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(task.caregiverId),
            }).catch(() => { });
            // Set an active goal so Cara carries booking context through the re-match.
            // If this fails, reset the task to awaiting_approval so the family can retry.
            const { setActiveGoal } = await Promise.resolve().then(() => __importStar(require("./qaAgent")));
            const goalSet = await setActiveGoal(clientPhone, "booking", `Rebook after conflict with ${task.caregiverName} on ${appt.date}`, { originalDate: appt.date, startTime: appt.startTime, endTime: appt.endTime, durationHours: appt.durationHours }).then(() => true).catch((err) => {
                console.error("bookingExecutor: setActiveGoal failed", err);
                return false;
            });
            if (!goalSet) {
                await taskRef.update({ status: "awaiting_approval" }).catch(() => { });
                return;
            }
            const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
            if (sessionSnap.exists) {
                const sessionData = sessionSnap.data();
                await (0, client_1.sendMessage)(sessionData.chatId, `${task.caregiverName} already has a visit at that time — finding someone else for ${appt.date}.`);
                // Auto-retry matching immediately — family sees results without replying
                const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("./matchingAgent")));
                await runMatchingForClient(clientPhone, sessionData.chatId, sessionData, sessionData).catch((err) => console.error("bookingExecutor: conflict re-match failed", err));
            }
            return;
        }
    }
    // Idempotency guard: if Cloud Functions retries this invocation after a partial commit,
    // agentTaskId is already on every appointment written in the first attempt — skip if found.
    const existingAppts = await db.collection("appointments")
        .where("agentTaskId", "==", taskId)
        .limit(1)
        .get();
    if (!existingAppts.empty) {
        await taskRef.update({ status: "approved", humanApproved: true }).catch(() => { });
        return;
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
    await (0, jobNotifications_1.closeJobPost)(task.clientId).catch((err) => console.error("[executeBookings] closeJobPost failed:", err));
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
        const lines = task.appointments.map((a) => `${a.date} · ${a.startTime}–${a.endTime} · ${task.caregiverName}`).join("\n");
        await (0, client_1.sendMessage)(sessionSnap.data().chatId, `All booked! Here's your confirmed schedule:\n\n` +
            `${lines}\n\n` +
            `I'll text you when ${task.caregiverName} arrives for the first visit.\n` +
            `View your schedule: ${appUrl}/client/calendar\n\n` +
            `Any questions? Just text me.`);
        // Ask about recurring care — only for single-visit (one-time) bookings
        if (task.appointments.length === 1) {
            const firstAppt = task.appointments[0];
            const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(firstAppt.date).getDay()];
            const schedDesc = `${dayOfWeek}s ${firstAppt.startTime}–${firstAppt.endTime}`;
            // Write session flag BEFORE sending the message to avoid a race where a fast
            // YES reply arrives before the Firestore write lands.
            await db.collection("agent_sessions").doc(clientPhone).update({
                awaitingRecurringConfirmation: true,
                pendingRecurringSchedule: {
                    caregiverId: task.caregiverId,
                    caregiverName: task.caregiverName,
                    days: [dayOfWeek],
                    startTime: firstAppt.startTime,
                    endTime: firstAppt.endTime,
                    durationHours: firstAppt.durationHours,
                    hourlyRate: (() => {
                        var _a;
                        const totalHours = task.appointments.reduce((s, a) => s + a.durationHours, 0);
                        return totalHours > 0 ? ((_a = task.hourlyRate) !== null && _a !== void 0 ? _a : task.totalCost / totalHours) : 20;
                    })(),
                },
            }).catch(() => { });
            await (0, client_1.sendMessage)(sessionSnap.data().chatId, `Want me to set this up as a weekly recurring schedule — ${schedDesc} every week with ${task.caregiverName}? ` +
                `I'll handle the bookings automatically.\n\nReply YES to set it up, or NO to keep it one visit at a time.`);
        }
        // Post-crisis emotional anchoring — only for emergency replacements
        if (task.isEmergencyReplacement) {
            // Clear the active task roster entry — replacement is resolved
            await db.collection("agent_tasks_active").doc(clientPhone).delete().catch(() => { });
            await new Promise(r => setTimeout(r, 3000));
            await (0, client_1.sendMessage)(sessionSnap.data().chatId, `Last-minute coverage is one of the hardest parts of care. That's exactly what I'm here for. 💙`);
        }
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
                // Mark the task so it can be auto-retried when the card is added
                await db.collection("agent_tasks").doc(taskId).update({
                    status: "pending_payment_setup",
                    stripeCustomerId: stripeCustomerId !== null && stripeCustomerId !== void 0 ? stripeCustomerId : null,
                    paymentSetupSentAt: new Date().toISOString(),
                }).catch(() => { });
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
    const ref = await db.collection("agent_tasks").add(Object.assign({ type: "booking_confirmation", clientPhone: params.clientPhone, clientId: params.clientId, caregiverId: params.caregiverId, caregiverName: params.caregiverName, appointments: params.appointments, totalCost, status: "awaiting_approval", humanApproved: false, expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(), createdAt: now.toISOString() }, (params.isEmergencyReplacement && { isEmergencyReplacement: true })));
    return ref.id;
}
//# sourceMappingURL=bookingExecutor.js.map