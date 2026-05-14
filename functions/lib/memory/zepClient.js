"use strict";
/**
 * Cara – Zep Memory Integration
 * Docs: https://help.getzep.com/quick-start-guide
 */
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
exports.createCaraContextTemplate = createCaraContextTemplate;
exports.createZepUser = createZepUser;
exports.createZepThread = createZepThread;
exports.addUserMessageToZep = addUserMessageToZep;
exports.addAssistantMessageToZep = addAssistantMessageToZep;
exports.addBusinessDataToZep = addBusinessDataToZep;
exports.getZepContext = getZepContext;
exports.searchZepMemory = searchZepMemory;
exports.initializeZepForClient = initializeZepForClient;
exports.sendCareJournalToZep = sendCareJournalToZep;
const zep_cloud_1 = require("@getzep/zep-cloud");
const admin = __importStar(require("firebase-admin"));
const uuid_1 = require("uuid");
const db = admin.firestore();
// ── Singleton client ───────────────────────────────────────────────────────────
let _zep = null;
function getZep() {
    if (!_zep) {
        const apiKey = process.env.ZEP_API_KEY;
        if (!apiKey)
            throw new Error("ZEP_API_KEY not set");
        _zep = new zep_cloud_1.ZepClient({ apiKey });
    }
    return _zep;
}
// ── Create context template (run ONCE during setup) ────────────────────────────
async function createCaraContextTemplate() {
    await getZep().context.createContextTemplate({
        templateId: "cara-eldercare",
        template: `# CARE CONTEXT

## About This Family
%{user_summary}

## Current Facts (with date ranges)
%{edges limit=15}

## Key People & Relationships
%{entities limit=8}`,
    });
    console.log("Cara context template created in Zep.");
}
// ── Create Zep user (once per family, at onboarding completion) ────────────────
async function createZepUser(params) {
    var _a, _b;
    try {
        await getZep().user.add({
            userId: params.userId,
            firstName: params.firstName,
            lastName: (_a = params.lastName) !== null && _a !== void 0 ? _a : "",
            email: `${params.phone.replace(/\D/g, "")}@cara-internal.local`,
        });
    }
    catch (err) {
        if (!((_b = err === null || err === void 0 ? void 0 : err.message) === null || _b === void 0 ? void 0 : _b.includes("already exists"))) {
            console.error("createZepUser error:", err);
        }
    }
}
// ── Create Zep thread (once per family, stored in agent_sessions) ──────────────
// thread_id must be a UUID – stored in agent_sessions.zepThreadId
async function createZepThread(params) {
    var _a;
    const threadId = (0, uuid_1.v4)().replace(/-/g, "");
    try {
        await getZep().thread.create({
            threadId,
            userId: params.userId,
        });
        await db.collection("agent_sessions").doc(params.phone).update({
            zepThreadId: threadId,
        });
    }
    catch (err) {
        if (!((_a = err === null || err === void 0 ? void 0 : err.message) === null || _a === void 0 ? void 0 : _a.includes("already exists"))) {
            console.error("createZepThread error:", err);
        }
    }
    return threadId;
}
// ── Add incoming user message to Zep ──────────────────────────────────────────
// Call BEFORE calling Claude – when inbound message arrives in webhooks.ts
async function addUserMessageToZep(params) {
    var _a;
    try {
        const message = {
            createdAt: ((_a = params.sentAt) !== null && _a !== void 0 ? _a : new Date()).toISOString(),
            name: params.userName,
            role: "user",
            content: params.content,
        };
        await getZep().thread.addMessages(params.threadId, {
            messages: [message],
        });
    }
    catch (err) {
        console.error("addUserMessageToZep error:", err);
    }
}
// ── Add Cara's reply to Zep ────────────────────────────────────────────────────
// Call AFTER Claude generates a reply – in webhooks.ts after sendMessage()
async function addAssistantMessageToZep(params) {
    try {
        const message = {
            createdAt: new Date().toISOString(),
            name: "Cara",
            role: "assistant",
            content: params.content,
        };
        await getZep().thread.addMessages(params.threadId, {
            messages: [message],
        });
    }
    catch (err) {
        console.error("addAssistantMessageToZep error:", err);
    }
}
// ── Add business data (care events, onboarding data) to Zep graph ─────────────
// Zep auto-extracts facts, entities, relationships from any JSON
// Include user name so Zep associates data with the right person
async function addBusinessDataToZep(params) {
    try {
        await getZep().graph.add({
            userId: params.userId,
            type: "json",
            data: JSON.stringify(params.data),
        });
    }
    catch (err) {
        console.error("addBusinessDataToZep error:", err);
    }
}
// ── Get assembled context for Claude ──────────────────────────────────────────
// Call AFTER adding user message to Zep, BEFORE calling Claude
// Returns: user summary + relevant facts with valid_from/valid_to dates
// P95 latency < 200ms
async function getZepContext(threadId) {
    var _a, _b;
    try {
        // Try custom eldercare template first
        const userContext = await getZep().thread.getUserContext(threadId, {
            templateId: "cara-eldercare",
        });
        return (_a = userContext.context) !== null && _a !== void 0 ? _a : "";
    }
    catch (_c) {
        // Fall back to default if template not created yet
        try {
            const userContext = await getZep().thread.getUserContext(threadId);
            return (_b = userContext.context) !== null && _b !== void 0 ? _b : "";
        }
        catch (err) {
            console.error("getZepContext error:", err);
            return "";
        }
    }
}
// ── Search memory ──────────────────────────────────────────────────────────────
// Used when family texts "what do you know about mom?"
async function searchZepMemory(userId, query) {
    var _a;
    try {
        const results = await getZep().graph.search({
            userId,
            query,
            limit: 5,
        });
        if (!((_a = results === null || results === void 0 ? void 0 : results.edges) === null || _a === void 0 ? void 0 : _a.length))
            return "";
        return results.edges
            .map((e) => { var _a; return `- ${(_a = e.fact) !== null && _a !== void 0 ? _a : e.name}`; })
            .filter(Boolean)
            .join("\n");
    }
    catch (err) {
        console.error("searchZepMemory error:", err);
        return "";
    }
}
// ── Full onboarding initialization ────────────────────────────────────────────
// Call when client onboarding completes – creates user, thread, sends all data
async function initializeZepForClient(params) {
    var _a, _b, _c;
    await createZepUser({
        userId: params.userId,
        firstName: params.firstName,
        lastName: params.lastName,
        phone: params.phone,
    });
    const threadId = await createZepThread({
        userId: params.userId,
        phone: params.phone,
    });
    await addBusinessDataToZep({
        userId: params.userId,
        data: {
            user_name: params.firstName,
            user_id: params.userId,
            relationship_to_senior: (_a = params.relationship) !== null && _a !== void 0 ? _a : "family member",
            senior_name: params.seniorName,
            senior_age: params.seniorAge,
            senior_conditions: (_b = params.conditions) !== null && _b !== void 0 ? _b : [],
            senior_care_needs: (_c = params.careNeeds) !== null && _c !== void 0 ? _c : [],
            senior_location_city: params.city,
            care_schedule_days_per_week: params.daysPerWeek,
            care_schedule_time_of_day: params.timeOfDay,
            data_source: "cara_onboarding",
            timestamp: new Date().toISOString(),
        },
    });
    return threadId;
}
// ── Send care journal to Zep after each visit ──────────────────────────────────
// Call from journalCreated.ts – Zep extracts health facts and
// invalidates old facts automatically when conditions change
async function sendCareJournalToZep(params) {
    var _a;
    await addBusinessDataToZep({
        userId: params.userId,
        data: {
            event_type: "care_visit_completed",
            user_name: params.seniorName,
            caregiver_name: params.caregiverName,
            visit_date: params.date,
            mood: params.mood,
            ate_well: params.ateWell,
            medications_taken: params.medicationsTaken,
            health_observations: (_a = params.healthObservations) !== null && _a !== void 0 ? _a : [],
            care_notes: params.notes,
        },
    });
}
//# sourceMappingURL=zepClient.js.map