/**
 * SMS Service — Linq iMessage/RCS/SMS integration for Evia
 * All transactional messages route through Linq; Twilio is retained for Video only.
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendToPhone, listPhoneNumbers, createOrUpdateContactCard, LinqService } from "./linq/client";
import { checkRateLimit, RATE_LIMITS, getClientIdentifier } from "./rateLimit";
import { getAppUrl } from "./config/appUrl";
import { requireAdmin } from "./admin/requireAdmin";

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
  /**
   * Optional Linq protocol override. Omit for automatic iMessage → RCS → SMS.
   * Set "SMS" for compliance/opt-out and deliverability-critical sends that
   * must never use iMessage. See /guides/messaging/protocol-selection/.
   */
  preferredService?: LinqService;
}

export interface SMSResult {
  success:     boolean;
  messageSid?: string; // kept for API compatibility; not used by Linq
  error?:      string;
}

// ── Circuit breaker — blocks all outbound when Linq line is CRITICAL ─────────

async function isCircuitOpen(): Promise<boolean> {
  try {
    const snap = await db.collection("system_config").doc("linq_circuit_breaker").get();
    return snap.exists && snap.data()?.status === "open";
  } catch {
    return false; // fail open so we don't silently drop messages
  }
}

// ── Chat health gate — respect OPTED_OUT status ───────────────────────────────

async function getChatHealthStatus(phone: string): Promise<string | null> {
  try {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    return (snap.data() as any)?.healthStatus ?? null;
  } catch {
    return null;
  }
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

export async function optInPhoneNumber(phoneNumber: string): Promise<void> {
  const phone = phoneNumber.replace(/\s/g, "");
  await db.collection("agent_sessions").doc(phone).set(
    { optedOut: false, optedInAt: new Date().toISOString() },
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

    const message =
      payload.message.length > 1600
        ? payload.message.substring(0, 1597) + "..."
        : payload.message;

    await sendToPhone(payload.to, message, { preferredService: payload.preferredService });
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

export async function sendSMSToUser(
  userId: string,
  message: string,
  preferredService?: LinqService
): Promise<SMSResult> {
  validateUserId(userId);
  validateString(message, "message", 1600);

  const phone = await getUserPhone(userId);
  if (!phone) return { success: false, error: "No phone number on file" };

  return sendSMS({ to: phone, message, preferredService });
}

// ── Templates (unchanged) ─────────────────────────────────────────────────────

// 2026-09-14 (Hamse's call, full sweep): every date/time param here is a raw
// stored value ("2026-09-15" / "14:00") from the caller — these templates are
// the SMS text itself, so formatting happens HERE once, rather than trusting
// every caller to remember to pre-format (the exact way this bug slipped in
// originally — some callers formatted, most didn't). formatDateForDisplay /
// formatHHMMForDisplay are no-ops on an already-formatted string, so this is
// safe even if a caller does pass a pre-formatted value.
// The one text template still in use (notifications.ts onMessageSent). The ten
// others that lived here — booking confirmed / new request / cancelled,
// interview scheduled / reminder, shift reminder, payment received, background
// check, callout, backup assigned — were never called and all ended with "Open
// app…"; removed 2026-09-30 (founder: Evia finishes the job by text; nothing
// sends a person to the website).
export const SMS_TEMPLATES = {
  // The message itself rides along (Inbox parity, 2026-09-17); the recipient can
  // reply right here and Evia posts it back into the same thread. An image-only
  // message is the one thing text cannot carry, so that line names the Inbox.
  newMessage: (senderName: string, text?: string) =>
    text
      ? `Evia: New message from ${senderName}: "${text.slice(0, 1000)}" — reply here and I'll pass it along.`
      : `Evia: ${senderName} sent you a photo in your Inbox.`,
};

// ── Phone health check (Linq API) ────────────────────────────────────────────

/**
 * Fetches live phone health from Linq and stores it in Firestore.
 * Call on startup or from a scheduled job to keep health state fresh.
 */
export async function syncPhoneHealth(): Promise<void> {
  const numbers = await listPhoneNumbers();
  const batch   = db.batch();

  for (const pn of numbers) {
    const ref = db.collection("linq_phone_health").doc(pn.phone_number);
    batch.set(ref, {
      phoneNumber:   pn.phone_number,
      status:        pn.status,
      healthStatus:  pn.health_status.status,
      updatedAt:     pn.health_status.updated_at ?? new Date().toISOString(),
    }, { merge: true });

    // Auto-open circuit breaker if CRITICAL
    if (pn.health_status.status === "CRITICAL") {
      const cbRef = db.collection("system_config").doc("linq_circuit_breaker");
      batch.set(cbRef, {
        status:   "open",
        reason:   `Phone ${pn.phone_number} is CRITICAL`,
        openedAt: new Date().toISOString(),
        phone:    pn.phone_number,
      }, { merge: true });

      // P0 — surface circuit-open to ops immediately. Previously silent: outbound
      // was suppressed with no alert, leaving users in radio silence.
      const alertRef = db.collection("admin_alerts").doc();
      batch.set(alertRef, {
        type:        "linq_circuit_breaker_opened",
        phone:       pn.phone_number,
        reason:      `Phone ${pn.phone_number} health=CRITICAL — outbound messages suppressed`,
        severity:    "critical",
        resolved:    false,
        createdAt:   new Date().toISOString(),
      });
    }
  }

  await batch.commit();
}

// ── Contact card setup ────────────────────────────────────────────────────────

/**
 * One-time setup: configure Evia's identity on the provisioned Linq number.
 * Safe to call on every deploy — uses PATCH if card already exists.
 */
export async function setupCaraContactCard(params?: {
  firstName?: string;
  lastName?:  string;
  imageUrl?:  string;
}): Promise<void> {
  const phoneNumber = process.env.LINQ_PHONE_NUMBER ?? "";
  if (!phoneNumber) {
    console.warn("setupCaraContactCard: LINQ_PHONE_NUMBER not set");
    return;
  }
  // Contact-card fix (2026-07-12): CARA_AVATAR_URL was never set in the live
  // env, so the card had NO photo — fall back to the hosted app icon so the
  // thread always shows a face for Evia. And the old last_name default of
  // "Evia" rendered the sender as "Evia Evia" — a real last name is not a
  // thing Evia has, so send the brand as the surname-free display name.
  const imageUrl = params?.imageUrl?.trim() || process.env.CARA_AVATAR_URL?.trim() || `${getAppUrl()}/icon-512.png`;
  await createOrUpdateContactCard({
    phone_number: phoneNumber,
    first_name:   params?.firstName ?? "Evia",
    ...(params?.lastName ? { last_name: params.lastName } : {}),
    image_url:    imageUrl,
  });
}

// ── Callable (admin/test) ─────────────────────────────────────────────────────

export const sendTestSMS = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }
  await requireAdmin(context);

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
