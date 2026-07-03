// Mirrors Evia SMS/iMessage conversations into the web chat model
// (threads/{threadId}/messages) so families and caregivers see their Evia
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

  // Resolve the direct lookup first; only fall back to group resolution when no
  // direct session matches. Cache keys are namespaced by lookup type ("direct:"
  // vs "group:") so a chatId that happens to equal some other session's
  // groupChatId can never return the wrong branch's cached userIds.
  let userIds: string[] = [];
  try {
    const directKey = `direct:${params.chatId}`;
    const directCached = chatUserCache.get(directKey);
    if (directCached && Date.now() - directCached.cachedAt < CHAT_USER_CACHE_TTL_MS) {
      return directCached.userIds;
    }
    if (directCached) chatUserCache.delete(directKey); // expired — re-query below

    const directSnap = await db.collection("agent_sessions")
      .where("chatId", "==", params.chatId)
      .limit(1)
      .get();

    if (!directSnap.empty) {
      const userId = directSnap.docs[0].data().userId as string | undefined;
      if (userId) userIds = [userId];
      chatUserCache.set(directKey, { userIds, cachedAt: Date.now() });
      return userIds;
    }

    const groupKey = `group:${params.chatId}`;
    const groupCached = chatUserCache.get(groupKey);
    if (groupCached && Date.now() - groupCached.cachedAt < CHAT_USER_CACHE_TTL_MS) {
      return groupCached.userIds;
    }
    if (groupCached) chatUserCache.delete(groupKey); // expired — re-query below

    // Mirror every member of a family group, bounded by a generous cap far
    // above realistic family size to avoid an unbounded scan. We query for one
    // more than the cap so we can tell "exactly at cap" (complete) from "over
    // cap" (truly truncated) and only warn — rather than silently dropping
    // members from their web inbox — in the latter case.
    const GROUP_MIRROR_LIMIT = 50;
    const groupSnap = await db.collection("agent_sessions")
      .where("groupChatId", "==", params.chatId)
      .limit(GROUP_MIRROR_LIMIT + 1)
      .get();
    if (groupSnap.docs.length > GROUP_MIRROR_LIMIT) {
      console.warn(`threadMirror: group ${params.chatId} exceeded the ${GROUP_MIRROR_LIMIT}-member mirror cap — some members may be missing from web-inbox mirroring; investigate.`);
    }
    userIds = [...new Set(groupSnap.docs
      .slice(0, GROUP_MIRROR_LIMIT)
      .map((doc) => doc.data().userId as string | undefined)
      .filter((id): id is string => !!id))];
    chatUserCache.set(groupKey, { userIds, cachedAt: Date.now() });
    return userIds;
  } catch (err) {
    console.warn("threadMirror: chatId->userId lookup failed", err);
    return [];
  }
}

export async function mirrorToWebThread(params: {
  userId?:   string;
  chatId?:   string;
  direction: "inbound" | "outbound"; // inbound = user -> Evia, outbound = Evia -> user
  text:      string;
  /** Message origin ("cara_sms" default; "cara_web" for web-chat turns). */
  source?:   string;
  /** Client-generated id from the web composer, used to reconcile optimistic
   *  bubbles and to keep retries from duplicating the message. */
  clientMessageId?: string;
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
        contactName:   "Evia",
        contactAvatar: CARA_AVATAR,
        isCaraThread:  true,
        lastMessage:   preview,
        lastMessageTime: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        // Only Evia's outbound replies add to the web-inbox unread badge. For
        // inbound (user -> Evia) we OMIT unreadCount entirely so merge:true
        // preserves any existing unread from earlier Evia replies the user
        // hasn't opened in the web inbox — writing 0 here would wipe it.
        ...(params.direction === "outbound"
          ? { unreadCount: admin.firestore.FieldValue.increment(1) }
          : {}),
      }, { merge: true });

      await threadRef.collection("messages").add({
        text,
        senderId:  params.direction === "inbound" ? userId : CARA_SENDER_ID,
        isRead:    params.direction === "inbound",
        source:    params.source ?? "cara_sms",
        ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
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
