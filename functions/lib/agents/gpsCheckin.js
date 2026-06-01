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
exports.submitGpsCheckin = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
exports.submitGpsCheckin = functions.https.onCall(async (data, context) => {
    var _a;
    const { caregiverId, appointmentId, latitude, longitude } = data;
    if (!caregiverId || !appointmentId || latitude == null || longitude == null) {
        throw new functions.https.HttpsError("invalid-argument", "caregiverId, appointmentId, latitude, and longitude are required");
    }
    // Get appointment
    const apptSnap = await db.collection("appointments").doc(appointmentId).get();
    if (!apptSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Appointment not found");
    }
    const appt = apptSnap.data();
    // Get client/senior address with lat/lng
    const seniorSnap = await db.collection("senior_profiles").doc(appt.clientId).get();
    const senior = seniorSnap.data();
    const clientLat = senior === null || senior === void 0 ? void 0 : senior.latitude;
    const clientLon = senior === null || senior === void 0 ? void 0 : senior.longitude;
    if (!clientLat || !clientLon) {
        // No GPS on file — create check-in without validation
        await db.collection("shift_checkins").add({
            appointmentId,
            caregiverId,
            caregiverName: appt.caregiverName,
            clientId: appt.clientId,
            checkinAt: new Date().toISOString(),
            status: "arrived",
            gpsProvided: true,
            gpsValidated: false,
            note: "Client address has no GPS coordinates on file",
        });
        return { validated: false, message: "Checked in (address coordinates not on file)." };
    }
    const distanceMeters = haversineDistanceMeters(latitude, longitude, clientLat, clientLon);
    const withinRadius = distanceMeters <= 200;
    const checkinRef = await db.collection("shift_checkins").add({
        appointmentId,
        caregiverId,
        caregiverName: appt.caregiverName,
        clientId: appt.clientId,
        checkinAt: new Date().toISOString(),
        status: withinRadius ? "arrived" : "arrived_offsite",
        gpsProvided: true,
        gpsValidated: withinRadius,
        distanceMeters: Math.round(distanceMeters),
        caregiverLat: latitude,
        caregiverLon: longitude,
    });
    // Notify client
    const clientSnap = await db.collection("users").doc(appt.clientId).get();
    if (clientSnap.exists && ((_a = clientSnap.data()) === null || _a === void 0 ? void 0 : _a.chatId)) {
        const distStr = withinRadius
            ? `${Math.round(distanceMeters)}m from the address`
            : `${Math.round((distanceMeters / 1000) * 10) / 10}km from the address`;
        const arrivedMsg = withinRadius
            ? await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Cara is notifying the family that their caregiver ${appt.caregiverName} just arrived for today's visit with their loved one.`,
                fallback: `${appt.caregiverName} has arrived for today's visit.`,
            })
            : `${appt.caregiverName} has checked in but appears to be ${distStr}. They may be parking.`;
        await (0, client_1.sendMessage)(clientSnap.data().chatId, arrivedMsg);
    }
    return {
        validated: withinRadius,
        distanceMeters: Math.round(distanceMeters),
        checkinId: checkinRef.id,
        message: withinRadius
            ? "Checked in successfully. The family has been notified."
            : `Checked in, but you appear to be ${Math.round(distanceMeters)}m from the care address.`,
    };
});
//# sourceMappingURL=gpsCheckin.js.map