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
  });

  await roomRef.set({
    lastMessage:          text,
    lastMessageTime:      nowIso,
    lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    [`unreadCount.${recipientId}`]: admin.firestore.FieldValue.increment(1),
    [`deletedAt.${senderId}`]:      admin.firestore.FieldValue.delete(),
  }, { merge: true });
}
