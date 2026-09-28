// Caregiver-side "still waiting on you" nudges (founder, 2026-09-27/28: "does
// the caregiver get a reminder or nudge" on a pending booking request /
// interview request → "yes", plus schedule changes and replacement requests).
//
// A request the caregiver hasn't answered never prompted them again — the site
// only shows the Requests badge. This job re-prompts:
//   • interview request (video_interviews awaiting the caregiver)
//   • booking request  (booking_requests pending)
//   • replacement request (booking_requests pending + isShiftReplacement) —
//     time-critical, so a faster cycle
//   • schedule change  (booking_amendments pending)
// 24h after the request, then every 48h while it's pending (replacements: 2h,
// then every 12h until the visit date passes); stops the moment it's answered
// or withdrawn (the record is no longer pending). Each nudge is the same words
// as the original notice, texted AND mirrored to the bell (idempotent per
// window), and re-parks the decision so a plain ACCEPT / DECLINE reply runs the
// page's button (agents/decisionNotices.ts).
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { parseScheduledTimeMs, formatInterviewTime, formatDateForDisplay } from "../utils/scheduledTime";
import { parkedDecision, type DecisionKind } from "../agents/decisionNotices";

const db = admin.firestore();

export const NUDGE_DELAY_MS       = 24 * 60 * 60 * 1000;
export const RENUDGE_COOLDOWN_MS  = 48 * 60 * 60 * 1000;
export const REPLACEMENT_DELAY_MS    = 2 * 60 * 60 * 1000;
export const REPLACEMENT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Pure decision: nudge now? (createdMs/lastNudgedMs may be null when unparseable → never). */
export function shouldNudgePendingDecision(p: {
  createdMs: number | null; lastNudgedMs: number | null; nowMs: number; replacement?: boolean; visitDate?: string | null; today?: string;
}): boolean {
  if (p.createdMs === null) return false;
  const delay = p.replacement ? REPLACEMENT_DELAY_MS : NUDGE_DELAY_MS;
  const cooldown = p.replacement ? REPLACEMENT_COOLDOWN_MS : RENUDGE_COOLDOWN_MS;
  if (p.nowMs - p.createdMs < delay) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < cooldown) return false;
  if (p.replacement && p.visitDate && p.today && p.visitDate < p.today) return false; // the visit is gone
  return true;
}

/** createdAt / respondedAt as either side writes them: a Firestore Timestamp or an ISO string. */
export function toMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") { const ms = Date.parse(value); return Number.isNaN(ms) ? null : ms; }
  if (typeof value === "object") {
    const v = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === "function") return v.toMillis();
    const secs = typeof v.seconds === "number" ? v.seconds : typeof v._seconds === "number" ? v._seconds : null;
    return secs === null ? null : secs * 1000;
  }
  return null;
}

export interface PendingItem {
  kind: DecisionKind;
  collection: "video_interviews" | "booking_requests" | "booking_amendments";
  id: string;
  caregiverId: string;
  clientName: string;
  createdMs: number | null;
  lastNudgedMs: number | null;
  nudgeCount: number;
  replacement: boolean;
  visitDate: string | null;
  /** The notice's words, minus the reply line. */
  body: string;
  replyLine: string;
  label: string;
}

const REPLY: Record<string, string> = {
  interview_request: "Reply ACCEPT or DECLINE, or PROPOSE a different time.",
  booking_request:   "Reply ACCEPT or DECLINE, or DETAILS to see the full request.",
  amendment:         "Reply ACCEPT or DECLINE.",
};

/** The three queries, each the tab's own filter, mapped to one shape. */
export async function loadPendingItems(): Promise<PendingItem[]> {
  const out: PendingItem[] = [];
  // Interview requests awaiting the caregiver (the Interviews tab's Pending chip).
  for (const status of ["requested", "scheduled", "pending"]) {
    const snap = await db.collection("video_interviews").where("status", "==", status).limit(300).get();
    for (const d of snap.docs) {
      const iv = d.data();
      if (!iv.caregiverId) continue;
      if (iv.reschedulePendingTime && iv.rescheduledBy === "caregiver") continue; // their proposal is out — waiting on the family
      const whenMs = parseScheduledTimeMs(String(iv.scheduledTime ?? ""));
      if (Number.isFinite(whenMs) && whenMs > 0 && whenMs < Date.now()) continue;      // the time has passed
      const when = Number.isFinite(whenMs) && whenMs > 0 ? formatInterviewTime(whenMs) : "";
      const client = (iv.clientName as string) || "A family";
      out.push({
        kind: "interview_request", collection: "video_interviews", id: d.id, caregiverId: iv.caregiverId as string, clientName: client,
        createdMs: toMs(iv.createdAt) ?? toMs(iv.requestNotifiedAt), lastNudgedMs: toMs(iv.decisionNudgedAt), nudgeCount: Number(iv.decisionNudgeCount ?? 0),
        replacement: false, visitDate: null,
        body: `${client}'s interview request${iv.jobTitle ? ` for "${iv.jobTitle}"` : ""}${when ? ` (${when})` : ""} is still waiting on you.`,
        replyLine: REPLY.interview_request, label: `an interview request from ${client}`,
      });
    }
  }
  // Booking requests (incl. replacement requests) — the Requests tab.
  {
    const snap = await db.collection("booking_requests").where("status", "==", "pending").limit(300).get();
    for (const d of snap.docs) {
      const b = d.data();
      if (!b.caregiverId) continue;
      const replacement = b.isShiftReplacement === true;
      const client = (b.clientName as string) || "A family";
      const startDate = ((b.schedule as Record<string, unknown> | undefined)?.startDate as string | undefined) ?? null;
      out.push({
        kind: "booking_request", collection: "booking_requests", id: d.id, caregiverId: b.caregiverId as string, clientName: client,
        createdMs: toMs(b.updatedAt && b.isResend ? b.updatedAt : b.createdAt), lastNudgedMs: toMs(b.decisionNudgedAt), nudgeCount: Number(b.decisionNudgeCount ?? 0),
        replacement, visitDate: startDate,
        body: replacement
          ? `${client} needs a replacement caregiver${startDate ? ` on ${formatDateForDisplay(startDate)}` : ""} — the request is still waiting on you.`
          : `${client}'s booking request is still waiting on you.`,
        replyLine: REPLY.booking_request, label: `a booking request from ${client}`,
      });
    }
  }
  // Schedule changes — the Requests tab's second card.
  {
    const snap = await db.collection("booking_amendments").where("status", "==", "pending").limit(300).get();
    for (const d of snap.docs) {
      const a = d.data();
      if (!a.caregiverId) continue;
      const client = (a.clientName as string) || "A family";
      out.push({
        kind: "amendment", collection: "booking_amendments", id: d.id, caregiverId: a.caregiverId as string, clientName: client,
        createdMs: toMs(a.createdAt), lastNudgedMs: toMs(a.decisionNudgedAt), nudgeCount: Number(a.decisionNudgeCount ?? 0),
        replacement: false, visitDate: null,
        body: `${client}'s schedule change request is still waiting on you.`,
        replyLine: REPLY.amendment, label: `a schedule change from ${client}`,
      });
    }
  }
  return out;
}

export async function runPendingDecisionNudges(nowMs = Date.now()): Promise<{ nudged: number; bellOnly: number; skipped: number }> {
  const result = { nudged: 0, bellOnly: 0, skipped: 0 };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const items = await loadPendingItems();
  for (const it of items) {
    try {
      if (!shouldNudgePendingDecision({ createdMs: it.createdMs, lastNudgedMs: it.lastNudgedMs, nowMs, replacement: it.replacement, visitDate: it.visitDate, today })) { result.skipped++; continue; }
      const text = `${it.body} ${it.replyLine}`;
      // Bell first (idempotent per nudge number), then the text with the same words.
      await writeUserNotification({
        sourcePath: `${it.collection}/${it.id}`, eventId: `decision-nudge-${it.nudgeCount + 1}`, recipientId: it.caregiverId,
        transitionType: "decision_nudge", type: it.kind === "interview_request" ? "interview_request" : it.kind === "amendment" ? "amendment_request" : "booking_request",
        title: "Still waiting on you", body: it.body, data: { [it.collection === "video_interviews" ? "interviewId" : it.collection === "booking_amendments" ? "amendmentId" : "bookingId"]: it.id },
      }).catch((err) => console.error("[pendingDecisionNudge] bell failed:", it.collection, it.id, err));

      const phone = await resolveCaregiverPhone(it.caregiverId);
      const sessSnap = phone ? await db.collection("agent_sessions").doc(phone).get().catch(() => null) : null;
      let sent = false;
      if (phone && sessSnap?.exists && !sessSnap.data()?.optedOut) {
        // Re-park the decision so a plain ACCEPT / DECLINE reply runs the page's button.
        await db.collection("agent_sessions").doc(phone).set(
          { pendingDecision: parkedDecision(it.kind, it.id, it.label, "caregiver", nowMs, it.clientName) }, { merge: true },
        ).catch(() => {});
        sent = await sendViaInteractionAgent(phone, { content: text, urgency: "standard", sourceAgent: "pending_decision_nudge", canDrop: true });
      }
      // Stamp the window either way — the bell went out; a dropped text is retried next window, never spammed.
      await db.collection(it.collection).doc(it.id).update({
        decisionNudgeCount: it.nudgeCount + 1, decisionNudgedAt: new Date(nowMs).toISOString(),
      }).catch(() => {});
      if (sent) result.nudged++; else result.bellOnly++;
    } catch (err) {
      console.error(`[pendingDecisionNudge] error for ${it.collection}/${it.id}:`, err);
    }
  }
  return result;
}

export const sendPendingDecisionNudges = functions.pubsub
  .schedule("0 * * * *")
  .onRun(async () => {
    const r = await runPendingDecisionNudges();
    console.log("[pendingDecisionNudge]", r);
  });
