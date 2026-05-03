"use strict";
/**
 * SMS Service - Twilio Integration for CareConnex
 * Sends transactional SMS notifications for bookings, messages, and alerts
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
exports.sendSMS = sendSMS;
exports.getUserPhone = getUserPhone;
exports.sendSMSToUser = sendSMSToUser;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const twilio = __importStar(require("twilio"));
// Validation helpers
function validatePhoneNumber(phone, fieldName = 'phone') {
    if (!phone || typeof phone !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    if (!phone.match(/^\+[1-9]\d{1,14}$/)) {
        throw new Error(`${fieldName} must be in E.164 format (+1XXXXXXXXXX)`);
    }
}
function validateString(value, fieldName, maxLength = 1600) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    if (value.length > maxLength) {
        throw new Error(`${fieldName} must be at most ${maxLength} characters`);
    }
}
function validateUserId(userId) {
    if (!userId || typeof userId !== 'string') {
        throw new Error('userId must be a non-empty string');
    }
}
// Initialize Firestore
const db = admin.firestore();
// Twilio client - initialized lazily
let twilioClient = null;
function getTwilioClient() {
    var _a, _b;
    if (!twilioClient) {
        const accountSid = (_a = functions.config().twilio) === null || _a === void 0 ? void 0 : _a.account_sid;
        const authToken = (_b = functions.config().twilio) === null || _b === void 0 ? void 0 : _b.auth_token;
        if (!accountSid || !authToken) {
            throw new Error("Twilio credentials not configured. Run: firebase functions:config:set twilio.account_sid=XXX twilio.auth_token=XXX twilio.phone_number=+1XXXXXXXXXX");
        }
        twilioClient = twilio.default(accountSid, authToken);
    }
    return twilioClient;
}
function getTwilioPhoneNumber() {
    var _a;
    const phoneNumber = (_a = functions.config().twilio) === null || _a === void 0 ? void 0 : _a.phone_number;
    if (!phoneNumber) {
        throw new Error("Twilio phone number not configured. Run: firebase functions:config:set twilio.phone_number=+1XXXXXXXXXX");
    }
    return phoneNumber;
}
/**
 * Check if a phone number has opted out of SMS
 */
async function hasOptedOut(phoneNumber) {
    try {
        const normalizedPhone = phoneNumber.replace(/\s/g, '');
        const optOutDoc = await db.collection('smsOptOuts').doc(normalizedPhone).get();
        return optOutDoc.exists;
    }
    catch (error) {
        console.error(`Error checking opt-out status for ${phoneNumber}:`, error);
        return false; // Fail open - allow SMS if we can't check
    }
}
/**
 * Opt out a phone number from SMS
 */
async function optOutPhoneNumber(phoneNumber) {
    const normalizedPhone = phoneNumber.replace(/\s/g, '');
    await db.collection('smsOptOuts').doc(normalizedPhone).set({
        phoneNumber: normalizedPhone,
        optedOutAt: admin.firestore.FieldValue.serverTimestamp()
    });
}
/**
 * Send an SMS message via Twilio
 */
async function sendSMS(payload) {
    try {
        // Validate inputs
        validatePhoneNumber(payload.to, 'to');
        validateString(payload.message, 'message', 1600);
        // Check opt-out status
        const isOptedOut = await hasOptedOut(payload.to);
        if (isOptedOut) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`SMS blocked: ${payload.to} has opted out`);
            }
            return { success: false, error: 'Recipient has opted out of SMS notifications' };
        }
        // Truncate message if too long
        const message = payload.message.length > 1600
            ? payload.message.substring(0, 1597) + "..."
            : payload.message;
        const client = getTwilioClient();
        const result = await client.messages.create({
            body: message,
            from: getTwilioPhoneNumber(),
            to: payload.to
        });
        if (process.env.NODE_ENV !== 'production') {
            console.log(`SMS sent to ${payload.to}, SID: ${result.sid}`);
        }
        return { success: true, messageSid: result.sid };
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to send SMS to ${payload.to}:`, error);
        }
        return { success: false, error: error.message || "Unknown error" };
    }
}
/**
 * Get user's phone number from Firestore
 */
async function getUserPhone(userId) {
    try {
        // Try caregivers collection first
        const caregiverDoc = await db.collection('caregivers').doc(userId).get();
        if (caregiverDoc.exists) {
            const data = caregiverDoc.data();
            if (data === null || data === void 0 ? void 0 : data.phone)
                return data.phone;
        }
        // Try users/clients collection
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            const data = userDoc.data();
            if (data === null || data === void 0 ? void 0 : data.phone)
                return data.phone;
        }
        // Try seniors collection (for clients)
        const seniorDoc = await db.collection('seniors').doc(userId).get();
        if (seniorDoc.exists) {
            const data = seniorDoc.data();
            if (data === null || data === void 0 ? void 0 : data.phone)
                return data.phone;
        }
        return null;
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Error fetching phone for user ${userId}:`, error);
        }
        return null;
    }
}
/**
 * Send SMS to a user by their ID (looks up phone number)
 */
async function sendSMSToUser(userId, message) {
    // Validate inputs
    validateUserId(userId);
    validateString(message, 'message', 1600);
    const phone = await getUserPhone(userId);
    if (!phone) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(`No phone number found for user ${userId}, skipping SMS`);
        }
        return { success: false, error: "No phone number on file" };
    }
    return sendSMS({ to: phone, message });
}
// ===== SMS NOTIFICATION TEMPLATES =====
exports.SMS_TEMPLATES = {
    bookingConfirmed: (caregiverName, date, time) => `CareConnex: Your booking with ${caregiverName} is confirmed for ${date} at ${time}. View details in the app.`,
    newBookingRequest: (clientName, date, time) => `CareConnex: New booking! ${clientName} booked you for ${date} at ${time}. Open app to confirm.`,
    bookingCancelled: (name, date, reason) => `CareConnex: ${name} cancelled the appointment on ${date}.${reason ? ` Reason: ${reason}` : ''} Open app for details.`,
    newMessage: (senderName) => `CareConnex: New message from ${senderName}. Open the app to reply.`,
    interviewScheduled: (name, dateTime) => `CareConnex: Video interview with ${name} scheduled for ${dateTime}. Open app to join when ready.`,
    interviewReminder: (name, minutesUntil) => `CareConnex: Reminder! Your interview with ${name} starts in ${minutesUntil} minutes. Open app to join.`,
    shiftReminder: (clientName, time) => `CareConnex: Reminder! Your shift with ${clientName} starts at ${time}. Don't forget to clock in!`,
    paymentReceived: (amount) => `CareConnex: Payment of ${amount} has been deposited to your account. View earnings in app.`,
    backgroundCheckComplete: (status) => status === 'clear'
        ? `CareConnex: Great news! Your background check is complete and clear. You're ready to accept bookings!`
        : `CareConnex: Your background check requires review. Please contact support for next steps.`,
    emergencyAlert: (initiatorName) => `🚨 CareConnex URGENT: ${initiatorName} triggered an emergency alert. Please check in immediately or call 911 if needed.`,
    caregiverCallout: (caregiverName, date, time, backupCount, backupNames) => `CareConnex: ${caregiverName} cancelled your ${date} at ${time} appointment. ${backupCount} backup caregiver(s) available: ${backupNames}. Open app to select replacement or request refund.`,
    backupCaregiverAssigned: (clientName, date, time, address) => `CareConnex: You've been assigned to care for ${clientName} on ${date} at ${time}. Previous caregiver called out.${address ? ` Address: ${address}` : ''} Open app for details.`,
};
// ===== HTTP CALLABLE FOR MANUAL SMS =====
const rateLimit_1 = require("./rateLimit");
/**
 * Callable function to send SMS (for admin or testing)
 * Rate limited to prevent abuse
 */
exports.sendTestSMS = functions.https.onCall(async (data, context) => {
    // Require authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    // Rate limit check
    const clientId = (0, rateLimit_1.getClientIdentifier)(context);
    const rateLimitResult = await (0, rateLimit_1.checkRateLimit)(clientId, rateLimit_1.RATE_LIMITS.sms);
    if (!rateLimitResult.allowed) {
        throw new functions.https.HttpsError('resource-exhausted', `Rate limit exceeded. Try again in ${Math.ceil((rateLimitResult.retryAfterMs || 0) / 1000 / 60)} minutes.`);
    }
    const { to, message } = data;
    // Validate inputs
    try {
        validatePhoneNumber(to, 'to');
        validateString(message, 'message', 1600);
    }
    catch (error) {
        throw new functions.https.HttpsError('invalid-argument', error.message);
    }
    const result = await sendSMS({ to, message });
    return Object.assign(Object.assign({}, result), { rateLimitRemaining: rateLimitResult.remaining });
});
//# sourceMappingURL=sms.js.map