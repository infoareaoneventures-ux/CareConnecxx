import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { classifyIntentDetailed } from "../agents/intentClassifier";
import { buildCapabilityMenu } from "../agents/caraCapabilities";
import { staleConfirmFlags } from "../utils/sessionState";
import { runQaAgent, runQuickReply, isTrivialQuickReply } from "../agents/qaAgent";
import { intentToShadowFlow, shadowTap } from "../agents/routingShadowTap";
import { isConvergenceFlipped } from "../config/featureFlags";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
import { updatePermissionFromText, getPermissions } from "../agents/permissionsConversation";
import {
  handleInterviewSelection,
  handleInterviewConfirm,
  writeInterviewOutcomeSignal,
} from "../agents/interviewAgent";
import { executeBookings, createBookingTask } from "../agents/bookingExecutor";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { startJobPostingFlow } from "../agents/jobPostingFlow";
import { startModifyScheduleFlow } from "../agents/modifyScheduleFlow";
import { handleRefundRequest } from "../agents/refundHandler";
import { handleTimesheetApproval } from "../agents/timesheetHandler";
import { handleEarningsView } from "../agents/earningsHandler";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";
import { handleCaregiverSwapRequest } from "../agents/caregiverSwapHandler";
import { handleClientSwapRequest } from "../agents/clientSwapRequestHandler";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate, profileFieldFromIntent, ProfileUpdateField } from "../agents/caregiverProfileHandler";
import { generateCaraMessage } from "../utils/caraMessage";
import { handleJobResponse } from "../triggers/jobNotifications";
import {
  addUserMessageToZep,
  addAssistantMessageToZep,
  searchZepMemory,
  getZepUserId,
} from "../memory/zepClient";
import { quickComplete } from "../utils/openaiClient";
import { handleRecurringConfirm } from "./inboundHelpers";

const db = admin.firestore();

function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

async function extractFamilyMember(text: string): Promise<{ name: string | null; phone: string | null }> {
  const extractionRaw = await quickComplete(
    "Extract the family member name and phone number from this message. " +
      "Reply with JSON only: {\"name\":\"...\",\"phone\":\"+1...\"}. " +
      "If no name is present, name=null. If no phone is present, phone=null.",
    text,
    { maxTokens: 80 },
  ).catch(() => "{}");

  try {
    const parsed = JSON.parse(extractionRaw || "{}");
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      phone: normalizeE164(typeof parsed.phone === "string" ? parsed.phone : null),
    };
  } catch {
    // JSON parse failed (malformed LLM output). Only fall back to treating the
    // raw text as a phone number when it actually LOOKS like one — digits plus
    // common phone punctuation. Prose with stray digits (addresses, "3 days a
    // week", etc.) must not be coerced into a bogus E.164 number.
    const trimmed = text.trim();
    const phoneLike = /^[+(]?[\d\s().+-]{8,}$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 10;
    return { name: null, phone: phoneLike ? normalizeE164(text) : null };
  }
}

// ── Recurring schedule: PAUSE / CANCEL / RESUME ───────────────────────────────

async function handleRecurringPause(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const scheduleId = (session as any).activeRecurringScheduleId as string | undefined;
  if (!scheduleId) {
    await sendMessage(chatId, "I don't see an active recurring schedule. Let me know if you need anything else.");
    return;
  }
  await db.collection("recurring_schedules").doc(scheduleId).update({
    status:       "paused",
    pausedAt:     new Date().toISOString(),
    pausedReason: "client_request",
  });
  await sendMessage(chatId,
    "Recurring schedule paused. Future visits won't be booked automatically.\n\n" +
    "Text RESUME SCHEDULE whenever you're ready to start again."
  );
}

async function handleRecurringCancel(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const scheduleId = (session as any).activeRecurringScheduleId as string | undefined;
  if (!scheduleId) {
    await sendMessage(chatId, "I don't see an active recurring schedule. Let me know if you need anything else.");
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  // Cancel all future unconfirmed visits from this schedule
  const futureSnap = await db.collection("appointments")
    .where("recurringScheduleId", "==", scheduleId)
    .where("date", ">", today)
    .where("status", "in", ["confirmed"])
    .get();

  const batch = db.batch();
  batch.update(
    db.collection("recurring_schedules").doc(scheduleId),
    { status: "cancelled", cancelledAt: new Date().toISOString() }
  );
  for (const doc of futureSnap.docs) {
    batch.update(doc.ref, { status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
  }
  await batch.commit();

  await db.collection("agent_sessions").doc(phone).update({
    activeRecurringScheduleId: admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  await sendMessage(chatId,
    `Recurring schedule cancelled. ${futureSnap.size > 0 ? `${futureSnap.size} upcoming visit${futureSnap.size !== 1 ? "s" : ""} have been removed.` : ""}\n\n` +
    `You can still book individual visits anytime.`.trim()
  );
}

async function handleRecurringResume(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const scheduleId = (session as any).activeRecurringScheduleId as string | undefined;
  if (!scheduleId) {
    await sendMessage(chatId, "I don't see a paused schedule. Let me know if you need anything else.");
    return;
  }
  const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
  if (!schedSnap.exists || schedSnap.data()?.status !== "paused") {
    await sendMessage(chatId, "That schedule isn't currently paused.");
    return;
  }
  const sched = schedSnap.data()!;
  const today = new Date().toISOString().split("T")[0];
  const now   = new Date().toISOString();

  const { generateRecurringDates } = await import("../scheduled/recurringScheduler");
  const dates = generateRecurringDates(today, sched.days as string[], 4);

  const batch = db.batch();
  batch.update(schedSnap.ref, {
    status:          "active",
    pausedAt:        admin.firestore.FieldValue.delete(),
    pausedReason:    admin.firestore.FieldValue.delete(),
    lastExtendedAt:  now,
    weeksBookedAhead: 4,
  });
  for (const { date } of dates) {
    const apptRef = db.collection("appointments").doc();
    batch.set(apptRef, {
      clientId:            sched.clientId,
      caregiverId:         sched.caregiverId,
      caregiverName:       sched.caregiverName,
      date,
      startTime:           sched.startTime,
      endTime:             sched.endTime,
      durationHours:       sched.durationHours,
      hourlyRate:          sched.hourlyRate,
      status:              "confirmed",
      recurringScheduleId: scheduleId,
      humanApproved:       true,
      createdByAgent:      true,
      createdAt:           now,
    });
  }
  await batch.commit();

  const schedDesc = `${(sched.days as string[]).join("/")}s ${sched.startTime}–${sched.endTime}`;
  await sendMessage(chatId,
    `Resumed! ${sched.caregiverName as string} is booked every ${schedDesc} for the next 4 weeks.`
  );
}

export interface IntentRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

async function handleAddFamilyMemberIntent(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession
): Promise<void> {
  if ((session as any).isSecondaryMember) {
    await sendMessage(chatId, "I can help with updates here, but only the primary account holder can add people to this care group.");
    return;
  }

  const pendingAdd = (session as any).pendingAddFamilyMember as { name?: string | null; phone?: string | null } | undefined;
  const extracted = await extractFamilyMember(text);
  const memberName  = extracted.name  ?? pendingAdd?.name  ?? null;
  const memberPhone = extracted.phone ?? pendingAdd?.phone ?? null;

  if (!memberPhone) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingAddFamilyMember: { name: memberName, phone: null },
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).catch(() => {});
    await sendMessage(chatId, "I can add them. What phone number should I use?");
    return;
  }
  if (!memberName) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingAddFamilyMember: { name: null, phone: memberPhone },
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).catch(() => {});
    await sendMessage(chatId, "Got the number. What name should I use for them?");
    return;
  }

  const clientId = session.userId;
  const seniorId = (session as any).seniorId ?? session.userId;
  if (!clientId || !seniorId) {
    await sendMessage(chatId, "I need to finish linking your account before I can add someone to this care group.");
    return;
  }

  await db.collection("agent_sessions").doc(phone).update({
    pendingAddFamilyMember: admin.firestore.FieldValue.delete(),
    stateExpiresAt: admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  const { handleToolCall } = await import("../mcp/server");
  const result = await handleToolCall("add_family_member", {
    seniorId,
    name: memberName,
    memberPhone,
    clientId,
  }) as any;

  if (result?._toolError) {
    await sendMessage(chatId, result.message ?? "I couldn't add them yet. Please check the number and try again.");
    return;
  }

  await sendMessage(
    chatId,
    result?.notification?.sent === false
      ? `I added ${memberName} to the care group, but the welcome text did not go through. Please check the number.`
      : `Done - ${memberName} is in the care group, and I texted them the welcome message.`,
  );
}

// ── Intent routing — extracted verbatim from webhooks.ts handleInbound ───────
// Covers: pendingRematch, the pending agent_task lookup, intent classification
// and ALL intent branches through the QA-agent fallback. The try/catch/finally
// error boundary (agent_error_log + admin_alerts + deflection message + final
// stopTyping) stays in handleInbound — any throw from here is handled there.
export async function routeIntentAndRespond(ctx: IntentRouteContext): Promise<void> {
  const { phone, chatId, text, norm, session } = ctx;

  // ── Pending rematching after interview cancelled due to availability change ──
  if ((session as any).pendingRematch && (norm === "YES" || norm === "Y")) {
    await db.collection("agent_sessions").doc(phone).update({ pendingRematch: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete() });
    const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
    const { runMatchingForClient: rmfcPendingRematch } = await import("../agents/matchingAgent");
    await rmfcPendingRematch(phone, chatId, sd, sd);
    return;
  }

  // ── Check for pending task (booking / emergency replacement) ───────────────
  const taskSnap = await db
    .collection("agent_tasks")
    .where("clientPhone", "==", phone)
    .where("status",      "==", "awaiting_approval")
    .orderBy("createdAt", "desc").limit(1).get();

  const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];

  if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {/* non-critical */});

    if ((session as any).pendingAddFamilyMember) {
      await handleAddFamilyMemberIntent(phone, chatId, text, session);
      return;
    }

    // intentDegraded = the classifier errored/timed out and "QUESTION" is a
    // guess — when set, skip the quick-reply bypass and take the full QA path.
    const { intent, degraded: intentDegraded } = await classifyIntentDetailed(text, !!pendingTask);

    // ── /help: capability discovery ──────────────────────────────────────────
    // Static, side-effect-free reply listing what Cara can do for this role.
    // Reached only via the exact-string command bypass in classifyIntentDetailed.
    if (intent === "HELP") {
      await sendMessage(
        chatId,
        buildCapabilityMenu(session.userType, session.preferredLanguage ?? "en")
      );
      return;
    }

    // ── U7/U8/U9: convergence shadow tap ─────────────────────────────────────
    // Dark unless this flow is enabled in ROUTING_CONVERGENCE_SHADOW. Fire-and-
    // forget so the live turn's latency is unaffected; runs the MCP loop in shadow
    // mode (U11 → zero side effects, nothing sent) and records the loop's outcome
    // to routing_shadow for the convergence pilot. Never shadows safety/onboarding
    // intents (they're absent from the intent→flow map).
    const shadowFlow = intentToShadowFlow(intent);
    if (shadowFlow) {
      void shadowTap({
        flow: shadowFlow, intent, text, phone, chatId,
        userId:   session.userId as string | undefined,
        seniorId: session.seniorId as string | undefined,
        userType: (session.userType as "client" | "caregiver") ?? "client",
        session:  session as unknown as Record<string, unknown>,
      }).catch(() => {});
    }

    // ── Emergency replacement: 1/2/3 ─────────────────────────────────────────
    if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
      await handleTaskApproval(pendingTask, text.trim(), session, chatId);
      return;
    }

    // ── Stale high-stakes confirmation sweep ─────────────────────────────────
    // pendingInterviewConfirm / pendingCancelConfirm / awaitingRecurringConfirmation
    // are checked in a fixed order by the YES/NO branches below, so a stale flag
    // (set long ago, never resolved) can intercept a YES meant for a newer
    // question. The global stateExpiresAt sweep in webhooks.ts only fires when a
    // stateExpiresAt is present — flags set without one never expire. Clear any
    // confirm flag older than its TTL here (and any flag with no age stamp, the
    // dangerous never-expires case), in DB and on the in-memory session, so the
    // branches below only ever act on a fresh confirmation. Mirrors the
    // pendingTaskConfirm staleness pattern further down.
    {
      const stale = staleConfirmFlags(session as unknown as Record<string, unknown>);
      if (stale.length > 0) {
        const expired: Record<string, admin.firestore.FieldValue> = {};
        for (const flag of stale) {
          expired[flag] = admin.firestore.FieldValue.delete();
          expired[`${flag}SetAt`] = admin.firestore.FieldValue.delete();
          (session as any)[flag] = undefined;
        }
        await db.collection("agent_sessions").doc(phone).update(expired).catch(() => {});
      }
    }

    // ── BOOKING_CONFIRM — natural language YES ("sure", "sounds good", etc.) ──
    if (intent === "BOOKING_CONFIRM") {
      // Interview and cancel confirm are time-sensitive — check before recurring to avoid stale flag collision
      if ((session as any).pendingInterviewConfirm) {
        await handleInterviewConfirm(phone, chatId, session);
        return;
      }
      if ((session as any).pendingCancelConfirm) {
        const pendingCancel = (session as any).pendingCancelConfirm as { appointmentId?: unknown };
        const appointmentId = pendingCancel?.appointmentId;
        if (typeof appointmentId !== "string" || !appointmentId) {
          await sendMessage(chatId, "Sorry, I lost track of which visit you wanted to cancel. Could you tell me again?");
          return;
        }
        const apptRef  = db.collection("appointments").doc(appointmentId);
        const apptSnap = await apptRef.get();
        if (apptSnap.exists) {
          const appt = apptSnap.data()!;
          await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
          const cgSnap  = await db.collection("caregivers").doc(appt.caregiverId).get();
          const cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
            const cancelNotifMsgA = await generateCaraMessage({
              audience: "caregiver",
              context: `The family has cancelled the visit on ${appt.date}. Notify the caregiver and apologize for the inconvenience.`,
              fallback: `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`,
              maxTokens: 80,
            });
            await sendMessage(cgSess.chatId, cancelNotifMsgA);
          }
        }
        await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
        const cancelConfirmMsgA = await generateCaraMessage({
          audience: "family",
          context: "Visit has been cancelled. Cara is confirming and offering to find a replacement for that day.",
          fallback: "Cancelled. Want me to find a replacement for that day?",
          maxTokens: 60,
        });
        await sendMessage(chatId, cancelConfirmMsgA);
        return;
      }
      if ((session as any).awaitingRecurringConfirmation) {
        await handleRecurringConfirm(phone, chatId, session);
        return;
      }
      if (pendingTask && pendingTask.data().type === "booking_confirmation") {
        try {
          await executeBookings(pendingTask.id, phone);
        } catch (err) {
          console.error("executeBookings failed (BOOKING_CONFIRM):", err);
          await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
          await sendMessage(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc } = await import("../agents/matchingAgent");
          await rmfc(phone, chatId, sd, sd).catch(() => {});
        }
        return;
      }
    }

    // ── BOOKING_DECLINE — natural language NO ("never mind", "don't book", etc.) ──
    if (intent === "BOOKING_DECLINE") {
      // Interview and cancel confirms are time-sensitive — check before recurring to avoid stale flag collision
      if ((session as any).pendingInterviewConfirm) {
        const pending = (session as any).pendingInterviewConfirm as { docId: string; caregiverName: string; mutualTime: string };
        await db.collection("agent_sessions").doc(phone).update({ pendingInterviewConfirm: admin.firestore.FieldValue.delete() });
        const reqSnap      = await db.collection("interview_requests").doc(pending.docId).get();
        const availability = (reqSnap.data()?.caregiverAvailability ?? []) as string[];
        const remaining    = availability.filter(t => t !== pending.mutualTime);
        if (remaining.length > 0) {
          const timesList = remaining.map((t, i) => `${i + 1}. ${t}`).join("\n");
          await db.collection("agent_sessions").doc(phone).update({
            pendingTimeSelection: { interviewRequestId: pending.docId, caregiverName: pending.caregiverName },
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
          await sendMessage(chatId, `No problem! ${pending.caregiverName} also offered:\n\n${timesList}\n\nReply with which time works, or PASS to find someone else.`);
        } else {
          // No more times — mark request client_declined
          await db.collection("interview_requests").doc(pending.docId).update({ status: "client_declined", clientDeclinedAt: new Date().toISOString() }).catch(() => {});
          // Notify the caregiver so they aren't left waiting
          const _bdReqSnap  = await db.collection("interview_requests").doc(pending.docId).get().catch(() => null);
          const _bdCgId     = _bdReqSnap?.data()?.caregiverId as string | undefined;
          if (_bdCgId) {
            const _bdCgSnap  = await db.collection("caregivers").doc(_bdCgId).get().catch(() => null);
            const _bdCgPhone = _bdCgSnap?.data()?.phone as string | undefined;
            if (_bdCgPhone) {
              const _bdCgSess = await (await import("./client")).getOrCreateSession(_bdCgPhone);
              await sendMessage(_bdCgSess.chatId,
                `Hi ${pending.caregiverName}, the family was not able to find a time that works right now. ` +
                `Thank you for your interest — I'll be in touch when there's a new opening that fits.`
              ).catch(() => {});
            }
          }
          const { checkAndTriggerRematching } = await import("../triggers/triggerEngine");
          await checkAndTriggerRematching(phone, "").catch(() => {});
        }
        return;
      }
      if ((session as any).pendingCancelConfirm) {
        await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
        await sendMessage(chatId, "Got it — visit is still on! Let me know if you need anything.");
        return;
      }
      if ((session as any).awaitingRecurringConfirmation) {
        await db.collection("agent_sessions").doc(phone).update({
          awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
          pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId, "No problem — I'll keep each visit booked individually. You can set up a recurring schedule anytime.");
        return;
      }
      if (pendingTask && pendingTask.data().type === "booking_confirmation") {
        await pendingTask.ref.update({ status: "declined" });
        await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
        await sendMessage(chatId, "No problem — booking cancelled. Want me to look at different dates or a different caregiver?");
        return;
      }
    }

    // ── HIRE_CAREGIVER — "let's go with Maria", "hire James" ─────────────────
    if (intent === "HIRE_CAREGIVER") {
      const pending = (session as any).pendingInterviewOutcome as
        { interviewId: string; caregiverName: string; caregiverId?: string } | undefined;
      if (pending) {
        let caregiverId = pending.caregiverId ?? "";
        if (!caregiverId && pending.interviewId) {
          const reqSnap = await db.collection("interview_requests")
            .where("interviewId", "==", pending.interviewId).limit(1).get();
          if (!reqSnap.empty) caregiverId = reqSnap.docs[0].data().caregiverId ?? "";
        }
        await db.collection("agent_sessions").doc(phone).update({
          hireMode: { caregiverName: pending.caregiverName, caregiverId },
          pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        if (caregiverId) writeInterviewOutcomeSignal(session.userId ?? phone, caregiverId, "hire").catch(() => {});
        const hireMsgA = await generateCaraMessage({
          audience: "family",
          context: `Family wants to hire caregiver ${pending.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
          fallback: `${pending.caregiverName} sounds like a great fit. When would you like care to start?`,
          maxTokens: 80,
        });
        await sendMessage(chatId, hireMsgA);
        return;
      }
      await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
      return;
    }

    // ── CAREGIVER_DECLINE_JOB — natural language job decline from caregiver ──
    if (intent === "CAREGIVER_DECLINE_JOB" && session.userType === "caregiver") {
      if ((session as any).pendingJobId) {
        await handleJobResponse(phone, "NO", chatId, session as any);
      } else {
        const noJobMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver responded to a job offer but there was no pending job in session. Cara acknowledges and lets them know it will reach out when something comes up.",
          fallback: "No worries — I'll reach out when something comes up.",
          maxTokens: 60,
        });
        await sendMessage(chatId, noJobMsg);
      }
      return;
    }

    // ── YES — booking, recurring setup, or interview confirmation ───────────────
    if (norm === "YES" || norm === "Y") {
      // Interview and cancel confirm are time-sensitive — check before recurring to avoid stale flag collision
      if ((session as any).pendingInterviewConfirm) {
        await handleInterviewConfirm(phone, chatId, session);
        return;
      }
      if ((session as any).pendingCancelConfirm) {
        const pendingCancel = (session as any).pendingCancelConfirm as { appointmentId?: unknown };
        const appointmentId = pendingCancel?.appointmentId;
        if (typeof appointmentId !== "string" || !appointmentId) {
          await sendMessage(chatId, "Sorry, I lost track of which visit you wanted to cancel. Could you tell me again?");
          return;
        }
        const apptRef = db.collection("appointments").doc(appointmentId);
        const apptSnap = await apptRef.get();
        if (apptSnap.exists) {
          const appt = apptSnap.data()!;
          await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
          const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
          const cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
            const cancelNotifMsgB = await generateCaraMessage({
              audience: "caregiver",
              context: `The family has cancelled the visit on ${appt.date}. Notify the caregiver and apologize for the inconvenience.`,
              fallback: `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`,
              maxTokens: 80,
            });
            await sendMessage(cgSess.chatId, cancelNotifMsgB);
          }
        }
        await db.collection("agent_sessions").doc(phone).update({
          pendingCancelConfirm: admin.firestore.FieldValue.delete(),
        });
        const cancelConfirmMsgB = await generateCaraMessage({
          audience: "family",
          context: "Visit has been cancelled. Cara is confirming and offering to find a replacement for that day.",
          fallback: "Cancelled. Want me to find a replacement for that day?",
          maxTokens: 60,
        });
        await sendMessage(chatId, cancelConfirmMsgB);
        return;
      }
      // YES to recurring schedule setup
      if ((session as any).awaitingRecurringConfirmation) {
        await handleRecurringConfirm(phone, chatId, session);
        return;
      }
      if (pendingTask && pendingTask.data().type === "booking_confirmation") {
        try {
          await executeBookings(pendingTask.id, phone);
        } catch (err) {
          console.error("executeBookings failed (YES):", err);
          await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
          await sendMessage(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc4 } = await import("../agents/matchingAgent");
          await rmfc4(phone, chatId, sd, sd).catch(() => {});
        }
        return;
      }
    }

    // ── NO — recurring setup declined, booking declined, or interview time rejected ──
    if (norm === "NO" || norm === "N") {
      // Interview and cancel confirms are time-sensitive — check before recurring to avoid stale flag collision
      if ((session as any).pendingInterviewConfirm) {
        const pending = (session as any).pendingInterviewConfirm as {
          docId: string; caregiverName: string; mutualTime: string;
        };
        await db.collection("agent_sessions").doc(phone).update({
          pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
        });
        // Check if caregiver offered more times
        const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
        const availability = (reqSnap.data()?.caregiverAvailability ?? []) as string[];
        // Remove the time we just rejected
        const remaining = availability.filter(t => t !== pending.mutualTime);
        if (remaining.length > 0) {
          const timesList = remaining.map((t, i) => `${i + 1}. ${t}`).join("\n");
          await db.collection("agent_sessions").doc(phone).update({
            pendingTimeSelection: { interviewRequestId: pending.docId, caregiverName: pending.caregiverName },
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
          await sendMessage(chatId,
            `No problem! ${pending.caregiverName} also offered:\n\n${timesList}\n\nReply with which time works, or PASS to find someone else.`
          );
        } else {
          await sendMessage(chatId,
            `Understood. Want me to ask ${pending.caregiverName} for different times, or reach out to the next best caregiver?`
          );
        }
        return;
      }
      // NO to cancel confirmation — abort the cancellation
      if ((session as any).pendingCancelConfirm) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingCancelConfirm: admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId, "Got it — visit is still on! Let me know if you need anything.");
        return;
      }
      // NO to recurring schedule setup
      if ((session as any).awaitingRecurringConfirmation) {
        await db.collection("agent_sessions").doc(phone).update({
          awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
          pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId,
          "No problem — I'll keep each visit booked individually. You can set up a recurring schedule anytime."
        );
        return;
      }
      // NO to booking summary
      if (pendingTask && pendingTask.data().type === "booking_confirmation") {
        await pendingTask.ref.update({ status: "declined" });
        await db.collection("agent_sessions").doc(phone).update({
          pendingCancelConfirm: admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId,
          "No problem — booking cancelled. Want me to look at different dates or a different caregiver?"
        );
        return;
      }
    }

    // ── CONFIRM / SKIP — finalizes a pending task selection made by 1/2/3 ──────
    // Drop stale pendingTaskConfirm (>1h old) so an old caregiver-selection
    // doesn't get finalized weeks later by an unrelated CONFIRM/SKIP keyword.
    if ((session as any).pendingTaskConfirm) {
      const setAt = (session as any).pendingTaskConfirmSetAt as string | undefined;
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      if (setAt && setAt < oneHourAgo) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingTaskConfirm:      admin.firestore.FieldValue.delete(),
          pendingTaskConfirmSetAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        (session as any).pendingTaskConfirm = undefined;
      }
    }
    if (norm === "CONFIRM" && (session as any).pendingTaskConfirm) {
      const { finalizeTaskApproval } = await import("../agents/taskApprovalHandler");
      await finalizeTaskApproval(phone, chatId, session as unknown as Record<string, unknown>);
      return;
    }
    if (norm === "SKIP" && (session as any).pendingTaskConfirm) {
      await db.collection("agent_sessions").doc(phone).update({
        pendingTaskConfirm: admin.firestore.FieldValue.delete(),
      });
      await sendMessage(chatId, "No problem — want me to find a different caregiver?");
      return;
    }

    // ── Post-interview outcome: classify natural language as HIRE/MAYBE/PASS ──
    const pendingOutcome = (session as any).pendingInterviewOutcome as
      { interviewId: string; caregiverName: string; caregiverId?: string } | undefined;
    if (pendingOutcome && norm !== "HIRE" && norm !== "MAYBE" && norm !== "PASS") {
      try {
        const classRaw = await quickComplete(
          "The user just interviewed a caregiver and is sharing their thoughts. " +
            "Classify as HIRE (positive, wants to proceed), MAYBE (uncertain, not sure), " +
            "or PASS (negative, concerns, didn't click). Reply with one word only.",
          text,
          { maxTokens: 10 },
        );
        const classified = classRaw.trim().toUpperCase();
        if (classified === "HIRE" || classified === "MAYBE" || classified === "PASS") {
          // Re-enter with classified keyword — will be picked up by the checks below
          (text as any); // text is const; shadow norm instead
          Object.assign(session, {}); // keep session reference
          // Override norm for the blocks below
          const resolvedNorm = classified;
          if (resolvedNorm === "HIRE") {
            let caregiverId = pendingOutcome.caregiverId ?? "";
            if (!caregiverId && pendingOutcome.interviewId) {
              const reqSnap = await db.collection("interview_requests")
                .doc(pendingOutcome.interviewId).get();
              if (reqSnap.exists) caregiverId = reqSnap.data()?.caregiverId ?? "";
            }
            await db.collection("agent_sessions").doc(phone).update({
              hireMode: { caregiverName: pendingOutcome.caregiverName, caregiverId },
              pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
              stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            if (caregiverId) {
              writeInterviewOutcomeSignal(session.userId ?? phone, caregiverId, "hire").catch(() => {});
            }
            const hireMsgB = await generateCaraMessage({
              audience: "family",
              context: `Family wants to hire caregiver ${pendingOutcome.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
              fallback: `${pendingOutcome.caregiverName} sounds like a great fit. When would you like care to start?`,
              maxTokens: 80,
            });
            await sendMessage(chatId, hireMsgB);
          } else if (resolvedNorm === "MAYBE") {
            const updates: Record<string, unknown> = {
              pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
            };
            if (pendingOutcome.caregiverId) {
              (updates as any).rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pendingOutcome.caregiverId);
            }
            await db.collection("agent_sessions").doc(phone).update(updates);
            await sendMessage(chatId, `That's okay — want me to reach out to anyone else in the meantime?`);
          } else {
            const updates: Record<string, unknown> = {
              pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
            };
            if (pendingOutcome.caregiverId) {
              (updates as any).rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pendingOutcome.caregiverId);
              writeInterviewOutcomeSignal(session.userId ?? phone, pendingOutcome.caregiverId, "pass").catch(() => {});
              // Notify caregiver of the outcome
              db.collection("caregivers").doc(pendingOutcome.caregiverId).get().then(async cgSnap => {
                const cgPhone = cgSnap.data()?.phone as string | undefined;
                const cgName  = cgSnap.data()?.name ?? "Caregiver";
                if (!cgPhone) return;
                const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
                await sendMessage(cgSess.chatId,
                  `Hi ${cgName}, the family has decided not to move forward at this time. ` +
                  `Thank you for interviewing — I'll reach out when there's a new opportunity that's a great fit.`
                );
              }).catch(() => {});
            }
            await db.collection("agent_sessions").doc(phone).update(updates);
            await sendMessage(chatId, `Understood. Want me to search for more caregivers? Reply YES and I'll get started.`);
          }
          return;
        }
      } catch (err) {
        console.error("interview outcome classification error:", err);
      }
    }

    // ── HIRE — post-interview decision ────────────────────────────────────────
    if (norm === "HIRE") {
      const pending = (session as any).pendingInterviewOutcome as
        { interviewId: string; caregiverName: string; caregiverId?: string } | undefined;
      if (pending) {
        // Resolve caregiverId from interview_requests if not already on pending
        let caregiverId = pending.caregiverId ?? "";
        if (!caregiverId && pending.interviewId) {
          const reqSnap = await db.collection("interview_requests")
            .where("interviewId", "==", pending.interviewId)
            .limit(1).get();
          if (!reqSnap.empty) caregiverId = reqSnap.docs[0].data().caregiverId ?? "";
        }
        await db.collection("agent_sessions").doc(phone).update({
          hireMode: { caregiverName: pending.caregiverName, caregiverId },
          pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        if (caregiverId) {
          writeInterviewOutcomeSignal(session.userId ?? phone, caregiverId, "hire").catch(() => {});
        }
        const hireMsgC = await generateCaraMessage({
          audience: "family",
          context: `Family wants to hire caregiver ${pending.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
          fallback: `${pending.caregiverName} sounds like a great fit. When would you like care to start?`,
          maxTokens: 80,
        });
        await sendMessage(chatId, hireMsgC);
        return;
      }
      // No pending outcome — ask who
      await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
      return;
    }

    // ── MAYBE / PASS — post-interview ─────────────────────────────────────────
    if (norm === "MAYBE" || norm === "PASS") {
      const pending = (session as any).pendingInterviewOutcome as
        { interviewId?: string; caregiverName: string; caregiverId?: string } | undefined;
      if (pending) {
        const updates: Record<string, unknown> = {
          pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
        };
        if (pending.caregiverId) {
          (updates as any).rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pending.caregiverId);
          if (norm === "PASS") {
            writeInterviewOutcomeSignal(session.userId ?? phone, pending.caregiverId, "pass").catch(() => {});
            // Notify caregiver of the outcome so they aren't left waiting
            db.collection("caregivers").doc(pending.caregiverId).get().then(async cgSnap => {
              const cgPhone = cgSnap.data()?.phone as string | undefined;
              const cgName  = cgSnap.data()?.name ?? "Caregiver";
              if (!cgPhone) return;
              const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
              await sendMessage(cgSess.chatId,
                `Hi ${cgName}, the family has decided not to move forward at this time. ` +
                `Thank you for interviewing — I'll reach out when there's a new opportunity that's a great fit.`
              );
            }).catch(() => {});
          }
        }
        await db.collection("agent_sessions").doc(phone).update(updates);
        if (norm === "MAYBE") {
          await sendMessage(chatId, `Got it — I'll keep ${pending.caregiverName} in mind. Want me to reach out to anyone else?`);
        } else {
          await sendMessage(chatId, `Understood. Want me to search for more caregivers? Reply YES and I'll get started.`);
        }
        return;
      }
    }

    // ── Caregiver selection (numbers after match presentation) ────────────────
    // Only fire when ALL of:
    //   - pendingMatches is non-empty
    //   - pendingMatches was set within the last 2 hours (older state is stale)
    //   - text is JUST a selection answer ("1", "2", "1 and 2", "all", "1,3"),
    //     not a sentence that happens to contain a digit ("3 mornings a week"
    //     used to trip the old loose /[123]/ regex)
    // Anything else falls through to the normal intent routing. If the user
    // explicitly says "find a caregiver" while pendingMatches is stale, we
    // clear it below so they get a fresh search instead of being asked to
    // pick from a list they never saw.
    const stalePendingMatches = (session as any).pendingMatches as Array<unknown> | undefined;
    if (stalePendingMatches && stalePendingMatches.length > 0) {
      const setAt = (session as any).pendingMatchesSetAt as string | undefined;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const isFresh = !setAt || setAt > twoHoursAgo;
      const trimmedNorm = norm.replace(/[.!?]+$/, "").trim();
      const isPureSelectionAnswer = /^(?:all|none|skip|pass|[1-9](?:\s*(?:,|and|&|\s)\s*[1-9])*)$/i.test(trimmedNorm);

      if (isFresh && isPureSelectionAnswer) {
        await handleInterviewSelection(phone, chatId, text, session);
        return;
      }

      // ── Mid-match refilter ─────────────────────────────────────────────
      // "show me cheaper ones", "any with dementia experience", "anyone Saturday?"
      // — detect criterion changes and re-run matching with the new filters.
      if (isFresh) {
        const { detectMatchRefilter } = await import("../utils/matchRefilterDetector");
        // Load Cara's last message so the detector can tell a search-criteria
        // change ("show me cheaper ones") apart from the family simply ANSWERING
        // a question Cara just asked (e.g. "What date/time works best?" → "Today
        // at 11am"). Without it, a scheduling-time reply was being misread as an
        // availability refilter and triggering a fresh caregiver search.
        const lastAssistantMessage = await db
          .collection("agent_conversations").doc(phone).collection("messages")
          .where("role", "==", "assistant").orderBy("timestamp", "desc").limit(1).get()
          .then(s => (s.empty ? undefined : (s.docs[0].data().content as string | undefined)))
          .catch(() => undefined);
        const refilter = await detectMatchRefilter(text, lastAssistantMessage).catch(() => null);
        if (refilter) {
          const baseIntake = ((session as any).onboardingData ?? {}) as Record<string, unknown>;
          const mergedIntake: Record<string, unknown> = { ...baseIntake };

          // Merge refilter overrides into intake
          if (refilter.skills?.length) {
            const existing = (baseIntake.careNeeds as string[] | undefined) ?? [];
            mergedIntake.careNeeds = Array.from(new Set([...existing, ...refilter.skills]));
          }
          if (refilter.languages?.length) {
            mergedIntake.languagePreference = refilter.languages[0];
          }
          if (refilter.genderPreference) {
            mergedIntake.genderPreference = refilter.genderPreference;
          }
          if (refilter.rate) {
            mergedIntake.rateDirection = refilter.rate.direction;
          }
          if (refilter.availability) {
            mergedIntake.availabilityOverride = refilter.availability;
          }
          if (refilter.distance) {
            mergedIntake.distanceDirection = refilter.distance.direction;
          }
          if (refilter.experienceYears?.min) {
            mergedIntake.minExperienceYears = refilter.experienceYears.min;
          }

          await db.collection("agent_sessions").doc(phone).update({
            pendingMatches:      admin.firestore.FieldValue.delete(),
            pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
            lastRefilterSummary: refilter.summary,
          }).catch(() => {});

          await sendMessage(chatId, `Searching for ${refilter.summary} — coming up.`);

          // Fire matching with merged intake; runs async with its own send.
          const { runMatchingForClient } = await import("../agents/matchingAgent");
          await runMatchingForClient(phone, chatId, mergedIntake, session as unknown as Record<string, unknown>);
          return;
        }
      }

      // User isn't picking from the list — if their intent is to start a new
      // search (FIND_CAREGIVER, REBOOK_REQUEST) or the list is stale, clear
      // the lingering state so it doesn't keep hijacking unrelated messages.
      const isFreshSearchIntent = intent === "FIND_CAREGIVER" || intent === "REBOOK_REQUEST" || intent === "POST_JOB";
      if (!isFresh || isFreshSearchIntent) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingMatches:      admin.firestore.FieldValue.delete(),
          pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        (session as any).pendingMatches = undefined;
      }
      // Otherwise fall through to normal intent routing.
    }

    // ── Recurring schedule: RESUME keyword ───────────────────────────────────
    if (norm === "RESUME SCHEDULE" || norm === "RESUME") {
      if ((session as any).activeRecurringScheduleId) {
        await handleRecurringResume(phone, chatId, session);
        return;
      }
    }

    // ── Recurring schedule: PAUSE / CANCEL via intent ─────────────────────────
    if (intent === "PAUSE_SCHEDULE") {
      await handleRecurringPause(phone, chatId, session);
      return;
    }

    if (intent === "CANCEL_SCHEDULE") {
      await handleRecurringCancel(phone, chatId, session);
      return;
    }

    // ── Permission update ─────────────────────────────────────────────────────
    if (intent === "PERMISSION_UPDATE") {
      const userId   = session.userId ?? session.caregiverId ?? phone;
      const userType = session.userType ?? "client";
      await updatePermissionFromText(userId, userType, phone, chatId, text);
      return;
    }

    if (intent === "MEMORY_QUERY") {
      const zepUserId = getZepUserId(phone);
      const zepFacts  = await searchZepMemory(zepUserId, text).catch(() => "");
      const memUserId = session.userId ?? session.caregiverId ?? phone;
      const { handleMemoryQuery } = await import("../memory/memoryFiles");
      await handleMemoryQuery(memUserId, chatId, sendMessage, zepFacts || undefined);
      return;
    }

    if (intent === "ADD_FAMILY_MEMBER") {
      await handleAddFamilyMemberIntent(phone, chatId, text, session);
      return;


      // Both pieces are now in hand — clear the partial-capture state.
    }

    if (intent === "REMOVE_FAMILY_MEMBER") {
      if ((session as any).isSecondaryMember) {
        await sendMessage(chatId, "I can help with updates here, but only the primary account holder can remove people from this care group.");
        return;
      }

      const { name: targetName, phone: extractedPhone } = await extractFamilyMember(text);
      let targetPhone: string | null = extractedPhone;

      if (!targetPhone && targetName) {
        const memberSnap = await db.collection("family_group_members")
          .where("primaryPhone", "==", phone)
          .get();
        // Exact (normalized) name match, not substring — substring would let
        // "Ann" resolve to "Joanna" and remove the wrong person. If more than
        // one member shares the name, ask for the phone to disambiguate rather
        // than guessing on a destructive action.
        const target = targetName.toLowerCase().trim();
        const matches = memberSnap.docs.filter(d =>
          (d.data().memberName as string ?? "").toLowerCase().trim() === target
        );
        if (matches.length > 1) {
          await sendMessage(chatId, `I have more than one ${targetName} in your care group. What's their phone number so I remove the right person?`);
          return;
        }
        if (matches.length === 1) targetPhone = matches[0].data().memberPhone as string;
      }

      if (!targetPhone) {
        await sendMessage(chatId, "I can remove them, but I need their phone number so I remove the right person.");
        return;
      }

      const seniorId: string = (session as any).seniorId ?? session.userId ?? phone;
      const clientId = session.userId;
      if (!clientId) {
        await sendMessage(chatId, "I need to finish linking your account before I can remove someone from this care group.");
        return;
      }

      const { handleToolCall } = await import("../mcp/server");
      const result = await handleToolCall("remove_family_member", {
        seniorId,
        memberPhone: targetPhone,
        phone,
        clientId,
        userId: clientId,
      }) as any;

      if (result?._pending_action) {
        await sendMessage(chatId, `Before I remove ${targetName ?? targetPhone} from the care group, please reply YES to confirm.`);
      } else if (result?._toolError) {
        await sendMessage(chatId, result.message ?? `I couldn't remove ${targetName ?? targetPhone} yet.`);
      } else {
        await sendMessage(chatId, `Done - ${targetName ?? targetPhone} has been removed from your care group.`);
      }
      return;
    }
    // ── hireMode step B — schedule reply ─────────────────────────────────────
    if ((session as any).hireMode && (session as any).hireModeDate) {
      const hire      = (session as any).hireMode      as { caregiverName: string; caregiverId: string };
      const dateStr   = (session as any).hireModeDate  as string;
      const parsedScheduleRaw = await quickComplete(
        "Extract a weekly care schedule from this message. " +
          "Reply with only a JSON object: { \"days\": [\"Monday\",\"Wednesday\",\"Friday\"], " +
          "\"startTime\": \"9:00 AM\", \"endTime\": \"1:00 PM\", \"durationHours\": 4 }. " +
          "days must be full day names. durationHours is a number.",
        text,
        { maxTokens: 120 },
      ).catch(() => "null");
      let schedule: { days: string[]; startTime: string; endTime: string; durationHours: number } | null = null;
      try {
        schedule = JSON.parse(parsedScheduleRaw || "null");
      } catch { /* */ }

      if (!schedule || !schedule.days?.length) {
        await sendMessage(chatId, "I didn't catch that — could you try again? (e.g. '3 days, Mon/Wed/Fri, 9am–1pm')");
        return;
      }

      // Fetch actual hourly rate from caregiver doc
      const cgDoc = await db.collection("caregivers").doc(hire.caregiverId).get();
      const hourlyRate = (cgDoc.data()?.hourlyRate ?? 20) as number;

      // Build one appointment per day starting from the hire date's week
      const startDate = new Date(dateStr + "T12:00:00Z");
      const dayIndexMap: Record<string, number> = {
        Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
      };
      const appointments: Array<{ date: string; startTime: string; endTime: string; durationHours: number }> = [];
      for (const day of schedule.days) {
        const target = dayIndexMap[day] ?? -1;
        if (target < 0) continue;
        const d = new Date(startDate);
        const diff = (target - d.getUTCDay() + 7) % 7;
        d.setUTCDate(d.getUTCDate() + diff);
        appointments.push({
          date:          d.toISOString().slice(0, 10),
          startTime:     schedule.startTime,
          endTime:       schedule.endTime,
          durationHours: schedule.durationHours,
        });
      }

      const clientId = session.userId ?? phone;
      const taskId   = await createBookingTask({
        clientPhone:   phone,
        clientId,
        caregiverId:   hire.caregiverId,
        caregiverName: hire.caregiverName,
        appointments,
        hourlyRate,
      });

      await db.collection("agent_sessions").doc(phone).update({
        hireMode:     admin.firestore.FieldValue.delete(),
        hireModeDate: admin.firestore.FieldValue.delete(),
      });

      const perms = await getPermissions(session.userId ?? phone).catch(() => null);
      if (perms?.canBookAutomatically) {
        try {
          await executeBookings(taskId, phone);
        } catch (err) {
          console.error("executeBookings failed (hireMode):", err);
          await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
          await sendMessage(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc2 } = await import("../agents/matchingAgent");
          await rmfc2(phone, chatId, sd, sd).catch(() => {});
        }
      } else {
        const totalCost = (appointments.length * schedule.durationHours * hourlyRate).toFixed(2);
        const lines = appointments.map(a => `${a.date} · ${a.startTime}–${a.endTime}`).join("\n");
        await sendMessage(chatId,
          `Here's your booking summary:\n\n${lines}\n${hire.caregiverName} · $${totalCost} total\n\nReply YES to confirm or NO to cancel.`
        );
      }
      return;
    }

    // ── hireMode step A — date reply ──────────────────────────────────────────
    if ((session as any).hireMode && !(session as any).hireModeDate) {
      const parsedDateRaw = await quickComplete(
        `Today is ${new Date().toISOString().slice(0, 10)}. ` +
          "The user is choosing a start date for care. Reply with only a YYYY-MM-DD date string, nothing else.",
        text,
        { maxTokens: 20 },
      ).catch(() => "");
      const dateStr = parsedDateRaw.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await sendMessage(chatId, "I didn't catch that date — could you try again? (e.g. \"next Monday\" or \"May 19\")");
        return;
      }
      await db.collection("agent_sessions").doc(phone).update({
        hireModeDate: dateStr,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId,
        `Got it — starting ${dateStr}.\n\nHow many days a week and what hours? (e.g. "3 days, Mon/Wed/Fri, 9am–1pm")`
      );
      return;
    }

    // ── pendingTimeSelection — family picking from caregiver's offered times ──
    if ((session as any).pendingTimeSelection) {
      const sel = (session as any).pendingTimeSelection as { interviewRequestId: string; caregiverName: string };

      if (norm === "PASS") {
        await db.collection("agent_sessions").doc(phone).update({
          pendingTimeSelection: admin.firestore.FieldValue.delete(),
        });
        await db.collection("interview_requests").doc(sel.interviewRequestId).update({ status: "client_declined" });
        await sendMessage(chatId, `No problem — want me to reach out to the next best caregiver? Reply YES and I'll get on it.`);
        return;
      }

      // Parse which time the family chose
      const reqSnap = await db.collection("interview_requests").doc(sel.interviewRequestId).get();
      const availability = (reqSnap.data()?.caregiverAvailability ?? []) as string[];
      const parsedChosen = await quickComplete(
        `Available times: ${availability.join(", ")}. ` +
          "The user picked one of these times. Reply with only the exact string from the list that best matches their reply, or 'NONE' if no match.",
        text,
        { maxTokens: 60 },
      ).catch(() => "");
      const chosen = parsedChosen.trim();
      if (chosen === "NONE" || !availability.includes(chosen)) {
        await sendMessage(chatId, `I didn't catch that — which of these works for you?\n\n${availability.join("\n")}\n\nOr reply PASS to find someone else.`);
        return;
      }

      // Book the chosen time
      await db.collection("agent_sessions").doc(phone).update({
        pendingTimeSelection:   admin.firestore.FieldValue.delete(),
        pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen },
        pendingInterviewConfirmSetAt: new Date().toISOString(),
      });
      await handleInterviewConfirm(phone, chatId, {
        ...session,
        pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen },
      } as AgentSession);
      return;
    }

    // ── CANCEL intent — cancel a visit, NOT an opt-out ────────────────────────
    if (intent === "CANCEL_REQUEST" || norm === "CANCEL") {
      const clientId = session.userId ?? phone;
      const upcoming = await db.collection("appointments")
        .where("clientId", "==", clientId)
        .where("status",   "==", "confirmed")
        .orderBy("date",   "asc").limit(1).get();
      if (upcoming.empty) {
        await sendMessage(chatId, "I don't see any upcoming visits to cancel. What were you looking to change?");
        return;
      }
      const appt = upcoming.docs[0].data();
      await db.collection("agent_sessions").doc(phone).update({
        pendingCancelConfirm: { appointmentId: upcoming.docs[0].id },
        pendingCancelConfirmSetAt: new Date().toISOString(),
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId,
        `Cancel ${appt.caregiverName}'s visit on ${appt.date} (${appt.startTime}–${appt.endTime})?\n\nReply YES to confirm or NO to keep it.`
      );
      return;
    }

    // ── Pending rebook — waiting for client to supply a date ─────────────────
    if ((session as any).pendingRebook) {
      const rebook = (session as any).pendingRebook as {
        caregiverId: string; caregiverName: string;
        startTime: string; endTime: string; durationHours: number;
      };
      const parsedDateRaw = await quickComplete(
        `Today is ${new Date().toISOString().slice(0, 10)}. ` +
          "The user is choosing a date for a care visit. Reply with only a YYYY-MM-DD date string, nothing else.",
        text,
        { maxTokens: 20 },
      ).catch(() => "");
      const dateStr = parsedDateRaw.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await sendMessage(chatId, "I didn't catch that date — could you try again? (e.g. \"May 19\" or \"next Monday\")");
        return;
      }
      const clientId = session.userId ?? phone;
      const taskId   = await createBookingTask({
        clientPhone:   phone,
        clientId,
        caregiverId:   rebook.caregiverId,
        caregiverName: rebook.caregiverName,
        appointments:  [{ date: dateStr, startTime: rebook.startTime, endTime: rebook.endTime, durationHours: rebook.durationHours }],
        hourlyRate:    20,
      });
      await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
      const perms = await getPermissions(session.userId ?? phone).catch(() => null);
      if (perms?.canBookAutomatically) {
        try {
          await executeBookings(taskId, phone);
        } catch (err) {
          console.error("executeBookings failed (rebook):", err);
          await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
          await sendMessage(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc3 } = await import("../agents/matchingAgent");
          await rmfc3(phone, chatId, sd, sd).catch(() => {});
        }
      } else {
        const cost = (rebook.durationHours * 20).toFixed(2);
        await sendMessage(chatId,
          `Here's your booking summary:\n\n` +
          `${dateStr} · ${rebook.startTime}–${rebook.endTime}\n` +
          `${rebook.caregiverName} · $${cost}\n\n` +
          `Reply YES to confirm or NO to cancel.`
        );
      }
      return;
    }

    // ── Rebook request ────────────────────────────────────────────────────────
    if (intent === "REBOOK_REQUEST") {
      const clientId = session.userId ?? phone;
      const lastApptSnap = await db.collection("appointments")
        .where("clientId", "==", clientId)
        .where("status",   "==", "confirmed")
        .orderBy("date",   "desc").limit(1).get();

      if (lastApptSnap.empty) {
        await sendMessage(chatId, "I don't have any past bookings to rebook from. Want me to search for a caregiver? Just let me know!");
        return;
      }

      const last          = lastApptSnap.docs[0].data();
      const caregiverId   = last.caregiverId   as string;
      const caregiverName = last.caregiverName as string;
      const startTime     = last.startTime     as string;
      const endTime       = last.endTime       as string;
      const durationHours = (last.durationHours ?? 4) as number;

      await db.collection("agent_sessions").doc(phone).update({
        pendingRebook: { caregiverId, caregiverName, startTime, endTime, durationHours },
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId,
        `Got it — same schedule with ${caregiverName} (${startTime}–${endTime})?\n\n` +
        `What date should the visit be?`
      );
      return;
    }

    // ── Schedule request — set up a personal recurring reminder ─────────────
    if (intent === "SCHEDULE_REQUEST") {
      const { handleScheduleRequest } = await import("../agents/schedulingHandler");
      await handleScheduleRequest(phone, text, session as unknown as Record<string, unknown>);
      return;
    }

    // ── Trigger management — view or cancel personal reminders ───────────────
    if (intent === "TRIGGER_MANAGEMENT") {
      // U10: convergence flip — when "reminder_management" is flipped (only after
      // its shadow data shows parity), the live path runs through the MCP tool loop
      // instead of the cascade state machine. Dark by default (flag off → the state
      // machine below, unchanged). Reversible by clearing CONVERGENCE_FLIPPED; the
      // state machine is retained until a later post-flip cleanup deletes it.
      if (isConvergenceFlipped("reminder_management")) {
        const qaReplyReminder = await runQaAgent({
          text, phone, chatId,
          userId:      session.userId ?? "",
          seniorId:    session.seniorId ?? session.userId ?? "",
          userType:    (session.userType as "client" | "caregiver") ?? "client",
          caregiverId: session.caregiverId,
          session:     session as unknown as Record<string, unknown>,
          intent,
        });
        await sendViaInteractionAgent(phone, {
          content: qaReplyReminder, urgency: "standard", sourceAgent: "qa_reminder", canDrop: false,
        });
        return;
      }
      const { handleTriggerManagement } = await import("../agents/schedulingHandler");
      await handleTriggerManagement(phone, text, session as unknown as Record<string, unknown>);
      return;
    }

    // ── POST_JOB — start the conversational job posting state machine ────────
    if (intent === "POST_JOB" && session.userType !== "caregiver") {
      await startJobPostingFlow(phone, chatId, session);
      return;
    }

    // ── RESCHEDULE_REQUEST (caregiver) — natural language reschedule, mirrors RESCHEDULE keyword ──
    if (intent === "RESCHEDULE_REQUEST" && session.userType === "caregiver") {
      await db.collection("agent_sessions").doc(phone).update({
        caregiverRescheduling: true,
        stateExpiresAt:        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const rescheduleNlMsg = await generateCaraMessage({
        audience: "caregiver",
        context: "Caregiver wants to reschedule a visit. Cara is asking them to suggest 2–3 times that work and will relay them to the family.",
        fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
        maxTokens: 80,
      });
      await sendMessage(chatId, rescheduleNlMsg);
      return;
    }

    // ── RESCHEDULE_REQUEST — move an existing appointment to a new date/time ──
    if (intent === "RESCHEDULE_REQUEST" && session.userType !== "caregiver") {
      const qaReplyReschedule = await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
      });
      await sendViaInteractionAgent(phone, {
        content:     qaReplyReschedule,
        urgency:     "standard",
        sourceAgent: "qa_reschedule",
        canDrop:     false,
      });
      return;
    }

    // ── MODIFY_SCHEDULE — change days/times of recurring care schedule ────────
    if (intent === "MODIFY_SCHEDULE" && session.userType !== "caregiver") {
      await startModifyScheduleFlow(phone, chatId, session);
      return;
    }

    // ── SWAP_REQUEST — caregiver looking for coverage on one of their shifts ──
    if (intent === "SWAP_REQUEST" && session.userType === "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const cgDoc = session.caregiverId
          ? await db.collection("caregivers").doc(session.caregiverId).get()
          : null;
        await handleCaregiverSwapRequest(
          session.caregiverId ?? phone,
          cgDoc?.data()?.name ?? "Caregiver",
          phone,
          text,
          // Session has no swapStep yet — handler defaults to "identify_shift"
          session as unknown as Record<string, unknown>,
          chatId
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── CANCEL_SHIFT — caregiver proactively cancels one of their shifts ───
    if (intent === "CANCEL_SHIFT" && session.userType === "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const cgDoc = session.caregiverId
          ? await db.collection("caregivers").doc(session.caregiverId).get()
          : null;
        await handleCaregiverCancelShift(
          session.caregiverId ?? phone,
          cgDoc?.data()?.name ?? "Caregiver",
          phone,
          text,
          session as unknown as Record<string, unknown>,
          chatId,
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Caregiver profile updates (rate / skills / bio / photo / pause / reactivate) ──
    {
      const profileField = profileFieldFromIntent(intent) as ProfileUpdateField | undefined;
      if (profileField && session.userType === "caregiver" && session.caregiverId) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          // Seed the session state with the requested field and entry step so the
          // handler enters "collect" cleanly.
          await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep:  "collect",
            profileUpdateField: profileField,
            stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
          const enrichedSession = {
            ...(session as unknown as Record<string, unknown>),
            profileUpdateStep:  "collect",
            profileUpdateField: profileField,
          };
          await handleCaregiverProfileUpdate(
            session.caregiverId,
            phone,
            text,
            enrichedSession,
            chatId,
            profileField,
          );
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return;
      }
    }

    // ── INSTANT_PAYOUT — PAYOUT keyword / "cash out now" / etc. ────────────
    if (intent === "INSTANT_PAYOUT" && session.userType === "caregiver" && session.caregiverId) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const { startInstantPayout } = await import("../agents/instantPayoutHandler");
        await startInstantPayout(session.caregiverId, phone, chatId);
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── CLIENT_SWAP_REQUEST — client wants a different caregiver for a visit ──
    if (intent === "CLIENT_SWAP_REQUEST" && session.userType !== "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        await handleClientSwapRequest(
          session.userId ?? phone,
          phone,
          text,
          // Session has no clientSwapStep yet — handler defaults to "identify_appointment"
          session as unknown as Record<string, unknown>,
          chatId
        );
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── UPDATE_PAYMENT_METHOD — generate Stripe billing portal link ───────────
    if (intent === "UPDATE_PAYMENT_METHOD" && session.userType !== "caregiver") {
      const clientId = session.userId ?? phone;
      try {
        const { handleToolCall } = await import("../mcp/server");
        const result = await handleToolCall("get_payment_update_link", { clientId }) as { success?: boolean; url?: string };
        if (result?.success && result?.url) {
          await sendMessage(chatId,
            `Here's a secure link to update your payment method:\n\n${result.url}\n\n` +
            `This link expires in 5 minutes. Once updated, your next scheduled payment will use the new method.`
          );
        } else {
          await sendMessage(chatId,
            "I wasn't able to generate a payment update link right now. Please visit the app settings to update your billing, or reply again and I'll try once more."
          );
        }
      } catch (err) {
        console.error("UPDATE_PAYMENT_METHOD error:", err);
        await sendMessage(chatId,
          "I ran into an issue generating your billing link. You can update your payment method in the app under Settings → Billing."
        );
      }
      return;
    }

    // ── REQUEST_REFUND — start the refund self-service state machine ─────────
    if (intent === "REQUEST_REFUND" && session.userType !== "caregiver") {
      const refundClientId = (session.userId ?? phone) as string;
      // Initialise the state machine by calling with step = "identify_visit"
      await handleRefundRequest(
        refundClientId,
        text,
        session as unknown as Record<string, unknown>,
        (msg: string) => sendMessage(chatId, msg)
      );
      return;
    }

    // ── VIEW_INVOICE / VIEW_CARE_PLAN_HISTORY — routed to QA agent ───────────
    if (
      (intent === "VIEW_INVOICE" && session.userType !== "caregiver") ||
      (intent === "VIEW_CARE_PLAN_HISTORY" && session.userType !== "caregiver")
    ) {
      const qaReplyInvoice = await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
      });
      await sendViaInteractionAgent(phone, {
        content:     qaReplyInvoice,
        urgency:     "standard",
        sourceAgent: "qa",
        canDrop:     false,
      });
      return;
    }

    // ── APPROVE_TIMESHEET — client approves shift hours via dedicated handler ─
    if (intent === "APPROVE_TIMESHEET" && session.userType !== "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        await handleTimesheetApproval(
          (session.userId ?? phone) as string,
          phone,
          text,
          { ...session as unknown as Record<string, unknown>, timesheetStep: "start" },
          (msg: string) => sendMessage(chatId, msg)
        );
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── VIEW_EARNINGS — caregiver views their pay summary ────────────────────
    if (intent === "VIEW_EARNINGS" && session.userType === "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        const cgId = (session.caregiverId ?? session.userId ?? phone) as string;
        await handleEarningsView(cgId, (msg: string) => sendMessage(chatId, msg));
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── UPDATE_AVAILABILITY — caregiver updates their schedule ───────────────
    if (intent === "UPDATE_AVAILABILITY" && session.userType === "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        const cgId = (session.caregiverId ?? session.userId ?? phone) as string;
        await handleAvailabilityUpdate(
          cgId,
          phone,
          text,
          { ...session as unknown as Record<string, unknown>, availabilityStep: "start" },
          (msg: string) => sendMessage(chatId, msg)
        );
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Platform-action intents — routed to QA agent with new MCP tools ─────
    if (
      intent === "VIEW_MY_JOBS"    ||
      intent === "VIEW_APPLICANTS" ||
      intent === "VIEW_JOURNAL"    ||
      intent === "BROWSE_JOB_BOARD"
    ) {
      const qaReplyPlatform = await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    session.userType    ?? "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
      });
      await sendViaInteractionAgent(phone, {
        content:     qaReplyPlatform,
        urgency:     "standard",
        sourceAgent: "qa",
        canDrop:     false,
      });
      return;
    }

    // ── Credential management — "what logins do you have", "remove my CVS login" ─
    if (intent === "CREDENTIAL_MANAGEMENT" && session.userType !== "caregiver") {
      const qaReply = await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
      });
      await sendViaInteractionAgent(phone, {
        content:     qaReply,
        urgency:     "standard",
        sourceAgent: "qa",
        canDrop:     false,
      });
      return;
    }

    // ── Find caregiver — post-onboarding matching request ────────────────────
    if (intent === "FIND_CAREGIVER" && session.userType !== "caregiver") {
      const { runMatchingForClient } = await import("../agents/matchingAgent");
      const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
      const sessionData  = sessionSnap2.data() ?? {};
      await runMatchingForClient(phone, chatId, sessionData, sessionData);
      return;
    }

    // ── Healthcare intents — provider search, appointment booking, Rx ────────
    if (
      (intent === "FIND_NEARBY_PROVIDER" ||
       intent === "BOOK_DOCTOR_APPOINTMENT" ||
       intent === "PRESCRIPTION_REFILL" ||
       intent === "NEW_PRESCRIPTION") &&
      session.userType !== "caregiver"
    ) {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        const { startHealthcareFlow } = await import("../agents/healthcareHandler");
        await startHealthcareFlow(
          phone,
          chatId,
          text,
          session,
          intent,
          (msg) => sendMessage(chatId, msg)
        );
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Fact correction — user is correcting a known fact ────────────────────
    if (intent === "FACT_CORRECTION") {
      const { detectAndApplyCorrection } = await import("../memory/learnedFacts");
      const factUserId = session.userType === "caregiver"
        ? (session.caregiverId ?? session.userId ?? phone)
        : (session.userId ?? phone);
      const zepUserId2 = (session as any).zepThreadId ? phone.replace(/\D/g, "") : undefined;
      const applied = await detectAndApplyCorrection(factUserId, text, zepUserId2).catch(() => false);

      if (applied) {
        await sendMessage(chatId, "Got it — I've updated that.");
        return;
      }
      // Fall through to QA agent if we couldn't match a specific known fact
    }

    // ── Update onboarding — already-onboarded user wants to review/fix profile ─
    // PARTIAL users (no userId/seniorId) hit the onboarding offer earlier in
    // this handler and never reach here. For ONBOARDED users, flip a session
    // flag and fall through to runQaAgent — qaAgent reads the flag and runs a
    // structured profile-review sub-prompt (read current state, confirm in
    // prose, patch fields one at a time via update_senior_profile /
    // update_care_plan). 20-minute TTL prevents stale flags surviving across
    // unrelated future conversations.
    if (intent === "UPDATE_ONBOARDING" && session.userType !== "caregiver") {
      const ttlMs = 20 * 60 * 1000;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await db.collection("agent_sessions").doc(phone).update({
        profileReviewMode:      true,
        profileReviewExpiresAt: expiresAt,
      }).catch((err) => console.warn("profileReviewMode set failed", err));
      // Mutate the in-memory session too so the directive fires THIS turn.
      (session as any).profileReviewMode      = true;
      (session as any).profileReviewExpiresAt = expiresAt;
      // Fall through to runQaAgent below.
    }

    // ── Default: QA agent ─────────────────────────────────────────────────────
    const zepThreadId = (session as any).zepThreadId as string | undefined;

    if (zepThreadId) {
      addUserMessageToZep({
        threadId: zepThreadId,
        content:  text,
        userName: (session as any).firstName ?? "Family",
        sentAt:   new Date(),
      }).catch(console.error);
    }

    // ── Trivial quick-reply bypass — short generic greetings/thanks ─────────
    // For QUESTION-intent messages with no entity content, skip the full
    // tool-use loop and answer with gpt-4o-mini in ~1s. Conservative heuristic:
    // anything ambiguous falls through to runQaAgent below. A degraded
    // classification (classifier error → guessed QUESTION) never qualifies —
    // the full agent path with its supervisor is the fail-safe.
    if (intent === "QUESTION" && !intentDegraded && isTrivialQuickReply(text)) {
      const quickReply = await runQuickReply({
        text,
        phone,
        chatId,
        userId:      session.userId ?? "",
        seniorId:    session.seniorId ?? session.userId ?? "",
        userType:    session.userType ?? "client",
        caregiverId: session.caregiverId,
        session:     session as unknown as Record<string, unknown>,
      });
      if (zepThreadId && quickReply) {
        addAssistantMessageToZep({ threadId: zepThreadId, content: quickReply }).catch(console.error);
      }
      return;
    }

    const qaReply = await runQaAgent({
      text,
      phone,
      chatId,
      userId:      session.userId   ?? "",
      seniorId:    session.seniorId ?? session.userId ?? "",
      userType:    session.userType ?? "client",
      caregiverId: session.caregiverId,
      zepThreadId,
      session:     session as unknown as Record<string, unknown>,
      intent,
    });

    if (zepThreadId && qaReply) {
      addAssistantMessageToZep({
        threadId: zepThreadId,
        content:  qaReply,
      }).catch(console.error);
    }

    // Extract persistent facts from the user's message and store them (fire-and-forget).
    // Only for client messages — caregiver messages don't carry care-situation facts.
    if (session.userType !== "caregiver" && session.userId) {
      const { extractAndStoreFacts } = await import("../memory/learnedFacts");
      extractAndStoreFacts(
        session.userId as string,
        text,
        (session as any).zepThreadId ? getZepUserId(phone) : undefined
      ).catch(() => {});
    }
}
