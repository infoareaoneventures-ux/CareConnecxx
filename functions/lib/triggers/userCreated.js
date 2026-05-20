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
exports.onUserCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const db = admin.firestore();
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
    var _a, _b, _c, _d;
    try {
        // Load user profile — clients write to 'users', caregivers to 'caregivers'
        const userDoc = await db.collection("users").doc(user.uid).get();
        const data = userDoc.data();
        // Only create iMessage threads for clients with a phone number
        if (!(data === null || data === void 0 ? void 0 : data.phone) || (data === null || data === void 0 ? void 0 : data.userType) !== "client")
            return;
        const phone = data.phone;
        // Don't create duplicate sessions
        const existing = await db.collection("agent_sessions").doc(phone).get();
        if (existing.exists)
            return;
        const capability = await (0, client_1.checkCapability)(phone);
        const service = capability.iMessage
            ? "iMessage"
            : capability.RCS
                ? "RCS"
                : "SMS";
        const firstName = (_c = (_a = data.firstName) !== null && _a !== void 0 ? _a : (_b = data.name) === null || _b === void 0 ? void 0 : _b.split(" ")[0]) !== null && _c !== void 0 ? _c : "there";
        // TCPA: first message must request consent — no care data sent until user replies YES
        const optInText = `Hi ${firstName} — I'm Cara, your AI care assistant.\n\n` +
            `Reply YES to receive real-time care updates — visit summaries, wellness alerts, ` +
            `and health signals for your loved one.\n\n` +
            `Reply STOP anytime to opt out. Msg & data rates may apply.`;
        const chat = await (0, client_1.createChat)(phone, {
            parts: [{ type: "text", value: optInText }],
        });
        // Register Cara as a named contact so users see "Cara" not a raw number
        await (0, client_1.createOrUpdateContactCard)({
            phone_number: (_d = process.env.LINQ_PHONE_NUMBER) !== null && _d !== void 0 ? _d : "",
            first_name: "Cara",
            last_name: "CareConnex",
        });
        await (0, client_1.shareContactCard)(chat.chat_id).catch(() => { });
        const session = {
            chatId: chat.chat_id,
            userId: user.uid,
            seniorId: user.uid, // seniorId === clientId for single-senior households
            service,
            optedOut: false,
            optedIn: false, // pending — wait for YES reply
            createdAt: new Date().toISOString(),
        };
        await db.collection("agent_sessions").doc(phone).set(session);
        console.log(`agent_sessions created for ${user.uid} (${service})`);
    }
    catch (err) {
        // Never throw from auth triggers — it blocks user creation
        console.error("onUserCreated Linq error:", err);
    }
});
//# sourceMappingURL=userCreated.js.map