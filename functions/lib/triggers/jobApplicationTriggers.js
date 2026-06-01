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
exports.onJobApplicationCreated = exports.onJobApplicationWrite = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
// Applications in these statuses count toward the job's applicantCount.
// "withdrawn" applications do NOT count.
const COUNTED_STATUSES = new Set(["pending", "accepted", "rejected"]);
function counts(status) {
    return !!status && COUNTED_STATUSES.has(status);
}
/**
 * Maintains job_posts/{jobId}.applicantCount in response to writes on
 * job_applications/{appId}. Used by the Job Board "Less than 10 applicants"
 * badge.
 *
 * Create   → +1 (if status counts)
 * Delete   → -1 (if prior status counted)
 * Status change:
 *   counted → not-counted (e.g. withdrawn): -1
 *   not-counted → counted (re-applied): +1
 *   same bucket: no-op
 * jobId change: decrement old, increment new (rare/defensive)
 */
exports.onJobApplicationWrite = functions.firestore
    .document("job_applications/{appId}")
    .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    const beforeJobId = before === null || before === void 0 ? void 0 : before.jobId;
    const afterJobId = after === null || after === void 0 ? void 0 : after.jobId;
    const beforeStatus = before === null || before === void 0 ? void 0 : before.status;
    const afterStatus = after === null || after === void 0 ? void 0 : after.status;
    const beforeCounts = before ? counts(beforeStatus) : false;
    const afterCounts = after ? counts(afterStatus) : false;
    const deltas = new Map();
    const bump = (jobId, delta) => {
        var _a;
        if (!jobId || delta === 0)
            return;
        deltas.set(jobId, ((_a = deltas.get(jobId)) !== null && _a !== void 0 ? _a : 0) + delta);
    };
    if (beforeJobId && afterJobId && beforeJobId !== afterJobId) {
        // jobId changed — settle both sides
        if (beforeCounts)
            bump(beforeJobId, -1);
        if (afterCounts)
            bump(afterJobId, +1);
    }
    else {
        const jobId = afterJobId !== null && afterJobId !== void 0 ? afterJobId : beforeJobId;
        if (!beforeCounts && afterCounts)
            bump(jobId, +1);
        else if (beforeCounts && !afterCounts)
            bump(jobId, -1);
    }
    if (deltas.size === 0)
        return null;
    const db = admin.firestore();
    const ops = [];
    for (const [jobId, delta] of deltas) {
        const ref = db.collection("job_posts").doc(jobId);
        ops.push(db.runTransaction(async (tx) => {
            var _a, _b;
            const snap = await tx.get(ref);
            if (!snap.exists)
                return;
            const current = (_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.applicantCount) !== null && _b !== void 0 ? _b : 0;
            const next = Math.max(0, current + delta);
            tx.update(ref, { applicantCount: next });
        }));
    }
    try {
        await Promise.all(ops);
    }
    catch (err) {
        console.error("[onJobApplicationWrite] counter update failed", {
            appId: context.params.appId,
            deltas: Array.from(deltas.entries()),
            err,
        });
    }
    return null;
});
/**
 * Notify the client when a caregiver applies to their job post. Fires once
 * per application (idempotency-guarded via `clientNotifiedAt` on the
 * application doc).
 *
 * Skips if the application was created in a "withdrawn" or "rejected" state
 * (e.g. backfill imports). Skips clients without active sessions or who are
 * opted out. The message is generated by Claude/gpt-4o-mini so it reads
 * naturally — no template-y blast.
 */
exports.onJobApplicationCreated = functions.firestore
    .document("job_applications/{appId}")
    .onCreate(async (snap, context) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    try {
        const app = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
        const status = app.status;
        if (status === "withdrawn" || status === "rejected")
            return;
        const jobId = app.jobId;
        if (!jobId)
            return;
        const db = admin.firestore();
        const jobSnap = await db.collection("job_posts").doc(jobId).get();
        if (!jobSnap.exists)
            return;
        const job = (_b = jobSnap.data()) !== null && _b !== void 0 ? _b : {};
        const clientId = ((_d = (_c = job.clientId) !== null && _c !== void 0 ? _c : job.userId) !== null && _d !== void 0 ? _d : "");
        if (!clientId)
            return;
        // Resolve client phone — agent_sessions is keyed by phone, indexed on userId
        const sessionQ = await db.collection("agent_sessions")
            .where("userId", "==", clientId)
            .limit(1)
            .get();
        if (sessionQ.empty)
            return;
        const sessionDoc = sessionQ.docs[0];
        const sessionData = sessionDoc.data();
        if (sessionData.optedOut)
            return;
        if (sessionData.onboardingStep !== "complete")
            return; // don't interrupt onboarding
        const phone = ((_e = sessionData.phone) !== null && _e !== void 0 ? _e : sessionDoc.id);
        // Resolve caregiver display name (best effort)
        const cgId = ((_f = app.caregiverId) !== null && _f !== void 0 ? _f : "");
        let cgFirstName = "A caregiver";
        if (cgId) {
            const cgSnap = await db.collection("caregivers").doc(cgId).get();
            cgFirstName = ((_h = (_g = cgSnap.data()) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : "Caregiver").split(" ")[0] || "Caregiver";
        }
        const seniorName = ((_l = (_j = job.seniorName) !== null && _j !== void 0 ? _j : (_k = sessionData.onboardingData) === null || _k === void 0 ? void 0 : _k.seniorName) !== null && _l !== void 0 ? _l : "");
        const jobTitle = ((_m = job.title) !== null && _m !== void 0 ? _m : "your care job");
        const rate = app.proposedRate;
        const rateLine = typeof rate === "number" ? ` at $${rate}/hr` : "";
        const seniorPart = seniorName ? ` for ${seniorName}` : "";
        const message = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `Tell the family that ${cgFirstName} just applied to their job post${seniorPart}${rateLine}. ` +
                `Keep it warm, one-to-two sentences. Offer to pull up the caregiver's profile — don't dump details. ` +
                `End with a soft invitation like "Want me to share their profile?" or "Want to set up an intro call?"`,
            fallback: `${cgFirstName} just applied to ${jobTitle}${rateLine}${seniorPart ? "" : ""}. Want me to pull up their profile?`,
            maxTokens: 100,
        });
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: message,
            urgency: "standard",
            sourceAgent: "job_applicant_alert",
            canDrop: true,
        });
        await snap.ref.update({ clientNotifiedAt: new Date().toISOString() }).catch(() => { });
    }
    catch (err) {
        console.error("[onJobApplicationCreated] notify failed", { appId: context.params.appId, err });
    }
});
//# sourceMappingURL=jobApplicationTriggers.js.map