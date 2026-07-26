// ── Childcare context-conversation policy (plan 2026-07-22-002, U9 / R41-R42, KTD14) ──
//
// Childcare family-provider chat is CONTEXT-KEYED, never pairwise (KTD14/R41):
// the server-generated room key = vertical + context type (interview|booking|
// objective) + context ID + participant set. The SAME family-caregiver pair
// coordinating senior AND childcare gets SEPARATE rooms (AE5) — senior rooms
// are pairwise auto-ID docs created by the browser (services/chatService.ts,
// untouched this unit), childcare rooms are deterministic `cchat_…` docs
// created exclusively by the server (rules deny childcare-vertical chatRooms
// creates from the browser).
//
// STRUCTURAL CONTRACTS:
//   • Rooms live in the SHARED `chatRooms` collection as ADDITIVE
//     careVertical:"child" docs so the browser read path (subscribe by room
//     ID) is reusable; every senior consumer keys on the absence of the stamp.
//   • Server-owned lifecycle (R42): creation, participant changes, disclosure
//     phase, and access revocation happen ONLY through this module (Admin
//     SDK). Browser writes to childcare rooms/messages are rules-denied.
//   • Access versioning (KTD13 idiom): every participant change / revocation
//     bumps `accessVersion`; messages stamp the room's accessVersion +
//     disclosurePhase at send time, so a stale grant is visible on every row.
//   • NO SAFETY-DATA INJECTION: this module structurally cannot reach the
//     safety projection or the child private zone — it imports NEITHER
//     safetyProjection NOR childProfileRepository, and the message doc key
//     set is pinned (CHILDCARE_MESSAGE_DOC_KEYS). A static source-scan test
//     (conversationPolicy.test.ts) enforces both.
//   • Generic room metadata (R43): `lastMessage` on a childcare room is ALWAYS
//     the generic preview label — never message text — because room docs are
//     broad-admin readable (senior admin inbox compatibility) while childcare
//     MESSAGE reads are participants-only.
//   • Suspected-unsafe-party exclusion (AE24 hook): notification fan-out
//     filters recipients against an `excludedUids` set on the booking/case
//     record (filterExcludedNotificationRecipients). U12's incident policy
//     supplies the categories that populate the set — the hook is generic
//     here by design (plan U9 approach note).

import * as admin from "firebase-admin";
import { createHash } from "crypto";

export const CHILDCARE_CHAT_ROOM_PREFIX = "cchat_";

/** Generic preview label — the ONLY value ever stored in a childcare room's
 *  lastMessage field (message text never leaves the participants-only
 *  messages subcollection). */
export const CHILDCARE_ROOM_GENERIC_PREVIEW = "New message";

export const CHILDCARE_CONVERSATION_CONTEXT_TYPES = [
  "interview",
  "booking",
  "objective",
] as const;
export type ChildcareConversationContextType =
  (typeof CHILDCARE_CONVERSATION_CONTEXT_TYPES)[number];

export function isChildcareConversationContextType(
  v: unknown,
): v is ChildcareConversationContextType {
  return (
    typeof v === "string" &&
    (CHILDCARE_CONVERSATION_CONTEXT_TYPES as readonly string[]).includes(v)
  );
}

/** R42 disclosure phases. Pre-booking rooms cannot carry restricted child
 *  data BY POLICY; the enforcement is structural (no server code path injects
 *  safety data into messages in ANY phase — see module header). */
export type ChildcareDisclosurePhase = "pre_booking" | "confirmed_booking";

export type ChildcareConversationState = "active" | "revoked";

export interface ChildcareConversationDoc {
  careVertical: "child";
  roomId: string;
  contextType: ChildcareConversationContextType;
  contextId: string;
  householdId: string;
  /** Child authority bindings for targeted synchronous revocation. */
  childIds: string[];
  /** CURRENT participants — revocation removes a uid (rules key reads on this). */
  participants: string[];
  participantNames: string[];
  /** Senior-inbox render parity (InboxView reads index-aligned avatars). */
  participantAvatars: string[];
  disclosurePhase: ChildcareDisclosurePhase;
  /** Bumped on EVERY participant change / revocation / phase advance. */
  accessVersion: number;
  state: ChildcareConversationState;
  revokedReason: string | null;
  /** ALWAYS generic (CHILDCARE_ROOM_GENERIC_PREVIEW or "") — never message text. */
  lastMessage: string;
  lastMessageTime: string;
  lastMessageTimestamp: unknown;
  unreadCount: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

/**
 * EXACT key set of a childcare chat message doc — anything not on this list
 * structurally cannot reach a message row through this module (pinned by
 * tests; the no-safety-injection assertion rides on it).
 */
export const CHILDCARE_MESSAGE_DOC_KEYS = [
  "chatRoomId",
  "senderId",
  "senderName",
  "text",
  "type",
  "disclosurePhase",
  "accessVersion",
  "timestamp",
  "createdAt",
  "isRead",
  "readBy",
] as const;

export interface ChildcareMessageDoc {
  chatRoomId: string;
  senderId: string;
  senderName: string;
  text: string;
  type: "text";
  disclosurePhase: ChildcareDisclosurePhase;
  accessVersion: number;
  /** Server timestamp sentinel — ordering field (senior read-path parity). */
  timestamp: unknown;
  /** Server-side ISO stamp (never client-supplied). */
  createdAt: string;
  isRead: boolean;
  readBy: string[];
}

export const MAX_CHILDCARE_MESSAGE_LENGTH = 2000;

// ── Errors ───────────────────────────────────────────────────────────────────

export type ConversationPolicyErrorCode =
  | "invalid_input"
  | "not_participant"
  | "conversation_revoked"
  | "conversation_not_found"
  | "stale_access_version";

export class ConversationPolicyError extends Error {
  code: ConversationPolicyErrorCode;
  constructor(code: ConversationPolicyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ConversationPolicyError";
    this.code = code;
  }
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

// ── Room key derivation (KTD14 — vertical + context + participants) ──────────

/**
 * Deterministic server-generated room key. Participant order is normalized,
 * so the same (context, pair) always converges to ONE room (create-once,
 * AE15), while:
 *   • a different context (another booking, another interview) → NEW room
 *     (per-context rooms, R41);
 *   • a different participant set (replacement caregiver) → NEW room
 *     (revoke-first substitution gets a fresh room by construction, AE6).
 * Senior pairwise rooms are auto-ID/`{uidA}_{uidB}` docs — the `cchat_`
 * namespace can never collide with them (AE5).
 */
export function childcareConversationDocId(
  contextType: ChildcareConversationContextType,
  contextId: string,
  participants: string[],
): string {
  const cleanContextId = String(contextId ?? "").trim();
  const cleanParticipants = [...new Set(participants.map((p) => String(p ?? "").trim()))]
    .filter(Boolean)
    .sort();
  if (
    !isChildcareConversationContextType(contextType) ||
    !cleanContextId ||
    cleanParticipants.length < 2
  ) {
    throw new ConversationPolicyError("invalid_input");
  }
  return `${CHILDCARE_CHAT_ROOM_PREFIX}${sha1(
    `child|${contextType}|${cleanContextId}|${cleanParticipants.join("|")}`,
  )}`;
}

/** Deduplicated message doc ID when the sender supplies a clientMessageId —
 *  duplicate sends (retries) converge to one row (AE15). */
export function childcareMessageDocId(
  roomId: string,
  senderId: string,
  clientMessageId: string,
): string {
  return `cmsg_${sha1(`${roomId}|${senderId}|${clientMessageId}`)}`;
}

// ── Pure builders ────────────────────────────────────────────────────────────

export interface BuildConversationParams {
  contextType: ChildcareConversationContextType;
  contextId: string;
  householdId: string;
  childIds?: string[];
  participants: string[];
  participantNames: string[];
  disclosurePhase: ChildcareDisclosurePhase;
  now: Date;
}

export function buildChildcareConversationDoc(
  params: BuildConversationParams,
): ChildcareConversationDoc {
  const participants = [...new Set(params.participants.map((p) => String(p ?? "").trim()))]
    .filter(Boolean)
    .sort();
  const roomId = childcareConversationDocId(params.contextType, params.contextId, participants);
  const ts = params.now.toISOString();
  // Names index-align with the SORTED participants (senior-inbox parity).
  const nameByUid = new Map<string, string>();
  params.participants.forEach((uid, i) => {
    const clean = String(uid ?? "").trim();
    if (clean && !nameByUid.has(clean)) {
      nameByUid.set(clean, String(params.participantNames[i] ?? "").trim().slice(0, 80) || "Member");
    }
  });
  return {
    careVertical: "child",
    roomId,
    contextType: params.contextType,
    contextId: String(params.contextId).trim(),
    householdId: String(params.householdId ?? "").trim(),
    childIds: [...new Set((params.childIds ?? []).map((id) => String(id).trim()))]
      .filter(Boolean)
      .sort(),
    participants,
    participantNames: participants.map((uid) => nameByUid.get(uid) ?? "Member"),
    participantAvatars: participants.map(() => ""),
    disclosurePhase: params.disclosurePhase,
    accessVersion: 1,
    state: "active",
    revokedReason: null,
    lastMessage: "",
    lastMessageTime: "",
    lastMessageTimestamp: null,
    unreadCount: Object.fromEntries(participants.map((uid) => [uid, 0])),
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface BuildMessageParams {
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  disclosurePhase: ChildcareDisclosurePhase;
  accessVersion: number;
  now: Date;
}

/**
 * Build a childcare message doc. The ONLY message-doc constructor in the
 * childcare path — its output keys are exactly CHILDCARE_MESSAGE_DOC_KEYS
 * (structural no-safety-injection guard: there is no field a safety
 * projection could ride in on).
 */
export function buildChildcareMessageDoc(params: BuildMessageParams): ChildcareMessageDoc {
  const text = String(params.text ?? "").trim();
  if (!text || text.length > MAX_CHILDCARE_MESSAGE_LENGTH) {
    throw new ConversationPolicyError("invalid_input", "message text is required and bounded");
  }
  const doc: ChildcareMessageDoc = {
    chatRoomId: params.roomId,
    senderId: params.senderId,
    senderName: String(params.senderName ?? "").trim().slice(0, 80) || "Member",
    text,
    type: "text",
    disclosurePhase: params.disclosurePhase,
    accessVersion: Number(params.accessVersion ?? 0),
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: params.now.toISOString(),
    isRead: false,
    readBy: [],
  };
  for (const key of Object.keys(doc)) {
    if (!(CHILDCARE_MESSAGE_DOC_KEYS as readonly string[]).includes(key)) {
      throw new ConversationPolicyError("invalid_input", `message contract violation: "${key}"`);
    }
  }
  return doc;
}

// ── Suspected-unsafe-party exclusion hook (AE24 — categories are U12) ────────

/**
 * Filter a notification recipient list against the `excludedUids` set on a
 * booking/case record. EVERY childcare notification fan-out consults this
 * before writing/sending; U12's incident policy populates the set (an
 * incident hold stamps the suspected party's uid onto the booking/case doc).
 */
export function filterExcludedNotificationRecipients(
  record: { excludedUids?: unknown } | null | undefined,
  recipients: string[],
): string[] {
  const excluded = new Set(
    Array.isArray(record?.excludedUids)
      ? (record?.excludedUids as unknown[]).map((u) => String(u ?? "").trim()).filter(Boolean)
      : [],
  );
  if (excluded.size === 0) return recipients;
  return recipients.filter((uid) => !excluded.has(uid));
}

export function isExcludedNotificationRecipient(
  record: { excludedUids?: unknown } | null | undefined,
  uid: string,
): boolean {
  return filterExcludedNotificationRecipients(record, [uid]).length === 0;
}

// ── Server-owned room lifecycle (R42) ────────────────────────────────────────

function roomRef(db: Db, roomId: string) {
  return db.collection("chatRooms").doc(roomId);
}

/**
 * Create-once for a context conversation (deterministic ID — duplicate opens
 * converge, AE15). Returns the stored doc either way.
 */
export async function ensureChildcareConversation(
  params: BuildConversationParams,
  opts: { db?: Db } = {},
): Promise<{ room: ChildcareConversationDoc; created: boolean }> {
  const db = opts.db ?? defaultDb();
  const doc = buildChildcareConversationDoc(params);
  const ref = roomRef(db, doc.roomId);
  const created = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return false;
    tx.set(ref, doc);
    return true;
  });
  if (created) return { room: doc, created: true };
  const stored = (await ref.get()).data() as ChildcareConversationDoc;
  return { room: stored, created: false };
}

export async function getChildcareConversation(
  roomId: string,
  db: Db = defaultDb(),
): Promise<ChildcareConversationDoc | null> {
  const cleanId = String(roomId ?? "").trim();
  if (!cleanId) return null;
  const snap = await roomRef(db, cleanId).get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as ChildcareConversationDoc;
  return data.careVertical === "child" ? data : null;
}

/** Is `uid` a CURRENT participant of an ACTIVE childcare room? */
export function isCurrentParticipant(
  room: Pick<ChildcareConversationDoc, "participants" | "state" | "careVertical">,
  uid: string,
): boolean {
  return (
    room.careVertical === "child" &&
    room.state === "active" &&
    Array.isArray(room.participants) &&
    room.participants.includes(uid)
  );
}

/**
 * Append a message to an ACTIVE childcare room the sender currently
 * participates in. ONE transaction: fresh room re-read (participant/state/
 * access-version checks against live state), message write (dedupe-keyed when
 * clientMessageId is supplied), and the GENERIC room-metadata update — the
 * room's lastMessage never carries message text (R43; room docs are
 * admin-inbox readable, messages are not).
 *
 * Returns the recipients (current participants minus sender) so the caller
 * owns notification fan-out (where the excludedUids hook applies).
 */
export async function appendChildcareMessage(
  params: {
    roomId: string;
    senderId: string;
    text: string;
    clientMessageId?: string | null;
    /** Optional optimistic pin from a stale UI — mismatch fails closed. */
    expectedAccessVersion?: number | null;
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<{
  messageId: string;
  created: boolean;
  room: ChildcareConversationDoc;
  recipients: string[];
}> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const roomId = String(params.roomId ?? "").trim();
  const senderId = String(params.senderId ?? "").trim();
  if (!roomId || !senderId) throw new ConversationPolicyError("invalid_input");

  return db.runTransaction(async (tx) => {
    const ref = roomRef(db, roomId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ConversationPolicyError("conversation_not_found");
    const room = (snap.data() ?? {}) as ChildcareConversationDoc;
    if (room.careVertical !== "child") throw new ConversationPolicyError("conversation_not_found");
    if (room.state !== "active") throw new ConversationPolicyError("conversation_revoked");
    if (!Array.isArray(room.participants) || !room.participants.includes(senderId)) {
      throw new ConversationPolicyError("not_participant");
    }
    if (
      params.expectedAccessVersion !== undefined &&
      params.expectedAccessVersion !== null &&
      Number(params.expectedAccessVersion) !== Number(room.accessVersion)
    ) {
      throw new ConversationPolicyError("stale_access_version");
    }

    const senderIdx = room.participants.indexOf(senderId);
    const senderName = room.participantNames?.[senderIdx] ?? "Member";
    const message = buildChildcareMessageDoc({
      roomId,
      senderId,
      senderName,
      text: params.text,
      disclosurePhase: room.disclosurePhase ?? "pre_booking",
      accessVersion: Number(room.accessVersion ?? 0),
      now,
    });

    const clientMessageId = String(params.clientMessageId ?? "").trim();
    const messageId = clientMessageId
      ? childcareMessageDocId(roomId, senderId, clientMessageId)
      : `cmsg_${sha1(`${roomId}|${senderId}|${now.getTime()}|${Math.random()}`)}`;
    const messageRef = ref.collection("messages").doc(messageId);

    if (clientMessageId) {
      const existing = await tx.get(messageRef);
      if (existing.exists) {
        // Duplicate send converges — no metadata bump, no re-notification.
        return { messageId, created: false, room, recipients: [] };
      }
    }

    const recipients = room.participants.filter((uid) => uid !== senderId);
    const unreadCount = { ...(room.unreadCount ?? {}) };
    for (const uid of recipients) unreadCount[uid] = Number(unreadCount[uid] ?? 0) + 1;

    tx.set(messageRef, message as unknown as Record<string, unknown>);
    tx.set(ref, {
      ...room,
      lastMessage: CHILDCARE_ROOM_GENERIC_PREVIEW, // generic — NEVER message text
      lastMessageTime: now.toISOString(),
      lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      unreadCount,
      updatedAt: now.toISOString(),
    });
    return { messageId, created: true, room, recipients };
  });
}

/** Reset the caller's own unread counter (U11 UI seam; server-owned update). */
export async function markChildcareConversationRead(
  roomId: string,
  uid: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<void> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  await db.runTransaction(async (tx) => {
    const ref = roomRef(db, roomId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ConversationPolicyError("conversation_not_found");
    const room = (snap.data() ?? {}) as ChildcareConversationDoc;
    if (room.careVertical !== "child") throw new ConversationPolicyError("conversation_not_found");
    // Revoked rooms stay readable to REMAINING participants; read-marking is
    // allowed for anyone still on the participant list, active or revoked.
    if (!Array.isArray(room.participants) || !room.participants.includes(uid)) {
      throw new ConversationPolicyError("not_participant");
    }
    tx.set(ref, {
      ...room,
      unreadCount: { ...(room.unreadCount ?? {}), [uid]: 0 },
      updatedAt: now.toISOString(),
    });
  });
}

// ── Revocation semantics (R42/AE6 — always an accessVersion bump) ────────────

/**
 * Remove one participant from a childcare room (durable revoke): the uid
 * drops off `participants` (rules read access dies with it), the
 * accessVersion bumps, and — when fewer than two participants remain — the
 * room is marked revoked so nobody can write into a one-sided context.
 * Idempotent: revoking an already-removed uid still bumps monotonically only
 * when a change happened.
 */
export async function revokeChildcareConversationParticipant(
  roomId: string,
  uid: string,
  opts: { db?: Db; now?: Date; reason: string },
): Promise<ChildcareConversationDoc | null> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  return db.runTransaction(async (tx) => {
    const ref = roomRef(db, roomId);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const room = (snap.data() ?? {}) as ChildcareConversationDoc;
    if (room.careVertical !== "child") return null;
    const participants = (room.participants ?? []).filter((p) => p !== uid);
    if (participants.length === (room.participants ?? []).length && room.state === "revoked") {
      return room; // idempotent no-op
    }
    if (participants.length === (room.participants ?? []).length) {
      // uid was not a participant — nothing to revoke on this room.
      return room;
    }
    const idx = (room.participants ?? []).indexOf(uid);
    const participantNames = (room.participantNames ?? []).filter((_, i) => i !== idx);
    const participantAvatars = (room.participantAvatars ?? []).filter((_, i) => i !== idx);
    const unreadCount = { ...(room.unreadCount ?? {}) };
    delete unreadCount[uid];
    const next: ChildcareConversationDoc = {
      ...room,
      participants,
      participantNames,
      participantAvatars,
      unreadCount,
      accessVersion: Number(room.accessVersion ?? 0) + 1,
      state: participants.length < 2 ? "revoked" : room.state,
      revokedReason:
        participants.length < 2
          ? String(opts.reason ?? "").slice(0, 100) || "revoked"
          : room.revokedReason ?? null,
      updatedAt: now.toISOString(),
    };
    tx.set(ref, next);
    return next;
  });
}

/**
 * Revoke ALL conversation access tied to a booking context (cancellation,
 * incident hold): every `cchat_` room with contextType "booking" +
 * contextId == bookingId is marked revoked (writes die for everyone), the
 * accessVersion bumps, and — when `revokeUid` is given (the caregiver on a
 * cancellation, the OLD caregiver on a substitution step 1) — that uid also
 * drops off the participant list so their READ access dies too while the
 * family keeps their own history. Fail-soft per room; returns count touched.
 */
export async function revokeChildcareConversationsForBooking(
  bookingId: string,
  opts: { db?: Db; now?: Date; reason: string; revokeUid?: string | null },
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const cleanBookingId = String(bookingId ?? "").trim();
  if (!cleanBookingId) return 0;

  // Equality-only query — no composite index needed (contextType+contextId
  // are only ever set on childcare rooms).
  const snap = await db
    .collection("chatRooms")
    .where("careVertical", "==", "child")
    .where("contextType", "==", "booking")
    .where("contextId", "==", cleanBookingId)
    .get();

  let touched = 0;
  for (const doc of snap.docs) {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(roomRef(db, doc.id));
      if (!fresh.exists) return;
      const room = (fresh.data() ?? {}) as ChildcareConversationDoc;
      if (room.careVertical !== "child") return;
      const revokeUid = String(opts.revokeUid ?? "").trim();
      let participants = room.participants ?? [];
      let participantNames = room.participantNames ?? [];
      let participantAvatars = room.participantAvatars ?? [];
      const unreadCount = { ...(room.unreadCount ?? {}) };
      if (revokeUid && participants.includes(revokeUid)) {
        const idx = participants.indexOf(revokeUid);
        participants = participants.filter((p) => p !== revokeUid);
        participantNames = participantNames.filter((_, i) => i !== idx);
        participantAvatars = participantAvatars.filter((_, i) => i !== idx);
        delete unreadCount[revokeUid];
      }
      if (room.state === "revoked" && participants.length === (room.participants ?? []).length) {
        return; // already fully revoked and nothing more to remove
      }
      tx.set(roomRef(db, doc.id), {
        ...room,
        participants,
        participantNames,
        participantAvatars,
        unreadCount,
        state: "revoked",
        revokedReason: String(opts.reason ?? "").slice(0, 100) || "revoked",
        accessVersion: Number(room.accessVersion ?? 0) + 1,
        updatedAt: now.toISOString(),
      });
      touched++;
    });
  }
  return touched;
}

/**
 * Authority-change fan-out (U2 outbox hook, R19/AE20): remove an adult from
 * every childcare conversation of a household. Called durably from
 * guardianAuthority's derived_access_invalidation effect AFTER the caller
 * confirmed the adult no longer holds live `message` scope. Query contract
 * Q43 (careVertical + participants array-contains); household filtered in
 * memory (bounded — an adult's room list is small).
 */
export async function revokeChildcareConversationsForAdultInHousehold(
  householdId: string,
  adultUid: string,
  opts: { db?: Db; now?: Date; reason?: string } = {},
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const cleanHousehold = String(householdId ?? "").trim();
  const cleanUid = String(adultUid ?? "").trim();
  if (!cleanHousehold || !cleanUid) return 0;

  const snap = await db
    .collection("chatRooms")
    .where("careVertical", "==", "child")
    .where("participants", "array-contains", cleanUid)
    .get();

  let touched = 0;
  for (const doc of snap.docs) {
    const room = (doc.data() ?? {}) as ChildcareConversationDoc;
    if (room.householdId !== cleanHousehold) continue;
    const next = await revokeChildcareConversationParticipant(doc.id, cleanUid, {
      db,
      now: opts.now,
      reason: opts.reason ?? "authority_change",
    });
    if (next) touched++;
  }
  return touched;
}

/**
 * Advance every booking-context room of a booking to the confirmed
 * disclosure phase (called on the exactly-once confirm transition). Bumps
 * accessVersion (a phase change is an access-relevant change — messages
 * stamp the phase they were sent under).
 */
export async function advanceChildcareConversationPhaseForBooking(
  bookingId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const cleanBookingId = String(bookingId ?? "").trim();
  if (!cleanBookingId) return 0;
  const snap = await db
    .collection("chatRooms")
    .where("careVertical", "==", "child")
    .where("contextType", "==", "booking")
    .where("contextId", "==", cleanBookingId)
    .get();
  let advanced = 0;
  for (const doc of snap.docs) {
    const room = (doc.data() ?? {}) as ChildcareConversationDoc;
    if (room.state !== "active" || room.disclosurePhase === "confirmed_booking") continue;
    await roomRef(db, doc.id)
      .update({
        disclosurePhase: "confirmed_booking",
        accessVersion: Number(room.accessVersion ?? 0) + 1,
        updatedAt: now.toISOString(),
      })
      .catch(() => {});
    advanced++;
  }
  return advanced;
}

/**
 * List the childcare conversations `uid` currently participates in (server
 * read for v1-listMyChildcareConversations). Query contract Q43; sorted by
 * lastMessageTime in memory (bounded list — no orderBy so one composite
 * serves both this and the revocation fan-out).
 */
export async function listChildcareConversationsForUser(
  uid: string,
  opts: { db?: Db; limit?: number } = {},
): Promise<ChildcareConversationDoc[]> {
  const db = opts.db ?? defaultDb();
  const cleanUid = String(uid ?? "").trim();
  if (!cleanUid) return [];
  const snap = await db
    .collection("chatRooms")
    .where("careVertical", "==", "child")
    .where("participants", "array-contains", cleanUid)
    .get();
  const rooms = snap.docs
    .map((d) => (d.data() ?? {}) as ChildcareConversationDoc)
    .sort((a, b) => String(b.lastMessageTime || b.createdAt || "").localeCompare(
      String(a.lastMessageTime || a.createdAt || ""),
    ));
  return rooms.slice(0, Math.max(1, Math.min(opts.limit ?? 50, 100)));
}
