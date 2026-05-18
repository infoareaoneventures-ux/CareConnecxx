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
exports.handleTaskApproval = handleTaskApproval;
exports.finalizeTaskApproval = finalizeTaskApproval;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const bookingExecutor_1 = require("./bookingExecutor");
const db = admin.firestore();
async function handleTaskApproval(taskDoc, choice, session, chatId) {
    var _a, _b, _c, _d, _e, _f;
    const task = taskDoc.data();
    const options = (_a = task.options) !== null && _a !== void 0 ? _a : [];
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= options.length) {
        await (0, client_1.sendMessage)(chatId, "Please reply 1, 2, or 3 to choose a caregiver.");
        return;
    }
    const selected = options[idx];
    // Validate caregiver is still active
    const cgSnap = selected.caregiverId
        ? await db.collection("caregivers").doc(selected.caregiverId).get()
        : null;
    if (cgSnap && cgSnap.exists && ((_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.status) === "inactive") {
        await (0, client_1.sendMessage)(chatId, `${selected.name} is no longer available. Want me to search for another caregiver?`);
        return;
    }
    // Store selection so CONFIRM reply can finalize it
    await taskDoc.ref.update({ status: "pending_confirm", selectedIdx: idx });
    await db.collection("agent_sessions").doc((_c = session.phone) !== null && _c !== void 0 ? _c : taskDoc.ref.path).update({
        pendingTaskConfirm: {
            taskId: taskDoc.id,
            caregiverName: selected.name,
            caregiverId: (_d = selected.caregiverId) !== null && _d !== void 0 ? _d : "",
            time: (_e = task.time) !== null && _e !== void 0 ? _e : "",
        },
    }).catch(() => { });
    await (0, client_1.sendMessage)(chatId, `Got it — ${selected.name} for your ${(_f = task.time) !== null && _f !== void 0 ? _f : "upcoming"} visit.\n\n` +
        `Reply CONFIRM to book, or SKIP to choose someone else.`);
}
// Called when user replies CONFIRM after handleTaskApproval
async function finalizeTaskApproval(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const pending = session.pendingTaskConfirm;
    if (!pending) {
        await (0, client_1.sendMessage)(chatId, "I don't have a pending booking to confirm. Want me to search for caregivers?");
        return;
    }
    // Pull original task for appointment details
    const taskSnap = await db.collection("agent_tasks").doc(pending.taskId).get();
    if (!taskSnap.exists) {
        await (0, client_1.sendMessage)(chatId, "That booking has expired. Want me to start a fresh search?");
        await db.collection("agent_sessions").doc(phone).update({
            pendingTaskConfirm: admin.firestore.FieldValue.delete(),
        }).catch(() => { });
        return;
    }
    const task = taskSnap.data();
    // Create a real booking task that goes through the standard confirmation flow
    const clientId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    const cgSnap = await db.collection("caregivers").doc(pending.caregiverId).get();
    const hourlyRate = ((_c = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.hourlyRate) !== null && _c !== void 0 ? _c : 20);
    // Use appointments from original task or fall back to stored time
    const appointments = ((_d = task.appointments) !== null && _d !== void 0 ? _d : [{
            date: (_e = task.date) !== null && _e !== void 0 ? _e : new Date().toISOString().slice(0, 10),
            startTime: (_f = task.startTime) !== null && _f !== void 0 ? _f : "09:00",
            endTime: (_g = task.endTime) !== null && _g !== void 0 ? _g : "17:00",
            durationHours: (_h = task.durationHours) !== null && _h !== void 0 ? _h : 8,
        }]);
    const bookingTaskId = await (0, bookingExecutor_1.createBookingTask)({
        clientPhone: phone,
        clientId,
        caregiverId: pending.caregiverId,
        caregiverName: pending.caregiverName,
        appointments,
        hourlyRate,
        isEmergencyReplacement: task.type === "replacement_confirmation",
    });
    await db.collection("agent_sessions").doc(phone).update({
        pendingTaskConfirm: admin.firestore.FieldValue.delete(),
    }).catch(() => { });
    if (bookingTaskId) {
        // Auto-approve — user already confirmed intent
        const { executeBookings } = await Promise.resolve().then(() => __importStar(require("./bookingExecutor")));
        await executeBookings(bookingTaskId, phone);
    }
    else {
        await (0, client_1.sendMessage)(chatId, "Something went wrong starting the booking. Try again or text FIND to search for a new caregiver.");
    }
}
//# sourceMappingURL=taskApprovalHandler.js.map