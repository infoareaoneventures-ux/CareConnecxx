import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { parseScheduledTimeMs, businessNowMinutes } from "../utils/scheduledTime";
import {
  decideInShiftPrompt,
  decideHeartbeat,
  pickRotatingQuestion,
  timeOfDayFromMinutes,
  LADDER_INTERVAL_MIN,
  type AwaitingInShiftUpdate,
} from "./inShiftUpdatePolicy";

const db = admin.firestore();

// Kill switch — ships ON. Set IN_SHIFT_UPDATES_ENABLED="false" in the function
// env to disable without a deploy (the CARA_* kill-switch pattern).
function isEnabled(): boolean {
  return process.env.IN_SHIFT_UPDATES_ENABLED !== "false";
}

// Anchor the ladder to when the caregiver actually arrived; fall back to the
// scheduled start if the app flipped status without writing arrivedAt.
function resolveAnchorMs(appt: admin.firestore.DocumentData): number | null {
  if (appt.arrivedAt) {
    const ms = Date.parse(appt.arrivedAt);
    if (!Number.isNaN(ms)) return ms;
  }
  const start = (appt.startDateTime ?? "") as string;
  if (start) {
    const ms = parseScheduledTimeMs(start);
    if (!Number.isNaN(ms)) return ms;
  }
  // Legacy date + startTime shape
  if (appt.date && (appt.startTime || appt.time)) {
    const hhmm = ((appt.startTime ?? appt.time) as string).slice(0, 5);
    const ms = parseScheduledTimeMs(`${appt.date}T${hhmm}:00`);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function resolveScheduledEndMs(appt: admin.firestore.DocumentData, anchorMs: number | null): number | null {
  const duration = typeof appt.durationHours === "number" ? appt.durationHours : null;
  if (anchorMs !== null && duration !== null) return anchorMs + duration * 60 * 60 * 1000;
  return null;
}

async function loadClientSession(
  clientId: string
): Promise<{ phone: string; cadenceMinutes: number; cadenceOverridden: boolean; paused: boolean } | null> {
  if (!clientId) return null;
  const snap = await db.collection("agent_sessions").where("userId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() as any;
  const phone = (data.phone ?? snap.docs[0].id) as string;
  // Family-set preference (set_visit_update_frequency tool): minutes between
  // updates, or paused entirely. Anything unset/invalid falls to the default.
  const cadenceOverridden = typeof data.inShiftUpdateCadence === "number" && data.inShiftUpdateCadence > 0;
  const cadenceMinutes = cadenceOverridden ? data.inShiftUpdateCadence : LADDER_INTERVAL_MIN;
  const paused = data.inShiftUpdatesPaused === true;
  return { phone, cadenceMinutes, cadenceOverridden, paused };
}

async function carePlanHasMeds(seniorId: string, clientId: string): Promise<boolean> {
  // CANONICAL doc first (web cutover 2026-07-12), then the legacy subdocs.
  if (clientId) {
    const snap = await db.collection("care_plans").doc(clientId).get().catch(() => null);
    if (snap?.exists) {
      const meds = (snap.data()?.medications ?? []) as unknown[];
      if (Array.isArray(meds) && meds.length > 0) return true;
    }
  }
  for (const id of [seniorId, clientId].filter(Boolean)) {
    const snap = await db.collection("senior_profiles").doc(id)
      .collection("care_plans").doc("default").get().catch(() => null);
    if (snap?.exists) {
      const meds = (snap.data()?.medications ?? []) as unknown[];
      return Array.isArray(meds) && meds.length > 0;
    }
  }
  return false;
}

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
  });
}

// Facts-only family heartbeat: built entirely from known facts (names + arrival
// time). Never asserts wellbeing and never says the caregiver is unresponsive.
async function sendFamilyHeartbeat(params: {
  clientPhone: string;
  clientId:    string;
  seniorFirstName: string;
  caregiverFirstName: string;
  anchorMs: number | null;
}): Promise<boolean> {
  const { clientPhone, seniorFirstName, caregiverFirstName, anchorMs } = params;
  const since = anchorMs ? ` since ${formatClockTime(anchorMs)}` : "";
  const fallback =
    `${caregiverFirstName} is with ${seniorFirstName}${since} — the visit's going along ` +
    `and I'll pass along the next update as soon as I have it.`;

  const content = await generateCaraMessage({
    audience: "family",
    context:
      `Write a brief, warm 1-2 sentence reassurance to a family member during an in-progress care visit. ` +
      `State ONLY these facts: ${caregiverFirstName} is with ${seniorFirstName}${since}, the visit is ongoing, ` +
      `and you'll share the next update soon. Do NOT claim anything about how ${seniorFirstName} is feeling or ` +
      `doing, and do NOT say the caregiver is unresponsive or hasn't checked in. From Evia, a care coordinator. No emoji.`,
    fallback,
    maxTokens: 90,
  });

  return sendViaInteractionAgent(clientPhone, {
    content,
    urgency:       "standard",
    sourceAgent:   "in_shift_heartbeat",
    canDrop:       true,
    bypassDailyCap: true,
  });
}

export const sendInShiftUpdates = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => {
    if (!isEnabled()) return;

    const nowMs = Date.now();
    const nowMinutes = businessNowMinutes();

    const snap = await db.collection("appointments")
      .where("status", "==", "in-progress")
      .get();

    // completedAt is set by handleDone — filter in-memory (Firestore can't query absent fields)
    const activeAppts = snap.docs.filter(doc => !doc.data().completedAt);

    for (const apptDoc of activeAppts) {
      const appt = apptDoc.data();
      const apptId = apptDoc.id;
      // Childcare U10 (R54/AE16): childcare appointments never get senior
      // in-shift nudges (they interpolate senior care-plan/journal content).
      if (appt.careVertical === "child") continue;

      try {
        const caregiverId = appt.caregiverId as string;
        if (!caregiverId) continue;

        const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (!cgPhone) continue;
        const caregiverFirstName = ((cgSnap.data()?.name ?? "") as string).split(" ")[0] || "Your caregiver";

        // Skip if the caregiver is mid-flow on another blocking prompt — incl.
        // shift confirmations, whose replies would otherwise consume (or be
        // consumed by) the check-in answer, and whose shared stateExpiresAt a
        // prompt here would silently extend.
        const sessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
        const session = sessionSnap.exists ? (sessionSnap.data() as any) : null;
        if (session && (
          session.awaitingCareNotes || session.awaitingLateMinutes || session.awaitingIssueDescription ||
          session.awaitingTaskAck || session.pendingShiftConfirmation || session.pendingClientShiftConfirm ||
          session.pendingCaregiverReferral
        )) {
          continue;
        }

        const clientId = (appt.clientId ?? "") as string;
        const seniorId = (appt.seniorId ?? clientId) as string;
        const seniorFirstName = ((appt.clientName ?? appt.seniorName ?? "your client") as string).split(" ")[0];

        const anchorMs = resolveAnchorMs(appt);
        const scheduledEndMs = resolveScheduledEndMs(appt, anchorMs);
        const durationHours = typeof appt.durationHours === "number" ? appt.durationHours : null;
        const familyUpdateCount = (appt.inShiftFamilyUpdateCount ?? 0) as number;
        const lastPromptAtMs = appt.inShiftLastPromptAt ? Date.parse(appt.inShiftLastPromptAt) : null;

        const pending = session?.awaitingInShiftUpdate as { promptedAt?: string } | undefined;
        const awaitingReply = !!pending;
        const promptSentAtMs = pending?.promptedAt ? Date.parse(pending.promptedAt) : lastPromptAtMs;

        const clientSession = await loadClientSession(clientId);
        if (clientSession?.paused) continue; // family said no in-shift updates

        // ── 1) Heartbeat: an unanswered prompt past the wait window → tell the family
        const hb = decideHeartbeat({ awaitingReply, promptSentAtMs, familyUpdateCount, nowMs });
        if (hb.action === "heartbeat") {
          // The per-shift ceiling counts only real deliveries — a heartbeat that
          // was DND-skipped or had no reachable family must not burn a slot.
          let heartbeatSent = false;
          if (clientSession) {
            heartbeatSent = await sendFamilyHeartbeat({
              clientPhone: clientSession.phone,
              clientId,
              seniorFirstName,
              caregiverFirstName,
              anchorMs,
            });
          }
          // Increment (not overwrite) so a reply landing concurrently — its
          // handler resets the counter to 0 — isn't clobbered by our stale read.
          const unanswered = (appt.inShiftUnansweredCount ?? 0) + 1;
          await apptDoc.ref.update({
            ...(heartbeatSent ? { inShiftFamilyUpdateCount: admin.firestore.FieldValue.increment(1) } : {}),
            inShiftUnansweredCount: admin.firestore.FieldValue.increment(1),
          });
          // Clear the stale prompt so the next slot re-asks fresh. Leave the
          // SHARED stateExpiresAt alone if any other flow's flag is set.
          const hasOtherFlag = !!(session && (
            session.awaitingCareNotes || session.awaitingTaskAck || session.awaitingLateMinutes ||
            session.awaitingIssueDescription || session.pendingShiftConfirmation ||
            session.pendingClientShiftConfirm || session.pendingCaregiverReferral
          ));
          await db.collection("agent_sessions").doc(cgPhone).update({
            awaitingInShiftUpdate: admin.firestore.FieldValue.delete(),
            ...(hasOtherFlag ? {} : { stateExpiresAt: admin.firestore.FieldValue.delete() }),
          }).catch(() => {});
          // Internal-only escalation after repeated silence — non-punitive signal.
          // One alert per appointment (inShiftSilenceAlerted), not one per heartbeat.
          if (unanswered >= 2 && !appt.inShiftSilenceAlerted) {
            await apptDoc.ref.update({ inShiftSilenceAlerted: true }).catch(() => {});
            db.collection("admin_alerts").add({
              type: "caregiver_in_shift_silent",
              severity: "low",
              resolved: false,
              caregiverId,
              clientId,
              appointmentId: apptId,
              unansweredCount: unanswered,
              dedupeKey: `in_shift_silent:${apptId}`,
              createdAt: new Date().toISOString(),
            }).catch(() => {});
          }
          continue; // one action per appointment per run
        }

        // ── 2) Prompt: time to ask the caregiver for a fresh update
        const decision = decideInShiftPrompt({
          anchorMs,
          scheduledEndMs,
          durationHours,
          lastPromptAtMs,
          familyUpdateCount,
          awaitingReply,
          cadenceMinutes:    clientSession?.cadenceMinutes ?? LADDER_INTERVAL_MIN,
          cadenceOverridden: clientSession?.cadenceOverridden ?? false,
          nowMs,
        });
        if (decision.action !== "prompt") continue;
        if (!sessionSnap.exists) continue; // caregiver reply can't be routed without a session

        const slotIndex = (appt.inShiftPromptCount ?? 0) as number;
        const medsPromptedAlready = !!appt.inShiftMedsPrompted;
        const hasMeds = await carePlanHasMeds(seniorId, clientId);

        const q = pickRotatingQuestion({
          seniorFirstName,
          slotIndex,
          timeOfDay: timeOfDayFromMinutes(nowMinutes),
          hasMeds,
          medsPromptedAlready,
        });

        // First-ever prompt to this caregiver carries the honest pitch — this is
        // support, not surveillance: Evia fields the family so they don't text
        // mid-transfer, and documented visits get hours approved faster.
        const isFirstPrompt = !session?.inShiftIntroSent;
        const content = await generateCaraMessage({
          audience: "caregiver",
          context: isFirstPrompt
            ? `You're Evia, the caregiver's front-office, sending your FIRST mid-visit check-in to ${caregiverFirstName}. ` +
              `In 2 short sentences: (1) explain you'll check in now and then during visits and pass updates to the family ` +
              `yourself — so they don't text ${caregiverFirstName} directly, and families who see updates approve hours faster; ` +
              `(2) then ask: "${q.text}" Warm, zero pressure, easy to answer in a few words. No emoji.`
            : `You're Evia, the caregiver's front-office. Ask ${caregiverFirstName} a warm, brief check-in question ` +
              `so you can pass an update to ${seniorFirstName}'s family (saves the caregiver from being texted directly). ` +
              `Ask specifically: "${q.text}" Keep it to one short sentence, easy to answer in a few words. No emoji.`,
          fallback: isFirstPrompt
            ? `Hi ${caregiverFirstName} — I'll check in during visits and pass updates to the family myself, so they don't have to text you. Quick one: ${q.text}`
            : `Hi ${caregiverFirstName} — quick one so I can update the family: ${q.text}`,
          maxTokens: isFirstPrompt ? 140 : 80,
        });

        const promptSent = await sendViaInteractionAgent(cgPhone, {
          content,
          urgency:     "standard",
          sourceAgent: "in_shift_update",
          canDrop:     false, // caregiver is on shift — deliver regardless of quiet hours
        });
        if (!promptSent) continue; // opted out / deduped — don't record a phantom prompt

        const promptedAt = new Date().toISOString();
        const promptState: AwaitingInShiftUpdate = {
          appointmentId: apptId,
          clientId,
          seniorId,
          seniorName: seniorFirstName,
          question: q.text,
          topic: q.topic,
          promptedAt,
        };
        // One atomic batch: a crash between "appointment stamped" and "session
        // flag set" would block re-asks for a full cadence interval while ALSO
        // never heartbeating (decideHeartbeat needs the flag) — losing the slot.
        const batch = db.batch();
        batch.update(apptDoc.ref, {
          inShiftLastPromptAt: promptedAt,
          inShiftPromptCount: admin.firestore.FieldValue.increment(1),
          ...(q.topic === "medication" ? { inShiftMedsPrompted: true } : {}),
        });
        batch.update(db.collection("agent_sessions").doc(cgPhone), {
          awaitingInShiftUpdate: promptState,
          stateExpiresAt: new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(),
          ...(isFirstPrompt ? { inShiftIntroSent: true } : {}),
        });
        await batch.commit();
        // Quiet per-caregiver signal — pairs with inShiftStats.replies for the
        // (non-punitive) reply-rate the 60-day badge decision will read.
        db.collection("caregivers").doc(caregiverId).update({
          "inShiftStats.prompts": admin.firestore.FieldValue.increment(1),
        }).catch(() => {});
      } catch (err) {
        console.error(`[sendInShiftUpdates] Error for appointment ${apptId}:`, err);
      }
    }
  });
