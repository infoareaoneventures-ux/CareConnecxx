// ── Childcare notification privacy policy (plan 2026-07-22-002, U9 / R20, R43, KTD16, AE17, AE24) ──
//
// THE childcare notification surface: every childcare push / SMS / email /
// calendar / in-app payload is GENERIC ("You have a booking update" style) —
// no child name or display label, no exact address, no custody/health/
// incident detail. Sensitive detail is fetched only inside authenticated
// views (KTD16). Lock-screen text = template title/body only (AE17).
//
// STRUCTURAL CONTRACTS:
//   • `CHILDCARE_NOTIFICATION_TEMPLATES` is a registry of STATIC strings —
//     no template functions, no interpolation slots. A static test asserts
//     every entry is childSafe:true, carries zero `${`/placeholder tokens,
//     and passes assertChildSafeOutboundPayload; a source scan additionally
//     asserts this module never references a child display label or address
//     field AT ALL (prohibited-interpolation test).
//   • Duplicate sends: in-app rows go through the deterministic-id
//     writeUserNotification writer (notifications/userNotification.ts) —
//     one event, one row, retries converge (AE15).
//   • Opt-out/consent (R20): childcare SMS requires a LIVE (non-revoked)
//     childcare communicationConsent receipt (U4 consentReceipts). A revoked
//     adult gets in-app only. This is IN ADDITION to the phone-level opt-out
//     and circuit-breaker gates inside sms.ts sendSMSToUser.
//   • Suspected-unsafe-party exclusion (AE24): fan-out helpers consult the
//     excludedUids hook (conversationPolicy.filterExcludedNotificationRecipients)
//     — an excluded uid receives NOTHING (no in-app row, no SMS, no push)
//     while other parties are notified normally.

import * as admin from "firebase-admin";
import { writeUserNotification } from "../notifications/userNotification";
import { assertChildSafeOutboundPayload } from "./matchingEligibility";
import { CONSENT_RECEIPTS_COLLECTION, type ConsentReceiptDoc } from "./consentReceipts";
import { isExcludedNotificationRecipient } from "./conversationPolicy";

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

// ── The childSafe template registry (R43/KTD16) ──────────────────────────────

export interface ChildSafeNotificationTemplate {
  /** users/{uid}/notifications `type` value (stable, UI-routable). */
  readonly type: string;
  readonly childSafe: true;
  /** STATIC lock-screen-safe strings — no interpolation, ever. */
  readonly title: string;
  readonly body: string;
  /** Optional generic SMS nudge body (omit = never SMS for this kind). */
  readonly sms?: string;
}

export const CHILDCARE_NOTIFICATION_TEMPLATES = {
  childcare_booking_request: {
    type: "childcare_booking_request",
    childSafe: true,
    title: "New Booking Request",
    body: "A family sent you a childcare booking request. Open the app to respond.",
    sms: "Evia: You have a new childcare booking request. Open the app to respond.",
  },
  childcare_booking_accepted: {
    type: "childcare_booking_accepted",
    childSafe: true,
    title: "Caregiver Accepted",
    body: "Your childcare booking request was accepted. Open the app for next steps.",
  },
  childcare_booking_declined: {
    type: "childcare_booking_declined",
    childSafe: true,
    title: "Booking Declined",
    body: "The caregiver is unable to accept your childcare booking request.",
  },
  childcare_booking_confirmed_family: {
    type: "childcare_booking_confirmed",
    childSafe: true,
    title: "Booking Confirmed",
    body: "Your childcare booking is confirmed. Open the app for details.",
  },
  childcare_booking_confirmed_provider: {
    type: "childcare_booking_confirmed",
    childSafe: true,
    title: "Booking Confirmed",
    body: "A childcare booking you accepted is now confirmed. Open the app for details.",
  },
  childcare_booking_canceled: {
    type: "childcare_booking_canceled",
    childSafe: true,
    title: "Booking Canceled",
    body: "A childcare booking was canceled. Open the app for details.",
  },
  childcare_booking_change_requested: {
    type: "childcare_booking_change_requested",
    childSafe: true,
    title: "Schedule Change Requested",
    body: "A family requested a schedule change for a childcare booking. Open the app to respond.",
  },
  childcare_booking_change_accepted: {
    type: "childcare_booking_change_accepted",
    childSafe: true,
    title: "Schedule Change Accepted",
    body: "The caregiver accepted your schedule change. Open the app for the updated schedule.",
  },
  childcare_booking_change_declined: {
    type: "childcare_booking_change_declined",
    childSafe: true,
    title: "Schedule Change Declined",
    body: "The caregiver can't make the requested schedule change. The original schedule stands.",
  },
  childcare_booking_unassigned: {
    type: "childcare_booking_unassigned",
    childSafe: true,
    title: "Booking Update",
    body: "You are no longer assigned to a childcare booking. Open the app for details.",
  },
  childcare_booking_assigned: {
    type: "childcare_booking_assigned",
    childSafe: true,
    title: "New Booking Assignment",
    body: "You were assigned to a childcare booking. Open the app for details.",
    sms: "Evia: You have a new childcare booking assignment. Open the app for details.",
  },
  childcare_shift_started: {
    type: "childcare_shift_started",
    childSafe: true,
    title: "Visit Started",
    body: "Your caregiver has checked in for today's visit.",
  },
  childcare_shift_completed: {
    type: "childcare_shift_completed",
    childSafe: true,
    title: "Visit Completed",
    body: "Your caregiver has completed today's visit.",
  },
  childcare_application_accepted: {
    type: "childcare_application_accepted",
    childSafe: true,
    title: "Application Accepted",
    body: "A family accepted your childcare application. They may send a booking request next.",
  },
  childcare_application_rejected: {
    type: "childcare_application_rejected",
    childSafe: true,
    title: "Application Update",
    body: "A family has decided not to move forward with your childcare application.",
  },
  /** Chat message nudge — THE lock-screen payload for childcare rooms (AE17). */
  childcare_message: {
    type: "childcare_message",
    childSafe: true,
    title: "New Message",
    body: "You have a new message on Evia. Open the app to read it.",
    sms: "Evia: You have a new message. Open the app to read it.",
  },
  /** Generic email/calendar bodies for future childcare senders (none send
   *  email this unit; interview calendar strings live in interviewLinkTrigger
   *  and are already fully generic — characterized there). */
  childcare_generic_update: {
    type: "childcare_update",
    childSafe: true,
    title: "You have a booking update",
    body: "There is an update on your Evia childcare coordination. Open the app for details.",
  },
} as const satisfies Record<string, ChildSafeNotificationTemplate>;

export type ChildcareNotificationKind = keyof typeof CHILDCARE_NOTIFICATION_TEMPLATES;

export function getChildcareNotificationTemplate(
  kind: ChildcareNotificationKind,
): ChildSafeNotificationTemplate {
  const template = CHILDCARE_NOTIFICATION_TEMPLATES[kind];
  if (!template || template.childSafe !== true) {
    throw new Error(`[childcare] unknown or non-childSafe notification kind "${kind}"`);
  }
  return template;
}

// ── R20 consent gate (receipts, not booleans) ────────────────────────────────

/**
 * Does this adult hold a LIVE childcare communication consent (latest
 * communicationConsent receipt exists and is not revoked)? FAIL CLOSED: no
 * receipt at all (adult never completed a childcare consent flow) or a
 * revoked latest receipt both deny — the adult still gets in-app rows.
 */
export async function hasLiveChildcareCommunicationConsent(
  adultUid: string,
  db: Db = defaultDb(),
): Promise<boolean> {
  const clean = String(adultUid ?? "").trim();
  if (!clean) return false;
  try {
    const snap = await db
      .collection(CONSENT_RECEIPTS_COLLECTION)
      .where("adultUid", "==", clean)
      .where("policyType", "==", "communicationConsent")
      .get();
    if (snap.empty) return false;
    const receipts = snap.docs
      .map((d) => (d.data() ?? {}) as Partial<ConsentReceiptDoc>)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return !receipts[0]?.revokedAt;
  } catch {
    return false; // fail closed — in-app only
  }
}

// ── SMS throttle (burst suppression, senior smsThrottles pattern) ────────────

export const CHILDCARE_SMS_THROTTLE_MS = 5 * 60 * 1000;

async function isSmsThrottled(key: string, db: Db, nowMs: number): Promise<boolean> {
  try {
    const ref = db.collection("smsThrottles").doc(`childcare_${key}`);
    const snap = await ref.get();
    const last = Number((snap.data() ?? {}).lastSentAtMs ?? 0);
    if (nowMs - last < CHILDCARE_SMS_THROTTLE_MS) return true;
    await ref.set({ lastSentAtMs: nowMs, updatedAt: new Date(nowMs).toISOString() });
    return false;
  } catch {
    return true; // fail closed — skip the SMS, keep the in-app row
  }
}

// ── The fan-out writer (idempotent + exclusion-aware + consent-gated) ────────

export interface ChildcareNotificationEvent {
  /** Immutable canonical source doc path (dedupe key component). */
  sourcePath: string;
  /** Stable event id (trigger eventId / message id / transition key). */
  eventId: string;
  recipientUid: string;
  kind: ChildcareNotificationKind;
  /** Opaque IDs only (bookingId/roomId) — asserted child-safe before write. */
  data?: Record<string, unknown>;
  /** The booking/case record whose excludedUids set gates this fan-out. */
  exclusionRecord?: { excludedUids?: unknown } | null;
  /** Send the template's generic SMS nudge too (consent + throttle gated). */
  smsNudge?: boolean;
  /** Throttle key for the SMS nudge (defaults to sourcePath+recipient). */
  smsThrottleKey?: string;
}

export interface ChildcareNotificationOutcome {
  delivered: boolean;
  inAppCreated: boolean;
  smsSent: boolean;
  skippedReason: "excluded_uid" | "no_recipient" | null;
}

export type ChildcarePushContextDenial =
  | "missing_booking"
  | "invalid_room"
  | "vertical_mismatch"
  | "context_mismatch"
  | "participant_mismatch"
  | "stale_message"
  | "excluded_uid";

export function evaluateChildcarePushContext(params: {
  roomId: string;
  room: Record<string, unknown>;
  message: Record<string, unknown>;
  booking: Record<string, unknown> | null;
  recipientUid: string;
}): { allowed: true } | { allowed: false; reason: ChildcarePushContextDenial } {
  const { roomId, room, message, booking, recipientUid } = params;
  if (
    room.careVertical !== "child" ||
    room.state !== "active" ||
    room.roomId !== roomId
  ) {
    return { allowed: false, reason: "invalid_room" };
  }
  if (room.contextType !== "booking" || typeof room.contextId !== "string" || !room.contextId) {
    return { allowed: false, reason: "context_mismatch" };
  }
  if (!booking) return { allowed: false, reason: "missing_booking" };
  if (booking.careVertical !== "child") {
    return { allowed: false, reason: "vertical_mismatch" };
  }
  const participants = Array.isArray(room.participants)
    ? room.participants.filter((uid): uid is string => typeof uid === "string")
    : [];
  const senderUid = typeof message.senderId === "string" ? message.senderId : "";
  if (
    !senderUid ||
    !participants.includes(senderUid) ||
    !participants.includes(recipientUid) ||
    ![booking.clientId, booking.caregiverId].includes(senderUid) ||
    ![booking.clientId, booking.caregiverId].includes(recipientUid)
  ) {
    return { allowed: false, reason: "participant_mismatch" };
  }
  if (
    message.chatRoomId !== roomId ||
    message.accessVersion !== room.accessVersion
  ) {
    return { allowed: false, reason: "stale_message" };
  }
  if (isExcludedNotificationRecipient(booking, recipientUid)) {
    return { allowed: false, reason: "excluded_uid" };
  }
  return { allowed: true };
}

/**
 * Deliver one generic childcare notification: idempotent in-app row (always,
 * unless excluded) + optional consent-gated generic SMS nudge. NEVER throws —
 * notification failures must not fail the committed state transition.
 */
export async function deliverChildcareNotification(
  event: ChildcareNotificationEvent,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareNotificationOutcome> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const outcome: ChildcareNotificationOutcome = {
    delivered: false,
    inAppCreated: false,
    smsSent: false,
    skippedReason: null,
  };
  try {
    const recipientUid = String(event.recipientUid ?? "").trim();
    if (!recipientUid) {
      outcome.skippedReason = "no_recipient";
      return outcome;
    }
    // AE24: an excluded (suspected-unsafe) party receives NOTHING.
    if (isExcludedNotificationRecipient(event.exclusionRecord ?? null, recipientUid)) {
      outcome.skippedReason = "excluded_uid";
      return outcome;
    }

    const template = getChildcareNotificationTemplate(event.kind);
    const row = {
      type: template.type,
      title: template.title,
      body: template.body,
      data: event.data ?? {},
    };
    assertChildSafeOutboundPayload(row, `notificationPolicy.${event.kind}`);

    // Idempotent in-app row (deterministic operation id — AE15).
    outcome.inAppCreated = await writeUserNotification({
      sourcePath: event.sourcePath,
      eventId: event.eventId,
      recipientId: recipientUid,
      transitionType: event.kind,
      type: template.type,
      title: template.title,
      body: template.body,
      ...(event.data ? { data: event.data } : {}),
    }).catch(() => false);
    outcome.delivered = true;

    // Optional generic SMS nudge — R20 consent receipts first, then throttle.
    if (event.smsNudge && template.sms && outcome.inAppCreated) {
      const consent = await hasLiveChildcareCommunicationConsent(recipientUid, db);
      if (consent) {
        const throttleKey = event.smsThrottleKey ?? `${event.sourcePath}_${recipientUid}`;
        const throttled = await isSmsThrottled(
          throttleKey.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200),
          db,
          now.getTime(),
        );
        if (!throttled) {
          // Lazy import keeps this module's test graph free of the Linq stack.
          const { sendSMSToUser } = await import("../sms");
          const result = await sendSMSToUser(recipientUid, template.sms).catch(() => ({
            success: false,
          }));
          outcome.smsSent = result.success === true;
        }
      }
    }
    return outcome;
  } catch (err) {
    console.error(
      "[notificationPolicy] delivery error (state transition unaffected):",
      err instanceof Error ? err.name : "Error",
    );
    return outcome;
  }
}
