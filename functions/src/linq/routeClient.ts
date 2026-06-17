import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { handleJobPostingStep } from "../agents/jobPostingFlow";
import { handleModifyScheduleStep } from "../agents/modifyScheduleFlow";
import { handleRefundRequest } from "../agents/refundHandler";
import { handleTimesheetApproval } from "../agents/timesheetHandler";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";
import { handleClientSwapRequest } from "../agents/clientSwapRequestHandler";

const db = admin.firestore();

export interface ClientRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

// ── Pre-shift family task check-in handler ───────────────────────────────────

async function handlePreShiftUpdate(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  const info = (session as any).awaitingPreShiftUpdate as {
    appointmentId: string;
    caregiverName: string;
    seniorName:    string;
  };


  // isQuestionOrOther check — CLAUDE.md requirement
  const questionRaw = await quickComplete(
    "Is this message a question unrelated to adding care tasks, or is it about something completely different? " +
      "Reply only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "");

  const isQuestion = questionRaw.trim().toUpperCase().startsWith("Y");

  if (isQuestion) {
    // Generate the answer inline so we control message ordering. The previous
    // implementation sent the raw user text to sendViaInteractionAgent (which
    // generates a reply asynchronously) and immediately followed with the
    // re-ask, so the re-ask could arrive before the answer.
    let answer = "";
    try {
      answer = await quickComplete(
        "You are Cara, an AI care assistant. A family member was asked if they want to add tasks for today's " +
        `visit with ${info.caregiverName ?? "the caregiver"} for ${info.seniorName}. Instead they asked a question — ` +
        "answer it briefly (1–2 sentences). Do NOT ask them to add tasks — that prompt comes next.",
        text,
        { maxTokens: 180 },
      );
    } catch {
      answer = "Let me get back to you on that. In the meantime —";
    }
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      `So — did you want to add any tasks for ${info.seniorName}'s visit today?`
    );
    return;
  }

  // Parse action: decline or new tasks
  const parseRaw = await quickComplete(
    "The family was asked if they want to add tasks to today's care visit. " +
      "Extract their response. Reply JSON only: " +
      '{"action":"decline"|"addTasks","tasks":["task description 1","task description 2"]}. ' +
      '"decline" means they said no, nothing to add, or the plan is fine. ' +
      '"addTasks" means they listed one or more things they want done.',
    text,
    { maxTokens: 200 },
  ).catch(() => "{}");

  let action = "decline";
  let tasks: string[] = [];
  try {
    const parsed = JSON.parse(parseRaw || "{}");
    action = (parsed.action ?? "decline") as string;
    tasks  = Array.isArray(parsed.tasks) ? (parsed.tasks as string[]).filter(Boolean) : [];
  } catch { /* default to decline */ }

  // Clear state regardless of action
  await db.collection("agent_sessions").doc(phone).update({
    awaitingPreShiftUpdate: admin.firestore.FieldValue.delete(),
    stateExpiresAt:         admin.firestore.FieldValue.delete(),
  });

  if (action === "addTasks" && tasks.length > 0) {
    // Store on the appointment as dayOfVisitTasks
    await db.collection("appointments").doc(info.appointmentId).update({
      dayOfVisitTasks: admin.firestore.FieldValue.arrayUnion(...tasks),
    });

    const cgFirstName = info.caregiverName.split(" ")[0] || info.caregiverName;
    const taskList    = tasks.map(t => `• ${t}`).join("\n");
    const addMsg = await generateCaraMessage({
      audience: "family",
      context:
        `The family just added ${tasks.length} task${tasks.length > 1 ? "s" : ""} to ` +
        `${info.seniorName}'s care visit today: ${tasks.join(", ")}. ` +
        `${cgFirstName} will be notified when they check in. ` +
        `Write a warm 2-sentence confirmation back to the family. ` +
        `List what was added and reassure them ${cgFirstName} will have it.`,
      fallback:
        `Got it — I've added ${tasks.length === 1 ? "that" : "those"} to today's plan:\n\n` +
        `${taskList}\n\n` +
        `${cgFirstName} will see ${tasks.length === 1 ? "it" : "them"} when they check in.`,
    });
    await sendMessage(chatId, addMsg);
  } else {
    const declineMsg = await generateCaraMessage({
      audience: "family",
      context:
        `The family said no additional tasks for ${info.seniorName}'s care visit today — ` +
        `the regular care plan is all set. Write a brief, warm 1-sentence confirmation back to them.`,
      fallback: `Perfect — the regular care plan is all set for today's visit!`,
      maxTokens: 60,
    });
    await sendMessage(chatId, declineMsg);
  }
}

// Extract a contact's name + phone from free-form prose. Deciding which token
// is the name is intent parsing → use the LLM, not a regex split. Phone-format
// detection (digits) is still fine for validation.
export async function extractContactNameAndPhone(
  text: string,
): Promise<{ name: string | null; phone: string | null }> {
  const raw = await quickComplete(
    "Extract the contact's name and phone number from this message. " +
      'Reply with JSON only: {"name":"...","phone":"..."}. ' +
      "name=null if no name is present; phone=null if no phone is present. Keep the phone digits as written.",
    text,
    { maxTokens: 60 },
  ).catch(() => "{}");
  try {
    const parsed = JSON.parse(raw || "{}");
    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
    const phoneRaw = typeof parsed.phone === "string" ? parsed.phone : "";
    const digits = phoneRaw.replace(/[^\d+]/g, "");
    const phone = digits.replace(/\D/g, "").length >= 10 ? digits : null;
    return { name, phone };
  } catch {
    const trimmed = text.trim();
    const looksPhone = /^[+(]?[\d\s().+-]{10,}$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 10;
    return { name: null, phone: looksPhone ? trimmed.replace(/[^\d+]/g, "") : null };
  }
}

// ── Client-side pre-intent state machines — extracted verbatim from webhooks.ts
// handleInbound. Returns "handled" when the message was fully handled
// (handleInbound must return), or "fallthrough" when no state machine matched
// (handleInbound continues to intent routing). NOTE: this sequence is NOT
// wrapped in a userType check — some blocks (e.g. timesheetStep,
// availabilityStep) run for caregivers too; healthcareFlowStep checks
// userType internally. Preserve those internal conditions exactly.
export async function routeClientStateMachines(ctx: ClientRouteContext): Promise<"handled" | "fallthrough"> {
  const { phone, chatId, text, norm, session } = ctx;

  // ── Pre-shift family task check-in reply ────────────────────────────────────
  if ((session as any).awaitingPreShiftUpdate) {
    const psExpiry = (session as any).stateExpiresAt as string | undefined;
    if (psExpiry && new Date(psExpiry) < new Date()) {
      await db.collection("agent_sessions").doc(phone).update({
        awaitingPreShiftUpdate: admin.firestore.FieldValue.delete(),
        stateExpiresAt:         admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    } else {
      await handlePreShiftUpdate(phone, chatId, text, session);
      return "handled";
    }
  }

  // ── Emergency contact capture — family replies with EC name + phone ──────────
  if ((session as any).awaitingEmergencyContactUpdate) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingEmergencyContactUpdate: admin.firestore.FieldValue.delete(),
    });
    // Extract name + phone with the LLM rather than regex-splitting which token
    // is the name (parsing meaning from prose). Phone-FORMAT detection is still
    // fine for validation, but deciding "which part is the name" is intent.
    const { name: ecName, phone: ecPhone } = await extractContactNameAndPhone(text);
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
    return "handled";
  }

  // ── Shift hours APPROVE / DISPUTE (client iMessage reply) ───────────────────
  // Clear stale pending approvals (>72h old) so APPROVE/DISPUTE replies don't
  // hit a long-resolved shift.
  if ((session as any).pendingShiftApproval) {
    const setAt = (session as any).pendingShiftApprovalSetAt as string | undefined;
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    if (setAt && setAt < seventyTwoHoursAgo) {
      await db.collection("agent_sessions").doc(phone).update({
        pendingShiftApproval:      admin.firestore.FieldValue.delete(),
        pendingShiftApprovalSetAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      (session as any).pendingShiftApproval = undefined;
    }
  }
  if ((session as any).pendingShiftApproval && (norm === "APPROVE" || norm.startsWith("DISPUTE"))) {
    if ((session as any).isSecondaryMember) {
      await sendMessage(chatId, "I can keep you updated here, but the primary account holder has to approve or dispute payment.");
      return "handled";
    }
    const { appointmentId, amount, caregiverName } = (session as any).pendingShiftApproval;
    if (norm === "APPROVE") {
      const { approveShiftHoursForClient } = await import("../shiftHours");
      await approveShiftHoursForClient(appointmentId as string);
      const { logAgentAction } = await import("../observability/actionLedger");
      logAgentAction({
        actionType: "shift_hours_approved",
        status: "executed",
        userId: session.userId ?? phone,
        phone,
        role: "client",
        targetCollection: "shiftHours",
        targetDocId: appointmentId as string,
        metadata: { amount, caregiverName, source: "cara_sms" },
      }).catch(() => {});
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
      const { logAgentAction } = await import("../observability/actionLedger");
      logAgentAction({
        actionType: "shift_hours_disputed",
        status: "executed",
        userId: session.userId ?? phone,
        phone,
        role: "client",
        targetCollection: "admin_alerts",
        targetDocId: alertRef.id,
        metadata: { appointmentId, amount, caregiverName, source: "cara_sms" },
      }).catch(() => {});
      await sendMessage(chatId,
        `Got it — flagged for review. Our team will follow up within 24 hours.\n\n` +
        `What looks wrong with the hours? (reply to add details, or just ignore this message)`
      );
      return "handled";
    }
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
    return "handled";
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
    return "handled";
  }

  // ── Credential collection (portal logins) ─────────────────────────────────
  // Must run before intent classification — password messages must not be logged.
  if ((session as unknown as Record<string, unknown>).collectingCredential) {
    const { handleCredentialReply } = await import("../browser/credentialCollector");
    const handled = await handleCredentialReply({
      phone,
      userId: session.userId ?? "",
      text,
      session: session as unknown as Record<string, unknown>,
    });
    if (handled) return "handled";
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
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleJobPostingStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Recurring schedule modification flow ─────────────────────────────────
  if ((session as any).modifyScheduleStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleModifyScheduleStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Healthcare agentic flow — provider search, appt booking, Rx refill ────
  if ((session as any).healthcareFlowStep && session.userType !== "caregiver") {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      const { resumeHealthcareFlow } = await import("../agents/healthcareHandler");
      await resumeHealthcareFlow(phone, chatId, text, session, (msg) => sendMessage(chatId, msg));
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Refund self-service flow (multi-step state machine) ───────────────────
  if ((session as any).refundStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      const refundClientId = ((session as any).userId ?? phone) as string;
      await handleRefundRequest(
        refundClientId,
        text,
        session as unknown as Record<string, unknown>,
        (msg: string) => sendMessage(chatId, msg)
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Timesheet approval flow (multi-step state machine) ───────────────────
  // Drop stale timesheet state (>7 days) so old APPROVE/DISPUTE prompts don't
  // hijack unrelated future replies.
  if ((session as any).timesheetStep) {
    const setAt = (session as any).pendingTimesheetSetAt as string | undefined;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    if (setAt && setAt < sevenDaysAgo) {
      await db.collection("agent_sessions").doc(phone).update({
        timesheetStep:         admin.firestore.FieldValue.delete(),
        pendingTimesheetId:    admin.firestore.FieldValue.delete(),
        pendingTimesheetDesc:  admin.firestore.FieldValue.delete(),
        pendingTimesheetQueue: admin.firestore.FieldValue.delete(),
        pendingTimesheetSetAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      (session as any).timesheetStep = undefined;
    }
  }
  if ((session as any).timesheetStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleTimesheetApproval(
        (session.userId ?? phone) as string,
        phone,
        text,
        session as unknown as Record<string, unknown>,
        (msg: string) => sendMessage(chatId, msg)
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Availability update flow (multi-step state machine) ──────────────────
  if ((session as any).availabilityStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleAvailabilityUpdate(
        (session.caregiverId ?? session.userId ?? phone) as string,
        phone,
        text,
        session as unknown as Record<string, unknown>,
        (msg: string) => sendMessage(chatId, msg)
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Client caregiver swap flow — multi-step state machine ───────────────
  if ((session as any).clientSwapStep) {
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleClientSwapRequest(
        session.userId ?? phone,
        phone,
        text,
        session as unknown as Record<string, unknown>,
        chatId
      );
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  return "fallthrough";
}
