import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { claimProactiveTrigger, settleProactiveTriggerDelivery } from "./proactiveTriggerClaim";
import { gateOptionalSend } from "../scheduled/engineGate";

const db = admin.firestore();

const SYSTEM_DIRECTIVE_PREFIXES = [
  "health_escalation:",
  "qa_retry:",
];

function isSystemDirectiveMessage(message: string): boolean {
  return SYSTEM_DIRECTIVE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export interface ProactiveTrigger {
  id?:               string;
  userId:            string;
  phone:             string;
  // (weekly_checkin / medication_reminder and the health_* types were removed
  // 2026-09-27: nothing ever scheduled them and the website has no such thing.)
  type:              "appointment_reminder" | "custom"
                   | "qa_retry" | "caregiver_checkin" | "caregiver_checkin_escalation";
  scheduledAt:       string;   // ISO
  message:           string;
  firedAt?:          string | null;
  cancelledAt?:      string | null;
  deliveryState?:    "firing" | "delivered" | "failed_ambiguous" | "suppressed";
  deliveryClaimedAt?: string;
  deliveryCompletedAt?: string;
  deliveryError?:    string | null;
  createdAt:         string;
  // Links a trigger to the record it serves (e.g. "video_interview_<id>") so
  // cancelTriggersByRef can retire reminders when that record is cancelled.
  refId?:            string;
  // A website-bell copy of the reminder, written when it fires (founder's
  // rule, 2026-09-26: every reminder text is also in the bell). Idempotent per
  // trigger doc (users/{recipientId}/notifications keyed on the trigger id).
  bell?: { recipientId: string; type: string; title: string; body: string; data?: Record<string, unknown> };
  // Claude-scheduled trigger fields
  source?:           "claude" | "system";   // "claude" = scheduled by Evia via schedule_followup tool
  intent?:           string;                // why this trigger exists (used for dynamic content + suppression)
  suppressionReason?: string;               // set when context-aware suppression cancels the trigger
  expiresAt?:        string;
  feedbackReceived?: string | null;
  metadata?: {
    appointmentId?: string;
    clientId?:      string;
    caregiverId?:   string;
    [key: string]: unknown;
  };
}

// 30-day calibration period — no proactive triggers during this window
function isInCalibrationPeriod(sessionCreatedAt: string): boolean {
  const createdMs = new Date(sessionCreatedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - createdMs < thirtyDaysMs;
}

// Schedule a proactive trigger — no-op during calibration period.
// Transactional triggers (e.g. interview reminders for an interview the user
// just booked) pass bypassCalibration: the 30-day gate exists to suppress
// unsolicited proactive outreach, not confirmations of actions the user took —
// and interviews cluster in a user's first weeks, exactly inside the window.
export async function scheduleTrigger(
  trigger: Omit<ProactiveTrigger, "id" | "createdAt">,
  opts: { bypassCalibration?: boolean; idempotencyKey?: string } = {}
): Promise<string> {
  // Check calibration
  if (!opts.bypassCalibration) {
    const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
    if (sessionSnap.exists) {
      const session = sessionSnap.data()!;
      if (session.createdAt && isInCalibrationPeriod(session.createdAt as string)) {
        return ""; // Silently skip during calibration
      }
    }
  }

  const triggerDoc = {
    ...trigger,
    firedAt:     trigger.firedAt ?? null,
    cancelledAt: trigger.cancelledAt ?? null,
    createdAt:   new Date().toISOString(),
  };

  if (opts.idempotencyKey) {
    const id = opts.idempotencyKey.replace(/\//g, "%2F");
    const ref = db.collection("proactive_triggers").doc(id);
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (!existing.exists) {
        transaction.create(ref, triggerDoc);
      }
    });
    return id;
  }

  const ref = await db.collection("proactive_triggers").add(triggerDoc);
  return ref.id;
}

// ── Dynamic message generation for Claude-scheduled triggers ─────────────────
// Regenerates the message at fire time using current memory context, so the
// message feels written in the moment rather than frozen from days ago.

// Exported for tests (U2 — anti-invention clause + output guard).
export async function generateTriggerMessage(
  trigger: ProactiveTrigger,
  memoryContext: string
): Promise<string> {
  try {
    const resp = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 120,
      system:
        "You are Evia, a care coordinator. Write a single brief follow-up text message (1–2 sentences).\n" +
        "Tone: warm, specific, natural — like a care coordinator who remembers the context.\n" +
        "Use the family's care context and the reason for the follow-up to make it feel relevant.\n" +
        "No bullet points. No emoji. No preamble. Output only the message text.\n" +
        ANTI_INVENTION_CLAUSE,
      messages: [{
        role:    "user",
        content:
          `Reason for this follow-up: ${trigger.intent ?? "general check-in"}\n` +
          `Original planned message: ${trigger.message}\n` +
          `Care context:\n${memoryContext.slice(0, 600)}`,
      }],
    });
    const text = ((resp.content[0] as { text: string }).text ?? "").trim();
    // Output guard (U2, R2): a meta-response or composed URL is never delivered
    // — the stored trigger message goes out instead.
    if (text && caraOutputGuardEnabled() && !guardModelOutput(text).ok) {
      return trigger.message;
    }
    return text || trigger.message;
  } catch {
    return trigger.message; // fall back to the stored message
  }
}

// ── Context-aware suppression for Claude-scheduled triggers ───────────────────
// Checks recent conversation to see if the follow-up is still relevant before sending.

// Exported for tests (U2 — anti-invention clause + output guard).
export async function shouldFireTrigger(
  trigger: ProactiveTrigger,
  recentMessages: Array<{ role: string; content: string }>
): Promise<boolean> {
  if (!trigger.intent) return true; // no intent = system trigger = always fire
  if (recentMessages.length === 0) return true;

  const recentText = recentMessages
    .slice(-3)
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  try {
    const resp = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 5,
      system:
        "You decide if a scheduled follow-up message should still be sent, given recent conversation.\n" +
        "Reply YES if the follow-up is still relevant and useful.\n" +
        "Reply NO if the family already addressed this topic, the situation has resolved, or it would feel out of context.\n" +
        // U2: shared grounding rule rides here too; the one-word directive
        // stays last so the reply format is unambiguous.
        ANTI_INVENTION_CLAUSE + "\n" +
        "One word only: YES or NO.",
      messages: [{
        role:    "user",
        content:
          `Follow-up intent: ${trigger.intent}\n` +
          `Follow-up message: ${trigger.message}\n\n` +
          `Recent conversation:\n${recentText}`,
      }],
    });
    const raw = ((resp.content[0] as { text: string }).text ?? "").trim();
    // Output guard (U2): a guard-rejected verdict is untrusted — default open,
    // same as the catch below.
    if (raw && caraOutputGuardEnabled() && !guardModelOutput(raw).ok) {
      return true;
    }
    const answer = raw.toUpperCase();
    return answer !== "NO";
  } catch {
    return true; // default open on failure
  }
}

// Time-critical/transactional triggers a user reply must NOT invalidate: an
// interview or medication reminder is still owed after the family texts Evia
// about something unrelated, and system directives (caregiver check-ins,
// post-interview follow-ups, escalations) are work items, not nudges.
// qa_retry stays reply-cancellable on purpose — a new inbound starts a fresh
// turn and the commitment tracker backstops the promised answer.
const REPLY_EXEMPT_TYPES = new Set([
  "appointment_reminder",
]);
// (the issue_escalation / issue_followup directives were removed 2026-09-28 with the ISSUE pipeline)
const REPLY_EXEMPT_MESSAGE_PREFIXES: string[] = [];
export function isReplyExempt(t: Pick<ProactiveTrigger, "type" | "message">): boolean {
  if (REPLY_EXEMPT_TYPES.has(t.type)) return true;
  return REPLY_EXEMPT_MESSAGE_PREFIXES.some((p) => t.message?.startsWith(p));
}

// How the engine hands a fired trigger to the send layer. Transactional
// reminders (the reply-exempt types: the 1h interview reminder, issue
// directives) are NEVER droppable — no LLM SEND/WAIT judge, no 3/day
// proactive cap — exactly like the shift reminders (thirtyMinShiftReminder,
// clientDayBeforeReminder send canDrop: false). 2026-09-27 live: the 1h
// interview reminder reached the family while the caregiver's was silently
// dropped by the send layer, so the two sides didn't match. Discretionary
// triggers (weekly check-ins, Evia-scheduled follow-ups) stay droppable.
export function triggerSendOptions(t: Pick<ProactiveTrigger, "type" | "message">): { urgency: "standard"; canDrop: boolean } {
  return { urgency: "standard", canDrop: !isReplyExempt(t) };
}

// U8 engine gate (KTD15): classify a DISCRETIONARY trigger's content into a
// policy category. Visit-related content outranks money, which outranks the
// generic re-engagement default. Exported for tests.
export function discretionaryCategory(text: string): "re_engagement" | "visit_risk" | "billing_heads_up" {
  const t = (text ?? "").toLowerCase();
  if (/\b(visit|appointment|shift|booking|caregiver)\b/.test(t)) return "visit_risk";
  if (/\b(payment|invoice|bill|billing|charge|subscription|refund|dispute|payout)\b/.test(t)) return "billing_heads_up";
  return "re_engagement";
}

// ── Stale triggers (2026-10-01, live-caught) ─────────────────────────────────
// Degraded mode held every proactive send from Sep 27 until the next successful
// agent turn — Oct 1, 8:09 PM — and the very next engine run released the
// Sep 27 "your interview is in an hour" reminders to BOTH parties, four days
// late. Two rules now:
//   • a time-critical reminder (appointment_reminder) that is more than 2 hours
//     past its scheduledAt is never sent — it is cancelled as stale; any other
//     trigger more than a day late is cancelled too;
//   • an interview reminder (refId video_interview_<id>) is checked against the
//     LIVE interview at fire time — still accepted/confirmed and still starting
//     30–120 minutes from now — else cancelled (goal 8: act on live data only).
export const STALE_REMINDER_MS = 2 * 60 * 60 * 1000;
export const STALE_GENERIC_MS = 24 * 60 * 60 * 1000;
export function isStaleTrigger(t: Pick<ProactiveTrigger, "type" | "scheduledAt">, nowMs: number): boolean {
  const due = Date.parse(t.scheduledAt);
  if (!Number.isFinite(due)) return false;
  const late = nowMs - due;
  return late > (t.type === "appointment_reminder" ? STALE_REMINDER_MS : STALE_GENERIC_MS);
}
/** For an interview reminder: is the live interview still on, and still about an hour away? */
export function interviewReminderStillValid(iv: { status?: unknown; scheduledTime?: unknown } | null | undefined, nowMs: number): boolean {
  if (!iv || !AGREED_INTERVIEW.has(String(iv.status ?? ""))) return false;
  const start = typeof iv.scheduledTime === "string" ? Date.parse(iv.scheduledTime) : NaN;
  if (!Number.isFinite(start)) return false;
  const ahead = start - nowMs;
  return ahead >= 30 * 60 * 1000 && ahead <= 120 * 60 * 1000;
}
const AGREED_INTERVIEW = new Set(["accepted", "confirmed"]);
const INTERVIEW_REF = /^video_interview_(.+)$/;

// Cancels every pending trigger stamped with this refId (see ProactiveTrigger.refId).
// Fired/already-cancelled triggers are left untouched; safe to call repeatedly.
export async function cancelTriggersByRef(refId: string): Promise<number> {
  const snap = await db.collection("proactive_triggers")
    .where("refId", "==", refId)
    .get();
  const now = new Date().toISOString();
  const batch = db.batch();
  let cancelled = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as ProactiveTrigger;
    if (!d.firedAt && !d.cancelledAt) {
      batch.update(doc.ref, { cancelledAt: now });
      cancelled++;
    }
  }
  if (cancelled > 0) await batch.commit().catch(() => {});
  return cancelled;
}

// Called at the top of the main webhook handler (after crisis check) to cancel pending triggers
// Twin-trigger pattern: if user replied, cancel their scheduled nudge
export async function cancelTriggerIfUserReplied(userId: string, phone: string): Promise<void> {
  const now = new Date().toISOString();

  const snap = await db
    .collection("proactive_triggers")
    .where("userId", "==", userId)
    .where("cancelledAt", "==", null)
    .where("firedAt",     "==", null)
    .get();

  if (!snap.empty) {
    const batch = db.batch();
    let toCancel = 0;
    for (const doc of snap.docs) {
      if (isReplyExempt(doc.data() as ProactiveTrigger)) continue;
      batch.update(doc.ref, { cancelledAt: now });
      toCancel++;
    }
    if (toCancel > 0) await batch.commit().catch(() => {});
  }

  // Mark any recently-fired triggers as engaged — user replied
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const firedSnap = await db
    .collection("proactive_triggers")
    .where("userId",    "==", userId)
    .where("firedAt",   ">=", oneDayAgo)
    .get();

  for (const doc of firedSnap.docs) {
    const data = doc.data() as ProactiveTrigger;
    if (!data.firedAt || (data as any).engagedAt) continue;
    await doc.ref.update({ engagedAt: now });
    await markTriggerEngaged(phone, data.type);
  }
}

// Reset consecutive-ignore count when user engages with a trigger
export async function markTriggerEngaged(phone: string, triggerType: string): Promise<void> {
  await db.collection("trigger_engagement")
    .doc(`${phone}_${triggerType}`)
    .set({ consecutiveIgnores: 0, lastEngagedAt: new Date().toISOString() }, { merge: true });
}

async function pauseTriggerType(phone: string, triggerType: string): Promise<void> {
  await db.collection("trigger_engagement")
    .doc(`${phone}_${triggerType}`)
    .set({ paused: true, pausedAt: new Date().toISOString() }, { merge: true });

  // Cancel any pending triggers of this type for this user
  const snap = await db.collection("proactive_triggers")
    .where("phone", "==", phone)
    .where("type",  "==", triggerType)
    .get();

  const now   = new Date().toISOString();
  const batch = db.batch();
  for (const doc of snap.docs) {
    const d = doc.data() as ProactiveTrigger;
    if (!d.firedAt && !d.cancelledAt) batch.update(doc.ref, { cancelledAt: now });
  }
  await batch.commit().catch(() => {});
}

// Detect triggers fired 24h+ ago with no user response; pause after 3 consecutive ignores
export async function checkIgnoredTriggers(): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const snap = await db.collection("proactive_triggers")
    .where("firedAt", "<=", oneDayAgo)
    .get();

  for (const doc of snap.docs) {
    const trigger = doc.data() as ProactiveTrigger & { engagedAt?: string; ignoreCounted?: boolean };
    if (!trigger.firedAt) continue;
    if (trigger.engagedAt) continue;    // user did engage
    if (trigger.ignoreCounted) continue; // already counted

    const engRef  = db.collection("trigger_engagement").doc(`${trigger.phone}_${trigger.type}`);
    const engSnap = await engRef.get();
    const prev    = (engSnap.data()?.consecutiveIgnores as number | undefined) ?? 0;
    const consecutiveIgnores = prev + 1;

    await engRef.set({
      phone:       trigger.phone,
      triggerType: trigger.type,
      consecutiveIgnores,
      lastIgnoredAt: new Date().toISOString(),
    }, { merge: true });

    await doc.ref.update({ ignoreCounted: true });

    if (consecutiveIgnores >= 3) {
      await pauseTriggerType(trigger.phone, trigger.type);

      const triggerFriendlyNames: Record<string, string> = {
        appointment_reminder: "appointment reminders",
        custom:               "these messages",
      };
      const friendlyName = triggerFriendlyNames[trigger.type] ?? "these messages";

      // U8 engine gate (KTD15): the pause itself already happened above — only
      // this courtesy notice is discretionary, so only the notice is gated. A
      // disallowed pass drops the notice (the pause stands quietly).
      const day = new Date().toISOString().slice(0, 10);
      const g = await gateOptionalSend({
        phone: trigger.phone,
        candidate: {
          source: "triggerEngine",
          category: "re_engagement",
          urgency: 1,
          evidenceCount: 1,
          dedupeKey: `trig:pause_notice_${trigger.type}:${trigger.phone}:${day}`,
        },
      });
      if (!g.allowed) {
        console.info("triggerEngine.policy", {
          context: "pause_notice", phone: trigger.phone, type: trigger.type,
          disposition: g.disposition, reason: g.reason,
        });
        continue;
      }

      await sendViaInteractionAgent(trigger.phone, {
        content:
          `I've paused the ${friendlyName} since you haven't been using them lately.\n\n` +
          `Want me to turn them back on, try a different time, or skip them for now?`,
        urgency:     "standard",
        sourceAgent: "trigger_engine",
        canDrop:     false,
      });
    }
  }
}

// Every-5-minute executor — fires due triggers, skips cancelled/fired ones
export const runTriggerEngine = functions.pubsub
  .schedule("*/5 * * * *")
  .onRun(async () => {
    const now = new Date().toISOString();

    // System-wide degraded mode (provider billing/auth outage): hold generic
    // proactive sends so users aren't pinged by a system that can't hold a
    // conversation. Held triggers stay unfired and go out on the first run
    // after recovery. Health/safety and operational triggers still fire.
    const degraded = await import("../observability/systemStatus")
      .then((m) => m.isSystemDegraded())
      .catch(() => false);

    const snap = await db
      .collection("proactive_triggers")
      .where("firedAt", "==", null)
      .where("cancelledAt", "==", null)
      .where("scheduledAt", "<=", now)
      .orderBy("scheduledAt", "asc")
      .limit(100)
      .get();

    for (const doc of snap.docs) {
      const trigger = doc.data() as ProactiveTrigger;

      // Skip already fired or cancelled
      if (trigger.firedAt || trigger.cancelledAt) continue;

      // Never send a reminder about something that already happened (see isStaleTrigger).
      if (isStaleTrigger(trigger, Date.parse(now))) {
        await doc.ref.update({ cancelledAt: now, suppressionReason: "stale", deliveryState: "suppressed", deliveryCompletedAt: now }).catch(() => {});
        console.info("triggerEngine.stale", { triggerId: doc.id, type: trigger.type, scheduledAt: trigger.scheduledAt });
        continue;
      }
      // An interview reminder fires only if the LIVE interview is still on and still about an hour away.
      const ivRef = trigger.refId ? INTERVIEW_REF.exec(trigger.refId) : null;
      if (ivRef) {
        const ivSnap = await db.collection("video_interviews").doc(ivRef[1]).get().catch(() => null);
        if (!interviewReminderStillValid(ivSnap?.exists ? ivSnap.data() : null, Date.parse(now))) {
          await doc.ref.update({ cancelledAt: now, suppressionReason: "interview_changed", deliveryState: "suppressed", deliveryCompletedAt: now }).catch(() => {});
          console.info("triggerEngine.interview_changed", { triggerId: doc.id, interviewId: ivRef[1] });
          continue;
        }
      }

      // Twin-trigger: check if user sent a message since trigger was created.
      // Time-critical reminders and system directives are exempt — texting
      // Evia about anything must not kill an interview reminder or a
      // caregiver check-in (isReplyExempt).
      if (!isReplyExempt(trigger)) {
        const lastReply = await db
          .collection("agent_conversations")
          .doc(trigger.phone)
          .collection("messages")
          .where("role",      "==", "user")
          .where("timestamp", ">=", new Date(trigger.createdAt).getTime())
          .limit(1)
          .get();

        if (!lastReply.empty) {
          // User already replied — cancel the trigger
          await doc.ref.update({ cancelledAt: now });
          continue;
        }
      }

      // Get user's session to find chatId
      const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
      if (!sessionSnap.exists) {
        await doc.ref.update({ cancelledAt: now });
        continue;
      }

      const session = sessionSnap.data()!;
      if (session.optedOut) {
        await doc.ref.update({ cancelledAt: now });
        continue;
      }

      const sendOpts = triggerSendOptions(trigger);
      const isDirective = isSystemDirectiveMessage(trigger.message);
      // Degraded mode holds sends that need a working LLM. A fixed-text,
      // time-critical reminder (the 1h interview reminder) needs none and is
      // worthless late — it goes out on time (and the stale guard above drops
      // it if it ever can't).
      if (!isDirective && !isReplyExempt(trigger) && degraded) {
        continue;
      }

      // U8 engine gate (KTD15): non-safety DISCRETIONARY trigger sends
      // (custom nudges, Claude-scheduled follow-ups) submit a PolicyCandidate
      // before claiming. Directives and transactional reminder types keep
      // their direct path untouched. The
      // gate runs BEFORE claimProactiveTrigger — the claim consumes the
      // trigger (sets firedAt), so a deferred candidate must stay unclaimed to
      // re-enter naturally on a later 5-min pass. A suppressed disposition is
      // final for this intent, so the trigger is cancelled (stamped like the
      // context-resolved suppression below) rather than left to clog the
      // bounded queue retrying forever.
      const isDiscretionary =
        !isDirective && !REPLY_EXEMPT_TYPES.has(trigger.type) &&
        (trigger.source === "claude" || trigger.type === "custom");
      if (isDiscretionary) {
        const category = discretionaryCategory(`${trigger.intent ?? ""} ${trigger.message ?? ""}`);
        const intentName = trigger.source === "claude" && trigger.intent ? trigger.intent : trigger.type;
        const g = await gateOptionalSend({
          phone: trigger.phone,
          candidate: {
            source: "triggerEngine",
            category,
            urgency: category === "visit_risk" ? 2 : 1,
            evidenceCount: 1,
            dedupeKey: `trig:${intentName}:${trigger.phone}:${now.slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("triggerEngine.policy", {
            triggerId: doc.id,
            type: trigger.type,
            source: trigger.source ?? "system",
            disposition: g.disposition,
            reason: g.reason,
          });
          if (g.disposition === "suppressed") {
            await doc.ref.update({
              cancelledAt: now,
              suppressionReason: `engine_${g.reason}`,
              deliveryState: "suppressed",
              deliveryCompletedAt: now,
            }).catch(() => {});
          }
          continue;
        }
      }

      const claimed = await claimProactiveTrigger(db, doc.ref, now);
      if (!claimed) continue;

      // null = this branch does its own delivery (escalations, retries); a boolean
      // is the send layer's verdict for a plain text.
      let delivered: boolean | null = null;
      try {
        if (trigger.message.startsWith("qa_retry:")) {
          const raw = trigger.message.slice("qa_retry:".length);
          try {
            const params = JSON.parse(raw);
            const { runQaAgent } = await import("../agents/qaAgent");
            await runQaAgent({ ...params, isRetry: true, sourceChannel: "[SYSTEM: retry]" });
          } catch (err) {
            console.error("qa_retry: parse/run failed:", err);
          }
        } else if (trigger.source === "claude" && trigger.intent) {
          // Claude-scheduled follow-up: check context before firing, then regenerate message

          // Load last 5 conversation turns for suppression check
          const recentMsgs = await db
            .collection("agent_conversations")
            .doc(trigger.phone)
            .collection("messages")
            .orderBy("timestamp", "desc")
            .limit(5)
            .get()
            .then(s => s.docs.map(d => ({ role: d.data().role as string, content: d.data().content as string })).reverse())
            .catch(() => [] as Array<{ role: string; content: string }>);

          // Context-aware suppression: skip if topic already addressed
          const fire = await shouldFireTrigger(trigger, recentMsgs);
          if (!fire) {
            await doc.ref.update({
              cancelledAt: now,
              suppressionReason: "context_resolved",
              deliveryState: "suppressed",
              deliveryCompletedAt: now,
            });
            console.log(`[triggerEngine] Suppressed claude trigger ${doc.id} — context already resolved`);
            continue;
          }

          // Dynamic message: regenerate from current care context
          const { getMemoryContext } = await import("../memory/memoryFiles");
          const memCtx = await getMemoryContext(trigger.userId).catch(() => "");
          const content = await generateTriggerMessage(trigger, memCtx);

          delivered = await sendViaInteractionAgent(trigger.phone, {
            content,
            ...sendOpts,
            sourceAgent: "trigger_engine",
          });
        } else {
          delivered = await sendViaInteractionAgent(trigger.phone, {
            content:     trigger.message,
            ...sendOpts,
            sourceAgent: "trigger_engine",
          });
        }
        if (trigger.bell?.recipientId) {
          const { writeUserNotification } = await import("../notifications/userNotification");
          await writeUserNotification({
            sourcePath:     `proactive_triggers/${doc.id}`,
            eventId:        doc.id,
            recipientId:    trigger.bell.recipientId,
            transitionType: trigger.type,
            type:           trigger.bell.type,
            title:          trigger.bell.title,
            body:           trigger.bell.body,
            ...(trigger.bell.data ? { data: trigger.bell.data } : {}),
          }).catch((err) => console.error("triggerEngine: bell copy failed for", doc.id, err));
        }
        if (delivered === false) {
          // The send layer dropped it (quiet hours / DND / daily cap / wait-tool).
          // Record that truthfully — 2026-09-18 (live-caught): a dropped text was
          // stamped "delivered", so downstream code believed the family had been
          // asked something they never saw.
          await doc.ref.update({
            deliveryState: "suppressed",
            deliveryCompletedAt: new Date().toISOString(),
            suppressionReason: "send_layer_dropped",
          });
        } else {
          await settleProactiveTriggerDelivery(doc.ref, new Date().toISOString());
        }
      } catch (err) {
        console.error("triggerEngine: failed to send for", doc.id, err);
        await settleProactiveTriggerDelivery(doc.ref, new Date().toISOString(), err).catch((settleError) => {
          console.error("triggerEngine: failed to record ambiguous delivery failure for", doc.id, settleError);
        });
        // A failed_ambiguous trigger is permanently consumed (never retried, so a
        // half-delivered send can't duplicate) — surface it so an admin can
        // re-send manually. admin_alerts high/critical priority auto-emails
        // via onAdminAlertCreated.
        await db.collection("admin_alerts").add({
          type:        "proactive_trigger_delivery_failed",
          triggerId:   doc.id,
          triggerType: trigger.type ?? null,
          userId:      trigger.userId ?? null,
          phone:       trigger.phone ?? null,
          message:     (trigger.message ?? "").slice(0, 200),
          error:       (err instanceof Error ? err.message : String(err)).slice(0, 500),
          createdAt:   new Date().toISOString(),
          resolved:    false,
          priority:    "high",
        }).catch((alertError) => {
          console.error("triggerEngine: failed to raise admin alert for", doc.id, alertError);
        });
      }
    }

    // No-show handling (2026-09-16): REMOVED. A visit whose caregiver never
    // checks in shows as Overdue on the website and nothing else happens
    // there — no automatic "your caregiver had to cancel" text, no candidate
    // blast, no auto-book. The old sweep here (arrival ping → emergency
    // replacement) told a family their caregiver cancelled when they had
    // not, and texted three other caregivers an "urgent opening". Evia now
    // does exactly what the site does: nothing, until a person acts.

    // Check for ignored triggers and pause after 3 consecutive ignores
    await checkIgnoredTriggers().catch((err) =>
      console.error("checkIgnoredTriggers error:", err)
    );

    // Clear expired state machine flags so users never get stuck
    await clearExpiredSessionStates().catch((err) =>
      console.error("clearExpiredSessionStates error:", err)
    );

    // Honor Evia's follow-up promises — re-answer or escalate any overdue
    // commitment so a promised follow-up never goes silent. Then convert any
    // dropped turns (inbound with no outbound reply) into tracked commitments.
    await import("../agents/commitmentTracker")
      .then(async (m) => {
        await m.sweepOverdueCommitments();
        await m.sweepDroppedTurns();
      })
      .catch((err) => console.error("commitment sweeps error:", err));
  });

export { runTriggerEngine as triggerEngineScheduled };

// 2026-09-09 (Hamse's call): checkExpiredInterviewRequests and
// checkAndTriggerRematching both removed along with the rest of the
// interview_requests collection. Both only ever served the interviewAgent.ts
// negotiation flow (deleted the same day — schedule_interview/video_interviews
// is the only interview path now), and by this point had zero remaining
// callers anywhere in functions/src.

// ── Clear expired session state machine flags ─────────────────────────────────

async function clearExpiredSessionStates(): Promise<void> {
  const now = new Date().toISOString();
  const { STATE_MACHINE_FLAGS, clearAllStateFlags, describeInterruptedFlow } =
    await import("../utils/sessionState");

  const snap = await db.collection("agent_sessions")
    .where("stateExpiresAt", "<=", now)
    .get();

  if (snap.empty) return;

  for (const doc of snap.docs) {
    const session = doc.data();
    const hasFlag = STATE_MACHINE_FLAGS.some(f => session[f] !== undefined && session[f] !== false);
    if (!hasFlag) continue;
    try {
      // Capture what was in flight BEFORE wiping it — an interrupted booking/
      // dispute/swap used to vanish silently here. If the flow is one worth
      // resuming, tell the user instead of going quiet.
      const interrupted = describeInterruptedFlow(session);
      await clearAllStateFlags(doc.id, db);
      console.log(`[clearExpiredSessionStates] Cleared flags for ${doc.id}`, { interrupted });
      if (interrupted && !session.optedOut) {
        // U8 engine gate (KTD15): the resume nudge is discretionary outreach —
        // the flag clearing above already happened either way. An interrupted
        // booking classifies as visit_risk via the shared content heuristic.
        const category = discretionaryCategory(interrupted);
        const g = await gateOptionalSend({
          phone: doc.id,
          candidate: {
            source: "triggerEngine",
            category,
            urgency: category === "visit_risk" ? 2 : 1,
            evidenceCount: 1,
            dedupeKey: `trig:state_expiry_nudge:${doc.id}:${now.slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("triggerEngine.policy", {
            context: "state_expiry_nudge", phone: doc.id,
            disposition: g.disposition, reason: g.reason,
          });
          continue;
        }
        await sendViaInteractionAgent(doc.id, {
          content:
            `Looks like we got interrupted while we were ${interrupted} — ` +
            `nothing was lost. Want to pick it back up? Just reply here.`,
          urgency:     "standard",
          sourceAgent: "state_expiry_nudge",
          canDrop:     true,
        }).catch((err) =>
          console.error(`[clearExpiredSessionStates] nudge failed for ${doc.id}:`, err)
        );
      }
    } catch (err) {
      console.error(`[clearExpiredSessionStates] Failed for ${doc.id}:`, err);
    }
  }
}

