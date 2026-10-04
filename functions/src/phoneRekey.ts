// A phone number change = the NEW number is her, completely (founder, 2026-10-03).
//
// Before this, confirmPhoneChange rewrote the login and ONE profile field and
// deleted the old text session. Everything else stayed keyed to the old number:
// the user record's phone (what every lifecycle text and reminder resolves),
// recognition of the new number on its first text (looked up by that stale
// field → treated as a cold signup), the conversation history and memory files
// (agent_conversations/{phone}), long-term memory (the Zep user id is the phone's
// digits), parked confirmations and pending reminders (phone field), and the
// signup bridge doc. This module moves all of it, once, from one place.
import * as admin from "firebase-admin";

const db = () => admin.firestore();
const digits = (phone: string) => phone.replace(/\D/g, "");

export interface PhoneRekeyArgs {
  uid: string;
  role: "client" | "caregiver";
  oldPhone: string | undefined;
  newPhone: string;
}

export interface PhoneRekeyReport {
  sessionMoved: boolean;
  conversationMoved: boolean;
  messagesMoved: number;
  pendingActionsRepointed: number;
  triggersRepointed: number;
  memoryAliased: boolean;
}

/** Copy a document and one subcollection to a new id, then delete the old ones. Batched. */
async function moveDoc(
  coll: string,
  fromId: string,
  toId: string,
  patch: Record<string, unknown>,
  subcollection?: string,
): Promise<{ moved: boolean; subMoved: number }> {
  const fromRef = db().collection(coll).doc(fromId);
  const toRef = db().collection(coll).doc(toId);
  const snap = await fromRef.get();
  if (!snap.exists) return { moved: false, subMoved: 0 };
  await toRef.set({ ...(snap.data() ?? {}), ...patch });
  let subMoved = 0;
  if (subcollection) {
    const subSnap = await fromRef.collection(subcollection).get();
    const docs = subSnap.docs;
    for (let i = 0; i < docs.length; i += 200) {
      const batch = db().batch();
      for (const d of docs.slice(i, i + 200)) {
        batch.set(toRef.collection(subcollection).doc(d.id), d.data());
        batch.delete(d.ref);
      }
      await batch.commit();
    }
    subMoved = docs.length;
  }
  await fromRef.delete();
  return { moved: true, subMoved };
}

/** Re-point every doc in `coll` whose `phone` field is the old number. Batched. */
async function repointPhoneField(coll: string, oldPhone: string, newPhone: string): Promise<number> {
  const snap = await db().collection(coll).where("phone", "==", oldPhone).get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db().batch();
    for (const d of docs.slice(i, i + 400)) batch.update(d.ref, { phone: newPhone });
    await batch.commit();
  }
  return docs.length;
}

/**
 * Move everything keyed to the old number onto the new one. Each step is
 * best-effort and logged so one failing store can never leave the login and
 * the profile on different numbers — those two were already written by the
 * caller; this finishes the job for the rest.
 */
export async function rekeyPhoneEverywhere(args: PhoneRekeyArgs): Promise<PhoneRekeyReport> {
  const { uid, role, oldPhone, newPhone } = args;
  const report: PhoneRekeyReport = { sessionMoved: false, conversationMoved: false, messagesMoved: 0, pendingActionsRepointed: 0, triggersRepointed: 0, memoryAliased: false };

  // 1. Both profile records — the user record's phone is what every lifecycle
  //    text, reminder and "find her conversation" lookup resolves first.
  await db().collection("users").doc(uid).set({ phone: newPhone }, { merge: true });
  if (role === "caregiver") await db().collection("caregivers").doc(uid).set({ phone: newPhone }, { merge: true });

  if (!oldPhone || oldPhone === newPhone) return report;

  // 2. The text session: moved, not deleted — her step, linked ids, cached links,
  //    Zep thread id and preferences come along. The first inbound from the new
  //    number refreshes the chat id (the webhook already does that).
  try {
    const r = await moveDoc("agent_sessions", oldPhone, newPhone, { phone: newPhone, phoneChangedFrom: oldPhone, phoneChangedAt: new Date().toISOString() });
    report.sessionMoved = r.moved;
  } catch (err) { console.error(`[phoneRekey] session move failed ${oldPhone} → ${newPhone}:`, err); }

  // 3. Conversation history + memory files (agent_conversations/{phone} + messages).
  try {
    const r = await moveDoc("agent_conversations", oldPhone, newPhone, { phone: newPhone }, "messages");
    report.conversationMoved = r.moved; report.messagesMoved = r.subMoved;
  } catch (err) { console.error(`[phoneRekey] conversation move failed ${oldPhone} → ${newPhone}:`, err); }

  // 4. Long-term memory: the Zep user id is the OLD number's digits — alias the
  //    new number to it so nothing Evia learned is lost (zepClient resolves it).
  try {
    const { setZepUserAlias } = await import("./memory/zepClient");
    await setZepUserAlias(digits(newPhone), digits(oldPhone));
    report.memoryAliased = true;
  } catch (err) { console.error(`[phoneRekey] memory alias failed ${oldPhone} → ${newPhone}:`, err); }

  // 5. Parked confirmations and pending reminders carry the phone they will text.
  try { report.pendingActionsRepointed = await repointPhoneField("pending_actions", oldPhone, newPhone); }
  catch (err) { console.error("[phoneRekey] pending_actions repoint failed:", err); }
  try { report.triggersRepointed = await repointPhoneField("proactive_triggers", oldPhone, newPhone); }
  catch (err) { console.error("[phoneRekey] proactive_triggers repoint failed:", err); }

  // 6. The signup bridge doc for the old number is meaningless now.
  await db().collection("web_onboarding_sessions").doc(oldPhone).delete().catch(() => {});

  console.info(`[phoneRekey] ${role} ${uid}: ${oldPhone} → ${newPhone}`, report);
  return report;
}
