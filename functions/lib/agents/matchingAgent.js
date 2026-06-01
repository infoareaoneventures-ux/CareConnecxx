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
const claudeMatching_1 = require("../ai/claudeMatching");
const outcomeAnalytics_1 = require("../ai/outcomeAnalytics");
const db = admin.firestore();
/** Compute rule-based signals as a pre-filter before calling Claude. */
function computeRuleSignals(caregiver, intake) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    const needs = ((_a = intake.careNeeds) !== null && _a !== void 0 ? _a : []);
    const intakeCity = ((_b = intake.city) !== null && _b !== void 0 ? _b : "").toLowerCase();
    const intakeZip = ((_c = intake.zipCode) !== null && _c !== void 0 ? _c : "");
    const intakeDays = ((_d = intake.daysPerWeek) !== null && _d !== void 0 ? _d : 0);
    const intakeTod = ((_e = intake.timeOfDay) !== null && _e !== void 0 ? _e : "").toLowerCase();
    const allSkills = [
        ...((_f = caregiver.specialties) !== null && _f !== void 0 ? _f : []),
        ...((_g = caregiver.certifications) !== null && _g !== void 0 ? _g : []),
    ];
    const skillsCoverage = (0, claudeMatching_1.computeSkillsCoverage)(allSkills, needs);
    // Simple distance proxy from city/zip (no lat/lng in this flow)
    const cgCity = ((_h = caregiver.city) !== null && _h !== void 0 ? _h : "").toLowerCase();
    const cgZip = ((_j = caregiver.zipCode) !== null && _j !== void 0 ? _j : "");
    let distanceMiles;
    if (cgCity === intakeCity)
        distanceMiles = 2;
    else if (intakeZip && cgZip && intakeZip.slice(0, 3) === cgZip.slice(0, 3))
        distanceMiles = 12;
    else
        distanceMiles = 22;
    const cgHours = ((_l = (_k = caregiver.availability) === null || _k === void 0 ? void 0 : _k.hours) !== null && _l !== void 0 ? _l : "").toLowerCase();
    let scheduleOverlap = 60;
    if (cgHours.includes(intakeTod) || intakeTod === "")
        scheduleOverlap = 90;
    if (intakeDays > 5 && !cgHours.includes("weekend"))
        scheduleOverlap = Math.min(scheduleOverlap, 70);
    // Quick rule-based score for pre-filtering only (not the final score)
    let ruleScore = Math.round(skillsCoverage * 0.35 +
        (distanceMiles <= 5 ? 100 : distanceMiles <= 15 ? 70 : 30) * 0.20 +
        Math.min(Math.round(((_m = caregiver.rating) !== null && _m !== void 0 ? _m : 3.5) / 5 * 100), 100) * 0.20 +
        scheduleOverlap * 0.15 +
        75 * 0.10 // personality placeholder
    );
    // Soft preference penalties — keep mismatches IN the pool (so we never dead-end
    // a family with no matches) but push them down so better-fitting caregivers
    // surface first. Claude does the nuanced scoring; this just orders the top 15.
    const budgetMax = Number((_o = intake.budgetMax) !== null && _o !== void 0 ? _o : 0);
    const genderPref = ((_p = intake.genderPreference) !== null && _p !== void 0 ? _p : "").toLowerCase();
    if (budgetMax > 0 && caregiver.hourlyRate > budgetMax)
        ruleScore -= 20;
    if (genderPref && caregiver.gender && caregiver.gender.toLowerCase() !== genderPref)
        ruleScore -= 15;
    if (intake.needsDriving === true && caregiver.canDrive === false)
        ruleScore -= 10;
    ruleScore = Math.max(0, ruleScore);
    const signals = {
        caregiverId: caregiver.id,
        name: caregiver.name,
        distanceMiles,
        skillsCoveragePercent: skillsCoverage,
        scheduleOverlapPercent: scheduleOverlap,
        rating: caregiver.rating,
        yearsExperience: caregiver.yearsExperience,
        isVerified: !caregiver.pendingBackgroundCheck,
        certifications: caregiver.certifications,
        languages: caregiver.languages,
        gender: caregiver.gender,
        canDrive: caregiver.canDrive,
        personalityTags: [],
        hourlyRate: caregiver.hourlyRate,
        hasDementiaCert: (0, claudeMatching_1.detectDementiaCert)(allSkills),
        hasMedicalCred: (0, claudeMatching_1.detectMedicalCred)(allSkills),
        feedbackSummary: "no prior history with this family",
        ruleScore,
    };
    return { ruleScore, signals };
}
async function runMatchingForClient(phone, chatId, intake, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
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
        // Step 1: compute rule-based signals for pre-filtering
        const withSignals = caregivers.map(c => (Object.assign({ c }, computeRuleSignals(c, intake))));
        // Step 2: take top 15 by rule score to send to Claude
        const topCandidates = withSignals
            .sort((a, b) => b.ruleScore - a.ruleScore)
            .slice(0, 15);
        // Step 3: Claude Sonnet scores all top candidates holistically
        const outcomePatterns = await (0, outcomeAnalytics_1.getOutcomePatternSummary)(db).catch(() => "");
        const systemPrompt = (0, claudeMatching_1.buildMatchingSystemPrompt)(outcomePatterns);
        const needs = ((_f = intake.careNeeds) !== null && _f !== void 0 ? _f : []);
        const senior = {
            needs,
            genderPreference: ((_g = intake.genderPreference) !== null && _g !== void 0 ? _g : ""),
            languagePreference: ((_h = intake.languagePreference) !== null && _h !== void 0 ? _h : ""),
            budgetMax: Number((_j = intake.budgetMax) !== null && _j !== void 0 ? _j : 0) || undefined,
            needsDriving: intake.needsDriving === true,
            personality: ((_k = intake.seniorPersonality) !== null && _k !== void 0 ? _k : ""),
            name: ((_l = intake.seniorName) !== null && _l !== void 0 ? _l : ""),
        };
        let claudeScores;
        try {
            claudeScores = await (0, claudeMatching_1.scoreWithClaude)(topCandidates.map(x => x.signals), senior, systemPrompt, 3000);
        }
        catch (err) {
            console.warn("[matchingAgent] Claude scoring failed, falling back to rule scores:", err);
            // Fallback: convert rule signals to MatchScoreResult shape
            claudeScores = new Map(topCandidates.map(x => {
                var _a, _b, _c, _d;
                return [x.c.id, {
                        caregiverId: x.c.id,
                        overallScore: x.ruleScore,
                        confidence: x.ruleScore >= 80 ? "high" : x.ruleScore >= 65 ? "medium" : "low",
                        reasoning: [
                            ((_a = x.signals.skillsCoveragePercent) !== null && _a !== void 0 ? _a : 0) > 60
                                ? `Covers ${x.signals.skillsCoveragePercent}% of care needs` : "Available caregiver",
                        ],
                        redFlags: [],
                        factors: {
                            skillsMatch: (_b = x.signals.skillsCoveragePercent) !== null && _b !== void 0 ? _b : 50,
                            availability: (_c = x.signals.scheduleOverlapPercent) !== null && _c !== void 0 ? _c : 60,
                            distance: x.signals.distanceMiles != null
                                ? Math.max(0, 100 - x.signals.distanceMiles * 3) : 50,
                            experience: Math.min(100, ((_d = x.signals.yearsExperience) !== null && _d !== void 0 ? _d : 0) * 10),
                            personalityFit: 75,
                            languageMatch: 75,
                        },
                    }];
            }));
        }
        // Step 4: build MatchScoreResult objects from Claude output
        const scoredCaregivers = topCandidates
            .map(({ c }) => {
            const claude = claudeScores.get(c.id);
            if (!claude)
                return null;
            const ms = {
                overallScore: claude.overallScore,
                confidence: claude.confidence,
                reasoning: claude.reasoning,
                breakdown: {
                    skillsMatch: claude.factors.skillsMatch,
                    availabilityMatch: claude.factors.availability,
                    personalityMatch: claude.factors.personalityFit,
                    distanceScore: claude.factors.distance,
                    ratingScore: claude.factors.experience,
                    rebookingRate: 70,
                },
            };
            return { c, matchScore: ms };
        })
            .filter(Boolean)
            .sort((a, b) => b.matchScore.overallScore - a.matchScore.overallScore);
        const top3 = scoredCaregivers.slice(0, 3).map((x) => x.c);
        const top3Scores = scoredCaregivers.slice(0, 3).map((x) => x.matchScore);
        if (top3.length === 0) {
            // Read and increment the failure counter on the client's session
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            const prevFailures = ((_o = (_m = sessionSnap.data()) === null || _m === void 0 ? void 0 : _m.consecutiveMatchFailures) !== null && _o !== void 0 ? _o : 0);
            const failureCount = prevFailures + 1;
            await db.collection("agent_sessions").doc(phone).update({ consecutiveMatchFailures: failureCount });
            const intakeCareNeeds = ((_p = intake.careNeeds) !== null && _p !== void 0 ? _p : []);
            const severity = failureCount >= 2 ? "urgent" : "high";
            await db.collection("admin_alerts").add({
                type: "no_match_found",
                clientPhone: phone,
                city: ((_q = intake.city) !== null && _q !== void 0 ? _q : ""),
                zipCode: ((_r = intake.zipCode) !== null && _r !== void 0 ? _r : ""),
                careNeeds: intakeCareNeeds,
                failureCount,
                createdAt: new Date().toISOString(),
                resolved: false,
                severity,
            });
            if (failureCount >= 2) {
                // Pool is repeatedly exhausted — escalate urgently and keep searching
                await (0, client_1.sendMessage)(chatId, "I haven't been able to find the right match yet, but I'm still actively searching. " +
                    "Our team has also been notified and will personally reach out to you shortly — we won't let you wait.");
                // Auto-trigger a broader rematch on the next cycle by clearing rejected list
                // only if all local + broader search is exhausted
                if (rejectedIds.length > 0) {
                    // Widen the pool: keep only the last 3 rejections to allow re-presentation after escalation
                    const trimmedRejections = rejectedIds.slice(-3);
                    await db.collection("agent_sessions").doc(phone).update({
                        rejectedCaregiverIds: trimmedRejections,
                    });
                }
            }
            else {
                await (0, client_1.sendMessage)(chatId, "I don't have anyone available in your area right now, but I've flagged your request " +
                    "and our team will reach out within 24 hours to find the right match.");
            }
            return;
        }
        // Successful match — reset the failure counter
        await db.collection("agent_sessions").doc(phone).update({ consecutiveMatchFailures: 0 }).catch(() => { });
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
                    clientId: (_s = session === null || session === void 0 ? void 0 : session.userId) !== null && _s !== void 0 ? _s : phone,
                    status: "pending_bg_clear",
                    createdAt: new Date().toISOString(),
                });
            }
        }
        const seniorName = ((_t = intake.seniorName) !== null && _t !== void 0 ? _t : "your loved one");
        const appUrl = (_u = process.env.APP_URL) !== null && _u !== void 0 ? _u : "https://cara.app";
        const userId = (_v = session === null || session === void 0 ? void 0 : session.userId) !== null && _v !== void 0 ? _v : phone;
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
            `Under 300 characters per message when possible. ` +
            `When you reference a Profile link, copy the URL EXACTLY as shown above including the https:// prefix — never shorten, paraphrase, or drop the scheme (clients need to be able to tap it). ` +
            `End the intro with "Which ones would you like to meet?"`;
        // Roster check — reuse existing agent if one is active for this user
        const existingAgent = await (0, executionAgent_1.getActiveAgentForUser)(phone, "matching");
        let agentId;
        if (existingAgent) {
            // Keep history so the family can reference previous caregivers discussed;
            // only update the system prompt + context with the fresh match data.
            await (0, executionAgent_1.updateExecutionAgentContext)(existingAgent.id, { matchData, seniorName, careNeeds: needs }, agentSystemPrompt, false);
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
        // First agent turn generates the intro message — route through interaction agent
        // so it gets supervisor lint, DND respect, and proper chunking.
        const introMessage = await (0, executionAgent_1.runExecutionAgentTurn)(agentId, "Introduce these caregivers to the family now.");
        // Deterministic fallback: the structured summary already contains every name,
        // rate, profile URL, and specialty. This is what we send if the LLM intro is
        // empty OR drops any caregiver's name or tappable profile link — a family making
        // a high-stakes decision must never receive a name-less, link-less message.
        const deterministicIntro = `I found ${matchData.length} caregiver${matchData.length > 1 ? "s" : ""} for ${seniorName}:\n\n` +
            `${matchSummary}\n\n` +
            `Which ones would you like to meet?`;
        const introComplete = !!introMessage &&
            matchData.every(m => introMessage.includes(m.name) && introMessage.includes(m.profileUrl));
        if (!introComplete && introMessage) {
            console.warn("[matchingAgent] LLM intro dropped a name/profile URL — sending deterministic summary instead", { phone });
        }
        const finalIntro = introComplete ? introMessage : deterministicIntro;
        const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("./caraAgent")));
        await sendViaInteractionAgent(phone, {
            content: finalIntro,
            urgency: "immediate",
            sourceAgent: "matching",
            canDrop: false,
        });
        // Store match list in session for follow-up; embed active goal context so
        // interview selection can pre-populate booking dates without re-prompting the family
        const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
        const goalContext = ((_x = (_w = sessionSnap2.data()) === null || _w === void 0 ? void 0 : _w.activeGoal) === null || _x === void 0 ? void 0 : _x.type) === "booking"
            ? sessionSnap2.data().activeGoal.context
            : null;
        await db.collection("agent_sessions").doc(phone).update({
            pendingMatches: top3.map((c, i) => (Object.assign({ id: c.id, name: c.name, rate: c.hourlyRate, matchScore: top3Scores[i], agentId }, (goalContext ? { goalContext } : {})))),
            // Used by webhooks.ts to detect stale state — selection prompts older
            // than 2 hours are treated as expired and cleared on next inbound.
            pendingMatchesSetAt: new Date().toISOString(),
        });
    }
    catch (err) {
        console.error("runMatchingForClient error:", err);
        await (0, client_1.sendMessage)(chatId, "I'm searching for caregivers — I'll text you top matches within the hour.");
    }
}
//# sourceMappingURL=matchingAgent.js.map