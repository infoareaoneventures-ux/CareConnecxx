"use strict";
/**
 * SMS Service — Linq iMessage/RCS/SMS integration for CareConnex
 * All transactional messages route through Linq; Twilio is retained for Video only.
 */
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
exports.sendTestSMS = exports.SMS_TEMPLATES = void 0;
exports.hasOptedOut = hasOptedOut;
exports.optOutPhoneNumber = optOutPhoneNumber;
exports.optInPhoneNumber = optInPhoneNumber;
exports.sendSMS = sendSMS;
exports.getUserPhone = getUserPhone;
exports.sendSMSToUser = sendSMSToUser;
exports.syncPhoneHealth = syncPhoneHealth;
exports.setupCaraContactCard = setupCaraContactCard;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("./linq/client");
const rateLimit_1 = require("./rateLimit");
const db = admin.firestore();
// ── Validation helpers (unchanged) ───────────────────────────────────────────
function validatePhoneNumber(phone, fieldName = "phone") {
    if (!phone || typeof phone !== "string")
        throw new Error(`${fieldName} must be a string`);
    if (!phone.match(/^\+[1-9]\d{1,14}$/))
        throw new Error(`${fieldName} must be in E.164 format (+1XXXXXXXXXX)`);
}
function validateString(value, fieldName, maxLength = 1600) {
    if (!value || typeof value !== "string")
        throw new Error(`${fieldName} must be a string`);
    if (value.length > maxLength)
        throw new Error(`${fieldName} must be at most ${maxLength} characters`);
}
function validateUserId(userId) {
    if (!userId || typeof userId !== "string")
        throw new Error("userId must be a non-empty string");
}
// ── Circuit breaker — blocks all outbound when Linq line is CRITICAL ─────────
async function isCircuitOpen() {
    var _a;
    try {
        const snap = await db.collection("system_config").doc("linq_circuit_breaker").get();
        return snap.exists && ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.status) === "open";
    }
    catch (_b) {
        return false; // fail open so we don't silently drop messages
    }
}
// ── Chat health gate — respect OPTED_OUT status ───────────────────────────────
async function getChatHealthStatus(phone) {
    var _a, _b;
    try {
        const snap = await db.collection("agent_sessions").doc(phone).get();
        return (_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.healthStatus) !== null && _b !== void 0 ? _b : null;
    }
    catch (_c) {
        return null;
    }
}
// ── Opt-out (stored in agent_sessions.optedOut) ───────────────────────────────
async function hasOptedOut(phoneNumber) {
    try {
        const phone = phoneNumber.replace(/\s/g, "");
        const snap = await db.collection("agent_sessions").doc(phone).get();
        return snap.exists ? !!snap.data().optedOut : false;
    }
    catch (_a) {
        return false;
    }
}
async function optOutPhoneNumber(phoneNumber) {
    const phone = phoneNumber.replace(/\s/g, "");
    await db.collection("agent_sessions").doc(phone).set({ optedOut: true, optedOutAt: new Date().toISOString() }, { merge: true });
}
async function optInPhoneNumber(phoneNumber) {
    const phone = phoneNumber.replace(/\s/g, "");
    await db.collection("agent_sessions").doc(phone).set({ optedOut: false, optedInAt: new Date().toISOString() }, { merge: true });
}
// ── Core send ─────────────────────────────────────────────────────────────────
async function sendSMS(payload) {
    var _a;
    try {
        validatePhoneNumber(payload.to, "to");
        validateString(payload.message, "message", 1600);
        if (await hasOptedOut(payload.to)) {
            return { success: false, error: "Recipient has opted out of SMS notifications" };
        }
        // Linq best-practice: do not send when line is circuit-broken (CRITICAL phone health)
        if (await isCircuitOpen()) {
            console.warn("sendSMS: circuit breaker is OPEN — message dropped for", payload.to);
            return { success: false, error: "Messaging line is temporarily unavailable" };
        }
        // Linq best-practice: do not send to OPTED_OUT chats
        const chatHealth = await getChatHealthStatus(payload.to);
        if (chatHealth === "OPTED_OUT") {
            return { success: false, error: "Chat is in OPTED_OUT state" };
        }
        const message = payload.message.length > 1600
            ? payload.message.substring(0, 1597) + "..."
            : payload.message;
        await (0, client_1.sendToPhone)(payload.to, message, { preferredService: payload.preferredService });
        return { success: true };
    }
    catch (error) {
        console.error(`Failed to send message to ${payload.to}:`, error);
        return { success: false, error: (_a = error.message) !== null && _a !== void 0 ? _a : "Unknown error" };
    }
}
// ── Phone lookup (unchanged logic) ───────────────────────────────────────────
async function getUserPhone(userId) {
    var _a, _b;
    try {
        const caregiverDoc = await db.collection("caregivers").doc(userId).get();
        if (caregiverDoc.exists) {
            const phone = (_a = caregiverDoc.data()) === null || _a === void 0 ? void 0 : _a.phone;
            if (phone)
                return phone;
        }
        const userDoc = await db.collection("users").doc(userId).get();
        if (userDoc.exists) {
            const phone = (_b = userDoc.data()) === null || _b === void 0 ? void 0 : _b.phone;
            if (phone)
                return phone;
        }
        return null;
    }
    catch (_c) {
        return null;
    }
}
async function sendSMSToUser(userId, message, preferredService) {
    validateUserId(userId);
    validateString(message, "message", 1600);
    const phone = await getUserPhone(userId);
    if (!phone)
        return { success: false, error: "No phone number on file" };
    return sendSMS({ to: phone, message, preferredService });
}
// ── Templates (unchanged) ─────────────────────────────────────────────────────
exports.SMS_TEMPLATES = {
    bookingConfirmed: (caregiverName, date, time) => `Cara: Your booking with ${caregiverName} is confirmed for ${date} at ${time}. View details in the app.`,
    newBookingRequest: (clientName, date, time) => `Cara: New booking! ${clientName} booked you for ${date} at ${time}. Open app to confirm.`,
    bookingCancelled: (name, date, reason) => `Cara: ${name} cancelled the appointment on ${date}.${reason ? ` Reason: ${reason}` : ""} Open app for details.`,
    newMessage: (senderName) => `Cara: New message from ${senderName}. Open the app to reply.`,
    interviewScheduled: (name, dateTime) => `Cara: Video interview with ${name} scheduled for ${dateTime}. Open app to join when ready.`,
    interviewReminder: (name, minutesUntil) => `Cara: Reminder! Your interview with ${name} starts in ${minutesUntil} minutes. Open app to join.`,
    shiftReminder: (clientName, time) => `Cara: Reminder! Your shift with ${clientName} starts at ${time}. Don't forget to clock in!`,
    paymentReceived: (amount) => `Cara: Payment of ${amount} has been deposited to your account. View earnings in app.`,
    backgroundCheckComplete: (status) => status === "clear"
        ? `Cara: Great news! Your background check is complete and clear. You're ready to accept bookings!`
        : `Cara: Your background check requires review. Please contact support for next steps.`,
    emergencyAlert: (initiatorName) => `🚨 Cara URGENT: ${initiatorName} triggered an emergency alert. Please check in immediately or call 911 if needed.`,
    caregiverCallout: (caregiverName, date, time, backupCount, backupNames) => `Cara: ${caregiverName} cancelled your ${date} at ${time} appointment. ${backupCount} backup caregiver(s) available: ${backupNames}. Open app to select replacement or request refund.`,
    backupCaregiverAssigned: (clientName, date, time, address) => `Cara: You've been assigned to care for ${clientName} on ${date} at ${time}. Previous caregiver called out.${address ? ` Address: ${address}` : ""} Open app for details.`,
};
// ── Phone health check (Linq API) ────────────────────────────────────────────
/**
 * Fetches live phone health from Linq and stores it in Firestore.
 * Call on startup or from a scheduled job to keep health state fresh.
 */
async function syncPhoneHealth() {
    var _a;
    const numbers = await (0, client_1.listPhoneNumbers)();
    const batch = db.batch();
    for (const pn of numbers) {
        const ref = db.collection("linq_phone_health").doc(pn.phone_number);
        batch.set(ref, {
            phoneNumber: pn.phone_number,
            status: pn.status,
            healthStatus: pn.health_status.status,
            updatedAt: (_a = pn.health_status.updated_at) !== null && _a !== void 0 ? _a : new Date().toISOString(),
        }, { merge: true });
        // Auto-open circuit breaker if CRITICAL
        if (pn.health_status.status === "CRITICAL") {
            const cbRef = db.collection("system_config").doc("linq_circuit_breaker");
            batch.set(cbRef, {
                status: "open",
                reason: `Phone ${pn.phone_number} is CRITICAL`,
                openedAt: new Date().toISOString(),
                phone: pn.phone_number,
            }, { merge: true });
            // P0 — surface circuit-open to ops immediately. Previously silent: outbound
            // was suppressed with no alert, leaving users in radio silence.
            const alertRef = db.collection("admin_alerts").doc();
            batch.set(alertRef, {
                type: "linq_circuit_breaker_opened",
                phone: pn.phone_number,
                reason: `Phone ${pn.phone_number} health=CRITICAL — outbound messages suppressed`,
                severity: "critical",
                resolved: false,
                createdAt: new Date().toISOString(),
            });
        }
    }
    await batch.commit();
}
// ── Contact card setup ────────────────────────────────────────────────────────
/**
 * One-time setup: configure Cara's identity on the provisioned Linq number.
 * Safe to call on every deploy — uses PATCH if card already exists.
 */
async function setupCaraContactCard(params) {
    var _a, _b, _c, _d;
    const phoneNumber = (_a = process.env.LINQ_PHONE_NUMBER) !== null && _a !== void 0 ? _a : "";
    if (!phoneNumber) {
        console.warn("setupCaraContactCard: LINQ_PHONE_NUMBER not set");
        return;
    }
    await (0, client_1.createOrUpdateContactCard)({
        phone_number: phoneNumber,
        first_name: (_b = params === null || params === void 0 ? void 0 : params.firstName) !== null && _b !== void 0 ? _b : "Cara",
        last_name: (_c = params === null || params === void 0 ? void 0 : params.lastName) !== null && _c !== void 0 ? _c : "CareConnex",
        image_url: (_d = params === null || params === void 0 ? void 0 : params.imageUrl) !== null && _d !== void 0 ? _d : process.env.CARA_AVATAR_URL,
    });
}
// ── Callable (admin/test) ─────────────────────────────────────────────────────
exports.sendTestSMS = functions.https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
    }
    const clientId = (0, rateLimit_1.getClientIdentifier)(context);
    const rateLimitResult = await (0, rateLimit_1.checkRateLimit)(clientId, rateLimit_1.RATE_LIMITS.sms);
    if (!rateLimitResult.allowed) {
        throw new functions.https.HttpsError("resource-exhausted", `Rate limit exceeded. Try again in ${Math.ceil(((_a = rateLimitResult.retryAfterMs) !== null && _a !== void 0 ? _a : 0) / 1000 / 60)} minutes.`);
    }
    const { to, message } = data;
    try {
        validatePhoneNumber(to, "to");
        validateString(message, "message", 1600);
    }
    catch (error) {
        throw new functions.https.HttpsError("invalid-argument", error.message);
    }
    const result = await sendSMS({ to, message });
    return Object.assign(Object.assign({}, result), { rateLimitRemaining: rateLimitResult.remaining });
});
//# sourceMappingURL=sms.js.map