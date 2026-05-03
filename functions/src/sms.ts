/**
 * SMS Service - Twilio Integration for CareConnex
 * Sends transactional SMS notifications for bookings, messages, and alerts
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as twilio from "twilio";

// Validation helpers
function validatePhoneNumber(phone: string, fieldName: string = 'phone'): void {
  if (!phone || typeof phone !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (!phone.match(/^\+[1-9]\d{1,14}$/)) {
    throw new Error(`${fieldName} must be in E.164 format (+1XXXXXXXXXX)`);
  }
}

function validateString(value: string, fieldName: string, maxLength: number = 1600): void {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} must be at most ${maxLength} characters`);
  }
}

function validateUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId must be a non-empty string');
  }
}

// Initialize Firestore
const db = admin.firestore();

// Twilio client - initialized lazily
let twilioClient: twilio.Twilio | null = null;

function getTwilioClient(): twilio.Twilio {
    if (!twilioClient) {
        const accountSid = functions.config().twilio?.account_sid;
        const authToken = functions.config().twilio?.auth_token;
        
        if (!accountSid || !authToken) {
            throw new Error("Twilio credentials not configured. Run: firebase functions:config:set twilio.account_sid=XXX twilio.auth_token=XXX twilio.phone_number=+1XXXXXXXXXX");
        }
        
        twilioClient = twilio.default(accountSid, authToken);
    }
    return twilioClient;
}

function getTwilioPhoneNumber(): string {
    const phoneNumber = functions.config().twilio?.phone_number;
    if (!phoneNumber) {
        throw new Error("Twilio phone number not configured. Run: firebase functions:config:set twilio.phone_number=+1XXXXXXXXXX");
    }
    return phoneNumber;
}

export interface SMSPayload {
    to: string;          // Phone number in E.164 format (+1XXXXXXXXXX)
    message: string;     // SMS body (max 1600 chars, but aim for <160 for single segment)
}

export interface SMSResult {
    success: boolean;
    messageSid?: string;
    error?: string;
}

/**
 * Check if a phone number has opted out of SMS
 */
export async function hasOptedOut(phoneNumber: string): Promise<boolean> {
    try {
        const normalizedPhone = phoneNumber.replace(/\s/g, '');
        const optOutDoc = await db.collection('smsOptOuts').doc(normalizedPhone).get();
        return optOutDoc.exists;
    } catch (error) {
        console.error(`Error checking opt-out status for ${phoneNumber}:`, error);
        return false; // Fail open - allow SMS if we can't check
    }
}

/**
 * Opt out a phone number from SMS
 */
export async function optOutPhoneNumber(phoneNumber: string): Promise<void> {
    const normalizedPhone = phoneNumber.replace(/\s/g, '');
    await db.collection('smsOptOuts').doc(normalizedPhone).set({
        phoneNumber: normalizedPhone,
        optedOutAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

/**
 * Send an SMS message via Twilio
 */
export async function sendSMS(payload: SMSPayload): Promise<SMSResult> {
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
    } catch (error: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to send SMS to ${payload.to}:`, error);
        }
        return { success: false, error: error.message || "Unknown error" };
    }
}

/**
 * Get user's phone number from Firestore
 */
export async function getUserPhone(userId: string): Promise<string | null> {
    try {
        // Try caregivers collection first
        const caregiverDoc = await db.collection('caregivers').doc(userId).get();
        if (caregiverDoc.exists) {
            const data = caregiverDoc.data();
            if (data?.phone) return data.phone;
        }

        // Try users/clients collection
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            const data = userDoc.data();
            if (data?.phone) return data.phone;
        }

        // Try seniors collection (for clients)
        const seniorDoc = await db.collection('seniors').doc(userId).get();
        if (seniorDoc.exists) {
            const data = seniorDoc.data();
            if (data?.phone) return data.phone;
        }

        return null;
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Error fetching phone for user ${userId}:`, error);
        }
        return null;
    }
}

/**
 * Send SMS to a user by their ID (looks up phone number)
 */
export async function sendSMSToUser(userId: string, message: string): Promise<SMSResult> {
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

export const SMS_TEMPLATES = {
    bookingConfirmed: (caregiverName: string, date: string, time: string) =>
        `CareConnex: Your booking with ${caregiverName} is confirmed for ${date} at ${time}. View details in the app.`,
    
    newBookingRequest: (clientName: string, date: string, time: string) =>
        `CareConnex: New booking! ${clientName} booked you for ${date} at ${time}. Open app to confirm.`,
    
    bookingCancelled: (name: string, date: string, reason?: string) =>
        `CareConnex: ${name} cancelled the appointment on ${date}.${reason ? ` Reason: ${reason}` : ''} Open app for details.`,
    
    newMessage: (senderName: string) =>
        `CareConnex: New message from ${senderName}. Open the app to reply.`,
    
    interviewScheduled: (name: string, dateTime: string) =>
        `CareConnex: Video interview with ${name} scheduled for ${dateTime}. Open app to join when ready.`,
    
    interviewReminder: (name: string, minutesUntil: number) =>
        `CareConnex: Reminder! Your interview with ${name} starts in ${minutesUntil} minutes. Open app to join.`,
    
    shiftReminder: (clientName: string, time: string) =>
        `CareConnex: Reminder! Your shift with ${clientName} starts at ${time}. Don't forget to clock in!`,
    
    paymentReceived: (amount: string) =>
        `CareConnex: Payment of ${amount} has been deposited to your account. View earnings in app.`,
    
    backgroundCheckComplete: (status: 'clear' | 'flagged') =>
        status === 'clear' 
            ? `CareConnex: Great news! Your background check is complete and clear. You're ready to accept bookings!`
            : `CareConnex: Your background check requires review. Please contact support for next steps.`,
    
    emergencyAlert: (initiatorName: string) =>
        `🚨 CareConnex URGENT: ${initiatorName} triggered an emergency alert. Please check in immediately or call 911 if needed.`,
    
    caregiverCallout: (caregiverName: string, date: string, time: string, backupCount: number, backupNames: string) =>
        `CareConnex: ${caregiverName} cancelled your ${date} at ${time} appointment. ${backupCount} backup caregiver(s) available: ${backupNames}. Open app to select replacement or request refund.`,
    
    backupCaregiverAssigned: (clientName: string, date: string, time: string, address?: string) =>
        `CareConnex: You've been assigned to care for ${clientName} on ${date} at ${time}. Previous caregiver called out.${address ? ` Address: ${address}` : ''} Open app for details.`,
};

// ===== HTTP CALLABLE FOR MANUAL SMS =====

import { checkRateLimit, RATE_LIMITS, getClientIdentifier } from './rateLimit';

/**
 * Callable function to send SMS (for admin or testing)
 * Rate limited to prevent abuse
 */
export const sendTestSMS = functions.https.onCall(async (data, context) => {
    // Require authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }

    // Rate limit check
    const clientId = getClientIdentifier(context);
    const rateLimitResult = await checkRateLimit(clientId, RATE_LIMITS.sms);
    
    if (!rateLimitResult.allowed) {
        throw new functions.https.HttpsError(
            'resource-exhausted',
            `Rate limit exceeded. Try again in ${Math.ceil((rateLimitResult.retryAfterMs || 0) / 1000 / 60)} minutes.`
        );
    }

    const { to, message } = data;
    
    // Validate inputs
    try {
      validatePhoneNumber(to, 'to');
      validateString(message, 'message', 1600);
    } catch (error: any) {
      throw new functions.https.HttpsError('invalid-argument', error.message);
    }

    const result = await sendSMS({ to, message });
    return { ...result, rateLimitRemaining: rateLimitResult.remaining };
});
