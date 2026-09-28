// agents/familyRelay.ts — "running late" over text, the marketplace way
// (founder, 2026-09-28): Evia writes nothing to the family. The caregiver's
// OWN words are posted into the shared Inbox thread exactly as the site's
// Message button posts them (utils/chatThread.ts); the family gets them as a
// message from the caregiver — in-app and texted by onMessageSent — and
// answers in the same thread.
//
//   LATE            → "What should I tell <family>? I'll send it as your message."
//                     → the next text is relayed verbatim (NO / CANCEL backs out)
//   "running late…" → relayed verbatim, no question
//
// (The old LATE path asked "how late?" and texted the family an Evia-written
// sentence outside the thread — removed with the ISSUE pipeline.)
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { relayIntoSharedChatThread } from "../utils/chatThread";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

export interface FamilyRef { clientId: string; clientName: string }

/** The family of today's visit (in progress, else the next one today), else the caregiver's next scheduled visit. */
export async function familyForCaregiver(caregiverId: string): Promise<FamilyRef | null> {
  const today = businessTodayStr();
  const todaySnap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("date", "==", today).get();
  const todays = todaySnap.docs.map((d) => d.data()).filter((s) => s.caregiverId === caregiverId && (s.status === "in-progress" || s.status === "scheduled"))
    .sort((a, b) => (a.status === "in-progress" ? -1 : 1) - (b.status === "in-progress" ? -1 : 1) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
  let pick = todays[0];
  if (!pick) {
    const next = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["scheduled", "in-progress"]).orderBy("date", "asc").limit(5).get();
    pick = next.docs.map((d) => d.data()).find((s) => s.caregiverId === caregiverId && s.clientId);
  }
  if (!pick?.clientId) return null;
  return { clientId: String(pick.clientId), clientName: String(pick.clientName || "the family") };
}

export type RelayResult = { ok: true; clientId: string; clientName: string } | { ok: false; reason: "no_family" | "membership" | "empty"; message: string };

/** Posts the caregiver's words into the family's Inbox thread — the site's Message write. */
export async function relayCaregiverMessageToFamily(caregiverId: string, text: unknown, family?: FamilyRef | null): Promise<RelayResult> {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, reason: "empty", message: "What should I send?" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = cgSnap.data() ?? {};
  // InboxView blocks the composer without an active membership — same gate as send_client_message.
  const membershipActive = cg.membershipStatus === "active" || cg.membershipStatus === "trialing" || (!cg.membershipStatus && cg.membershipPaid === true);
  if (!membershipActive) return { ok: false, reason: "membership", message: "Your membership isn't active, so messages to families are paused until it's renewed." };
  const fam = family ?? await familyForCaregiver(caregiverId);
  if (!fam) return { ok: false, reason: "no_family", message: "I don't see a visit on your schedule, so I'm not sure which family to message." };
  await relayIntoSharedChatThread({
    clientId: fam.clientId, clientName: fam.clientName,
    caregiverId, caregiverName: String(cg.name ?? "Your caregiver"),
    senderId: caregiverId, senderName: String(cg.name ?? "Your caregiver"),
    text: body,
  });
  return { ok: true, clientId: fam.clientId, clientName: fam.clientName };
}

export const latePrompt = (family: string) => `What should I tell ${family}? I'll send it as your message.`;

/** LATE keyword + the parked "what should I tell them" step. */
export async function handleLateKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  const upper = raw.toUpperCase();
  const say = (m: string) => sendMessage(chatId, m);
  const pending = session.pendingFamilyMessage as { clientId?: string; clientName?: string } | undefined;
  const clear = () => db.collection("agent_sessions").doc(phone).update({ pendingFamilyMessage: admin.firestore.FieldValue.delete() }).catch(() => {});
  if (pending) {
    if (upper === "NO" || upper === "CANCEL") { await clear(); await say("Okay — nothing sent."); return "handled"; }
    const r = await relayCaregiverMessageToFamily(caregiverId, raw, pending.clientId ? { clientId: pending.clientId, clientName: pending.clientName || "the family" } : null);
    await clear();
    await say(r.ok ? `Sent to ${r.clientName} as your message.` : r.message);
    return "handled";
  }
  if (upper === "LATE") {
    const fam = await familyForCaregiver(caregiverId);
    if (!fam) { await say("I don't see a visit on your schedule, so I'm not sure which family to message."); return "handled"; }
    await db.collection("agent_sessions").doc(phone).set({ pendingFamilyMessage: { ...fam, at: new Date().toISOString() }, stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }, { merge: true }).catch(() => {});
    await say(latePrompt(fam.clientName));
    return "handled";
  }
  return "passthrough";
}

/** A plain "running about 10 minutes late" — relayed verbatim as the caregiver's message. */
export async function relayLateSentence(chatId: string, caregiverId: string, text: string): Promise<boolean> {
  const r = await relayCaregiverMessageToFamily(caregiverId, text);
  await sendMessage(chatId, r.ok ? `Sent to ${r.clientName} as your message: "${text.trim()}"` : r.message);
  return r.ok;
}
