import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { isStateExpired, clearFlags } from "../utils/sessionState";
import { quickComplete } from "../utils/openaiClient";
import { handleJobPostingStep } from "../agents/jobPostingFlow";
import { handleBookingFlowStep } from "../agents/bookingFlow";
import { handleReplacementFlowStep } from "../agents/replacementFlow";
import { handleRescheduleFlowStep } from "../agents/rescheduleFlow";
import { handleVisitRequestFlowStep } from "../agents/visitRequestFlow";
import { handleCorrectionFlowStep } from "../agents/correctionFlow";
import { handleCancelFlowStep } from "../agents/cancelFlow";
import { handleInterviewFlowStep } from "../agents/interviewFlow";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";

const db = admin.firestore();

export interface ClientRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

// ── Pre-shift family task check-in handler ───────────────────────────────────

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
      // The Timesheets modal has no "dispute" from Needs Review — the family
      // proposes a corrected start/end (propose_correction) and the caregiver
      // accepts or counters. Point them there; review_shift_hours makes that
      // same write. (The old admin_alerts "dispute" + free-text detail was an
      // Evia-only path — removed 2026-09-17.)
      await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId,
        `No problem — tell me the correct clock-in and clock-out times for ${caregiverName as string}'s visit and I'll send that correction to them to accept (they have 24 hours before it auto-accepts).`
      );
      return "handled";
    }
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
    return "handled";
  }

  // Credential collection (portal-login capture for the real-world healthcare
  // flow) was removed 2026-09-05 along with the flow itself — collectingCredential
  // can no longer be set, so there's nothing left to handle here.

  // ── Job posting flow — multi-step state machine for returning clients ───────
  if ((session as any).jobPostingStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["jobPostingStep", "jobPostingData", "stateExpiresAt"]);
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

  // ── Booking flow — multi-step state machine (2026-09-13) ────────────────────
  // Captures every reply deterministically once started (start_booking_flow),
  // exactly like jobPostingStep above — this is what protects the flow from
  // an in-progress reply ("are you there") being hijacked by intent
  // classification (e.g. a FACT_CORRECTION misfire) before it ever reaches
  // the flow's own step handler. See bookingFlow.ts.
  if ((session as any).bookingFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["bookingFlowStep", "bookingFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your booking session timed out. Text me anytime to start a new one!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleBookingFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Shift-replacement flow — multi-step state machine (2026-09-14) ─────────
  // Same protection as bookingFlowStep above. Mirrors the website's Find
  // Replacement modal step for step (candidates + keep/change the visit's
  // date/time → pick → recap → YES → replacement booking request). Built
  // after a live test where the free-form agent loop routed "who is
  // available for replacement" into a caregiver search and then an
  // interview, and a bare "yes" got hijacked mid-way. See replacementFlow.ts.
  if ((session as any).replacementFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["replacementFlowStep", "replacementFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your replacement session timed out. Text me anytime to pick it back up!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleReplacementFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Visit-reschedule flow — multi-step state machine (2026-09-15) ──────────
  // Same protection as replacementFlowStep above. Mirrors the website's
  // Reschedule button on an upcoming shift step for step (real visit list →
  // pick → new day/time → own-visit conflict check → recap → YES →
  // reschedulePending* write). Built after a live test where the free-form
  // loop moved the WRONG visit and a plain "9/17 10am to 3pm" reply got
  // hijacked by the memory-correction detector. See rescheduleFlow.ts.
  if ((session as any).rescheduleFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["rescheduleFlowStep", "rescheduleFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your reschedule session timed out. Text me anytime to pick it back up!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleRescheduleFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Cancel flow — multi-step state machine (2026-09-17) ────────────────────
  // The My Bookings page's cancel buttons step for step (what can be
  // cancelled → which one → the site's confirm wording → YES → the site's
  // write). See cancelFlow.ts.
  if ((session as any).cancelFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["cancelFlowStep", "cancelFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your cancel request timed out — nothing was cancelled. Text me anytime to pick it back up!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleCancelFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Request Visit flow — multi-step state machine (2026-09-16) ─────────────
  // The website's Calendar "+ Request Visit" modal, step for step (caregiver →
  // booking → days → per-day times with the modal's availability checks →
  // start → ongoing/end → note → recap → YES → booking_amendments). See
  // visitRequestFlow.ts.
  if ((session as any).correctionFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["correctionFlowStep", "correctionFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your timesheet correction timed out — the hours are still waiting for your review. Text me anytime to pick it back up!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleCorrectionFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  if ((session as any).visitRequestFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["visitRequestFlowStep", "visitRequestFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your visit request timed out. Text me anytime to pick it back up!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleVisitRequestFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // ── Interview flow — multi-step state machine (2026-09-13) ──────────────────
  // Same protection as bookingFlowStep above (start_interview_flow) — built
  // after a live SMS test showed schedule_interview had NONE at all: asking
  // "can you link to a job post" mid-scheduling misfired the intent
  // classifier into jobPostingFlow.ts entirely, with no way back. See
  // interviewFlow.ts.
  if ((session as any).interviewFlowStep) {
    if (isStateExpired(session)) {
      await clearFlags(phone, db, ["interviewFlowStep", "interviewFlowData", "stateExpiresAt"]);
      await sendMessage(chatId, "Your interview session timed out. Text me anytime to start a new one!");
      return "handled";
    }
    if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
    try {
      await handleInterviewFlowStep(phone, chatId, text, session);
    } finally {
      if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
    }
    return "handled";
  }

  // Real-world healthcare/browser-automation actions were removed 2026-09-05
  // (no site equivalent) — healthcareFlowStep can no longer be set, so there's
  // nothing left to resume here. The recurring-schedule modification flow
  // (modifyScheduleFlow.ts) was removed 2026-09-13 for the same reason —
  // modifyScheduleStep can no longer be set either.

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

  return "fallthrough";
}
