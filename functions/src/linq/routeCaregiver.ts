import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { quickComplete } from "../utils/openaiClient";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate } from "../agents/caregiverProfileHandler";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";

const db = admin.firestore();

// ── Parked page flows (2026-10-11) ───────────────────────────────────────────
// A modal the caregiver is in the middle of over text: the Cash Out modal
// (instantPayoutHandler), the Cancel-shift dialog (caregiverCancelShiftHandler),
// a My Profile section editor (caregiverProfileHandler) and the Update
// Availability modal (availabilityHandler). While one is parked, the reply is
// THAT modal's answer — resumed before any page keyword, exactly like the
// scripted flows above it. Live before this: CASH OUT ran the PAYOUTS keyword
// first and re-opened the modal it was answering (the confirm was unreachable
// except via YES / SEND / CONFIRM), and a bare CANCEL opened the Cancel-shift
// flow on top of the parked one. The expiry rules are each flow's own.
type ParkedFlow = "pendingInstantPayoutConfirm" | "cancelStep" | "profileUpdateStep" | "availabilityStep";
const PARKED_FLOW_ORDER: readonly ParkedFlow[] = ["pendingInstantPayoutConfirm", "cancelStep", "profileUpdateStep", "availabilityStep"];
// Each flow's own session fields (what its handler's clear() deletes).
const PARKED_FLOW_FLAGS: Record<ParkedFlow, readonly string[]> = {
  pendingInstantPayoutConfirm: ["pendingInstantPayoutConfirm", "pendingInstantPayoutAmount"],
  cancelStep:                  ["cancelStep", "cancelCandidates", "cancelShiftId", "cancelKind", "cancelShiftDate", "cancelShiftClientId", "cancelReason", "stateExpiresAt"],
  profileUpdateStep:           ["profileUpdateStep", "profileUpdateField", "profileUpdateValue", "stateExpiresAt"],
  availabilityStep:            ["availabilityStep", "pendingAvailability", "pendingDays", "pendingAction", "stateExpiresAt"],
};
async function clearParkedFlow(phone: string, flow: ParkedFlow): Promise<void> {
  const update: Record<string, admin.firestore.FieldValue> = {};
  for (const f of PARKED_FLOW_FLAGS[flow]) update[f] = admin.firestore.FieldValue.delete();
  await db.collection("agent_sessions").doc(phone).update(update).catch(() => {});
}
// The flow's own "nothing changed" line — the same sentence its handler sends on
// a back-out, so CANCEL reads the same at every step of that flow.
const PARKED_FLOW_CANCEL_LINE: Partial<Record<ParkedFlow, string>> = {
  profileUpdateStep: "No problem — your profile wasn't changed.",
  availabilityStep:  "Okay — your availability wasn't changed.",
};

function parkedFlowExpired(flow: ParkedFlow, session: AgentSession): boolean {
  if (flow === "pendingInstantPayoutConfirm") {
    // Parked with its own ISO stamp and a 10-minute life (no stateExpiresAt).
    const setAt = String((session as any).pendingInstantPayoutConfirm ?? "");
    return setAt < new Date(Date.now() - 10 * 60 * 1000).toISOString();
  }
  const expiry = (session as any).stateExpiresAt as string | undefined;
  return !!expiry && new Date(expiry) < new Date();
}

export interface CaregiverRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

// ── Caregiver keyword handlers ────────────────────────────────────────────────

// (handleArrived — the old ARRIVED handler — was deleted 2026-09-28: it read and
// wrote the retired `appointments` collection, so it never found a visit. The
// page's Start Shift / Tasks / notes / End now run over text through
// agents/inShift.ts: START (ARRIVED is still accepted there as its alias) ·
// DONE n · UNDO n · NOTE … · TASKS · FINISH · SKIP.)

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

    // ── Parked page flows — Cash Out · Cancel shift · Profile editor · Update Availability ──
    // (see PARKED_FLOW_* above). The flow's reply words (CASH OUT / SAVE / YES /
    // a number) are its answer; a bare CANCEL — and NO where the flow offered it
    // — backs out of THAT flow with its own one-line "nothing changed" (the Cash
    // Out and Cancel-shift handlers own that line themselves; the profile editor
    // and availability modal don't accept CANCEL at every step, so it is handled
    // here for them). Only with nothing parked does CANCEL open the cancel-shift
    // flow below.
    for (const flow of PARKED_FLOW_ORDER) {
      if (!(session as any)[flow]) continue;
      if (parkedFlowExpired(flow, session)) {
        await clearParkedFlow(phone, flow);
        continue; // the stale flag is gone; nothing to answer — route the text normally
      }
      if (flow === "availabilityStep" && !session.caregiverId && !session.userId) continue;
      if (flow === "profileUpdateStep" && !session.caregiverId) continue;
      if (norm === "CANCEL" && PARKED_FLOW_CANCEL_LINE[flow]) {
        await clearParkedFlow(phone, flow);
        await sendMessage(chatId, PARKED_FLOW_CANCEL_LINE[flow] as string);
        return "handled";
      }
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        if (flow === "pendingInstantPayoutConfirm") {
          const { handleInstantPayoutConfirm } = await import("../agents/instantPayoutHandler");
          await handleInstantPayoutConfirm(session.caregiverId ?? phone, phone, text, chatId);
        } else if (flow === "cancelStep") {
          const cgDoc = session.caregiverId ? await db.collection("caregivers").doc(session.caregiverId).get().catch(() => null) : null;
          await handleCaregiverCancelShift(session.caregiverId ?? phone, cgDoc?.data()?.name ?? "Caregiver", phone, text, session as unknown as Record<string, unknown>, chatId);
        } else if (flow === "profileUpdateStep") {
          await handleCaregiverProfileUpdate(session.caregiverId as string, phone, text, session as unknown as Record<string, unknown>, chatId);
        } else {
          await handleAvailabilityUpdate((session.caregiverId ?? session.userId ?? phone) as string, phone, text, session as unknown as Record<string, unknown>, (msg: string) => sendMessage(chatId, msg));
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

    // ── In-shift keywords — START · DONE n · NOTE … · END · SKIP ──────────
    // The page's per-visit buttons over text (agents/inShift.ts): the start
    // text announced these exact words, so they're matched deterministically.
    if (session.caregiverId) {
      const { handleInShiftKeyword } = await import("../agents/inShift");
      const inShift = await handleInShiftKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (inShift === "handled") return "handled";
    }

    // ── Visit mode — free text while a visit is IN PROGRESS (agents/visitMode.ts, 2026-10-07) ──
    // Read against the open visit before any other page's keywords, flow or the
    // intent classifier can claim it ("I'm done with the visit" used to become
    // CANCEL_SHIFT). Tasks / notes / finish / a question about the visit are
    // handled here; anything outside the visit falls through as before. With
    // no visit open, an arrival inside the Start window starts the visit.
    if (session.caregiverId) {
      const { handleVisitModeMessage } = await import("../agents/visitMode");
      const vm = await handleVisitModeMessage(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (vm === "handled") return "handled";
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

    // ── PROFILE · PHOTO · BIO · LANGUAGES · SERVICES · RATES · LOOKING FOR · AVAILABILITY · TRAVEL — the My Profile page (agents/caregiverMyProfile.ts) ──
    if (session.caregiverId) {
      const { handleMyProfileKeyword } = await import("../agents/caregiverMyProfile");
      const mp = await handleMyProfileKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (mp === "handled") return "handled";
    }

    // ── SETTINGS · RESEND EMAIL LINK · PAUSE [date] · REACTIVATE — the Account Settings page (agents/caregiverSettings.ts) ──
    if (session.caregiverId) {
      const { handleSettingsKeyword } = await import("../agents/caregiverSettings");
      const st = await handleSettingsKeyword(phone, chatId, session.caregiverId, text);
      if (st === "handled") return "handled";
    }

    // ── MEMBERSHIP · MANAGE MEMBERSHIP · ACTIVATE · AUTHORIZE — Settings › Membership & verification (agents/caregiverMembership.ts) ──
    if (session.caregiverId) {
      const { handleMembershipKeyword } = await import("../agents/caregiverMembership");
      const mb = await handleMembershipKeyword(phone, chatId, session.caregiverId, text);
      if (mb === "handled") return "handled";
    }

    // ── PAYOUTS · PAYOUT HISTORY · CASH OUT · SETUP · MORE — the Payments page's Payouts tab (agents/caregiverPayouts.ts) ──
    if (session.caregiverId) {
      const { handlePayoutsKeyword } = await import("../agents/caregiverPayouts");
      const po = await handlePayoutsKeyword(phone, chatId, session.caregiverId, text, session as unknown as Record<string, unknown>);
      if (po === "handled") return "handled";
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
      // parked flow CANCEL means back out — the parked-page-flows block and the
      // scripted flows at the top of this router run before this.)
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

    // (The Cancel-shift, profile-editor and Cash Out confirm resumes that used to
    // sit here — AFTER the page keywords — moved to the parked-page-flows block
    // at the top of this router on 2026-10-11; see PARKED_FLOW_ORDER.)

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
