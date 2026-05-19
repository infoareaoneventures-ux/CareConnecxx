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
exports.getPermissions = getPermissions;
exports.sendClientPermissionsFlow = sendClientPermissionsFlow;
exports.handleClientPermissionsReply = handleClientPermissionsReply;
exports.sendCaregiverPermissionsFlow = sendCaregiverPermissionsFlow;
exports.handleCaregiverPermissionsReply = handleCaregiverPermissionsReply;
exports.updatePermissionFromText = updatePermissionFromText;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function askClaude(system, userText) {
    var _a;
    try {
        const res = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001", max_tokens: 100,
            system, messages: [{ role: "user", content: userText }],
        });
        return ((_a = res.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (_b) {
        return "__error__";
    }
}
const db = admin.firestore();
// ── Read helper — used by action handlers to check before acting ──────────────
async function getPermissions(userId) {
    const snap = await db.collection("agent_permissions").doc(userId).get();
    if (!snap.exists)
        return null;
    return snap.data();
}
async function setPermissions(phone, userId, userType, perms) {
    const ref = db.collection("agent_permissions").doc(userId);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : {};
    await ref.set(Object.assign(Object.assign(Object.assign({}, existing), perms), { userId,
        userType, updatedAt: new Date().toISOString() }));
    // Track last permissions question in session
    await db.collection("agent_sessions").doc(phone).update({
        permissionsStep: perms,
    }).catch(() => { });
}
// ── CLIENT permissions flow ───────────────────────────────────────────────────
async function sendClientPermissionsFlow(phone, chatId, session) {
    var _a, _b;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await db.collection("agent_sessions").doc(phone).update({
        onboardingStep: "client_permissions_contact",
        permissionsContext: "client",
    });
    await (0, client_1.sendMessage)(chatId, `I'm already searching for caregivers for ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one"}.\n\n` +
        `Before I send you matches, two quick questions so I know how to best help you.\n\n` +
        `Can I reach out to caregivers on your behalf to schedule interviews once you select someone?\n\n` +
        `Reply YES or NO`);
}
async function handleClientPermissionsReply(phone, chatId, text, session, userId) {
    var _a;
    const norm = text.trim().toUpperCase();
    const step = (_a = session.onboardingStep) !== null && _a !== void 0 ? _a : "";
    const isYes = norm === "YES" || norm === "Y";
    if (step === "client_permissions_contact") {
        await setPermissions(phone, userId, "client", {
            canContactCaregivers: isYes,
            canScheduleInterviews: isYes,
        });
        await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "client_permissions_booking" });
        await (0, client_1.sendMessage)(chatId, `Got it.\n\n` +
            `Once you've approved a caregiver after an interview, can I book their first visits for you?\n` +
            `I'll always show you exactly what I'm booking and wait for your confirmation before anything is scheduled.\n\n` +
            `Reply YES or NO`);
        return;
    }
    if (step === "client_permissions_booking") {
        await setPermissions(phone, userId, "client", {
            canBookWithConfirmation: isYes,
            canCancelWithConfirmation: isYes,
            canSendWeeklyDigest: true,
            canSendHealthAlerts: true,
        });
        await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "client_permissions_autobook" });
        await (0, client_1.sendMessage)(chatId, `Got it.\n\n` +
            `One more thing — for recurring visits with a caregiver you've already approved, ` +
            `can I go ahead and book automatically without checking each time?\n\n` +
            `1️⃣ Yes, book automatically\n` +
            `2️⃣ No, always ask me first`);
        return;
    }
    if (step === "client_permissions_autobook") {
        await setPermissions(phone, userId, "client", {
            canBookAutomatically: isYes,
        });
        await db.collection("agent_sessions").doc(phone).update({
            onboardingStep: "complete",
            optedIn: true,
        });
        await (0, client_1.sendMessage)(chatId, `Perfect. I'll handle all the coordination${isYes ? " and book automatically" : " — you make the final calls"}.\n\n` +
            `I'm still searching for caregivers — I'll text you the top matches within the hour.\n\n` +
            `Questions? Just text me anytime.`);
        // Kick off matching
        const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("./matchingAgent")));
        const intakeSnap = await db.collection("clientIntakes")
            .where("phone", "==", phone)
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
        if (!intakeSnap.empty) {
            const intake = intakeSnap.docs[0].data();
            runMatchingForClient(phone, chatId, intake).catch((err) => console.error("runMatchingForClient error:", err));
        }
        return;
    }
}
// ── CAREGIVER permissions flow ─────────────────────────────────────────────────
async function sendCaregiverPermissionsFlow(phone, chatId, _session, caregiverName) {
    await db.collection("agent_sessions").doc(phone).update({
        onboardingStep: "caregiver_permissions_decline",
    });
    await (0, client_1.sendMessage)(chatId, `A couple of quick questions so I can work best for you, ${caregiverName}:\n\n` +
        `Can I automatically decline job requests that are outside your stated availability?\n` +
        `(Saves you time on requests you can't take)\n\n` +
        `Reply YES or NO`);
}
async function handleCaregiverPermissionsReply(phone, chatId, text, session, caregiverId) {
    var _a, _b, _c;
    const norm = text.trim().toUpperCase();
    const step = (_a = session.onboardingStep) !== null && _a !== void 0 ? _a : "";
    const isYes = norm === "YES" || norm === "Y";
    const d = (_b = session.onboardingData) !== null && _b !== void 0 ? _b : {};
    if (step === "caregiver_permissions_decline") {
        await setPermissions(phone, caregiverId, "caregiver", {
            canDeclineJobsAutomatically: isYes,
        });
        await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "caregiver_permissions_arrival" });
        await (0, client_1.sendMessage)(chatId, `Got it.\n\n` +
            `When you arrive at a client's home, want me to automatically notify the family?\n` +
            `They love knowing their caregiver has arrived.\n\n` +
            `Reply YES or NO`);
        return;
    }
    if (step === "caregiver_permissions_arrival") {
        await setPermissions(phone, caregiverId, "caregiver", {
            canSendArrivalNotifications: isYes,
            canShareJournalWithFamily: true,
            canAcceptJobsWithConfirmation: true,
        });
        await db.collection("agent_sessions").doc(phone).update({
            onboardingStep: "complete",
            optedIn: true,
        });
        const appUrl = (_c = process.env.APP_URL) !== null && _c !== void 0 ? _c : "https://cara.app";
        const name = d.name ? `, ${d.name}` : "";
        const city = d.city ? ` in ${d.city}` : "";
        await (0, client_1.sendMessage)(chatId, `You're all set${name}! 🎉\n\n` +
            `Your profile is live and you're ready to be matched with families${city}.\n\n` +
            `When a family needs someone with your skills, I'll text you the job details — ` +
            `including the care plan and directions before every visit.\n\n` +
            `View your profile: ${appUrl}/caregiver/${caregiverId}`);
        // Notify admin for final review
        await db.collection("admin_alerts").add({
            type: "caregiver_pending_review",
            caregiverId,
            name: d.name,
            phone,
            createdAt: new Date().toISOString(),
            resolved: false,
        });
        return;
    }
}
// ── Permission updates via text ───────────────────────────────────────────────
async function updatePermissionFromText(userId, userType, phone, chatId, text) {
    var _a, _b, _c;
    const permOptions = userType === "client"
        ? "canSendWeeklyDigest (weekly summaries/digest), canSendHealthAlerts (health alerts), canBookAutomatically (auto-booking)"
        : "canDeclineJobsAutomatically (auto-decline jobs), canSendArrivalNotifications (arrival notifications), canShareJournalWithFamily (share journal with family)";
    const raw = await askClaude(`The user is changing a notification or feature permission. ` +
        `Available permissions for a ${userType}: ${permOptions}. ` +
        `Determine: (1) which permission they mean, (2) whether they want to enable or disable it. ` +
        `Reply in JSON: {"permission":"<permissionKey>","action":"enable|disable"}. ` +
        `If the message is not a permission change request, reply with the literal word: none`, text);
    if (raw === "__error__" || raw === "none" || !raw.startsWith("{"))
        return;
    let permission, action;
    try {
        const parsed = JSON.parse(raw);
        permission = (_a = parsed.permission) !== null && _a !== void 0 ? _a : "";
        action = (_b = parsed.action) !== null && _b !== void 0 ? _b : "";
    }
    catch (_d) {
        return;
    }
    const validPerms = [
        "canSendWeeklyDigest", "canSendHealthAlerts", "canBookAutomatically",
        "canDeclineJobsAutomatically", "canSendArrivalNotifications", "canShareJournalWithFamily",
    ];
    const matched = validPerms.find(p => p === permission);
    if (!matched || (action !== "enable" && action !== "disable"))
        return;
    const newVal = action === "enable";
    const ref = db.collection("agent_permissions").doc(userId);
    await ref.set({ [matched]: newVal, updatedAt: new Date().toISOString() }, { merge: true });
    const friendly = {
        canSendWeeklyDigest: "weekly summaries",
        canSendHealthAlerts: "health alerts",
        canBookAutomatically: "automatic booking",
        canDeclineJobsAutomatically: "auto-declining jobs outside your availability",
        canSendArrivalNotifications: "arrival notifications",
        canShareJournalWithFamily: "sharing journal entries with families",
    };
    const label = (_c = friendly[matched]) !== null && _c !== void 0 ? _c : matched;
    if (!newVal) {
        await (0, client_1.sendMessage)(chatId, `Got it. No more ${label}. Just text me if you change your mind.`);
    }
    else {
        const resumeLabel = label.includes("book") ? "asking before booking" : `sending ${label} again`;
        await (0, client_1.sendMessage)(chatId, `Sure thing. I'll go back to ${resumeLabel}.`);
    }
}
//# sourceMappingURL=permissionsConversation.js.map