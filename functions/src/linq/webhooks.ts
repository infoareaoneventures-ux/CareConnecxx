import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { sendMessage, startTyping, stopTyping, shareContactCard, setContactCard, checkCapability, AgentSession, LinqService } from "./client";
import { classifyIntent } from "../agents/intentClassifier";
import { runQaAgent } from "../agents/qaAgent";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
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
} from "../agents/interviewAgent";
import { executeBookings, createBookingTask } from "../agents/bookingExecutor";
import { detectCrisis, MEDICAL_RESPONSE, EMOTIONAL_RESPONSE } from "../safety/crisisDetector";
import { cancelTriggerIfUserReplied } from "../triggers/triggerEngine";
import { logCrisisDetected } from "../observability/auditLog";
import { isBereavementTrigger, activateBereavementMode } from "../agents/bereavement";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handleJobResponse, handleAvailabilityConfirmation } from "../triggers/jobNotifications";
import {
  initializeZepOnFirstContact,
  addUserMessageToZep,
  addAssistantMessageToZep,
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
  await appt.ref.update({ arrivedAt: new Date().toISOString(), status: "in-progress" });

  // Notify family
  const clientPhone = await getClientPhoneForAppt(appt.data());
  if (clientPhone) {
    const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
    if (clientSession.exists) {
      await sendMessage(clientSession.data()!.chatId,
        `${session.caregiverId ? (await db.collection("caregivers").doc(session.caregiverId).get()).data()?.name ?? "Your caregiver" : "Your caregiver"} just arrived for ${appt.data().clientName ?? "the visit"}.`
      );
    }
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
  });

  await sendMessage(chatId,
    "How did the visit go? Tell me in your own words — I'll handle the notes."
  );
}

async function handleRunningLate(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: true });
  await sendMessage(chatId, "How late do you think you'll be?");
}

async function handleIssue(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: true });
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

  // Get clientId from appointment
  let clientId = "";
  let seniorId = "";
  if (apptId) {
    const apptSnap = await db.collection("appointments").doc(apptId).get();
    clientId = apptSnap.data()?.clientId ?? "";
    seniorId = apptSnap.data()?.seniorId ?? clientId;
  }

  await db.collection("care_journal").add({
    caregiverId,
    seniorId,
    appointmentId: apptId,
    timestamp:     new Date().toISOString(),
    notes:         entry.notes ?? text,
    wellness: {
      ateWell:   entry.appetite === "good",
      tookMeds:  Array.isArray(entry.medications) && entry.medications.length > 0,
      wasActive: Array.isArray(entry.activities)  && entry.activities.length > 0,
      mood:      entry.mood ?? "neutral",
    },
    activities:    entry.activities ?? [],
    observations:  entry.observations ?? "",
  });

  // Clear awaiting flag
  await db.collection("agent_sessions").doc(phone).update({
    awaitingCareNotes:  false,
    careNotesApptId:    "",
  });

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

// ── Main inbound handler ──────────────────────────────────────────────────────

async function handleInbound(event: unknown): Promise<void> {
  const ev     = event as any;
  const phone  = ev.data?.sender_handle?.value as string | undefined;
  const text   = (ev.data?.parts?.[0]?.value ?? "") as string;
  const chatId = ev.data?.chat?.id as string | undefined;

  if (!phone || !chatId) return;

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

      // Start Zep memory for this secondary member too
      initializeZepOnFirstContact(phone).catch(console.error);

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

    // Start Zep memory immediately — before we know name or role
    initializeZepOnFirstContact(phone).catch(console.error);

    await startTyping(chatId).catch(() => {});
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

  // STOP — works at any stage (CANCEL is NOT here — it cancels a visit, not the account)
  if (stopWords.has(norm)) {
    await optOutPhoneNumber(phone);
    await sendMessage(chatId, "You've been unsubscribed from Cara messages. Reply START anytime to reactivate.");
    return;
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
  if (isBereavementTrigger(text) && !(session as any).bereavementMode) {
    const seniorName = (session as any).seniorName ?? "your loved one";
    await activateBereavementMode(session.userId ?? phone, chatId, phone, seniorName as string);
    return;
  }
  // If already in bereavement mode, send gentle acknowledgment only
  if ((session as any).bereavementMode) {
    await sendMessage(chatId,
      "I'm here with you. 💙 Take all the time you need. I'm ready when you are."
    );
    return;
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
    return;
  }

  // Rate limit
  if (await isRateLimited(phone)) {
    await sendMessage(chatId, "I'm getting a lot of messages right now — try again in a bit.");
    return;
  }

  // ── Caregiver keyword handling ──────────────────────────────────────────────
  if (session.userType === "caregiver") {
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
          await apptSnap.docs[0].ref.update({ caregiverConfirmed: true, caregiverConfirmedAt: now });
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
        await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: true });
        await sendMessage(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
      },
      PASS:       async () => {
        await handleCaregiverAvailabilityReply(phone, session.caregiverId ?? "", "", chatId, "PASS");
      },
    };

    if (norm in KEYWORDS) {
      await startTyping(chatId).catch(() => {/* non-critical */});
      try { await KEYWORDS[norm](); } finally { await stopTyping(chatId).catch(() => {}); }
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
      await handleCareNotes(phone, chatId, text, session);
      return;
    }

    // Awaiting late minutes
    if ((session as any).awaitingLateMinutes) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false });
      const clientPhone = await (async () => {
        const today = new Date().toISOString().slice(0, 10);
        const snap  = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date",        "==", today).limit(1).get();
        return snap.empty ? null : await getClientPhoneForAppt(snap.docs[0].data());
      })();
      if (clientPhone) {
        const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
        if (clientSession.exists) {
          const cgSnap = session.caregiverId
            ? await db.collection("caregivers").doc(session.caregiverId).get()
            : null;
          const cgName = cgSnap?.data()?.name ?? "Your caregiver";
          const today  = new Date().toISOString().slice(0, 10);
          const appt   = await db.collection("appointments")
            .where("caregiverId", "==", session.caregiverId ?? "")
            .where("date", "==", today).limit(1).get();
          const origTime = appt.empty ? "" : ` (originally ${appt.docs[0].data().startTime})`;
          await sendMessage(clientSession.data()!.chatId,
            `${cgName} is running about ${text} late. They're on their way${origTime}.`
          );
        }
      }
      await sendMessage(chatId, "I've notified the family. Drive safe.");
      return;
    }

    // Awaiting issue description
    if ((session as any).awaitingIssueDescription) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false });
      await db.collection("admin_alerts").add({
        type:        "caregiver_issue",
        caregiverId: session.caregiverId ?? phone,
        phone,
        description: text,
        severity:    "medium",
        createdAt:   new Date().toISOString(),
        resolved:    false,
      });
      const clientPhone = await (async () => {
        const today = new Date().toISOString().slice(0, 10);
        const snap  = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date", "==", today).limit(1).get();
        return snap.empty ? null : await getClientPhoneForAppt(snap.docs[0].data());
      })();
      if (clientPhone) {
        const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
        if (clientSession.exists) {
          await sendMessage(clientSession.data()!.chatId,
            `Your caregiver flagged a concern during today's visit. Our team is looking into it and will follow up shortly.`
          );
        }
      }
      await sendMessage(chatId, "I've flagged this for our team and notified the family. Thank you for letting me know.");
      return;
    }

    // Caregiver rescheduling — parse new times and notify family
    if ((session as any).caregiverRescheduling) {
      await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() });
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const parsed    = await claude.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system:
          "Extract interview time proposals from this message as a JSON array of human-readable strings. " +
          "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.",
        messages: [{ role: "user", content: text }],
      });
      let timeList: string[] = [];
      try { timeList = JSON.parse((parsed.content[0] as { text: string }).text ?? "[]") as string[]; } catch { /* */ }
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
          });
        }
        await reqSnap.docs[0].ref.update({ status: "awaiting_client_confirmation", caregiverAvailability: timeList });
      }
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

    // ── Job alert: YES/NO response ──────────────────────────────────────────
    if ((session as any).awaitingJobResponse === true && (norm === "YES" || norm === "NO")) {
      await startTyping(chatId).catch(() => {});
      try { await handleJobResponse(phone, norm, chatId, session as any); }
      finally { await stopTyping(chatId).catch(() => {}); }
      return;
    }

    // ── Job alert: availability confirmation (any text) ─────────────────────
    if ((session as any).awaitingAvailabilityConfirmation === true) {
      await startTyping(chatId).catch(() => {});
      try { await handleAvailabilityConfirmation(phone, text, chatId, session as any); }
      finally { await stopTyping(chatId).catch(() => {}); }
      return;
    }
  }

  // ── Shift hours APPROVE / DISPUTE (client iMessage reply) ───────────────────
  if ((session as any).pendingShiftApproval && (norm === "APPROVE" || norm.startsWith("DISPUTE"))) {
    const { appointmentId, amount, caregiverName } = (session as any).pendingShiftApproval;
    if (norm === "APPROVE") {
      const { approveShiftHoursForClient } = await import("../shiftHours");
      await approveShiftHoursForClient(appointmentId as string);
      await sendMessage(chatId, `Approved. ${caregiverName as string} will be paid $${amount as string}.`);
    } else {
      await sendMessage(chatId,
        `Got it — I'll flag this for review. Someone from our team will follow up within 24 hours. ` +
        `If you'd like to add details, just reply with what looks wrong.`
      );
      await db.collection("admin_alerts").add({
        type:          "shift_hours_disputed",
        appointmentId,
        clientPhone:   phone,
        createdAt:     new Date().toISOString(),
        resolved:      false,
      });
    }
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
    return;
  }

  // ── Check for pending task (booking / emergency replacement) ───────────────
  const taskSnap = await db
    .collection("agent_tasks")
    .where("clientPhone", "==", phone)
    .where("status",      "==", "awaiting_approval")
    .orderBy("createdAt", "desc").limit(1).get();

  const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];

  await startTyping(chatId).catch(() => {/* non-critical */});

  try {
    const intent = await classifyIntent(text, !!pendingTask);

    // ── Emergency replacement: 1/2/3 ─────────────────────────────────────────
    if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
      await handleTaskApproval(pendingTask, text.trim(), session, chatId);
      return;
    }

    // ── YES — booking or interview confirmation ───────────────────────────────
    if (norm === "YES" || norm === "Y") {
      if (pendingTask && pendingTask.data().type === "booking_confirmation") {
        await executeBookings(pendingTask.id, phone);
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

    // ── NO — booking declined or interview time rejected ──────────────────────
    if (norm === "NO" || norm === "N") {
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
                .where("interviewId", "==", pendingOutcome.interviewId).limit(1).get();
              if (!reqSnap.empty) caregiverId = reqSnap.docs[0].data().caregiverId ?? "";
            }
            await db.collection("agent_sessions").doc(phone).update({
              hireMode: { caregiverName: pendingOutcome.caregiverName, caregiverId },
              pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
            });
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
        });
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

    // ── Permission update ─────────────────────────────────────────────────────
    if (intent === "PERMISSION_UPDATE") {
      const userId   = session.userId ?? session.caregiverId ?? phone;
      const userType = session.userType ?? "client";
      await updatePermissionFromText(userId, userType, phone, chatId, text);
      return;
    }

    if (intent === "MEMORY_QUERY") {
      const zepUserId = getZepUserId(phone);
      const zepFacts = await searchZepMemory(zepUserId, text).catch(() => "");

      if (zepFacts) {
        await sendMessage(chatId,
          `Here's what I know about ${(session as any).seniorName ?? "your loved one"}:\n\n` + zepFacts
        );
      } else {
        const memUserId = session.userId ?? session.caregiverId ?? phone;
        const { handleMemoryQuery } = await import("../memory/memoryFiles");
        await handleMemoryQuery(memUserId, chatId, sendMessage);
      }
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
        await executeBookings(taskId, phone);
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
      await db.collection("agent_sessions").doc(phone).update({ hireModeDate: dateStr });
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
        await executeBookings(taskId, phone);
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
      });
      await sendMessage(chatId,
        `Got it — same schedule with ${caregiverName} (${startTime}–${endTime})?\n\n` +
        `What date should the visit be?`
      );
      return;
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
    });

    if (zepThreadId && qaReply) {
      addAssistantMessageToZep({
        threadId: zepThreadId,
        content:  qaReply,
      }).catch(console.error);
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

// ── Webhook HTTPS function ────────────────────────────────────────────────────

export const linqWebhook = functions.https.onRequest(async (req, res) => {
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

  // FIX 10 — deduplicate by event_id to prevent double-processing on retry
  const eventId: string | undefined = event.event_id ?? event.id;
  if (eventId && event.type === "message.received") {
    const logRef = db.collection("agent_event_log").doc(eventId);
    const existing = await logRef.get();
    if (existing.exists) return; // already processed
    await logRef.set({ processedAt: new Date().toISOString() });
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
      await db.collection("agent_reactions").add({
        chatId:    event.data?.chat?.id,
        messageId: event.data?.message_id,
        reaction:  event.data?.reaction,
        phone:     event.data?.sender_handle?.value,
        reactedAt: new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "chat.typing_indicator.started":
      await handleTypingStarted(event).catch((err) =>
        console.error("linqWebhook handleTypingStarted:", err)
      );
      break;

    default:
      break;
  }
});
