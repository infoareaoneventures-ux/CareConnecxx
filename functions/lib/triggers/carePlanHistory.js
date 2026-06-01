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
exports.onCarePlanWrite = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
// Save a version of the care plan every time it changes
exports.onCarePlanWrite = functions.firestore
    .document("senior_profiles/{seniorId}/care_plans/{planId}")
    .onWrite(async (change, context) => {
    var _a;
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    if (!before || !after)
        return; // skip create and delete
    if (JSON.stringify(before) === JSON.stringify(after))
        return; // no change
    const { seniorId } = context.params;
    await db.collection("senior_profiles").doc(seniorId)
        .collection("carePlanVersions").add({
        carePlan: before,
        savedAt: new Date().toISOString(),
        changedBy: (_a = after.lastUpdatedBy) !== null && _a !== void 0 ? _a : "unknown",
        summary: buildChangeSummary(before, after),
    });
});
function buildChangeSummary(before, after) {
    const changes = [];
    const fields = ["medications", "careNeeds", "dietaryNotes", "doctorContacts", "specialInstructions"];
    for (const field of fields) {
        const bVal = JSON.stringify(before[field]);
        const aVal = JSON.stringify(after[field]);
        if (bVal !== aVal)
            changes.push(field.replace(/([A-Z])/g, " $1").toLowerCase());
    }
    return changes.length ? `Updated: ${changes.join(", ")}` : "Care plan updated";
}
//# sourceMappingURL=carePlanHistory.js.map