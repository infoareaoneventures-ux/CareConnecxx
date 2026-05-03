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
exports.onJobApplicationWrite = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
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
//# sourceMappingURL=jobApplicationTriggers.js.map