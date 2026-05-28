"use strict";
// Runtime-enforced confirmation gate for irreversible tool calls.
//
// Today Cara is *told* in the system prompt to confirm before
// cancel_appointment, delete_reminder, etc. — but if she forgets or is
// prompt-injected, the action fires immediately. One bad incident in
// eldercare is irrecoverable, so we enforce confirmation in the runtime.
//
// Flow:
//   1. Claude calls a high-risk tool inside the qa loop.
//   2. MCP dispatcher routes through this module instead of executing.
//   3. proposePendingAction() writes a Firestore doc with the tool name,
//      args, and a 15-min TTL, and returns a structured stub for Claude.
//   4. Claude reads the stub, generates a confirmation message to the family.
//   5. Family replies. approvalHandler classifies YES / NO / QUESTION.
//   6. On YES, the MCP gate re-runs the tool with _confirmedActionId set,
//      which bypasses this gate and executes normally.
//   7. On NO, the action is marked rejected.
//   8. On timeout / 15-min expiry, the action is unusable; a subsequent YES
//      from the family won't re-trigger anything.
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
exports.PENDING_ACTION_TTL_MS = void 0;
exports.isHighRisk = isHighRisk;
exports.buildActionPreview = buildActionPreview;
exports.proposePendingAction = proposePendingAction;
exports.getLatestPending = getLatestPending;
exports.getPendingActionById = getPendingActionById;
exports.resolvePendingAction = resolvePendingAction;
exports.buildPendingActionStub = buildPendingActionStub;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
exports.PENDING_ACTION_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Set of tool names that ALWAYS require confirmation regardless of args.
// Mirrors the qaAgent.ts system-prompt list. Adding a tool here is a
// production-safety change; review the prompt's confirmation guidance too.
const ALWAYS_CONFIRM = new Set([
    "cancel_appointment",
    "delete_reminder",
    "remove_family_member",
    "cancel_subscription",
    "restore_care_plan_version",
    "block_user",
    "report_user",
    "cancel_job_post",
]);
// Tools whose risk depends on an argument value. The predicate inspects the
// input and returns true when this specific call is irreversible.
const CONDITIONAL_CONFIRM = {
    // Only cancel — pause and resume are reversible.
    manage_recurring_schedule: (input) => input.action === "cancel",
    // Rejecting an applicant is irreversible (caregiver sees the decline).
    // Accept is also high-stakes but happens via a separate hire flow.
    respond_to_job_application: (input) => input.decision === "reject",
};
function isHighRisk(toolName, toolInput) {
    if (ALWAYS_CONFIRM.has(toolName))
        return true;
    const pred = CONDITIONAL_CONFIRM[toolName];
    return pred ? pred(toolInput) : false;
}
// Build a short human-readable preview of the action so support / debugging
// can see what was proposed without parsing the raw input JSON. Falls back
// to a generic summary when no special-cased shape applies.
function buildActionPreview(toolName, toolInput) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    switch (toolName) {
        case "cancel_appointment":
            return `Cancel appointment ${String((_a = toolInput.appointmentId) !== null && _a !== void 0 ? _a : "?")}`;
        case "delete_reminder":
            return `Delete reminder ${String((_b = toolInput.reminderId) !== null && _b !== void 0 ? _b : "?")}`;
        case "remove_family_member":
            return `Remove family member ${String((_d = (_c = toolInput.memberPhone) !== null && _c !== void 0 ? _c : toolInput.memberId) !== null && _d !== void 0 ? _d : "?")}`;
        case "cancel_subscription":
            return `Cancel CareConnex subscription`;
        case "restore_care_plan_version":
            return `Restore care plan to version ${String((_e = toolInput.versionId) !== null && _e !== void 0 ? _e : "?")}`;
        case "block_user":
            return `Block user ${String((_g = (_f = toolInput.targetUserId) !== null && _f !== void 0 ? _f : toolInput.targetPhone) !== null && _g !== void 0 ? _g : "?")}`;
        case "report_user":
            return `Report user ${String((_j = (_h = toolInput.targetUserId) !== null && _h !== void 0 ? _h : toolInput.targetPhone) !== null && _j !== void 0 ? _j : "?")}`;
        case "cancel_job_post":
            return `Cancel job post ${String((_k = toolInput.jobId) !== null && _k !== void 0 ? _k : "?")}`;
        case "manage_recurring_schedule":
            return `${String((_l = toolInput.action) !== null && _l !== void 0 ? _l : "modify")} recurring schedule ${String((_m = toolInput.scheduleId) !== null && _m !== void 0 ? _m : "")}`.trim();
        case "respond_to_job_application":
            return `${String((_o = toolInput.decision) !== null && _o !== void 0 ? _o : "respond to")} application ${String((_p = toolInput.applicationId) !== null && _p !== void 0 ? _p : "")}`.trim();
        default:
            return `${toolName} (irreversible)`;
    }
}
// Write a new pending action and return the doc. The id is generated by
// Firestore; callers use it to bypass the gate on the approval re-run.
async function proposePendingAction(params) {
    const now = Date.now();
    const action = {
        phone: params.phone,
        userId: params.userId,
        toolName: params.toolName,
        toolInput: params.toolInput,
        preview: buildActionPreview(params.toolName, params.toolInput),
        proposedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + exports.PENDING_ACTION_TTL_MS).toISOString(),
        status: "awaiting",
    };
    const ref = await db.collection("pending_actions").add(action);
    return Object.assign({ id: ref.id }, action);
}
// Look up the most recent unresolved pending action for a phone, or null.
// "Unresolved" = status === "awaiting" AND expiresAt > now.
// Auto-expires stale awaiting docs so they don't accumulate.
async function getLatestPending(phone) {
    const snap = await db.collection("pending_actions")
        .where("phone", "==", phone)
        .where("status", "==", "awaiting")
        .orderBy("proposedAt", "desc")
        .limit(1)
        .get();
    if (snap.empty)
        return null;
    const doc = snap.docs[0];
    const data = doc.data();
    if (new Date(data.expiresAt).getTime() < Date.now()) {
        // Lazily expire — keeps the read fast at the cost of one write per stale doc.
        await doc.ref.update({
            status: "expired",
            resolvedAt: new Date().toISOString(),
        }).catch(() => { });
        return null;
    }
    return Object.assign({ id: doc.id }, data);
}
async function getPendingActionById(id) {
    const snap = await db.collection("pending_actions").doc(id).get();
    if (!snap.exists)
        return null;
    return Object.assign({ id: snap.id }, snap.data());
}
// Mark resolved with the given status. Idempotent — calling twice with the
// same status is a no-op; calling with a different status logs a warning so
// downstream race conditions surface.
async function resolvePendingAction(id, status, opts = {}) {
    const ref = db.collection("pending_actions").doc(id);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists)
            return;
        const current = snap.data();
        if (current.status !== "awaiting" && current.status !== status) {
            console.warn("pendingActions.resolve: status conflict", {
                id,
                currentStatus: current.status,
                requestedStatus: status,
            });
            return;
        }
        tx.update(ref, Object.assign({ status, resolvedAt: new Date().toISOString() }, (opts.executionPreview ? { executionPreview: opts.executionPreview.slice(0, 500) } : {})));
    });
}
// Stub returned to Claude in place of the real tool result. Claude reads
// this and generates a confirmation prompt for the family.
function buildPendingActionStub(action) {
    const minutes = Math.max(1, Math.ceil((new Date(action.expiresAt).getTime() - Date.now()) / 60000));
    return {
        _pending_action: true,
        actionId: action.id,
        toolName: action.toolName,
        preview: action.preview,
        expires_in_minutes: minutes,
        guidance: "This action is irreversible. Tell the family in plain English exactly what you are about to do, " +
            "then ask for an explicit YES before proceeding. Do NOT call this tool again until they confirm. " +
            "If they decline, acknowledge and stop. If they ask a question instead, answer it and re-ask for confirmation.",
    };
}
//# sourceMappingURL=pendingActions.js.map