// Mirrors Cara SMS/iMessage conversations into the web chat model
// (threads/{threadId}/messages) so families and caregivers see their Cara
// history in the web inbox (Chat.tsx / ChatInbox.tsx read threads where
// participants array-contains their uid).
//
// Thread doc ID is deterministic — `cara_{userId}` — so inbound and outbound
// mirrors land in the same thread without a lookup race. Mirroring is strictly
// best-effort: failures are logged and never block message delivery.

import * as admin from "firebase-admin";

const db = admin.firestore();

export const CARA_SENDER_ID = "cara";

// Inline SVG so the web inbox renders an avatar without external requests.
const CARA_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='50' fill='%237c3aed'/%3E%3Ctext x='50' y='62' font-size='40' font-family='sans-serif' fill='white' text-anchor='middle'%3EC%3C/text%3E%3C/svg%3E";

// chatId → userId lookups are hot (every outbound send) — memoize per instance.
const chatUserCache = new Map<string, string | null>();

async function resolveUserId(params: { userId?: string; chatId?: string }): Promise<string | null> {
  if (params.userId) return params.userId;
  if (!params.chatId) return null;
  if (chatUserCache.has(params.chatId)) return chatUserCache.get(params.chatId)!;
  let userId: string | null = null;
  try {
    const snap = await db.collection("agent_sessions")
      .where("chatId", "==", params.chatId)
      .limit(1)
      .get();
    userId = snap.empty ? null : ((snap.docs[0].data().userId as string | undefined) ?? null);
  } catch (err) {
    console.warn("threadMirror: chatId→userId lookup failed", err);
    return null; // don't cache failures
  }
  chatUserCache.set(params.chatId, userId);
  return userId;
}

export async function mirrorToWebThread(params: {
  userId?:   string;
  chatId?:   string;
  direction: "inbound" | "outbound"; // inbound = user → Cara, outbound = Cara → user
  text:      string;
}): Promise<void> {
  try {
    const text = (params.text ?? "").trim();
    if (!text) return;

    const userId = await resolveUserId(params);
    if (!userId) return; // pre-onboarding (no auth account yet) — nothing to mirror to

    const threadId  = `cara_${userId}`;
    const threadRef = db.collection("threads").doc(threadId);
    const preview   = text.substring(0, 100);

    await threadRef.set({
      id:            threadId,
      participants:  [userId, CARA_SENDER_ID],
      contactName:   "Cara",
      contactAvatar: CARA_AVATAR,
      isCaraThread:  true,
      lastMessage:   preview,
      lastMessageTime: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      // Only Cara's replies count as unread for the web user; their own
      // (inbound SMS) messages are already read by definition.
      unreadCount:   params.direction === "outbound" ? admin.firestore.FieldValue.increment(1) : 0,
    }, { merge: true });

    await threadRef.collection("messages").add({
      text,
      senderId:  params.direction === "inbound" ? userId : CARA_SENDER_ID,
      isRead:    params.direction === "inbound",
      source:    "cara_sms",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("threadMirror: mirror failed (non-blocking)", err);
  }
}

// Extracts mirrorable plain text from a structured Linq message (text parts
// only — links are included, media parts are summarized).
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
