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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_TOOLS = void 0;
exports.handleToolCall = handleToolCall;
const admin = __importStar(require("firebase-admin"));
const matchingAgent_1 = require("../agents/matchingAgent");
const auditLog_1 = require("../observability/auditLog");
const memoryFiles_1 = require("../memory/memoryFiles");
const db = admin.firestore();
exports.MCP_TOOLS = [
    {
        name: "get_senior_profile",
        description: "Get the profile of the senior being cared for, including name, age, diagnoses, and care needs.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's user ID" },
            },
            required: ["seniorId"],
        },
    },
    {
        name: "get_care_journal",
        description: "Get recent care journal entries for a senior, including wellness, meals, medications, and notes.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's user ID" },
                limit: { type: "number", description: "Number of entries to return (default 5)" },
            },
            required: ["seniorId"],
        },
    },
    {
        name: "get_upcoming_appointments",
        description: "Get upcoming confirmed or pending appointments for a client.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "get_caregiver_info",
        description: "Get a caregiver's profile including name, rate, specialties, and rating.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's ID" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_caregiver_reviews",
        description: "Fetch reviews for a specific caregiver.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                limit: { type: "number", description: "Max reviews to return (default 5)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_health_signals",
        description: "Get health signals detected from recent care journal entries for a senior (last 30 days).",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's user ID" },
            },
            required: ["seniorId"],
        },
    },
    {
        name: "get_billing_summary",
        description: "Get the client's current subscription status and recent billing history.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The client's user ID" },
            },
            required: ["userId"],
        },
    },
    {
        name: "find_replacement_caregivers",
        description: "Search for available caregivers matching the client's care needs.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                phone: { type: "string", description: "The client's phone number" },
                chatId: { type: "string", description: "The client's chat ID for sending results" },
            },
            required: ["clientId", "phone", "chatId"],
        },
    },
    {
        name: "request_booking",
        description: "Create a booking request for a caregiver. Returns the booking task ID.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string" },
                caregiverId: { type: "string" },
                dates: { type: "array", items: { type: "string" }, description: "ISO date strings (YYYY-MM-DD)" },
                startTime: { type: "string", description: "e.g. '09:00'" },
                endTime: { type: "string", description: "e.g. '17:00'" },
            },
            required: ["clientId", "caregiverId", "dates", "startTime", "endTime"],
        },
    },
    {
        name: "update_preferences",
        description: "Update Cara's notification preferences for the user (DND, active hours, etc.).",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string" },
                dndEnabled: { type: "boolean" },
                dndStart: { type: "string", description: "HH:MM e.g. '22:00'" },
                dndEnd: { type: "string", description: "HH:MM e.g. '08:00'" },
            },
            required: ["userId"],
        },
    },
    {
        name: "log_health_flag",
        description: "Log a health concern flagged directly by the family member (not from a journal entry).",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string" },
                signalType: { type: "string", description: "e.g. 'falls', 'appetite_loss', 'confusion'" },
                description: { type: "string" },
            },
            required: ["seniorId", "signalType", "description"],
        },
    },
    {
        name: "read_memory_file",
        description: "Read one of Cara's long-term memory files for a user (profile, health, family, recent_episodes, procedural).",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The user's ID" },
                file: { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
            },
            required: ["userId", "file"],
        },
    },
    {
        name: "update_memory_file",
        description: "Append new information to one of Cara's long-term memory files for a user.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The user's ID" },
                file: { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
                content: { type: "string", description: "Markdown content to append to the file" },
            },
            required: ["userId", "file", "content"],
        },
    },
];
// ── Tool executor ─────────────────────────────────────────────────────────────
async function handleToolCall(name, input) {
    var _a, _b, _c, _d, _e, _f, _g;
    const nowIso = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    switch (name) {
        case "get_senior_profile": {
            (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_senior_profile").catch(() => { });
            const snap = await db.collection("seniors").doc(input.seniorId).get();
            return (_a = snap.data()) !== null && _a !== void 0 ? _a : { error: "Senior not found" };
        }
        case "get_care_journal": {
            (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_care_journal").catch(() => { });
            const limit = (_b = input.limit) !== null && _b !== void 0 ? _b : 5;
            const snap = await db
                .collection("care_journal")
                .where("seniorId", "==", input.seniorId)
                .orderBy("timestamp", "desc")
                .limit(limit)
                .get();
            return snap.docs.map((d) => d.data());
        }
        case "get_upcoming_appointments": {
            const today = new Date().toISOString().slice(0, 10);
            const snap = await db
                .collection("appointments")
                .where("clientId", "==", input.clientId)
                .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
                .where("date", ">=", today)
                .orderBy("date", "asc")
                .limit(5)
                .get();
            return snap.docs.map((d) => d.data());
        }
        case "get_caregiver_info": {
            const snap = await db.collection("caregivers").doc(input.caregiverId).get();
            return (_c = snap.data()) !== null && _c !== void 0 ? _c : { error: "Caregiver not found" };
        }
        case "get_caregiver_reviews": {
            const limit = (_d = input.limit) !== null && _d !== void 0 ? _d : 5;
            const snap = await db
                .collection("reviews")
                .where("caregiverId", "==", input.caregiverId)
                .orderBy("createdAt", "desc")
                .limit(limit)
                .get();
            return snap.docs.map((d) => d.data());
        }
        case "get_health_signals": {
            (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_health_signals").catch(() => { });
            const snap = await db
                .collection("health_signals")
                .where("seniorId", "==", input.seniorId)
                .where("detectedAt", ">=", thirtyDaysAgo)
                .orderBy("detectedAt", "desc")
                .limit(20)
                .get();
            return snap.docs.map((d) => d.data());
        }
        case "get_billing_summary": {
            const [subSnap, invoiceSnap] = await Promise.all([
                db.collection("subscriptions").doc(input.userId).get(),
                db.collection("invoices")
                    .where("userId", "==", input.userId)
                    .orderBy("createdAt", "desc")
                    .limit(3)
                    .get(),
            ]);
            return {
                subscription: (_e = subSnap.data()) !== null && _e !== void 0 ? _e : null,
                recentInvoices: invoiceSnap.docs.map((d) => d.data()),
            };
        }
        case "find_replacement_caregivers": {
            const sessionSnap = await db.collection("agent_sessions").doc(input.phone).get();
            const session = (_f = sessionSnap.data()) !== null && _f !== void 0 ? _f : {};
            const clientSnap = await db.collection("users").doc(input.clientId).get();
            const clientProfile = (_g = clientSnap.data()) !== null && _g !== void 0 ? _g : {};
            await (0, matchingAgent_1.runMatchingForClient)(input.phone, input.chatId, session, clientProfile);
            return { triggered: true };
        }
        case "request_booking": {
            const ref = await db.collection("booking_tasks").add({
                clientId: input.clientId,
                caregiverId: input.caregiverId,
                dates: input.dates,
                startTime: input.startTime,
                endTime: input.endTime,
                status: "pending",
                source: "qa_agent",
                createdAt: nowIso,
            });
            (0, auditLog_1.logBookingCreated)(input.clientId, input.caregiverId, input.dates).catch(() => { });
            return { taskId: ref.id };
        }
        case "update_preferences": {
            const { userId } = input, patch = __rest(input, ["userId"]);
            await db.collection("user_preferences").doc(userId).set(patch, { merge: true });
            return { updated: true };
        }
        case "log_health_flag": {
            (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:log_health_flag").catch(() => { });
            await db.collection("health_signals").add({
                seniorId: input.seniorId,
                signalType: input.signalType,
                description: input.description,
                severity: "flag",
                source: "family_report",
                detectedAt: nowIso,
            });
            return { logged: true };
        }
        case "read_memory_file": {
            (0, auditLog_1.logHealthDataAccessed)(input.userId, input.userId, "mcp:read_memory_file").catch(() => { });
            const content = await (0, memoryFiles_1.readMemoryFile)(input.userId, input.file);
            return { content: content || "" };
        }
        case "update_memory_file": {
            const existing = await (0, memoryFiles_1.readMemoryFile)(input.userId, input.file);
            const updated = existing
                ? `${existing.trimEnd()}\n\n${input.content}`
                : input.content;
            await (0, memoryFiles_1.writeMemoryFile)(input.userId, input.file, updated);
            return { updated: true };
        }
        default:
            return { error: `Unknown tool: ${name}` };
    }
}
//# sourceMappingURL=server.js.map