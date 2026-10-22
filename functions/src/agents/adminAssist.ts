// ── Admin assist: an admin helping a person on the phone (2026-10-22) ────────
//
// Founder: when a client or care provider calls for help, the team should be
// able to do anything the person could do on the site, from the admin page —
// except the steps that must stay with the person (identity check, payment,
// background-check consent, payout setup, deletion), where the admin sends the
// link instead. Whatever the admin does is as if the person did it.
//
// Consent, in layers (founder picked the texted YES, 2026-10-22):
//   1. the admin presses "Act for this person" → Evia texts the account's phone
//      "Reply YES to allow" and the request is parked on the person's session;
//   2. the person's YES (from the account's own phone) opens a one-hour window
//      recorded on adminAssist/{uid}; NO closes it; anything else is routed as
//      a normal message and the request lapses after 15 minutes;
//   3. every step above is an audit entry, next to the actions it covers.
//
// This module owns the state and the texts. The queue trigger
// (triggers/adminAssistQueue.ts) calls requestAdminAssist / endAdminAssist on
// the admin's behalf; the inbound webhook calls handleAdminAssistConsentReply
// before any other routing while a request is parked.
import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import { sendMessage, sendToPhone, type AgentSession } from "../linq/client";

const db = admin.firestore();

/** How long one YES allows the team to act. */
export const ASSIST_WINDOW_MS = 60 * 60 * 1000;
/** How long a "Reply YES to allow" waits for its answer. */
export const CONSENT_PENDING_TTL_MS = 15 * 60 * 1000;

export type AssistRole = "client" | "caregiver";
export type AssistStatus = "requested" | "granted" | "declined" | "ended" | "expired";

export interface AdminAssistConsentPending {
  uid: string;
  role: AssistRole;
  adminUid: string;
  adminName: string;
  requestedAt: string;
}

export interface AdminAssistState {
  uid: string;
  role: AssistRole;
  status: AssistStatus;
  phone: string;
  requestedAt: string;
  requestedBy: { uid: string; name: string };
  grantedAt?: string;
  until?: string;
  endedAt?: string;
  endedBy?: { uid: string; name: string } | null;
  lastReply?: string;
}

/** Strict binary read of the consent reply — the system said "Reply YES or NO". */
export function consentReplyKind(text: string): "yes" | "no" | null {
  const norm = text.trim().toUpperCase().replace(/[.!]+$/, "");
  if (norm === "YES" || norm === "Y" || norm === "SI" || norm === "SÍ") return "yes";
  if (norm === "NO" || norm === "N") return "no";
  return null;
}

export function isPendingFresh(pending: { requestedAt: string }, now = Date.now()): boolean {
  const t = Date.parse(pending.requestedAt);
  return Number.isFinite(t) && now - t <= CONSENT_PENDING_TTL_MS;
}

export function assistWindowEnd(grantedAtMs: number): string {
  return new Date(grantedAtMs + ASSIST_WINDOW_MS).toISOString();
}

/** True while a granted window is still open. */
export function isAssistActive(state: Partial<AdminAssistState> | undefined, now = Date.now()): boolean {
  if (!state || state.status !== "granted" || !state.until) return false;
  const until = Date.parse(state.until);
  return Number.isFinite(until) && until > now;
}

export function consentRequestText(firstName: string | undefined): string {
  const hi = firstName ? `Hi ${firstName}, this is Evia.` : "Hi, this is Evia.";
  return `${hi} Our team is about to help with your account by phone, at your request. Reply YES to allow it for the next hour, or NO.`;
}

export const CONSENT_GRANTED_TEXT =
  "Thanks — our team can help with your account for the next hour. You'll get a text for each thing they do, and payment, identity and background-check steps always stay with you.";
export const CONSENT_DECLINED_TEXT = "No problem — nothing will be done on your account by our team.";
export const ASSIST_ENDED_TEXT = "Our team has finished helping with your account. If you need anything else, just text me.";

function pendingTimeFormat(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
}

/** The admin pressed "Act for this person": park the request and text the YES ask. */
export async function requestAdminAssist(input: {
  uid: string; role: AssistRole; phone: string; firstName?: string; adminUid: string; adminName: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const state: AdminAssistState = {
    uid: input.uid, role: input.role, status: "requested", phone: input.phone, requestedAt: now,
    requestedBy: { uid: input.adminUid, name: input.adminName }, endedBy: null,
  };
  await db.collection("adminAssist").doc(input.uid).set(state);
  const pending: AdminAssistConsentPending = { uid: input.uid, role: input.role, adminUid: input.adminUid, adminName: input.adminName, requestedAt: now };
  await db.collection("agent_sessions").doc(input.phone).set({ adminAssistConsentPending: pending }, { merge: true });
  await sendToPhone(input.phone, consentRequestText(input.firstName));
  await logAudit({ eventType: "admin_assist_requested", userId: input.uid, phone: input.phone, data: { adminUid: input.adminUid, adminName: input.adminName, role: input.role } });
}

/** The admin pressed Stop, or the window ran out. */
export async function endAdminAssist(input: {
  uid: string; phone: string; adminUid?: string; adminName?: string; reason: "ended" | "expired"; notify?: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.collection("adminAssist").doc(input.uid).set({
    status: input.reason, endedAt: now, endedBy: input.adminUid ? { uid: input.adminUid, name: input.adminName ?? "" } : null,
  }, { merge: true });
  await db.collection("agent_sessions").doc(input.phone).update({ adminAssistConsentPending: admin.firestore.FieldValue.delete() }).catch(() => {});
  if (input.notify !== false && input.reason === "ended") await sendToPhone(input.phone, ASSIST_ENDED_TEXT).catch(() => {});
  await logAudit({ eventType: input.reason === "ended" ? "admin_assist_ended" : "admin_assist_expired", userId: input.uid, phone: input.phone, data: { adminUid: input.adminUid ?? null, adminName: input.adminName ?? null } });
}

/**
 * The person's reply while a request is parked. Returns true when the reply was
 * the consent answer (handled here); false lets the webhook route it as usual.
 */
export async function handleAdminAssistConsentReply(phone: string, chatId: string, session: AgentSession, text: string): Promise<boolean> {
  const pending = (session as unknown as Record<string, unknown>).adminAssistConsentPending as AdminAssistConsentPending | undefined;
  if (!pending || typeof pending.uid !== "string") return false;
  const clear = () => db.collection("agent_sessions").doc(phone).update({ adminAssistConsentPending: admin.firestore.FieldValue.delete() }).catch(() => {});
  if (!isPendingFresh(pending)) {
    // The ask lapsed (15 min) — close it quietly; the admin page shows "Expired, ask again".
    await clear();
    const cur = (await db.collection("adminAssist").doc(pending.uid).get()).data() as Partial<AdminAssistState> | undefined;
    if (cur?.status === "requested") await endAdminAssist({ uid: pending.uid, phone, reason: "expired", notify: false });
    return false;
  }
  const kind = consentReplyKind(text);
  if (!kind) return false;
  await clear();
  const now = Date.now();
  if (kind === "yes") {
    const grantedAt = new Date(now).toISOString();
    const until = assistWindowEnd(now);
    await db.collection("adminAssist").doc(pending.uid).set({ status: "granted", grantedAt, until, lastReply: text.trim().slice(0, 40) }, { merge: true });
    await sendMessage(chatId, CONSENT_GRANTED_TEXT);
    await logAudit({ eventType: "admin_assist_granted", userId: pending.uid, phone, data: { adminUid: pending.adminUid, adminName: pending.adminName, until, askedAt: pendingTimeFormat(pending.requestedAt) } });
    return true;
  }
  await db.collection("adminAssist").doc(pending.uid).set({ status: "declined", endedAt: new Date(now).toISOString(), lastReply: text.trim().slice(0, 40) }, { merge: true });
  await sendMessage(chatId, CONSENT_DECLINED_TEXT);
  await logAudit({ eventType: "admin_assist_declined", userId: pending.uid, phone, data: { adminUid: pending.adminUid, adminName: pending.adminName } });
  return true;
}
