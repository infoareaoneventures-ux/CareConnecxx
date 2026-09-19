// The website's "Message our team" room, server-side — the SAME chatRooms
// document services/chatService.ts createOrGetSupportRoom creates from the
// header popover (participants [uid, careconnex-support], isSupport: true),
// and the same message shape chatService.sendMessage writes. One room per
// person, whichever door they came in: the site button, a text to Evia
// ("I want to talk to a person"), or Evia's own low-confidence handoff.
// Built 2026-09-19 (founder: "can they chat with us through Evia").
import * as admin from "firebase-admin";

export const SUPPORT_AGENT_ID = "careconnex-support";
export const SUPPORT_AGENT_NAME = "Evia team";

const db = admin.firestore();

export type SupportRole = "client" | "caregiver";

/** Who should be told about a new message in a room — pure, so the trigger's branching is testable. */
export function resolveSupportRouting(
  room: { participants?: unknown; isSupport?: unknown } | undefined,
  message: { senderId?: unknown; type?: unknown },
): { kind: "not_support" } | { kind: "skip" } | { kind: "alert_team"; userId: string } | { kind: "relay_to_user"; userId: string } {
  if (!room || room.isSupport !== true) return { kind: "not_support" };
  const participants = Array.isArray(room.participants) ? (room.participants as string[]) : [];
  const userId = participants.find((p) => p !== SUPPORT_AGENT_ID);
  if (!userId) return { kind: "skip" };
  if (message.type === "system") return { kind: "skip" };
  // The family or caregiver wrote → the team must hear about it (nothing else
  // in the room can receive a text). Anyone else (an admin replying, or the
  // support account) → relay to the person by text, like any Inbox message.
  return String(message.senderId ?? "") === userId ? { kind: "alert_team", userId } : { kind: "relay_to_user", userId };
}

async function displayNameFor(userId: string, fallback: string): Promise<string> {
  const snap = await db.collection("users").doc(userId).get().catch(() => null);
  const d = (snap?.data() ?? {}) as Record<string, unknown>;
  const full = [d.firstName, d.lastName].filter(Boolean).join(" ").trim();
  return (typeof d.displayName === "string" && d.displayName.trim()) || full || fallback;
}

export async function getOrCreateSupportRoom(userId: string, userName?: string): Promise<string> {
  const snap = await db.collection("chatRooms").where("participants", "array-contains", userId).get();
  const existing = snap.docs.find((d) => d.data().isSupport === true);
  if (existing) return existing.id;
  const name = userName?.trim() || await displayNameFor(userId, "Member");
  const ref = await db.collection("chatRooms").add({
    participants: [userId, SUPPORT_AGENT_ID],
    participantNames: [name, SUPPORT_AGENT_NAME],
    participantAvatars: ["", ""],
    lastMessage: "",
    lastMessageTime: "",
    lastMessageTimestamp: null,
    unreadCount: { [userId]: 0, [SUPPORT_AGENT_ID]: 0 },
    isSupport: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function postSupportMessage(
  roomId: string,
  msg: { senderId: string; senderName: string; text: string; type?: "text" | "system" },
): Promise<string> {
  const roomRef = db.collection("chatRooms").doc(roomId);
  const roomSnap = await roomRef.get();
  const room = (roomSnap.data() ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const msgRef = await roomRef.collection("messages").add({
    chatRoomId: roomId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    text: msg.text,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: now,
    isRead: false,
    readBy: [],
    type: msg.type ?? "text",
    imageUrl: null,
  });
  const participants = Array.isArray(room.participants) ? (room.participants as string[]) : [];
  const unread = { ...((room.unreadCount as Record<string, number> | undefined) ?? {}) };
  for (const p of participants) if (p !== msg.senderId) unread[p] = (unread[p] ?? 0) + 1;
  await roomRef.set({
    lastMessage: msg.text,
    lastMessageTime: now,
    lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    unreadCount: unread,
  }, { merge: true });
  return msgRef.id;
}

/** The founder's phone hears about it (adminAlertNotifier texts ADMIN_PHONE for this type) and the admin panel lists it. */
export async function alertTeamAboutSupportMessage(input: {
  userId: string; roomId: string; preview: string; source: string; role?: SupportRole | null;
}): Promise<void> {
  await db.collection("admin_alerts").add({
    type: "support_message",
    severity: "medium",
    priority: "medium",
    userId: input.userId,
    role: input.role ?? null,
    roomId: input.roomId,
    message: input.preview.slice(0, 300),
    source: input.source,
    createdAt: new Date().toISOString(),
    resolved: false,
  }).catch((err) => console.error("alertTeamAboutSupportMessage failed", err));
}

/**
 * A person asked Evia for a human: their words go into their support room as
 * THEIR message (the room's onMessageSent trigger then alerts the team, exactly
 * as if they had used the website's button).
 */
export async function relayToTeam(input: { userId: string; text: string; userName?: string }): Promise<{ roomId: string }> {
  const roomId = await getOrCreateSupportRoom(input.userId, input.userName);
  const name = input.userName?.trim() || await displayNameFor(input.userId, "Member");
  await postSupportMessage(roomId, { senderId: input.userId, senderName: name, text: input.text });
  return { roomId };
}

/**
 * Evia herself hands a conversation to the team (low-confidence hold): a
 * system note in the room — never texted back to the person — plus the alert.
 */
export async function escalateToTeam(input: { userId: string; note: string; source: string; role?: SupportRole | null }): Promise<{ roomId: string }> {
  const roomId = await getOrCreateSupportRoom(input.userId);
  await postSupportMessage(roomId, { senderId: SUPPORT_AGENT_ID, senderName: "Evia", text: input.note, type: "system" });
  await alertTeamAboutSupportMessage({ userId: input.userId, roomId, preview: input.note, source: input.source, role: input.role });
  return { roomId };
}
