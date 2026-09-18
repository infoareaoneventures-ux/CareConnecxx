import * as admin from "firebase-admin";

const db = admin.firestore();

// Mirrors services/chatService.ts's chatRooms/{roomId}/messages shape exactly
// (repo root, frontend-only, can't be imported into functions/) so a message
// relayed by Evia lands in the SAME persisted, two-way thread the website's
// Inbox reads from — not just a one-off SMS with no visible reply path.
// Room id matches FindCaregivers.tsx's openChat(): sorted([clientId,
// caregiverId]).join('_').

export function chatRoomIdFor(clientId: string, caregiverId: string): string {
  return [clientId, caregiverId].sort().join("_");
}

export async function relayIntoSharedChatThread(opts: {
  clientId: string; clientName: string;
  caregiverId: string; caregiverName: string;
  senderId: string; senderName: string;
  text: string;
}): Promise<void> {
  const { clientId, clientName, caregiverId, caregiverName, senderId, senderName, text } = opts;
  const participants = [clientId, caregiverId].sort();
  const nameById: Record<string, string> = { [clientId]: clientName, [caregiverId]: caregiverName };
  const participantNames = participants.map((id) => nameById[id] ?? "");
  const roomId = participants.join("_");
  const roomRef = db.collection("chatRooms").doc(roomId);
  const roomSnap = await roomRef.get();
  const recipientId = participants.find((id) => id !== senderId) ?? participants[0];
  const nowIso = new Date().toISOString();

  if (!roomSnap.exists) {
    await roomRef.set({
      participants,
      participantNames,
      participantAvatars: ["", ""],
      lastMessage: "",
      lastMessageTime: "",
      lastMessageTimestamp: null,
      unreadCount: { [clientId]: 0, [caregiverId]: 0 },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await roomRef.collection("messages").doc().set({
    chatRoomId: roomId,
    senderId,
    senderName,
    text,
    timestamp:  admin.firestore.FieldValue.serverTimestamp(),
    createdAt:  nowIso,
    isRead:     false,
    readBy:     [] as string[],
    type:       "text",
    imageUrl:   null,
    // The recipient already got a guaranteed-delivery SMS as part of this same
    // relayIntoSharedChatThread call (see the trySend/sendSMSToUser above the
    // caller of this function) — the chatRooms-message-created trigger that
    // texts the recipient on a new message (notifications.ts onMessageSent)
    // must skip this message, or the recipient gets double-texted for one.
  });

  // Mirrors chatService.ts's sendMessage exactly: clear deletedAt for BOTH
  // participants (not just the sender) so a new message always resurfaces the
  // conversation for whichever side had soft-deleted it — previously only the
  // sender's deletedAt was cleared, so a message relayed after the RECIPIENT
  // soft-deleted the conversation went silently missing from their inbox.
  // Preserve any existing deletedAt as messagesCutoff so pre-deletion messages
  // stay hidden (InboxView.tsx reads this to filter history on resurface).
  const roomData = roomSnap.data() ?? {};
  const existingDeletedAt = (roomData as any).deletedAt ?? {};
  const existingCutoff = (roomData as any).messagesCutoff ?? {};
  const toMs = (ts: any) => ts?.toMillis?.() ?? (ts?.seconds ? ts.seconds * 1000 : 0);

  const roomUpdate: Record<string, unknown> = {
    lastMessage:          text,
    lastMessageTime:      nowIso,
    lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    [`unreadCount.${recipientId}`]: admin.firestore.FieldValue.increment(1),
  };
  for (const uid of participants) {
    roomUpdate[`deletedAt.${uid}`] = admin.firestore.FieldValue.delete();
    if (existingDeletedAt[uid] && (!existingCutoff[uid] || toMs(existingDeletedAt[uid]) > toMs(existingCutoff[uid]))) {
      roomUpdate[`messagesCutoff.${uid}`] = existingDeletedAt[uid];
    }
  }
  await roomRef.set(roomUpdate, { merge: true });
}
