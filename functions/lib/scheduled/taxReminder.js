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
exports.send1099Notifications = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const taxDocuments_1 = require("../billing/taxDocuments");
const client_1 = require("../linq/client");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Runs Jan 31 — notify eligible caregivers about their 1099 summary
exports.send1099Notifications = functions.pubsub
    .schedule("0 9 31 1 *") // Jan 31 at 9am
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a;
    const year = new Date().getFullYear() - 1;
    const caregiverSnap = await db.collection("caregivers")
        .where("verified", "==", true)
        .limit(500)
        .get();
    console.log(`[send1099Notifications] Processing ${caregiverSnap.size} caregivers for tax year ${year}`);
    for (const cgDoc of caregiverSnap.docs) {
        const cg = cgDoc.data();
        if (!cg.chatId && !cg.phone)
            continue;
        try {
            const summary = await (0, taxDocuments_1.getCaregiverTaxSummary)(cgDoc.id, year);
            if (!summary.eligibleFor1099)
                continue;
            const chatId = (_a = cg.chatId) !== null && _a !== void 0 ? _a : cg.phone;
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: `The caregiver's ${year} tax summary is ready. ` +
                    `They earned $${summary.totalEarnings.toFixed(2)} across ${summary.visitCount} visits and may receive a 1099-NEC. ` +
                    `Let them know their tax summary is ready and that they can text "tax summary" for the full breakdown. ` +
                    "Keep the tone positive and informative — this is good news about their hard work.",
                fallback: `Your ${year} tax summary is ready! You earned $${summary.totalEarnings.toFixed(2)} ` +
                    `across ${summary.visitCount} visits. You may receive a 1099-NEC. ` +
                    `Text "tax summary" for your full breakdown.`,
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, msg);
            console.log(`[send1099Notifications] Notified ${cgDoc.id} — $${summary.totalEarnings}`);
        }
        catch (e) {
            console.error(`[send1099Notifications] Failed for ${cgDoc.id}:`, e);
        }
    }
});
//# sourceMappingURL=taxReminder.js.map