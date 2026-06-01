import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  createChat,
  sendMessage,
  addParticipant,
  updateChatName,
  removeParticipant,
} from "../linq/client";

const db = admin.firestore();

// ── Callable: triggered from FamilyManager UI ─────────────────────────────────

export const createFamilyGroup = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }

  const seniorId: string = data.seniorId ?? context.auth.uid;

  try {
    await buildOrUpdateFamilyGroup(seniorId);
    return { success: true };
  } catch (err: any) {
    console.error("createFamilyGroup error:", err);
    throw new functions.https.HttpsError("internal", err.message ?? "Failed to create group");
  }
});

// ── Core logic (also called when a new member with phone is added) ─────────────

export async function buildOrUpdateFamilyGroup(seniorId: string): Promise<void> {
  // Load senior profile for name + family members
  const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
  const senior     = seniorSnap.data();
  if (!senior) return;

  const seniorName: string = senior.name ?? "Your loved one";
  const familyMembers: any[] = senior.familyMembers ?? [];

  // Collect all phones that have sessions (primary client + family members with phones)
  const primarySnap = await db.collection("users").doc(seniorId).get();
  const primaryPhone: string | undefined = primarySnap.data()?.phone;

  const familyPhones: string[] = familyMembers
    .map((m) => m.phone)
    .filter((p): p is string => !!p);

  const allPhones = [...new Set([...(primaryPhone ? [primaryPhone] : []), ...familyPhones])];

  if (allPhones.length < 2) return; // need at least 2 for a group

  // Check if a group chat already exists for this senior
  const existingSnap = await db
    .collection("family_groups")
    .where("seniorId", "==", seniorId)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    // Group exists — add any new phones that aren't already in it
    const groupDoc  = existingSnap.docs[0];
    const groupData = groupDoc.data();
    const existing  = new Set<string>(groupData.phones ?? []);
    const chatId: string = groupData.chatId;

    for (const phone of allPhones) {
      if (!existing.has(phone)) {
        await addParticipant(chatId, phone).catch(() => {});
        await sendMessage(chatId, `Welcome to the group! You'll receive care updates here and can text the assistant anytime.`);
        await groupDoc.ref.update({
          phones: admin.firestore.FieldValue.arrayUnion(phone),
        });
      }
    }
    return;
  }

  // Create new group chat — first phone initiates, rest join
  const [firstPhone, ...rest] = allPhones;
  const groupChat = await createChat(firstPhone, {
    parts: [{
      type:  "text",
      value:
        `Hi everyone — I'm Cara, the AI care assistant for ${seniorName}'s care.\n\n` +
        `I'll send care updates here so everyone stays in the loop. ` +
        `Anyone can text me questions anytime.`,
    }],
    effect: { type: "screen", name: "hearts" },
  });

  const chatId = groupChat.chat_id;

  // Add remaining family members
  for (const phone of rest) {
    await addParticipant(chatId, phone).catch(() => {});
  }

  // Name the group
  await updateChatName(chatId, `${seniorName.split(" ")[0]}'s Care · Cara`);

  // Persist group record
  await db.collection("family_groups").add({
    seniorId,
    chatId,
    phones:    allPhones,
    createdAt: new Date().toISOString(),
  });

  // Update each participant's agent_session with the group chatId
  for (const phone of allPhones) {
    await db
      .collection("agent_sessions")
      .doc(phone)
      .set({ groupChatId: chatId }, { merge: true });
  }
}

// ── removeMemberFromGroup — called from webhook REMOVE_FAMILY_MEMBER handler ──

export async function removeMemberFromGroup(
  seniorId:   string,
  targetPhone: string
): Promise<{ removed: boolean; reason?: string }> {
  const groupSnap = await db.collection("family_groups")
    .where("seniorId", "==", seniorId)
    .limit(1)
    .get();

  if (groupSnap.empty) {
    return { removed: false, reason: "no_group" };
  }

  const groupDoc  = groupSnap.docs[0];
  const groupData = groupDoc.data();
  const phones: string[] = groupData.phones ?? [];

  if (!phones.includes(targetPhone)) {
    return { removed: false, reason: "not_in_group" };
  }

  const chatId: string = groupData.chatId;

  // Remove from Linq group chat
  await removeParticipant(chatId, targetPhone).catch(() => {});

  // Update Firestore group record
  await groupDoc.ref.update({
    phones: admin.firestore.FieldValue.arrayRemove(targetPhone),
  });

  // Clear groupChatId from the removed member's session
  await db.collection("agent_sessions").doc(targetPhone)
    .update({ groupChatId: admin.firestore.FieldValue.delete() })
    .catch(() => {});

  console.log(`[removeMemberFromGroup] Removed ${targetPhone} from group for senior ${seniorId}`);
  return { removed: true };
}
