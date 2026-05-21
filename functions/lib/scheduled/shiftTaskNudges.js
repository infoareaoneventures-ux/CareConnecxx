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
exports.sendShiftTaskNudges = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Parses "8:00 AM", "2:30 PM", or "14:30" → minutes since midnight. Returns null if unparseable.
function parseTimeToMinutes(timeStr) {
    const trimmed = (timeStr !== null && timeStr !== void 0 ? timeStr : "").trim();
    const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        let h = parseInt(ampm[1], 10);
        const m = parseInt(ampm[2], 10);
        const period = ampm[3].toUpperCase();
        if (period === "AM") {
            if (h === 12)
                h = 0;
        }
        else {
            if (h !== 12)
                h += 12;
        }
        return h * 60 + m;
    }
    const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) {
        const h = parseInt(h24[1], 10);
        const m = parseInt(h24[2], 10);
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59)
            return h * 60 + m;
    }
    return null;
}
function isTaskUpcoming(taskMinutes, nowMinutes, windowEnd) {
    if (windowEnd <= 1439) {
        return taskMinutes >= nowMinutes && taskMinutes <= windowEnd;
    }
    // Window wraps past midnight
    return taskMinutes >= nowMinutes || taskMinutes <= (windowEnd - 1440);
}
async function loadCarePlan(seniorId, clientId) {
    var _a, _b, _c, _d, _e, _f;
    const empty = { dailyRoutine: [], medications: [] };
    // 1. Canonical path: senior_profiles/{seniorId}/care_plans/default
    if (seniorId) {
        const snap = await db.collection("senior_profiles").doc(seniorId)
            .collection("care_plans").doc("default").get();
        if (snap.exists) {
            const d = snap.data();
            return {
                dailyRoutine: ((_a = d.dailyRoutine) !== null && _a !== void 0 ? _a : []),
                medications: ((_b = d.medications) !== null && _b !== void 0 ? _b : []),
            };
        }
    }
    // 2. Legacy 1:1 model: senior_profiles/{clientId}/care_plans/default
    if (clientId && clientId !== seniorId) {
        const snap = await db.collection("senior_profiles").doc(clientId)
            .collection("care_plans").doc("default").get();
        if (snap.exists) {
            const d = snap.data();
            return {
                dailyRoutine: ((_c = d.dailyRoutine) !== null && _c !== void 0 ? _c : []),
                medications: ((_d = d.medications) !== null && _d !== void 0 ? _d : []),
            };
        }
    }
    // 3. Flat legacy collection (same as morningBriefing.ts)
    if (clientId) {
        const snap = await db.collection("care_plans").doc(clientId).get();
        if (snap.exists) {
            const d = snap.data();
            return {
                dailyRoutine: ((_e = d.dailyRoutine) !== null && _e !== void 0 ? _e : []),
                medications: ((_f = d.medications) !== null && _f !== void 0 ? _f : []),
            };
        }
    }
    return empty;
}
async function getCompletedTaskIds(appointmentId) {
    var _a;
    const snap = await db.collection("appointment_care_plans")
        .where("appointmentId", "==", appointmentId)
        .limit(1)
        .get();
    if (snap.empty)
        return new Set();
    return new Set(((_a = snap.docs[0].data().tasksCompleted) !== null && _a !== void 0 ? _a : []));
}
exports.sendShiftTaskNudges = functions.pubsub
    .schedule("*/15 * * * *")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const windowEnd = nowMinutes + 30;
    const snap = await db.collection("appointments")
        .where("status", "==", "in-progress")
        .get();
    // completedAt is set by handleDone — filter in-memory since Firestore can't query for absent fields
    const activeAppts = snap.docs.filter(doc => !doc.data().completedAt);
    for (const apptDoc of activeAppts) {
        const appt = apptDoc.data();
        const apptId = apptDoc.id;
        try {
            const caregiverId = appt.caregiverId;
            if (!caregiverId)
                continue;
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgPhone = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
            if (!cgPhone)
                continue;
            // Skip if caregiver session has a blocking state flag active
            const sessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
            if (sessionSnap.exists) {
                const s = sessionSnap.data();
                if (s.awaitingCareNotes || s.awaitingLateMinutes || s.awaitingIssueDescription)
                    continue;
            }
            const clientId = ((_b = appt.clientId) !== null && _b !== void 0 ? _b : "");
            const seniorId = ((_c = appt.seniorId) !== null && _c !== void 0 ? _c : clientId);
            const { dailyRoutine, medications } = await loadCarePlan(seniorId, clientId);
            if (dailyRoutine.length === 0)
                continue;
            const nudgedTaskIds = new Set(((_d = appt.nudgedTaskIds) !== null && _d !== void 0 ? _d : []));
            const completedBySms = new Set(((_e = appt.completedTaskIds) !== null && _e !== void 0 ? _e : []));
            const completedByApp = await getCompletedTaskIds(apptId);
            for (const task of dailyRoutine) {
                if (!task.id || !task.time)
                    continue;
                if (nudgedTaskIds.has(task.id))
                    continue; // already nudged
                if (completedBySms.has(task.id))
                    continue; // confirmed done via SMS
                if (completedByApp.has(task.id))
                    continue; // checked off in the app
                const taskMinutes = parseTimeToMinutes(task.time);
                if (taskMinutes === null)
                    continue;
                if (!isTaskUpcoming(taskMinutes, nowMinutes, windowEnd))
                    continue;
                // Build nudge message — use Claude for a warm, natural reminder
                const isMed = task.category === "medication";
                const matched = isMed
                    ? medications.find(m => task.description.toLowerCase().includes(m.name.toLowerCase()))
                    : null;
                const medDetail = matched ? ` ${matched.name} ${matched.dosage}` : "";
                const cgFirstName = ((_g = (_f = cgSnap.data()) === null || _f === void 0 ? void 0 : _f.name) !== null && _g !== void 0 ? _g : "").split(" ")[0] || "there";
                const seniorNameForNudge = ((_j = (_h = appt.clientName) !== null && _h !== void 0 ? _h : appt.seniorName) !== null && _j !== void 0 ? _j : "your client");
                const content = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: isMed
                        ? `Write a friendly medication reminder to ${cgFirstName}. ` +
                            `It's almost time for ${seniorNameForNudge}'s ${task.description} at ${task.time}.` +
                            `${medDetail ? " Medication: " + medDetail + "." : ""} ` +
                            `Ask them to let you know once it's been given. Keep it warm and brief.`
                        : `Write a friendly care task reminder to ${cgFirstName}. ` +
                            `It's almost time for ${seniorNameForNudge}'s ${task.description} at ${task.time}. ` +
                            `Ask them to let you know when it's done. Keep it short and encouraging.`,
                    fallback: isMed
                        ? `Hey ${cgFirstName}, almost time for ${seniorNameForNudge}'s ${task.description} at ${task.time}.${medDetail ? " (" + medDetail + ")" : ""} Let me know when it's done!`
                        : `Hey ${cgFirstName}, heads up — ${seniorNameForNudge}'s ${task.description} is coming up at ${task.time}. Give me a shout when it's done!`,
                });
                await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                    content,
                    urgency: "standard",
                    sourceAgent: "shift_task_nudge",
                    canDrop: true,
                });
                // Mark as nudged immediately (before next iteration in case of crash)
                await apptDoc.ref.update({
                    nudgedTaskIds: admin.firestore.FieldValue.arrayUnion(task.id),
                });
                nudgedTaskIds.add(task.id);
                // Set awaitingTaskAck on the caregiver session so their reply is routed correctly
                if (sessionSnap.exists) {
                    const seniorNameSnap = seniorId
                        ? await db.collection("senior_profiles").doc(seniorId).get().catch(() => null)
                        : null;
                    const seniorName = ((_m = (_l = (_k = seniorNameSnap === null || seniorNameSnap === void 0 ? void 0 : seniorNameSnap.data()) === null || _k === void 0 ? void 0 : _k.name) !== null && _l !== void 0 ? _l : appt.clientName) !== null && _m !== void 0 ? _m : "");
                    await db.collection("agent_sessions").doc(cgPhone).update({
                        awaitingTaskAck: {
                            taskId: task.id,
                            taskDescription: task.description,
                            taskCategory: task.category,
                            appointmentId: apptId,
                            clientId,
                            seniorId,
                            seniorName,
                            nudgedAt: new Date().toISOString(),
                        },
                        stateExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
                    });
                }
                // Only nudge one task per run per caregiver to avoid flooding
                break;
            }
        }
        catch (err) {
            console.error(`[sendShiftTaskNudges] Error for appointment ${apptId}:`, err);
        }
    }
});
//# sourceMappingURL=shiftTaskNudges.js.map