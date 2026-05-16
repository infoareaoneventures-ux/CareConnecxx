/**
 * SMS Service — Linq iMessage/RCS/SMS integration for CareConnex
 * All transactional messages route through Linq; Twilio is retained for Video only.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendToPhone } from "./linq/client";
import { checkRateLimit, RATE_LIMITS, getClientIdentifier } from "./rateLimit";

const db = admin.firestore();

// ── Validation helpers (unchanged) ───────────────────────────────────────────

function validatePhoneNumber(phone: string, fieldName = "phone"): void {
  if (!phone || typeof phone !== "string")
    throw new Error(`${fieldName} must be a string`);
  if (!phone.match(/^\+[1-9]\d{1,14}$/))
    throw new Error(`${fieldName} must be in E.164 format (+1XXXXXXXXXX)`);
}

function validateString(value: string, fieldName: string, maxLength = 1600): void {
  if (!value || typeof value !== "string")
    throw new Error(`${fieldName} must be a string`);
  if (value.length > maxLength)
    throw new Error(`${fieldName} must be at most ${maxLength} characters`);
}

function validateUserId(userId: string): void {
  if (!userId || typeof userId !== "string")
    throw new Error("userId must be a non-empty string");
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SMSPayload {
  to:      string;
  message: string;
}

export interface SMSResult {
  success:     boolean;
  messageSid?: string; // kept for API compatibility; not used by Linq
  error?:      string;
}

// ── Opt-out (stored in agent_sessions.optedOut) ───────────────────────────────

export async function hasOptedOut(phoneNumber: string): Promise<boolean> {
  try {
    const phone = phoneNumber.replace(/\s/g, "");
    const snap  = await db.collection("agent_sessions").doc(phone).get();
    return snap.exists ? !!(snap.data() as any).optedOut : false;
  } catch {
    return false;
  }
}

export async function optOutPhoneNumber(phoneNumber: string): Promise<void> {
  const phone = phoneNumber.replace(/\s/g, "");
  await db.collection("agent_sessions").doc(phone).set(
    { optedOut: true, optedOutAt: new Date().toISOString() },
    { merge: true }
  );
}

// ── Core send ─────────────────────────────────────────────────────────────────

export async function sendSMS(payload: SMSPayload): Promise<SMSResult> {
  try {
    validatePhoneNumber(payload.to, "to");
    validateString(payload.message, "message", 1600);

    if (await hasOptedOut(payload.to)) {
      return { success: false, error: "Recipient has opted out of SMS notifications" };
    }

    const message =
      payload.message.length > 1600
        ? payload.message.substring(0, 1597) + "..."
        : payload.message;

    await sendToPhone(payload.to, message);
    return { success: true };
  } catch (error: any) {
    console.error(`Failed to send message to ${payload.to}:`, error);
    return { success: false, error: error.message ?? "Unknown error" };
  }
}

// ── Phone lookup (unchanged logic) ───────────────────────────────────────────

export async function getUserPhone(userId: string): Promise<string | null> {
  try {
    const caregiverDoc = await db.collection("caregivers").doc(userId).get();
    if (caregiverDoc.exists) {
      const phone = (caregiverDoc.data() as any)?.phone;
      if (phone) return phone;
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      const phone = (userDoc.data() as any)?.phone;
      if (phone) return phone;
    }

    return null;
  } catch {
    return null;
  }
}

export async function sendSMSToUser(userId: string, message: string): Promise<SMSResult> {
  validateUserId(userId);
  validateString(message, "message", 1600);

  const phone = await getUserPhone(userId);
  if (!phone) return { success: false, error: "No phone number on file" };

  return sendSMS({ to: phone, message });
}

// ── Templates (unchanged) ─────────────────────────────────────────────────────

export const SMS_TEMPLATES = {
  bookingConfirmed: (caregiverName: string, date: string, time: string) =>
    `Cara: Your booking with ${caregiverName} is confirmed for ${date} at ${time}. View details in the app.`,

  newBookingRequest: (clientName: string, date: string, time: string) =>
    `Cara: New booking! ${clientName} booked you for ${date} at ${time}. Open app to confirm.`,

  bookingCancelled: (name: string, date: string, reason?: string) =>
    `Cara: ${name} cancelled the appointment on ${date}.${reason ? ` Reason: ${reason}` : ""} Open app for details.`,

  newMessage: (senderName: string) =>
    `Cara: New message from ${senderName}. Open the app to reply.`,

  interviewScheduled: (name: string, dateTime: string) =>
    `Cara: Video interview with ${name} scheduled for ${dateTime}. Open app to join when ready.`,

  interviewReminder: (name: string, minutesUntil: number) =>
    `Cara: Reminder! Your interview with ${name} starts in ${minutesUntil} minutes. Open app to join.`,

  shiftReminder: (clientName: string, time: string) =>
    `Cara: Reminder! Your shift with ${clientName} starts at ${time}. Don't forget to clock in!`,

  paymentReceived: (amount: string) =>
    `Cara: Payment of ${amount} has been deposited to your account. View earnings in app.`,

  backgroundCheckComplete: (status: "clear" | "flagged") =>
    status === "clear"
      ? `Cara: Great news! Your background check is complete and clear. You're ready to accept bookings!`
      : `Cara: Your background check requires review. Please contact support for next steps.`,

  emergencyAlert: (initiatorName: string) =>
    `🚨 Cara URGENT: ${initiatorName} triggered an emergency alert. Please check in immediately or call 911 if needed.`,

  caregiverCallout: (
    caregiverName: string,
    date: string,
    time: string,
    backupCount: number,
    backupNames: string
  ) =>
    `Cara: ${caregiverName} cancelled your ${date} at ${time} appointment. ${backupCount} backup caregiver(s) available: ${backupNames}. Open app to select replacement or request refund.`,

  backupCaregiverAssigned: (
    clientName: string,
    date: string,
    time: string,
    address?: string
  ) =>
    `Cara: You've been assigned to care for ${clientName} on ${date} at ${time}. Previous caregiver called out.${address ? ` Address: ${address}` : ""} Open app for details.`,
};

// ── Callable (admin/test) ─────────────────────────────────────────────────────

export const sendTestSMS = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }

  const clientId = getClientIdentifier(context);
  const rateLimitResult = await checkRateLimit(clientId, RATE_LIMITS.sms);

  if (!rateLimitResult.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      `Rate limit exceeded. Try again in ${Math.ceil((rateLimitResult.retryAfterMs ?? 0) / 1000 / 60)} minutes.`
    );
  }

  const { to, message } = data;

  try {
    validatePhoneNumber(to, "to");
    validateString(message, "message", 1600);
  } catch (error: any) {
    throw new functions.https.HttpsError("invalid-argument", error.message);
  }

  const result = await sendSMS({ to, message });
  return { ...result, rateLimitRemaining: rateLimitResult.remaining };
});
