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
exports.handleTimesheetApproval = handleTimesheetApproval;
const admin = __importStar(require("firebase-admin"));
const parseWithClaude_1 = require("../utils/parseWithClaude");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
async function isQuestionOrOther(text) {
    const result = await (0, parseWithClaude_1.parseWithClaude)("Reply YES if this is a general question or off-topic comment unrelated to approving or disputing timesheet hours. Reply NO if it is a direct answer. Only reply YES or NO.", text, 5);
    return result.toUpperCase().startsWith("Y");
}
// State flow: start → confirm_one → [done]
async function handleTimesheetApproval(clientId, phone, text, session, sendMessage) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    const step = (_a = session.timesheetStep) !== null && _a !== void 0 ? _a : "start";
    // ── start — load pending timesheets and ask for approval ─────────────────
    if (step === "start") {
        const snap = await db.collection("shiftHours")
            .where("clientId", "==", clientId)
            .where("status", "==", "pending_client_review")
            .orderBy("submittedAt", "desc")
            .limit(5)
            .get();
        if (snap.empty) {
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: "A family member asked about pending timesheets but there are none waiting for review. Let them know briefly and warmly.",
                fallback: "No timesheets are waiting for your review right now.",
                maxTokens: 60,
            });
            await sendMessage(msg);
            await db.collection("agent_sessions").doc(phone).update({
                timesheetStep: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
            return;
        }
        const timesheets = await Promise.all(snap.docs.map(async (d) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const ts = d.data();
            const cgSnap = await db.collection("caregivers").doc(ts.caregiverId).get().catch(() => null);
            const cg = (_a = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) !== null && _a !== void 0 ? _a : {};
            return {
                id: d.id,
                caregiverName: ((_b = cg.name) !== null && _b !== void 0 ? _b : `${(_c = cg.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg.lastName) !== null && _d !== void 0 ? _d : ""}`.trim()) || "Caregiver",
                date: ts.date,
                clockIn: (_e = ts.clockInTime) !== null && _e !== void 0 ? _e : "",
                clockOut: (_f = ts.clockOutTime) !== null && _f !== void 0 ? _f : "",
                hours: Number((_g = ts.durationHours) !== null && _g !== void 0 ? _g : 0),
                amountOwed: `$${(((_h = ts.amountCents) !== null && _h !== void 0 ? _h : 0) / 100).toFixed(2)}`,
                amountCents: (_j = ts.amountCents) !== null && _j !== void 0 ? _j : 0,
                caregiverId: ts.caregiverId,
                appointmentId: (_k = ts.appointmentId) !== null && _k !== void 0 ? _k : "",
            };
        }));
        // Store list and present first one
        const first = timesheets[0];
        const restIds = timesheets.slice(1).map(t => t.id);
        await db.collection("agent_sessions").doc(phone).update({
            timesheetStep: "confirm_one",
            pendingTimesheetId: first.id,
            pendingTimesheetDesc: JSON.stringify(first),
            pendingTimesheetQueue: restIds,
            pendingTimesheetSetAt: new Date().toISOString(),
        });
        const opener = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `${first.caregiverName} submitted hours for review for the visit on ${first.date}. Cara is presenting them to the family for approval. Write a brief 1-sentence intro.`,
            fallback: `${first.caregiverName} submitted their hours for ${first.date} — here are the details:`,
            maxTokens: 60,
        });
        const timeRange = first.clockIn && first.clockOut ? ` (${first.clockIn} – ${first.clockOut})` : "";
        await sendMessage(`${opener}\n\n` +
            `Caregiver: ${first.caregiverName}\n` +
            `Date: ${first.date}${timeRange}\n` +
            `Hours worked: ${first.hours}\n` +
            `Amount: ${first.amountOwed}\n\n` +
            `Reply APPROVE to confirm and release payment, or DISPUTE if something looks wrong.`);
        return;
    }
    // ── confirm_one — handle APPROVE / DISPUTE ────────────────────────────────
    if (step === "confirm_one") {
        if (await isQuestionOrOther(text)) {
            const ts = JSON.parse((_b = session.pendingTimesheetDesc) !== null && _b !== void 0 ? _b : "{}");
            await sendMessage(`No problem — here are the hours again:\n\n` +
                `Caregiver: ${ts.caregiverName}  |  Date: ${ts.date}  |  Hours: ${ts.hours}  |  Amount: ${ts.amountOwed}\n\n` +
                `Reply APPROVE to release payment or DISPUTE if something looks off.`);
            return;
        }
        const decision = await (0, parseWithClaude_1.parseWithClaude)('"approve", "yes", "looks good", "go ahead", "ok", "correct", "confirm", "pay them" → APPROVE. ' +
            '"dispute", "no", "wrong", "incorrect", "that\'s off", "disagree", "flag", "reject" → DISPUTE. ' +
            'Reply with exactly APPROVE or DISPUTE.', text, 10);
        const tsId = session.pendingTimesheetId;
        const tsData = JSON.parse((_c = session.pendingTimesheetDesc) !== null && _c !== void 0 ? _c : "{}");
        if (decision === "APPROVE") {
            await db.collection("shiftHours").doc(tsId).update({
                status: "approved",
                approvedAt: new Date().toISOString(),
                approvedBy: clientId,
            });
            // Fire payment processing (fire-and-forget)
            if (tsData.appointmentId && tsData.caregiverId && tsData.amountCents > 0) {
                Promise.resolve().then(() => __importStar(require("../billing/visitBilling"))).then(({ createVisitPayment }) => {
                    createVisitPayment({
                        appointmentId: tsData.appointmentId,
                        clientId,
                        clientPhone: "",
                        caregiverId: tsData.caregiverId,
                        caregiverName: tsData.caregiverName,
                        caregiverPhone: "",
                        durationHours: tsData.hours,
                        hourlyRate: tsData.amountCents / 100 / Math.max(tsData.hours, 1),
                        date: tsData.date,
                    });
                }).catch(() => { });
            }
            const approveMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Family just approved ${tsData.caregiverName}'s timesheet for ${tsData.date} (${tsData.hours} hrs, ${tsData.amountOwed}). Write a brief warm confirmation and let them know payment will process tonight.`,
                fallback: `Approved! ${tsData.caregiverName}'s payment of ${tsData.amountOwed} will process tonight.`,
                maxTokens: 80,
            });
            await sendMessage(approveMsg);
        }
        else {
            await db.collection("shiftHours").doc(tsId).update({
                status: "disputed",
                disputedAt: new Date().toISOString(),
                disputedBy: clientId,
            });
            await db.collection("dispute_flags").add({
                type: "timesheet_dispute",
                clientId,
                timesheetId: tsId,
                caregiverId: tsData.caregiverId,
                caregiverName: tsData.caregiverName,
                date: tsData.date,
                amountCents: tsData.amountCents,
                flaggedAt: new Date().toISOString(),
                status: "open",
            }).catch(() => { });
            const disputeMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Family flagged a dispute on ${tsData.caregiverName}'s timesheet for ${tsData.date}. Acknowledge the dispute warmly and let them know a coordinator will follow up within 24 hours.`,
                fallback: `Got it — I've flagged ${tsData.caregiverName}'s timesheet for review. A coordinator will follow up within 24 hours.`,
                maxTokens: 80,
            });
            await sendMessage(disputeMsg);
        }
        // Check if there are more timesheets in the queue
        const queue = (_d = session.pendingTimesheetQueue) !== null && _d !== void 0 ? _d : [];
        await db.collection("agent_sessions").doc(phone).update({
            timesheetStep: admin.firestore.FieldValue.delete(),
            pendingTimesheetId: admin.firestore.FieldValue.delete(),
            pendingTimesheetDesc: admin.firestore.FieldValue.delete(),
            pendingTimesheetQueue: admin.firestore.FieldValue.delete(),
        }).catch(() => { });
        if (queue.length > 0) {
            const nextSnap = await db.collection("shiftHours").doc(queue[0]).get().catch(() => null);
            if (nextSnap === null || nextSnap === void 0 ? void 0 : nextSnap.exists) {
                const nextTs = nextSnap.data();
                const cgSnap = await db.collection("caregivers").doc(nextTs.caregiverId).get().catch(() => null);
                const cg = (_e = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) !== null && _e !== void 0 ? _e : {};
                const next = {
                    id: nextSnap.id,
                    caregiverName: ((_f = cg.name) !== null && _f !== void 0 ? _f : `${(_g = cg.firstName) !== null && _g !== void 0 ? _g : ""} ${(_h = cg.lastName) !== null && _h !== void 0 ? _h : ""}`.trim()) || "Caregiver",
                    date: nextTs.date,
                    clockIn: (_j = nextTs.clockInTime) !== null && _j !== void 0 ? _j : "",
                    clockOut: (_k = nextTs.clockOutTime) !== null && _k !== void 0 ? _k : "",
                    hours: Number((_l = nextTs.durationHours) !== null && _l !== void 0 ? _l : 0),
                    amountOwed: `$${(((_m = nextTs.amountCents) !== null && _m !== void 0 ? _m : 0) / 100).toFixed(2)}`,
                    amountCents: (_o = nextTs.amountCents) !== null && _o !== void 0 ? _o : 0,
                    caregiverId: nextTs.caregiverId,
                    appointmentId: (_p = nextTs.appointmentId) !== null && _p !== void 0 ? _p : "",
                };
                await db.collection("agent_sessions").doc(phone).update({
                    timesheetStep: "confirm_one",
                    pendingTimesheetId: next.id,
                    pendingTimesheetDesc: JSON.stringify(next),
                    pendingTimesheetQueue: queue.slice(1),
                    pendingTimesheetSetAt: new Date().toISOString(),
                });
                const timeRange2 = next.clockIn && next.clockOut ? ` (${next.clockIn} – ${next.clockOut})` : "";
                await sendMessage(`You have one more to review:\n\n` +
                    `Caregiver: ${next.caregiverName}\n` +
                    `Date: ${next.date}${timeRange2}\n` +
                    `Hours worked: ${next.hours}\n` +
                    `Amount: ${next.amountOwed}\n\n` +
                    `Reply APPROVE or DISPUTE.`);
            }
        }
        return;
    }
}
//# sourceMappingURL=timesheetHandler.js.map