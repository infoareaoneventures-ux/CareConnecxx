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
exports.processEvent = processEvent;
exports.runInteractionAgent = runInteractionAgent;
exports.runExecutionAgent = runExecutionAgent;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const matchingAgent_1 = require("./matchingAgent");
const bookingExecutor_1 = require("./bookingExecutor");
const db = admin.firestore();
// ── processEvent — internal natural language event dispatch ───────────────────
async function processEvent(eventType, payload) {
    switch (eventType) {
        case "journal.created":
            await handleJournalEvent(payload);
            break;
        case "appointment.cancelled":
            await handleAppointmentCancelledEvent(payload);
            break;
        case "caregiver.arrived":
            await handleCaregiverArrivedEvent(payload);
            break;
        case "interview.scheduled":
            // Future: notify family and caregiver with calendar details
            break;
        default:
            console.warn(`processEvent: unknown eventType "${eventType}"`);
    }
}
// ── Event handlers ────────────────────────────────────────────────────────────
async function handleJournalEvent(payload) {
    var _a;
    const { seniorId, caregiverId } = payload;
    if (!seniorId)
        return;
    const clientDoc = await db.collection("users").doc(seniorId).get();
    const phone = (_a = clientDoc.data()) === null || _a === void 0 ? void 0 : _a.phone;
    if (!phone)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut || session.optedIn === false)
        return;
    // Delegate to journalCreated trigger logic — already handles health signals + message
    // processEvent is a dispatch layer; actual logic stays in triggers/journalCreated.ts
    console.log(`processEvent journal.created: seniorId=${seniorId}, caregiver=${caregiverId}`);
}
async function handleAppointmentCancelledEvent(payload) {
    const { clientPhone, caregiverName, date } = payload;
    if (!clientPhone)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut)
        return;
    await (0, client_1.sendMessage)(session.chatId, `Heads up — ${caregiverName !== null && caregiverName !== void 0 ? caregiverName : "your caregiver"}'s visit on ${date !== null && date !== void 0 ? date : "today"} has been cancelled.\n\n` +
        `Want me to find a replacement? Reply YES and I'll get on it right away. 💙`);
}
async function handleCaregiverArrivedEvent(payload) {
    const { clientPhone, caregiverName } = payload;
    if (!clientPhone)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut)
        return;
    await (0, client_1.sendMessage)(session.chatId, `${caregiverName !== null && caregiverName !== void 0 ? caregiverName : "Your caregiver"} has arrived for today's visit. 💙`);
}
// ── Interaction Agent — NLU only, reads only ──────────────────────────────────
async function runInteractionAgent(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
    const norm = text.trim().toUpperCase();
    // Delegate hire intent → booking execution
    if (norm === "HIRE") {
        const outcome = session.pendingInterviewOutcome;
        if (outcome) {
            return {
                type: "booking",
                payload: {
                    mode: "hire",
                    caregiverName: outcome.caregiverName,
                    caregiverId: outcome.caregiverId,
                    phone,
                    chatId,
                },
            };
        }
    }
    // Delegate YES to pending booking task → execution
    if ((norm === "YES" || norm === "Y")) {
        const taskSnap = await db
            .collection("agent_tasks")
            .where("clientPhone", "==", phone)
            .where("status", "==", "awaiting_approval")
            .limit(1).get();
        if (!taskSnap.empty) {
            return {
                type: "booking",
                payload: { taskId: taskSnap.docs[0].id, phone, chatId },
            };
        }
    }
    // Search for caregiver
    if (norm.includes("FIND") ||
        norm.includes("CAREGIVER") ||
        norm.includes("NEED HELP") ||
        norm.includes("LOOKING FOR")) {
        return {
            type: "matching",
            payload: { clientId: (_a = session.userId) !== null && _a !== void 0 ? _a : phone, phone, chatId },
        };
    }
    // Default: hand off to QA agent
    return {
        type: "qa",
        payload: {
            text,
            phone,
            chatId,
            userId: (_b = session.userId) !== null && _b !== void 0 ? _b : phone,
            seniorId: (_d = (_c = session.seniorId) !== null && _c !== void 0 ? _c : session.userId) !== null && _d !== void 0 ? _d : phone,
            userType: (_e = session.userType) !== null && _e !== void 0 ? _e : "client",
            caregiverId: session.caregiverId,
        },
    };
}
// ── Execution Agents — write to Firestore, no Claude calls ───────────────────
async function runExecutionAgent(task) {
    switch (task.type) {
        case "booking":
            await bookingAgent(task.payload);
            break;
        case "matching":
            await matchingAgent(task.payload);
            break;
        case "alert":
            await alertAgent(task.payload);
            break;
        case "memory_update":
            await memoryAgent(task.payload);
            break;
        case "wait":
            // Deliberate silence — no action needed
            break;
        case "qa":
            // QA is handled separately in webhooks.ts via runQaAgent
            break;
    }
}
// ── Execution agent implementations ──────────────────────────────────────────
async function bookingAgent(payload) {
    const { taskId, phone } = payload;
    if (taskId) {
        // Execute an existing booking task
        await (0, bookingExecutor_1.executeBookings)(taskId, phone);
    }
    else if (payload.mode === "hire") {
        // HIRE flow: set up hireMode and prompt for start date
        const { caregiverName, phone: p, chatId: c } = payload;
        await db.collection("agent_sessions").doc(p).update({
            hireMode: caregiverName,
            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(c, `Great choice! 🎉 ${caregiverName} will be thrilled.\n\n` +
            `What date should their first visit be? (e.g. "this Monday" or "June 15")`);
    }
}
async function matchingAgent(payload) {
    var _a;
    const { phone, chatId } = payload;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    const session = (_a = sessionSnap.data()) !== null && _a !== void 0 ? _a : {};
    await (0, matchingAgent_1.runMatchingForClient)(phone, chatId, session, session);
}
async function alertAgent(payload) {
    const { chatId, message, type, metadata } = payload;
    if (!chatId || !message)
        return;
    await (0, client_1.sendMessage)(chatId, message);
    await db.collection("agent_alerts_log").add(Object.assign({ type: type !== null && type !== void 0 ? type : "agent_alert", sentAt: new Date().toISOString() }, (typeof metadata === "object" && metadata !== null ? metadata : {})));
}
async function memoryAgent(payload) {
    // Memory writes are handled in learnedFacts.ts and memoryFiles.ts
    // This stub allows future routing through the execution agent
    const { userId, text } = payload;
    if (!userId || !text)
        return;
    const { extractAndStoreFacts } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
    await extractAndStoreFacts(userId, text).catch(() => { });
}
//# sourceMappingURL=caraAgent.js.map