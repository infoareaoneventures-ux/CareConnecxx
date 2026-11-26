// ── Human mode: the team has this person's conversation (2026-10-22) ──────────
//
// Founder: a per-person switch on the admin page — "Hand to human" / "Back to
// Evia" — that turns a flag on or off; while it is on, Evia does not reply to
// that person's texts, the team's replies go out from Evia's number into the
// same thread (the Messages tab), and a "Needs a human" list shows everyone
// whose switch is on. Evia's own handoffs (the low-confidence gate and
// "message our team") flip the same flag, so there is ONE mechanism.
//
// State lives in two places, written only here (server):
//   agent_sessions/{phone}.humanMode   — what the webhook checks before Evia runs
//   users/{uid} (+ caregivers/{uid})   — flat fields the admin lists and the
//                                        "Needs a human" panel read:
//     humanModeOn, humanModeSince, humanModeReason, humanModeByName,
//     humanModeLastText, humanModeLastAt, humanModeUnread, humanModeLastTeamAt
// Scheduled notices about visits/bookings still go out — those are facts, not
// conversation. STOP still works (carrier protocol) — it is never swallowed here.
import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import { sendToPhone, type AgentSession } from "../linq/client";

const db = admin.firestore();

export type HumanModeReason = "admin" | "low_confidence" | "asked_for_human";
export interface HumanModeFlag {
  on: boolean;
  since: string;
  reason: HumanModeReason;
  by: { uid: string; name: string } | "evia";
}

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END", "OPTOUT"]);
/** The carrier STOP protocol always reaches the normal handler, even while a human has the thread. */
export function isStopWord(text: string): boolean {
  return STOP_WORDS.has(text.trim().toUpperCase());
}

async function personDocs(uid: string): Promise<{ user: Record<string, unknown>; isCaregiver: boolean }> {
  const user = (await db.collection("users").doc(uid).get()).data() ?? {};
  const isCaregiver = user.userType === "caregiver";
  return { user, isCaregiver };
}

async function resolvePhone(uid: string, user: Record<string, unknown>, isCaregiver: boolean): Promise<string | undefined> {
  if (typeof user.phone === "string" && user.phone) return user.phone;
  if (isCaregiver) {
    const cg = (await db.collection("caregivers").doc(uid).get()).data() ?? {};
    if (typeof cg.phone === "string" && cg.phone) return cg.phone;
  }
  return (await admin.auth().getUser(uid).catch(() => null))?.phoneNumber ?? undefined;
}

/** Write the same flat fields to users/{uid} and, for a care provider, caregivers/{uid}. */
async function mirrorFlags(uid: string, isCaregiver: boolean, fields: Record<string, unknown>): Promise<void> {
  await db.collection("users").doc(uid).set(fields, { merge: true });
  if (isCaregiver) await db.collection("caregivers").doc(uid).set(fields, { merge: true }).catch(() => {});
}

export function personLabel(user: Record<string, unknown>, fallback = "Someone"): string {
  const name = [user.firstName, user.lastName].filter((x) => typeof x === "string" && x).join(" ").trim()
    || (typeof user.name === "string" ? user.name : "") || (typeof user.displayName === "string" ? user.displayName : "");
  return name || fallback;
}

/** Turn human mode on or off for one person. Idempotent. */
export async function setHumanMode(input: {
  uid: string; on: boolean; reason: HumanModeReason; by: { uid: string; name: string } | "evia"; phone?: string;
}): Promise<{ phone?: string }> {
  const { user, isCaregiver } = await personDocs(input.uid);
  const phone = input.phone ?? (await resolvePhone(input.uid, user, isCaregiver));
  const now = new Date().toISOString();
  const flag: HumanModeFlag = { on: input.on, since: now, reason: input.reason, by: input.by };
  if (phone) await db.collection("agent_sessions").doc(phone).set({ humanMode: flag }, { merge: true });
  const byName = input.by === "evia" ? "Evia" : input.by.name;
  await mirrorFlags(input.uid, isCaregiver, input.on
    ? { humanModeOn: true, humanModeSince: now, humanModeReason: input.reason, humanModeByName: byName, humanModeUnread: 0, humanModeLastAt: now }
    : { humanModeOn: false, humanModeEndedAt: now, humanModeEndedByName: byName, humanModeUnread: 0 });
  await logAudit({
    eventType: input.on ? "human_mode_on" : "human_mode_off",
    userId: input.uid, ...(phone ? { phone } : {}),
    data: { reason: input.reason, byName, ...(input.by !== "evia" ? { adminUid: input.by.uid, adminName: input.by.name } : {}) },
  });
  return { phone };
}

/**
 * A text from a person whose thread the team holds: Evia stays quiet; the text is
 * already mirrored into the thread by the webhook; the counters move and the team
 * is alerted. Returns false for STOP words so the normal handler takes them.
 */
export async function handleInboundWhileHuman(input: { phone: string; session: AgentSession; text: string }): Promise<boolean> {
  if (isStopWord(input.text)) return false;
  const uid = typeof input.session.userId === "string" ? input.session.userId : undefined;
  const preview = input.text.trim().slice(0, 160);
  if (uid) {
    const { user, isCaregiver } = await personDocs(uid);
    await mirrorFlags(uid, isCaregiver, {
      humanModeLastText: preview, humanModeLastAt: new Date().toISOString(),
      humanModeUnread: admin.firestore.FieldValue.increment(1),
    });
    const role = isCaregiver ? "caregiver" : "client";
    await db.collection("admin_alerts").add({
      type: "human_mode_text", severity: "medium", priority: "medium",
      userId: uid, role, phone: input.phone,
      message: `${personLabel(user)} (${role === "caregiver" ? "care provider" : "client"}) texted while the team has their thread: "${preview}" — reply from their admin page (Messages tab).`,
      source: "human_mode", createdAt: new Date().toISOString(), resolved: false,
    }).catch((err) => console.warn("humanMode: team alert failed", err instanceof Error ? err.message : err));
  }
  return true;
}

/** The team's reply, from Evia's number, into the same thread (mirrored with source "team"). */
export async function sendTeamText(input: { uid: string; text: string; adminUid: string; adminName: string; phone?: string }): Promise<void> {
  const text = input.text.trim();
  if (!text) throw new Error("Nothing to send");
  const { user, isCaregiver } = await personDocs(input.uid);
  const phone = input.phone ?? (await resolvePhone(input.uid, user, isCaregiver));
  if (!phone) throw new Error("No phone number on this account yet");
  await sendToPhone(phone, text, { mirrorSource: "team" });
  await mirrorFlags(input.uid, isCaregiver, { humanModeUnread: 0, humanModeLastTeamAt: new Date().toISOString() });
  await logAudit({ eventType: "team_text_sent", userId: input.uid, phone, data: { adminUid: input.adminUid, adminName: input.adminName, chars: text.length } });
}
