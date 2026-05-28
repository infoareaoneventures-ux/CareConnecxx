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
exports.createJobPost = createJobPost;
exports.notifyAreaCaregivers = notifyAreaCaregivers;
exports.handleJobResponse = handleJobResponse;
exports.handleAvailabilityConfirmation = handleAvailabilityConfirmation;
exports.closeJobPost = closeJobPost;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const scoring_1 = require("../ai/scoring");
const client_1 = require("../linq/client");
const caraAgent_1 = require("../agents/caraAgent");
const parseWithClaude_1 = require("../utils/parseWithClaude");
const openaiClient_1 = require("../utils/openaiClient");
const MATCH_PUSH_THRESHOLD = 80; // push only when skill overlap is ≥ 80%
function computeSimpleMatchScore(cgSkills, jobCareTypes) {
    if (!jobCareTypes.length)
        return 50;
    const cgNorm = cgSkills.map(s => s.toLowerCase());
    const matches = jobCareTypes.filter(t => cgNorm.some(s => s.includes(t.toLowerCase()) || t.toLowerCase().includes(s)));
    return Math.round((matches.length / jobCareTypes.length) * 100);
}
async function sendJobMatchPush(caregiverId, jobId, jobTitle, city, matchScore) {
    var _a, _b;
    const userSnap = await admin.firestore().collection("caregivers").doc(caregiverId).get();
    const fcmTokens = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.fcmTokens) !== null && _b !== void 0 ? _b : [];
    if (!fcmTokens.length)
        return;
    const sends = fcmTokens.slice(0, 5).map(token => admin.messaging().send({
        token,
        notification: {
            title: "New job match for you!",
            body: `${jobTitle} · ${city} — ${matchScore}% match`,
        },
        data: {
            type: "job_match",
            jobId,
            matchScore: String(matchScore),
            deepLink: `/caregiver/jobs/${jobId}`,
        },
        android: { priority: "high" },
    }).catch(() => { }));
    await Promise.all(sends);
}
const db = admin.firestore();
const NOTIFY_RADIUS_MILES = 25;
// ── createJobPost ─────────────────────────────────────────────────────────────
async function createJobPost(intakeId, intakeData, clientId) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    try {
        const lat = (_e = (_c = (_a = intakeData.latitude) !== null && _a !== void 0 ? _a : (_b = intakeData.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = intakeData.location) === null || _d === void 0 ? void 0 : _d.lat) !== null && _e !== void 0 ? _e : null;
        const lng = (_k = (_h = (_f = intakeData.longitude) !== null && _f !== void 0 ? _f : (_g = intakeData.location) === null || _g === void 0 ? void 0 : _g.longitude) !== null && _h !== void 0 ? _h : (_j = intakeData.location) === null || _j === void 0 ? void 0 : _j.lng) !== null && _k !== void 0 ? _k : null;
        const city = (_o = (_l = intakeData.city) !== null && _l !== void 0 ? _l : (_m = intakeData.location) === null || _m === void 0 ? void 0 : _m.city) !== null && _o !== void 0 ? _o : null;
        const careTypes = (_p = intakeData.careTypes) !== null && _p !== void 0 ? _p : [];
        await db.collection("job_posts").doc(intakeId).set({
            intakeId,
            clientId,
            status: "open",
            careTypes,
            schedule: (_q = intakeData.schedule) !== null && _q !== void 0 ? _q : null,
            startDate: (_r = intakeData.startDate) !== null && _r !== void 0 ? _r : null,
            location: { lat, lng, city },
            summary: careTypes.length > 0
                ? `New care job — ${careTypes.join(", ")}`
                : "New care job",
            applicantCount: 0,
            notifiedCount: 0,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        if (!lat || !lng) {
            console.warn(`[createJobPost] Intake ${intakeId} has no coordinates — caregivers will not be notified`);
        }
    }
    catch (err) {
        console.error("[createJobPost] failed:", err);
    }
}
// ── notifyAreaCaregivers ──────────────────────────────────────────────────────
async function notifyAreaCaregivers(jobId, intakeData, clientId) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
    const clientLat = (_c = (_a = intakeData.latitude) !== null && _a !== void 0 ? _a : (_b = intakeData.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = intakeData.location) === null || _d === void 0 ? void 0 : _d.lat;
    const clientLng = (_g = (_e = intakeData.longitude) !== null && _e !== void 0 ? _e : (_f = intakeData.location) === null || _f === void 0 ? void 0 : _f.longitude) !== null && _g !== void 0 ? _g : (_h = intakeData.location) === null || _h === void 0 ? void 0 : _h.lng;
    const city = (_l = (_j = intakeData.city) !== null && _j !== void 0 ? _j : (_k = intakeData.location) === null || _k === void 0 ? void 0 : _k.city) !== null && _l !== void 0 ? _l : "";
    const careTypes = (_m = intakeData.careTypes) !== null && _m !== void 0 ? _m : [];
    if (!clientLat || !clientLng) {
        console.warn(`[notifyAreaCaregivers] No coordinates for job ${jobId} — skipping notifications`);
        return;
    }
    const snap = await db.collection("caregivers").where("status", "==", "active").get();
    if (snap.empty) {
        console.log("[notifyAreaCaregivers] No active caregivers found");
        return;
    }
    let notifiedCount = 0;
    let pushSentCount = 0;
    const jobTitle = careTypes.length > 0 ? `${careTypes.join(", ")} job` : "Care job";
    const todayIso = new Date().toISOString();
    for (const doc of snap.docs) {
        const cg = doc.data();
        const phone = cg.phone;
        if (!phone || cg.optedOut === true)
            continue;
        // Skip paused caregivers — they're on vacation / temporarily off the platform
        const pausedUntil = cg.pausedUntil;
        if (pausedUntil && pausedUntil > todayIso)
            continue;
        const cgLat = (_q = (_o = cg.latitude) !== null && _o !== void 0 ? _o : (_p = cg.location) === null || _p === void 0 ? void 0 : _p.latitude) !== null && _q !== void 0 ? _q : (_r = cg.location) === null || _r === void 0 ? void 0 : _r.lat;
        const cgLng = (_u = (_s = cg.longitude) !== null && _s !== void 0 ? _s : (_t = cg.location) === null || _t === void 0 ? void 0 : _t.longitude) !== null && _u !== void 0 ? _u : (_v = cg.location) === null || _v === void 0 ? void 0 : _v.lng;
        const dist = (0, scoring_1.haversineMiles)(clientLat, clientLng, cgLat, cgLng);
        if (dist === undefined || dist > NOTIFY_RADIUS_MILES)
            continue;
        try {
            // Idempotency guard — don't text the same caregiver twice for the same job
            const existing = await db.collection("job_notifications")
                .where("caregiverId", "==", doc.id)
                .where("jobId", "==", jobId)
                .limit(1)
                .get();
            if (!existing.empty)
                continue;
            const session = await (0, client_1.getOrCreateSession)(phone, { caregiverId: doc.id });
            if (session.optedOut)
                continue;
            const firstName = ((_x = (_w = cg.firstName) !== null && _w !== void 0 ? _w : cg.name) !== null && _x !== void 0 ? _x : "there").split(" ")[0];
            const scheduleText = buildScheduleText(intakeData);
            const careText = careTypes.length > 0 ? careTypes.join(", ") : "care";
            const message = `Hi ${firstName}! A new care job opened near you.\n\n` +
                `📍 ${city || "your area"} · ${careText}` +
                (scheduleText ? `\n${scheduleText}` : "") +
                `\n\nInterested? Reply YES or NO.`;
            await (0, client_1.startTyping)(session.chatId).catch(() => { });
            await (0, client_1.sendMessage)(session.chatId, message);
            await db.collection("job_notifications").add({
                caregiverId: doc.id,
                jobId,
                phone,
                sentAt: new Date().toISOString(),
            });
            await db.collection("agent_sessions").doc(phone).update({
                awaitingJobResponse: true,
                awaitingAvailabilityConfirmation: false,
                pendingJobId: jobId,
                pendingJobSentAt: new Date().toISOString(),
            });
            notifiedCount++;
            // FCM push for high-match caregivers (cap at 50)
            if (pushSentCount < 50) {
                const cgSkills = [
                    ...((_y = cg.specialties) !== null && _y !== void 0 ? _y : []),
                    ...((_z = cg.medicalSkills) !== null && _z !== void 0 ? _z : []),
                    ...((_0 = cg.certifications) !== null && _0 !== void 0 ? _0 : []),
                ];
                const matchScore = computeSimpleMatchScore(cgSkills, careTypes);
                if (matchScore >= MATCH_PUSH_THRESHOLD) {
                    await sendJobMatchPush(doc.id, jobId, jobTitle, city || "your area", matchScore)
                        .catch(err => console.error(`[notifyAreaCaregivers] push failed for ${doc.id}:`, err));
                    pushSentCount++;
                }
            }
        }
        catch (err) {
            console.error(`[notifyAreaCaregivers] Failed for caregiver ${doc.id}:`, err);
        }
    }
    if (notifiedCount > 0) {
        await db.collection("job_posts").doc(jobId)
            .update({ notifiedCount: firestore_1.FieldValue.increment(notifiedCount) })
            .catch(err => console.error("[notifyAreaCaregivers] notifiedCount update failed:", err));
    }
    console.log(`[notifyAreaCaregivers] Notified ${notifiedCount} caregivers for job ${jobId}`);
}
function buildScheduleText(intake) {
    var _a, _b, _c;
    if (typeof intake.schedule === "string")
        return intake.schedule;
    const days = intake.daysPerWeek ? `${intake.daysPerWeek} days/week` : null;
    const time = (_c = (_a = intake.timeOfDay) !== null && _a !== void 0 ? _a : (_b = intake.schedule) === null || _b === void 0 ? void 0 : _b.timeOfDay) !== null && _c !== void 0 ? _c : null;
    const hours = intake.hoursPerDay ? `${intake.hoursPerDay} hrs/day` : null;
    return [days, time, hours].filter(Boolean).join(", ");
}
// ── handleJobResponse ─────────────────────────────────────────────────────────
async function handleJobResponse(phone, text, chatId, session) {
    const jobId = session.pendingJobId;
    if (!jobId) {
        await db.collection("agent_sessions").doc(phone).update({
            awaitingJobResponse: false,
            pendingJobId: null,
            pendingJobSentAt: null,
        });
        return;
    }
    // isQuestionOrOther — if caregiver asks a question instead of YES/NO, answer
    // it and re-pose the question without consuming the pending state.
    const qRaw = await (0, parseWithClaude_1.parseWithClaude)("A caregiver was just texted about a new job opportunity and asked to reply YES or NO. " +
        "Reply YES if their message is a general question or off-topic comment rather than a yes/no answer. " +
        "Reply NO if it is a direct yes/no decision. Only reply YES or NO.", text, 5);
    if (qRaw.toUpperCase().startsWith("Y")) {
        const answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A caregiver was offered a job and asked a question instead of replying YES/NO. " +
            "Answer their question briefly (1-2 sentences). Do NOT ask them to commit — that prompt comes next.", text, { maxTokens: 180 }).catch(() => "Let me get back to you on that. In the meantime —");
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "So — interested in this job? Reply YES or NO.");
        return;
    }
    // Single LLM call to determine YES/NO from natural language.
    const decision = await (0, parseWithClaude_1.parseWithClaude)('A caregiver is responding to a job offer. ' +
        '"yes", "yeah", "yep", "sure", "ok", "interested", "I\'ll take it" → YES. ' +
        '"no", "pass", "can\'t", "decline", "skip", "not interested" → NO. ' +
        'Reply with exactly YES or NO.', text, 5);
    const isYes = ["YES", "Y", "YEAH", "YEP"].includes(decision.toUpperCase());
    if (!isYes) {
        await db.collection("agent_sessions").doc(phone).update({
            awaitingJobResponse: false,
            pendingJobId: null,
            pendingJobSentAt: null,
        });
        await (0, client_1.sendMessage)(chatId, "No problem — I'll reach out when something comes up.");
        // Record the decline and check if all notified caregivers have declined
        await db.collection("job_notifications")
            .where("phone", "==", phone)
            .where("jobId", "==", jobId)
            .limit(1)
            .get()
            .then(snap => {
            if (!snap.empty)
                return snap.docs[0].ref.update({ status: "declined", declinedAt: new Date().toISOString() });
            return undefined;
        })
            .catch(() => { });
        notifyFamilyIfAllDeclined(jobId).catch(err => console.error("[handleJobResponse] notifyFamilyIfAllDeclined failed:", err));
        return;
    }
    // YES path — ask availability confirmation
    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    const scheduleText = jobSnap.exists
        ? buildScheduleSummaryFromJobPost(jobSnap.data())
        : "this schedule";
    await db.collection("agent_sessions").doc(phone).update({
        awaitingJobResponse: false,
        awaitingAvailabilityConfirmation: true,
        pendingJobId: jobId,
    });
    await (0, client_1.sendMessage)(chatId, `Great! Just to confirm — are you available for ${scheduleText}?\n\nReply YES to apply or NO to pass.`);
}
async function notifyFamilyIfAllDeclined(jobId) {
    var _a, _b, _c, _d, _e;
    const notifSnap = await db.collection("job_notifications")
        .where("jobId", "==", jobId)
        .get();
    if (notifSnap.empty)
        return;
    const allDeclined = notifSnap.docs.every(d => d.data().status === "declined" || d.data().status === "applied");
    // Only act if every notified caregiver has responded AND all declined
    const anyApplied = notifSnap.docs.some(d => d.data().status === "applied");
    if (!allDeclined || anyApplied)
        return;
    // Look up the job post → get clientId → find family phone
    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    if (!jobSnap.exists)
        return;
    const jobData = jobSnap.data();
    const clientId = jobData.clientId;
    if (!clientId)
        return;
    // Cap re-match attempts at 2 to prevent infinite loops
    const rematchAttempts = ((_a = jobData.rematchAttempts) !== null && _a !== void 0 ? _a : 0);
    if (rematchAttempts >= 2) {
        // All attempts exhausted — escalate to admin and notify family
        await db.collection("admin_alerts").add({
            type: "job_no_coverage",
            jobId,
            clientId,
            createdAt: new Date().toISOString(),
            resolved: false,
            priority: "high",
        });
        const userSnap = await db.collection("users").doc(clientId).get();
        const familyPhone = (_b = userSnap.data()) === null || _b === void 0 ? void 0 : _b.phone;
        if (familyPhone) {
            await (0, caraAgent_1.sendViaInteractionAgent)(familyPhone, {
                content: "I've done a thorough search and haven't been able to find available caregivers right now. " +
                    "Our team has been notified and will reach out within 2 hours to help.",
                urgency: "standard",
                sourceAgent: "job_notification",
                canDrop: false,
            });
        }
        await db.collection("job_posts").doc(jobId).update({ status: "no_coverage" });
        return;
    }
    // Increment attempt counter before proceeding
    await db.collection("job_posts").doc(jobId).update({
        rematchAttempts: firestore_1.FieldValue.increment(1),
    });
    const userSnap = await db.collection("users").doc(clientId).get();
    const familyPhone = (_c = userSnap.data()) === null || _c === void 0 ? void 0 : _c.phone;
    if (!familyPhone)
        return;
    await (0, caraAgent_1.sendViaInteractionAgent)(familyPhone, {
        content: "The caregivers I reached out to aren't available right now. " +
            "I'm searching for more options and will text you as soon as I find a match.",
        urgency: "standard",
        sourceAgent: "job_notification",
        canDrop: false,
    });
    // Trigger a fresh broad matching pass
    const sessionSnap = await db.collection("agent_sessions").doc(familyPhone).get();
    if (sessionSnap.exists) {
        const sessionData = (_d = sessionSnap.data()) !== null && _d !== void 0 ? _d : {};
        const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
        await runMatchingForClient(familyPhone, (_e = sessionData.chatId) !== null && _e !== void 0 ? _e : "", sessionData, sessionData).catch(err => console.error("[notifyFamilyIfAllDeclined] re-match failed:", err));
    }
}
function buildScheduleSummaryFromJobPost(job) {
    var _a;
    if (typeof job.schedule === "string")
        return job.schedule;
    const days = job.daysPerWeek ? `${job.daysPerWeek} days/week` : null;
    const time = (_a = job.timeOfDay) !== null && _a !== void 0 ? _a : null;
    const hours = job.hoursPerDay ? `${job.hoursPerDay} hrs/day` : null;
    return [days, time, hours].filter(Boolean).join(", ") || "this schedule";
}
// ── handleAvailabilityConfirmation ────────────────────────────────────────────
async function handleAvailabilityConfirmation(phone, text, chatId, session) {
    var _a, _b;
    const jobId = session.pendingJobId;
    // Always clear flags first
    await db.collection("agent_sessions").doc(phone).update({
        awaitingAvailabilityConfirmation: false,
        pendingJobId: null,
        pendingJobSentAt: null,
    });
    if (!jobId) {
        await (0, client_1.sendMessage)(chatId, "No problem — I'll reach out when the next opportunity opens up.");
        return;
    }
    let available = false;
    try {
        available = await parseAvailabilityConfirmation(text);
    }
    catch (err) {
        console.error("[handleAvailabilityConfirmation] Haiku parse failed:", err);
        // Default to treating as NO on parse failure
    }
    if (!available) {
        await (0, client_1.sendMessage)(chatId, "No worries — thanks for letting us know. I'll reach out when something else opens up.");
        return;
    }
    // YES — write application
    try {
        const jobSnap = await db.collection("job_posts").doc(jobId).get();
        if (!jobSnap.exists) {
            await (0, client_1.sendMessage)(chatId, "Sorry, that position is no longer available. I'll text you when new ones come up!");
            return;
        }
        const job = jobSnap.data();
        const clientId = job.clientId;
        // Resolve caregiverId from session or by phone lookup
        let caregiverId = session.caregiverId;
        if (!caregiverId) {
            const cgSnap = await db.collection("caregivers").where("phone", "==", phone).limit(1).get();
            caregiverId = cgSnap.empty ? undefined : cgSnap.docs[0].id;
        }
        if (!caregiverId) {
            console.error("[handleAvailabilityConfirmation] Could not resolve caregiverId for phone", phone);
            await (0, client_1.sendMessage)(chatId, "Something went wrong — please contact us directly to apply.");
            return;
        }
        const caregiverName = (_b = (_a = session.name) !== null && _a !== void 0 ? _a : session.firstName) !== null && _b !== void 0 ? _b : "Caregiver";
        // Write application
        await db.collection("job_applications").add({
            jobId,
            caregiverId,
            clientId,
            phone,
            caregiverName,
            status: "pending",
            appliedAt: new Date().toISOString(),
            source: "sms_notification",
        });
        // Add to family's candidate pool
        await db.collection("clientMatches").doc(clientId).set({ appliedCandidates: firestore_1.FieldValue.arrayUnion(caregiverId), updatedAt: new Date().toISOString() }, { merge: true });
        // Notify family
        await notifyFamilyOfApplicant(clientId, caregiverName, caregiverId);
        await (0, client_1.sendMessage)(chatId, "You're in. I'll let you know once the family reviews your application.");
        console.log(`[handleAvailabilityConfirmation] ${caregiverId} applied to job ${jobId}`);
    }
    catch (err) {
        console.error("[handleAvailabilityConfirmation] application write failed:", err);
        await (0, client_1.sendMessage)(chatId, "Something went wrong on our end. Please try again or contact us directly.");
    }
}
async function parseAvailabilityConfirmation(text) {
    const decision = await (0, parseWithClaude_1.parseWithClaude)("A caregiver is confirming or declining availability for a specific care job. " +
        "Reply YES if they confirm availability, NO if they decline. Reply with exactly YES or NO.", text, 5);
    return decision.toUpperCase() === "YES";
}
async function notifyFamilyOfApplicant(clientId, caregiverName, caregiverId) {
    var _a;
    try {
        const userSnap = await db.collection("users").doc(clientId).get();
        const familyPhone = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
        if (!familyPhone)
            return;
        const output = {
            content: `${caregiverName} just applied to your open care job and confirmed availability.\n\n` +
                `You can review their profile in the app. Reply HIRE to book them, or PASS to keep looking.`,
            urgency: "standard",
            sourceAgent: "job_notification",
            canDrop: false,
        };
        await (0, caraAgent_1.sendViaInteractionAgent)(familyPhone, output);
    }
    catch (err) {
        console.error("[notifyFamilyOfApplicant] failed:", err);
    }
}
// ── closeJobPost ──────────────────────────────────────────────────────────────
async function closeJobPost(clientId) {
    try {
        const snap = await db.collection("job_posts")
            .where("clientId", "==", clientId)
            .where("status", "==", "open")
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
        if (snap.empty)
            return;
        await snap.docs[0].ref.update({
            status: "closed",
            closedAt: new Date().toISOString(),
        });
        console.log(`[closeJobPost] Closed job post ${snap.docs[0].id} for client ${clientId}`);
    }
    catch (err) {
        console.error("[closeJobPost] failed:", err);
    }
}
//# sourceMappingURL=jobNotifications.js.map