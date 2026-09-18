// The website's Inbox page (components/InboxView.tsx + services/chatService.ts),
// read the way the page reads it:
//   · the thread list = chatRooms where participants array-contains the user,
//     newest lastMessageTimestamp first, minus rooms the user soft-deleted
//     (deletedAt[uid]) and minus blocked users; the search box matches the
//     contact's name or the last message; grouped into My Care Team (partners
//     on an accepted booking_requests doc), Other Caregivers, and Support
//     (isSupport rooms); each row shows the last message or "Start a
//     conversation" and its unread badge (unreadCount[uid]).
//   · opening a thread = the room's messages, oldest → newest, hiding anything
//     before the later of deletedAt[uid] / messagesCutoff[uid], and it marks
//     the thread read exactly like chatService.markMessagesAsRead.
// Sending lives in utils/chatThread.ts (= chatService.sendMessage).
import * as admin from "firebase-admin";
import { chatRoomIdFor } from "../utils/chatThread";
import { businessTodayStr, formatInterviewTime } from "../utils/scheduledTime";

const db = admin.firestore();

export type InboxSection = "care_team" | "other" | "support";

export interface InboxRoomRow {
  roomId: string;
  withId: string | null;
  withName: string;
  withAvatar: string | null;
  section: InboxSection;
  /** The row's second line — the page shows "Start a conversation" for an empty room. */
  lastMessagePreview: string;
  lastMessage: string | null;
  lastMessageTime: string | null;
  unread: number;
}

export interface InboxThreadMessage {
  from: "you" | string;
  fromId: string | null;
  text: string;
  /** Raw stored timestamp (Firestore Timestamp or ISO string). */
  timestamp: unknown;
  /** YYYY-MM-DD in the business time zone, for the page's date separators. */
  date: string | null;
  /** Human time, e.g. "Tue, Sep 22 at 2:00 PM". */
  when: string | null;
}

export interface InboxThread {
  roomId: string;
  withId: string | null;
  withName: string;
  messages: InboxThreadMessage[];
  messagesMarkedRead: number;
}

const toMs = (ts: unknown): number => {
  if (!ts) return 0;
  const t = ts as { toMillis?: () => number; seconds?: number };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  if (typeof ts === "string") { const p = Date.parse(ts); return Number.isFinite(p) ? p : 0; }
  return 0;
};

function otherParticipant(room: Record<string, unknown>, userId: string): { id: string | null; name: string; avatar: string | null } {
  const participants = (room.participants as string[] | undefined) ?? [];
  const names = (room.participantNames as string[] | undefined) ?? [];
  const avatars = (room.participantAvatars as string[] | undefined) ?? [];
  const idx = participants.findIndex((p) => p !== userId);
  return {
    id: idx >= 0 ? participants[idx] : null,
    name: (idx >= 0 ? names[idx] : "") || "Unknown",
    avatar: (idx >= 0 ? avatars[idx] : "") || null,
  };
}

// InboxView.tsx careTeamIds: partners on an accepted booking_requests doc.
async function careTeamPartnerIds(userId: string, role: "client" | "caregiver"): Promise<Set<string>> {
  const field = role === "client" ? "clientId" : "caregiverId";
  const otherField = role === "client" ? "caregiverId" : "clientId";
  const snap = await db.collection("booking_requests").where(field, "==", userId).where("status", "==", "accepted").get();
  const ids = new Set<string>();
  snap.docs.forEach((d) => { const other = d.data()[otherField]; if (typeof other === "string" && other) ids.add(other); });
  return ids;
}

export async function listInboxRooms(
  userId: string,
  opts: { role?: "client" | "caregiver"; query?: string } = {},
): Promise<{ rooms: InboxRoomRow[]; sections: { careTeam: InboxRoomRow[]; other: InboxRoomRow[]; support: InboxRoomRow[] }; unreadTotal: number; total: number }> {
  const role = opts.role ?? "client";
  const [roomsSnap, userSnap, careTeamIds] = await Promise.all([
    db.collection("chatRooms").where("participants", "array-contains", userId).orderBy("lastMessageTimestamp", "desc").get(),
    db.collection("users").doc(userId).get(),
    careTeamPartnerIds(userId, role),
  ]);
  const blocked = new Set<string>(((userSnap.data()?.blockedUsers as string[] | undefined) ?? []));
  const q = (opts.query ?? "").trim().toLowerCase();

  const rows: InboxRoomRow[] = [];
  for (const d of roomsSnap.docs) {
    const room = d.data() as Record<string, unknown>;
    // subscribeToChatRooms drops rooms this user soft-deleted.
    if ((room.deletedAt as Record<string, unknown> | undefined)?.[userId]) continue;
    const other = otherParticipant(room, userId);
    if (other.id && blocked.has(other.id)) continue;
    const lastMessage = typeof room.lastMessage === "string" ? room.lastMessage : "";
    if (q && !other.name.toLowerCase().includes(q) && !lastMessage.toLowerCase().includes(q)) continue;
    const isSupport = room.isSupport === true;
    rows.push({
      roomId: d.id,
      withId: other.id,
      withName: other.name,
      withAvatar: other.avatar,
      section: isSupport ? "support" : (other.id && careTeamIds.has(other.id)) ? "care_team" : "other",
      lastMessagePreview: lastMessage || "Start a conversation",
      lastMessage: lastMessage || null,
      lastMessageTime: typeof room.lastMessageTime === "string" && room.lastMessageTime ? room.lastMessageTime : null,
      unread: Number((room.unreadCount as Record<string, number> | undefined)?.[userId] ?? 0) || 0,
    });
  }
  return {
    rooms: rows,
    sections: {
      careTeam: rows.filter((r) => r.section === "care_team"),
      other: rows.filter((r) => r.section === "other"),
      support: rows.filter((r) => r.section === "support"),
    },
    unreadTotal: rows.reduce((sum, r) => sum + r.unread, 0),
    total: rows.length,
  };
}

// chatService.markMessagesAsRead: every still-unread message in the room gets
// isRead:true + this user in readBy (no senderId filter — the site marks any
// unread message, including this user's own), then unreadCount[uid] = 0.
export async function markThreadRead(userId: string, roomId: string): Promise<number> {
  const roomRef = db.collection("chatRooms").doc(roomId);
  const unreadSnap = await roomRef.collection("messages").where("isRead", "==", false).get();
  let marked = 0;
  await Promise.all(unreadSnap.docs.map(async (m) => {
    const readBy = (m.data()?.readBy as string[] | undefined) ?? [];
    if (readBy.includes(userId)) return;
    await m.ref.set({ isRead: true, readBy: admin.firestore.FieldValue.arrayUnion(userId) }, { merge: true });
    marked++;
  }));
  await roomRef.set({ [`unreadCount.${userId}`]: 0 }, { merge: true });
  return marked;
}

export async function readInboxThread(userId: string, counterpartId: string, limit = 20): Promise<InboxThread | null> {
  const roomId = chatRoomIdFor(userId, counterpartId);
  const roomRef = db.collection("chatRooms").doc(roomId);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) return null;
  const room = (roomSnap.data() ?? {}) as Record<string, unknown>;
  const deletedAt = (room.deletedAt as Record<string, unknown> | undefined)?.[userId];
  const cutoff = (room.messagesCutoff as Record<string, unknown> | undefined)?.[userId];
  // The page hides a soft-deleted room from the list entirely.
  if (deletedAt) return null;
  const effectiveCutoffMs = toMs(cutoff);
  const other = otherParticipant(room, userId);

  const msgsSnap = await roomRef.collection("messages").orderBy("timestamp", "desc").limit(Math.max(1, Math.min(limit, 50))).get();
  const messages: InboxThreadMessage[] = msgsSnap.docs.reverse()
    .map((m) => m.data() as Record<string, unknown>)
    .filter((msg) => !effectiveCutoffMs || !msg.timestamp || toMs(msg.timestamp) > effectiveCutoffMs)
    .map((msg) => {
      const ms = toMs(msg.timestamp) || toMs(msg.createdAt);
      return {
        from: msg.senderId === userId ? "you" : ((msg.senderName as string | undefined) || other.name),
        fromId: (msg.senderId as string | undefined) ?? null,
        text: String(msg.text ?? "").slice(0, 500),
        timestamp: msg.timestamp ?? null,
        date: ms ? businessTodayStr(undefined, new Date(ms)) : null,
        when: ms ? formatInterviewTime(ms) : null,
      };
    });

  // Opening a conversation marks it read on the page.
  const messagesMarkedRead = await markThreadRead(userId, roomId).catch(() => 0);
  return { roomId, withId: other.id, withName: other.name, messages, messagesMarkedRead };
}
