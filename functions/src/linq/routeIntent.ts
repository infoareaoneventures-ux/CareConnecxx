import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { readFlag } from "../utils/sessionState";
import { classifyIntentDetailed, isCaregiverSearchMisroutedAsProviderSearch } from "../agents/intentClassifier";
import { canonicalApptFields } from "../utils/appointmentDoc";
import { BILLING_AUTHORITY_VERSION } from "../billing/createValidatedShiftHours";

/** Shape guard for pendingCancelConfirm — must carry a usable appointmentId. */
const hasAppointmentId = (v: unknown): boolean =>
  !!v && typeof v === "object" && typeof (v as { appointmentId?: unknown }).appointmentId === "string";
import { buildHelpSmsReply, type DiscoveryRole } from "../agents/capabilityDiscovery";
import { buildOperationalRecipeLead, loadCaraOperationalContext } from "../agents/operationalContext";
import { staleConfirmFlags, hasActiveSmsFlow, PENDING_MATCHES_TTL_MS } from "../utils/sessionState";
import { getLatestPending } from "../agents/pendingActions";
import { isBareDateOrTimeAnswer, isBareYesNoAnswer } from "../utils/bareDateTimeAnswer";
import { runQaAgent, runQuickReply, isTrivialQuickReply } from "../agents/qaAgent";
import { intentToShadowFlow, shadowTap } from "../agents/routingShadowTap";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
import { updatePermissionFromText, getPermissions } from "../agents/permissionsConversation";
import { executeBookings, createBookingTask } from "../agents/bookingExecutor";
import { resolveCaregiverRate as resolveCaregiverRateShared, coerceHourlyRate } from "../utils/caregiverRate";
import { startJobPostingFlow } from "../agents/jobPostingFlow";
import { handleRefundRequest } from "../agents/refundHandler";
import { handleTimesheetApproval } from "../agents/timesheetHandler";
import { handleEarningsView } from "../agents/earningsHandler";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";
import { handleCaregiverSwapRequest } from "../agents/caregiverSwapHandler";
import { handleClientSwapRequest } from "../agents/clientSwapRequestHandler";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate, profileFieldFromIntent, ProfileUpdateField } from "../agents/caregiverProfileHandler";
import { generateCaraMessage } from "../utils/caraMessage";
import { businessTodayStr, formatDateForDisplay, formatHHMMForDisplay } from "../utils/scheduledTime";
import { handleJobResponse } from "../triggers/jobNotifications";
import {
  searchZepMemory,
  getZepUserId,
} from "../memory/zepClient";
import { quickComplete } from "../utils/openaiClient";
import { handleRecurringConfirm } from "./inboundHelpers";
import { buildNonMedicalDeflection } from "../agents/medicalBoundary";

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
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The family asked about their recurring schedule, but there isn't an active one on file. Gently let them know, and offer to check their upcoming visits instead.",
      fallback: "I don't see an active recurring schedule. Want me to check upcoming visits instead?",
      maxTokens: 70,
    }));
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
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The family asked about their recurring schedule, but there isn't an active one on file. Gently let them know, and offer to check their upcoming visits instead.",
      fallback: "I don't see an active recurring schedule. Want me to check upcoming visits instead?",
      maxTokens: 70,
    }));
    return;
  }

  // Business-timezone today — UTC ("PT tomorrow" in the evening) left
  // tomorrow's visit confirmed when cancelling a recurring schedule at night.
  const today = businessTodayStr();

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
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The family asked to resume a paused recurring schedule, but there isn't a paused one on file. Gently let them know, and offer to check their upcoming visits instead.",
      fallback: "I don't see a paused schedule. Want me to check upcoming visits instead?",
      maxTokens: 70,
    }));
    return;
  }
  const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
  if (!schedSnap.exists || schedSnap.data()?.status !== "paused") {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The family asked to resume their recurring schedule, but it isn't actually paused right now. Gently let them know it's already active.",
      fallback: "That schedule isn't currently paused.",
      maxTokens: 60,
    }));
    return;
  }
  const sched = schedSnap.data()!;
  const today = businessTodayStr();
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
      seniorName:          sched.seniorName || null,
      ...(sched.recipientKey ? { recipientKey: sched.recipientKey } : {}),
      date,
      startTime:           sched.startTime,
      endTime:             sched.endTime,
      durationHours:       sched.durationHours,
      hourlyRate:          sched.hourlyRate,
      ...canonicalApptFields({ startTime: sched.startTime as string, durationHours: sched.durationHours as number | undefined, hourlyRate: sched.hourlyRate as number | undefined }),
      status:              "confirmed",
      billingAuthority:    BILLING_AUTHORITY_VERSION,
      recurringScheduleId: scheduleId,
      humanApproved:       true,
      createdByAgent:      true,
      createdAt:           now,
    });
  }
  await batch.commit();

  const schedDesc = `${(sched.days as string[]).join("/")}s ${formatHHMMForDisplay(sched.startTime as string)}–${formatHHMMForDisplay(sched.endTime as string)}`;
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
  /**
   * The Linq webhook wrapper's deduplicated event key (event_id / message_id /
   * synthetic hash) — the stable source-turn key for completed-turn memory
   * persistence (memory-grounding plan U3, R9). Optional: agent/test callers
   * without one get no idempotency promise (typed `missing_source_key`).
   */
  eventId?: string;
}

async function handleAddFamilyMemberIntent(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession
): Promise<void> {
  if ((session as any).isSecondaryMember) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "This person is a secondary member of the care group and asked to add someone new. Warmly explain you're happy to help with updates here, but only the primary account holder can add people to the care group.",
      fallback: "I can help with updates here, but only the primary account holder can add people to this care group.",
      maxTokens: 70,
    }));
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
    // Static, side-effect-free reply listing what Evia can do for this role.
    // Reached only via the exact-string command bypass in classifyIntentDetailed.
    if (intent === "HELP") {
      const role: DiscoveryRole = session.userType === "caregiver"
        ? "caregiver"
        : (session as any).isSecondaryMember
          ? "family-secondary"
          : "client";
      const ops = await loadCaraOperationalContext({
        phone,
        userId: session.userId,
        caregiverId: session.caregiverId,
      }).catch(() => null);
      await sendMessage(chatId, buildHelpSmsReply(
        role,
        ops ? buildOperationalRecipeLead(ops, role) : undefined,
      ));
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
    // pendingCancelConfirm / awaitingRecurringConfirmation are checked in a
    // fixed order by the YES/NO branches below, so a stale flag
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
      // Cancel confirm is time-sensitive — check before recurring to avoid stale flag collision
      const cancelConfirm303 = readFlag<{ appointmentId: string }>(session, "pendingCancelConfirm", hasAppointmentId);
      if (cancelConfirm303) {
        const { appointmentId } = cancelConfirm303;
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
              context: `The family has cancelled the visit on ${formatDateForDisplay(appt.date)}. Notify the caregiver and apologize for the inconvenience. Refer to it only as 'the visit on ${formatDateForDisplay(appt.date)}' — do not name the client unless given.`,
              fallback: `The family has cancelled the visit on ${formatDateForDisplay(appt.date)}. Sorry for the inconvenience.`,
              maxTokens: 80,
            });
            await sendMessage(cgSess.chatId, cancelNotifMsgA);
          }
        }
        await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
        const cancelConfirmMsgA = await generateCaraMessage({
          audience: "family",
          context: "Visit has been cancelled. Evia is confirming and offering to find a replacement for that day.",
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
          await db.collection("admin_alerts").add({
            type: "route_intent_fallback", handler: "booking_confirm_nl", phone,
            error: String(err).slice(0, 300), severity: "medium",
            createdAt: new Date().toISOString(), resolved: false,
          }).catch(() => {});
          await sendMessage(chatId, await generateCaraMessage({
            audience: "family",
            language: session.preferredLanguage === "es" ? "es" : "en",
            context: "That booking didn't lock in. Tell the family plainly, and say you're pulling up other openings for that same visit right now and will text as soon as you have one. Sound human and calm, not like an error message.",
            fallback: "That booking didn't go through on my end. I'm pulling up other openings for that visit right now and I'll text you as soon as I have one.",
            maxTokens: 80,
          }));
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc } = await import("../agents/matchingAgent");
          await rmfc(phone, chatId, sd, sd).catch(() => {});
        }
        return;
      }
    }

    // ── BOOKING_DECLINE — natural language NO ("never mind", "don't book", etc.) ──
    if (intent === "BOOKING_DECLINE") {
      // Cancel confirm is time-sensitive — check before recurring to avoid stale flag collision
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

    // ── HIRE_CAREGIVER — "let's go with Maria", "hire James", "I want to
    // book Sarah" ────────────────────────────────────────────────────────
    // 2026-09-13 live-testing find: this used to reply "Who would you like
    // to hire?" UNCONDITIONALLY, even when the family's own message already
    // named the caregiver (the classifier's own prompt example for this
    // intent IS "I want to book Sarah") — the name was thrown away and the
    // conversation dead-ended right here every time, never reaching
    // request_booking in that turn. Mirrors the FIND_CAREGIVER fix pattern
    // (2026-09-09/13, same file, below): only ask the generic question when
    // there's genuinely no caregiver context to resolve a name against;
    // otherwise fall through to runQaAgent, which already has the context
    // injection (pendingMatches/shownCaregiverIds) to resolve "her"/a named
    // caregiver and take the real next step (schedule_interview or
    // request_booking) itself.
    if (intent === "HIRE_CAREGIVER") {
      const sessionSnapHire      = await db.collection("agent_sessions").doc(phone).get();
      const sessionDataHire      = sessionSnapHire.data() ?? {};
      const pendingMatchesHire   = sessionDataHire.pendingMatches as Array<unknown> | undefined;
      const pendingMatchesSetAt  = sessionDataHire.pendingMatchesSetAt as string | undefined;
      const pendingMatchesFresh  = !!pendingMatchesHire && pendingMatchesHire.length > 0 &&
        (!pendingMatchesSetAt || pendingMatchesSetAt > new Date(Date.now() - PENDING_MATCHES_TTL_MS).toISOString());
      const shownCaregiverIdsHire  = sessionDataHire.shownCaregiverIds as Array<string> | undefined;
      const hasShownCaregiversHire = !!shownCaregiverIdsHire && shownCaregiverIdsHire.length > 0;
      if (!pendingMatchesFresh && !hasShownCaregiversHire) {
        await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
        return;
      }
      // Fresh pendingMatches, or a caregiver already shown this session —
      // fall through to normal routing / runQaAgent below.
    }

    // ── CAREGIVER_DECLINE_JOB — natural language job decline from caregiver ──
    if (intent === "CAREGIVER_DECLINE_JOB" && session.userType === "caregiver") {
      if ((session as any).pendingJobId) {
        await handleJobResponse(phone, "NO", chatId, session as any);
      } else {
        const noJobMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver responded to a job offer but there was no pending job in session. Evia acknowledges and lets them know it will reach out when something comes up.",
          fallback: "No worries — I'll reach out when something comes up.",
          maxTokens: 60,
        });
        await sendMessage(chatId, noJobMsg);
      }
      return;
    }

    // ── YES — booking, recurring setup, or interview confirmation ───────────────
    if (norm === "YES" || norm === "Y") {
      // Cancel confirm is time-sensitive — check before recurring to avoid stale flag collision
      const cancelConfirm470 = readFlag<{ appointmentId: string }>(session, "pendingCancelConfirm", hasAppointmentId);
      if (cancelConfirm470) {
        const { appointmentId } = cancelConfirm470;
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
              context: `The family has cancelled the visit on ${formatDateForDisplay(appt.date)}. Notify the caregiver and apologize for the inconvenience. Refer to it only as 'the visit on ${formatDateForDisplay(appt.date)}' — do not name the client unless given.`,
              fallback: `The family has cancelled the visit on ${formatDateForDisplay(appt.date)}. Sorry for the inconvenience.`,
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
          context: "Visit has been cancelled. Evia is confirming and offering to find a replacement for that day.",
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
          await db.collection("admin_alerts").add({
            type: "route_intent_fallback", handler: "booking_confirm_yes", phone,
            error: String(err).slice(0, 300), severity: "medium",
            createdAt: new Date().toISOString(), resolved: false,
          }).catch(() => {});
          await sendMessage(chatId, await generateCaraMessage({
            audience: "family",
            language: session.preferredLanguage === "es" ? "es" : "en",
            context: "That booking didn't lock in. Tell the family plainly, and say you're pulling up other openings for that same visit right now and will text as soon as you have one. Sound human and calm, not like an error message.",
            fallback: "That booking didn't go through on my end. I'm pulling up other openings for that visit right now and I'll text you as soon as I have one.",
            maxTokens: 80,
          }));
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc4 } = await import("../agents/matchingAgent");
          await rmfc4(phone, chatId, sd, sd).catch(() => {});
        }
        return;
      }
    }

    // ── NO — recurring setup declined, booking declined, or interview time rejected ──
    if (norm === "NO" || norm === "N") {
      // Cancel confirm is time-sensitive — check before recurring to avoid stale flag collision
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

    // ── HIRE — post-interview decision ────────────────────────────────────────
    // 2026-09-09: this used to resolve a pendingInterviewOutcome flag (set only
    // by interviewAgent.ts's now-removed sendPostInterviewFollowUp) into a
    // hireMode handoff. Nothing sets that flag anymore since schedule_interview/
    // video_interviews became the only interview path (2026-09-07) — the fit
    // decision after a live interview now goes through submit_interview_feedback
    // (mcp/server.ts) instead. The fallback below is what always ran regardless.
    if (norm === "HIRE") {
      await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
      return;
    }

    // ── Caregiver selection (numbers after match presentation) ────────────────
    // 2026-09-07 (Hamse decision): a bare-number/name reply picking a caregiver
    // off the match list used to short-circuit here into handleInterviewSelection
    // (interviewAgent.ts) — a whole separate flow where EVIA asks the CAREGIVER
    // for their availability first, then confirms a mutual time with the family,
    // writing video_interviews directly instead of through the shared
    // requestVideoInterview() the website's own "Request Interview" modal uses.
    // That flow has NO website equivalent at all (the site always collects a
    // specific date/time from the client upfront) and was never brought under
    // the same eligibility/rate-limit protections requestVideoInterview() has.
    // Removed the interception entirely: qaAgent.ts already has purpose-built
    // handling for exactly this reply (see its "CAREGIVERS YOU JUST SHOWED THIS
    // FAMILY" context block) — it resolves a number/name/pronoun against
    // pendingMatches and calls schedule_interview (requestVideoInterview,
    // matching the site) after asking for a date/time if needed. A number reply
    // now simply falls through to normal routing/runQaAgent like a name reply
    // already did, so both go through the one flow that matches the site.
    // 2026-09-09: interviewAgent.ts (handleInterviewSelection and the rest of
    // the interview_requests-based negotiation flow it belonged to) has since
    // been deleted outright — the collection is retired, this was its only
    // remaining code path, and there was nothing left in flight to preserve.
    const stalePendingMatches = (session as any).pendingMatches as Array<unknown> | undefined;
    if (stalePendingMatches && stalePendingMatches.length > 0) {
      const setAt = (session as any).pendingMatchesSetAt as string | undefined;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const isFresh = !setAt || setAt > twoHoursAgo;

      // ── Mid-match refilter ─────────────────────────────────────────────
      // "show me cheaper ones", "any with dementia experience", "anyone Saturday?"
      // — detect criterion changes and re-run matching with the new filters.
      if (isFresh) {
        const { detectMatchRefilter } = await import("../utils/matchRefilterDetector");
        // Load Evia's last message so the detector can tell a search-criteria
        // change ("show me cheaper ones") apart from the family simply ANSWERING
        // a question Evia just asked (e.g. "What date/time works best?" → "Today
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
      // search (REBOOK_REQUEST, POST_JOB) or the list is stale, clear the
      // lingering state so it doesn't keep hijacking unrelated messages.
      // 2026-09-09 live incident: FIND_CAREGIVER used to be in this list too.
      // A fresh reoffer ("want me to send their profiles again, or keep
      // looking?") got its own answer ("Can you send me their profiles")
      // misclassified back into FIND_CAREGIVER, which cleared pendingMatches
      // right here and then re-ran the deterministic search below — repeating
      // the identical canned question instead of ever reaching the agent
      // (which has resend_caregiver_profile and could see what was just
      // shown). Removed: the FIND_CAREGIVER branch below now makes its own
      // freshness-aware decision instead of relying on this clearing early.
      const isFreshSearchIntent = intent === "REBOOK_REQUEST" || intent === "POST_JOB";
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
      const handled = await updatePermissionFromText(userId, userType, phone, chatId, text);
      if (handled) return;
      // Classifier/parser failures fall through to the QA agent so the user
      // still gets a response instead of a silent terminal turn.
    }

    if (intent === "MEMORY_QUERY") {
      const zepUserId = getZepUserId(phone);
      const memUserId = session.userId ?? session.caregiverId ?? phone;
      // U4a (KTD9): the app userId keys reader-level reconciliation suppression
      // inside searchZepMemory — a mid-reconciliation Zep edge never reaches
      // the memory-query answer.
      const zepFacts  = await searchZepMemory(zepUserId, text, memUserId).catch(() => "");
      const { handleMemoryQuery } = await import("../memory/memoryFiles");
      // 2026-07-22 incident: pass the role so caregiver recall answers ground
      // on live account facts with caregiver framing, and RECORD the full turn
      // pair — this path used to skip the user turn entirely, so the next turn
      // had amnesia about it. Send skips the transport recorder and the pair
      // is saved once here (same record-exactly-once pattern as runQuickReply).
      const reply = await handleMemoryQuery(
        memUserId,
        chatId,
        (id, msg) => sendMessage(id, msg, { skipHistoryRecord: true }),
        text,
        zepFacts || undefined,
        { userType: session.userType, caregiverId: session.caregiverId ?? undefined },
      );
      if (reply) {
        const { recordSideChannelTurn } = await import("../agents/qaAgent");
        await recordSideChannelTurn(phone, text, reply);
      }
      return;
    }

    if (intent === "ADD_FAMILY_MEMBER") {
      await handleAddFamilyMemberIntent(phone, chatId, text, session);
      return;


      // Both pieces are now in hand — clear the partial-capture state.
    }

    if (intent === "REMOVE_FAMILY_MEMBER") {
      if ((session as any).isSecondaryMember) {
        await sendMessage(chatId, await generateCaraMessage({
          audience: "family",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "This person is a secondary member of the care group and asked to remove someone. Warmly explain you're happy to help with updates here, but only the primary account holder can remove people from the care group.",
          fallback: "I can help with updates here, but only the primary account holder can remove people from this care group.",
          maxTokens: 70,
        }));
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
          await db.collection("admin_alerts").add({
            type: "route_intent_fallback", handler: "hire_mode_auto_book", phone,
            error: String(err).slice(0, 300), severity: "medium",
            createdAt: new Date().toISOString(), resolved: false,
          }).catch(() => {});
          await sendMessage(chatId, await generateCaraMessage({
            audience: "family",
            language: session.preferredLanguage === "es" ? "es" : "en",
            context: `Booking ${hire.caregiverName} for that schedule didn't lock in. Tell the family plainly, and say you're checking ${hire.caregiverName}'s other openings (or a similar caregiver) right now and will text as soon as you have one. Sound human and calm, not like an error message.`,
            fallback: `Booking ${hire.caregiverName} for that schedule didn't go through on my end. I'm checking other openings right now and I'll text you as soon as I have one.`,
            maxTokens: 80,
          }));
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc2 } = await import("../agents/matchingAgent");
          await rmfc2(phone, chatId, sd, sd).catch(() => {});
        }
      } else {
        const totalCost = (appointments.length * schedule.durationHours * hourlyRate).toFixed(2);
        const lines = appointments.map(a => `${formatDateForDisplay(a.date)} · ${formatHHMMForDisplay(a.startTime)}–${formatHHMMForDisplay(a.endTime)}`).join("\n");
        await sendMessage(chatId,
          `Here's your booking summary:\n\n${lines}\n${hire.caregiverName} · $${totalCost} total\n\nReply YES to confirm or NO to cancel.`
        );
      }
      return;
    }

    // ── hireMode step A — date reply ──────────────────────────────────────────
    if ((session as any).hireMode && !(session as any).hireModeDate) {
      const parsedDateRaw = await quickComplete(
        `Today is ${businessTodayStr()}. ` +
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
        `Got it — starting ${formatDateForDisplay(dateStr)}.\n\nHow many days a week and what hours? (e.g. "3 days, Mon/Wed/Fri, 9am–1pm")`
      );
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
        // 2026-09-09 (live-caught): this used to hardcode "no visits to
        // cancel" and end the turn unconditionally — including right after
        // Evia herself had just told the family about a pending INTERVIEW
        // waiting on the caregiver, so "cancel it" / "cancel that interview"
        // got a context-blind dead-end instead of ever reaching
        // cancel_interview. No confirmed appointment to cancel doesn't mean
        // there's nothing to cancel — hand off to the full agent, which has
        // the real conversation context and both cancellation tools, instead
        // of assuming "cancel" can only ever mean a visit.
        const qaReply = await runQaAgent({
          text, phone, chatId,
          userId:      session.userId   ?? "",
          seniorId:    session.seniorId ?? session.userId ?? "",
          userType:    session.userType ?? "client",
          caregiverId: session.caregiverId,
          zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
          session:     session as unknown as Record<string, unknown>,
          intent,
          ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
        });
        await persistDefaultQaTurn(ctx, qaReply ?? "");
        return;
      }
      const appt = upcoming.docs[0].data();
      await db.collection("agent_sessions").doc(phone).update({
        pendingCancelConfirm: { appointmentId: upcoming.docs[0].id },
        pendingCancelConfirmSetAt: new Date().toISOString(),
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId,
        `Cancel ${appt.caregiverName}'s visit on ${formatDateForDisplay(appt.date)} (${formatHHMMForDisplay(appt.startTime)}–${formatHHMMForDisplay(appt.endTime)})?\n\nReply YES to confirm or NO to keep it.`
      );
      return;
    }

    // ── Pending rebook — waiting for client to supply a date ─────────────────
    if ((session as any).pendingRebook) {
      const rebook = (session as any).pendingRebook as {
        caregiverId: string; caregiverName: string;
        startTime: string; endTime: string; durationHours: number;
        hourlyRate?: number;
      };
      const parsedDateRaw = await quickComplete(
        `Today is ${businessTodayStr()}. ` +
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
      // 2026-09-13: this used to hardcode hourlyRate: 20 regardless of the
      // caregiver's actual rate — a fabricated rate here becomes a
      // fabricated charge the caregiver is asked to accept. A rebook is
      // "same arrangement, new date" (matches the website's own `?rebook=`
      // flow, which reuses the prior booking doc's own rate) — so the rate
      // of THAT arrangement (carried onto pendingRebook above) takes
      // precedence; caregivers.hourlyRate (browsing/display data, confirmed
      // never used by the site as a booking default) is only a last-resort
      // fallback for an old arrangement that somehow never recorded a rate,
      // and refusing (never guessing) is the final fallback either way.
      let effectiveHourlyRate = rebook.hourlyRate;
      if (effectiveHourlyRate === undefined) {
        const rebookRate = await resolveCaregiverRateShared(rebook.caregiverId);
        if (!rebookRate.ok) {
          // rebookRate.message is written as an agent-facing tool-error
          // instruction, not customer copy — never text that verbatim.
          await sendMessage(chatId,
            `I wasn't able to confirm ${rebook.caregiverName}'s current rate, so I couldn't rebook this yet — ` +
            `I'll get that sorted and follow up.`);
          await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
          return;
        }
        effectiveHourlyRate = rebookRate.hourlyRate;
      }
      const taskId   = await createBookingTask({
        clientPhone:   phone,
        clientId,
        caregiverId:   rebook.caregiverId,
        caregiverName: rebook.caregiverName,
        appointments:  [{ date: dateStr, startTime: rebook.startTime, endTime: rebook.endTime, durationHours: rebook.durationHours }],
        hourlyRate:    effectiveHourlyRate,
      });
      await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
      const perms = await getPermissions(session.userId ?? phone).catch(() => null);
      if (perms?.canBookAutomatically) {
        try {
          await executeBookings(taskId, phone);
        } catch (err) {
          console.error("executeBookings failed (rebook):", err);
          await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
          await db.collection("admin_alerts").add({
            type: "route_intent_fallback", handler: "rebook_auto_book", phone,
            error: String(err).slice(0, 300), severity: "medium",
            createdAt: new Date().toISOString(), resolved: false,
          }).catch(() => {});
          await sendMessage(chatId, await generateCaraMessage({
            audience: "family",
            language: session.preferredLanguage === "es" ? "es" : "en",
            context: `Rebooking ${rebook.caregiverName} for ${dateStr} didn't lock in. Tell the family plainly, and say you're checking other openings for that visit right now and will text as soon as you have one. Sound human and calm, not like an error message.`,
            fallback: `Rebooking ${rebook.caregiverName} for that date didn't go through on my end. I'm checking other openings right now and I'll text you as soon as I have one.`,
            maxTokens: 80,
          }));
          const sd = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
          const { runMatchingForClient: rmfc3 } = await import("../agents/matchingAgent");
          await rmfc3(phone, chatId, sd, sd).catch(() => {});
        }
      } else {
        // 2026-09-13: this also hardcoded * 20 — the same bug as the
        // createBookingTask call above, just in the summary text shown when
        // auto-booking isn't permitted. Must use the same resolved rate.
        const cost = (rebook.durationHours * effectiveHourlyRate).toFixed(2);
        await sendMessage(chatId,
          `Here's your booking summary:\n\n` +
          `${formatDateForDisplay(dateStr)} · ${formatHHMMForDisplay(rebook.startTime)}–${formatHHMMForDisplay(rebook.endTime)}\n` +
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
        await sendMessage(chatId, await generateCaraMessage({
          audience: "family",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "The family asked to rebook a past caregiver, but there are no past bookings to rebook from. Gently let them know, and offer to search for a caregiver.",
          fallback: "I don't have any past bookings to rebook from. Want me to search for a caregiver? Just let me know!",
          maxTokens: 70,
        }));
        return;
      }

      const last          = lastApptSnap.docs[0].data();
      const caregiverId   = last.caregiverId   as string;
      const caregiverName = last.caregiverName as string;
      const startTime     = last.startTime     as string;
      const endTime       = last.endTime       as string;
      const durationHours = (last.durationHours ?? 4) as number;
      // The rate of THIS arrangement — matches the website's own rebook flow
      // (PostsPage.tsx's `?rebook=` entry reuses `prevBookingData.rate` from
      // the prior booking doc, never the caregiver's browsing-listed rate).
      // A rebook is "same arrangement, new date," so its rate is whatever
      // was actually agreed for this arrangement, not a fresh lookup.
      const priorHourlyRate = coerceHourlyRate(last.hourlyRate);

      await db.collection("agent_sessions").doc(phone).update({
        pendingRebook: {
          caregiverId, caregiverName, startTime, endTime, durationHours,
          ...(priorHourlyRate !== null ? { hourlyRate: priorHourlyRate } : {}),
        },
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId,
        `Got it — same schedule with ${caregiverName} (${startTime}–${endTime})?\n\n` +
        `What date should the visit be?`
      );
      return;
    }

    // Personal reminders (SCHEDULE_REQUEST/TRIGGER_MANAGEMENT) were removed
    // 2026-09-05 — no site equivalent. Both intents now fall through to the
    // default QA agent below, same as any other unhandled intent.

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
        context: "Caregiver wants to reschedule a visit. Evia is asking them to suggest 2–3 times that work and will relay them to the family.",
        fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
        maxTokens: 80,
      });
      await sendMessage(chatId, rescheduleNlMsg);
      return;
    }

    // ── RESCHEDULE_REQUEST — move an existing appointment to a new date/time ──
    if (intent === "RESCHEDULE_REQUEST" && session.userType !== "caregiver") {
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
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
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
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
        phone,
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
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
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
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
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
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
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
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    // ── Credential management — "what logins do you have", "remove my CVS login" ─
    if (intent === "CREDENTIAL_MANAGEMENT" && session.userType !== "caregiver") {
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
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
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    // ── Find caregiver — post-onboarding matching request ────────────────────
    // isCaregiverSearchMisroutedAsProviderSearch is the safety net for when
    // the classifier mistakes a caregiver search for a medical-provider
    // search (see its own doc comment) — a live family hit exactly this.
    if (
      (intent === "FIND_CAREGIVER" || isCaregiverSearchMisroutedAsProviderSearch(intent, text)) &&
      session.userType !== "caregiver"
    ) {
      const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
      const sessionData  = sessionSnap2.data() ?? {};
      // 2026-09-09 live incident: a fresh re-offer ("want me to send their
      // profiles again, or keep looking?") got its own answer ("Can you send
      // me their profiles") misclassified back into FIND_CAREGIVER, which
      // blindly re-ran this deterministic search and repeated the identical
      // canned question — the agent (which has resend_caregiver_profile and
      // can see exactly who was just shown, via pendingMatches) never got a
      // turn. When pendingMatches is still fresh, defer to the agent instead
      // of guessing from the intent label alone — it has both tools
      // available and can decide whether to resend or search again.
      const pendingMatches      = sessionData.pendingMatches as Array<unknown> | undefined;
      const pendingMatchesSetAt = sessionData.pendingMatchesSetAt as string | undefined;
      const pendingMatchesFresh = !!pendingMatches && pendingMatches.length > 0 &&
        (!pendingMatchesSetAt || pendingMatchesSetAt > new Date(Date.now() - PENDING_MATCHES_TTL_MS).toISOString());
      // 2026-09-13 live incident: "can you setup interview with Basra Yousuf"
      // (a caregiver just shown via find_nearby_caregivers, which only writes
      // shownCaregiverIds — never pendingMatches) classified as FIND_CAREGIVER
      // and sailed past pendingMatchesFresh, restarting a brand-new matching/
      // intake flow ("how often would the help be needed...") instead of
      // letting the agent recognize the named caregiver it already knows
      // about and call schedule_interview. shownCaregiverIds has no freshness
      // timestamp (it only ever grows via arrayUnion), so treat any caregiver
      // already shown this session the same as fresh pendingMatches — the
      // agent still has find_nearby_caregivers itself and can kick off a real
      // new search when that's actually what's being asked for; it just
      // shouldn't be pre-empted by this deterministic shortcut once there's
      // already caregiver context in play.
      const shownCaregiverIds  = sessionData.shownCaregiverIds as Array<string> | undefined;
      const hasShownCaregivers = !!shownCaregiverIds && shownCaregiverIds.length > 0;
      if (!pendingMatchesFresh && !hasShownCaregivers) {
        const { runMatchingForClient } = await import("../agents/matchingAgent");
        await runMatchingForClient(phone, chatId, sessionData, sessionData);
        return;
      }
      // Fresh pendingMatches, or a caregiver already shown this session —
      // fall through to normal routing / runQaAgent below.
    }

    // ── Healthcare intents — provider search, appointment booking, Rx ────────
    // Real-world healthcare/browser-automation actions were removed 2026-09-05
    // (client-tool capability audit: the site has zero medical-appointment/
    // pharmacy feature of any kind). Always deflect — never route to a
    // healthcare-action flow.
    // 2026-09-09 (live-caught): classifyIntentDetailed sees only the raw text,
    // no conversation history, so "Can you schedule interview with Basra
    // Yousuf" was misclassified as BOOK_DOCTOR_APPOINTMENT — its own few-shot
    // examples ("book an appointment with Dr. Smith", "schedule a checkup for
    // mom") superficially match schedule/book + a person's name. The word
    // "interview" is never used for a real medical appointment, so its
    // presence rules out this deflection regardless of what the classifier said.
    if (
      (intent === "FIND_NEARBY_PROVIDER" ||
       intent === "BOOK_DOCTOR_APPOINTMENT" ||
       intent === "PRESCRIPTION_REFILL" ||
       intent === "NEW_PRESCRIPTION") &&
      session.userType !== "caregiver" &&
      !/\binterview/i.test(text)
    ) {
      await sendMessage(chatId, buildNonMedicalDeflection(intent, text));
      return;
    }

    // ── Fact correction — user is correcting or retracting a known fact ──────
    // U4a (R11/R12/R15, KTD9/KTD10): typed detection over the bounded active-
    // fact candidate reader + transactional cross-store staging. A staged,
    // ambiguous, or unmatched request gets its deterministic acknowledgement
    // copy and ENDS the turn — pending forget never claims completion,
    // ambiguity asks one clarifying question and changes nothing, and no-match
    // is an honest "cannot identify that memory". The deterministic turn is
    // deliberately not persisted as a completed turn, so it is never passively
    // extracted (R23). not_correction/failed fall through to the QA agent.
    // 2026-09-05: classifyIntentDetailed sees ONLY the raw text, no conversation
    // history, so a mid-flow pushback ("you don't know their availability at
    // all") can read exactly like a fact correction out of context and misfire
    // into the honest-but-nonsensical "cannot identify that memory" copy —
    // live-caught mid a caregiver-interview flow. Same guard as the trivial
    // quick-reply bypass below: any turn inside an active guarded flow defers
    // to the full grounded agent instead, which has the actual conversation
    // context to answer correctly (and can still stage a real fact correction
    // itself via its own tools).
    // 2026-09-09: that guard only covers SCRIPTED flows (a tracked session
    // flag) — it doesn't cover a free-form agent-loop conversation like
    // schedule_interview's "what date/time?" ask, which sets no flag at all.
    // Live-caught there: bare "9/11", "9/12", "12pm" answers misfired into
    // FACT_CORRECTION, once even claiming a (nonexistent) correction was
    // staged. A message that is ENTIRELY just a date or time cannot carry a
    // real correction's explanatory language, so skip this branch for that
    // narrow shape regardless of hasActiveSmsFlow.
    // 2026-09-12: same misfire, a THIRD shape — the family corrected which
    // caregiver a PENDING confirmation (e.g. schedule_interview's "confirm
    // Imran?") referred to ("no i said basra"). handlePendingApprovals
    // (webhooks.ts) already judged this reply too complex to be a clean
    // YES/NO and fell through here so the full agent could use the pending
    // action's context to fix the mistake — but FACT_CORRECTION intercepted
    // first and tried to stage "basra" as a corrected MEMORY FACT about the
    // care situation, producing the nonsensical "I've updated that" ack
    // instead of ever touching the still-awaiting pending action. A reply
    // while a confirmation is awaiting is a correction to THAT action, never
    // a stored fact — skip this branch whenever one exists.
    const pendingDuringFactCheck = intent === "FACT_CORRECTION"
      ? await getLatestPending(phone).catch(() => null)
      : null;
    if (
      intent === "FACT_CORRECTION" &&
      !pendingDuringFactCheck &&
      !hasActiveSmsFlow(session as unknown as Record<string, unknown>) &&
      !isBareDateOrTimeAnswer(text) &&
      !isBareYesNoAnswer(text)
    ) {
      const { detectAndStageFactChange, factChangeAckCopy } = await import("../memory/learnedFacts");
      const factUserId = session.userType === "caregiver"
        ? (session.caregiverId ?? session.userId ?? phone)
        : (session.userId ?? phone);
      const outcome = await detectAndStageFactChange({
        userId: factUserId,
        text,
        phone,
        // The intent classifier already judged this a correction/forget, so an
        // empty fact store yields the honest no_match copy, not silence (R15).
        assumeChangeIntent: true,
      }).catch((err) => ({
        kind: "failed" as const,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      }));

      const ack = factChangeAckCopy(outcome);
      if (ack) {
        await sendMessage(chatId, ack);
        return;
      }
      // not_correction / failed → fall through to the QA agent.
    }

    // ── Update onboarding — already-onboarded user wants to review/fix profile ─
    // PARTIAL users (no userId/seniorId) hit the onboarding offer earlier in
    // this handler and never reach here. For ONBOARDED users, flip a session
    // flag and fall through to runQaAgent — qaAgent reads the flag and runs a
    // structured profile-review sub-prompt (read current state, confirm in
    // prose, patch fields one at a time via update_care_plan). 20-minute TTL
    // prevents stale flags surviving across
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
    // Completed-session turn memory — Zep transcript, client learned-fact
    // extraction, and durable history sync — is owned by ONE boundary:
    // persistCompletedTurn → memory_operations → memoryOperationWorker
    // (memory-grounding plan 2026-07-17-002 U3, R8-R10). The old direct
    // addUserMessageToZep / addAssistantMessageToZep / extractAndStoreFacts
    // tail that lived here is superseded — do NOT re-add per-callsite writes.
    // Pre-completion onboarding Zep writes (webhooks.ts) and structured
    // business-event writes are separate paths and remain in place (R10).
    const zepThreadId = (session as any).zepThreadId as string | undefined;

    // ── Trivial quick-reply bypass — short generic greetings/thanks ─────────
    // For QUESTION-intent messages with no entity content, skip the full
    // tool-use loop and answer with gpt-4o-mini in ~1s. Conservative heuristic:
    // anything ambiguous falls through to runQaAgent below. A degraded
    // classification (classifier error → guessed QUESTION) never qualifies —
    // the full agent path with its supervisor is the fail-safe.
    //
    // Found 2026-09-04: a short in-flow reply ("yeah", "anyone else", "which
    // one", a bare first name like "Amina") classifies as QUESTION with no
    // entity content and passed isTrivialQuickReply — routing to
    // runQuickReply, which has NO tool access and answers purely from the
    // last few turns of chat history. Mid a caregiver-matching flow
    // (pendingMatches set), that produced fabricated caregiver names/details
    // never backed by any real Firestore record — a hallucinated match, not
    // a stale one. hasActiveSmsFlow (pendingMatches + every other guarded
    // state-machine flag, sessionState.ts) is the existing, already-tested
    // signal for "a multi-turn flow is in progress here" — any turn inside
    // one of those needs real grounding, so it must never take the no-tool
    // fast path regardless of how trivial the text looks in isolation.
    if (
      intent === "QUESTION" &&
      !intentDegraded &&
      isTrivialQuickReply(text) &&
      !hasActiveSmsFlow(session as unknown as Record<string, unknown>)
    ) {
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
      await persistDefaultQaTurn(ctx, quickReply ?? "");
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
      // U4: Linq turn identity for lifecycle checkpoints.
      ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
    });

    await persistDefaultQaTurn(ctx, qaReply ?? "");
}

// ── Completed-turn memory persistence (memory-grounding plan U3, R8/R9) ──────
// One call per completed default QA/quick turn. qaAgent already wrote the
// durable history pair (saveConversationTurn) and delivered the reply;
// persistCompletedTurn ADOPTS those rows, creates the reference-only turn_sync
// operation, and the one-minute memoryOperationWorker dispatches the Zep
// transcript write and (client-only) learned-fact extraction with retries.
// A persistence failure is a typed outcome + aggregate log — it must never
// throw into a turn whose tools and reply already committed (R8).
async function persistDefaultQaTurn(ctx: IntentRouteContext, assistantText: string): Promise<void> {
  // Empty reply = the agent held/skipped the turn (DND, handoff hold, empty
  // guard) — not a completed turn; the agent layer's judgment is authoritative.
  if (!assistantText?.trim()) return;
  const { phone, text, session } = ctx;
  try {
    const { persistCompletedTurn } = await import("../memory/conversationMemory");
    const outcome = await persistCompletedTurn({
      channel:       "linq",
      sourceKey:     ctx.eventId ?? "",
      phone,
      userId:        session.userId ?? "",
      userText:      text,
      assistantText,
      // R8: family-fact extraction stays CLIENT-only — the exact eligibility
      // the removed direct tail used (non-caregiver role + linked userId).
      extractFacts:  session.userType !== "caregiver" && Boolean(session.userId),
      adoptExistingRows: true,
    });
    if (!outcome.ok) {
      // R21: aggregate/enum-only log — channel + error class, no content/phone.
      console.warn(JSON.stringify({
        memory_turn_persistence_skipped: true,
        channel:     "linq",
        error_class: outcome.errorClass,
        timestamp:   new Date().toISOString(),
      }));
    }
  } catch (err) {
    // persistCompletedTurn is contractually non-throwing; belt-and-suspenders
    // so a memory failure can never fail a turn that already replied (R8).
    console.error(JSON.stringify({
      memory_turn_persistence_skipped: true,
      channel:     "linq",
      error_class: err instanceof Error ? err.constructor.name : typeof err,
      timestamp:   new Date().toISOString(),
    }));
  }
}
