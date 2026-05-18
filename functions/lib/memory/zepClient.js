"use strict";
/**
 * Cara – Zep Memory Integration
 * Docs: https://help.getzep.com/quick-start-guide
 *
 * Zep userId = phone digits only (e.g. "14155551234").
 * This is stable, requires no Firebase Auth UID, and is consistent from
 * first contact through the entire lifecycle.
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
exports.getZepUserId = getZepUserId;
exports.createCaraContextTemplate = createCaraContextTemplate;
exports.ensureCaraContextTemplate = ensureCaraContextTemplate;
exports.initializeZepOnFirstContact = initializeZepOnFirstContact;
exports.addUserMessageToZep = addUserMessageToZep;
exports.addAssistantMessageToZep = addAssistantMessageToZep;
exports.addBusinessDataToZep = addBusinessDataToZep;
exports.getZepContext = getZepContext;
exports.searchZepMemory = searchZepMemory;
exports.pushOnboardingDataToZep = pushOnboardingDataToZep;
exports.sendCareJournalToZep = sendCareJournalToZep;
const zep_cloud_1 = require("@getzep/zep-cloud");
const admin = __importStar(require("firebase-admin"));
const uuid_1 = require("uuid");
const db = admin.firestore();
// ── Structured Zep failure logging ───────────────────────────────────────────
// Emits a JSON log entry that Cloud Monitoring can use for alerting.
// severity + zep_failure key are stable — set up a log-based metric on these.
function logZepFailure(operation, err, context) {
    var _a, _b, _c;
    const code = (_b = (_a = err === null || err === void 0 ? void 0 : err.status) !== null && _a !== void 0 ? _a : err === null || err === void 0 ? void 0 : err.code) !== null && _b !== void 0 ? _b : "unknown";
    const message = (_c = err === null || err === void 0 ? void 0 : err.message) !== null && _c !== void 0 ? _c : String(err);
    console.error(JSON.stringify(Object.assign(Object.assign({ severity: "ERROR", zep_failure: true, operation, error_code: code, error_message: message }, context), { timestamp: new Date().toISOString() })));
}
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
// ── Retry helper for transient Zep failures ───────────────────────────────────
// Retries on network errors (no status), 429 rate limit, and 5xx server errors.
// 400-level auth/bad-request errors are not retried — they won't self-heal.
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function withZepRetry(fn, opName, context) {
    var _a;
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            const status = (_a = err === null || err === void 0 ? void 0 : err.status) !== null && _a !== void 0 ? _a : err === null || err === void 0 ? void 0 : err.statusCode;
            const isRetryable = !status || // network-level error (no HTTP status)
                status === 429 || // rate limited
                (status >= 500 && status < 600); // server error
            if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
                logZepFailure(opName, err, context);
                throw err;
            }
            // Exponential back-off: 200 ms → 400 ms → 800 ms (+ jitter)
            await sleep(Math.min(200 * Math.pow(2, attempt), 4000) + Math.random() * 100);
        }
    }
    throw lastErr;
}
// ── Stable Zep userId derived from phone ──────────────────────────────────────
// Exported so all callers use the same derivation consistently
function getZepUserId(phone) {
    return phone.replace(/\D/g, "");
}
// ── Context template definition ───────────────────────────────────────────────
const CARA_TEMPLATE_ID = "cara-eldercare";
const CARA_TEMPLATE_BODY = `# CARE CONTEXT

## About This Family
%{user_summary}

## Current Facts (with date ranges)
%{edges limit=15}

## Key People & Relationships
%{entities limit=8}`;
// Called once during deploy/setup — kept for backwards-compat.
async function createCaraContextTemplate() {
    await getZep().context.createContextTemplate({
        templateId: CARA_TEMPLATE_ID,
        template: CARA_TEMPLATE_BODY,
    });
    console.log("Cara context template created in Zep.");
}
// Called automatically on Cloud Function cold-start. Checks whether the template
// exists; creates it if missing. Safe to call repeatedly — idempotent.
let _templateEnsured = false;
async function ensureCaraContextTemplate() {
    var _a, _b, _c, _d;
    if (_templateEnsured)
        return;
    try {
        // Attempt to fetch the template — Zep returns 404 if it doesn't exist.
        await ((_b = (_a = getZep().context).getContextTemplate) === null || _b === void 0 ? void 0 : _b.call(_a, { templateId: CARA_TEMPLATE_ID }));
        _templateEnsured = true;
    }
    catch (err) {
        const status = (_c = err === null || err === void 0 ? void 0 : err.status) !== null && _c !== void 0 ? _c : err === null || err === void 0 ? void 0 : err.statusCode;
        if (status === 404 || ((_d = err === null || err === void 0 ? void 0 : err.message) === null || _d === void 0 ? void 0 : _d.includes("not found"))) {
            // Template missing — create it now.
            try {
                await getZep().context.createContextTemplate({
                    templateId: CARA_TEMPLATE_ID,
                    template: CARA_TEMPLATE_BODY,
                });
                console.log("[zepClient] cara-eldercare context template created.");
                _templateEnsured = true;
            }
            catch (createErr) {
                logZepFailure("ensureCaraContextTemplate.create", createErr);
            }
        }
        else {
            // Non-404 — log but don't crash; getContextTemplate may not exist on all SDK versions
            logZepFailure("ensureCaraContextTemplate.check", err);
        }
    }
}
// ── Initialize Zep on first contact ───────────────────────────────────────────
// Call the moment a new user sends their first text — before we know name/role.
// Uses phone digits as userId so memory starts immediately.
async function initializeZepOnFirstContact(phone) {
    var _a, _b, _c;
    const userId = getZepUserId(phone);
    try {
        await getZep().user.add({
            userId,
            email: `${userId}@cara-internal.local`,
        });
    }
    catch (err) {
        if (!((_a = err === null || err === void 0 ? void 0 : err.message) === null || _a === void 0 ? void 0 : _a.includes("already exists"))) {
            logZepFailure("initializeZepOnFirstContact.user.add", err, { userId });
        }
    }
    // Guard: if a threadId is already stored, don't create a second thread — that
    // would split this user's memory across two Zep threads permanently.
    const existingSession = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    if ((_b = existingSession === null || existingSession === void 0 ? void 0 : existingSession.data()) === null || _b === void 0 ? void 0 : _b.zepThreadId)
        return;
    const threadId = (0, uuid_1.v4)().replace(/-/g, "");
    try {
        await getZep().thread.create({ threadId, userId });
        await db.collection("agent_sessions").doc(phone).set({ zepThreadId: threadId }, { merge: true });
    }
    catch (err) {
        if (!((_c = err === null || err === void 0 ? void 0 : err.message) === null || _c === void 0 ? void 0 : _c.includes("already exists"))) {
            logZepFailure("initializeZepOnFirstContact.thread.create", err, { userId, threadId });
        }
    }
}
// ── Add incoming user message to Zep ──────────────────────────────────────────
// Fire-and-forget before every Claude call AND before handleOnboardingStep
async function addUserMessageToZep(params) {
    var _a;
    const message = {
        createdAt: ((_a = params.sentAt) !== null && _a !== void 0 ? _a : new Date()).toISOString(),
        name: params.userName,
        role: "user",
        content: params.content,
    };
    await withZepRetry(() => getZep().thread.addMessages(params.threadId, { messages: [message] }), "addUserMessageToZep", { threadId: params.threadId }).catch(() => { }); // fire-and-forget: retry exhausted → logged, don't throw
}
// ── Add Cara's reply to Zep ────────────────────────────────────────────────────
// Fire-and-forget after Claude/QA agent sends a reply
async function addAssistantMessageToZep(params) {
    const message = {
        createdAt: new Date().toISOString(),
        name: "Cara",
        role: "assistant",
        content: params.content,
    };
    await withZepRetry(() => getZep().thread.addMessages(params.threadId, { messages: [message] }), "addAssistantMessageToZep", { threadId: params.threadId }).catch(() => { }); // fire-and-forget
}
// ── Add business data to Zep knowledge graph ──────────────────────────────────
// Zep auto-extracts facts, entities, relationships from JSON
async function addBusinessDataToZep(params) {
    await withZepRetry(() => getZep().graph.add({
        userId: params.userId,
        type: "json",
        data: JSON.stringify(params.data),
    }), "addBusinessDataToZep", { userId: params.userId });
    // Callers that want fire-and-forget must wrap with .catch() themselves
}
// ── Get assembled context for Claude ──────────────────────────────────────────
// Returns: user summary + relevant facts with valid_from/valid_to dates.
// Self-heals missing template on first call per cold-start.
async function getZepContext(threadId) {
    var _a, _b;
    // Ensure template exists — no-op after first successful check per instance.
    await ensureCaraContextTemplate().catch(() => { });
    try {
        const userContext = await getZep().thread.getUserContext(threadId, {
            templateId: CARA_TEMPLATE_ID,
        });
        return (_a = userContext.context) !== null && _a !== void 0 ? _a : "";
    }
    catch (_c) {
        try {
            const userContext = await getZep().thread.getUserContext(threadId);
            return (_b = userContext.context) !== null && _b !== void 0 ? _b : "";
        }
        catch (err) {
            logZepFailure("getZepContext", err, { threadId });
            return "";
        }
    }
}
// ── Search memory ──────────────────────────────────────────────────────────────
// Used when family texts "what do you know about mom?"
async function searchZepMemory(userId, query) {
    var _a;
    try {
        const results = await getZep().graph.search({ userId, query, limit: 5 });
        if (!((_a = results === null || results === void 0 ? void 0 : results.edges) === null || _a === void 0 ? void 0 : _a.length))
            return "";
        return results.edges
            .map((e) => { var _a; return `- ${(_a = e.fact) !== null && _a !== void 0 ? _a : e.name}`; })
            .filter(Boolean)
            .join("\n");
    }
    catch (err) {
        logZepFailure("searchZepMemory", err, { userId, query: query.slice(0, 50) });
        return "";
    }
}
// ── Push structured onboarding data to Zep graph ──────────────────────────────
// Call at payment completion — thread already exists from first contact.
// Zep uses this to build richer knowledge: senior name, conditions, care needs.
async function pushOnboardingDataToZep(params) {
    var _a, _b, _c;
    const userId = getZepUserId(params.phone);
    // Update Zep user record with name now that we know it
    try {
        await getZep().user.update(userId, { firstName: params.firstName });
    }
    catch (err) {
        logZepFailure("pushOnboardingDataToZep.user.update", err, { userId });
    }
    await addBusinessDataToZep({
        userId,
        data: {
            user_name: params.firstName,
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
}
// ── Send care journal to Zep after each visit ──────────────────────────────────
// Zep extracts health facts and bi-temporally dates them
async function sendCareJournalToZep(params) {
    var _a;
    await addBusinessDataToZep({
        userId: getZepUserId(params.phone),
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