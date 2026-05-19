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
exports.triggerFamilyEmergency = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
exports.triggerFamilyEmergency = functions.https.onCall(async (data, context) => {
    var _a, _b, _c;
    if (!((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid)) {
        throw new functions.https.HttpsError("unauthenticated", "Login required");
    }
    const { appointmentId } = data;
    const clientId = context.auth.uid;
    if (!appointmentId) {
        throw new functions.https.HttpsError("invalid-argument", "appointmentId is required");
    }
    // HIPAA audit log
    await db.collection("emergency_events").add({
        type: "family_panic",
        clientId,
        appointmentId,
        triggeredAt: new Date().toISOString(),
        triggeredBy: clientId,
    });
    // Get appointment details
    const apptSnap = await db.collection("appointments").doc(appointmentId).get();
    const appt = apptSnap.data();
    if (!appt) {
        throw new functions.https.HttpsError("not-found", "Appointment not found");
    }
    // Alert the caregiver
    if (appt.caregiverPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(appt.caregiverPhone, {
            content: `🚨 EMERGENCY: The family needs immediate help. ` +
                `Please check on ${(_b = appt.seniorName) !== null && _b !== void 0 ? _b : "the client"} right away and call 911 if needed.`,
            urgency: "immediate",
            sourceAgent: "emergency_replacement",
            canDrop: false,
        });
    }
    // Open admin alert for on-call team
    await db.collection("admin_alerts").add({
        type: "family_emergency",
        clientId,
        appointmentId,
        caregiverId: (_c = appt.caregiverId) !== null && _c !== void 0 ? _c : null,
        createdAt: new Date().toISOString(),
        resolved: false,
        severity: "critical",
    });
    return { success: true };
});
//# sourceMappingURL=familyEmergency.js.map