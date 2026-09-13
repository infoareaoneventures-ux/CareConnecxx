import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { createInterviewCallAssets } from "../agents/interviewLinks";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import { trySend } from "../utils/toolNotify";
import { parseScheduledTimeMs, formatInterviewTime } from "../utils/scheduledTime";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";

const db = admin.firestore();

// ── Link enforcement point for video_interviews ────────────────────────────────
//
// Sibling of onVideoInterviewWrite (in-app notifications, untouched): any
// video_interviews doc that reaches an agreed status without a call link gets
// one generated, persisted, delivered to both participants, and reminded —
// regardless of which writer created it. This is what covers the web
// ScheduleInterviewModal path (the web writes Firestore directly; there is no
// server hook to call) and any future writer.
//
// Concurrency contract (v1 events are at-least-once and can run concurrently):
//   - generation/delivery work is claimed via transaction on linkWork.claimedAt
//     (stale after CLAIM_TTL_MS so a crashed invocation self-heals)
//   - the predicate is state-based ("agreed AND work outstanding"), not
//     transition-based, so a missed event is repaired by the next write
//   - delivery is tracked per-recipient (linkDelivery.client / .caregiver);
//     a re-fired event completes only what is missing, never re-sends
//   - the MCP schedule_interview tool writes new requests as "requested" (the
//     same not-yet-agreed status the website's own request flow uses), so
//     this trigger's link/reminder pass — and the Meet-link/reminder texts it
//     sends — only ever fires once respond_to_interview_request moves the
//     doc into "confirmed", exactly like a website caregiver clicking Accept
//
// SECURITY: never log callUrl/icsUrl values — OPEN links are joinable by
// anyone who holds them. Log interview doc IDs only.

const AGREED = new Set(["accepted", "confirmed", "scheduled"]);
const CLAIM_TTL_MS = 5 * 60 * 1000;
const INTERVIEW_MINUTES = 30;

type DeliveryOutcome = { status: string; at: string };
type InterviewDoc = Record<string, unknown> & {
  status?: string;
  callUrl?: string;
  icsUrl?: string;
  clientId?: string;
  caregiverId?: string;
  clientName?: string;
  caregiverName?: string;
  scheduledTime?: string;
  linkDelivery?: { client?: DeliveryOutcome; caregiver?: DeliveryOutcome };
  linkWork?: { claimedAt?: string };
  remindersScheduledAt?: string;
  requestNotifiedAt?: string;
};

function deliveryComplete(doc: InterviewDoc): boolean {
  return Boolean(doc.linkDelivery?.client?.status && doc.linkDelivery?.caregiver?.status);
}

export const onVideoInterviewLinkEnsure = functions
  .runWith({ timeoutSeconds: 120 })
  .firestore.document("video_interviews/{interviewId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after = change.after.data() as InterviewDoc;
    const interviewId = context.params.interviewId as string;
    const ref = change.after.ref;

    try {
      // Web-created requests: SMS the caregiver so Evia-onboarded (phone-keyed,
      // no web login) caregivers can accept by text. The in-app notification
      // from onVideoInterviewWrite only reaches auth-account caregivers.
      if (!change.before.exists && after.status === "requested" && !after.requestNotifiedAt) {
        await notifyCaregiverOfRequest(ref, interviewId, after);
        return;
      }

      // Agreed → terminal transition (declined/cancelled/no-response): retire
      // the 1h reminders so nobody gets "your interview is in an hour" for a
      // dead interview. Clearing remindersScheduledAt lets a later
      // re-agreement schedule fresh ones.
      const before = change.before.exists ? (change.before.data() as InterviewDoc) : null;
      if (before?.status && AGREED.has(before.status) && after.status && !AGREED.has(after.status)) {
        const { cancelTriggersByRef } = await import("./triggerEngine");
        const n = await cancelTriggersByRef(`video_interview_${interviewId}`).catch(() => 0);
        if (after.remindersScheduledAt) {
          await ref.update({ remindersScheduledAt: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
        if (n > 0) console.log(`onVideoInterviewLinkEnsure: cancelled ${n} reminder(s) for ${interviewId} (${after.status})`);
        return;
      }

      if (!after.status || !AGREED.has(after.status)) return;

      // Fast precheck — most writes on a fully-processed doc stop here
      if (after.callUrl && deliveryComplete(after) && after.remindersScheduledAt) return;

      // Transactional work claim
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const cur = snap.data() as InterviewDoc;
        if (cur.callUrl && deliveryComplete(cur) && cur.remindersScheduledAt) return false;
        const claimedAt = cur.linkWork?.claimedAt;
        if (claimedAt && Date.now() - new Date(claimedAt).getTime() < CLAIM_TTL_MS) return false;
        tx.update(ref, { "linkWork.claimedAt": new Date().toISOString() });
        return true;
      });
      if (!claimed) return;

      try {
        await processInterview(ref, interviewId);
      } finally {
        await ref.update({ "linkWork.claimedAt": admin.firestore.FieldValue.delete() }).catch(() => {});
      }
    } catch (err) {
      // Never crash-loop the trigger; the state-based predicate retries on the
      // next write and the ops alert (raised where the failure happened) pages.
      console.error(`onVideoInterviewLinkEnsure error for ${interviewId}:`, err);
    }
  });

// ── Work pass: generate → deliver → remind ────────────────────────────────────

async function processInterview(
  ref: FirebaseFirestore.DocumentReference,
  interviewId: string
): Promise<void> {
  const snap = await ref.get();
  if (!snap.exists) return;
  const doc = snap.data() as InterviewDoc;
  if (!doc.status || !AGREED.has(doc.status)) return;

  const startMs = parseScheduledTimeMs(doc.scheduledTime ?? "");
  if (Number.isNaN(startMs)) {
    console.error(`Interview ${interviewId} has unparseable scheduledTime; skipping`);
    return;
  }
  const caregiverName = (doc.caregiverName as string) || "the caregiver";
  const clientName    = (doc.clientName as string) || "the family";
  const formatted     = formatInterviewTime(startMs);

  // 1. Ensure link
  let callUrl = doc.callUrl ?? "";
  let icsUrl  = doc.icsUrl ?? "";
  if (!callUrl) {
    // Failure raises the ops alert inside the helper and throws; the claim is
    // released by the caller's finally so a later write can retry.
    const assets = await createInterviewCallAssets({
      title:           `Care Interview — ${caregiverName}`,
      startTime:       new Date(startMs).toISOString(),
      durationMinutes: INTERVIEW_MINUTES,
      interviewId,
      icsStoragePrefix: "video_interviews",
    });
    callUrl = assets.callUrl;
    icsUrl  = assets.icsUrl;
    await ref.update({ callUrl, ...(icsUrl ? { icsUrl } : {}) });
  }

  // 2. Deliver to whichever recipients are still missing a terminal outcome
  const delivery = doc.linkDelivery ?? {};
  const updates: Record<string, unknown> = {};

  if (!delivery.caregiver?.status) {
    const cgPhone = await resolveCaregiverPhone(doc.caregiverId);
    const outcome = await deliverLink(cgPhone, interviewId, "caregiver",
      `Your interview with ${clientName} is confirmed for ${formatted}. Join from your phone: ${callUrl}` +
      (icsUrl ? `\n\nCalendar invite: ${icsUrl}` : ""));
    if (outcome) updates["linkDelivery.caregiver"] = outcome;
  }

  if (!delivery.client?.status) {
    const clientPhone = await resolveClientPhone(doc.clientId);
    const outcome = await deliverLink(clientPhone, interviewId, "client",
      `Your interview with ${caregiverName} is confirmed for ${formatted}. Join from your phone: ${callUrl}` +
      (icsUrl ? `\n\nCalendar invite: ${icsUrl}` : ""));
    if (outcome) updates["linkDelivery.client"] = outcome;
  }

  // 3. Reminders (1h before, both parties) — transactional, calibration-exempt
  if (!doc.remindersScheduledAt) {
    const scheduled = await scheduleReminders(doc, interviewId, startMs, callUrl, caregiverName);
    if (scheduled) updates.remindersScheduledAt = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) await ref.update(updates);
}

// Terminal outcomes are recorded so re-fired events never re-send; a hard send
// failure records nothing, leaving the recipient eligible for retry on the
// next write.
async function deliverLink(
  phone: string | undefined,
  interviewId: string,
  who: "client" | "caregiver",
  message: string
): Promise<DeliveryOutcome | null> {
  const at = new Date().toISOString();
  if (!phone) {
    await createCaraOpsAlert({
      type:     "interview_link_undeliverable",
      severity: "medium",
      source:   "interviewLinkTrigger",
      reason:   `No reachable phone for ${who} on interview ${interviewId}; link not delivered by SMS.`,
    }).catch(() => {});
    return { status: "missing_phone", at };
  }
  const outcome = await trySend(phone, message, `interviewLinkTrigger:${who}`);
  if (outcome.sent) return { status: "sent", at };
  if (outcome.reason === "queued_for_retry") return { status: "queued", at };
  if (outcome.reason === "recipient_opted_out") return { status: "skipped_opt_out", at };
  // linq_line_unavailable / linq_send_failed → non-terminal, retry later
  return null;
}

async function resolveClientPhone(clientId?: string): Promise<string | undefined> {
  if (!clientId) return undefined;
  const userSnap = await db.collection("users").doc(clientId).get();
  const userPhone = userSnap.data()?.phone as string | undefined;
  if (userPhone) return userPhone;
  const sessSnap = await db.collection("agent_sessions").where("userId", "==", clientId).limit(1).get();
  return sessSnap.empty ? undefined : sessSnap.docs[0].id; // agent_sessions are phone-keyed
}

// resolveCaregiverPhone moved to ../utils/caregiverPhone.ts (2026-09-13) so
// mcp/server.ts's identical caregiver-phone lookups (10 occurrences, three of
// them a security ownership check that was unconditionally failing) share the
// exact same fix instead of drifting from this file's copy.

async function scheduleReminders(
  doc: InterviewDoc,
  interviewId: string,
  startMs: number,
  callUrl: string,
  caregiverName: string
): Promise<boolean> {
  const oneHourBefore = startMs - 60 * 60 * 1000;
  const ninetyMinAway = startMs - 90 * 60 * 1000;
  if (Date.now() >= ninetyMinAway) return true; // too close — mark done, no stale reminder

  const { scheduleTrigger } = await import("./triggerEngine");
  const refId = `video_interview_${interviewId}`; // cancelTriggersByRef key on decline/cancel
  const clientPhone = await resolveClientPhone(doc.clientId);
  if (clientPhone) {
    await scheduleTrigger({
      userId:      doc.clientId ?? clientPhone,
      phone:       clientPhone,
      type:        "appointment_reminder",
      scheduledAt: new Date(oneHourBefore).toISOString(),
      message:     `Your interview with ${caregiverName} is in an hour — ${callUrl}`,
      refId,
    }, { bypassCalibration: true }).catch((err) => console.error("interview reminder (client) error:", err));
  }
  const cgPhone = await resolveCaregiverPhone(doc.caregiverId);
  if (cgPhone) {
    await scheduleTrigger({
      userId:      doc.caregiverId ?? cgPhone,
      phone:       cgPhone,
      type:        "appointment_reminder",
      scheduledAt: new Date(oneHourBefore).toISOString(),
      message:     `Interview in an hour with a family — ${callUrl} Reply if you need to reschedule.`,
      refId,
    }, { bypassCalibration: true }).catch((err) => console.error("interview reminder (caregiver) error:", err));
  }
  return true;
}

// ── Web-created 'requested' docs: SMS the caregiver an accept path ────────────

async function notifyCaregiverOfRequest(
  ref: FirebaseFirestore.DocumentReference,
  interviewId: string,
  doc: InterviewDoc
): Promise<void> {
  if (!doc.caregiverId) return;
  const cgPhone = await resolveCaregiverPhone(doc.caregiverId);
  if (!cgPhone) return; // no phone on file anywhere — in-app notification is the only path left

  const startMs = parseScheduledTimeMs(doc.scheduledTime ?? "");
  const when = Number.isNaN(startMs) ? "a time that works" : formatInterviewTime(startMs);
  const clientName = (doc.clientName as string) || "A family";

  const outcome = await trySend(
    cgPhone,
    `Hi — ${clientName} would like a 30-minute video interview with you on ${when}. ` +
    `Reply to confirm, or suggest another time and I'll pass it along.`,
    "interviewLinkTrigger:requested"
  );
  await ref.update({ requestNotifiedAt: new Date().toISOString() }).catch(() => {});
  if (!outcome.sent && outcome.reason !== "recipient_opted_out") {
    console.warn(`Interview request SMS to caregiver not sent for ${interviewId}: ${outcome.reason}`);
  }
}
