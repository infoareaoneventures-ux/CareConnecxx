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
exports.createFamilyGroup = void 0;
exports.buildOrUpdateFamilyGroup = buildOrUpdateFamilyGroup;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const db = admin.firestore();
// ── Callable: triggered from FamilyManager UI ─────────────────────────────────
exports.createFamilyGroup = functions.https.onCall(async (data, context) => {
    var _a, _b;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
    }
    const seniorId = (_a = data.seniorId) !== null && _a !== void 0 ? _a : context.auth.uid;
    try {
        await buildOrUpdateFamilyGroup(seniorId);
        return { success: true };
    }
    catch (err) {
        console.error("createFamilyGroup error:", err);
        throw new functions.https.HttpsError("internal", (_b = err.message) !== null && _b !== void 0 ? _b : "Failed to create group");
    }
});
// ── Core logic (also called when a new member with phone is added) ─────────────
async function buildOrUpdateFamilyGroup(seniorId) {
    var _a, _b, _c, _d;
    // Load senior profile for name + family members
    const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
    const senior = seniorSnap.data();
    if (!senior)
        return;
    const seniorName = (_a = senior.name) !== null && _a !== void 0 ? _a : "Your loved one";
    const familyMembers = (_b = senior.familyMembers) !== null && _b !== void 0 ? _b : [];
    // Collect all phones that have sessions (primary client + family members with phones)
    const primarySnap = await db.collection("users").doc(seniorId).get();
    const primaryPhone = (_c = primarySnap.data()) === null || _c === void 0 ? void 0 : _c.phone;
    const familyPhones = familyMembers
        .map((m) => m.phone)
        .filter((p) => !!p);
    const allPhones = [...new Set([...(primaryPhone ? [primaryPhone] : []), ...familyPhones])];
    if (allPhones.length < 2)
        return; // need at least 2 for a group
    // Check if a group chat already exists for this senior
    const existingSnap = await db
        .collection("family_groups")
        .where("seniorId", "==", seniorId)
        .limit(1)
        .get();
    if (!existingSnap.empty) {
        // Group exists — add any new phones that aren't already in it
        const groupDoc = existingSnap.docs[0];
        const groupData = groupDoc.data();
        const existing = new Set((_d = groupData.phones) !== null && _d !== void 0 ? _d : []);
        const chatId = groupData.chatId;
        for (const phone of allPhones) {
            if (!existing.has(phone)) {
                await (0, client_1.addParticipant)(chatId, phone).catch(() => { });
                await (0, client_1.sendMessage)(chatId, `Welcome to the group! You'll receive care updates here and can text the assistant anytime.`);
                await groupDoc.ref.update({
                    phones: admin.firestore.FieldValue.arrayUnion(phone),
                });
            }
        }
        return;
    }
    // Create new group chat — first phone initiates, rest join
    const [firstPhone, ...rest] = allPhones;
    const groupChat = await (0, client_1.createChat)(firstPhone, {
        parts: [{
                type: "text",
                value: `Hi everyone — I'm Cara, the AI care assistant for ${seniorName}'s care.\n\n` +
                    `I'll send care updates here so everyone stays in the loop. ` +
                    `Anyone can text me questions anytime.`,
            }],
        effect: { type: "screen", name: "hearts" },
    });
    const chatId = groupChat.chat_id;
    // Add remaining family members
    for (const phone of rest) {
        await (0, client_1.addParticipant)(chatId, phone).catch(() => { });
    }
    // Name the group
    await (0, client_1.updateChatName)(chatId, `${seniorName.split(" ")[0]}'s Care · Cara`);
    // Persist group record
    await db.collection("family_groups").add({
        seniorId,
        chatId,
        phones: allPhones,
        createdAt: new Date().toISOString(),
    });
    // Update each participant's agent_session with the group chatId
    for (const phone of allPhones) {
        await db
            .collection("agent_sessions")
            .doc(phone)
            .set({ groupChatId: chatId }, { merge: true });
    }
}
//# sourceMappingURL=familyGroupManager.js.map