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

// ── Callable: triggered from the public /join invite page (JoinFamilyPage) ────
// The /join page is unauthenticated by design — family members land there from
// an invite link before they have any account. Authorization is the invite
// token itself: the payload's primaryPhone must belong to an existing Cara
// session, otherwise the request is rejected.

export const addFamilyGroupMember = functions.https.onCall(async (data, _context) => {
  const primaryPhone: unknown = data?.primaryPhone;
  const memberPhone: unknown = data?.memberPhone;

  const E164 = /^\+\d{10,15}$/;
  if (typeof primaryPhone !== "string" || !E164.test(primaryPhone)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invitation");
  }
  if (typeof memberPhone !== "string" || !E164.test(memberPhone)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid member phone number is required");
  }

  try {
    // Validate the invite: the primary phone must belong to an existing session
    const sessionRef  = db.collection("agent_sessions").doc(primaryPhone);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Invalid invitation");
    }
    const session = sessionSnap.data() ?? {};

    // Dedupe: already a member → succeed silently
    const existingSnap = await db.collection("family_group_members")
      .where("primaryPhone", "==", primaryPhone)
      .where("memberPhone",  "==", memberPhone)
      .limit(1)
      .get();

    if (existingSnap.empty) {
      // Mirror the webhook ADD_FAMILY_MEMBER data model
      await sessionRef.update({
        groupMembers: admin.firestore.FieldValue.arrayUnion(memberPhone),
      });
      await db.collection("family_group_members").add({
        primaryPhone,
        memberPhone,
        memberName: "Family member",
        userId:     session.userId ?? primaryPhone,
        addedAt:    new Date().toISOString(),
      });
    }

    // Best-effort: add the new member to the existing Linq group chat, if any
    try {
      const groupSnap = await db.collection("family_groups")
        .where("phones", "array-contains", primaryPhone)
        .limit(1)
        .get();
      if (!groupSnap.empty) {
        const groupDoc = groupSnap.docs[0];
        const phones: string[] = groupDoc.data().phones ?? [];
        const chatId: string   = groupDoc.data().chatId;
        if (!phones.includes(memberPhone)) {
          await addParticipant(chatId, memberPhone).catch(() => {});
          await groupDoc.ref.update({
            phones: admin.firestore.FieldValue.arrayUnion(memberPhone),
          });
          await db.collection("agent_sessions").doc(memberPhone)
            .set({ groupChatId: chatId }, { merge: true });
        }
      }
    } catch (err) {
      console.error("addFamilyGroupMember group-chat join failed:", err);
    }

    return { success: true };
  } catch (err: any) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("addFamilyGroupMember error:", err);
    throw new functions.https.HttpsError("internal", err.message ?? "Failed to join group");
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
