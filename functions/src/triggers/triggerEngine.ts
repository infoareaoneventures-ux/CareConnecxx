import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { sendToPhone } from "../linq/client";
import { parseScheduledTimeMs } from "../utils/scheduledTime";
import { decideArrivalCapture } from "./noShowPolicy";

const db = admin.firestore();

export interface ProactiveTrigger {
  id?:               string;
  userId:            string;
  phone:             string;
  type:              "appointment_reminder" | "weekly_checkin" | "medication_reminder" | "custom"
                   | "qa_retry" | "caregiver_checkin" | "caregiver_checkin_escalation"
                   | "issue_escalation" | "issue_escalation_final" | "issue_followup"
                   | "post_visit_feedback";
  scheduledAt:       string;   // ISO
  message:           string;
  firedAt?:          string | null;
  cancelledAt?:      string | null;
  createdAt:         string;
  // Links a trigger to the record it serves (e.g. "video_interview_<id>") so
  // cancelTriggersByRef can retire reminders when that record is cancelled.
  refId?:            string;
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

async function generateTriggerMessage(
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
        "No bullet points. No emoji. No preamble. Output only the message text.",
      messages: [{
        role:    "user",
        content:
          `Reason for this follow-up: ${trigger.intent ?? "general check-in"}\n` +
          `Original planned message: ${trigger.message}\n` +
          `Care context:\n${memoryContext.slice(0, 600)}`,
      }],
    });
    const text = ((resp.content[0] as { text: string }).text ?? "").trim();
    return text || trigger.message;
  } catch {
    return trigger.message; // fall back to the stored message
  }
}

// ── Context-aware suppression for Claude-scheduled triggers ───────────────────
// Checks recent conversation to see if the follow-up is still relevant before sending.

async function shouldFireTrigger(
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
        "One word only: YES or NO.",
      messages: [{
        role:    "user",
        content:
          `Follow-up intent: ${trigger.intent}\n` +
          `Follow-up message: ${trigger.message}\n\n` +
          `Recent conversation:\n${recentText}`,
      }],
    });
    const answer = ((resp.content[0] as { text: string }).text ?? "").trim().toUpperCase();
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
  "medication_reminder",
  "post_visit_feedback",
]);
const REPLY_EXEMPT_MESSAGE_PREFIXES = [
  "caregiver_checkin:", "caregiver_checkin_escalation:", "interview_followup:",
  "health_escalation:", "issue_escalation:", "issue_escalation_final:",
  "issue_followup:", "replacement_task:", "retry_extend_schedule:",
];
export function isReplyExempt(t: Pick<ProactiveTrigger, "type" | "message">): boolean {
  if (REPLY_EXEMPT_TYPES.has(t.type)) return true;
  return REPLY_EXEMPT_MESSAGE_PREFIXES.some((p) => t.message?.startsWith(p));
}

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
        weekly_checkin:       "weekly check-ins",
        medication_reminder:  "medication reminders",
        custom:               "these messages",
      };
      const friendlyName = triggerFriendlyNames[trigger.type] ?? "these messages";

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
      .where("scheduledAt", "<=", now)
      .get();

    for (const doc of snap.docs) {
      const trigger = doc.data() as ProactiveTrigger;

      // Skip already fired or cancelled
      if (trigger.firedAt || trigger.cancelledAt) continue;

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

      try {
        // Retry recurring schedule extension after 1h
        if (trigger.message.startsWith("retry_extend_schedule:")) {
          const scheduleId = trigger.message.slice("retry_extend_schedule:".length);
          const { extendRecurringScheduleById } = await import("../scheduled/recurringScheduler");
          await extendRecurringScheduleById(scheduleId).catch(err =>
            console.error(`retry_extend_schedule failed for ${scheduleId}:`, err)
          );
        } else if (trigger.message.startsWith("health_escalation:")) {
          const [, seniorId, alertDocId] = trigger.message.split(":");
          if (seniorId && alertDocId) {
            await escalateHealthAlert(seniorId, alertDocId, trigger.phone).catch(err =>
              console.error("health escalation failed:", err)
            );
          }
        } else if (trigger.message.startsWith("replacement_task:")) {
          const taskId   = trigger.message.slice("replacement_task:".length);
          const taskSnap = await db.collection("agent_tasks").doc(taskId).get();
          const task     = taskSnap.data();
          if (task && task.status === "awaiting_approval") {
            await autoBookBestReplacement(taskId, task);
          }
        } else if (trigger.message.startsWith("qa_retry:")) {
          const raw = trigger.message.slice("qa_retry:".length);
          try {
            const params = JSON.parse(raw);
            const { runQaAgent } = await import("../agents/qaAgent");
            await runQaAgent({ ...params, isRetry: true, sourceChannel: "[SYSTEM: retry]" });
          } catch (err) {
            console.error("qa_retry: parse/run failed:", err);
          }
        } else if (trigger.message.startsWith("caregiver_checkin:")) {
          const appointmentId = trigger.message.slice("caregiver_checkin:".length);
          await handleCaregiverCheckin(appointmentId, trigger.phone).catch(err =>
            console.error("caregiver_checkin failed:", err)
          );
        } else if (trigger.message.startsWith("caregiver_checkin_escalation:")) {
          const appointmentId = trigger.message.slice("caregiver_checkin_escalation:".length);
          await handleCaregiverCheckinEscalation(appointmentId).catch(err =>
            console.error("caregiver_checkin_escalation failed:", err)
          );
        } else if (trigger.message.startsWith("issue_escalation:")) {
          const issueLogId = trigger.message.slice("issue_escalation:".length);
          const { escalateIssue } = await import("../agents/issueEscalator");
          await escalateIssue(issueLogId).catch(err =>
            console.error("issue_escalation failed:", err)
          );
        } else if (trigger.message.startsWith("issue_escalation_final:")) {
          const issueLogId = trigger.message.slice("issue_escalation_final:".length);
          const { escalateIssueFinal } = await import("../agents/issueEscalator");
          await escalateIssueFinal(issueLogId).catch(err =>
            console.error("issue_escalation_final failed:", err)
          );
        } else if (trigger.message.startsWith("issue_followup:")) {
          const issueLogId = trigger.message.slice("issue_followup:".length);
          const { sendIssueFollowUp } = await import("../agents/issueEscalator");
          await sendIssueFollowUp(issueLogId).catch(err =>
            console.error("issue_followup failed:", err)
          );
        } else if (trigger.message.startsWith("interview_followup:")) {
          const interviewId = trigger.message.slice("interview_followup:".length);
          const { sendPostInterviewFollowUp } = await import("../agents/interviewAgent");
          await sendPostInterviewFollowUp(interviewId).catch(err =>
            console.error("interview_followup failed:", err)
          );
        } else if (trigger.source === "claude" && trigger.intent) {
          // Held while degraded — regenerating + sending a chatty follow-up
          // during a provider outage produces broken conversations. Trigger
          // stays unfired and goes out after recovery.
          if (degraded) continue;
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
            await doc.ref.update({ cancelledAt: now, suppressionReason: "context_resolved" });
            console.log(`[triggerEngine] Suppressed claude trigger ${doc.id} — context already resolved`);
            continue;
          }

          // Dynamic message: regenerate from current care context
          const { getMemoryContext } = await import("../memory/memoryFiles");
          const memCtx = await getMemoryContext(trigger.userId).catch(() => "");
          const content = await generateTriggerMessage(trigger, memCtx);

          const isHealthTrigger = ["health_alert", "health_check", "medication_reminder", "fall_risk", "wellness_check"].includes(trigger.type ?? "");
          await sendViaInteractionAgent(trigger.phone, {
            content,
            urgency:     isHealthTrigger ? "immediate" : "standard",
            sourceAgent: "trigger_engine",
            canDrop:     !isHealthTrigger,
          });
        } else {
          const isHealthTrigger = ["health_alert", "health_check", "medication_reminder", "fall_risk", "wellness_check"].includes(trigger.type ?? "");
          // Health triggers fire even while degraded; generic check-ins hold
          // (stay unfired) until the system recovers.
          if (degraded && !isHealthTrigger) continue;
          await sendViaInteractionAgent(trigger.phone, {
            content:     trigger.message,
            urgency:     isHealthTrigger ? "immediate" : "standard",
            sourceAgent: "trigger_engine",
            canDrop:     !isHealthTrigger,
          });
        }
        await doc.ref.update({ firedAt: now });
      } catch (err) {
        console.error("triggerEngine: failed to send for", doc.id, err);
      }
    }

    // ── Arrival capture + no-show detection ───────────────────────────────────
    // Window is bounded on BOTH ends: visits that started between 3h and 8min
    // ago. Do NOT filter on `noShowChecked == null` — Firestore `==null` matches
    // only docs where the field is explicitly null (appointments are created
    // WITHOUT it), so that filter returned zero rows and no-show detection never
    // fired. We instead skip already-checked docs in code. The lower bound +
    // ascending order keep the scan bounded so already-checked visits can't fill
    // the limit and starve fresh ones (the old unbounded `limit(10)` would).
    //
    // A caregiver who arrived on time but forgot to text ARRIVED must NOT be
    // treated as a no-show — that falsely tells the family their caregiver
    // cancelled. So we first send an arrival-capture ping and only escalate to
    // emergency replacement if that ping goes unanswered (see noShowPolicy).
    // Derive the started-8min-to-3h-ago window from the stored `date` +
    // `startTime`/`time` wall-clock fields — the old range query on
    // `startDateTime` matched NOTHING because no writer ever sets that field
    // on appointments (this no-show sweep was silently dead).
    const nowNoShowMs   = Date.now();
    const eightMinAgoMs   = nowNoShowMs - 8 * 60 * 1000;
    const threeHoursAgoMs = nowNoShowMs - 3 * 60 * 60 * 1000;
    const { apptStartMs, businessTodayStr } = await import("../utils/scheduledTime");

    const noShowSnap = await db
      .collection("appointments")
      .where("status", "==", "confirmed")
      .where("date",   "==", businessTodayStr())
      .limit(200)
      .get();

    for (const apptDoc of noShowSnap.docs) {
      const appt = apptDoc.data();
      if (appt.noShowChecked) continue; // replacement already run
      if (appt.arrivedAt) continue;     // caregiver checked in, not a no-show

      try {
        const startMs = apptStartMs(appt.date, appt.startTime ?? appt.time);
        if (!Number.isFinite(startMs)) continue;
        if (startMs > eightMinAgoMs || startMs < threeHoursAgoMs) continue; // outside the window

        const arrivalPingSentAtMs = appt.arrivalPingSentAt
          ? Date.parse(appt.arrivalPingSentAt as string) : null;

        // Resolve the caregiver's phone + last inbound (engagement signal).
        let cgPhone: string | undefined;
        let lastInboundAtMs: number | null = null;
        if (appt.caregiverId) {
          const cgSnap = await db.collection("caregivers").doc(appt.caregiverId as string).get();
          cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const cgSession = await db.collection("agent_sessions").doc(cgPhone).get();
            const li = cgSession.data()?.lastInboundAt as string | undefined;
            lastInboundAtMs = li ? Date.parse(li) : null;
          }
        }

        const decision = decideArrivalCapture({
          startMs,
          arrived: false,
          arrivalPingSentAtMs,
          lastInboundAtMs,
          canPing: !!cgPhone,
          nowMs: Date.now(),
        });

        if (decision.action === "ping" && cgPhone) {
          const seniorName = (appt.clientName ?? appt.seniorName ?? "your client") as string;
          const pinged = await sendViaInteractionAgent(cgPhone, {
            content:     `Hi — are you with ${seniorName}? Text ARRIVED so I can let the family know you're there.`,
            urgency:     "immediate",
            sourceAgent: "arrival_capture",
            canDrop:     false,
          });
          if (pinged) {
            await apptDoc.ref.update({ arrivalPingSentAt: now });
          } else {
            // Undeliverable ping (no session doc / opted out): stamping it would
            // start a 15-min clock on a message that never existed — the exact
            // false "caregiver cancelled" this flow exists to prevent. Fall back
            // to the plain timeout an unreachable caregiver gets.
            const fallback = decideArrivalCapture({
              startMs, arrived: false, arrivalPingSentAtMs: null,
              lastInboundAtMs, canPing: false, nowMs: Date.now(),
            });
            if (fallback.action === "replace") {
              await apptDoc.ref.update({ noShowChecked: now });
              const clientSnap2 = await db.collection("users").doc(appt.clientId).get();
              const clientPhone2 = (clientSnap2.data() as any)?.phone as string | undefined;
              if (clientPhone2) {
                const { runEmergencyReplacement } = await import("../agents/replacementAgent");
                await runEmergencyReplacement({
                  appointmentId: apptDoc.id,
                  clientId:      appt.clientId,
                  clientPhone:   clientPhone2,
                  appt,
                });
              }
            }
          }
        } else if (decision.action === "replace") {
          await apptDoc.ref.update({ noShowChecked: now });
          const clientSnap = await db.collection("users").doc(appt.clientId).get();
          const phone = (clientSnap.data() as any)?.phone as string | undefined;
          if (!phone) continue;

          const { runEmergencyReplacement } = await import("../agents/replacementAgent");
          await runEmergencyReplacement({
            appointmentId: apptDoc.id,
            clientId:      appt.clientId,
            clientPhone:   phone,
            appt,
          });
        }
        // "wait"/"skip": do nothing this pass.
      } catch (err) {
        console.error("triggerEngine no-show handling error for", apptDoc.id, err);
      }
    }

    // Check for ignored triggers and pause after 3 consecutive ignores
    await checkIgnoredTriggers().catch((err) =>
      console.error("checkIgnoredTriggers error:", err)
    );

    // Expire stale interview requests and re-match family if no candidates remain
    await checkExpiredInterviewRequests().catch((err) =>
      console.error("checkExpiredInterviewRequests error:", err)
    );

    // Fire any user-defined recurring reminders that are due
    await evaluateUserTriggers().catch((err) =>
      console.error("evaluateUserTriggers error:", err)
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

// ── Expire stale interview requests and re-match when all candidates exhausted ─

async function checkExpiredInterviewRequests(): Promise<void> {
  const now = new Date().toISOString();

  const snap = await db.collection("interview_requests")
    .where("status",    "==", "awaiting_caregiver_availability")
    .where("expiresAt", "<=", now)
    .get();

  if (snap.empty) return;

  for (const doc of snap.docs) {
    const req = doc.data();
    try {
      await doc.ref.update({ status: "expired", expiredAt: now });

      const clientPhone: string | undefined = req.clientPhone;
      if (!clientPhone) continue;

      // Notify family that this caregiver didn't respond
      const caregiverName: string = req.caregiverName ?? "The caregiver";
      await sendViaInteractionAgent(clientPhone, {
        content:
          `${caregiverName} didn't respond to the interview request in time. ` +
          `I'm looking for other options — I'll send new matches shortly.`,
        urgency:     "standard",
        sourceAgent: "interview_agent",
        canDrop:     false,
      }).catch(() => {});

      // Check if ALL interview requests for this client are now in terminal states
      await checkAndTriggerRematching(clientPhone, req.caregiverId ?? "").catch(err =>
        console.error(`checkExpiredInterviewRequests: re-match failed for ${clientPhone}:`, err)
      );
    } catch (err) {
      console.error(`checkExpiredInterviewRequests: error for request ${doc.id}:`, err);
    }
  }

  console.log(`[checkExpiredInterviewRequests] Expired ${snap.size} interview requests`);
}

// Called when a caregiver declines or an interview expires — checks if all options
// are exhausted and kicks off a fresh matching pass if so.
export async function checkAndTriggerRematching(clientPhone: string, excludeCaregiverId: string): Promise<void> {
  const TERMINAL = ["declined", "expired", "caregiver_declined", "client_declined", "scheduled"];

  const allReqs = await db.collection("interview_requests")
    .where("clientPhone", "==", clientPhone)
    .get();

  if (allReqs.empty) return;

  // Collect all tried caregiver IDs
  const triedIds = allReqs.docs.map(d => d.data().caregiverId as string).filter(Boolean);

  const allTerminal = allReqs.docs.every(d => TERMINAL.includes(d.data().status ?? ""));
  const anyScheduled = allReqs.docs.some(d => d.data().status === "scheduled");

  if (!allTerminal || anyScheduled) return; // Still an active request, or interview already scheduled

  // All requests exhausted — trigger fresh matching with exclusions
  const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
  if (!sessionSnap.exists) return;
  const session = sessionSnap.data()!;
  if (session.optedOut) return;

  // Add excluded caregivers to session so matchingAgent skips them
  const alreadyExcluded: string[] = (session.rejectedCaregiverIds ?? []) as string[];
  const newExclusions = triedIds.filter(id => !alreadyExcluded.includes(id));
  if (newExclusions.length > 0) {
    await db.collection("agent_sessions").doc(clientPhone).update({
      rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(...newExclusions),
    });
  }

  await sendViaInteractionAgent(clientPhone, {
    content: "All the caregivers I reached out to weren't available. Let me search for fresh options — I'll have new matches for you shortly.",
    urgency:     "standard",
    sourceAgent: "interview_agent",
    canDrop:     false,
  });

  // Skip if a matching agent is already running for this client
  const activeMatchSnap = await db.collection("agent_tasks_active").doc(clientPhone).get();
  if (activeMatchSnap.exists && activeMatchSnap.data()?.type === "matching") {
    console.log(`[checkAndTriggerRematching] Skipping re-match — matching agent already active for ${clientPhone}`);
    return;
  }

  const { runMatchingForClient } = await import("../agents/matchingAgent");
  const chatId = session.chatId as string ?? "";
  await runMatchingForClient(clientPhone, chatId, session, session).catch(err =>
    console.error("checkAndTriggerRematching: runMatchingForClient failed:", err)
  );
}

// ── Escalate health alert to emergency contact if family didn't acknowledge ────

async function escalateHealthAlert(seniorId: string, alertDocId: string, familyPhone: string): Promise<void> {
  const alertSnap = await db.collection("health_alerts_pending").doc(alertDocId).get();
  if (!alertSnap.exists) return;

  const alert = alertSnap.data()!;
  if (alert.escalated) return; // already escalated

  // Check if the family replied after the alert was sent
  const sentAt  = alert.sentAt as string;
  const replied = await db.collection("agent_conversations")
    .doc(familyPhone)
    .collection("messages")
    .where("role",      "==", "user")
    .where("timestamp", ">=", new Date(sentAt).getTime())
    .limit(1)
    .get();

  if (!replied.empty) {
    // Family responded — no escalation needed
    await alertSnap.ref.update({ escalated: false, familyReplied: true });
    return;
  }

  // Family has not responded — find emergency contact
  const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
  const senior     = seniorSnap.exists ? seniorSnap.data()! : {};
  const ecPhone    = senior.emergencyContact?.phone as string | undefined;
  const seniorName = (senior.name ?? "your loved one") as string;
  const signals: string[] = alert.signals ?? [];

  if (ecPhone && ecPhone !== familyPhone) {
    await sendToPhone(ecPhone,
      `Hi — this is Evia, the care coordinator for ${seniorName}.\n\n` +
      `There were some health concerns noted in a recent care visit (${signals.slice(0, 2).join(", ")}) ` +
      `and the primary contact hasn't responded in 24 hours.\n\n` +
      `Please reach out to them or contact the care team directly.`
    );
  }

  // Also flag for admin
  await db.collection("admin_alerts").add({
    type:        "health_alert_unacknowledged",
    seniorId,
    phone:       familyPhone,
    signals,
    sentAt,
    createdAt:   new Date().toISOString(),
    resolved:    false,
    priority:    "high",
  });

  await alertSnap.ref.update({ escalated: true, escalatedAt: new Date().toISOString() });
  console.log(`[escalateHealthAlert] Escalated health alert for senior ${seniorId}`);
}

// ── Fire user-defined recurring reminders ────────────────────────────────────

async function evaluateUserTriggers(): Promise<void> {
  const now = new Date().toISOString();

  const snap = await db.collection("user_triggers")
    .where("active",     "==", true)
    .where("nextFireAt", "<=", now)
    .get();

  if (snap.empty) return;

  const { calculateNextFireAt } = await import("./userTriggerManager");

  for (const doc of snap.docs) {
    const t = doc.data();
    try {
      await sendViaInteractionAgent(t.phone as string, {
        content:     t.message     as string,
        urgency:     "standard",
        sourceAgent: "user_trigger",
        canDrop:     false,
      });

      if (t.recurrence === "once") {
        await doc.ref.update({ active: false, firedAt: now });
      } else {
        const next = calculateNextFireAt(
          t.recurrence as "daily" | "weekly" | "monthly" | "once",
          t.dayOfWeek  as number | undefined,
          t.hour       as number,
          t.minute     as number
        );
        await doc.ref.update({ nextFireAt: next, lastFiredAt: now });
      }
    } catch (err) {
      console.error(`[evaluateUserTriggers] Failed for trigger ${doc.id}:`, err);
    }
  }
}

// ── Auto-book best replacement when the 30-min family response window expires ──

async function autoBookBestReplacement(taskId: string, task: any): Promise<void> {
  const options: any[] = task.options ?? [];
  const option = options[0];

  if (!option) {
    // No candidates were found at the time — notify family
    const { handleNoReplacementsFound } = await import("../agents/replacementAgent");
    const apptSnap = await db.collection("appointments").doc(task.appointmentId).get();
    const appt     = apptSnap.data() ?? {};
    await handleNoReplacementsFound(
      task.appointmentId, task.clientId, task.clientPhone,
      { caregiverName: appt.caregiverName ?? "Your caregiver", date: appt.date ?? "", time: appt.time ?? "" }
    );
    await db.collection("agent_tasks").doc(taskId).update({ status: "no_options_available" });
    return;
  }

  // Update appointment with replacement caregiver
  await db.collection("appointments").doc(task.appointmentId).update({
    caregiverId:   option.caregiverId,
    caregiverName: option.name,
    status:        "confirmed",
    autoBooked:    true,
    bookedAt:      new Date().toISOString(),
  });

  // Mark task complete
  await db.collection("agent_tasks").doc(taskId).update({
    status:       "auto_booked",
    bookedAt:     new Date().toISOString(),
    bookedOption: option,
  });

  // Notify family
  const apptSnap = await db.collection("appointments").doc(task.appointmentId).get();
  const appt     = apptSnap.data() ?? {};
  await sendViaInteractionAgent(task.clientPhone, {
    content:
      `You didn't respond, so I went ahead and booked ${option.name} ` +
      `for your ${appt.time ?? ""} visit today — they're confirmed. ` +
      `Reply CANCEL if you need to change this.`,
    urgency:     "immediate",
    sourceAgent: "emergency_replacement",
    canDrop:     false,
  });

  // Clear the active task roster entry — replacement is resolved
  await db.collection("agent_tasks_active").doc(task.clientPhone).delete().catch(() => {});

  // Post-crisis emotional anchoring
  await new Promise(r => setTimeout(r, 3000));
  await sendViaInteractionAgent(task.clientPhone, {
    content:     `Last-minute coverage is one of the hardest parts of care. That's exactly what I'm here for. 💙`,
    urgency:     "standard",
    sourceAgent: "emergency_replacement",
    canDrop:     true,
  });

  // Notify the replacement caregiver
  const cgSnap  = await db.collection("caregivers").doc(option.caregiverId).get();
  const cgPhone = cgSnap.data()?.phone as string | undefined;
  if (cgPhone) {
    await sendToPhone(cgPhone,
      `You've been assigned to cover a visit today.\n\n` +
      `${appt.date ?? ""} at ${appt.time ?? ""}\n` +
      (appt.clientName ? `${appt.clientName}\n` : "") +
      (appt.address    ? `${appt.address}`       : "")
    );
  }

  console.log(`[autoBookBestReplacement] Auto-booked ${option.caregiverId} for task ${taskId}`);
}

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

// ── Caregiver check-in 2h before visit ───────────────────────────────────────

async function handleCaregiverCheckin(appointmentId: string, caregiverPhone: string): Promise<void> {
  const apptSnap = await db.collection("appointments").doc(appointmentId).get();
  if (!apptSnap.exists) return;
  const appt = apptSnap.data()!;

  // Skip if already arrived or cancelled
  if (["cancelled", "cancelled_by_client", "completed"].includes(appt.status ?? "")) return;
  if (appt.arrivedAt) return;

  const seniorName = appt.clientName ?? appt.seniorName ?? "your client";
  const startTime  = appt.startTime ?? "";

  await sendToPhone(caregiverPhone,
    `Hey — are you confirmed for today's visit with ${seniorName} at ${startTime}?\n\nReply CONFIRM if you're good to go, or LATE if you're running behind.`
  );

  await db.collection("appointments").doc(appointmentId).update({
    caregiverCheckInSent:   true,
    caregiverCheckInSentAt: new Date().toISOString(),
  });

  // Schedule escalation in 30 min if no response
  await db.collection("proactive_triggers").add({
    userId:      appt.caregiverId ?? "",
    phone:       caregiverPhone,
    type:        "caregiver_checkin_escalation",
    scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    message:     `caregiver_checkin_escalation:${appointmentId}`,
    firedAt:     null,
    cancelledAt: null,
    createdAt:   new Date().toISOString(),
  });
}

// ── Caregiver check-in escalation — warn family if no confirm/arrival ─────────

async function handleCaregiverCheckinEscalation(appointmentId: string): Promise<void> {
  const apptSnap = await db.collection("appointments").doc(appointmentId).get();
  if (!apptSnap.exists) return;
  const appt = apptSnap.data()!;

  // If caregiver confirmed or arrived — nothing to do
  if (appt.arrivedAt || appt.caregiverCheckInConfirmed) return;
  if (["cancelled", "cancelled_by_client", "completed"].includes(appt.status ?? "")) return;

  const seniorName    = appt.clientName ?? appt.seniorName ?? "your client";
  const startTime     = appt.startTime ?? "";
  const caregiverName = appt.caregiverName ?? "Your caregiver";

  // Warn family
  const clientSnap = await db.collection("users").doc(appt.clientId ?? "").get();
  const clientPhone = (clientSnap.data() as any)?.phone as string | undefined;
  if (clientPhone) {
    await sendViaInteractionAgent(clientPhone, {
      content:
        `Heads-up — ${caregiverName} hasn't confirmed today's visit at ${startTime} with ${seniorName}. ` +
        `I'm following up with them now. I'll let you know as soon as I hear back.`,
      urgency:     "immediate",
      sourceAgent: "caregiver_checkin",
      canDrop:     false,
    });
  }

  // Urgent re-ping caregiver
  const cgSnap    = await db.collection("caregivers").doc(appt.caregiverId ?? "").get();
  const cgPhone   = cgSnap.data()?.phone as string | undefined;
  if (cgPhone) {
    await sendToPhone(cgPhone,
      `URGENT: We haven't heard back about your visit with ${seniorName} at ${startTime} today. ` +
      `Please reply CONFIRM now or call us immediately.`
    );
  }

  // Admin alert
  await db.collection("admin_alerts").add({
    type:          "caregiver_unresponsive_checkin",
    appointmentId,
    caregiverId:   appt.caregiverId ?? "",
    caregiverName,
    clientId:      appt.clientId ?? "",
    seniorName,
    startTime,
    createdAt:     new Date().toISOString(),
    resolved:      false,
    priority:      "high",
  });

  console.log(`[handleCaregiverCheckinEscalation] Escalated check-in for appointment ${appointmentId}`);
}
