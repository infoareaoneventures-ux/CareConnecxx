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
const db = admin.firestore();
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