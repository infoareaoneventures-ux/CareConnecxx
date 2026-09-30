// agents/familyRelay.ts — "running late" over text, the marketplace way
// (founder, 2026-09-28): Evia writes nothing to the family. The caregiver's
// OWN words are posted into the shared Inbox thread exactly as the site's
// Message button posts them (utils/chatThread.ts); the family gets them as a
// message from the caregiver — in-app and texted by onMessageSent — and
// answers in the same thread.
//
//   LATE            → "What should I tell <family>? I'll send it as your message."
//                     → the next text is relayed verbatim (NO / CANCEL backs out)
//   "running late…" → Evia INFERRED the audience, so it confirms first (the
//                     composer's own step): "Send to <family> as your message:
//                     '…'? Reply YES or NO." — YES posts it verbatim.
//
// WHICH family (founder 2026-09-30: "how does it know it's for that client"):
// always by the visit's own clientId on the shift record — never by a name or
// a phone number. The visit in progress wins; else today's visits; else the next
// scheduled visit. When today holds visits for TWO OR MORE families and none is
// in progress, Evia asks which one (numbered) before anything is sent.
//
// (The old LATE path asked "how late?" and texted the family an Evia-written
// sentence outside the thread — removed with the ISSUE pipeline.)
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { relayIntoSharedChatThread } from "../utils/chatThread";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

export interface FamilyRef { clientId: string; clientName: string }
export interface FamilyPick { pick: FamilyRef | null; candidates: FamilyRef[] }

const asRef = (s: FirebaseFirestore.DocumentData): FamilyRef => ({ clientId: String(s.clientId), clientName: String(s.clientName || "the family") });
const distinct = (refs: FamilyRef[]): FamilyRef[] => { const seen = new Set<string>(); return refs.filter((r) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true))); };

/**
 * Today's visits, by the shift's clientId: the one in progress decides; one family
 * today decides; several families today and none in progress → ambiguous (pick null,
 * candidates listed, in start-time order). No visit today → the next scheduled one.
 */
export async function familyCandidatesForCaregiver(caregiverId: string): Promise<FamilyPick> {
  const today = businessTodayStr();
  const todaySnap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("date", "==", today).get();
  const todays = todaySnap.docs.map((d) => d.data()).filter((s) => s.caregiverId === caregiverId && s.clientId && (s.status === "in-progress" || s.status === "scheduled"))
    .sort((a, b) => (a.status === "in-progress" ? -1 : 1) - (b.status === "in-progress" ? -1 : 1) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
  const inProgress = todays.find((s) => s.status === "in-progress");
  if (inProgress) return { pick: asRef(inProgress), candidates: [asRef(inProgress)] };
  const families = distinct(todays.map(asRef));
  if (families.length === 1) return { pick: families[0], candidates: families };
  if (families.length > 1) return { pick: null, candidates: families };
  const next = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["scheduled", "in-progress"]).orderBy("date", "asc").limit(10).get();
  const pick = next.docs.map((d) => d.data()).find((s) => s.caregiverId === caregiverId && s.clientId);
  return pick ? { pick: asRef(pick), candidates: [asRef(pick)] } : { pick: null, candidates: [] };
}

/** The family of today's visit (in progress, else the only one today), else the caregiver's next scheduled visit; null when none or ambiguous. */
export async function familyForCaregiver(caregiverId: string): Promise<FamilyRef | null> {
  return (await familyCandidatesForCaregiver(caregiverId)).pick;
}

export type RelayResult =
  | { ok: true; clientId: string; clientName: string }
  | { ok: false; reason: "no_family" | "membership" | "empty"; message: string }
  | { ok: false; reason: "ambiguous"; message: string; candidates: FamilyRef[] };

export const whichFamilyPrompt = (candidates: FamilyRef[]) =>
  `Which family? ${candidates.map((c, i) => `Reply ${i + 1} for ${c.clientName}`).join(", ")}.`;

/** Posts the caregiver's words into the family's Inbox thread — the site's Message write. */
export async function relayCaregiverMessageToFamily(caregiverId: string, text: unknown, family?: FamilyRef | null): Promise<RelayResult> {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, reason: "empty", message: "What should I send?" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cg = cgSnap.data() ?? {};
  // InboxView blocks the composer without an active membership — same gate as send_client_message.
  const membershipActive = cg.membershipStatus === "active" || cg.membershipStatus === "trialing" || (!cg.membershipStatus && cg.membershipPaid === true);
  if (!membershipActive) return { ok: false, reason: "membership", message: "Your membership isn't active, so messages to families are paused until it's renewed." };
  let fam = family ?? null;
  if (!fam) {
    const found = await familyCandidatesForCaregiver(caregiverId);
    if (!found.pick && found.candidates.length > 1) return { ok: false, reason: "ambiguous", message: whichFamilyPrompt(found.candidates), candidates: found.candidates };
    fam = found.pick;
  }
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

const FLOW_TTL_MS = 30 * 60 * 1000;
type PendingChoice = { candidates: FamilyRef[]; text?: string };
type PendingConfirm = { clientId: string; clientName: string; text: string };

export const confirmRelayPrompt = (family: string, text: string) => `Send to ${family} as your message: "${text}"? Reply YES or NO.`;
async function parkRelayConfirm(phone: string, fam: FamilyRef, text: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).set({ pendingRelayConfirm: { clientId: fam.clientId, clientName: fam.clientName, text }, pendingFamilyChoice: admin.firestore.FieldValue.delete(), stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() }, { merge: true });
}

/** Which of the numbered families did they mean? A number, or a name the list holds (deterministic — the list was just texted). */
export function resolveFamilyChoice(candidates: FamilyRef[], text: string): FamilyRef | null {
  const raw = text.trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : null;
  if (n !== null) return candidates[n - 1] ?? null;
  const lower = raw.toLowerCase();
  const byName = candidates.filter((c) => c.clientName.toLowerCase().includes(lower) || lower.includes(c.clientName.toLowerCase()));
  return byName.length === 1 ? byName[0] : null;
}

/** LATE keyword + the parked "which family" and "what should I tell them" steps. */
export async function handleLateKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  const upper = raw.toUpperCase();
  const say = (m: string) => sendMessage(chatId, m);
  const ref = db.collection("agent_sessions").doc(phone);
  const pending = session.pendingFamilyMessage as { clientId?: string; clientName?: string } | undefined;
  const choice = session.pendingFamilyChoice as PendingChoice | undefined;
  const confirm = session.pendingRelayConfirm as PendingConfirm | undefined;
  const clear = () => ref.update({ pendingFamilyMessage: admin.firestore.FieldValue.delete(), pendingFamilyChoice: admin.firestore.FieldValue.delete(), pendingRelayConfirm: admin.firestore.FieldValue.delete() }).catch(() => {});

  // "Send to <family> as your message: '…'? Reply YES or NO." — the strict binary the text announced.
  if (confirm?.text) {
    if (upper === "YES" || upper === "Y" || upper === "SEND") {
      const r = await relayCaregiverMessageToFamily(caregiverId, confirm.text, { clientId: confirm.clientId, clientName: confirm.clientName });
      await clear();
      await say(r.ok ? `Sent to ${r.clientName} as your message.` : r.message);
      return "handled";
    }
    if (upper === "NO" || upper === "N" || upper === "CANCEL") { await clear(); await say("Okay — nothing sent."); return "handled"; }
    await say(confirmRelayPrompt(confirm.clientName, confirm.text));
    return "handled";
  }

  if (choice?.candidates?.length) {
    if (upper === "NO" || upper === "CANCEL") { await clear(); await say("Okay — nothing sent."); return "handled"; }
    const picked = resolveFamilyChoice(choice.candidates, raw);
    if (!picked) { await say(whichFamilyPrompt(choice.candidates)); return "handled"; }
    if (choice.text) {
      await parkRelayConfirm(phone, picked, choice.text);
      await say(confirmRelayPrompt(picked.clientName, choice.text));
      return "handled";
    }
    await ref.set({ pendingFamilyMessage: { ...picked, at: new Date().toISOString() }, pendingFamilyChoice: admin.firestore.FieldValue.delete(), stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() }, { merge: true });
    await say(latePrompt(picked.clientName));
    return "handled";
  }
  if (pending) {
    if (upper === "NO" || upper === "CANCEL") { await clear(); await say("Okay — nothing sent."); return "handled"; }
    const r = await relayCaregiverMessageToFamily(caregiverId, raw, pending.clientId ? { clientId: pending.clientId, clientName: pending.clientName || "the family" } : null);
    await clear();
    await say(r.ok ? `Sent to ${r.clientName} as your message.` : r.message);
    return "handled";
  }
  if (upper === "LATE") {
    const found = await familyCandidatesForCaregiver(caregiverId);
    if (!found.pick && found.candidates.length > 1) {
      await ref.set({ pendingFamilyChoice: { candidates: found.candidates }, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() }, { merge: true });
      await say(whichFamilyPrompt(found.candidates));
      return "handled";
    }
    if (!found.pick) { await say("I don't see a visit on your schedule, so I'm not sure which family to message."); return "handled"; }
    await ref.set({ pendingFamilyMessage: { ...found.pick, at: new Date().toISOString() }, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() }, { merge: true });
    await say(latePrompt(found.pick.clientName));
    return "handled";
  }
  return "passthrough";
}

/**
 * A plain "running about 10 minutes late" — Evia inferred this is for the family,
 * so nothing is sent yet: which family (asked when several), then "Send to <family>
 * as your message: '…'? Reply YES or NO." (founder 2026-09-30). Returns true only
 * when a confirmation question was parked.
 */
export async function relayLateSentence(phone: string, chatId: string, caregiverId: string, text: string): Promise<boolean> {
  const body = text.trim();
  if (!body) { await sendMessage(chatId, "What should I send?"); return false; }
  const cg = (await db.collection("caregivers").doc(caregiverId).get()).data() ?? {};
  const membershipActive = cg.membershipStatus === "active" || cg.membershipStatus === "trialing" || (!cg.membershipStatus && cg.membershipPaid === true);
  if (!membershipActive) { await sendMessage(chatId, "Your membership isn't active, so messages to families are paused until it's renewed."); return false; }
  const found = await familyCandidatesForCaregiver(caregiverId);
  if (!found.pick && found.candidates.length > 1) {
    await db.collection("agent_sessions").doc(phone).set({ pendingFamilyChoice: { candidates: found.candidates, text: body }, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() }, { merge: true });
    await sendMessage(chatId, whichFamilyPrompt(found.candidates));
    return true;
  }
  if (!found.pick) { await sendMessage(chatId, "I don't see a visit on your schedule, so I'm not sure which family to message."); return false; }
  await parkRelayConfirm(phone, found.pick, body);
  await sendMessage(chatId, confirmRelayPrompt(found.pick.clientName, body));
  return true;
}
