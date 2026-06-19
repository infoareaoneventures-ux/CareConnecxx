// Mirrors Cara SMS/iMessage conversations into the web chat model
// (threads/{threadId}/messages) so families and caregivers see their Cara
// history in the web inbox (Chat.tsx / ChatInbox.tsx read threads where
// participants array-contains their uid).
//
// Thread doc ID is deterministic: `cara_{userId}`. Mirroring is strictly
// best-effort: failures are logged and never block message delivery.

import * as admin from "firebase-admin";

const db = admin.firestore();

export const CARA_SENDER_ID = "cara";

// Inline SVG so the web inbox renders an avatar without external requests.
const CARA_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='50' fill='%237c3aed'/%3E%3Ctext x='50' y='62' font-size='40' font-family='sans-serif' fill='white' text-anchor='middle'%3EC%3C/text%3E%3C/svg%3E";

// chatId/groupChatId -> userId lookups are hot, so memoize per instance. The
// cache is TTL'd so a newly added family-group member is discovered within the
// window instead of being invisible until the instance recycles.
const CHAT_USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const chatUserCache = new Map<string, { userIds: string[]; cachedAt: number }>();

async function resolveUserIds(params: { userId?: string; chatId?: string }): Promise<string[]> {
  if (params.userId) return [params.userId];
  if (!params.chatId) return [];
  const cached = chatUserCache.get(params.chatId);
  if (cached && Date.now() - cached.cachedAt < CHAT_USER_CACHE_TTL_MS) {
    return cached.userIds;
  }
  if (cached) chatUserCache.delete(params.chatId); // expired — re-query below

  let userIds: string[] = [];
  try {
    const directSnap = await db.collection("agent_sessions")
      .where("chatId", "==", params.chatId)
      .limit(1)
      .get();

    if (!directSnap.empty) {
      const userId = directSnap.docs[0].data().userId as string | undefined;
      if (userId) userIds = [userId];
    } else {
      // Mirror every member of a family group, bounded by a generous cap far
      // above realistic family size to avoid an unbounded scan. If a group ever
      // hits the cap we warn (rather than silently dropping members from their
      // web inbox) so operators can investigate.
      const GROUP_MIRROR_LIMIT = 50;
      const groupSnap = await db.collection("agent_sessions")
        .where("groupChatId", "==", params.chatId)
        .limit(GROUP_MIRROR_LIMIT)
        .get();
      if (groupSnap.docs.length === GROUP_MIRROR_LIMIT) {
        console.warn(`threadMirror: group ${params.chatId} hit the ${GROUP_MIRROR_LIMIT}-member mirror cap — some members may be missing from web-inbox mirroring; investigate.`);
      }
      userIds = [...new Set(groupSnap.docs
        .map((doc) => doc.data().userId as string | undefined)
        .filter((id): id is string => !!id))];
    }
  } catch (err) {
    console.warn("threadMirror: chatId->userId lookup failed", err);
    return [];
  }

  chatUserCache.set(params.chatId, { userIds, cachedAt: Date.now() });
  return userIds;
}

export async function mirrorToWebThread(params: {
  userId?:   string;
  chatId?:   string;
  direction: "inbound" | "outbound"; // inbound = user -> Cara, outbound = Cara -> user
  text:      string;
}): Promise<void> {
  try {
    const text = (params.text ?? "").trim();
    if (!text) return;

    const userIds = await resolveUserIds(params);
    if (userIds.length === 0) return; // pre-onboarding: nothing to mirror to

    const preview = text.substring(0, 100);

    // Mirror to each member's thread concurrently — they're independent docs
    // (cara_{userId}), so parallelizing avoids 2N sequential round-trips on the
    // message-delivery path.
    await Promise.all(userIds.map(async (userId) => {
      const threadId  = `cara_${userId}`;
      const threadRef = db.collection("threads").doc(threadId);

      await threadRef.set({
        id:            threadId,
        participants:  [userId, CARA_SENDER_ID],
        contactName:   "Cara",
        contactAvatar: CARA_AVATAR,
        isCaraThread:  true,
        lastMessage:   preview,
        lastMessageTime: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        // Only Cara's replies count as unread for the web user; their own
        // inbound SMS messages are already read by definition.
        unreadCount:   params.direction === "outbound" ? admin.firestore.FieldValue.increment(1) : 0,
      }, { merge: true });

      await threadRef.collection("messages").add({
        text,
        senderId:  params.direction === "inbound" ? userId : CARA_SENDER_ID,
        isRead:    params.direction === "inbound",
        source:    "cara_sms",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }));
  } catch (err) {
    console.warn("threadMirror: mirror failed (non-blocking)", err);
  }
}

// Extracts mirrorable plain text from a structured Linq message. Text and link
// parts are included; media parts are summarized.
export function extractMirrorText(message: { parts?: Array<{ type: string; value?: string }> }): string {
  if (!message.parts?.length) return "";
  return message.parts
    .map((p) => {
      if (p.type === "text" || p.type === "link") return p.value ?? "";
      return p.type === "media" ? "[attachment]" : "";
    })
    .filter(Boolean)
    .join("\n");
}
