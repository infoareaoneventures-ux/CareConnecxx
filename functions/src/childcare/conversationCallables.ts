// ── Childcare conversation callables (plan 2026-07-22-002, U9 / R20, R35, R41-R43) ──
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   openChildcareConversation, sendChildcareMessage,
//   listMyChildcareConversations, getChildcareConversationMessages,
//   markChildcareConversationRead, getChildcareBookingCoordination
//
// Every callable stacks the R21 controls in the U2/U3 order: requireAppCheck →
// Auth → Firestore-resident childcare flags (R61) → fail-closed rate limits →
// input bounds + idempotency → object-level authorization → enumeration-safe
// errors.
//
// STRUCTURAL CONTRACTS:
//   • KTD14/R41: rooms are context-keyed (vertical + interview|booking context
//     + participants) with server-owned creation — openChildcareConversation
//     is CONTEXT-VALIDATED (interview or booking participants only) and
//     create-once per context. The senior pairwise path (services/
//     chatService.ts) is untouched (AE5).
//   • R42: sends re-check CURRENT participation + room state + access version
//     against a fresh transactional read; server timestamps only.
//   • NO SAFETY-DATA INJECTION: message writes go exclusively through
//     conversationPolicy.appendChildcareMessage (pinned key set; that module
//     imports neither safetyProjection nor the child repository — static
//     source-scan test). The coordination callable below is the ONLY place
//     this module touches the safety machinery, and its payload goes to the
//     authenticated CALLER response — never into messages, notifications, or
//     logs.
//   • R43/KTD16: message notifications are generic registry templates
//     (in-app idempotent row + consent-gated generic SMS nudge); the
//     excludedUids hook filters every fan-out (AE24).
//   • ADDRESS DELIVERY (deferred from U7): getChildcareBookingCoordination —
//     assigned caregiver + current access version + confirmed/in_progress +
//     eligibility recheck → exact address + arrival notes from the child
//     private zone via the versioned coordination projection (U7 revoke-first
//     machinery — substitution/cancellation revokes address access
//     identically). Family side: checkAuthority 'view' per child. Reads are
//     audit-logged (IDs only).

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { checkAuthority, GuardianAuthorityError } from "./guardianAuthority";
import {
  recheckChildcareProviderEligibility,
} from "./providerEligibility";
import {
  appendChildcareMessage,
  ensureChildcareConversation,
  getChildcareConversation,
  listChildcareConversationsForUser,
  markChildcareConversationRead as markReadCore,
  ConversationPolicyError,
  isChildcareConversationContextType,
  type ChildcareConversationContextType,
  type ChildcareConversationDoc,
  type ChildcareDisclosurePhase,
} from "./conversationPolicy";
import { deliverChildcareNotification } from "./notificationPolicy";
import { readBookingCoordination, SafetyProjectionError } from "./safetyProjection";
import type { ChildcareBookingDoc } from "./bookingPolicy";

// ── Shared guard helpers (U2/U3 middleware idiom) ────────────────────────────

const CONVERSATION_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: "rl:childcare:conv:mut:",
};
const CONVERSATION_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:conv:read:",
};
const COORDINATION_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: "rl:childcare:coord:read:",
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(kind: "read" | "write"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok = kind === "write" ? flags.writesEnabled : flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** ONE generic error for every not-found/not-authorized shape (enumeration-safe). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

function invalidArgument(): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", "Invalid request.");
}

function mapConversationError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ConversationPolicyError) {
    if (err.code === "invalid_input") throw invalidArgument();
    if (err.code === "stale_access_version") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This conversation changed since you loaded it. Please refresh and try again.",
        { code: "stale_access_version" },
      );
    }
    // not_participant / conversation_revoked / conversation_not_found —
    // indistinguishable (wrong room IDs are enumeration-safe).
    throw permissionDenied();
  }
  if (err instanceof SafetyProjectionError) {
    if (err.code === "invalid_input") throw invalidArgument();
    if (err.code === "stale_projection") {
      // Only reachable by an already-authorized caller (same rationale as the
      // U7 safety read): the family changed details; a fresh version is due.
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Details were updated by the family. Please try again shortly.",
        { code: "stale_projection" },
      );
    }
    throw permissionDenied();
  }
  if (err instanceof GuardianAuthorityError) {
    if ((err as { code?: string }).code === "invalid_input") throw invalidArgument();
    throw permissionDenied();
  }
  console.error("[conversationCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

// ── Context validation (interview | booking participants only) ───────────────

/** Interview statuses in which the adult-to-adult room may open (pre-booking). */
const OPENABLE_INTERVIEW_STATUSES = new Set(["requested", "accepted", "confirmed", "scheduled"]);
/** Booking statuses in which the room may open (canceled/declined never). */
const OPENABLE_BOOKING_STATUSES = new Set([
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
  "completed",
]);

interface ValidatedContext {
  contextType: ChildcareConversationContextType;
  contextId: string;
  householdId: string;
  clientId: string;
  caregiverId: string;
  disclosurePhase: ChildcareDisclosurePhase;
  childIds: string[];
  /** The record whose excludedUids set gates notification fan-out. */
  exclusionRecord: { excludedUids?: unknown } | null;
}

async function validateConversationContext(
  db: Db,
  actorUid: string,
  contextType: string,
  contextId: string,
): Promise<ValidatedContext> {
  if (contextType === "booking") {
    const snap = await db.collection("booking_requests").doc(contextId).get();
    const booking = (snap.data() ?? {}) as Partial<ChildcareBookingDoc> & {
      excludedUids?: unknown;
    };
    if (
      !snap.exists ||
      booking.careVertical !== "child" ||
      !OPENABLE_BOOKING_STATUSES.has(String(booking.status ?? ""))
    ) {
      throw permissionDenied();
    }
    if (booking.clientId !== actorUid && booking.caregiverId !== actorUid) {
      throw permissionDenied();
    }
    return {
      contextType: "booking",
      contextId,
      householdId: String(booking.householdId ?? ""),
      clientId: String(booking.clientId ?? ""),
      caregiverId: String(booking.caregiverId ?? ""),
      disclosurePhase:
        booking.status === "confirmed" || booking.status === "in_progress" || booking.status === "completed"
          ? "confirmed_booking"
          : "pre_booking",
      childIds: Array.isArray(booking.childIds) ? booking.childIds.map(String) : [],
      exclusionRecord: booking,
    };
  }

  if (contextType === "interview") {
    const snap = await db.collection("video_interviews").doc(contextId).get();
    const interview = (snap.data() ?? {}) as Record<string, unknown>;
    if (
      !snap.exists ||
      interview.careVertical !== "child" ||
      !OPENABLE_INTERVIEW_STATUSES.has(String(interview.status ?? ""))
    ) {
      throw permissionDenied();
    }
    const clientId = String(interview.clientId ?? "");
    const caregiverId = String(interview.caregiverId ?? "");
    if (clientId !== actorUid && caregiverId !== actorUid) throw permissionDenied();

    // Child linkage lives in the job's server-only private subdoc (R33).
    const jobId = String(interview.jobId ?? "");
    let householdId = "";
    let childIds: string[] = [];
    if (jobId) {
      const privSnap = await db
        .collection("job_posts")
        .doc(jobId)
        .collection("private")
        .doc("children")
        .get();
      const priv = (privSnap.data() ?? {}) as Record<string, unknown>;
      householdId = String(priv.householdId ?? "");
      childIds = Array.isArray(priv.childIds) ? (priv.childIds as unknown[]).map(String) : [];
    }
    return {
      contextType: "interview",
      contextId,
      householdId,
      clientId,
      caregiverId,
      disclosurePhase: "pre_booking", // interview rooms NEVER confirmed-phase
      childIds,
      exclusionRecord: interview as { excludedUids?: unknown },
    };
  }

  throw invalidArgument();
}

/** Family actors need LIVE `message` scope for every child in the context;
 *  provider actors pass the R29 "contact" eligibility recheck. */
async function requireActorMayMessage(
  db: Db,
  actorUid: string,
  context: ValidatedContext,
): Promise<void> {
  if (actorUid === context.caregiverId) {
    const eligibility = await recheckChildcareProviderEligibility(actorUid, {
      context: "contact",
      db: db as never,
    });
    if (!eligibility.eligible) throw permissionDenied();
    return;
  }
  // Family adult: per-child `message` scope, live (R42/AE4).
  if (context.childIds.length === 0) throw permissionDenied();
  for (const childId of context.childIds) {
    const decision = await checkAuthority(actorUid, childId, "message", { db });
    if (!decision.allowed) throw permissionDenied();
  }
}

// ── openChildcareConversation ────────────────────────────────────────────────

export const openChildcareConversation = childcareOnCall("openChildcareConversation", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("openChildcareConversation", uid, CONVERSATION_MUTATION_RATE);

  const contextType = String(data?.contextType ?? "").trim();
  const contextId = String(data?.contextId ?? "").trim();
  if (
    !isChildcareConversationContextType(contextType) ||
    contextType === "objective" || // objective-context rooms are a later-unit surface
    !contextId ||
    contextId.length > 128
  ) {
    throw invalidArgument();
  }

  try {
    const db = defaultDb();
    const now = new Date();
    const validated = await validateConversationContext(db, uid, contextType, contextId);
    await requireActorMayMessage(db, uid, validated);

    const [clientName, caregiverName] = await Promise.all([
      db.collection("users").doc(validated.clientId).get()
        .then((s) => String((s.data() ?? {}).name ?? "Family")),
      db.collection("caregivers").doc(validated.caregiverId).get()
        .then((s) => String((s.data() ?? {}).name ?? "Caregiver")),
    ]);

    const { room, created } = await ensureChildcareConversation(
      {
        contextType: validated.contextType,
        contextId: validated.contextId,
        householdId: validated.householdId,
        childIds: validated.childIds,
        participants: [validated.clientId, validated.caregiverId],
        participantNames: [clientName, caregiverName],
        disclosurePhase: validated.disclosurePhase,
        now,
      },
      { db },
    );

    if (created) {
      await logAudit({
        eventType: "childcare_conversation_opened",
        userId: uid,
        data: { roomId: room.roomId, contextType, contextId },
      }).catch(() => {});
    }
    return {
      success: true,
      roomId: room.roomId,
      created,
      disclosurePhase: room.disclosurePhase,
      accessVersion: room.accessVersion,
    };
  } catch (err) {
    mapConversationError(err);
  }
});

// ── sendChildcareMessage ─────────────────────────────────────────────────────

export const sendChildcareMessage = childcareOnCall("sendChildcareMessage", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("sendChildcareMessage", uid, CONVERSATION_MUTATION_RATE);

  const roomId = String(data?.roomId ?? "").trim();
  const text = String(data?.text ?? "");
  const clientMessageId = String(data?.clientMessageId ?? "").trim() || null;
  const expectedAccessVersion =
    data?.expectedAccessVersion != null ? Number(data.expectedAccessVersion) : null;
  if (!roomId || roomId.length > 128) throw invalidArgument();
  if (clientMessageId && clientMessageId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();

    // Consent/authority recheck at SEND time: participation alone is not
    // enough — a family adult whose `message` scope was revoked (but whose
    // room removal is still in the durable outbox) fails HERE, live (R42).
    const room = await getChildcareConversation(roomId, db);
    if (!room || !room.participants?.includes(uid)) throw permissionDenied();
    let exclusionRecord: { excludedUids?: unknown } | null = null;
    if (room.contextType === "booking") {
      const bookingSnap = await db.collection("booking_requests").doc(room.contextId).get();
      const booking = (bookingSnap.data() ?? {}) as Partial<ChildcareBookingDoc> & {
        excludedUids?: unknown;
      };
      exclusionRecord = bookingSnap.exists ? booking : null;
      if (bookingSnap.exists && booking.clientId === uid) {
        for (const childId of booking.childIds ?? []) {
          const decision = await checkAuthority(uid, String(childId), "message", { db });
          if (!decision.allowed) throw permissionDenied();
        }
      }
    }

    const result = await appendChildcareMessage(
      { roomId, senderId: uid, text, clientMessageId, expectedAccessVersion },
      { db, now },
    );

    if (result.created) {
      // Generic fan-out (R43/KTD16/AE24): idempotent in-app row per message +
      // consent-gated generic SMS nudge; excluded uids receive nothing.
      for (const recipientUid of result.recipients) {
        await deliverChildcareNotification(
          {
            sourcePath: `chatRooms/${roomId}`,
            eventId: result.messageId,
            recipientUid,
            kind: "childcare_message",
            data: { chatRoomId: roomId },
            exclusionRecord,
            smsNudge: true,
            smsThrottleKey: `msg_${roomId}_${recipientUid}`,
          },
          { db, now },
        );
      }
    }
    return {
      success: true,
      messageId: result.messageId,
      created: result.created,
      duplicate: !result.created,
    };
  } catch (err) {
    mapConversationError(err);
  }
});

// ── listMyChildcareConversations ─────────────────────────────────────────────

export const listMyChildcareConversations = childcareOnCall("listMyChildcareConversations", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("listMyChildcareConversations", uid, CONVERSATION_READ_RATE);

  try {
    const db = defaultDb();
    const rooms = await listChildcareConversationsForUser(uid, { db });
    return {
      success: true,
      conversations: rooms.map((room: ChildcareConversationDoc) => ({
        roomId: room.roomId,
        contextType: room.contextType,
        contextId: room.contextId,
        participants: room.participants,
        participantNames: room.participantNames,
        disclosurePhase: room.disclosurePhase,
        state: room.state,
        accessVersion: room.accessVersion,
        lastMessage: room.lastMessage, // always the generic preview label
        lastMessageTime: room.lastMessageTime,
        unreadCount: Number(room.unreadCount?.[uid] ?? 0),
      })),
    };
  } catch (err) {
    mapConversationError(err);
  }
});

// ── getChildcareConversationMessages (paginated) ─────────────────────────────

export const getChildcareConversationMessages = childcareOnCall("getChildcareConversationMessages", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getChildcareConversationMessages", uid, CONVERSATION_READ_RATE);

  const roomId = String(data?.roomId ?? "").trim();
  const pageSize = Math.max(1, Math.min(Number(data?.limit ?? 50) || 50, 100));
  const beforeCreatedAt = String(data?.beforeCreatedAt ?? "").trim() || null;
  if (!roomId || roomId.length > 128) throw invalidArgument();
  if (beforeCreatedAt && beforeCreatedAt.length > 64) throw invalidArgument();

  try {
    const db = defaultDb();
    // CURRENT participants only — a revoked adult/provider loses reads here
    // AND at the rules layer (they are off the participants array).
    const room = await getChildcareConversation(roomId, db);
    if (!room || !Array.isArray(room.participants) || !room.participants.includes(uid)) {
      throw permissionDenied();
    }

    let query = db
      .collection("chatRooms")
      .doc(roomId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(pageSize + 1) as FirebaseFirestore.Query;
    if (beforeCreatedAt) query = query.where("createdAt", "<", beforeCreatedAt);
    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const hasMore = snap.docs.length > pageSize;

    return {
      success: true,
      messages: docs
        .map((d) => {
          const m = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            senderId: m.senderId,
            senderName: m.senderName,
            text: m.text,
            type: m.type,
            disclosurePhase: m.disclosurePhase,
            createdAt: m.createdAt,
          };
        })
        .reverse(),
      cursor: hasMore ? String(docs[docs.length - 1]?.data()?.createdAt ?? "") : null,
      hasMore,
    };
  } catch (err) {
    mapConversationError(err);
  }
});

// ── markChildcareConversationRead (U11 UI seam) ──────────────────────────────

export const markChildcareConversationRead = childcareOnCall("markChildcareConversationRead", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("markChildcareConversationRead", uid, CONVERSATION_READ_RATE);

  const roomId = String(data?.roomId ?? "").trim();
  if (!roomId || roomId.length > 128) throw invalidArgument();

  try {
    await markReadCore(roomId, uid, { db: defaultDb() });
    return { success: true };
  } catch (err) {
    mapConversationError(err);
  }
});

// ── getChildcareBookingCoordination (THE exact-address callable) ─────────────

export const getChildcareBookingCoordination = childcareOnCall("getChildcareBookingCoordination", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getChildcareBookingCoordination", uid, COORDINATION_READ_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
    const booking = (bookingSnap.data() ?? {}) as Partial<ChildcareBookingDoc>;
    if (!bookingSnap.exists || booking.careVertical !== "child") throw permissionDenied();

    let callerRole: "provider" | "family";
    if (booking.caregiverId === uid) {
      callerRole = "provider";
    } else if (booking.clientId === uid) {
      // Family side: LIVE `view` scope per child (plan U9 requirement).
      for (const childId of booking.childIds ?? []) {
        const decision = await checkAuthority(uid, String(childId), "view", { db });
        if (!decision.allowed) throw permissionDenied();
      }
      callerRole = "family";
    } else {
      throw permissionDenied();
    }

    const result = await readBookingCoordination(
      { bookingId, callerUid: uid, callerRole },
      { db },
    );

    // Audit the read — IDs and versions ONLY, never the address (R57).
    await logAudit({
      eventType: "childcare_coordination_read",
      userId: uid,
      data: {
        bookingId,
        role: callerRole,
        version: result.version,
        accessVersion: result.accessVersion,
      },
    }).catch(() => {});

    return {
      success: true,
      bookingId,
      version: result.version,
      coordination: result.coordination.map((c) => ({
        childId: c.childId,
        addressDetail: c.addressDetail,
        arrivalNotes: c.arrivalNotes,
      })),
    };
  } catch (err) {
    mapConversationError(err);
  }
});
