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
exports.logAudit = logAudit;
exports.logMessageSent = logMessageSent;
exports.logHealthDataAccessed = logHealthDataAccessed;
exports.logBookingCreated = logBookingCreated;
exports.logCrisisDetected = logCrisisDetected;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
// 6-year TTL in milliseconds (HIPAA minimum retention)
const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;
async function logAudit(event) {
    const now = new Date();
    const ttlMs = now.getTime() + SIX_YEARS_MS;
    try {
        await db.collection("agent_audit_log").add(Object.assign(Object.assign({}, event), { timestamp: now.toISOString(), 
            // Firestore TTL policy uses a Timestamp field to auto-delete expired docs
            ttl: admin.firestore.Timestamp.fromMillis(ttlMs) }));
    }
    catch (err) {
        // Audit log failure must never interrupt the main flow
        console.error("auditLog write error:", err);
    }
}
// Convenience wrappers for common event types
function logMessageSent(userId, phone, chatId, messagePreview) {
    return logAudit({
        eventType: "message_sent",
        userId,
        phone,
        data: { chatId, preview: messagePreview.slice(0, 200) },
    });
}
function logHealthDataAccessed(userId, seniorId, source) {
    return logAudit({
        eventType: "health_data_accessed",
        userId,
        data: { seniorId, source },
    });
}
function logBookingCreated(userId, caregiverId, dates) {
    return logAudit({
        eventType: "booking_created",
        userId,
        data: { caregiverId, dates },
    });
}
function logCrisisDetected(phone, crisisType, text) {
    return logAudit({
        eventType: "crisis_detected",
        userId: phone,
        phone,
        data: { crisisType, textPreview: text.slice(0, 100) },
    });
}
//# sourceMappingURL=auditLog.js.map