// safety/emergency.ts — what happens when someone texts about an emergency (founders, 2026-11-26).
//
// ONE place for the whole path, used by every text entry point and the web chat:
//   assessEmergency  — keyword fast path (with the quote/joke filter), else the LLM reader, in any language
//   the reply        — fixed text only (utils/language.ts): 911, never medical advice, never model-written
//   escalateEmergency — pages the team and, for a signed-up person, texts the right people. Nothing is paused: after
//                       the reply, the conversation and any open flow carry on as they were (founder, 2026-11-26)
//
// Who is texted (founder: "go with your recommendations"):
//   • a family: their emergency contacts + the care provider on a visit now or today
//   • a care provider reporting a medical emergency (or that the person they care for is suicidal): that family
//     (account holder + emergency contacts) — the visit in progress, else today's if it is only ONE family
//   • a care provider who is suicidal themselves: the team ONLY, never the family they work for
//   • "I need help" with no detail: the team only
// A medical message is quoted to the people texted; a self-harm message never is.
import * as admin from "firebase-admin";
import { detectCrisis, isLikelyRealCrisis, classifyEmergency, type EmergencyAssessment, type EmergencyKind } from "./crisisDetector";
import { sendToPhone } from "../linq/client";
import { queryVisits } from "../utils/visitQuery";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { businessTodayStr } from "../utils/scheduledTime";

const db = () => admin.firestore();
type Doc = Record<string, unknown>;

/** Bare protocol replies can't describe an emergency — no model call for them. */
const PROTOCOL_ONLY = /^(\s*(yes|y|no|n|ok|okay|stop|start|skip|cancel|submit|done|finish|accept|decline|thanks|thank you|hi|hello|hey|\d+)[\s.!]*)$/i;

export async function assessEmergency(text: string): Promise<EmergencyAssessment | null> {
  if (!text.trim() || PROTOCOL_ONLY.test(text)) return null;
  const keyword = detectCrisis(text);
  if (keyword && (await isLikelyRealCrisis(text, keyword))) {
    if (keyword === "medical") return { kind: "medical", aboutSelf: false };
    // Whose crisis it is only matters for who gets told; unsure → treated as the sender's own (the private choice).
    const read = await classifyEmergency(text).catch(() => null);
    return { kind: "emotional", aboutSelf: !(read?.kind === "emotional" && read.aboutSelf === false) };
  }
  if (keyword) {
    console.info("emergency: keyword matched but judged not a real crisis", { keyword });
    return null;
  }
  return classifyEmergency(text);
}

export interface Recipient { phone: string; name: string; relation: "emergency contact" | "care provider" | "family" }

export function toE164(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim().startsWith("+") && digits.length >= 11 ? `+${digits}` : null;
}

async function personName(uid: string, fallback: string): Promise<{ name: string; phone?: string }> {
  const u = (await db().collection("users").doc(uid).get().catch(() => null))?.data() ?? {};
  const name = [u.firstName, u.lastName].filter((x) => typeof x === "string" && x).join(" ").trim()
    || (typeof u.name === "string" ? u.name : "") || (typeof u.displayName === "string" ? u.displayName : "") || fallback;
  return { name, phone: typeof u.phone === "string" ? u.phone : undefined };
}

async function emergencyContacts(clientId: string, visits: Doc[]): Promise<Recipient[]> {
  const found: Array<{ name?: unknown; phone?: unknown }> = [];
  for (const collection of ["care_plans", "carePlans"]) {
    const data = (await db().collection(collection).doc(clientId).get().catch(() => null))?.data();
    if (Array.isArray(data?.emergencyContacts)) found.push(...(data!.emergencyContacts as Array<{ name?: unknown; phone?: unknown }>));
  }
  for (const v of visits) if (v.emergencyContact) found.push(v.emergencyContact as { name?: unknown; phone?: unknown });
  return found.flatMap((c) => {
    const phone = toE164(c?.phone);
    return phone ? [{ phone, name: String(c.name ?? "").trim() || "your emergency contact", relation: "emergency contact" as const }] : [];
  });
}

async function visitsNowOrToday(field: "clientId" | "caregiverId", uid: string): Promise<{ now: Doc[]; today: Doc[] }> {
  const extraWhere: Array<[string, FirebaseFirestore.WhereFilterOp, unknown]> = [[field, "==", uid]];
  const read = async (p: Parameters<typeof queryVisits>[0]) =>
    (await queryVisits(p).catch((err) => { console.error("emergency: visit lookup failed", err); return []; })).map((d) => d.data() as Doc);
  return {
    now: await read({ extraWhere, shiftStatuses: ["in-progress"] }),
    today: await read({ extraWhere, dateOp: "==", dateValue: businessTodayStr(), shiftStatuses: ["scheduled", "in-progress"] }),
  };
}

export async function resolveRecipients(input: {
  uid: string; userType: string; assessment: EmergencyAssessment; senderPhone: string;
}): Promise<{ recipients: Recipient[]; note?: string }> {
  const { uid, assessment } = input;
  if (assessment.kind === "help") return { recipients: [], note: "Unclear plea for help: team only." };
  const out: Recipient[] = [];
  let note: string | undefined;
  if (input.userType === "caregiver") {
    if (assessment.kind === "emotional" && assessment.aboutSelf) return { recipients: [], note: "Care provider's own crisis: team only." };
    const { now, today } = await visitsNowOrToday("caregiverId", uid);
    const visits = now.length ? now : today;
    const clientIds = [...new Set(visits.map((v) => String(v.clientId ?? "")).filter(Boolean))];
    if (!now.length && clientIds.length > 1) return { recipients: [], note: "Several families today and no visit in progress: nobody texted, please work out which one." };
    if (!clientIds.length) return { recipients: [], note: "No visit now or today: no family texted." };
    for (const clientId of clientIds) {
      const holder = await personName(clientId, "the family");
      const phone = toE164(holder.phone);
      if (phone) out.push({ phone, name: holder.name, relation: "family" });
      out.push(...(await emergencyContacts(clientId, visits.filter((v) => v.clientId === clientId))));
    }
  } else {
    const { now, today } = await visitsNowOrToday("clientId", uid);
    const visits = [...now, ...today];
    out.push(...(await emergencyContacts(uid, visits)));
    for (const caregiverId of [...new Set(visits.map((v) => String(v.caregiverId ?? "")).filter(Boolean))]) {
      const phone = toE164(await resolveCaregiverPhone(caregiverId).catch(() => undefined));
      const name = String(visits.find((v) => v.caregiverId === caregiverId)?.caregiverName ?? "") || "your care provider";
      if (phone) out.push({ phone, name, relation: "care provider" });
    }
  }
  const seen = new Set<string>([toE164(input.senderPhone) ?? input.senderPhone]);
  const recipients = out.filter((r) => !seen.has(r.phone) && !!seen.add(r.phone));
  if (!recipients.length) note = "No emergency contact or visit on file: nobody else was texted.";
  return { recipients, note };
}

export function contactText(kind: EmergencyKind, senderName: string, senderIsCaregiver: boolean, said: string): string {
  const who = senderIsCaregiver ? `${senderName} (care provider)` : senderName;
  if (kind === "medical") {
    return `🚨 Evia emergency alert: ${who} just reported an emergency: "${said.trim().slice(0, 200)}". Please check on them now. If anyone is in danger, call 911.`;
  }
  return `Evia alert: ${who} sent a message suggesting someone may need urgent support. Please check on them now. If anyone is in immediate danger, call 911.`;
}

/** An emergency contact is not a user: a session created only to deliver this alert is removed, so their reply is treated as a first hello. */
async function textRecipient(r: Recipient, text: string): Promise<string> {
  try {
    const ref = db().collection("agent_sessions").doc(r.phone);
    const known = (await ref.get().catch(() => null))?.exists === true;
    const outcome = await sendToPhone(r.phone, text, { source: "emergency_alert" });
    if (!known) await ref.delete().catch(() => {});
    return outcome;
  } catch (err) {
    console.error("emergency: alert text failed", err instanceof Error ? err.message : err);
    return "failed";
  }
}

const RENOTIFY_MS = 30 * 60 * 1000;
const RANK: Record<EmergencyKind, number> = { help: 0, emotional: 1, medical: 2 };

/**
 * Page the team and text the right people. Never pauses the thread. Returns the names actually texted so the reply claims
 * only what happened. Never throws: the 911 reply has already gone out and nothing here may undo that.
 */
export async function escalateEmergency(input: {
  phone: string; text: string; assessment: EmergencyAssessment; session: Doc | null; channel: "text" | "web";
}): Promise<{ notified: string[]; teamAlerted: boolean }> {
  const { phone, text, assessment, session } = input;
  const uid = typeof session?.userId === "string" && session.userId ? session.userId : undefined;
  const userType = session?.userType === "caregiver" ? "caregiver" : "client";
  const result = { notified: [] as string[], teamAlerted: false };
  try {
    const sender = uid ? await personName(uid, phone) : { name: `Unknown number ${phone}` };
    const prior = session?.emergencyNotified as { at?: string; kind?: EmergencyKind } | undefined;
    const repeat = !!prior?.at && Date.now() - Date.parse(prior.at) < RENOTIFY_MS && RANK[prior.kind ?? "help"] >= RANK[assessment.kind];

    const ref = await db().collection("admin_alerts").add({
      type: "emergency",
      severity: assessment.kind === "help" ? "high" : "critical",
      kind: assessment.kind,
      phone,
      ...(uid ? { userId: uid, role: userType } : {}),
      name: sender.name,
      said: text.slice(0, 500),
      channel: input.channel,
      message: `${sender.name}${uid ? ` (${userType === "caregiver" ? "care provider" : "family"})` : " (not signed up)"} — ${assessment.kind === "medical" ? "medical emergency" : assessment.kind === "emotional" ? "possible self-harm risk" : "asked for help"}. Evia told them to call 911.`,
      resolved: false,
      createdAt: new Date().toISOString(),
    });
    result.teamAlerted = true;

    // Signed-in people only: a number with no account has nobody on file to text.
    if (!uid) return result;

    const plan = repeat
      ? { recipients: [] as Recipient[], note: "Already texted people within the last 30 minutes." }
      : await resolveRecipients({ uid, userType, assessment, senderPhone: phone });
    const body = contactText(assessment.kind, sender.name, userType === "caregiver", text);
    const sent = await Promise.all(plan.recipients.map(async (r) => ({ ...r, status: await textRecipient(r, body) })));
    result.notified = sent.filter((r) => r.status === "sent").map((r) => r.name);
    await ref.update({ notified: sent, ...(plan.note ? { note: plan.note } : {}) }).catch(() => {});

    if (assessment.kind !== "help") {
      if (sent.length) {
        await db().collection("agent_sessions").doc(phone).set({ emergencyNotified: { at: new Date().toISOString(), kind: assessment.kind } }, { merge: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("emergency: escalation failed", err instanceof Error ? err.message : err);
  }
  return result;
}
