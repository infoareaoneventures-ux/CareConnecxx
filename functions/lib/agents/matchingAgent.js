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
exports.runMatchingForClient = runMatchingForClient;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const executionAgent_1 = require("./executionAgent");
const learnedFacts_1 = require("../memory/learnedFacts");
const db = admin.firestore();
function computeMatchScore(caregiver, intake) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    const needs = ((_a = intake.careNeeds) !== null && _a !== void 0 ? _a : []);
    const intakeCity = ((_b = intake.city) !== null && _b !== void 0 ? _b : "").toLowerCase();
    const intakeZip = ((_c = intake.zipCode) !== null && _c !== void 0 ? _c : "");
    const intakeDays = ((_d = intake.daysPerWeek) !== null && _d !== void 0 ? _d : 0);
    const intakeTimeOfDay = ((_e = intake.timeOfDay) !== null && _e !== void 0 ? _e : "").toLowerCase();
    const genderPref = ((_f = intake.genderPreference) !== null && _f !== void 0 ? _f : "").toLowerCase();
    // Skills match (0-100): % of care needs matched by specialties
    const matchedNeeds = needs.filter((n) => { var _a; return (_a = caregiver.specialties) === null || _a === void 0 ? void 0 : _a.some((s) => s.toLowerCase().includes(n.toLowerCase())); });
    const skillsMatch = needs.length > 0
        ? Math.round((matchedNeeds.length / needs.length) * 100)
        : 70;
    // Distance score (0-100): exact city = 100, zip prefix match = 70, no match = 30
    const cgCity = ((_g = caregiver.city) !== null && _g !== void 0 ? _g : "").toLowerCase();
    const cgZip = ((_h = caregiver.zipCode) !== null && _h !== void 0 ? _h : "");
    let distanceScore = 30;
    if (cgCity === intakeCity)
        distanceScore = 100;
    else if (intakeZip && cgZip && intakeZip.slice(0, 3) === cgZip.slice(0, 3))
        distanceScore = 70;
    // Availability match (0-100): simplified — overlap on time of day
    const cgHours = ((_k = (_j = caregiver.availability) === null || _j === void 0 ? void 0 : _j.hours) !== null && _k !== void 0 ? _k : "").toLowerCase();
    let availabilityMatch = 60;
    if (cgHours.includes(intakeTimeOfDay) || intakeTimeOfDay === "")
        availabilityMatch = 90;
    if (intakeDays > 5 && !cgHours.includes("weekend"))
        availabilityMatch = Math.min(availabilityMatch, 70);
    // Rating score (0-100): 5-star → 100
    const ratingScore = Math.min(Math.round(((_l = caregiver.rating) !== null && _l !== void 0 ? _l : 3.5) / 5 * 100), 100);
    // Personality / gender preference (0-100)
    let personalityMatch = 75;
    if (genderPref && caregiver.gender) {
        personalityMatch = caregiver.gender.toLowerCase() === genderPref ? 95 : 55;
    }
    // Experience-weighted rebooking proxy (0-100)
    const rebookingRate = Math.min(Math.round(50 + ((_m = caregiver.yearsExperience) !== null && _m !== void 0 ? _m : 0) * 5 + ((_o = caregiver.rating) !== null && _o !== void 0 ? _o : 3) * 5), 100);
    // Weighted average: skills 35%, distance 20%, rating 20%, availability 15%, personality 10%
    const overallScore = Math.round(skillsMatch * 0.35 +
        distanceScore * 0.20 +
        ratingScore * 0.20 +
        availabilityMatch * 0.15 +
        personalityMatch * 0.10);
    // Build reasoning list
    const reasoning = [];
    if (matchedNeeds.length > 0)
        reasoning.push(`Specializes in ${matchedNeeds.slice(0, 2).join(" and ")}`);
    if (distanceScore === 100)
        reasoning.push(`Located in ${intake.city}`);
    if (((_p = caregiver.rating) !== null && _p !== void 0 ? _p : 0) >= 4.8)
        reasoning.push("Top-rated by families");
    if (((_q = caregiver.yearsExperience) !== null && _q !== void 0 ? _q : 0) >= 5)
        reasoning.push(`${caregiver.yearsExperience} years of experience`);
    if (availabilityMatch >= 90)
        reasoning.push("Available at your preferred times");
    if (reasoning.length === 0)
        reasoning.push("Available and local");
    const confidence = overallScore >= 80 ? "high" : overallScore >= 65 ? "medium" : "low";
    return {
        overallScore,
        breakdown: { skillsMatch, availabilityMatch, personalityMatch, distanceScore, ratingScore, rebookingRate },
        reasoning,
        confidence,
    };
}
async function runMatchingForClient(phone, chatId, intake, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    try {
        const zip = ((_a = intake.zipCode) !== null && _a !== void 0 ? _a : "");
        const city = ((_b = intake.city) !== null && _b !== void 0 ? _b : "");
        // Exclude caregivers the family has already declined
        const rejectedIds = ((_c = session === null || session === void 0 ? void 0 : session.rejectedCaregiverIds) !== null && _c !== void 0 ? _c : []);
        if (!session) {
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            if (sessionSnap.exists) {
                rejectedIds.push(...((_e = (_d = sessionSnap.data()) === null || _d === void 0 ? void 0 : _d.rejectedCaregiverIds) !== null && _e !== void 0 ? _e : []));
            }
        }
        // Pull active + pending_review caregivers in a broad radius
        const snap = await db.collection("caregivers")
            .where("status", "in", ["active", "pending_review"])
            .limit(50)
            .get();
        let caregivers = snap.docs
            .map((d) => {
            var _a;
            return (Object.assign({ id: d.id, pendingBackgroundCheck: d.data().status === "pending_review", backgroundCheckStatus: (_a = d.data().backgroundCheckData) === null || _a === void 0 ? void 0 : _a.status, certifications: d.data().certifications }, d.data()));
        })
            .filter((c) => {
            var _a, _b;
            return !rejectedIds.includes(c.id) && (((_a = c.city) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === city.toLowerCase() ||
                ((_b = c.zipCode) === null || _b === void 0 ? void 0 : _b.startsWith(zip.slice(0, 3))));
        });
        if (caregivers.length === 0) {
            // Broader search if local returns nothing (still respecting rejections)
            caregivers = snap.docs
                .map((d) => (Object.assign({ id: d.id }, d.data())))
                .filter((c) => !rejectedIds.includes(c.id));
        }
        const scoredCaregivers = caregivers
            .map((c) => ({ c, matchScore: computeMatchScore(c, intake) }))
            .sort((a, b) => b.matchScore.overallScore - a.matchScore.overallScore);
        const top3 = scoredCaregivers.slice(0, 3).map((x) => x.c);
        const top3Scores = scoredCaregivers.slice(0, 3).map((x) => x.matchScore);
        if (top3.length === 0) {
            // Write admin alert so the team can manually follow up
            const intakeCareNeeds = ((_f = intake.careNeeds) !== null && _f !== void 0 ? _f : []);
            await db.collection("admin_alerts").add({
                type: "no_match_found",
                clientPhone: phone,
                city: ((_g = intake.city) !== null && _g !== void 0 ? _g : ""),
                zipCode: ((_h = intake.zipCode) !== null && _h !== void 0 ? _h : ""),
                careNeeds: intakeCareNeeds,
                createdAt: new Date().toISOString(),
                resolved: false,
                severity: "high",
            });
            await (0, client_1.sendMessage)(chatId, "I don't have anyone available in your area right now, but I've flagged your request " +
                "and our team will reach out within 24 hours to find the right match.");
            return;
        }
        // Write pending interview requests (and caregiver_interest tasks for pending-bg-check caregivers)
        for (let i = 0; i < top3.length; i++) {
            const c = top3[i];
            const ms = top3Scores[i];
            await db.collection("interview_requests").add({
                clientPhone: phone,
                caregiverId: c.id,
                caregiverName: c.name,
                status: "pending_presentation",
                createdAt: new Date().toISOString(),
                matchScore: {
                    overallScore: ms.overallScore,
                    breakdown: ms.breakdown,
                    reasoning: ms.reasoning,
                    confidence: ms.confidence,
                },
            });
            if (c.pendingBackgroundCheck) {
                await db.collection("agent_tasks").add({
                    type: "caregiver_interest",
                    caregiverId: c.id,
                    caregiverName: c.name,
                    clientPhone: phone,
                    clientId: (_j = session === null || session === void 0 ? void 0 : session.userId) !== null && _j !== void 0 ? _j : phone,
                    status: "pending_bg_clear",
                    createdAt: new Date().toISOString(),
                });
            }
        }
        const seniorName = ((_k = intake.seniorName) !== null && _k !== void 0 ? _k : "your loved one");
        const needs = ((_l = intake.careNeeds) !== null && _l !== void 0 ? _l : []);
        const appUrl = (_m = process.env.APP_URL) !== null && _m !== void 0 ? _m : "https://cara.app";
        const userId = (_o = session === null || session === void 0 ? void 0 : session.userId) !== null && _o !== void 0 ? _o : phone;
        // Surface remembered client preferences so Cara can reference them naturally
        const learnedFacts = await (0, learnedFacts_1.getRelevantFacts)(userId).catch(() => []);
        const factsContext = learnedFacts.length > 0
            ? `\n\n🧠 KNOWN PREFERENCES (learned from past conversations):\n${learnedFacts.map(f => `- ${f.fact}`).join("\n")}\nIf the top match aligns with a known preference, mention it naturally (e.g. "You mentioned preferring female caregivers — Maria fits that perfectly.").`
            : "";
        // Compute a simple trust score (0-100) for each caregiver
        function caregiversTrustScore(c) {
            var _a, _b, _c;
            let s = 0;
            const bgStatus = (_a = c.backgroundCheckStatus) !== null && _a !== void 0 ? _a : (c.pendingBackgroundCheck ? "pending" : "clear");
            if (bgStatus === "clear")
                s += 30;
            const approvedAt = c.approvedAt;
            if (approvedAt) {
                const months = Math.floor((Date.now() - new Date(approvedAt).getTime()) / (30 * 24 * 60 * 60 * 1000));
                s += Math.min(months, 12) / 12 * 20;
            }
            if (c.rating != null)
                s += (c.rating / 5) * 20;
            const vStatus = c.verificationStatus;
            if (vStatus === "approved" || vStatus === "checkr_clear")
                s += 15;
            s += (Math.min((_c = (_b = c.certifications) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0, 3) / 3) * 15;
            return Math.round(s);
        }
        // Build structured match data for the execution agent's context
        const matchData = top3.map((c, i) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const ms = top3Scores[i];
            const bgStatus = (_a = c.backgroundCheckStatus) !== null && _a !== void 0 ? _a : (c.pendingBackgroundCheck ? "pending" : "clear");
            const trustLines = [];
            if (bgStatus === "clear")
                trustLines.push("background check cleared");
            if ((_b = c.certifications) === null || _b === void 0 ? void 0 : _b.length)
                trustLines.push(c.certifications.slice(0, 2).join(", "));
            return {
                index: i + 1,
                id: c.id,
                name: c.name,
                hourlyRate: c.hourlyRate,
                rating: (_c = c.rating) !== null && _c !== void 0 ? _c : null,
                bgStatus,
                trustSignals: trustLines,
                trustScore: caregiversTrustScore(c),
                pendingBg: !!c.pendingBackgroundCheck,
                topReason: (_d = ms.reasoning[0]) !== null && _d !== void 0 ? _d : "available and local",
                allReasons: ms.reasoning,
                overallScore: ms.overallScore,
                profileUrl: `${appUrl}/caregiver/${c.id}`,
                specialties: (_e = c.specialties) !== null && _e !== void 0 ? _e : [],
                yearsExp: (_f = c.yearsExperience) !== null && _f !== void 0 ? _f : null,
                city: (_g = c.city) !== null && _g !== void 0 ? _g : "",
            };
        });
        // Build the matching agent system prompt with full caregiver context baked in
        const matchSummary = matchData
            .map(m => `${m.index}. ${m.name} — ${m.topReason}. $${m.hourlyRate}/hr` +
            (m.trustScore >= 60 ? ` · ${m.trustScore}⭐ Trust` : "") +
            (m.trustSignals.length ? `\n   ✓ ${m.trustSignals.join(" · ")}` : "") +
            (m.pendingBg ? `\n   ⏳ Background check in progress` : "") +
            `\n   Profile: ${m.profileUrl}` +
            `\n   Specialties: ${m.specialties.join(", ") || "general care"}` +
            (m.yearsExp ? `\n   Experience: ${m.yearsExp} years` : ""))
            .join("\n\n");
        const agentSystemPrompt = `You are Cara's matching agent. You found these caregivers for ${seniorName}:\n\n` +
            `${matchSummary}\n\n` +
            `Care needs: ${needs.join(", ") || "general"}` +
            factsContext +
            `\n\nYour job:\n` +
            `- First turn: write a warm, specific intro message presenting these caregivers\n` +
            `- Follow-up turns: answer questions about the specific caregivers from the details above\n` +
            `- If asked about a caregiver not in this list, say you only have details for the ones you presented\n\n` +
            `Rules: plain text only, no bullet points, no headers. Warm, direct, specific. ` +
            `Under 300 characters per message when possible. End the intro with "Which ones would you like to meet?"`;
        // Roster check — reuse existing agent if one is active for this user
        const existingAgent = await (0, executionAgent_1.getActiveAgentForUser)(phone, "matching");
        let agentId;
        if (existingAgent) {
            await (0, executionAgent_1.updateExecutionAgentContext)(existingAgent.id, { matchData, seniorName, careNeeds: needs }, agentSystemPrompt, true);
            agentId = existingAgent.id;
        }
        else {
            agentId = await (0, executionAgent_1.spawnExecutionAgent)({
                type: "matching",
                ownerId: userId,
                ownerPhone: phone,
                systemPrompt: agentSystemPrompt,
                context: { matchData, seniorName, careNeeds: needs },
            });
        }
        // First agent turn generates the intro message
        const introMessage = await (0, executionAgent_1.runExecutionAgentTurn)(agentId, "Introduce these caregivers to the family now.");
        await (0, client_1.sendMessage)(chatId, introMessage || `Here are ${top3.length} caregivers I found for ${seniorName}. Which would you like to meet?`);
        // Store match list in session for follow-up; embed active goal context so
        // interview selection can pre-populate booking dates without re-prompting the family
        const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
        const goalContext = ((_q = (_p = sessionSnap2.data()) === null || _p === void 0 ? void 0 : _p.activeGoal) === null || _q === void 0 ? void 0 : _q.type) === "booking"
            ? sessionSnap2.data().activeGoal.context
            : null;
        await db.collection("agent_sessions").doc(phone).update({
            pendingMatches: top3.map((c, i) => (Object.assign({ id: c.id, name: c.name, rate: c.hourlyRate, matchScore: top3Scores[i], agentId }, (goalContext ? { goalContext } : {})))),
        });
    }
    catch (err) {
        console.error("runMatchingForClient error:", err);
        await (0, client_1.sendMessage)(chatId, "I'm searching for caregivers — I'll text you top matches within the hour.");
    }
}
//# sourceMappingURL=matchingAgent.js.map