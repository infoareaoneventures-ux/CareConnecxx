import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { sendMessage, startTyping, stopTyping, shareContactCard, setContactCard, checkCapability, AgentSession, LinqService } from "./client";
import { classifyIntent } from "../agents/intentClassifier";
import { runQaAgent } from "../agents/qaAgent";
import { handleTaskApproval, finalizeTaskApproval } from "../agents/taskApprovalHandler";
import { optOutPhoneNumber } from "../sms";
import {
  handleOnboardingStep,
} from "../agents/onboardingConversation";
import {
  handleClientPermissionsReply,
  handleCaregiverPermissionsReply,
  updatePermissionFromText,
  getPermissions,
} from "../agents/permissionsConversation";
import {
  handleInterviewSelection,
  handleInterviewConfirm,
  handleCaregiverAvailabilityReply,
  writeInterviewOutcomeSignal,
} from "../agents/interviewAgent";
import { executeBookings, createBookingTask } from "../agents/bookingExecutor";
import { detectCrisis, MEDICAL_RESPONSE, EMOTIONAL_RESPONSE } from "../safety/crisisDetector";
import { cancelTriggerIfUserReplied } from "../triggers/triggerEngine";
import { logCrisisDetected } from "../observability/auditLog";
import { isBereavementTrigger, activateBereavementMode } from "../agents/bereavement";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handleJobPostingStep, startJobPostingFlow } from "../agents/jobPostingFlow";
import { startModifyScheduleFlow, handleModifyScheduleStep } from "../agents/modifyScheduleFlow";
import { handleRefundRequest } from "../agents/refundHandler";
import { handleCaregiverSwapRequest, handleSwapAcceptance } from "../agents/caregiverSwapHandler";
import { handleClientSwapRequest } from "../agents/clientSwapRequestHandler";
import { STATE_MACHINE_FLAGS, clearAllStateFlags } from "../utils/sessionState";
import { sendIfNotDND } from "../utils/dndGuard";
import { writeFeedbackSignal } from "../ai/feedback";
import { handleJobResponse, handleAvailabilityConfirmation } from "../triggers/jobNotifications";
import {
  initializeZepOnFirstContact,
  addUserMessageToZep,
  addAssistantMessageToZep,
  addBusinessDataToZep,
  searchZepMemory,
  getZepUserId,
} from "../memory/zepClient";

const db = admin.firestore();

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(
  rawBody:   Buffer,
  timestamp: string,
  signature: string,
  secret:    string
): boolean {
  const secretKey = Buffer.from(secret, "base64");
  const payload   = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
  const hmac      = crypto.createHmac("sha256", secretKey).update(payload);

  const expectedB64 = hmac.digest("base64");
  const expectedHex = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");

  try {
    if (signature.length === expectedB64.length)
      return crypto.timingSafeEqual(Buffer.from(expectedB64), Buffer.from(signature));
    if (signature.length === expectedHex.length)
      return crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(signature));
    return false;
  } catch {
    return false;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function isRateLimited(phone: string): Promise<boolean> {
  const rateRef = db.collection("agent_rate").doc(phone);
  const snap    = await rateRef.get();
  const now     = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const calls   = ((snap.data()?.calls ?? []) as number[]).filter((t) => t > hourAgo);
  if (calls.length >= 10) return true;
  await rateRef.set({ calls: [...calls, now] });
  return false;
}

// ── Opt-in for existing (non-onboarding) users ────────────────────────────────

// ── Typing indicator — pre-fetch context so Claude responds faster ─────────────

async function handleTypingStarted(event: unknown): Promise<void> {
  const ev    = event as any;
  const phone  = ev.data?.sender_handle?.value as string | undefined;
  const chatId = ev.data?.chat?.id as string | undefined;
  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut || session.optedIn === false) return;

  const seniorId = session.seniorId ?? session.userId ?? "";
  const userId   = session.userId ?? "";
  const now      = new Date().toISOString();

  const [seniorSnap, journalSnap, apptSnap, historySnap] = await Promise.all([
    db.collection("senior_profiles").doc(seniorId).get(),
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .orderBy("timestamp", "desc").limit(3).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate",  ">=", now.slice(0, 10))
      .where("status",   "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc").limit(1).get(),
    db.collection("agent_conversations").doc(phone)
      .collection("messages").orderBy("timestamp", "desc").limit(10).get(),
  ]).catch(() => [null, null, null, null]);

  if (!seniorSnap) return;

  await db.collection("agent_prefetch").doc(phone).set({
    seniorProfile:       seniorSnap.exists ? seniorSnap.data() : null,
    recentJournal:       journalSnap ? journalSnap.docs.map((d) => d.data()) : [],
    nextAppointment:     apptSnap && !apptSnap.empty ? apptSnap.docs[0].data() : null,
    conversationHistory: historySnap
      ? historySnap.docs.map((d) => d.data()).reverse()
      : [],
    cachedAt:  now,
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
  });
}

// ── Caregiver keyword handlers ────────────────────────────────────────────────

async function handleArrived(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Find today's appointment for this caregiver
  const today  = new Date().toISOString().slice(0, 10);
  const caregiverId = session.caregiverId;
  if (!caregiverId) return;

  const snap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date",        "==", today)
    .where("status",      "in", ["confirmed", "pending_caregiver_confirmation"])
    .limit(1).get();

  if (snap.empty) {
    await sendMessage(chatId, "I don't see a scheduled visit for you today. Let me know if something looks wrong.");
    return;
  }

  const appt = snap.docs[0];
  const apptData = appt.data();
  const arrivedAt = new Date().toISOString();
  await appt.ref.update({ arrivedAt, status: "in-progress" });

  // Track lateness if caregiver arrived >= 15 min after scheduled start
  const scheduledStart = apptData.startTime ?? apptData.time ?? "";
  if (scheduledStart && session.caregiverId) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const schedMs  = new Date(`${todayStr}T${scheduledStart.slice(0, 5)}:00`).getTime();
    const minutesLate = Math.round((Date.now() - schedMs) / 60000);
    if (minutesLate >= 15) {
      const cgSnap  = await db.collection("caregivers").doc(session.caregiverId).get();
      const cgName  = cgSnap.data()?.name ?? "Unknown";
      const { recordLatenessEvent, checkLatenessPattern } = await import("../agents/latenessTracker");
      recordLatenessEvent({
        caregiverId:   session.caregiverId,
        caregiverName: cgName,
        appointmentId: appt.id,
        clientId:      apptData.clientId ?? "",
        date:          todayStr,
        scheduledTime: scheduledStart.slice(0, 5),
        minutesLate,
        selfReported:  false,
      }).catch(() => {});
      checkLatenessPattern(session.caregiverId, cgName).catch(() => {});
    }
  }

  // Notify family (DND-aware: high urgency — queued but priority delivery)
  const clientPhone = await getClientPhoneForAppt(apptData);
  if (clientPhone) {
    const cgName2 = session.caregiverId
      ? (await db.collection("caregivers").doc(session.caregiverId).get()).data()?.name ?? "Your caregiver"
      : "Your caregiver";
    await sendIfNotDND(clientPhone, {
      content:     `${cgName2} just arrived for ${apptData.clientName ?? "the visit"}.`,
      urgency:     "immediate",
      sourceAgent: "arrived_notification",
      canDrop:     false,
    }, "high");
  }

  await sendMessage(chatId, "Got it — I've let the family know you're there. Have a good visit.");
}

async function handleDone(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const caregiverId = session.caregiverId;
  if (!caregiverId) return;

  const today = new Date().toISOString().slice(0, 10);
  const snap  = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date",        "==", today)
    .where("status",      "==", "in-progress")
    .limit(1).get();

  if (!snap.empty) {
    await snap.docs[0].ref.update({ completedAt: new Date().toISOString() });
  }

  // Store that we're awaiting care notes
  await db.collection("agent_sessions").doc(phone).update({
    awaitingCareNotes: true,
    careNotesApptId:   snap.empty ? "" : snap.docs[0].id,
    stateExpiresAt:    new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });

  await sendMessage(chatId,
    "How did the visit go? Tell me in your own words — I'll handle the notes."
  );
}

async function handleRunningLate(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    awaitingLateMinutes: true,
    stateExpiresAt:      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  await sendMessage(chatId, "How late do you think you'll be?");
}

async function handleIssue(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    awaitingIssueDescription: true,
    stateExpiresAt:           new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  await sendMessage(chatId, "I'm sorry to hear that. Can you describe what's happening?");
}

async function getClientPhoneForAppt(appt: admin.firestore.DocumentData): Promise<string | null> {
  const clientId = appt.clientId as string;
  if (!clientId) return null;
  const snap = await db.collection("agent_sessions")
    .where("userId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  return (snap.docs[0].data() as any).phone ?? snap.docs[0].id;
}

// ── Caregiver voice/text → structured journal ─────────────────────────────────

async function handleCareNotes(
  phone:    string,
  chatId:   string,
  text:     string,
  session:  AgentSession
): Promise<void> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const structured = await claude.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system:
      "Convert this caregiver note into a structured care journal entry. " +
      'Reply in JSON: {"overallWellness":1,"mood":"happy|neutral|agitated|confused|tired",' +
      '"appetite":"good|fair|poor|refused","activities":[],"medications":[],' +
      '"observations":"","notes":""}',
    messages: [{ role: "user", content: text }],
  });

  let entry: Record<string, unknown> = {};
  try {
    entry = JSON.parse((structured.content[0] as { text: string }).text ?? "{}");
  } catch { entry = { notes: text }; }

  const apptId = (session as any).careNotesApptId ?? "";
  const caregiverId = session.caregiverId ?? "";

  // Get clientId from appointment and re-validate status
  let clientId = "";
  let seniorId = "";
  if (apptId) {
    const apptSnap = await db.collection("appointments").doc(apptId).get();
    const apptData = apptSnap.data();
    clientId = apptData?.clientId ?? "";
    seniorId = apptData?.seniorId ?? clientId;

    // Re-validate: only write notes if appointment was actually in progress or just completed
    const validStatuses = ["in-progress", "completed", "confirmed"];
    if (apptData && !validStatuses.includes(apptData.status ?? "")) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
      await sendMessage(chatId, "I wasn't able to save those notes — it looks like that visit was cancelled.");
      return;
    }

    // Dedup + write in a single transaction to prevent duplicate journal entries if
    // two requests race (e.g. duplicate webhook delivery or fast caregiver retap).
    let alreadyExists = false;
    const journalRef  = db.collection("care_journal").doc();
    const sessionRef  = db.collection("agent_sessions").doc(phone);

    await db.runTransaction(async (t) => {
      const existingSnap = await db.collection("care_journal")
        .where("appointmentId", "==", apptId)
        .limit(1)
        .get();
      if (!existingSnap.empty) {
        alreadyExists = true;
        return;
      }
      t.set(journalRef, {
        caregiverId,
        seniorId,
        appointmentId: apptId,
        timestamp:     new Date().toISOString(),
        notes:         entry.notes ?? text,
        wellness: {
          ateWell:   entry.appetite === "good",
          tookMeds:  Array.isArray(entry.medications) && (entry.medications as unknown[]).length > 0,
          wasActive: Array.isArray(entry.activities)  && (entry.activities  as unknown[]).length > 0,
          mood:      entry.mood ?? "neutral",
        },
        activities:    entry.activities ?? [],
        observations:  entry.observations ?? "",
      });
      t.update(sessionRef, { awaitingCareNotes: false, careNotesApptId: "" });
    });

    if (alreadyExists) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
      await sendMessage(chatId, "Notes for this visit are already saved.");
      return;
    }
  } else {
    // No apptId — write without dedup guard and clear flag
    await db.collection("care_journal").add({
      caregiverId,
      seniorId,
      appointmentId: apptId,
      timestamp:     new Date().toISOString(),
      notes:         entry.notes ?? text,
      wellness: {
        ateWell:   entry.appetite === "good",
        tookMeds:  Array.isArray(entry.medications) && (entry.medications as unknown[]).length > 0,
        wasActive: Array.isArray(entry.activities)  && (entry.activities  as unknown[]).length > 0,
        mood:      entry.mood ?? "neutral",
      },
      activities:    entry.activities ?? [],
      observations:  entry.observations ?? "",
    });
    await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
  }

  const cgSnap    = await db.collection("caregivers").doc(caregiverId).get();
  const hourlyRate = cgSnap.data()?.hourlyRate ?? 20;

  const apptSnap = apptId
    ? await db.collection("appointments").doc(apptId).get()
    : null;
  const durationHours = apptSnap?.data()?.durationHours ?? 4;
  const pay = (hourlyRate * durationHours).toFixed(2);

  // Fire visit billing (fire-and-forget so it doesn't block caregiver confirmation)
  if (apptId && clientId) {
    const { createVisitPayment } = await import("../billing/visitBilling");
    createVisitPayment({
      appointmentId:  apptId,
      clientId,
      clientPhone:    "", // Family phone looked up inside createVisitPayment if needed
      caregiverId,
      caregiverName:  cgSnap.data()?.name ?? "Your caregiver",
      caregiverPhone: phone,
      durationHours,
      hourlyRate,
      date:           new Date().toISOString().slice(0, 10),
    }).catch((err) => console.error("createVisitPayment error:", err));
  }

  // Find next appointment for this caregiver
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextSnap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date",        ">=", tomorrow.toISOString().slice(0, 10))
    .where("status",      "in", ["confirmed"])
    .orderBy("date", "asc").limit(1).get();

  const nextLine = nextSnap.empty
    ? "No upcoming visits scheduled yet."
    : `Next visit: ${nextSnap.docs[0].data().date} at ${nextSnap.docs[0].data().startTime ?? ""}`;

  await sendMessage(chatId,
    `Got it — notes saved.\n\n` +
    `Your payment of $${pay} will be processed tonight.\n` +
    `${nextLine}\n\n` +
    `Have a great rest of your day.`
  );
}

// ── Post-visit feedback sentiment classifier ──────────────────────────────────

async function classifyFeedbackSentiment(
  text: string
): Promise<"positive" | "negative" | "neutral"> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await claude.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "Classify this feedback about a home care visit as positive, negative, or neutral. " +
        "Consider tone, context, and nuance — not just keywords. " +
        "Reply with one word: POSITIVE, NEGATIVE, or NEUTRAL.",
      messages: [{ role: "user", content: text }],
    });
    const label = ((res.content[0] as { text: string }).text ?? "").trim().toUpperCase();
    if (label === "POSITIVE") return "positive";
    if (label === "NEGATIVE") return "negative";
  } catch (err) {
    console.error("classifyFeedbackSentiment error:", err);
  }
  return "neutral";
}

async function handleVisitFeedback(params: {
  phone:         string;
  chatId:        string;
  text:          string;
  caregiverId:   string;
  clientId:      string;
  appointmentId: string;
  triggerId:     string;
}): Promise<void> {
  const sentiment = await classifyFeedbackSentiment(params.text);
  const numericRating = sentiment === "positive" ? 5 : sentiment === "negative" ? 2 : 3;

  if (sentiment !== "neutral" && params.clientId && params.caregiverId) {
    await writeFeedbackSignal({
      clientId:      params.clientId,
      caregiverId:   params.caregiverId,
      signal:        sentiment === "positive" ? 1 : -1,
      source:        "post_visit_feedback",
      appointmentId: params.appointmentId,
      rawText:       params.text,
    }).catch((err) => console.error("writeFeedbackSignal error:", err));
  }

  // Write to post_visit_feedback collection for rating aggregation
  if (params.caregiverId && params.clientId) {
    await db.collection("post_visit_feedback").add({
      caregiverId:   params.caregiverId,
      clientId:      params.clientId,
      appointmentId: params.appointmentId,
      rating:        numericRating,
      sentiment,
      rawText:       params.text.slice(0, 500),
      status:        "submitted",
      createdAt:     new Date().toISOString(),
    }).catch(() => {});

    // Aggregate ratings back into the caregiver doc
    const { onFeedbackSubmitted } = await import("../agents/feedbackAggregator");
    onFeedbackSubmitted(params.caregiverId, numericRating, params.appointmentId, params.clientId)
      .catch((err) => console.error("onFeedbackSubmitted error:", err));
  }

  await db.collection("proactive_triggers").doc(params.triggerId)
    .update({ feedbackReceived: new Date().toISOString() })
    .catch(() => {});

  const response =
    sentiment === "positive"
      ? "Glad to hear it — I'll keep that in mind for future matches. 💙"
      : sentiment === "negative"
      ? "Thank you for letting me know. I'll take that into account and make sure future caregivers are a better fit."
      : "Got it — noted.";

  await sendViaInteractionAgent(params.phone, {
    content:     response,
    urgency:     "standard",
    sourceAgent: "feedback",
    canDrop:     false,
  });
}

// ── Recurring schedule: YES confirmation ─────────────────────────────────────

async function handleRecurringConfirm(
  phone:   string,
  chatId:  string,
  session: AgentSession
): Promise<void> {
  const pending = (session as any).pendingRecurringSchedule as {
    caregiverId:   string;
    caregiverName: string;
    days:          string[];
    startTime:     string;
    endTime:       string;
    durationHours: number;
    hourlyRate:    number;
  } | undefined;

  if (!pending) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    });
    return;
  }

  const clientId   = session.userId ?? phone;
  const seniorName = (session as any).onboardingData?.seniorName ?? (session as any).seniorName ?? "";
  const today      = new Date().toISOString().split("T")[0];
  const now        = new Date().toISOString();

  const { generateRecurringDates } = await import("../scheduled/recurringScheduler");
  const dates = generateRecurringDates(today, pending.days, 4);

  if (dates.length === 0) {
    await sendMessage(chatId, "I couldn't generate dates for that schedule — the days may not be valid. Let me know if you'd like to try again.");
    await db.collection("agent_sessions").doc(phone).update({
      awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }

  const scheduleRef = db.collection("recurring_schedules").doc();
  const batch       = db.batch();

  batch.set(scheduleRef, {
    clientId,
    caregiverId:      pending.caregiverId,
    caregiverName:    pending.caregiverName,
    clientPhone:      phone,
    seniorName,
    days:             pending.days,
    startTime:        pending.startTime,
    endTime:          pending.endTime,
    durationHours:    pending.durationHours,
    hourlyRate:       pending.hourlyRate,
    status:           "active",
    startDate:        today,
    weeksBookedAhead: 4,
    lastExtendedAt:   now,
    createdAt:        now,
  });

  for (const { date } of dates) {
    const apptRef = db.collection("appointments").doc();
    batch.set(apptRef, {
      clientId,
      caregiverId:         pending.caregiverId,
      caregiverName:       pending.caregiverName,
      date,
      startTime:           pending.startTime,
      endTime:             pending.endTime,
      durationHours:       pending.durationHours,
      hourlyRate:          pending.hourlyRate,
      status:              "confirmed",
      recurringScheduleId: scheduleRef.id,
      humanApproved:       true,
      createdByAgent:      true,
      createdAt:           now,
    });
  }

  await batch.commit();

  await db.collection("agent_sessions").doc(phone).update({
    awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
    pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
    activeRecurringScheduleId:     scheduleRef.id,
  }).catch(() => {});

  const schedDesc = `${pending.days.join("/")}s ${pending.startTime}–${pending.endTime}`;
  await sendMessage(chatId,
    `Set up! ${pending.caregiverName} is booked every ${schedDesc} for the next 4 weeks — ` +
    `and I'll keep extending it automatically.\n\n` +
    `To pause or stop anytime, just text me PAUSE SCHEDULE or CANCEL SCHEDULE.`
  );
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

// ── Main inbound handler ──────────────────────────────────────────────────────

async function handleInbound(event: unknown): Promise<void> {
  const ev      = event as any;
  const phone   = ev.data?.sender_handle?.value as string | undefined;
  const text    = (ev.data?.parts?.[0]?.value ?? "") as string;
  const chatId  = ev.data?.chat?.id as string | undefined;
  const service = (ev.data?.service ?? ev.data?.chat?.service ?? "SMS") as string;

  if (!phone || !chatId) return;

  // Fire typing indicator immediately — before any async work — so the family
  // never sees silence during the ~200ms session load + routing decisions.
  if (service === "iMessage") startTyping(chatId).catch(() => {});

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();

  // ── New user — texted first (MO consent) ────────────────────────────────────
  if (!sessionSnap.exists) {
    // Check if this phone belongs to a secondary family group member
    const groupSnap = await db.collection("agent_sessions")
      .where("groupMembers", "array-contains", phone)
      .limit(1)
      .get();

    if (!groupSnap.empty) {
      // Route as secondary family member using primary's session context
      const primarySession = groupSnap.docs[0].data() as AgentSession;
      const primaryPhone   = groupSnap.docs[0].id;

      // Create a lightweight session for this member pointing to the primary
      await db.collection("agent_sessions").doc(phone).set({
        chatId,
        phone,
        service:        "iMessage",
        userType:       "client",
        onboardingStep: "complete",
        optedIn:        true,
        optedOut:       false,
        userId:         primarySession.userId,
        seniorId:       primarySession.seniorId,
        primaryPhone,
        isSecondaryMember: true,
        createdAt:      new Date().toISOString(),
      });

      // Start Zep memory for this secondary member too — awaited so zepThreadId lands before
      // their first message is processed.
      await initializeZepOnFirstContact(phone).catch((err) =>
        console.error("Zep init failed (secondary member):", err)
      );

      await sendMessage(chatId,
        `Hi, I'm Cara — the care assistant for ${(primarySession as any).onboardingData?.seniorName ?? "your family"}. ` +
        `I've added you to the care group. You'll get the same updates and can ask me anything.`
      );
      return;
    }

    const capability = await checkCapability(phone);
    const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
    const linqPhone = process.env.LINQ_PHONE_NUMBER ?? "";

    await setContactCard({ phone_number: linqPhone, display_name: "Cara" }).catch(() => {/* non-critical */});
    await shareContactCard(chatId).catch(() => {/* non-critical */});

    await db.collection("agent_sessions").doc(phone).set({
      chatId,
      phone,
      service,
      userType:       null,
      onboardingStep: "ask_role",
      optedIn:        true,
      optedOut:       false,
      createdAt:      new Date().toISOString(),
    });

    // Start Zep memory immediately — awaited so zepThreadId is written before
    // the next message arrives (fast: ~200ms HTTP call).
    await initializeZepOnFirstContact(phone).catch((err) =>
      console.error("Zep init failed (first contact):", err)
    );

    if (service === "iMessage") await startTyping(chatId).catch(() => {});
    await sendMessage(chatId,
      `Hi — I'm Cara. I help families find and manage care for aging parents, all through text. No app needed.\n\n` +
      `Are you looking for care for someone, or are you a caregiver?\n\n` +
      `1️⃣ I need care for someone\n` +
      `2️⃣ I'm a caregiver`
    );
    return;
  }

  const session  = sessionSnap.data() as AgentSession;
  const norm     = text.trim().toUpperCase();
  const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);

  if (session.optedOut) return;

  // ── Expired state machine — save checkpoint for onboarding, clear otherwise ─
  {
    const stateExpiresAt = (session as any).stateExpiresAt as string | undefined;
    const hasStateFlag   = STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
                             .some(f => !!(session as any)[f]);
    if (hasStateFlag && stateExpiresAt && new Date(stateExpiresAt) < new Date()) {
      // If mid-onboarding, save a checkpoint so the user can resume instead of restarting
      const isOnboarding = session.onboardingStep && session.onboardingStep !== "complete";
      if (isOnboarding) {
        await db.collection("agent_sessions").doc(phone).update({
          onboardingCheckpoint: {
            step:          session.onboardingStep,
            onboardingData: (session as any).onboardingData ?? {},
            savedAt:       new Date().toISOString(),
          },
        }).catch(() => {});
      }
      await clearAllStateFlags(phone, db);
      if (isOnboarding) {
        await sendMessage(chatId,
          "Your session timed out. No worries — I saved your progress!\n\n" +
          "Reply RESUME to pick up where you left off, or START OVER to begin fresh."
        );
      } else {
        await sendMessage(chatId, "Your previous session timed out — just text me if you'd like to continue.");
      }
      return;
    }
  }

  // ── Onboarding resume from checkpoint ────────────────────────────────────────
  {
    const checkpoint = (session as any).onboardingCheckpoint as {
      step: string; onboardingData: Record<string, unknown>; savedAt: string;
    } | undefined;
    const isResumeCommand = norm === "RESUME" || norm === "CONTINUE" || norm === "PICK UP WHERE I LEFT OFF";
    const isStartOver     = norm === "START OVER" || norm === "RESTART" || norm === "BEGIN AGAIN";

    if (checkpoint && (isResumeCommand || isStartOver)) {
      await db.collection("agent_sessions").doc(phone).update({
        onboardingCheckpoint: admin.firestore.FieldValue.delete(),
      });
      if (isStartOver) {
        await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role", onboardingData: {} });
        await sendMessage(chatId,
          "Starting fresh! Are you looking for care for someone, or are you a caregiver?\n\n" +
          "1️⃣  I need care for someone\n" +
          "2️⃣  I'm a caregiver"
        );
      } else {
        // Resume: restore checkpoint data and re-ask the current step's question
        await db.collection("agent_sessions").doc(phone).update({
          onboardingStep: checkpoint.step,
          onboardingData: checkpoint.onboardingData,
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const resumedSession = { ...session, onboardingStep: checkpoint.step, onboardingData: checkpoint.onboardingData } as AgentSession;
        await sendMessage(chatId, "Picking up where we left off!");
        await handleOnboardingStep(phone, chatId, "__RESUME__", resumedSession);
      }
      return;
    }

    // If checkpoint exists but user sent a normal message (not resume/start-over),
    // nudge them to choose before processing normally
    if (checkpoint && session.onboardingStep !== "complete") {
      await sendMessage(chatId,
        "You have a saved onboarding session. Reply RESUME to continue, or START OVER to begin fresh."
      );
      return;
    }
  }

  // STOP — works at any stage (CANCEL is NOT here — it cancels a visit, not the account)
  if (stopWords.has(norm)) {
    await optOutPhoneNumber(phone);
    await sendMessage(chatId, "You've been unsubscribed from Cara messages. Reply START anytime to reactivate.");
    return;
  }

  // ── Subscription lapse — graceful degradation for clients with lapsed billing ─
  if (session.userType === "client" && session.onboardingStep === "complete") {
    const userId = session.userId ?? phone;
    const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
    const subStatus = userSnap?.data()?.subscriptionStatus as string | undefined;
    if (subStatus === "past_due" || subStatus === "canceled" || subStatus === "unpaid") {
      await sendMessage(chatId,
        "Your Cara membership needs attention — there was an issue with your payment.\n\n" +
        "To keep your care coordination active, please update your billing at cara.app/billing or reply HELP to reach our support team."
      );
      return;
    }
  }

  // ── Twin-trigger cancel — user replied, cancel any pending proactive nudges ─
  cancelTriggerIfUserReplied(session.userId ?? phone, phone).catch(() => {});

  // ── Crisis detection — checked before everything else ──────────────────────
  const crisis = detectCrisis(text);
  if (crisis === "medical") {
    await sendMessage(chatId, MEDICAL_RESPONSE);
    logCrisisDetected(phone, "medical", text).catch(() => {});
    return;
  }
  if (crisis === "emotional") {
    await sendMessage(chatId, EMOTIONAL_RESPONSE);
    logCrisisDetected(phone, "emotional", text).catch(() => {});
    return;
  }

  // ── Bereavement detection — before intent classification ───────────────────
  if (await isBereavementTrigger(text) && !(session as any).bereavementMode) {
    const seniorName = (session as any).seniorName ?? "your loved one";
    await activateBereavementMode(session.userId ?? phone, chatId, phone, seniorName as string);
    return;
  }
  // If already in bereavement mode — allow explicit exit or send gentle acknowledgment
  if ((session as any).bereavementMode) {
    let isExit = false;
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 5,
        system:
          "The user is in bereavement mode after losing a loved one. " +
          "Reply YES if they are clearly expressing that they are ready to resume normal service " +
          "(e.g. they need a caregiver, want to continue, are ready). " +
          "Reply NO if they are still grieving or just checking in. " +
          "Reply with only YES or NO.",
        messages: [{ role: "user", content: text }],
      });
      isExit = ((res.content[0] as { text: string }).text ?? "").trim().toUpperCase().startsWith("Y");
    } catch {
      isExit = false;
    }
    if (isExit) {
      await db.collection("agent_sessions").doc(phone).update({ bereavementMode: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId, "Of course. I'm here whenever you need me. What can I help you with?");
    } else {
      // After 30 days, gently offer to resume — don't trap them forever
      const activatedAt = (session as any).bereavementActivatedAt as string | undefined;
      const daysSince = activatedAt
        ? (Date.now() - new Date(activatedAt).getTime()) / (1000 * 60 * 60 * 24)
        : 0;
      if (daysSince > 30) {
        await sendMessage(chatId,
          "I'm here with you. 💙 Whenever you're ready to arrange care again, just let me know."
        );
      } else {
        await sendMessage(chatId, "I'm here with you. 💙 Take all the time you need.");
      }
    }
    return;
  }

  // ── Zep lazy-init — backfill for users onboarded before Zep was added ──────
  if (!(session as any).zepThreadId && session.onboardingStep === "complete") {
    initializeZepOnFirstContact(phone).catch((err) =>
      console.error("Zep lazy-init error:", err)
    );
  }

  // ── ONBOARDING gate — route to state machine if not complete ─────────────
  const step = session.onboardingStep ?? "";
  if (step && step !== "complete") {
    // Log every onboarding message to Zep — this is where names, conditions,
    // and care needs are shared, so Zep starts building the knowledge graph now
    const onboardingZepThreadId = (session as any).zepThreadId as string | undefined;
    if (onboardingZepThreadId) {
      addUserMessageToZep({
        threadId: onboardingZepThreadId,
        content:  text,
        userName: (session as any).onboardingData?.firstName ?? "User",
        sentAt:   new Date(),
      }).catch(console.error);
    }

    // Permissions steps
    if (step === "client_permissions_contact" || step === "client_permissions_booking" || step === "client_permissions_autobook") {
      const userId = session.userId ?? phone;
      await handleClientPermissionsReply(phone, chatId, text, session, userId);
      return;
    }
    if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
      const caregiverId = session.caregiverId ?? phone;
      await handleCaregiverPermissionsReply(phone, chatId, text, session, caregiverId);
      return;
    }
    await handleOnboardingStep(phone, chatId, text, session);

    // After each onboarding step, push the progress event to Zep as structured JSON
    // so Zep's knowledge graph captures names, conditions, care needs as they're collected.
    if (onboardingZepThreadId) {
      const afterSnap   = await db.collection("agent_sessions").doc(phone).get();
      const afterData   = afterSnap.data() ?? {};
      const newStep     = afterData.onboardingStep ?? step;
      const oData       = afterData.onboardingData ?? {};
      addBusinessDataToZep({
        userId: getZepUserId(phone),
        data: {
          event_type:         "onboarding_step",
          step_completed:     step,
          step_next:          newStep,
          user_type:          afterData.userType ?? "unknown",
          user_name:          (oData as any).firstName ?? (oData as any).name ?? "",
          senior_name:        (oData as any).seniorName ?? "",
          senior_age:         (oData as any).age ?? null,
          senior_conditions:  (oData as any).conditions ?? [],
          senior_care_needs:  (oData as any).careNeeds ?? [],
          senior_city:        (oData as any).city ?? "",
          timestamp:          new Date().toISOString(),
        },
      }).catch((err) => console.error("onboarding Zep push error:", err));
    }
    return;
  }

  // Rate limit
  if (await isRateLimited(phone)) {
    await sendMessage(chatId, "I'm getting a lot of messages right now — try again in a bit.");
    return;
  }

  // ── Universal state-machine escape hatch ──────────────────────────────────────
  {
    const ESCAPE_WORDS = new Set(["NEVERMIND", "QUIT", "EXIT", "BACK", "START OVER", "RESET", "FORGET IT"]);
    const hasStateFlagEscape = STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
                                 .some(f => !!(session as any)[f]);
    if (hasStateFlagEscape &&
        (ESCAPE_WORDS.has(norm) ||
         norm.startsWith("NEVER MIND") ||
         norm.startsWith("FORGET IT"))) {
      await clearAllStateFlags(phone, db);
      await sendMessage(chatId, "No problem, starting fresh. What can I help you with?");
      return;
    }
  }

  // ── Post-visit feedback reply — check before general routing ──────────────
  {
    const pendingFeedback = await db.collection("proactive_triggers")
      .where("phone",            "==", phone)
      .where("type",             "==", "post_visit_feedback")
      .where("firedAt",          "!=", null)
      .where("feedbackReceived", "==", null)
      .orderBy("firedAt", "desc")
      .limit(1)
      .get();

    if (!pendingFeedback.empty) {
      const triggerDoc = pendingFeedback.docs[0];
      const meta       = triggerDoc.data().metadata ?? {};
      await handleVisitFeedback({
        phone,
        chatId,
        text,
        caregiverId:   meta.caregiverId ?? "",
        clientId:      meta.clientId ?? session.userId ?? "",
        appointmentId: meta.appointmentId ?? "",
        triggerId:     triggerDoc.id,
      });
      return;
    }
  }

  // ── Caregiver keyword handling ──────────────────────────────────────────────
  if (session.userType === "caregiver") {
    // ── Swap acceptance/decline — when another caregiver was asked to cover ──
    if ((session as any).pendingSwapRequestId) {
      const swapRequestId  = (session as any).pendingSwapRequestId as string;
      const fromName       = (session as any).pendingSwapFromName as string ?? "A caregiver";
      const Anthropic      = (await import("@anthropic-ai/sdk")).default;
      const _swapClaude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const _swapRes       = await _swapClaude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system:
          "The caregiver is responding to a shift-swap request. " +
          "Reply ACCEPT if they agree to cover the shift. " +
          "Reply DECLINE if they refuse. " +
          "Reply UNSURE if it is unclear. " +
          "Reply with exactly one word.",
        messages: [{ role: "user", content: text }],
      });
      const swapDecision = ((_swapRes.content[0] as { text: string }).text ?? "").trim().toUpperCase();

      if (swapDecision === "ACCEPT") {
        const cgName = session.caregiverId
          ? (await db.collection("caregivers").doc(session.caregiverId).get()).data()?.name ?? "Caregiver"
          : "Caregiver";
        await db.collection("agent_sessions").doc(phone).update({
          pendingSwapRequestId: admin.firestore.FieldValue.delete(),
          pendingSwapFromName:  admin.firestore.FieldValue.delete(),
        });
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleSwapAcceptance(session.caregiverId ?? phone, cgName, swapRequestId, chatId);
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return;
      }

      if (swapDecision === "DECLINE") {
        await db.collection("shift_swap_requests").doc(swapRequestId).update({
          candidateResponses: admin.firestore.FieldValue.arrayUnion({
            caregiverId: session.caregiverId ?? phone,
            response:    "declined",
            at:          new Date().toISOString(),
          }),
        }).catch(() => {});
        await db.collection("agent_sessions").doc(phone).update({
          pendingSwapRequestId: admin.firestore.FieldValue.delete(),
          pendingSwapFromName:  admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId, `No problem — thanks for letting ${fromName}'s coordinator know!`);
        return;
      }
      // UNSURE — fall through to normal routing so Claude can answer the message
    }

    const KEYWORDS: Record<string, () => Promise<void>> = {
      ARRIVED:    () => handleArrived(phone, chatId, session),
      DONE:       () => handleDone(phone, chatId, session),
      LATE:       () => handleRunningLate(phone, chatId),
      ISSUE:      () => handleIssue(phone, chatId),
      CONFIRM:    async () => {
        // Find most recent appointment for this caregiver not yet confirmed
        const now = new Date().toISOString();
        const apptSnap = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("status",      "==", "confirmed")
          .where("caregiverConfirmed", "!=", true)
          .orderBy("caregiverConfirmed")
          .orderBy("date", "asc")
          .limit(1).get();
        if (!apptSnap.empty) {
          const appt = apptSnap.docs[0].data();
          const updateFields: Record<string, unknown> = { caregiverConfirmed: true, caregiverConfirmedAt: now };
          // Mark check-in confirmed so escalation guard skips it
          if (appt.caregiverCheckInSent) {
            updateFields.caregiverCheckInConfirmed = true;
            updateFields.caregiverCheckInAt        = now;
          }
          await apptSnap.docs[0].ref.update(updateFields);
          // Notify family
          const familySnap = await db.collection("agent_sessions").doc(appt.clientId ?? appt.clientPhone).get();
          if (familySnap.exists) {
            await sendMessage(familySnap.data()!.chatId,
              `${appt.caregiverName ?? "Your caregiver"} confirmed the visit on ${appt.date}. You're all set.`
            );
          }
          await sendMessage(chatId, "Confirmed! See you then. 👍");
        } else {
          await sendMessage(chatId, "Got it — confirmed! 👍");
        }
      },
      RESCHEDULE: async () => {
        await db.collection("agent_sessions").doc(phone).update({
          caregiverRescheduling: true,
          stateExpiresAt:        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await sendMessage(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
      },
      PASS:       async () => {
        await handleCaregiverAvailabilityReply(phone, session.caregiverId ?? "", "", chatId, "PASS");
      },
    };

    if (norm in KEYWORDS) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {/* non-critical */});
      try { await KEYWORDS[norm](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return;
    }

    // YES / NO to replacement candidate request
    if (norm === "YES" || norm === "NO") {
      const candidateSnap = await db.collection("replacement_candidates")
        .where("phone",  "==", phone)
        .where("status", "==", "contacted")
        .orderBy("contactedAt", "desc")
        .limit(1)
        .get();

      if (!candidateSnap.empty) {
        const candidate = candidateSnap.docs[0].data();
        const taskSnap  = await db.collection("agent_tasks").doc(candidate.taskId).get();
        const task      = taskSnap.data();

        if (task && task.status === "awaiting_approval") {
          if (norm === "YES") {
            await candidateSnap.docs[0].ref.update({ status: "available", respondedAt: new Date().toISOString() });
            await sendMessage(chatId, "Got it — we'll confirm with the family and follow up shortly.");
          } else {
            await candidateSnap.docs[0].ref.update({ status: "declined", respondedAt: new Date().toISOString() });
            await sendMessage(chatId, "No worries — thanks for letting us know!");
          }
          return;
        }
      }
    }

    // Awaiting care notes after DONE
    if ((session as any).awaitingCareNotes) {
      const cnExpiry = (session as any).stateExpiresAt as string | undefined;
      if (cnExpiry && new Date(cnExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
      } else {
        await handleCareNotes(phone, chatId, text, session);
        return;
      }
    }

    // Awaiting late minutes
    if ((session as any).awaitingLateMinutes) {
      const lmExpiry = (session as any).stateExpiresAt as string | undefined;
      if (lmExpiry && new Date(lmExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
        // fall through to normal message processing
      } else {
        await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false });
        const today2 = new Date().toISOString().slice(0, 10);
        const lateApptSnap = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date",        "==", today2).limit(1).get();
        const clientPhone = lateApptSnap.empty ? null : await getClientPhoneForAppt(lateApptSnap.docs[0].data());

        // Record lateness event
        if (!lateApptSnap.empty && session.caregiverId) {
          const lateApptData = lateApptSnap.docs[0].data();
          const minutesLateNum = parseInt(text.replace(/\D/g, ""), 10);
          if (!isNaN(minutesLateNum) && minutesLateNum > 0) {
            const cgSnap2 = await db.collection("caregivers").doc(session.caregiverId).get();
            const cgName2 = cgSnap2.data()?.name ?? "Unknown";
            const { recordLatenessEvent, checkLatenessPattern } = await import("../agents/latenessTracker");
            recordLatenessEvent({
              caregiverId:   session.caregiverId,
              caregiverName: cgName2,
              appointmentId: lateApptSnap.docs[0].id,
              clientId:      lateApptData.clientId ?? "",
              date:          today2,
              scheduledTime: (lateApptData.startTime ?? "").slice(0, 5),
              minutesLate:   minutesLateNum,
              selfReported:  true,
            }).catch(() => {});
            checkLatenessPattern(session.caregiverId, cgName2).catch(() => {});
          }
        }

        if (clientPhone) {
          const cgSnap = session.caregiverId
            ? await db.collection("caregivers").doc(session.caregiverId).get()
            : null;
          const cgName    = cgSnap?.data()?.name ?? "Your caregiver";
          const origTime  = lateApptSnap.empty ? "" : ` (originally ${lateApptSnap.docs[0].data().startTime})`;
          await sendIfNotDND(clientPhone, {
            content:     `${cgName} is running about ${text} late. They're on their way${origTime}.`,
            urgency:     "immediate",
            sourceAgent: "late_notification",
            canDrop:     false,
          }, "high");
        }
        await sendMessage(chatId, "I've notified the family. Drive safe.");
        return;
      }
    }

    // Awaiting issue description — smart classification + multi-level escalation
    if ((session as any).awaitingIssueDescription) {
      const idExpiry = (session as any).stateExpiresAt as string | undefined;
      if (idExpiry && new Date(idExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
        // fall through to normal message processing
      } else {
      await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false });

      const issueToday = new Date().toISOString().slice(0, 10);
      const issueApptSnap = await db.collection("appointments")
        .where("caregiverId", "==", session.caregiverId ?? "")
        .where("date",        "==", issueToday)
        .where("status",      "in", ["confirmed", "in-progress"])
        .limit(1).get();
      const issueAppt = issueApptSnap.empty ? null : issueApptSnap.docs[0].data();
      const clientPhone = issueApptSnap.empty ? null : await getClientPhoneForAppt(issueAppt!);

      const cgSnap      = session.caregiverId
        ? await db.collection("caregivers").doc(session.caregiverId).get()
        : null;
      const cgName       = cgSnap?.data()?.name ?? "Your caregiver";
      const seniorId     = issueAppt?.seniorId ?? issueAppt?.clientId ?? "";
      const seniorSnap   = seniorId ? await db.collection("senior_profiles").doc(seniorId).get() : null;
      const seniorName   = seniorSnap?.data()?.name ?? (issueAppt as any)?.clientName ?? "your client";

      const { handleCaregiverIssue } = await import("../agents/issueEscalator");
      await handleCaregiverIssue({
        caregiverId:    session.caregiverId ?? phone,
        caregiverPhone: phone,
        caregiverName:  cgName,
        appointmentId:  issueApptSnap.empty ? "" : issueApptSnap.docs[0].id,
        clientId:       issueAppt?.clientId ?? "",
        clientPhone:    clientPhone ?? "",
        seniorId,
        seniorName,
        description:    text,
      }).catch(async (err) => {
        console.error("handleCaregiverIssue failed:", err);
        // Fallback: write plain admin alert
        await db.collection("admin_alerts").add({
          type:        "caregiver_issue",
          caregiverId: session.caregiverId ?? phone,
          phone, description: text, severity: "medium",
          createdAt: new Date().toISOString(), resolved: false,
        });
      });

      await sendMessage(chatId, "I've flagged this for our team and notified the family. Thank you for letting me know.");
      return;
      } // end stateExpiresAt else
    }

    // Awaiting issue closure check (sent 20h after an ISSUE was filed)
    if ((session as any).awaitingIssueClosureCheck) {
      const issueLogId = (session as any).awaitingIssueClosureCheck as string;
      await db.collection("agent_sessions").doc(phone).update({
        awaitingIssueClosureCheck: admin.firestore.FieldValue.delete(),
      });
      const normReply = text.trim().toUpperCase();
      if (normReply === "YES" || normReply.startsWith("YES")) {
        await db.collection("issue_log").doc(issueLogId).update({
          resolvedAt: new Date().toISOString(),
        }).catch(() => {});
        await sendMessage(chatId, "Good to hear — glad everything's okay.");
      } else {
        await sendMessage(chatId, "Thanks for the update — I've noted it. Let me know if anything changes.");
      }
      return;
    }

    // ── Wellbeing check-in response: "4 3 5" style reply ──────────────────────
    if ((session as any).pendingWellbeingCheckin) {
      const parts = text.trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 5);
      if (parts.length === 3) {
        const [energy, stress, satisfaction] = parts;
        await db.collection("wellbeing_checkins").add({
          caregiverId: session.caregiverId ?? session.userId ?? phone,
          phone,
          energy,
          stress,
          satisfaction,
          recordedAt: new Date().toISOString(),
        });
        await db.collection("agent_sessions").doc(phone).update({
          pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
        });
        const avg = (energy + stress + satisfaction) / 3;
        const reply = avg < 3
          ? `Thank you for being honest 💙 Your scores tell me you might need some support. Would you like to:\n\n1. Adjust your schedule\n2. Talk to our support team\n3. Get info on mental health resources\n\nReply 1, 2, or 3 — or just ignore this if you're okay.`
          : `Checked in. Sounds like things are going well — your clients are in good hands.`;
        await sendMessage(chatId, reply);
        return;
      }
    }

    // Caregiver rescheduling — parse new times and notify family
    if ((session as any).caregiverRescheduling) {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      let timeList: string[] = [];
      try {
        const parsed = await claude.messages.create({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 100,
          system:
            "Extract interview time proposals from this message as a JSON array of human-readable strings. " +
            "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.",
          messages: [{ role: "user", content: text }],
        });
        timeList = JSON.parse((parsed.content[0] as { text: string }).text ?? "[]") as string[];
      } catch { /* fall through — use raw text below */ }
      const timesText = timeList.length > 0 ? timeList.join(", ") : text;

      // Find the relevant interview request
      const caregiverId = session.caregiverId ?? "";
      const cgSnap      = caregiverId ? await db.collection("caregivers").doc(caregiverId).get() : null;
      const cgName      = cgSnap?.data()?.name ?? "Your caregiver";
      const reqSnap     = await db.collection("interview_requests")
        .where("caregiverId", "==", caregiverId)
        .where("status",      "in", ["scheduled", "awaiting_client_confirmation"])
        .orderBy("createdAt", "desc").limit(1).get();

      if (!reqSnap.empty) {
        const reqData       = reqSnap.docs[0].data();
        const familyPhone   = reqData.clientPhone as string;
        const familySession = await db.collection("agent_sessions").doc(familyPhone).get();
        if (familySession.exists) {
          await sendMessage(familySession.data()!.chatId,
            `${cgName} needs to reschedule the interview.\n\n` +
            `They're available: ${timesText}\n\n` +
            `Reply with which time works, or PASS to find someone new.`
          );
          // Let family's next reply be handled as a time selection
          await db.collection("agent_sessions").doc(familyPhone).update({
            pendingTimeSelection: { interviewRequestId: reqSnap.docs[0].id, caregiverName: cgName },
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
        }
        await reqSnap.docs[0].ref.update({ status: "awaiting_client_confirmation", caregiverAvailability: timeList });
      }

      // Clear the flag only after the family has been notified successfully
      await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId, "Got it — I've sent those times to the family. I'll let you know once they confirm.");
      return;
    }

    // Caregiver availability reply (for interview scheduling)
    if ((session as any).pendingInterviewAvailabilityRequest) {
      await handleCaregiverAvailabilityReply(
        phone,
        session.caregiverId ?? "",
        "",
        chatId,
        text
      );
      return;
    }

    // ── Job alert: YES/NO/natural-language response ────────────────────────
    if ((session as any).awaitingJobResponse === true) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try { await handleJobResponse(phone, text, chatId, session as any); }
      finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return;
    }

    // ── Job alert: availability confirmation (any text) ─────────────────────
    if ((session as any).awaitingAvailabilityConfirmation === true) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try { await handleAvailabilityConfirmation(phone, text, chatId, session as any); }
      finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return;
    }

    // ── Caregiver shift swap — multi-step state machine ───────────────────
    if ((session as any).swapStep) {
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
          session as Record<string, unknown>,
          chatId
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Caregiver NLU fallback — handle natural-language keyword variants ──
    // Runs only when no exact keyword matched and no state machine is active.
    // Catches "I just arrived", "I'm done now", "running about 10 min late", etc.
    {
      const Anthropic   = (await import("@anthropic-ai/sdk")).default;
      const _nluClaude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const _nluRes     = await _nluClaude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 15,
        system:
          "Classify this caregiver message as one of: ARRIVED, DONE, LATE, ISSUE, CONFIRM, RESCHEDULE, NONE. " +
          "ARRIVED = caregiver arrived at or is entering a care visit. " +
          "DONE = caregiver has finished a care visit. " +
          "LATE = caregiver is running late to a visit. " +
          "ISSUE = caregiver is reporting a problem or concern during a visit. " +
          "CONFIRM = caregiver is confirming an upcoming appointment. " +
          "RESCHEDULE = caregiver wants to change the time of an appointment. " +
          "NONE = does not fit any of the above. " +
          "Reply with exactly one word.",
        messages: [{ role: "user", content: text }],
      });
      const nluAction = ((_nluRes.content[0] as { text: string }).text ?? "").trim().toUpperCase();
      if (nluAction in KEYWORDS) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try { await KEYWORDS[nluAction](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
        return;
      }
    }
  }

  // ── Emergency contact capture — family replies with EC name + phone ──────────
  if ((session as any).awaitingEmergencyContactUpdate) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingEmergencyContactUpdate: admin.firestore.FieldValue.delete(),
    });
    // Try to extract a phone number from the reply
    const ecPhoneMatch = text.match(/\+?[\d\s\-().]{10,}/);
    const ecPhone      = ecPhoneMatch ? ecPhoneMatch[0].replace(/[\s\-().]/g, "") : null;
    const ecName       = text.replace(/\+?[\d\s\-().]{10,}/g, "").trim().replace(/^[,;]+|[,;]+$/g, "").trim();
    const seniorId     = (session as any).seniorId ?? session.userId ?? "";
    if (ecPhone && seniorId) {
      await db.collection("senior_profiles").doc(seniorId).set(
        { emergencyContact: { phone: ecPhone, name: ecName || "Emergency Contact" } },
        { merge: true }
      );
      await sendMessage(chatId,
        `Got it — I've saved ${ecName || "your emergency contact"} (${ecPhone}) for ${(session as any).onboardingData?.seniorName ?? "your family member"}. They'll be contacted if there's ever an urgent issue.`
      );
    } else {
      await sendMessage(chatId,
        "I wasn't able to find a phone number in that message. Please reply with your emergency contact's name and phone number (e.g. 'John Smith 555-000-1234')."
      );
      await db.collection("agent_sessions").doc(phone).update({ awaitingEmergencyContactUpdate: true });
    }
    return;
  }

  // ── Shift hours APPROVE / DISPUTE (client iMessage reply) ───────────────────
  if ((session as any).pendingShiftApproval && (norm === "APPROVE" || norm.startsWith("DISPUTE"))) {
    const { appointmentId, amount, caregiverName } = (session as any).pendingShiftApproval;
    if (norm === "APPROVE") {
      const { approveShiftHoursForClient } = await import("../shiftHours");
      await approveShiftHoursForClient(appointmentId as string);
      await sendMessage(chatId, `Approved. ${caregiverName as string} will be paid $${amount as string}.`);
    } else {
      // Create admin alert and set a pending state to capture the follow-up detail
      const alertRef = await db.collection("admin_alerts").add({
        type:          "shift_hours_disputed",
        appointmentId,
        caregiverName,
        amount,
        clientPhone:   phone,
        createdAt:     new Date().toISOString(),
        resolved:      false,
        detail:        null,
      });
      await db.collection("agent_sessions").doc(phone).update({
        pendingShiftApproval:    admin.firestore.FieldValue.delete(),
        pendingDisputeDetail:    { alertId: alertRef.id, caregiverName },
      });
      await sendMessage(chatId,
        `Got it — flagged for review. Our team will follow up within 24 hours.\n\n` +
        `What looks wrong with the hours? (reply to add details, or just ignore this message)`
      );
      return;
    }
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
    return;
  }

  // ── Shift hours dispute detail — follow-up message after DISPUTE ────────────
  if ((session as any).pendingDisputeDetail) {
    const { alertId, caregiverName: cgName } = (session as any).pendingDisputeDetail as {
      alertId: string; caregiverName: string;
    };
    await db.collection("admin_alerts").doc(alertId).update({ detail: text });
    await db.collection("agent_sessions").doc(phone).update({
      pendingDisputeDetail: admin.firestore.FieldValue.delete(),
    });
    await sendMessage(chatId,
      `Thanks — I've added your note to the dispute. Our team will review the hours for ${cgName} and get back to you.`
    );
    return;
  }

  // ── Credential collection (portal logins) ─────────────────────────────────
  // Must run before intent classification — password messages must not be logged.
  if ((session as Record<string, unknown>).collectingCredential) {
    const { handleCredentialReply } = await import("../browser/credentialCollector");
    const handled = await handleCredentialReply({
      phone,
      userId: session.userId ?? "",
      text,
      session: session as Record<string, unknown>,
    });
    if (handled) return;
  }

  // ── Job posting flow — multi-step state machine for returning clients ───────
  if ((session as any).jobPostingStep) {
    const jpExpiry = (session as any).stateExpiresAt as string | undefined;
    if (jpExpiry && new Date(jpExpiry) < new Date()) {
      await db.collection("agent_sessions").doc(phone).update({
        jobPostingStep: admin.firestore.FieldValue.delete(),
        jobPostingData:  admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
      });
      await sendMessage(chatId, "Your job posting session timed out. Text me anytime to start a new one!");
      return;
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleJobPostingStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return;
  }

  // ── Recurring schedule modification flow ─────────────────────────────────
  if ((session as any).modifyScheduleStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleModifyScheduleStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return;
  }

  // ── Refund self-service flow (multi-step state machine) ───────────────────
  if ((session as any).refundStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      const refundClientId = ((session as any).userId ?? phone) as string;
      await handleRefundRequest(
        refundClientId,
        text,
        session as Record<string, unknown>,
        (msg: string) => sendMessage(chatId, msg)
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return;
  }

  // ── Client caregiver swap flow — multi-step state machine ───────────────
  if ((session as any).clientSwapStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleClientSwapRequest(
        session.userId ?? phone,
        phone,
        text,
        session as Record<string, unknown>,
        chatId
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return;
  }

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

  try {
    const intent = await classifyIntent(text, !!pendingTask);

    // ── Emergency replacement: 1/2/3 ─────────────────────────────────────────
    if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
      await handleTaskApproval(pendingTask, text.trim(), session, chatId);
      return;
    }

    // ── BOOKING_CONFIRM — natural language YES ("sure", "sounds good", etc.) ──
    if (intent === "BOOKING_CONFIRM") {
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
      if ((session as any).pendingInterviewConfirm) {
        await handleInterviewConfirm(phone, chatId, session);
        return;
      }
      if ((session as any).pendingCancelConfirm) {
        const { appointmentId } = (session as any).pendingCancelConfirm as { appointmentId: string };
        const apptRef  = db.collection("appointments").doc(appointmentId);
        const apptSnap = await apptRef.get();
        if (apptSnap.exists) {
          const appt = apptSnap.data()!;
          await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
          const cgSnap  = await db.collection("caregivers").doc(appt.caregiverId).get();
          const cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
            await sendMessage(cgSess.chatId, `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`);
          }
        }
        await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
        await sendMessage(chatId, "Cancelled. Want me to find a replacement for that day?");
        return;
      }
    }

    // ── BOOKING_DECLINE — natural language NO ("never mind", "don't book", etc.) ──
    if (intent === "BOOKING_DECLINE") {
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
        await sendMessage(chatId, `${pending.caregiverName} sounds like a great fit. When would you like care to start?`);
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
        await sendMessage(chatId, "No worries — I'll reach out when something comes up.");
      }
      return;
    }

    // ── YES — booking, recurring setup, or interview confirmation ───────────────
    if (norm === "YES" || norm === "Y") {
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
      if ((session as any).pendingInterviewConfirm) {
        await handleInterviewConfirm(phone, chatId, session);
        return;
      }
      // YES to cancel confirmation
      if ((session as any).pendingCancelConfirm) {
        const { appointmentId } = (session as any).pendingCancelConfirm as { appointmentId: string };
        const apptRef = db.collection("appointments").doc(appointmentId);
        const apptSnap = await apptRef.get();
        if (apptSnap.exists) {
          const appt = apptSnap.data()!;
          await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
          // Notify caregiver
          const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
          const cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const cgSess = await (await import("./client")).getOrCreateSession(cgPhone);
            await sendMessage(cgSess.chatId,
              `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`
            );
          }
        }
        await db.collection("agent_sessions").doc(phone).update({
          pendingCancelConfirm: admin.firestore.FieldValue.delete(),
        });
        await sendMessage(chatId, "Cancelled. Want me to find a replacement for that day?");
        return;
      }
    }

    // ── NO — recurring setup declined, booking declined, or interview time rejected ──
    if (norm === "NO" || norm === "N") {
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
      // NO to interview time — show other available times or offer alternatives
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
    }

    // ── CONFIRM / SKIP — finalizes a pending task selection made by 1/2/3 ──────
    if (norm === "CONFIRM" && (session as any).pendingTaskConfirm) {
      const { finalizeTaskApproval } = await import("../agents/taskApprovalHandler");
      await finalizeTaskApproval(phone, chatId, session as Record<string, unknown>);
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
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const _ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const _r = await _ac.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 10,
          system:
            "The user just interviewed a caregiver and is sharing their thoughts. " +
            "Classify as HIRE (positive, wants to proceed), MAYBE (uncertain, not sure), " +
            "or PASS (negative, concerns, didn't click). Reply with one word only.",
          messages: [{ role: "user", content: text }],
        });
        const classified = ((_r.content[0] as { text: string }).text ?? "").trim().toUpperCase();
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
            await sendMessage(chatId,
              `${pendingOutcome.caregiverName} sounds like a great fit. When would you like care to start?`
            );
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
        await sendMessage(chatId,
          `${pending.caregiverName} sounds like a great fit. When would you like care to start?`
        );
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
    if ((session as any).pendingMatches?.length > 0 && /[123]|all/i.test(text)) {
      await handleInterviewSelection(phone, chatId, text, session);
      return;
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
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const extraction = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system:     "Extract the name and phone number from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.",
        messages:   [{ role: "user", content: text }],
      });

      let memberName: string | null = null;
      let memberPhone: string | null = null;
      try {
        const parsed = JSON.parse((extraction.content[0] as { text: string }).text ?? "{}");
        memberName  = parsed.name  ?? null;
        memberPhone = parsed.phone ?? null;
      } catch { /* */ }

      if (!memberPhone) {
        await sendMessage(chatId, "I didn't catch a phone number — please include it (e.g. 'add my sister Sarah at +1 555 000 1234').");
        return;
      }

      // Add to groupMembers array in session
      await db.collection("agent_sessions").doc(phone).update({
        groupMembers: admin.firestore.FieldValue.arrayUnion(memberPhone),
      });

      // Add to family_group_members collection
      await db.collection("family_group_members").add({
        primaryPhone:  phone,
        memberPhone,
        memberName:    memberName ?? "Family member",
        userId:        session.userId ?? phone,
        addedAt:       new Date().toISOString(),
      });

      await sendViaInteractionAgent(phone, {
        content:     `Done — ${memberName ?? memberPhone} is now in your care group. They'll get the same updates you do.`,
        urgency:     "standard",
        sourceAgent: "family_group",
        canDrop:     false,
      });
      return;
    }

    if (intent === "REMOVE_FAMILY_MEMBER") {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const extraction = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system:     "Extract the name and/or phone number of the person to remove from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.",
        messages:   [{ role: "user", content: text }],
      });

      let targetName: string | null = null;
      let targetPhone: string | null = null;
      try {
        const parsed = JSON.parse((extraction.content[0] as { text: string }).text ?? "{}");
        targetName  = parsed.name  ?? null;
        targetPhone = parsed.phone ?? null;
      } catch { /* */ }

      // If no phone provided, try to resolve by name from family_group_members
      if (!targetPhone && targetName) {
        const memberSnap = await db.collection("family_group_members")
          .where("primaryPhone", "==", phone)
          .get();
        const match = memberSnap.docs.find(d =>
          (d.data().memberName as string ?? "").toLowerCase().includes(targetName!.toLowerCase())
        );
        if (match) targetPhone = match.data().memberPhone as string;
      }

      if (!targetPhone) {
        await sendMessage(chatId, "I didn't find that person in your care group. Try including their phone number (e.g. 'remove +1 555 000 1234').");
        return;
      }

      // Look up seniorId from session
      const seniorId: string = (session as any).seniorId ?? session.userId ?? phone;
      const { removeMemberFromGroup } = await import("../agents/familyGroupManager");
      const result = await removeMemberFromGroup(seniorId, targetPhone);

      if (result.removed) {
        // Also remove from family_group_members collection and session
        const memberSnap = await db.collection("family_group_members")
          .where("primaryPhone", "==", phone)
          .where("memberPhone",  "==", targetPhone)
          .limit(1)
          .get();
        if (!memberSnap.empty) await memberSnap.docs[0].ref.delete();

        await db.collection("agent_sessions").doc(phone).update({
          groupMembers: admin.firestore.FieldValue.arrayRemove(targetPhone),
        }).catch(() => {});

        await sendMessage(chatId, `Done — ${targetName ?? targetPhone} has been removed from your care group. They'll no longer receive updates.`);
      } else {
        await sendMessage(chatId, `I couldn't find ${targetName ?? targetPhone} in your care group. Let me know if you need help.`);
      }
      return;
    }

    // ── hireMode step B — schedule reply ─────────────────────────────────────
    if ((session as any).hireMode && (session as any).hireModeDate) {
      const hire      = (session as any).hireMode      as { caregiverName: string; caregiverId: string };
      const dateStr   = (session as any).hireModeDate  as string;
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const parsedSchedule = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system:
          "Extract a weekly care schedule from this message. " +
          "Reply with only a JSON object: { \"days\": [\"Monday\",\"Wednesday\",\"Friday\"], " +
          "\"startTime\": \"9:00 AM\", \"endTime\": \"1:00 PM\", \"durationHours\": 4 }. " +
          "days must be full day names. durationHours is a number.",
        messages: [{ role: "user", content: text }],
      });
      let schedule: { days: string[]; startTime: string; endTime: string; durationHours: number } | null = null;
      try {
        schedule = JSON.parse((parsedSchedule.content[0] as { text: string }).text ?? "null");
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
      const Anthropic  = (await import("@anthropic-ai/sdk")).default;
      const claude     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const parsedDate = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 20,
        system:
          `Today is ${new Date().toISOString().slice(0, 10)}. ` +
          "The user is choosing a start date for care. Reply with only a YYYY-MM-DD date string, nothing else.",
        messages: [{ role: "user", content: text }],
      });
      const dateStr = ((parsedDate.content[0] as { text: string }).text ?? "").trim();
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
      const Anthropic    = (await import("@anthropic-ai/sdk")).default;
      const claude       = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const parsed       = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 60,
        system:
          `Available times: ${availability.join(", ")}. ` +
          "The user picked one of these times. Reply with only the exact string from the list that best matches their reply, or 'NONE' if no match.",
        messages: [{ role: "user", content: text }],
      });
      const chosen = ((parsed.content[0] as { text: string }).text ?? "").trim();
      if (chosen === "NONE" || !availability.includes(chosen)) {
        await sendMessage(chatId, `I didn't catch that — which of these works for you?\n\n${availability.join("\n")}\n\nOr reply PASS to find someone else.`);
        return;
      }

      // Book the chosen time
      await db.collection("agent_sessions").doc(phone).update({
        pendingTimeSelection:   admin.firestore.FieldValue.delete(),
        pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen },
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
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const parsedDate = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 20,
        system:
          `Today is ${new Date().toISOString().slice(0, 10)}. ` +
          "The user is choosing a date for a care visit. Reply with only a YYYY-MM-DD date string, nothing else.",
        messages: [{ role: "user", content: text }],
      });
      const dateStr = ((parsedDate.content[0] as { text: string }).text ?? "").trim();
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
      await handleScheduleRequest(phone, text, session as Record<string, unknown>);
      return;
    }

    // ── Trigger management — view or cancel personal reminders ───────────────
    if (intent === "TRIGGER_MANAGEMENT") {
      const { handleTriggerManagement } = await import("../agents/schedulingHandler");
      await handleTriggerManagement(phone, text, session as Record<string, unknown>);
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
      await sendMessage(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
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
        zepThreadId: (session as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as Record<string, unknown>,
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
          session as Record<string, unknown>,
          chatId
        );
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
          session as Record<string, unknown>,
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
        session as Record<string, unknown>,
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
        zepThreadId: (session as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as Record<string, unknown>,
      });
      await sendViaInteractionAgent(phone, {
        content:     qaReplyInvoice,
        urgency:     "standard",
        sourceAgent: "qa",
        canDrop:     false,
      });
      return;
    }

    // ── Platform-action intents — routed to QA agent with new MCP tools ─────
    if (
      intent === "VIEW_MY_JOBS"        ||
      intent === "VIEW_APPLICANTS"     ||
      intent === "VIEW_JOURNAL"        ||
      intent === "APPROVE_TIMESHEET"   ||
      intent === "VIEW_EARNINGS"       ||
      intent === "UPDATE_AVAILABILITY" ||
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
        zepThreadId: (session as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as Record<string, unknown>,
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
        zepThreadId: (session as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as Record<string, unknown>,
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

    const qaReply = await runQaAgent({
      text,
      phone,
      chatId,
      userId:      session.userId   ?? "",
      seniorId:    session.seniorId ?? session.userId ?? "",
      userType:    session.userType ?? "client",
      caregiverId: session.caregiverId,
      zepThreadId,
      session:     session as Record<string, unknown>,
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
  } catch (err) {
    console.error("handleInbound error:", err);
    await stopTyping(chatId).catch(() => {});
    await sendMessage(chatId, "I'm having trouble right now. For urgent concerns, please call 911.");

    await db.collection("agent_error_log").add({
      phone, error: String(err), text, createdAt: new Date().toISOString(),
    }).catch(() => {/* non-critical */});
  } finally {
    await stopTyping(chatId).catch(() => {});
  }
}

// ── message.failed handler ────────────────────────────────────────────────────

async function handleMessageFailed(event: unknown): Promise<void> {
  const ev        = event as any;
  const chatId    = ev.data?.chat_id    as string | undefined;
  const messageId = ev.data?.message_id as string | undefined;
  const errorCode = ev.data?.error_code as number | undefined;
  const reason    = ev.data?.reason     as string | undefined;
  const now       = new Date().toISOString();

  await db.collection("agent_error_log").add({
    type:      "message.failed",
    chatId,
    messageId,
    errorCode,
    reason,
    failedAt:  ev.data?.failed_at ?? now,
    createdAt: now,
  }).catch(() => {});

  await db.collection("admin_alerts").add({
    type:      "linq_message_failed",
    chatId,
    messageId,
    errorCode,
    reason,
    severity:  (errorCode === 4001 || errorCode === 4002) ? "high" : "medium",
    createdAt: now,
    resolved:  false,
  }).catch(() => {});

  console.warn("linqWebhook: message.failed", { chatId, messageId, errorCode, reason });
}

// ── phone_number.status_updated handler ───────────────────────────────────────

async function handlePhoneNumberStatusUpdated(event: unknown): Promise<void> {
  const ev          = event as any;
  const phoneNumber = ev.data?.phone_number     as string | undefined;
  const newHealth   = ev.data?.new_health_status as string | undefined;
  const prevHealth  = ev.data?.previous_health_status as string | undefined;
  const now         = new Date().toISOString();

  if (!phoneNumber) return;

  await db.collection("linq_phone_health").doc(phoneNumber).set({
    phoneNumber,
    healthStatus: newHealth,
    updatedAt:    now,
  }, { merge: true }).catch(() => {});

  const degraded = newHealth === "at_risk" || newHealth === "critical";
  if (degraded) {
    await db.collection("admin_alerts").add({
      type:         "linq_phone_health_degraded",
      phoneNumber,
      prevHealth,
      newHealth,
      severity:     newHealth === "critical" ? "critical" : "high",
      message:      `Linq line ${phoneNumber} health changed from ${prevHealth ?? "unknown"} to ${newHealth}. ${newHealth === "critical" ? "Pause outbound messaging immediately." : "Reduce send volume."}`,
      createdAt:    now,
      resolved:     false,
    }).catch(() => {});

    console.error("linqWebhook: phone number health degraded", { phoneNumber, prevHealth, newHealth });

    if (newHealth === "critical") {
      await db.collection("system_config").doc("linq_circuit_breaker").set({
        status:    "open",
        reason:    `Linq line ${phoneNumber} status went critical`,
        openedAt:  now,
        phone:     phoneNumber,
      }, { merge: true }).catch(() => {});
      console.error("linqWebhook: circuit breaker OPENED for outbound messaging — Linq line critical", { phoneNumber });
    }
  }
}

// ── iMessage emoji reaction → task confirmation ───────────────────────────────
// Positive emojis (👍 ❤️ 😍 🎉 ✅ 👏 💙) → YES / confirm pending task
// Negative emojis (👎 ✖️) → NO / decline pending task

const POSITIVE_REACTIONS = new Set(["thumbsup", "love", "ha", "emphasize", "like", "heart", "👍", "❤️", "😍", "🎉", "✅", "👏", "💙", "🙌"]);
const NEGATIVE_REACTIONS = new Set(["thumbsdown", "dislike", "👎", "✖️", "❌"]);

async function handleReactionAdded(event: any): Promise<void> {
  const phone    = event.data?.sender_handle?.value as string | undefined;
  const reaction = (event.data?.reaction ?? "") as string;
  const chatId   = event.data?.chat?.id     as string | undefined;
  const now      = new Date().toISOString();

  // Audit log regardless
  await db.collection("agent_reactions").add({
    chatId,
    messageId: event.data?.message_id,
    reaction,
    phone,
    reactedAt: now,
  }).catch(() => {});

  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;
  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut) return;

  const isYes = POSITIVE_REACTIONS.has(reaction);
  const isNo  = NEGATIVE_REACTIONS.has(reaction);
  if (!isYes && !isNo) return;

  // Check for a pending agent_task awaiting approval
  const taskSnap = await db
    .collection("agent_tasks")
    .where("clientPhone", "==", phone)
    .where("status",      "==", "awaiting_approval")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (!taskSnap.empty && isYes) {
    const taskDoc = taskSnap.docs[0];
    if (taskDoc.data().type === "booking_confirmation") {
      const { executeBookings } = await import("../agents/bookingExecutor");
      await executeBookings(taskDoc.id, phone).catch(err =>
        console.error("handleReactionAdded: executeBookings failed:", err)
      );
    } else {
      // Generic approval for other task types (e.g. replacement selection)
      await handleTaskApproval(taskDoc, "1", session, chatId);
    }
    return;
  }

  if (!taskSnap.empty && isNo) {
    const taskDoc = taskSnap.docs[0];
    await taskDoc.ref.update({ status: "declined_by_reaction", declinedAt: now });
    await sendViaInteractionAgent(phone, {
      content:     "Got it — I'll leave it for now. Let me know if you'd like a different option.",
      urgency:     "immediate",
      sourceAgent: "reaction_handler",
      canDrop:     false,
    }).catch(() => {});
    return;
  }

  // No pending task — check if there's a pending recurring schedule confirmation in session
  if (isYes && (session as any).awaitingRecurringConfirmation) {
    const setAt = (session as any).pendingRecurringConfirmationSetAt as string | undefined;
    if (setAt && Date.now() - new Date(setAt).getTime() > 2 * 60 * 60 * 1000) {
      // Confirmation window expired — clear state
      await db.collection("agent_sessions").doc(phone).update({
        awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
        pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      return;
    }
    await handleRecurringConfirm(phone, chatId, session);
    return;
  }
}

// ── Webhook HTTPS function ────────────────────────────────────────────────────

export const linqWebhook = functions
  .runWith({ secrets: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "CREDENTIAL_VAULT_KEY"] })
  .https.onRequest(async (req, res) => {
  res.status(200).send("ok");

  if (req.method !== "POST") return;

  const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
  if (webhookSecret) {
    const timestamp = req.headers["x-webhook-timestamp"] as string ?? "";
    const signature = req.headers["x-webhook-signature"] as string ?? "";
    const rawBody   = (req as any).rawBody as Buffer ?? Buffer.from(JSON.stringify(req.body));
    if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
      console.warn("linqWebhook: invalid signature — ignoring");
      return;
    }
    // FIX 9 — reject stale events (replay attack protection)
    const tsNum = parseInt(timestamp, 10);
    if (!isNaN(tsNum) && Math.abs(Date.now() / 1000 - tsNum) > 300) {
      console.warn("linqWebhook: stale timestamp — ignoring");
      return;
    }
  }

  const event = req.body;

  // Deduplicate all event types by event_id (Linq delivers at-least-once)
  const eventId: string | undefined = event.event_id ?? event.id;
  if (eventId) {
    const logRef  = db.collection("agent_event_log").doc(eventId);
    const existing = await logRef.get();
    if (existing.exists) return; // already processed
    await logRef.set({ type: event.type, processedAt: new Date().toISOString() });
  }

  switch (event.type) {
    case "message.received":
      await handleInbound(event).catch((err) =>
        console.error("linqWebhook handleInbound:", err)
      );
      break;

    case "message.read":
      await db.collection("agent_read_receipts").add({
        chatId:    event.data?.chat?.id,
        messageId: event.data?.message_id,
        phone:     event.data?.sender_handle?.value,
        readAt:    new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "reaction.added":
      await handleReactionAdded(event as any).catch((err) =>
        console.error("linqWebhook handleReactionAdded:", err)
      );
      break;

    case "chat.typing_indicator.started":
      await handleTypingStarted(event).catch((err) =>
        console.error("linqWebhook handleTypingStarted:", err)
      );
      break;

    case "message.delivered":
      await db.collection("agent_conversations")
        .where("messageId", "==", event.data?.message_id)
        .limit(1)
        .get()
        .then(async (snap) => {
          if (!snap.empty) {
            await snap.docs[0].ref.update({ deliveredAt: event.data?.delivered_at ?? new Date().toISOString() });
          }
        })
        .catch(() => {/* non-critical */});
      break;

    case "message.failed":
      await handleMessageFailed(event).catch((err) =>
        console.error("linqWebhook handleMessageFailed:", err)
      );
      break;

    case "phone_number.status_updated":
      await handlePhoneNumberStatusUpdated(event).catch((err) =>
        console.error("linqWebhook handlePhoneNumberStatusUpdated:", err)
      );
      break;

    default:
      console.warn(`linqWebhook: unhandled event type "${(event as any)?.type ?? "unknown"}"`);
      break;
  }
});
