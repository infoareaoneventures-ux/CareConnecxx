// ── LEGACY-COMPAT BOUNDARY (childcare plan 2026-07-22-002, U2) ────────────────
// This module is the legacy PHONE-KEYED family-group flow (Linq group chat +
// phones-in-list membership). It is classified
// legacy-compat-remove-after-migration in the childcare consumer manifest and
// stays SENIOR-ONLY: a recycled phone number satisfies the phone-in-list rule,
// so NO child-vertical data may ever flow through these readers. The canonical
// replacement is childcare/householdRepository.ts (memberships) +
// childcare/guardianAuthority.ts (explicit recipient-scoped grants); SMS-joined
// adults map to PROVISIONAL memberships with zero grantable scopes there.
// Do not extend this module with childcare behavior.

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  createChat,
  sendMessage,
  sendToPhone,
  addParticipant,
  updateChatName,
  removeParticipant,
} from "../linq/client";
import { logAudit } from "../observability/auditLog";
import { logAgentAction } from "../observability/actionLedger";
import { generateToken, verifyToken } from "./tokenService";

const db = admin.firestore();
const E164 = /^\+\d{10,15}$/;

export function familyMemberDocId(primaryPhone: string, memberPhone: string): string {
  return `${primaryPhone}_${memberPhone}`.replace(/\//g, "_");
}

export function createFamilyJoinToken(primaryPhone: string, seniorName: string, ttlSeconds = 7 * 24 * 60 * 60): string {
  if (!E164.test(primaryPhone)) throw new Error("Invalid primary phone");
  return generateToken({ phone: primaryPhone, task: "family_join", seniorName }, ttlSeconds);
}

export function verifyFamilyJoinToken(token: unknown): { primaryPhone: string; seniorName: string } | null {
  if (typeof token !== "string" || !token.trim()) return null;
  const payload = verifyToken(token);
  if (!payload || payload.task !== "family_join" || !E164.test(payload.phone)) return null;
  return {
    primaryPhone: payload.phone,
    seniorName: typeof payload.seniorName === "string" && payload.seniorName.trim()
      ? payload.seniorName.trim()
      : "your loved one",
  };
}

export async function resolvePrimaryPhone(userId: string): Promise<string | undefined> {
  const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
  const userPhone = userSnap?.data()?.phone as string | undefined;
  if (userPhone) return userPhone;

  const sessionSnap = await db.collection("agent_sessions")
    .where("userId", "==", userId)
    .limit(1)
    .get()
    .catch(() => null);
  if (!sessionSnap || sessionSnap.empty) return undefined;
  return (sessionSnap.docs[0].data() as any).phone ?? sessionSnap.docs[0].id;
}

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
// The /join page is unauthenticated by design. Authorization is a signed,
// expiring family_join token; caller-supplied phones or names are never trusted.

export const addFamilyGroupMember = functions.https.onCall(async (data, _context) => {
  const invite = verifyFamilyJoinToken(data?.token);
  const memberPhone: unknown = data?.memberPhone;

  if (!invite) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invitation");
  }
  if (typeof memberPhone !== "string" || !E164.test(memberPhone)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid member phone number is required");
  }
  const { primaryPhone, seniorName } = invite;

  try {
    // Validate the invite: the primary phone must belong to an existing session
    const sessionRef  = db.collection("agent_sessions").doc(primaryPhone);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Invalid invitation");
    }
    const session = sessionSnap.data() ?? {};

    // Dedupe: deterministic doc ID + atomic create() so concurrent requests
    // converge on a single membership doc (no check-then-add race).
    // Create the membership doc FIRST so a create failure leaves no partial
    // state; the arrayUnion update is idempotent, so running it after an
    // ALREADY_EXISTS "success" is safe.
    try {
      // Mirror the webhook ADD_FAMILY_MEMBER data model.
      await db.collection("family_group_members")
        .doc(familyMemberDocId(primaryPhone, memberPhone))
        .create({
          primaryPhone,
          memberPhone,
          memberName: "Family member",
          userId:     session.userId ?? primaryPhone,
          seniorName,
          source:      "join_page",
          addedAt:    new Date().toISOString(),
        });
    } catch (err: any) {
      // ALREADY_EXISTS (gRPC code 6) → already a member, succeed silently
      if (err?.code !== 6 && err?.code !== "already-exists") throw err;
    }
    await sessionRef.update({
      groupMembers: admin.firestore.FieldValue.arrayUnion(memberPhone),
    });

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
          let addedToLinq = true;
          await addParticipant(chatId, memberPhone).catch((err) => {
            addedToLinq = false;
            console.warn(`addFamilyGroupMember: addParticipant failed for chat ${chatId}, member ${memberPhone}:`, err);
            logAudit({
              eventType: "family_group_participant_add_failed",
              userId: session.userId ?? primaryPhone,
              phone: primaryPhone,
              data: { primaryPhone, memberPhone, chatId, error: err instanceof Error ? err.message : String(err) },
            }).catch(() => {});
            logAgentAction({
              actionType: "family_group_participant_add",
              status: "failed",
              userId: session.userId ?? primaryPhone,
              phone: primaryPhone,
              role: "family",
              targetCollection: "family_groups",
              targetDocId: groupDoc.id,
              errorReason: err instanceof Error ? err.message : String(err),
              metadata: { memberPhone, chatId },
            }).catch(() => {});
          });
          if (addedToLinq) {
            await groupDoc.ref.update({
              phones: admin.firestore.FieldValue.arrayUnion(memberPhone),
            });
            await db.collection("agent_sessions").doc(memberPhone)
              .set({ groupChatId: chatId }, { merge: true });
            logAudit({
              eventType: "family_group_participant_added",
              userId: session.userId ?? primaryPhone,
              phone: primaryPhone,
              data: { primaryPhone, memberPhone, chatId, source: "join_page" },
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error("addFamilyGroupMember group-chat join failed:", err);
    }

    let welcomeSent = true;
    await sendToPhone(
      memberPhone,
      `Hi - you've joined ${seniorName}'s Evia care group. I'm Evia, and I'll send care updates here. You can text me questions anytime. Reply STOP to opt out.`,
    ).catch((err) => {
      welcomeSent = false;
      logAudit({
        eventType: "family_member_welcome_failed",
        userId: session.userId ?? primaryPhone,
        phone: memberPhone,
        data: { primaryPhone, memberPhone, source: "join_page", error: err instanceof Error ? err.message : String(err) },
      }).catch(() => {});
    });
    if (welcomeSent) {
      logAudit({
        eventType: "family_member_welcome_sent",
        userId: session.userId ?? primaryPhone,
        phone: memberPhone,
        data: { primaryPhone, memberPhone, source: "join_page" },
      }).catch(() => {});
    }

    logAudit({
      eventType: "family_member_invited",
      userId: session.userId ?? primaryPhone,
      phone: primaryPhone,
      data: { primaryPhone, memberPhone, source: "join_page" },
    }).catch(() => {});

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
  const primaryPhone = await resolvePrimaryPhone(seniorId);

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
      // update (not set/merge): only backfill groupChatId onto an EXISTING
      // session. set/merge would create a placeholder agent_sessions doc for a
      // phone that never onboarded, which later blocks proper secondary-member
      // bootstrap. A missing doc makes update reject (NOT_FOUND) — absorbed by
      // the catch — which is the intended no-op for un-onboarded phones.
      await db.collection("agent_sessions").doc(phone)
        .update({ groupChatId: chatId })
        .catch((err) => {
          console.warn(`buildOrUpdateFamilyGroup: groupChatId backfill skipped/failed for ${phone} (chat ${chatId}):`, err);
        });

      if (!existing.has(phone)) {
        let addedToLinq = true;
        await addParticipant(chatId, phone).catch((err) => {
          addedToLinq = false;
          logAudit({
            eventType: "family_group_participant_add_failed",
            userId: seniorId,
            phone,
            data: { seniorId, chatId, error: err instanceof Error ? err.message : String(err) },
          }).catch(() => {});
        });
        if (addedToLinq) {
          // Best-effort welcome — a delivery failure must NOT skip the phones
          // array update + audit below, or the member would be in the Linq chat
          // yet unrecorded in Firestore and re-added on the next run.
          await sendMessage(chatId, `Welcome to the group. You'll receive care updates here and can text me anytime.`).catch((err) => {
            console.warn(`buildOrUpdateFamilyGroup: welcome sendMessage failed for chat ${chatId}, ${phone}:`, err);
          });
          await groupDoc.ref.update({
            phones: admin.firestore.FieldValue.arrayUnion(phone),
          });
          logAudit({
            eventType: "family_group_participant_added",
            userId: seniorId,
            phone,
            data: { seniorId, chatId, source: "buildOrUpdateFamilyGroup" },
          }).catch(() => {});
          logAgentAction({
            actionType: "family_group_participant_add",
            status: "executed",
            userId: seniorId,
            phone,
            role: "family",
            targetCollection: "family_groups",
            targetDocId: groupDoc.id,
            metadata: { seniorId, chatId, source: "buildOrUpdateFamilyGroup" },
          }).catch(() => {});
        }
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
        `Hi everyone - I'm Evia, the care coordinator for ${seniorName}'s care.\n\n` +
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
  await updateChatName(chatId, `${seniorName.split(" ")[0]}'s Care · Evia`);

  // Persist group record
  const groupRef = await db.collection("family_groups").add({
    seniorId,
    chatId,
    phones:    allPhones,
    createdAt: new Date().toISOString(),
  });
  logAudit({
    eventType: "family_group_created",
    userId: seniorId,
    phone: primaryPhone,
    data: { seniorId, chatId, phones: allPhones },
  }).catch(() => {});
  logAgentAction({
    actionType: "family_group_created",
    status: "executed",
    userId: seniorId,
    phone: primaryPhone,
    role: "family",
    targetCollection: "family_groups",
    targetDocId: groupRef.id,
    metadata: { chatId, phones: allPhones },
  }).catch(() => {});

  // Update each participant's agent_session with the group chatId. update (not
  // set/merge): only backfill onto an EXISTING session so a phone that never
  // onboarded doesn't get a placeholder doc that later blocks proper
  // secondary-member bootstrap. Missing doc → update rejects (NOT_FOUND),
  // absorbed by the catch as the intended no-op.
  for (const phone of allPhones) {
    await db
      .collection("agent_sessions")
      .doc(phone)
      .update({ groupChatId: chatId })
      .catch((err) => {
        console.warn(`buildOrUpdateFamilyGroup: groupChatId backfill skipped/failed for ${phone} (chat ${chatId}):`, err);
      });
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
