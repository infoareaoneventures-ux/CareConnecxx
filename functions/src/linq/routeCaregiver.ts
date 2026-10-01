import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { quickComplete } from "../utils/openaiClient";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate } from "../agents/caregiverProfileHandler";
import {
  createCaregiverReferralInvite,
  normalizeCaregiverReferralPhone,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";

const db = admin.firestore();

export interface CaregiverRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

interface PendingCaregiverReferral {
  referredName?:  string;
  referredPhone?: string;
  startedAt?:     string;
}

function normalizeReferralPhone(raw: string): string {
  return normalizeCaregiverReferralPhone(raw);
}

function extractPhoneFromText(text: string): string {
  const match = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return match ? normalizeReferralPhone(match[0]) : "";
}

// Name extraction is meaning-parsing of free-form text — CLAUDE.md mandates an
// LLM, never a keyword-strip heuristic. (Phone extraction stays regex: that is
// format detection, the explicitly-allowed exception, like email validation.)
async function extractReferralName(text: string): Promise<string> {
  const raw = await quickComplete(
    "Extract the referred caregiver's name from this text. If no name is present, reply with an empty string. Reply with only the name.",
    text,
    { maxTokens: 30 },
  ).catch(() => "");
  return raw.trim().replace(/^["']|["']$/g, "");
}

// Intent detection on free-form SMS — CLAUDE.md forbids regex/keyword matching
// here. The `norm` fast-path is allowed: it's the upstream LLM classifier's
// result, not a string heuristic. Everything else goes through the LLM.
async function isCaregiverReferralIntent(text: string, norm: string): Promise<boolean> {
  if (norm === "REFER" || norm === "REFERRAL") return true;
  const raw = await quickComplete(
    "Does this caregiver's message EXPLICITLY express intent to refer, invite, or recommend ANOTHER person " +
      "to become an Evia caregiver (e.g. \"I want to refer my friend\", \"can I invite someone\")? " +
      "A bare acknowledgment like \"yes\", \"no\", \"ok\", \"sure\", or \"sounds good\" is NOT referral intent — " +
      "it is an answer to some earlier question, so reply NO. " +
      "Reply YES only when the message itself names or clearly describes bringing in another person. " +
      "Reply only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "");
  return raw.trim().toUpperCase().startsWith("Y");
}

async function handleCaregiverReferral(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession,
  pending?: PendingCaregiverReferral,
): Promise<void> {
  // CLAUDE.md handler checklist: while collecting referral details, a mid-flow
  // question must not be misparsed as a name/phone. Detect it (LLM, not regex)
  // and re-ask the current question instead of extracting garbage from it.
  if (pending) {
    const qRaw = await quickComplete(
      "A caregiver is being asked for a referral's name and phone number. Is THIS message a question or off-topic, rather than a name/phone answer? Reply only YES or NO.",
      text,
      { maxTokens: 5 },
    ).catch(() => "");
    if (qRaw.trim().toUpperCase().startsWith("Y")) {
      const reAsk = pending.referredName
        ? `What phone number should I text for ${pending.referredName}?`
        : "Who should I invite? Send me their name.";
      await sendMessage(chatId, reAsk);
      return;
    }
  }

  const extractedPhone = extractPhoneFromText(text);
  const extractedName  = await extractReferralName(text);
  const next: PendingCaregiverReferral = {
    ...(pending ?? {}),
    ...(extractedName  ? { referredName: extractedName } : {}),
    ...(extractedPhone ? { referredPhone: extractedPhone } : {}),
    startedAt: pending?.startedAt ?? new Date().toISOString(),
  };

  if (!next.referredName) {
    await db.collection("agent_sessions").doc(phone).set({
      pendingCaregiverReferral: next,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, { merge: true });
    await sendMessage(chatId, "Who should I invite? Send me their name.");
    return;
  }

  if (!next.referredPhone) {
    await db.collection("agent_sessions").doc(phone).set({
      pendingCaregiverReferral: next,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, { merge: true });
    await sendMessage(chatId, `What phone number should I text for ${next.referredName}?`);
    return;
  }

  try {
    const referrerName = await resolveCaregiverReferralName(session.caregiverId, phone);
    const result = await createCaregiverReferralInvite({
      referrerUserId: session.caregiverId ?? session.userId ?? phone,
      referrerPhone: phone,
      referrerName,
      referredName: next.referredName,
      referredPhone: next.referredPhone,
      source: "cara_sms",
    });
    if (result.deliveryStatus === "sent") {
      await sendMessage(chatId, `Sent. I texted ${next.referredName} the caregiver application link.`);
    } else {
      await sendMessage(chatId, `I saved the referral, but I couldn't text ${next.referredName} yet. I flagged it for admin review.`);
    }
  } finally {
    await db.collection("agent_sessions").doc(phone).update({
      pendingCaregiverReferral: admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
  }
}

// ── Caregiver keyword handlers ────────────────────────────────────────────────

// (handleArrived — the ARRIVED keyword — was deleted 2026-09-28: it read and
// wrote the retired `appointments` collection, so it never found a visit. The
// page's Start Shift / Tasks / notes / End now run over text through
// agents/inShift.ts: START · DONE n · NOTE … · END.)

// (handleShiftConfirmation — the day-before YES/NO — was removed 2026-09-28:
// the site never asks a caregiver to re-confirm a visit they accepted. The
// day-before text is a plain reminder now; "can't make it" is the page's
// Cancel this shift only, over text.)

// ── Care plan briefing sent to caregiver at arrival ───────────────────────────

// (sendArrivalCarePlanBriefing and handleDone — the DONE keyword — were
// deleted 2026-09-28 with handleArrived: both were the retired appointments /
// care_plans pipeline. See agents/inShift.ts.)

// (handleRunningLate / handleIssue and the Evia-written family texts behind
// them were removed 2026-09-28 — see agents/familyRelay.ts: the caregiver's
// own words go into the shared Inbox thread, exactly like the Message button.
// The ISSUE pipeline (issue_log, admin alerts, follow-ups) is gone entirely.)

// (sendFamilyTaskUpdate / handleTaskAck / sendFamilyShiftEndUpdate /
// handleCareNotes — the task-nudge acks and the care-notes-after-DONE
// questionnaire with its family wrap-up and billing — were removed
// 2026-09-28. The page's Tasks, visit notes and End (closing note) live in
// agents/inShift.ts; timesheets are submitted the way the site does.)

// ── Caregiver inbound routing — extracted verbatim from webhooks.ts handleInbound ──
// Returns "handled" when the message was fully handled (handleInbound must return),
// or "fallthrough" when no caregiver path matched (handleInbound continues).
export async function routeCaregiverMessage(ctx: CaregiverRouteContext): Promise<"handled" | "fallthrough"> {
  const { phone, chatId, text, norm, session } = ctx;

    // (The texted job-invite yes/no state machine that used to own every reply
    // here for 48h was removed 2026-09-27, and the shift-offer YES/NO
    // interceptor (agents/shiftOffer.ts) on 2026-09-28 — the website has no
    // such flows; a booking is answered on the Requests tab.)

    // ── Jobs page forms as scripted flows (caregiverJobFlows.ts) ─────────────
    // The Apply modal and the interview Propose-new-time form, one question per
    // turn, back-out at any step, Submit/Send or Cancel at the end — checked
    // before any keyword/NLU so a short answer like "9/28 at 9am" is the
    // flow's answer, not something else's.
    for (const flow of ["applyFlowStep", "interviewRescheduleFlowStep", "logHoursFlowStep", "submitHoursFlowStep", "reviewCorrectionFlowStep"] as const) {
      if (!(session as any)[flow]) continue;
      const dataKey = flow.replace(/Step$/, "Data");
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          [flow]: admin.firestore.FieldValue.delete(), [dataKey]: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        await sendMessage(chatId, "That timed out — nothing was sent. Text me anytime to start again.");
        return "handled";
      }
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        if (flow === "logHoursFlowStep") {
          const { handleLogHoursFlowStep } = await import("../agents/caregiverPastBookings");
          await handleLogHoursFlowStep(phone, chatId, text, session);
        } else if (flow === "submitHoursFlowStep" || flow === "reviewCorrectionFlowStep") {
          // Payments › Timesheets: the Submit hours modal and the Review correction modal (agents/caregiverTimesheets.ts).
          const ts = await import("../agents/caregiverTimesheets");
          if (flow === "submitHoursFlowStep") await ts.handleSubmitHoursFlowStep(phone, chatId, text, session);
          else await ts.handleReviewCorrectionFlowStep(phone, chatId, text, session);
        } else {
          const flows = await import("../agents/caregiverJobFlows");
          if (flow === "applyFlowStep") await flows.handleApplyFlowStep(phone, chatId, text, session);
          else await flows.handleInterviewRescheduleFlowStep(phone, chatId, text, session);
        }
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return "handled";
    }

    // ── Decision notices (agents/decisionNotices.ts, 2026-09-27) ────────────
    // A notice that ended in "Reply ACCEPT or DECLINE" parked the expected
    // decision; a plain reply runs the page's own write here — no tool choice,
    // no id, no guessing. Anything else falls through with the decision parked.
    if ((session as any).pendingDecision) {
      const { handlePendingDecisionReply } = await import("../agents/decisionNotices");
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        if ((await handlePendingDecisionReply(phone, chatId, text, session as any)) === "handled") return "handled";
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
    }

    const pendingReferral = (session as any).pendingCaregiverReferral as PendingCaregiverReferral | undefined;
    if (pendingReferral) {
      const referralExpiry = (session as any).stateExpiresAt as string | undefined;
      if (referralExpiry && new Date(referralExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingCaregiverReferral: admin.firestore.FieldValue.delete(),
          stateExpiresAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleCaregiverReferral(phone, chatId, text, session, pendingReferral);
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }
    }

    if (await isCaregiverReferralIntent(text, norm)) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        await handleCaregiverReferral(phone, chatId, text, session);
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return "handled";
    }

    // ── In-shift keywords — START · DONE n · NOTE … · END · SKIP ──────────
    // The page's per-visit buttons over text (agents/inShift.ts): the start
    // text announced these exact words, so they're matched deterministically.
    if (session.caregiverId) {
      const { handleInShiftKeyword } = await import("../agents/inShift");
      const inShift = await handleInShiftKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (inShift === "handled") return "handled";
    }

    // ── FAMILIES · PAST FAMILIES · FAMILY n — the My Families page (agents/caregiverFamilies.ts) ──
    if (session.caregiverId) {
      const { handleFamiliesKeyword } = await import("../agents/caregiverFamilies");
      const fam = await handleFamiliesKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (fam === "handled") return "handled";
    }

    // ── CALENDAR · TODAY · TOMORROW · WEEK · NEXT WEEK · MONTH · INTERVIEW n — the My Calendar page (agents/caregiverCalendar.ts) ──
    if (session.caregiverId) {
      const { handleCalendarKeyword } = await import("../agents/caregiverCalendar");
      const cal = await handleCalendarKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (cal === "handled") return "handled";
    }

    // ── PAST · PAST VISITS · VISIT n · LOG n — the Past Bookings tab (agents/caregiverPastBookings.ts) ──
    if (session.caregiverId) {
      const { handlePastBookingsKeyword } = await import("../agents/caregiverPastBookings");
      const past = await handlePastBookingsKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (past === "handled") return "handled";
    }

    // ── TIMESHEETS · PENDING · HISTORY · REPORT · SUBMIT n · REVIEW n · DETAILS n · VIEW n — the Payments page's Timesheets tab (agents/caregiverTimesheets.ts) ──
    if (session.caregiverId) {
      const { handleTimesheetsKeyword } = await import("../agents/caregiverTimesheets");
      const ts = await handleTimesheetsKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (ts === "handled") return "handled";
    }

    // ── VISITS — the page's "Show more" on the Active Bookings card ──────────
    if (session.caregiverId && norm === "VISITS") {
      const { sendCaregiverActiveBookings } = await import("../agents/caregiverActiveBookings");
      await sendCaregiverActiveBookings(phone, chatId, session.caregiverId, { allVisits: true });
      return "handled";
    }

    // ── LATE — the caregiver's own words to the family (agents/familyRelay.ts) ──
    if (session.caregiverId) {
      const { handleLateKeyword } = await import("../agents/familyRelay");
      const late = await handleLateKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (late === "handled") return "handled";
    }

    const KEYWORDS: Record<string, () => Promise<void>> = {
      // CANCEL — the Bookings page's two cancel buttons as a scripted flow
      // (agents/caregiverCancelShiftHandler.ts). A certain door: the flow lists
      // what the page lets them cancel and asks the page's own dialog. (Inside a
      // parked step CANCEL still means back out — those steps run before this.)
      CANCEL: async () => {
        if (!session.caregiverId) return;
        const cgDoc = await db.collection("caregivers").doc(session.caregiverId).get().catch(() => null);
        await handleCaregiverCancelShift(session.caregiverId, cgDoc?.data()?.name ?? "Caregiver", phone, text, session as unknown as Record<string, unknown>, chatId);
      },
      // (CONFIRM keyword/NLU removed 2026-09-27: it wrote the legacy appointments
      // collection the site has no button for, and swallowed interview replies
      // like "9/28 at 9am" with "Got it — confirmed!" before the agent saw them.
      // A booking request is accepted with respond_to_booking_request, an
      // interview with respond_to_interview_request — exactly the site's buttons.)
      // (RESCHEDULE and PASS keyword acks removed 2026-09-27: they wrote
      // nothing and told the caregiver times were "sent" / a request was
      // "passed" on. Moving an interview or a visit is a real tool call now —
      // reschedule_interview / manage_shift_reschedule — and declining a
      // request is respond_to_interview_request, exactly like the site.)
      PAYOUT:     async () => {
        if (!session.caregiverId) {
          await sendMessage(chatId, "I couldn't find your caregiver profile. Send the email you used to sign up and I'll try again.");
          return;
        }
        const { startInstantPayout } = await import("../agents/instantPayoutHandler");
        await startInstantPayout(session.caregiverId, phone, chatId);
      },
      REACTIVATE: async () => {
        if (!session.caregiverId) return;
        await handleCaregiverProfileUpdate(
          session.caregiverId,
          phone,
          text,
          session as unknown as Record<string, unknown>,
          chatId,
          "reactivate",
        );
      },
    };

    // CANCEL is a carrier opt-out word on plain SMS (CTIA: STOP/END/CANCEL/UNSUBSCRIBE/QUIT), so the
    // announced door is the two-word CANCEL SHIFT; the bare word still opens the flow if it reaches us.
    const CANCEL_PHRASES = new Set(["CANCEL SHIFT", "CANCEL VISIT", "CANCEL BOOKING", "CANCEL MY SHIFT", "CANCEL A SHIFT", "CANCEL MY BOOKING", "CANCEL MY VISIT"]);
    if (CANCEL_PHRASES.has(norm)) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try { await KEYWORDS.CANCEL(); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return "handled";
    }

    if (norm in KEYWORDS) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {/* non-critical */});
      try { await KEYWORDS[norm](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return "handled";
    }

    // Caregiver rescheduling — parse new times and acknowledge.
    // 2026-09-09: this used to look up a live interview_requests doc (status
    // scheduled/awaiting_client_confirmation) to actually relay the caregiver's
    // times to the family — but nothing has created such a doc since
    // schedule_interview/video_interviews became the only interview path
    // (2026-09-07), so reqSnap was always empty and that branch was already
    // dead. The unconditional ack below is exactly what always ran regardless;
    // removing the dead query changes no observable behavior.
    // A legacy caregiverRescheduling flag (the removed RESCHEDULE ack) no
    // longer owns the next text — clear it and route normally.
    if ((session as any).caregiverRescheduling) {
      await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() }).catch(() => {});
    }

    // (Removed 2026-07-15: a pendingInterviewAvailabilityRequest consumer sat
    // here, but NOTHING in production sets that flag — only a test seeded it.
    // A flag with no setter and no expiry was one hijack away from consuming
    // every inbound text.)

    // ── Caregiver-initiated shift cancellation — multi-step state machine ─
    if ((session as any).cancelStep) {
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          cancelStep:          admin.firestore.FieldValue.delete(),
          cancelCandidates:    admin.firestore.FieldValue.delete(),
          cancelShiftId:       admin.firestore.FieldValue.delete(),
          cancelShiftDate:     admin.firestore.FieldValue.delete(),
          cancelShiftClientId: admin.firestore.FieldValue.delete(),
          stateExpiresAt:      admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
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
        return "handled";
      }
    }

    // ── Profile update flow (rate / skills / bio / photo / pause / reactivate)
    if ((session as any).profileUpdateStep) {
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          profileUpdateStep:  admin.firestore.FieldValue.delete(),
          profileUpdateField: admin.firestore.FieldValue.delete(),
          profileUpdateValue: admin.firestore.FieldValue.delete(),
          stateExpiresAt:     admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else if (session.caregiverId) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleCaregiverProfileUpdate(
            session.caregiverId,
            phone,
            text,
            session as unknown as Record<string, unknown>,
            chatId,
          );
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }
    }

    // ── PAYOUT instant-payout YES/NO confirmation ──────────────────────────
    if ((session as any).pendingInstantPayoutConfirm) {
      const setAt = (session as any).pendingInstantPayoutConfirm as string;
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      if (setAt < tenMinAgo) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(),
          pendingInstantPayoutAmount:  admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        const { handleInstantPayoutConfirm } = await import("../agents/instantPayoutHandler");
        await handleInstantPayoutConfirm(
          session.caregiverId ?? phone,
          phone,
          text,
          chatId,
        );
        return "handled";
      }
    }

    // ── "running about 10 minutes late" in plain words → relayed verbatim ──
    // Only LATE is inferred here (2026-09-28): arriving / finishing a visit is
    // start_shift / complete_shift through the agent, and ISSUE is gone.
    if (session.caregiverId) {
      const lateRaw = await quickComplete(
        "Classify this caregiver message: LATE if they are telling someone they're running late / delayed on the way to a visit " +
          "(e.g. 'running about 10 min late', 'stuck in traffic, be there by 2:15'). Anything else is NONE. Reply with exactly one word.",
        text,
        { maxTokens: 5 },
      ).catch(() => "");
      if (lateRaw.trim().toUpperCase() === "LATE") {
        const { relayLateSentence } = await import("../agents/familyRelay");
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try { await relayLateSentence(phone, chatId, session.caregiverId, text); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
        return "handled";
      }
    }

  return "fallthrough";
}
