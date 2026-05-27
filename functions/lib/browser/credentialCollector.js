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
exports.PORTAL_CONFIG = void 0;
exports.startCredentialCollection = startCredentialCollection;
exports.handleCredentialReply = handleCredentialReply;
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const credentialVault_1 = require("./credentialVault");
const openaiClient_1 = require("../utils/openaiClient");
const db = admin.firestore();
// Conservative classifier for credential capture. If the user replies with a
// question or worry instead of a credential, we MUST NOT store the text — a
// password field is the worst possible place to accidentally write "is this
// safe?". When in doubt, treat as a question; the cost of a false positive is
// re-asking the credential, but a false negative leaks PII into the vault.
async function isCredentialReply(text, step, portalName) {
    const trimmed = text.trim();
    if (!trimmed)
        return false;
    // Question-mark or interrogative opener — never a credential.
    if (trimmed.endsWith("?"))
        return false;
    if (/^\s*(why|how|what|is\s+(this|that|it)|are\s+you|can\s+you|do\s+you|will\s+you|should\s+i|where|when|who)\b/i.test(trimmed)) {
        return false;
    }
    // Multi-sentence input is almost certainly a question or worry, not a credential.
    if (/[.?!]\s+\S/.test(trimmed))
        return false;
    try {
        const result = await (0, openaiClient_1.quickComplete)(`The user was just asked for their ${portalName} ${step}. Reply YES if their message looks like a ` +
            `${step} (a plausible username/email or a password — single token, no sentences). ` +
            "Reply NO if it is a question, a worry, a refusal, a request to cancel, or any conversational sentence. " +
            "When in doubt, reply NO.", trimmed, { maxTokens: 5 });
        return result.trim().toUpperCase().startsWith("Y");
    }
    catch (_a) {
        // Fail closed — treat as not-a-credential. Re-asking is safe; storing junk is not.
        return false;
    }
}
async function answerCredentialQuestion(text, portalName) {
    try {
        return await (0, openaiClient_1.quickComplete)(`You are Cara, an AI care assistant. A family member was just asked for their ${portalName} login ` +
            "so you can take an action on their behalf. They asked a question or expressed hesitation instead. " +
            "Answer briefly (1–2 sentences). Reassure them that the credential is encrypted at rest, only used " +
            "for the action they requested, and can be deleted anytime by replying " +
            `"remove my ${portalName} login". Do NOT ask for the credential — that prompt comes separately.`, text, { maxTokens: 180 });
    }
    catch (_a) {
        return `Your ${portalName} login is encrypted and only used when you ask me to do something on that site. ` +
            `You can remove it anytime by saying "remove my ${portalName} login".`;
    }
}
// Human-readable names and login URLs for each portal service
exports.PORTAL_CONFIG = {
    mychart: { name: "MyChart", url: "https://mychart.com", usernameLabel: "MyChart username or email" },
    athenahealth: { name: "athenahealth", url: "https://www.athenahealth.com/patients", usernameLabel: "athenahealth username or email" },
    followmyhealth: { name: "FollowMyHealth", url: "https://www.followmyhealth.com", usernameLabel: "FollowMyHealth email" },
    cvs: { name: "CVS", url: "https://www.cvs.com/account/login", usernameLabel: "CVS.com email" },
    walgreens: { name: "Walgreens", url: "https://www.walgreens.com/login", usernameLabel: "Walgreens email" },
    riteaid: { name: "Rite Aid", url: "https://www.riteaid.com/account/login", usernameLabel: "Rite Aid email" },
    caremark: { name: "CVS Caremark", url: "https://www.caremark.com", usernameLabel: "Caremark username or email" },
    express_scripts: { name: "Express Scripts", url: "https://www.express-scripts.com", usernameLabel: "Express Scripts username" },
    aetna: { name: "Aetna", url: "https://www.aetna.com/individuals-families/member-login.html", usernameLabel: "Aetna member username or email" },
    unitedhealthcare: { name: "UnitedHealthcare", url: "https://www.uhc.com/member-login", usernameLabel: "UHC member username or email" },
    humana: { name: "Humana", url: "https://www.humana.com/member/login", usernameLabel: "Humana member username or email" },
    cigna: { name: "Cigna", url: "https://my.cigna.com/web/public/guest", usernameLabel: "myCigna username or email" },
    medicare: { name: "Medicare", url: "https://www.medicare.gov/account/login", usernameLabel: "Medicare.gov username or email" },
    medicaid: { name: "Medicaid", url: "https://www.medicaid.gov", usernameLabel: "State Medicaid portal username or email" },
};
// ── Start collecting credentials via iMessage ─────────────────────────────────
async function startCredentialCollection(params) {
    const config = exports.PORTAL_CONFIG[params.service];
    await (0, caraAgent_1.sendViaInteractionAgent)(params.phone, {
        content: `To ${params.reason}, I'll need your ${config.name} login.\n\n` +
            `I encrypt and store it securely — you only need to do this once.\n\n` +
            `What's your ${config.usernameLabel}?`,
        urgency: "standard",
        sourceAgent: "credential_collector",
        canDrop: false,
    });
    await db.collection("agent_sessions").doc(params.phone).update({
        collectingCredential: true,
        collectingCredentialService: params.service,
        collectingCredentialStep: "username",
        collectingCredentialReason: params.reason,
    });
}
// ── Handle credential replies from the family ─────────────────────────────────
// Returns true if the message was a credential reply and was handled.
// Call this BEFORE intent classification in webhooks.ts.
async function handleCredentialReply(params) {
    var _a, _b;
    const { phone, userId, text, session } = params;
    if (!session.collectingCredential)
        return false;
    const service = session.collectingCredentialService;
    const step = session.collectingCredentialStep;
    const config = exports.PORTAL_CONFIG[service];
    if (step === "username") {
        if (!(await isCredentialReply(text, "username", config.name))) {
            const answer = await answerCredentialQuestion(text, config.name);
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: answer,
                urgency: "standard",
                sourceAgent: "credential_collector",
                canDrop: false,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `When you're ready — what's your ${config.usernameLabel}?`,
                urgency: "standard",
                sourceAgent: "credential_collector",
                canDrop: false,
            });
            return true;
        }
        await db.collection("agent_sessions").doc(phone).update({
            collectingCredentialUsername: text.trim(),
            collectingCredentialStep: "password",
        });
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: `Got it. Now what's your ${config.name} password?\n\n` +
                `I'll encrypt it immediately.`,
            urgency: "standard",
            sourceAgent: "credential_collector",
            canDrop: false,
        });
        return true;
    }
    if (step === "password") {
        if (!(await isCredentialReply(text, "password", config.name))) {
            const answer = await answerCredentialQuestion(text, config.name);
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: answer,
                urgency: "standard",
                sourceAgent: "credential_collector",
                canDrop: false,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `When you're ready — what's your ${config.name} password?`,
                urgency: "standard",
                sourceAgent: "credential_collector",
                canDrop: false,
            });
            return true;
        }
        const username = (_b = (_a = session.collectingCredentialUsername) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
        const password = text.trim();
        // Encrypt and store — username is never persisted in plaintext after this point
        await (0, credentialVault_1.storeCredential)(userId, service, username, password);
        // Clear ALL credential collection state from session immediately
        await db.collection("agent_sessions").doc(phone).update({
            collectingCredential: false,
            collectingCredentialService: null,
            collectingCredentialStep: null,
            collectingCredentialUsername: null,
            collectingCredentialReason: null,
        });
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: `Done — your ${config.name} login is saved securely.\n\n` +
                `I'll use it whenever you ask me to take action on ${config.name}. ` +
                `Reply "remove my ${config.name} login" anytime to delete it.`,
            urgency: "standard",
            sourceAgent: "credential_collector",
            canDrop: false,
        });
        return true;
    }
    return false;
}
//# sourceMappingURL=credentialCollector.js.map