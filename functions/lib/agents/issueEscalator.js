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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIssue = classifyIssue;
exports.handleCaregiverIssue = handleCaregiverIssue;
exports.escalateIssue = escalateIssue;
exports.escalateIssueFinal = escalateIssueFinal;
exports.resolveIssue = resolveIssue;
exports.sendIssueFollowUp = sendIssueFollowUp;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("./caraAgent");
const client_1 = require("../linq/client");
const db = admin.firestore();
// Fast keyword pre-check before Claude call
const EMERGENCY_KEYWORDS = [
    /\b(fell|fall|fallen|on the floor|found on floor)\b/i,
    /\b(not breathing|unresponsive|unconscious|passed out)\b/i,
    /\b(chest pain|heart attack|stroke|seizure|choking)\b/i,
    /\b(heavy bleeding|won't stop bleeding|deep cut)\b/i,
];
async function classifyIssue(text) {
    var _a, _b, _c, _d, _e, _f, _g;
    // Fast path: check emergency keywords
    if (EMERGENCY_KEYWORDS.some(r => r.test(text))) {
        return {
            type: text.toLowerCase().includes("fell") || text.toLowerCase().includes("floor") ? "fall" : "medical",
            severity: "critical",
            is911: true,
            summary: "Potential emergency situation reported",
        };
    }
    const client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
        const resp = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            system: 'You are a care coordinator reviewing an issue from a caregiver. Classify it. Reply JSON only:\n' +
                '{"type":"fall|medical|behavioral|environment|other","severity":"routine|urgent|critical","is911":false,"summary":"one sentence for family"}\n' +
                'type: fall=falling/slipping/floor, medical=chest pain/breathing/unresponsive/seizure, behavioral=agitation/confusion/refusal, environment=unsafe/gas/equipment, other=anything else\n' +
                'severity: routine=worth noting, urgent=needs follow-up today, critical=possible emergency\n' +
                'is911: true ONLY for unresponsive/not breathing/chest pain/severe fall with injury/heavy bleeding',
            messages: [{ role: "user", content: text }],
        });
        const raw = (_a = resp.content[0].text) !== null && _a !== void 0 ? _a : "{}";
        const parsed = JSON.parse((_c = (_b = raw.match(/\{[\s\S]*\}/)) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : "{}");
        return {
            type: (_d = parsed.type) !== null && _d !== void 0 ? _d : "other",
            severity: (_e = parsed.severity) !== null && _e !== void 0 ? _e : "routine",
            is911: (_f = parsed.is911) !== null && _f !== void 0 ? _f : false,
            summary: (_g = parsed.summary) !== null && _g !== void 0 ? _g : text.slice(0, 100),
        };
    }
    catch (_h) {
        return { type: "other", severity: "routine", is911: false, summary: text.slice(0, 100) };
    }
}
async function handleCaregiverIssue(params) {
    const { caregiverId, caregiverPhone, caregiverName, appointmentId, clientId, clientPhone, seniorId, seniorName, description } = params;
    const now = new Date().toISOString();
    const classification = await classifyIssue(description);
    if (classification.is911) {
        // Emergency path — bypass DND, send immediately
        await (0, caraAgent_1.sendViaInteractionAgent)(caregiverPhone, {
            content: "If the situation is life-threatening, call 911 immediately. I'm notifying the family now.",
            urgency: "immediate",
            sourceAgent: "issue_escalator",
            canDrop: false,
        });
        if (clientPhone) {
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: `${caregiverName} reported an emergency with ${seniorName}. If this is life-threatening, call 911 immediately. I'm reaching out to you now.`,
                urgency: "immediate",
                sourceAgent: "issue_escalator",
                canDrop: false,
            });
        }
        await db.collection("admin_alerts").add({
            type: "caregiver_issue_911",
            caregiverId,
            clientId,
            appointmentId,
            description,
            issueType: classification.type,
            priority: "critical",
            createdAt: now,
            resolved: false,
        });
        return; // No escalation schedule for 911 — direct path
    }
    // Non-911 path
    const familyMsg = classification.severity === "urgent"
        ? `${caregiverName} flagged a concern during today's visit with ${seniorName}: ${classification.summary}. Our team is aware. Reply with any questions.`
        : `Quick note from ${caregiverName} — ${classification.summary}. Nothing urgent, wanted to keep you informed.`;
    if (clientPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: familyMsg,
            urgency: classification.severity === "urgent" ? "immediate" : "standard",
            sourceAgent: "issue_escalator",
            canDrop: false,
        });
    }
    // Write issue_log
    const issueLogRef = await db.collection("issue_log").add({
        appointmentId,
        caregiverId,
        caregiverName,
        clientId,
        clientPhone,
        seniorId,
        seniorName,
        description,
        type: classification.type,
        severity: classification.severity,
        is911: false,
        familyNotifiedAt: now,
        escalationLevel: 0,
        resolvedAt: null,
        followUpSentAt: null,
        createdAt: now,
    });
    // Write admin_alerts
    await db.collection("admin_alerts").add({
        type: "caregiver_issue",
        caregiverId,
        clientId,
        appointmentId,
        issueLogId: issueLogRef.id,
        description,
        issueType: classification.type,
        severity: classification.severity,
        createdAt: now,
        resolved: false,
        priority: classification.severity === "urgent" ? "high" : "medium",
    });
    // Schedule 30-min escalation trigger if urgent
    if (classification.severity === "urgent" || classification.severity === "critical") {
        await db.collection("proactive_triggers").add({
            userId: clientId,
            phone: clientPhone,
            type: "custom",
            scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            message: `issue_escalation:${issueLogRef.id}`,
            createdAt: now,
            firedAt: null,
            cancelledAt: null,
        });
    }
    // Always schedule 20h follow-up
    await db.collection("proactive_triggers").add({
        userId: clientId,
        phone: clientPhone,
        type: "custom",
        scheduledAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
        message: `issue_followup:${issueLogRef.id}`,
        createdAt: now,
        firedAt: null,
        cancelledAt: null,
    });
}
async function escalateIssue(issueLogId) {
    var _a, _b, _c, _d, _e, _f;
    const snap = await db.collection("issue_log").doc(issueLogId).get();
    if (!snap.exists)
        return;
    const issue = snap.data();
    if (issue.resolvedAt)
        return;
    if (issue.escalationLevel >= 2)
        return;
    // Check if family replied after familyNotifiedAt
    const replied = await db.collection("agent_conversations")
        .doc((_a = issue.clientPhone) !== null && _a !== void 0 ? _a : "")
        .collection("messages")
        .where("role", "==", "user")
        .where("timestamp", ">=", new Date(issue.familyNotifiedAt).getTime())
        .limit(1)
        .get();
    if (!replied.empty) {
        // Family responded — no escalation needed
        await snap.ref.update({ escalationLevel: 1, familyReplied: true });
        return;
    }
    // Family hasn't responded — contact emergency contact
    const seniorSnap = await db.collection("senior_profiles").doc((_b = issue.seniorId) !== null && _b !== void 0 ? _b : "").get();
    const ecPhone = (_d = (_c = seniorSnap.data()) === null || _c === void 0 ? void 0 : _c.emergencyContact) === null || _d === void 0 ? void 0 : _d.phone;
    const seniorName = (_e = issue.seniorName) !== null && _e !== void 0 ? _e : "your loved one";
    if (ecPhone && ecPhone !== issue.clientPhone) {
        await (0, client_1.sendToPhone)(ecPhone, `Hi — I'm Cara, the AI care assistant for ${seniorName}. ` +
            `${(_f = issue.caregiverName) !== null && _f !== void 0 ? _f : "A caregiver"} flagged a concern during today's visit. ` +
            `The primary contact hasn't responded in 30 minutes. ` +
            `Please reach out to them or contact the care team directly.`);
    }
    else if (!ecPhone) {
        // No emergency contact on file — log admin alert and ask family to provide one
        await db.collection("admin_alerts").add({
            type: "missing_emergency_contact",
            issueLogId,
            clientId: issue.clientId,
            seniorId: issue.seniorId,
            priority: "high",
            resolved: false,
            createdAt: new Date().toISOString(),
        });
        if (issue.clientPhone) {
            await (0, client_1.sendToPhone)(issue.clientPhone, `I tried to reach your emergency contact but don't have their info on file. ` +
                `Please reply with their name and phone number so I can add them.`);
            // Set session flag so the next reply from the family is captured
            const sessionSnap = await db.collection("agent_sessions")
                .where("phone", "==", issue.clientPhone)
                .limit(1)
                .get();
            if (!sessionSnap.empty) {
                await sessionSnap.docs[0].ref.update({
                    awaitingEmergencyContactUpdate: true,
                }).catch(() => { });
            }
            else {
                // Fallback: session doc keyed directly by phone
                await db.collection("agent_sessions").doc(issue.clientPhone).set({ awaitingEmergencyContactUpdate: true }, { merge: true });
            }
        }
    }
    await snap.ref.update({ escalationLevel: 2 });
    // Schedule final escalation at +90min
    await db.collection("proactive_triggers").add({
        userId: issue.clientId,
        phone: issue.clientPhone,
        type: "custom",
        scheduledAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        message: `issue_escalation_final:${issueLogId}`,
        createdAt: new Date().toISOString(),
        firedAt: null,
        cancelledAt: null,
    });
}
async function escalateIssueFinal(issueLogId) {
    const snap = await db.collection("issue_log").doc(issueLogId).get();
    if (!snap.exists)
        return;
    const issue = snap.data();
    if (issue.resolvedAt)
        return;
    await db.collection("admin_alerts").add({
        type: "issue_unacknowledged",
        issueLogId,
        clientId: issue.clientId,
        caregiverId: issue.caregiverId,
        seniorId: issue.seniorId,
        severity: "critical",
        priority: "critical",
        createdAt: new Date().toISOString(),
        resolved: false,
    });
    await snap.ref.update({ escalationLevel: 3 });
}
// ── Resolve an issue — cancels pending escalation triggers ───────────────────
// Call this when caregiver replies YES to the closure check, or admin marks resolved.
async function resolveIssue(issueLogId, resolvedBy, note) {
    const ref = db.collection("issue_log").doc(issueLogId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().resolvedAt)
        return; // Already resolved
    await ref.update({
        resolvedAt: new Date().toISOString(),
        resolvedBy,
        resolutionNote: note !== null && note !== void 0 ? note : null,
    });
    // Pending escalation triggers gate on resolvedAt — no separate cancellation needed.
    console.info(`[resolveIssue] ${issueLogId} resolved by ${resolvedBy}`);
}
async function sendIssueFollowUp(issueLogId) {
    var _a;
    const snap = await db.collection("issue_log").doc(issueLogId).get();
    if (!snap.exists)
        return;
    const issue = snap.data();
    if (issue.resolvedAt || issue.followUpSentAt)
        return;
    const seniorName = (_a = issue.seniorName) !== null && _a !== void 0 ? _a : "your loved one";
    // Message to family
    if (issue.clientPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(issue.clientPhone, {
            content: `Just checking in — how is ${seniorName} doing today after yesterday's concern?\n\nEverything okay?`,
            urgency: "standard",
            sourceAgent: "issue_followup",
            canDrop: false,
        });
    }
    // Closure check to caregiver
    if (issue.caregiverPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(issue.caregiverPhone, {
            content: "Quick check-in: was the concern from yesterday's visit resolved? Reply YES if everything's okay, or give me an update if not.",
            urgency: "standard",
            sourceAgent: "issue_followup",
            canDrop: false,
        });
        // Set closure check flag
        await db.collection("agent_sessions").doc(issue.caregiverPhone).update({
            awaitingIssueClosureCheck: issueLogId,
        }).catch(() => { });
    }
    await snap.ref.update({ followUpSentAt: new Date().toISOString() });
}
//# sourceMappingURL=issueEscalator.js.map