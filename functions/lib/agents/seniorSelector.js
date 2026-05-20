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
exports.getSeniorsForClient = getSeniorsForClient;
exports.formatSeniorSelectionMessage = formatSeniorSelectionMessage;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * Returns all seniors for a given client.
 * Tries the new model first (senior_profiles.clientId == clientId),
 * then falls back to the old 1:1 model (senior_profiles/{clientId}).
 */
async function getSeniorsForClient(clientId) {
    var _a, _b, _c;
    // New model: query by clientId field
    const snap = await db.collection("senior_profiles")
        .where("clientId", "==", clientId)
        .limit(10)
        .get();
    if (!snap.empty) {
        return snap.docs.map(d => {
            var _a;
            return ({
                seniorId: d.id,
                name: (_a = d.data().name) !== null && _a !== void 0 ? _a : "Unknown",
                age: d.data().age,
            });
        });
    }
    // Old model fallback: clientId === seniorId
    const single = await db.collection("senior_profiles").doc(clientId).get();
    if (single.exists) {
        return [{
                seniorId: clientId,
                name: (_b = (_a = single.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "Unknown",
                age: (_c = single.data()) === null || _c === void 0 ? void 0 : _c.age,
            }];
    }
    return [];
}
/**
 * Returns a prompt asking the client which senior this conversation is about,
 * or an empty string if there's only one senior (no selection needed).
 */
function formatSeniorSelectionMessage(seniors) {
    if (seniors.length === 0) {
        return "I don't have a senior profile on file yet. Can you tell me who I'll be helping care for?";
    }
    if (seniors.length === 1) {
        return "";
    }
    const list = seniors
        .map((s, i) => `${i + 1}. ${s.name}${s.age ? ` (${s.age})` : ""}`)
        .join("\n");
    return `Who is this for?\n${list}`;
}
//# sourceMappingURL=seniorSelector.js.map