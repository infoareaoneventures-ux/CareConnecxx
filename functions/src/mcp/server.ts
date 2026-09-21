import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { requestVideoInterview, VideoInterviewRequestError, resolveCaregiverForInterview } from "../agents/videoInterviewRequest";
import { logHealthDataAccessed, logAudit } from "../observability/auditLog";
import {
  readMemoryFile,
  writeMemoryFile,
  editMemoryFile,
  deleteMemoryFile,
  searchMemoryHybrid,
  getMemoryContext,
  listMemoryFiles,
  isTransientToolFile,
  MemoryFile,
  MEMORY_QUERY_RECONCILIATION_COPY,
} from "../memory/memoryFiles";
import { getPreferences } from "../memory/preferences";
import { isHighRisk, proposePendingAction, buildPendingActionStub, getPendingActionById, isConfirmedActionValid } from "../agents/pendingActions";
import { claimToolExecution, settleToolExecution, toolExecutionKey } from "./toolExecutionLedger";
import { pauseCaregiver, reactivateCaregiver } from "../agents/pauseAccount";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { apptStartMs, businessTodayStr, parseScheduledTimeMs, formatInterviewTime, formatDateForDisplay, formatHHMMForDisplay, weekdayForDate } from "../utils/scheduledTime";
import { loadReschedulableShift, proposeShiftReschedule, isShiftOverdue, shiftDisplayStatus, acceptRescheduleProposal, clearRescheduleProposal } from "../agents/shiftReschedule";
import { listActiveBookings } from "../agents/activeBookings";
import { listClientInterviews } from "../agents/interviewsTab";
import { presentCaregiverSearch, searchCaregivers } from "../agents/caregiverSearch";
import {
  readCarePlanPage, resolveRecipient, savePlanSection, setRecipientLocation, addRecipient, removeRecipient,
  saveEmergencyContacts, confirmCarePlanReviewed, toCareType, CARE_NEED_SUBS,
} from "../agents/carePlanPage";
import { cancelVisit, cancelWholeBooking, cancelPendingRequest, cancelPendingAmendment, withdrawReplacementRequest } from "../agents/bookingCancel";
import { createScheduleAmendment, loadCaregiverAvailability, checkVisitBlock, normDayAbbr, blockToRange, describeBlock, describeRange, ABBR_TO_FULL as VISIT_DAY_FULL, type TimeBlock as VisitTimeBlock } from "../agents/visitRequest";
import { bookedWindowMillis, createValidatedShiftHours, ValidatedShiftHoursError } from "../billing/createValidatedShiftHours";
import { resetShiftPaymentForRetry } from "../billing/shiftPaymentRetry";
import { getSeniorProfileWithSource } from "../data/seniorProfileRepository";

// U6/U7 — CONFIRMED, externally-irreversible tools whose side effect must fire
// at most once per confirmation. When one runs as a confirmed action, its
// execution is keyed in the tool_execution_ledger (mcp/toolExecutionLedger.ts)
// so a replay (duplicate "YES", Linq redelivery, approvalHandler re-invoke)
// returns the cached result instead of re-submitting.
//
// INVARIANT (enforced by toolCapabilities.test.ts): every entry MUST be a real
// MCP tool AND high-risk — otherwise it never receives a _confirmedActionId and
// this guard is dead code. That guard caught the original mis-wiring: payouts
// and submit_shift_hours are NOT confirmation-gated (they carry their own
// idempotency — payoutCommon.executeInstantPayout's replay window + doc-keyed
// Stripe idempotency key, appointmentId dedup), so keying them here did
// nothing. This ledger is defense-in-depth layered over claimPendingAction's
// single-fire claim. Empty since perform_web_action (the one tool that needed
// it — a double-fire hit a third party) was removed 2026-09-05; add a future
// confirmed-and-irreversible third-party-facing tool here if one is built.
export const IDEMPOTENT_CONFIRMED_TOOLS = new Set<string>([]);
import { runEphemeralSubAgent, buildTaskToolDescription, getPublicSubAgentNames, INTERNAL_SUB_AGENT_NAMES } from "../agents/ephemeralSubAgents";
import { getAppUrl } from "../config/appUrl";
import { caregiverAnnualAmount, clientMonthlyAmount, clientMonthlyDisplay } from "../config/pricing";
import { logAgentAction } from "../observability/actionLedger";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import {
  createCaregiverReferralInvite,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";

const db = admin.firestore();

// Shared literal union for structured tool failures (see toolError below).
type ToolErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "UNAVAILABLE" | "CONFLICT" | "FORBIDDEN" | "RATE_UNKNOWN" | "IDENTITY_REQUIRED" | "MEMBERSHIP_REQUIRED" | "RATE_LIMITED";

// Legacy prod caregiver docs can carry hourlyRate as a STRING ("25", "$25"):
// the onboarding correction path stored the raw user text whenever Number()
// failed to parse it (onboardingConversation.ts), and update_signup_field
// Shared with the scripted booking flow (bookingFlow.ts / bookingResolution.ts)
// — both were found still carrying the exact hardcoded-$20-fallback pattern
// R9 (below) already killed here; extracting this to utils/caregiverRate.ts
// means all three booking-creating call sites can never drift apart again.
import { resolveCaregiverRate as resolveCaregiverRateShared } from "../utils/caregiverRate";
// Booking resolution helpers live in bookingResolution.ts (one home, shared
// with the scripted bookingFlow.ts, which owns the whole booking conversation
// and the site's Send Booking write since 2026-09-17).
import { bookingTimeToMinutes } from "../agents/bookingResolution";

// Resolve caregiver name + hourly rate from the caregiver doc. Mirrors the
// name fallbacks used by the live `request_booking` path (name/fullName) so a
// quote and the eventual booking agree.
//
// R9 (hallucination hardening 2026-07-17): when NO hourlyRate is on file this
// returns a structured RATE_UNKNOWN error instead of the old silent $20
// default. A fabricated rate here became a fabricated quote AND a fabricated
// booking charge — the agent must ask for / confirm the real rate instead.
// String rates that parse cleanly (legacy docs) coerce via coerceHourlyRate
// and flow exactly like numeric rates — quote and booking agree either way.
// Thin wrapper over the shared core: only this file's ToolErrorCode-typed
// contract (NOT_FOUND vs RATE_UNKNOWN vs INVALID_INPUT) lives here.
async function resolveCaregiverRate(
  caregiverId: string,
): Promise<{ ok: true; caregiverName: string; hourlyRate: number } | { ok: false; code: ToolErrorCode; message: string }> {
  if (!caregiverId) return { ok: false, code: "INVALID_INPUT", message: "caregiverId is required" };
  const result = await resolveCaregiverRateShared(caregiverId);
  if (result.ok) return result;
  const code: ToolErrorCode = result.message === "caregiver not found" ? "NOT_FOUND" : "RATE_UNKNOWN";
  return { ok: false, code, message: result.message };
}

// Short referral code (mirrors the frontend dbService.generateReferralCode shape:
// 6 uppercase alphanumerics). Used by send_referral / get_referral_status.
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Tool definitions (Anthropic tool_use format) ──────────────────────────────

export interface McpTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_senior_profile",
    description: "Get the profile of the senior being cared for, including name, age, diagnoses, and care needs.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's user ID" },
      },
      required: ["seniorId"],
    },
  },
  {
    name: "list_household_seniors",
    description: "The recipient tabs on the website's Care Plan page — everyone this family arranges care for (name, relationship, age, which one is primary). Use when a family manages care for more than one person and you need to know who's on file; get_care_plan returns the same list with each recipient's plan.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_upcoming_appointments",
    description: "Get a client's upcoming visits — the same list the website's My Bookings > Active Bookings shows under UPCOMING SHIFTS: scheduled and in-progress visits AND any visit marked 'needs_replacement' (the caregiver cancelled it). Each result carries its id (the shiftId) and status — use that id for manage_booking (cancel_visit/propose_reschedule) and, for a needs_replacement visit, for get_callout_backups.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "find_nearby_caregivers",
    description:
      "The website's Find Caregivers page (Find Care), exactly: the same caregiver pool, the same filter panel and " +
      "the same sort. Call it ANY time a family asks to see, browse or find caregivers — browsing is not gated on " +
      "identity or membership (only Message / Request Interview are, and those tools gate themselves). Filters mirror " +
      "the page: query (name, city or zip search box), maxDistanceMiles (slider, default 25), maxHourlyRate (slider, " +
      "default 75; 100 = no cap), minRating (Any/3/4/4.5), minExperienceYears (Any/1/3/5/10), verifiedOnly " +
      "(Background checked only), transportationOnly (Reliable transportation), specialties (any of), languages " +
      "(any of), sortBy (rating = Highest rated, the default; price-low; price-high), favoritesOnly (the Favorites tab). " +
      "Every caregiver shown is already background-check cleared — never ask the family whether they want that. " +
      "It texts the family the page: a '<N> caregivers found' line, then one card per caregiver (name, rate, rating, " +
      "experience, location, specialties, verification, and the card's button state: Request Interview / Active " +
      "Booking / Interview requested / Re-book) with a tappable profile link, and records them in pendingMatches. It " +
      "does NOT hide anyone the family already met — same as the page; use offset (with the same filters) for 'show " +
      "me more'. Never repeat the names/rates/links in your reply; follow the instruction in its result. NOT for a " +
      "visit the caregiver cancelled (a 'Needs Replacement' visit) — that is start_replacement_flow.",
    input_schema: {
      type: "object",
      properties: {
        clientId:           { type: "string", description: "The client's user ID" },
        query:              { type: "string", description: "The page's search box — matches name, city, state or zip." },
        maxDistanceMiles:   { type: "number", description: "Distance slider (default 25)." },
        maxHourlyRate:      { type: "number", description: "Max rate slider (default 75; 100 or more = no cap)." },
        minRating:          { type: "number", description: "Rating pills: 3, 4 or 4.5 (omit for Any)." },
        minExperienceYears: { type: "number", description: "Experience: 1, 3, 5 or 10 (omit for Any)." },
        verifiedOnly:       { type: "boolean", description: "Background checked only." },
        transportationOnly: { type: "boolean", description: "Reliable transportation only." },
        specialties:        { type: "array", items: { type: "string" }, description: "Senior care specialties — any of (e.g. 'Dementia / Memory Care', 'Mobility Assistance')." },
        languages:          { type: "array", items: { type: "string" }, description: "Languages — any of." },
        sortBy:             { type: "string", enum: ["rating", "price-low", "price-high"], description: "Sort by: Highest rated (default), Price: Low to High, Price: High to Low." },
        favoritesOnly:      { type: "boolean", description: "The Favorites tab — only caregivers the family has hearted." },
        offset:             { type: "number", description: "Skip this many results — for 'show me more' with the SAME filters." },
        limit:              { type: "number", description: "Cards to text this turn (default 4, max 10)." },
      },
      required: ["clientId"],
    },
  },
  {
    // Merged with the former get_caregiver_reviews (2026-09-03, to make room
    // for find_nearby_caregivers under OpenAI's 128-tool cap) — reviews are
    // now always included alongside the profile fields, one lookup instead
    // of two for what's almost always wanted together.
    name: "get_caregiver_info",
    description:
      "The website's caregiver profile page (/client/caregiver/{id}) as data, exactly as this family sees it: header (name, rating or 'No reviews yet', badges, city, " +
      "$rate/hr · $billed/hr), About + languages, Care Services, Rates (1 / 2 / 3+ people, each with the billed figure), experience, Weekly Availability blocks, Background, " +
      "Location & Travel, recent Reviews, and the buttons the page shows this family (Active Booking / Re-book / Interview Requested / Request Interview; Message; Leave a Review). " +
      "Use for any question about a specific caregiver. Quote only what is in the result; `summary` is the page in one paragraph.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's ID" },
        clientId:    { type: "string", description: "The family viewing the page (auto-injected) — decides which buttons the page shows them" },
        reviewLimit: { type: "number", description: "Max recent reviews to include (default 5, max 20 — the page lists 20)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "contact_support",
    description:
      "Put the person in touch with Evia's human team — the website's 'Message our team' button. Use it the moment someone asks for a person, a human, " +
      "support, a manager, or to complain about Evia; or when they raise something you must not handle yourself (a safety worry about a caregiver, a billing " +
      "dispute you cannot settle, an accusation). Pass their words as `message`. It writes into their support room (the same room the website button opens); " +
      "the team is alerted and replies are texted back to them. Then tell them, in one line, that the team has it and will reply here by text — do NOT promise a time.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The person's user ID (client or caregiver)" },
        message: { type: "string", description: "What they want the team to know — their own words, verbatim where possible" },
      },
      required: ["userId", "message"],
    },
  },
  {
    name: "get_notifications",
    description:
      "The website's notification bell as data: the family's notifications newest first (chat messages excluded — the Inbox owns them), the unread count, and for each one the " +
      "page the bell opens (page.label / page.path). Use when they ask what's new, what a notification was about, or to clear the bell. action: list (default) | mark_all_read " +
      "(the bell's Mark all read) | mark_read (one, needs notificationId) | delete (the trash icon on one, needs notificationId).",
    input_schema: {
      type: "object",
      properties: {
        userId:         { type: "string", description: "The family's user ID (auto-injected)" },
        action:         { type: "string", enum: ["list", "mark_all_read", "mark_read", "delete"], description: "Default list" },
        notificationId: { type: "string", description: "For mark_read / delete: the id from a previous list" },
        show:           { type: "number", description: "How many to include in the summary line (default 5; items always has all of them)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "get_account_settings",
    description:
      "The website's Account Settings page as data, row by row: profile photo, name + joined date, membership plan, identity check, recovery email, mobile phone, location, " +
      "blocked users, and delete account — each with the tool that is that row's Edit (actions[]). Use before answering anything about the family's own account details " +
      "or before changing one, and quote only what it returns.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "The family's user ID (auto-injected)" } }, required: ["userId"] },
  },
  {
    name: "get_membership_page",
    description:
      `The website's Membership page exactly: the plan card (Standard Plan, ${clientMonthlyDisplay()}), status, next billing date — or the end date once ` +
      "a cancel is scheduled — and the buttons for that state (Select a plan / Cancel + Manage / Reactivate + Manage). Use for any question " +
      "about the membership: is it active, when it renews, when it ends, what it costs. 'manage' (card, invoices) is get_payment_update_link; " +
      "cancel/reactivate is set_subscription_status; 'select_plan' is send_onboarding_link (payment).",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "get_caregiver_booking_rate",
    description: "Look up a caregiver's name and hourly rate. Read-only — books nothing. Use this when the family asks what a caregiver charges, before quoting or committing a booking.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "start_replacement_flow",
    description:
      "THE way to handle a visit marked 'Needs Replacement' (the caregiver cancelled it): starts Evia's own scripted " +
      "flow that walks the website's Find Replacement modal step for step — it texts the family each candidate's " +
      "profile card (Care Team first, then nearby matches, never the caregiver who cancelled), asks which one and " +
      "whether to keep the visit's date/time or change it, shows a recap, and only on the family's YES sends the " +
      "replacement booking request (the same booking_requests write the modal's Request button makes). No interview " +
      "step exists in this flow. Get the shiftId from get_upcoming_appointments (the visit whose status is " +
      "'needs_replacement') if you don't have it. This tool ALREADY TEXTS THE FAMILY itself — send NOTHING else this " +
      "turn. The flow then owns the conversation until it finishes or the family backs out.",
    input_schema: {
      type: "object",
      properties: {
        shiftId: { type: "string", description: "The shift (visit) that needs a replacement — status 'needs_replacement'." },
      },
      required: ["shiftId"],
    },
  },
  {
    name: "start_cancel_flow",
    description:
      "Cancel something on the family's My Bookings page — the website's own cancel buttons, step for step: it reads " +
      "what can be cancelled right now (an upcoming visit, a Needs Replacement visit = Skip, a whole active booking, a " +
      "pending booking request, a pending replacement request, a pending schedule-change request), asks which one if " +
      "more than one could be meant, confirms with the site's own dialog wording, and only on YES makes the site's " +
      "own write. Pass initialText = the family's message so 'cancel Thursday's visit' picks the right one. This tool " +
      "ALREADY TEXTS THE FAMILY — send NOTHING else this turn. For an interview, use cancel_interview instead.",
    input_schema: {
      type: "object",
      properties: {
        initialText: { type: "string", description: "The family's own message asking to cancel, verbatim." },
      },
    },
  },
  {
    name: "start_correction_flow",
    description:
      "Correct a caregiver's submitted timesheet — clock-in/out AND the additional charges (adjust an amount or remove one, exactly what the modal allows) — the website's Timesheets 'Review submitted hours' modal, step for " +
      "step. Starts Evia's scripted flow: which timesheet (only if more than one is waiting), the proposed clock-in (KEEP = as " +
      "submitted), the proposed clock-out, an optional reason, a recap with the proposed total and pay, then YES sends the " +
      "SAME propose_correction write the modal makes (the caregiver has 24h to accept or counter; silence auto-accepts). If the " +
      "caregiver already sent a COUNTER, the flow offers exactly the modal's two buttons: ACCEPT or ESCALATE. Use this the " +
      "moment a family says any clock-in/out, hours or pay on a submitted timesheet is wrong ('change the clock in time', " +
      "'she left at 10:30 not 10:38', 'the hours are off') — pass initialText = their message so times they already gave are " +
      "used. This tool ALREADY TEXTS THE FAMILY — send NOTHING else this turn. review_shift_hours stays for a plain approve.",
    input_schema: {
      type: "object",
      properties: {
        initialText:   { type: "string", description: "The family's own message about the timesheet, verbatim." },
        appointmentId: { type: "string", description: "Optional — the shiftHours id if the family named a specific timesheet." },
      },
      required: [],
    },
  },
  {
    name: "start_visit_request_flow",
    description:
      "Add an extra visit (a new day, or new days, and times) to a booking the caregiver has already accepted — the " +
      "website's Calendar '+ Request Visit' button, step for step. Starts Evia's scripted flow: which caregiver (only " +
      "those with an active booking), which booking if they have more than one, the day(s), the time(s) per day " +
      "(refusing anything that overlaps an existing visit with that caregiver or a time they're booked elsewhere, and " +
      "flagging times outside their usual availability), start date, ongoing or end date, an optional note, then a " +
      "recap; only on YES does it write the booking_amendments request the caregiver must accept. Pass initialText = " +
      "the family's own message so a day/time they already said is used. This tool ALREADY TEXTS THE FAMILY — send " +
      "NOTHING else this turn. Do NOT call request_schedule_amendment yourself for a family's ask.",
    input_schema: {
      type: "object",
      properties: {
        initialText: { type: "string", description: "The family's own message asking for the visit, verbatim." },
        caregiverId: { type: "string", description: "Optional — the caregiver the family named." },
      },
    },
  },
  {
    name: "get_calendar",
    description:
      "The family's My Calendar page for a date range, exactly: every visit (shifts, all statuses) in the range with the " +
      "page's display status (scheduled / in-progress / overdue / completed / cancelled — 'overdue' is a scheduled visit whose " +
      "time has passed with no check-in) plus every interview the page shows (requested/accepted/in-progress/completed). Each " +
      "visit carries what the page's click-through popover shows — caregiver, time, address, care recipients, care needs vs " +
      "tasksCompleted, actual start/end and completion notes once done — and 'actions' = its buttons (scheduled: message, " +
      "cancel; completed: message). Each interview carries type, the page's status label (requested → Pending), the linked " +
      "job title/location, the Google Meet link, and 'actions' (join_video_call, message, cancel while pending/accepted). Use " +
      "for 'what's on my calendar this week / next week / in October', 'how many visits in September', 'what happened last " +
      "week'. Defaults to today through the next 6 days; max 62 days. Adding a visit is start_visit_request_flow (the page's " +
      "'+ Request Visit' button).",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        fromDate: { type: "string", description: "YYYY-MM-DD (default today)" },
        toDate:   { type: "string", description: "YYYY-MM-DD (default fromDate + 6 days)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "start_reschedule_flow",
    description:
      "THE way to move an existing scheduled visit to a different day/time (the website's own Reschedule button on " +
      "My Bookings > Active Bookings > UPCOMING SHIFTS): starts Evia's scripted flow, which reads the family's REAL " +
      "upcoming scheduled visits fresh from the database (never from memory), asks which one if more than one could " +
      "be meant, asks the new day + start/end time if not already given, checks it doesn't overlap another visit " +
      "with the same caregiver that day (same check as the site), shows a recap, and only on the family's YES writes " +
      "the proposal (reschedulePending*; the real time changes only when the caregiver accepts). Pass initialText = " +
      "the family's own message so their visit choice and new time are read from what they actually said; pass shiftId " +
      "only when you are certain which visit (a 'scheduled' one — never a 'needs_replacement' one). This tool ALREADY " +
      "TEXTS THE FAMILY itself — send NOTHING else this turn. The flow then owns the conversation until it finishes.",
    input_schema: {
      type: "object",
      properties: {
        initialText: { type: "string", description: "The family's own message asking for the move, verbatim." },
        shiftId:     { type: "string", description: "Optional — the scheduled visit's id from get_upcoming_appointments, only when unambiguous." },
        date:        { type: "string", description: "Optional YYYY-MM-DD the family asked to move it to." },
        startTime:   { type: "string", description: "Optional HH:MM 24-hour new start." },
        endTime:     { type: "string", description: "Optional HH:MM 24-hour new end." },
      },
    },
  },
  {
    name: "start_resend_booking_flow",
    description:
      "Resend a booking request the caregiver declined or the family cancelled — the website's own 'Resend' row on " +
      "Care Requests > Interviews ('Visit cancelled' / 'Caregiver declined' + Resend). Starts Evia's scripted booking " +
      "flow PRE-FILLED from that request (same as the site's 'Resend Booking Request' modal): the family sees the full " +
      "recap, can change rate/schedule/location/recipients/note, and on YES the SAME booking_requests doc goes back to " +
      "'pending' (isResend: true). Pass caregiverId when the family named one; omit it to consider every resendable " +
      "request. If more than one could be resent, the flow asks which with a numbered list. This tool ALREADY TEXTS THE " +
      "FAMILY — send NOTHING else this turn. Never use start_booking_flow for a resend.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:      { type: "string", description: "Optional — the caregiver the family named." },
        bookingRequestId: { type: "string", description: "Optional — only when you already know the exact declined/cancelled booking_requests id." },
      },
    },
  },
  {
    name: "start_booking_flow",
    description:
      "Start Evia's own scripted, step-by-step booking flow — the PREFERRED way to send a booking request once " +
      "the family is ready to move forward (e.g. right after a 'strong' submit_interview_feedback result, or when " +
      "they ask to book/hire a caregiver). Every booking must trace back to a completed interview, same as the " +
      "site (there is no 'Send Booking' button without one) — this tool finds and, if needed, asks which one. " +
      "Both caregiverId and interviewId are OPTIONAL: pass caregiverId when a specific caregiver was named (still " +
      "narrows to that caregiver's own eligible interviews); omit it entirely when the family hasn't named one " +
      "yet ('let's send a booking') and this will show every completed-interview-ready option across ALL their " +
      "caregivers to pick from. Pass interviewId only when you already have the exact id (e.g. right after " +
      "submit_interview_feedback) — otherwise leave it out and this resolves/asks for it itself. This tool then " +
      "asks every remaining question (rate, schedule, care location if ambiguous) one at a time and shows a full " +
      "recap matching the website's 'Send Booking Request' modal before sending — you do NOT need to collect any " +
      "of that yourself. On YES it performs the exact write the website's 'Send Booking' button performs. This tool ALREADY TEXTS " +
      "THE FAMILY the first question itself — do not send anything else this turn beyond a brief acknowledgment " +
      "that you're setting up the booking, if anything at all.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver being booked, if the family named one. Omit when they haven't — Evia will show every eligible caregiver+interview to pick from." },
        interviewId: { type: "string", description: "Pass this only when you already have the exact interview id (e.g. right after submit_interview_feedback). Omit otherwise — this tool resolves or asks for it itself from completed interviews." },
      },
    },
  },
  {
    name: "trigger_emergency_alert",
    description: "Raise an emergency alert for the family/account when they report an urgent safety situation (a fall, medical emergency, caregiver no-show with the senior alone, etc.). Creates an active alert + notifies staff. clientId is injected automatically. Use ONLY for genuine urgent situations — confirm it's a real emergency first. For life-threatening events also tell them to call 911.",
    input_schema: {
      type: "object",
      properties: {
        note:     { type: "string", description: "Short description of the emergency (what's happening)" },
        location: { type: "object", description: "Optional { lat, lng } if known", properties: { lat: { type: "number" }, lng: { type: "number" } } },
      },
      required: [],
    },
  },
  {
    name: "get_callout_backups",
    description: "THE tool for a visit marked 'Needs Replacement' (the caregiver cancelled it): find and TEXT the family replacement candidates — matches the website's own Find Replacement picker exactly: your Care Team first (anyone you've booked before), then other bookable caregivers ranked by care-needs match, distance, and rating, and it EXCLUDES the caregiver who cancelled. The family's pick then goes to select_callout_backup, which sends that candidate a real replacement booking request for this visit — no interview step, exactly like the website's Request button. Get the shiftId from get_upcoming_appointments (the visit whose status is 'needs_replacement') if you don't already have it — never use find_replacement_caregivers for this. This tool ALREADY SENDS each candidate's profile card itself (same tappable photo-preview link format as find_nearby_caregivers) — do not repeat their names/rates yourself, just follow the instruction in its result. clientId and phone are injected automatically — only the visit's owner may view its candidates.",
    input_schema: {
      type: "object",
      properties: { shiftId: { type: "string", description: "The shift (visit) that needs a replacement." } },
      required: ["shiftId"],
    },
  },
  {
    name: "select_callout_backup",
    description: "Send a new booking request to a chosen backup caregiver for a visit that needs replacement — matches the website's own flow exactly: this creates a real booking request (the candidate gets the normal accept/decline text) rather than reassigning the visit outright. Omit date/startTime/endTime to keep the same day/time as the original visit; pass them only if the family wants a different day/time for the replacement. clientId is injected automatically.",
    input_schema: {
      type: "object",
      properties: {
        shiftId:           { type: "string", description: "The shift (visit) that needs a replacement." },
        backupCaregiverId: { type: "string", description: "id of the backup caregiver to send the request to (from get_callout_backups)" },
        date:              { type: "string", description: "YYYY-MM-DD. Optional — defaults to the original visit's own date." },
        startTime:         { type: "string", description: "HH:MM 24-hour. Optional — defaults to the original visit's own start time." },
        endTime:           { type: "string", description: "HH:MM 24-hour. Optional — defaults to the original visit's own end time." },
      },
      required: ["shiftId", "backupCaregiverId"],
    },
  },
  {
    name: "send_referral",
    description: "Send a referral invite to a friend/family member by email, sharing the user's referral code. userId is injected automatically.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string", description: "Email address to invite" } },
      required: ["email"],
    },
  },
  {
    name: "get_referral_status",
    description: "Get the user's referral code and how many people they've referred (and their statuses). Read-only. userId is injected automatically.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_preferences",
    description: "Update Evia's notification preferences for the user (DND, active hours, etc.).",
    input_schema: {
      type: "object",
      properties: {
        userId:     { type: "string" },
        dndEnabled: { type: "boolean" },
        dndStart:   { type: "string", description: "HH:MM e.g. '22:00'" },
        dndEnd:     { type: "string", description: "HH:MM e.g. '08:00'" },
      },
      required: ["userId"],
    },
  },
  {
    name: "read_memory_file",
    description: "Read one of Evia's long-term memory files for a user. Canonical files: profile, health, family, recent_episodes, procedural. May also be an ad-hoc slug returned by another tool (e.g. an offloaded large result like \"tool_get_invoice_history_...\").",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID" },
        file:   { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
      },
      required: ["userId", "file"],
    },
  },
  {
    name: "update_memory_file",
    description: "Append new information to one of Evia's long-term memory files for a user.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The user's ID" },
        file:    { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
        content: { type: "string", description: "Markdown content to append to the file" },
      },
      required: ["userId", "file", "content"],
    },
  },
  {
    name: "edit_memory_file",
    description:
      "Surgically correct a stored fact in one of Evia's memory files by find/replace, instead of appending a duplicate. " +
      "Use when a previously stored detail changes (e.g. the family says 'Mom is 82, not 78'). Returns how many occurrences were replaced.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The user's ID" },
        file:    { type: "string", description: "Memory file slug (e.g. profile, health, family, recent_episodes, procedural)" },
        find:    { type: "string", description: "Exact text currently in the file to replace" },
        replace: { type: "string", description: "Replacement text" },
      },
      required: ["userId", "file", "find", "replace"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search across all of a user's long-term memory files for a keyword or phrase and return the matching sections. " +
      "Use to retrieve a specific remembered detail without loading every memory file.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID" },
        query:  { type: "string", description: "Keyword or phrase to search for" },
      },
      required: ["userId", "query"],
    },
  },
  {
    name: "write_todos",
    description:
      "Scaffold a checklist of the steps you intend to take in this conversation. Use when the family's request has 3+ distinct steps " +
      "(e.g. 'cancel Thursday, find a replacement for Friday, and let Marco know'). " +
      "Items persist across turns until cleared, so on subsequent turns you can update statuses or add steps. " +
      "Pass the full updated list each time — it overwrites the prior list. Don't use for simple single-step asks.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Conversation key — the family member's phone number from the system context" },
        items: {
          type: "array",
          description: "Ordered checklist. Each item: { task: short imperative description, status: 'pending' | 'in_progress' | 'completed' }",
          items: {
            type: "object",
            properties: {
              task:   { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["task", "status"],
          },
        },
      },
      required: ["phone", "items"],
    },
  },
  {
    name: "cara_knows",
    description:
      "Return a clean digest of everything Evia remembers about this family — senior profile, " +
      "health, family relationships, recent episodes, procedural notes. " +
      "Call when the family asks 'what do you know about Mom?', 'what's on file?', 'remind me what we've told you', " +
      "'do you remember [topic]?', or any variation that asks Evia to surface her stored memory. " +
      "Returns the raw memory context so you can summarize it warmly in 2–3 sentences (never as a bulleted list).",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The family member's user ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "task",
    description: buildTaskToolDescription(),
    input_schema: {
      type: "object",
      properties: {
        description:   { type: "string", description: "The specific work the sub-agent should do. Include all the context the sub-agent needs — it does not see the conversation history." },
        subagent_type: { type: "string", enum: getPublicSubAgentNames(), description: "Which sub-agent to delegate to." },
      },
      required: ["description", "subagent_type"],
    },
  },
  {
    // Consolidated (rather than 5 separate tools) to stay under OpenAI's
    // 128-tool-per-role hard cap enforced by parity.test.ts — one schema
    // covering every family-side booking_requests/shifts/booking_amendments
    // cancel-or-resend action, matching My Bookings / Calendar exactly.
    name: "manage_booking",
    description:
      "Cancel or resend a booking, a single visit, or a pending schedule-change request. Always confirm with the family before calling.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID (for ownership check)" },
        action: {
          type: "string",
          enum: [
            "cancel_pending_request", "cancel_whole_booking", "cancel_visit", "cancel_pending_amendment",
            "withdraw_replacement_request", "propose_reschedule", "accept_reschedule", "clear_reschedule",
          ],
          description:
            "cancel_pending_request — withdraw a booking still awaiting the caregiver's YES/NO (needs bookingRequestId). " +
            "cancel_whole_booking — cancel an accepted booking, every still-scheduled visit under it (needs bookingRequestId). " +
            "cancel_visit — cancel ONE visit, leaving the rest of the booking active (needs shiftId). Also works on a " +
            "'Needs Replacement' visit (the family deciding they don't need a replacement after all — matches the " +
            "website's own Skip button). " +
            "cancel_pending_amendment — withdraw a schedule-change request still awaiting the caregiver's response (needs amendmentId). " +
            "withdraw_replacement_request — cancel a pending replacement booking request you sent to a backup caregiver, so a " +
            "different one can be chosen instead (needs bookingRequestId — the id select_callout_backup returned). " +
            "propose_reschedule — propose moving ONE existing scheduled visit to a new day/time, in place (needs shiftId, " +
            "date, startTime, endTime) — the caregiver gets a text to confirm or counter; the visit's real time does NOT " +
            "change until they accept. Use this instead of cancelling and re-requesting a visit. " +
            "accept_reschedule — confirm a new day/time the CAREGIVER proposed for one of your visits (needs shiftId) — " +
            "only valid when the pending proposal came from the caregiver, not from you. " +
            "clear_reschedule — decline the caregiver's proposed new time (the original time stands), OR withdraw your " +
            "own proposal before they've responded — either way just needs shiftId.",
        },
        bookingRequestId: { type: "string", description: "The booking_requests document ID — required for cancel_pending_request, cancel_whole_booking, withdraw_replacement_request" },
        shiftId:          { type: "string", description: "The shifts document ID — required for cancel_visit, propose_reschedule, accept_reschedule, clear_reschedule" },
        amendmentId:      { type: "string", description: "The booking_amendments document ID — required for cancel_pending_amendment" },
        date:             { type: "string", description: "YYYY-MM-DD — required for propose_reschedule" },
        startTime:        { type: "string", description: "HH:MM 24-hour — required for propose_reschedule" },
        endTime:          { type: "string", description: "HH:MM 24-hour — required for propose_reschedule" },
      },
      required: ["clientId", "action"],
    },
  },
  {
    name: "request_schedule_amendment",
    description:
      "LOW-LEVEL write behind the website's Calendar '+ Request Visit' modal — prefer start_visit_request_flow for a " +
      "family's ask (it picks the caregiver/booking, checks availability, and confirms). Adds day(s)/time(s) to an " +
      "ACCEPTED booking as a booking_amendments request the caregiver must accept. Either pass newDays (the modal's " +
      "full shape: 3-letter day → list of {start,end} blocks) with startDate and ongoing/endDate, or the older single " +
      "date + startTime + endTime. Refuses a block that overlaps an existing visit with that caregiver or a time they're " +
      "booked elsewhere (the same checks the modal enforces).",
    input_schema: {
      type: "object",
      properties: {
        bookingRequestId: { type: "string", description: "The ACCEPTED booking_requests document ID this amendment applies to" },
        clientId:         { type: "string", description: "The client's user ID" },
        newDays:          { type: "object", description: "{ \"Tue\": [{ \"start\": \"09:00\", \"end\": \"13:00\" }], ... } — the modal's own shape" },
        startDate:        { type: "string", description: "YYYY-MM-DD first date the new day(s) apply (default today)" },
        endDate:          { type: "string", description: "YYYY-MM-DD last date, when not ongoing" },
        date:             { type: "string", description: "Legacy single-day form: YYYY-MM-DD" },
        startTime:        { type: "string", description: "Legacy single-day form: HH:MM" },
        endTime:          { type: "string", description: "Legacy single-day form: HH:MM" },
        notes:            { type: "string", description: "Optional note to the caregiver" },
        ongoing:          { type: "boolean", description: "true for a standing recurring day (default when newDays is given), false for a one-off" },
      },
      required: ["bookingRequestId", "clientId"],
    },
  },
  {
    name: "respond_to_schedule_amendment",
    description: "Caregiver accepts or declines a schedule-change request from a family.",
    input_schema: {
      type: "object",
      properties: {
        amendmentId:  { type: "string", description: "The booking_amendments document ID" },
        caregiverId:  { type: "string", description: "The caregiver's Firestore document ID" },
        decision:     { type: "string", enum: ["accept", "decline"] },
      },
      required: ["amendmentId", "caregiverId", "decision"],
    },
  },
  {
    name: "manage_shift_reschedule",
    description:
      "Caregiver-side counterpart to the family's own reschedule tool — proposes moving ONE existing scheduled visit " +
      "to a new day/time in place (matches CaregiverBookingsPage.tsx's own Reschedule button exactly), or responds to a " +
      "day/time the FAMILY already proposed for one of your visits. This is for changing an already-scheduled visit — " +
      "not for cancelling a shift (use your normal cancel-a-shift flow) or adding a brand-new recurring day.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        shiftId:     { type: "string", description: "The shifts document ID" },
        action: {
          type: "string",
          enum: ["propose", "accept", "decline"],
          description:
            "propose — suggest a new day/time for this visit (needs date, startTime, endTime); the family gets a text " +
            "to confirm or counter, the visit's real time doesn't change until they accept. " +
            "accept — confirm a new day/time the FAMILY proposed (only valid when they proposed it, not you). " +
            "decline — reject the family's proposed time (original stands), or withdraw your own proposal before they respond.",
        },
        date:      { type: "string", description: "YYYY-MM-DD — required for action:'propose'" },
        startTime: { type: "string", description: "HH:MM 24-hour — required for action:'propose'" },
        endTime:   { type: "string", description: "HH:MM 24-hour — required for action:'propose'" },
      },
      required: ["caregiverId", "shiftId", "action"],
    },
  },
  {
    name: "send_caregiver_message",
    description:
      "The website Inbox's composer: posts the family's message into their shared thread with that caregiver (the same " +
      "chatRooms write the page makes). The caregiver is then notified exactly like a website message — in-app and by text " +
      "with the message itself — so do NOT also text them yourself. Same paywall as the page (identity, then membership). " +
      "Tell the family what you're sending before you call this tool.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        message:     { type: "string", description: "The message text to send to the caregiver" },
        clientId:    { type: "string", description: "The client's user ID (for audit log)" },
      },
      required: ["caregiverId", "message", "clientId"],
    },
  },
  {
    name: "request_location",
    description:
      "Ask the user to share their current location via the native one-tap prompt. " +
      "Works on 1:1 iMessage only — on SMS or RCS the prompt can't fire, and this tool " +
      "tells you to instead ask the user to type their city and zip code. The shared pin " +
      "arrives later as a separate message; this tool only sends the prompt. " +
      "Session context (phone, chatId) is injected automatically — do NOT ask the user for these. " +
      "Tell the user you're requesting their location before calling this.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional short reason for logs (e.g. 'find nearby caregivers', 'update address')" },
      },
      required: [],
    },
  },
  {
    name: "react_to_message",
    description:
      "Add an iMessage tapback reaction to the user's most recent message — silent, no text is sent. " +
      "Use it the way a person would: heart a photo of their loved one, thumbs-up a quick confirmation, laugh at a joke. " +
      "After reacting, only send a text reply if one is genuinely needed — a reaction alone is often the whole answer. " +
      "Works on iMessage only; on SMS/RCS this tool tells you to express the sentiment in your text reply instead. " +
      "Session context (phone) is injected automatically — the tool targets the user's last message by itself.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["love", "like", "dislike", "laugh", "emphasize", "question", "custom"],
          description: "Tapback type: love (❤️), like (👍), dislike (👎), laugh (haha), emphasize (!!), question (?), or 'custom' for any other emoji.",
        },
        customEmoji: { type: "string", description: "Required when type is 'custom' — a single emoji character (e.g. '🎉')." },
      },
      required: ["type"],
    },
  },
  {
    name: "set_visit_update_frequency",
    description:
      "Set how often the family gets mid-visit updates while a caregiver is with their loved one. " +
      "Use when they say things like 'update me every hour', 'fewer updates please', 'stop the visit updates', " +
      "or 'go back to normal updates'. Default is every 2 hours during a visit. " +
      "Session context (phone) is injected automatically.",
    input_schema: {
      type: "object",
      properties: {
        frequencyMinutes: {
          type: "number",
          description: "Minutes between mid-visit updates (30–480). E.g. 60 for hourly. Omit when using mode.",
        },
        mode: {
          type: "string",
          enum: ["default", "off"],
          description: "'default' resets to the standard cadence (every 2 hours); 'off' stops mid-visit updates entirely (arrival and end-of-visit summaries still send).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_active_bookings",
    description:
      "The website's My Bookings > Active Bookings tab, exactly: one card per active booking — caregiver, Ongoing or " +
      "Until <date>, Starts <date>, the weekly days/times with per-day hours and hours/week, address, rate + payment " +
      "(Card), the booking note, care recipients (with each one's care plan needs/subtasks and lifestyle), emergency " +
      "contact — plus that booking's UPCOMING SHIFTS: every visit with the page's own status pill (scheduled / overdue / " +
      "in-progress / needs_replacement), a visit-specific note, any pending reschedule proposal (who proposed it and " +
      "whether it's waiting on the family), the reschedule history, the replacement state, and 'actions' = the exact " +
      "buttons the page shows for that row (cancel_visit, propose_reschedule, accept_reschedule/decline_reschedule, " +
      "withdraw_reschedule, find_replacement/skip, choose_someone_else). Call for 'what's my schedule/booking', 'when " +
      "does X come', 'is anything waiting on me', 'how many visits are left', and BEFORE any cancel/reschedule/" +
      "replacement so you act on the real shiftId. Booking-level Cancel Booking and Message are always available.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_family_group",
    description: "Get all family members who are part of this care group and receive updates.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The primary family member's phone number" },
      },
      required: ["phone"],
    },
  },
  {
    name: "create_senior_profile",
    description:
      "Add a care recipient — the website's Care Plan page '+ Add' form, exactly. Use when a family says they care for someone " +
      "else too (\"I also look after my dad\"). The form REQUIRES first name, relationship (Myself / Parent / Grandparent / Spouse / " +
      "Sibling / Other) and a care location with a street address (pick one already on file from get_care_plan's locationPool, or " +
      "give a new street/city/state/zip); it also takes care needs (the page's fixed pills: Mobility Assistance, Dementia / Memory " +
      "Care, Medication Reminders, Personal Care, Companionship, Transportation, Meal Preparation, Light Housekeeping) with optional " +
      "sub-tasks, and a note. Collect what's missing conversationally, read it back, then call. Non-medical: never record " +
      "medications, diagnoses or conditions. Only for a NEW recipient — edits go through update_care_plan.",
    input_schema: {
      type: "object",
      properties: {
        clientId:        { type: "string", description: "Injected automatically — the owning family account." },
        userId:          { type: "string", description: "Injected automatically." },
        firstName:       { type: "string", description: "The recipient's first name." },
        lastName:        { type: "string", description: "Last name (optional)." },
        name:            { type: "string", description: "Full name — alternative to firstName/lastName." },
        relationship:    { type: "string", description: "Myself, Parent, Grandparent, Spouse, Sibling or Other (required)." },
        age:             { type: ["number", "string"], description: "Age, if known." },
        careNeeds:       { type: "array", items: { type: "string" }, description: "Care needs from the page's list." },
        careNeedDetails: { type: "object", description: "Optional sub-tasks per need, e.g. { \"Meal Preparation\": [\"Breakfast\"] }." },
        notes:           { type: "string", description: "The Notes section, if the family gave one." },
        location:        { type: "object", description: "Care location: { street, city, state, zipCode } — street is required.", properties: { street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zipCode: { type: "string" } } },
      },
      required: ["clientId", "relationship", "location"],
    },
  },
  {
    name: "remove_care_recipient",
    description:
      "Remove a care recipient from the household — the same as the trash icon on the website's Care Plan page. Permanent; confirm with the family before calling. " +
      "Cannot remove the only care recipient on the household (there must always be at least one).",
    input_schema: {
      type: "object",
      properties: {
        clientId:           { type: "string", description: "Injected automatically — the owning family account." },
        recipientFirstName: { type: "string", description: "First name of the care recipient to remove." },
      },
      required: ["clientId", "recipientFirstName"],
    },
  },
  {
    name: "set_recipient_photo",
    description:
      "The Care Plan page's recipient photo (the avatar on each recipient tab — click → pick a file). Over text the file is the " +
      "photo the family just attached: call this right after a message like 'this is Samira' with a picture, or when the family " +
      "sends a photo of a care recipient. With one recipient on file the name is optional; with several and no name, ask which " +
      "recipient it is before calling. Saves to the same storage folder and roster field the page uses.",
    input_schema: {
      type: "object",
      properties: {
        clientId:           { type: "string", description: "Injected automatically — the owning family account." },
        recipientFirstName: { type: "string", description: "Which care recipient the photo is of (optional when there is only one)." },
        photoUrl:           { type: "string", description: "The saved photo URL from the '[The user sent a photo … saved at …]' line; defaults to the most recent photo the family sent." },
      },
      required: ["clientId"],
    },
  },
  {
    name: "delete_review",
    description: "Delete a review the family previously left for a caregiver. Permanent — confirm before calling.",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, reviewId: { type: "string", description: "The review document id." } }, required: ["clientId", "reviewId"] },
  },
  {
    name: "get_support_ticket",
    description: "Get the status and details of one of the family's support tickets by id.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "Injected automatically." }, ticketId: { type: "string" } }, required: ["userId", "ticketId"] },
  },
  {
    name: "list_support_tickets",
    description: "List the family's support tickets (most recent first) so Evia can give status updates instead of opening duplicates.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "Injected automatically." } }, required: ["userId"] },
  },
  {
    name: "update_support_ticket",
    description: "Update one of the family's OWN support tickets: add a follow-up note ('add_response') or reopen a resolved ticket ('reopen'). Cannot set admin-only triage states.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "Injected automatically." }, ticketId: { type: "string" }, action: { type: "string", description: "'add_response' or 'reopen'" }, message: { type: "string", description: "Follow-up note (required for add_response)." } }, required: ["userId", "ticketId", "action"] },
  },
  {
    name: "log_match_feedback",
    description: "Record the family's qualitative feedback about a caregiver match (e.g. 'great with mom but often late'). Feeds future matching. Distinct from start_review_flow (the public star review).",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, caregiverId: { type: "string" }, sentiment: { type: "string", description: "'positive', 'neutral', or 'negative'" }, note: { type: "string" } }, required: ["clientId", "caregiverId", "note"] },
  },
  {
    name: "create_job_post",
    description:
      "Post a new caregiver job for the family so nearby caregivers can apply — matches the website's own 6-step " +
      "'Post a Job' wizard field for field. Collect care needs, schedule, a title, a description, and a 5-digit " +
      "zip code (required — never accept a typed city, the zip auto-derives it, same as onboarding); confirm, " +
      "then call. Omit hourlyRate entirely if the family wants a flexible/negotiable rate instead of a set number " +
      "— same as leaving the website's 'rate flexible' toggle on.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "Injected automatically." },
        title:         { type: "string", description: "Job title shown to caregivers, 10-80 characters — same field as the website's 'Job title' box." },
        notes:         { type: "string", description: "Description of the job, 50-2500 characters — what a caregiver should know (responsibilities, tasks, etc.). Same as the website's required 'Details' field; never accept phone numbers or emails here." },
        careTypes:     { type: "array", items: { type: "string" } },
        careNeedDetails: {
          type: "object",
          description: "Optional sub-tasks per care type, e.g. { \"Mobility Assistance\": [\"Ambulation\", \"Transfer Assist\"] } — same as the website's sub-task checkboxes under each care type.",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
        frequency:     { type: "string", description: "e.g. 'weekly', 'one-time'" },
        days:          { type: "array", items: { type: "string" } },
        timeOfDay:     { type: "array", items: { type: "string" } },
        hourlyRate:    { type: "number", description: "Omit entirely for a flexible/negotiable rate — do not pass 0." },
        streetAddress: { type: "string", description: "Optional street address — saved to the family's care plan, not shown on the public job post" },
        zipCode:       { type: "string", description: "5-digit zip — required, city/state are auto-derived from it" },
        startDate:     { type: "string", description: "YYYY-MM-DD" },
        endDate:       { type: "string", description: "YYYY-MM-DD — only if this is a date-limited request, not ongoing" },
        careLevel:          { type: "string", description: "Optional overall care level" },
        minHoursPerWeek:    { type: "number", description: "Optional minimum hours per week" },
        caregiversNeeded:   { type: "number", description: "Optional, 1-4 — how many caregivers this job is looking to hire. Defaults to 1 if not mentioned, same as the website." },
        careRecipients: {
          type: "array",
          description: "EVERY care recipient this job covers — both someone new AND anyone already on the family's roster/care plan (check the CARE PLAN section of your context first). Including an existing recipient here is safe and expected: it will NOT create a duplicate, it just keeps their care plan (care needs, notes, location) in sync with this job post.",
          items: {
            type: "object",
            properties: {
              firstName:    { type: "string" },
              lastName:     { type: "string" },
              relationship: { type: "string" },
            },
            required: ["firstName"],
          },
        },
      },
      required: ["clientId", "title", "notes", "careTypes", "zipCode"],
    },
  },
  {
    name: "list_proactive_drafts",
    description: "List Evia's pending proactive message drafts queued for this family that haven't sent yet.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "Injected automatically." } }, required: ["userId"] },
  },
  {
    name: "cancel_proactive_draft",
    description: "Cancel a pending proactive message draft so Evia doesn't send it. Only works on drafts that haven't already sent.",
    input_schema: { type: "object", properties: { userId: { type: "string", description: "Injected automatically." }, draftId: { type: "string" } }, required: ["userId", "draftId"] },
  },
  {
    name: "schedule_followup",
    description:
      "Schedule a one-time proactive follow-up message to send to the family at a future time. " +
      "Use this when the family mentions a future event (doctor appointment, test results, family visit, procedure) and a check-in would be natural. " +
      "Examples: 'Mom has her MRI Thursday' → schedule a follow-up Friday morning. 'We're trying a new medication this week' → schedule 3 days out. " +
      "Do NOT use for recurring reminders (use create_reminder instead). Do NOT schedule without a clear reason.",
    input_schema: {
      type: "object",
      properties: {
        phone:       { type: "string",  description: "The family's phone number" },
        userId:      { type: "string",  description: "The family's user ID" },
        message:     { type: "string",  description: "The exact text Evia will send as the follow-up" },
        scheduledAt: { type: "string",  description: "ISO 8601 datetime for when to send (e.g. '2026-05-20T09:00:00.000Z')" },
        reason:      { type: "string",  description: "One-sentence reason why this follow-up makes sense (for context at fire time)" },
      },
      required: ["phone", "userId", "message", "scheduledAt", "reason"],
    },
  },
  {
    name: "resume_execution_agent",
    description:
      "Route a family message to an active background execution agent (e.g. a matching agent that presented caregivers). " +
      "Use this when the family is asking a follow-up question about an ongoing task — 'tell me more about the second one', " +
      "'what's her experience with dementia?', 'what's her rate again?'. " +
      "The agent has full context of the task. Return its response EXACTLY as-is, without rephrasing or adding to it.",
    input_schema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The execution agent document ID from ACTIVE EXECUTION AGENT context" },
        input:   { type: "string", description: "The family's message to pass to the agent" },
      },
      required: ["agentId", "input"],
    },
  },
  {
    name: "get_caregiver_appointments",
    description: "Get upcoming scheduled appointments for a caregiver — used when a caregiver asks about their schedule.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        daysAhead:   { type: "number", description: "How many days ahead to look (default 7, max 30)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_pending_tasks",
    description:
      "Everything the website shows the family as pending, in one read — the exact items and conditions of its pages: " +
      "booking requests and visit requests still awaiting the caregiver (My Bookings > Requests), visits marked Needs Replacement " +
      "(Find Replacement / Skip) and reschedule proposals (a caregiver's proposal is waiting on the family; the family's own is waiting " +
      "on the caregiver), interview requests and interview reschedule proposals (Care Requests > Interviews), the Care Plan review " +
      "banner, and timesheets to review. Each item says waitingOn: 'you' (the family) or 'caregiver', and which page it lives on. " +
      "Call this when the family says hello or asks 'anything going on / anything I need to do?'. Nothing else is ever pending — " +
      "if it isn't here, don't say something is waiting.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "suggest_upcoming_care",
    description:
      "Check if the client has upcoming care coverage and whether a preferred caregiver has availability. " +
      "Call this when the family is chatting casually and you want to proactively surface a relevant booking opportunity. " +
      "Returns: hasVisitNextWeek (boolean), preferredCaregiverAvailable (boolean), caregiverName, suggestedDate.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        phone:    { type: "string", description: "The client's phone number" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_care_plan",
    description:
      "The website's Care Plan page, exactly: every care recipient (tab) with their Care Needs & Tasks (careNeeds + sub-tasks), " +
      "Care Location, Notes, Lifestyle & Preferences ('Not specified' when empty), plus the shared locationPool, the Emergency " +
      "Contacts card (and the signup contact), whether the plan has been reviewed ('Looks good'), and the page's option lists. " +
      "Call before any care plan question or change. Non-medical — there are no medications or diagnoses on this page.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "update_care_plan",
    description:
      "Edit one section of the website's Care Plan page for one care recipient — the pencil on that section: " +
      "'careNeeds' (the fixed pills; removing a need also drops its sub-tasks, like the page), 'careNeedDetails' (sub-tasks " +
      "under a selected need, e.g. Meal Preparation → Breakfast), 'notes', 'lifestyle' (pass only the fields changing), " +
      "'careLocation' (street/city/state/zipCode — an address already in locationPool is reused, a new one is geocoded and " +
      "added to the pool), 'emergencyContacts' (the Emergency Contacts card — items {name, relation, phone, isPrimary}; the " +
      "card holds at most 2 contacts including the signup contact; phone must be 10+ digits), or 'reviewed' (the 'Looks good' " +
      "button — value true). This is a non-medical marketplace: never solicit or record medications, diagnoses, or other medical " +
      "details. MANDATORY: read the change back in plain English and wait for explicit confirmation before calling. When the " +
      "household has more than one recipient, pass recipientFirstName.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        field:    { type: "string", enum: ["careNeeds", "careNeedDetails", "notes", "lifestyle", "careLocation", "emergencyContacts", "reviewed"], description: "Which section to edit." },
        value:    {
          description:
            "careNeeds: array of pills (set) or one pill (append/remove). careNeedDetails: { \"<need>\": [sub-tasks] } (set/append/remove on that need). " +
            "notes: string. lifestyle: partial object of {favoriteActivities[], favoriteActivitiesOther, helpActivities[], entertainment[], entertainmentOther, " +
            "enjoysConversation, prefersQuiet, familyInArea, familyVisitFreq, friendsVisitors, friendsVisitFreq, hasAppointments, appointmentsDetails}. " +
            "careLocation: {street, city, state, zipCode}. emergencyContacts: array (set) or one contact (append/remove) of {name, relation, phone, isPrimary}. reviewed: true.",
        },
        action:   { type: "string", enum: ["set", "append", "remove"], description: "set = replace, append = add, remove = remove. notes/lifestyle/careLocation/reviewed only support 'set'." },
        recipientFirstName: { type: "string", description: "Which care recipient (tab) — required when the household has more than one." },
      },
      required: ["clientId", "field", "value", "action"],
    },
  },
  {
    name: "update_caregiver_profile",
    description:
      "Update your own caregiver profile — hourly rate, bio, city, or weekly availability. " +
      "Only you can update your own profile. Changes take effect immediately. To change your " +
      "PHONE NUMBER, pass requestPhoneChange:true instead of a new number — login here is by " +
      "phone number, so it emails a secure link to the address on file and the new number is " +
      "entered and verified there, never over SMS.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:        { type: "string",  description: "Your caregiver Firestore document ID" },
        hourlyRate:         { type: "number",  description: "Your new hourly rate in dollars" },
        bio:                { type: "string",  description: "Your updated bio (max 2500 characters)" },
        phone:              { type: "string",  description: "Your current session phone; used to verify account ownership and never changed by this tool" },
        requestPhoneChange: { type: "boolean", description: "Set true to start a phone number change (see description) — a request flag, not the new number itself" },
        city:               { type: "string",  description: "Your city" },
        weeklyAvailability: { type: "object",  description: "Object mapping day abbreviations to time windows" },
      },
      required: ["caregiverId", "phone"],
    },
  },
  {
    name: "pause_account",
    description:
      "Pause your own caregiver account so you stop receiving job matches (e.g. vacation, a break). " +
      "Reversible at any time with reactivate_account. Only you can pause your own account.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "Your caregiver Firestore document ID" },
        until:       { type: "string", description: "When to pause until: an ISO date 'YYYY-MM-DD', or 'indefinite' for an open-ended pause" },
        phone:       { type: "string", description: "The acting caregiver's phone — auto-injected; used to verify you own this account" },
      },
      required: ["caregiverId", "until"],
    },
  },
  {
    name: "reactivate_account",
    description:
      "Reactivate your own paused caregiver account so you start receiving job matches again. " +
      "Only you can reactivate your own account.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "Your caregiver Firestore document ID" },
        phone:       { type: "string", description: "The acting caregiver's phone — auto-injected; used to verify you own this account" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "accept_shift",
    description:
      "Accept the shift offer the family or system just sent you — confirms the visit. " +
      "Use when you agree to take your current pending offer. There's nothing to pass; it resolves your active offer.",
    input_schema: {
      type: "object",
      properties: {
        phone:  { type: "string", description: "The acting caregiver's phone — auto-injected" },
        chatId: { type: "string", description: "The caregiver's chat id — auto-injected" },
      },
      required: [],
    },
  },
  {
    name: "decline_shift",
    description:
      "Decline the shift offer the family or system just sent you. " +
      "Use when you can't take your current pending offer; the system will line up a replacement.",
    input_schema: {
      type: "object",
      properties: {
        phone:  { type: "string", description: "The acting caregiver's phone — auto-injected" },
        chatId: { type: "string", description: "The caregiver's chat id — auto-injected" },
      },
      required: [],
    },
  },
  {
    name: "complete_task",
    description:
      "Signal that you've finished this turn — call this INSTEAD of a plain text reply when you've " +
      "achieved the outcome or are blocked. The message you pass is sent to the user as your reply. " +
      "status: 'done' (outcome achieved), 'blocked' (can't proceed — say why in the message), or " +
      "'needs_user' (waiting on the user). Do NOT use status 'done' while an action is still awaiting " +
      "the user's YES/NO confirmation.",
    input_schema: {
      type: "object",
      properties: {
        status:  { type: "string", enum: ["done", "blocked", "needs_user"], description: "Completion status" },
        message: { type: "string", description: "The user-facing message to send as your final reply this turn" },
      },
      required: ["status", "message"],
    },
  },
  {
    name: "save_onboarding_field",
    description:
      "During onboarding, persist ONE field the user just gave you (e.g. the senior's name, " +
      "the family relationship, care needs, the caregiver's rate). Call this as soon as you've " +
      "confirmed a value — one call per field. It returns the fields still missing so you know " +
      "what to ask next. Do NOT use this outside an active onboarding turn.",
    input_schema: {
      type: "object",
      properties: {
        role:       { type: "string", enum: ["client", "caregiver"], description: "Which onboarding flow this is (auto-injected; pass the current role)" },
        fieldName:  { type: "string", description: "The onboardingData field to set, e.g. firstName, seniorName, age, careNeeds, city, daysPerWeek, timeOfDay, hourlyRate" },
        fieldValue: { description: "The value to store. Pass numbers (like age) as a number, lists (like careNeeds) as an array — not as strings.", oneOf: [{ type: "string" }, { type: "number" }, { type: "array" }, { type: "object" }] },
      },
      required: ["role", "fieldName", "fieldValue"],
    },
  },
  {
    name: "complete_collection",
    description:
      "Signal that you've collected every required onboarding field. It re-checks the required " +
      "set: if anything is still missing it returns the missing list and does NOT advance (keep " +
      "collecting). If complete (client role), a real caregiver-match preview is sent as a SEPARATE " +
      "message right after this one — so your own closing message must NEVER say or imply that " +
      "matching/searching for caregivers only starts once membership is paid (that directly " +
      "contradicts the real match the family is about to see). Frame membership as what lets them " +
      "message and book someone like the match you're about to show, not as what unlocks matching " +
      "itself. Call ONLY when you believe collection is done.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["client", "caregiver"], description: "Which onboarding flow this is" },
      },
      required: ["role"],
    },
  },
  {
    name: "add_family_member",
    description:
      "Add a new family member to this care group. They receive a welcome SMS and start getting updates. " +
      "Only the primary client can add members.",
    input_schema: {
      type: "object",
      properties: {
        seniorId:    { type: "string", description: "The senior's profile document ID" },
        name:        { type: "string", description: "The new member's name" },
        memberPhone: { type: "string", description: "Phone number (E.164) of the family member being added" },
        phone:       { type: "string", description: "The acting user's phone — auto-injected; this is NOT the member being added" },
        clientId:    { type: "string", description: "The primary client's user ID" },
      },
      required: ["seniorId", "name", "memberPhone", "clientId"],
    },
  },
  {
    name: "remove_family_member",
    description:
      "Remove a family member from this care group. They stop receiving updates. " +
      "IMPORTANT: Only call after the primary client has explicitly confirmed.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's profile document ID" },
        memberPhone: { type: "string", description: "Phone number (E.164) of the family member to remove" },
        phone:    { type: "string", description: "The acting user's phone — auto-injected for SMS confirmation; this is NOT the member being removed" },
        clientId: { type: "string", description: "The primary client's user ID" },
      },
      required: ["seniorId", "memberPhone", "clientId"],
    },
  },
  {
    name: "start_review_flow",
    description:
      "Start Evia's scripted Leave a Review flow for a caregiver — the website's review modal, step for step (overall stars 1–5, optional category " +
      "ratings, a 10–250 character review, would-you-recommend YES/NO, a recap, then YES to post). Use when the family wants to review or rate a caregiver they " +
      "have had a completed visit with; the flow checks that itself (one review per caregiver per family) and tells them if they can't yet. This tool ALREADY " +
      "TEXTS THE FAMILY the first question — send NOTHING else this turn. Do not collect the rating or comment yourself.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string",  description: "The caregiver being reviewed" },
        rating:      { type: "integer", minimum: 1, maximum: 5, description: "Only if the family already stated a star count in THIS message" },
      },
      required: ["caregiverId"],
    },
  },
  {
    // Cancel + reactivate merged into one tool (2026-09-02, same reasoning as
    // set_block_status's 2026-08-31 merge) to make room for delete_account
    // under OpenAI's 128-tool cap.
    name: "set_subscription_status",
    description:
      "Cancel or reactivate the family's Evia membership. Cancel takes effect at end of billing period — " +
      "scheduled visits are unaffected. MANDATORY for action:'cancel': tell the family when their subscription " +
      "ends and confirm before calling. Reactivate needs no confirmation.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        action:   { type: "string", enum: ["cancel", "reactivate"], description: "cancel or reactivate" },
      },
      required: ["clientId", "action"],
    },
  },
  {
    name: "delete_account",
    description: "Permanently delete the family or caregiver's own Evia account — cancels any active subscription, removes their data, and deletes their login. MANDATORY: this is irreversible; confirm with them explicitly (read back that this is permanent) before calling.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID (client or caregiver)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "create_care_journal_entry",
    description:
      "Create a care journal entry after a visit — notes, mood, whether medications were given, activities. " +
      "Used by caregivers to log what happened during the shift.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string",  description: "Your caregiver document ID" },
        appointmentId: { type: "string",  description: "The appointment document ID" },
        notes:         { type: "string",  description: "Visit notes" },
        mood:          { type: "string",  enum: ["good","fair","poor"], description: "Senior's mood during visit" },
        medsGiven:     { type: "boolean", description: "Whether medications were administered" },
        activities:    { type: "array",   items: { type: "string" }, description: "Activities done during the visit" },
        recipientFirstName: { type: "string", description: "First name of the care recipient this entry is about — pass it when the household cares for more than one person; omit otherwise." },
      },
      required: ["caregiverId", "appointmentId", "notes"],
    },
  },
  {
    name: "apply_to_job",
    description:
      "Apply to an open job post. Optionally include a proposed hourly rate and a short cover note.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:  { type: "string", description: "Your caregiver document ID" },
        jobId:        { type: "string", description: "The job_posts document ID" },
        proposedRate: { type: "number", description: "Your proposed hourly rate" },
        coverNote:    { type: "string", description: "Brief cover note to the client" },
      },
      required: ["caregiverId", "jobId"],
    },
  },
  {
    name: "respond_to_job_application",
    description:
      "Accept or reject a caregiver's application to your job post. The website has no direct 'accept' action — " +
      "accepting an applicant means requesting an interview with them (preferredDate/preferredTime required); " +
      "the job isn't marked filled until a booking is actually sent and accepted later. " +
      "Call this tool the moment the family states their decision — for BOTH accept and reject. " +
      "Rejecting is irreversible and the system itself will ask the family to confirm before it actually " +
      "takes effect (you'll get back a confirmation request, not a result) — do not ask them to confirm " +
      "yourself in conversation first, and do not tell them it's done until this tool actually returns success. " +
      "Never say an application was accepted/rejected/declined without this tool having returned that result. " +
      "Rejecting matches the website's Decline button exactly: the application is marked rejected and the caregiver is " +
      "NOT messaged (they see it on their Job Board) — do not offer to send them a note. " +
      "MANDATORY: applicationId must come from a list_job_applicants result from THIS turn — never guess it or " +
      "reuse one from earlier in the conversation, and never substitute the applicant's caregiverId (a different " +
      "field on the same record) for applicationId; they are not interchangeable and mixing them up fails with " +
      "NOT_FOUND. If you don't already have a fresh applicationId in hand, call list_job_applicants first.",
    input_schema: {
      type: "object",
      properties: {
        applicationId:  { type: "string", description: "The job_applications document ID from list_job_applicants — NOT the applicant's caregiverId, a different field on the same record" },
        clientId:       { type: "string", description: "The client's user ID" },
        decision:       { type: "string", enum: ["accept","reject"], description: "accept (request an interview) or reject" },
        preferredDate:  { type: "string", description: "Required when accepting — e.g. '2026-09-01'" },
        preferredTime:  { type: "string", description: "Required when accepting — e.g. '14:00'" },
        interviewType:  { type: "string", description: "Optional, defaults to 'video'" },
        notes:          { type: "string", description: "Optional, accept only — anything to flag for the interview (topics to discuss, etc.). The job this interview relates to is linked automatically from the application — no need to ask for it." },
      },
      required: ["applicationId", "clientId", "decision"],
    },
  },
  {
    name: "submit_interview_feedback",
    description:
      "Submit your decision after interviewing a caregiver. Also marks the interview completed (the website's own separate " +
      "'Mark as Completed' step, done automatically here since it's one turn in a conversation, not two button clicks). " +
      "Options: 'strong' (the family wants to hire), 'maybe' (keep considering), 'no' (not a fit — matches the website's 'Not Selected'). " +
      "IMPORTANT: 'strong' only RECORDS the decision — it does NOT create an actual booking and does NOT notify the " +
      "caregiver of anything (no schedule, no rate, nothing for them to accept yet, and nothing sent to them at this " +
      "stage — matching the website's own 'Mark as Completed' + fit-decision step exactly: the caregiver hears " +
      "nothing until the family's own 'Send Booking' button / its Evia equivalent, start_booking_flow, actually creates " +
      "the real booking). On a 'strong' result, immediately call start_booking_flow with this same interviewId — it " +
      "asks every remaining question (rate, schedule, care location if ambiguous), shows the full recap matching the " +
      "website's 'Send Booking Request' modal, and on YES performs the exact write the website's 'Send Booking' " +
      "button performs — the ONLY point at which the caregiver is ever notified. Never leave a 'strong' decision " +
      "without starting the booking flow in the same or next turn; if the conversation stalls first, a follow-up " +
      "nudge (bookingFollowupNudge.ts) will check back in after an hour and every ~48h until a real booking exists.",
    input_schema: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "The video_interviews document ID" },
        clientId:    { type: "string", description: "The client's user ID" },
        fitLevel:    { type: "string", enum: ["strong","maybe","no"], description: "Fit assessment" },
        notes:       { type: "string", description: "Optional notes" },
      },
      required: ["interviewId", "clientId", "fitLevel"],
    },
  },
  {
    name: "complete_interview",
    description:
      "Mark a past interview as completed (matches the website's own 'Mark as Completed' button, shown once the scheduled " +
      "time has passed). Use this when the family confirms the interview happened but hasn't given a fit decision yet — " +
      "if they're also ready to say whether it went well, use submit_interview_feedback instead, which does this automatically.",
    input_schema: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "The video_interviews document ID" },
        clientId:    { type: "string", description: "The client's user ID" },
      },
      required: ["interviewId", "clientId"],
    },
  },
  {
    name: "request_instant_payout",
    description:
      "Request an instant payout of the caregiver's instantly-available balance — Stripe's 1% instant fee (min $0.50) is deducted from it (founder decision 2026-09-19); arrives within ~30 minutes. Always tell the caregiver the fee and what arrives. " +
      "If no amount specified, pays out the full instantly-available balance. Regular earnings need no request: " +
      "Stripe pays the balance out automatically every day (arrives ~2 business days after each shift payment).",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:  { type: "string",  description: "Your caregiver document ID" },
        amountCents:  { type: "integer", description: "Amount in cents (optional — omit for full balance)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "submit_shift_hours",
    description:
      "Submit your actual clock-in and clock-out times for a completed visit. " +
      "The client will review and approve before payment is processed.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string",  description: "Your caregiver document ID" },
        appointmentId: { type: "string",  description: "The appointment document ID" },
        clockInTime:   { type: "string",  description: "Clock-in time in HH:MM format" },
        clockOutTime:  { type: "string",  description: "Clock-out time in HH:MM format" },
        breakMinutes:  { type: "integer", description: "Break duration in minutes (default 0)" },
      },
      required: ["caregiverId", "appointmentId", "clockInTime", "clockOutTime"],
    },
  },
  {
    name: "review_shift_hours",
    description:
      "Approve, correct, or resolve a dispute on a caregiver's submitted shift hours — mirrors the website's Timesheets review modal exactly, action for action. " +
      "'approve' accepts the hours as submitted. 'propose_correction' proposes a different start/end time (give BOTH — a correction can fix either one independently, not just total hours). " +
      "'accept_counter'/'escalate' resolve a caregiver's counter-proposal after you've already proposed a correction and they pushed back — 'accept_counter' takes their counter-offer, 'escalate' sends it to Evia's team to mediate. " +
      "Only one of these four actions is valid at a time depending on the shift's current status; the tool tells you which if you pick the wrong one.",
    input_schema: {
      type: "object",
      properties: {
        clientId:          { type: "string", description: "The client's user ID" },
        appointmentId:     { type: "string", description: "The shiftHours document ID" },
        action:            { type: "string", enum: ["approve","propose_correction","accept_counter","escalate"], description: "Which action to take" },
        proposedStartTime: { type: "string", description: "Corrected start time (required for propose_correction), e.g. '2:00 PM'" },
        proposedEndTime:   { type: "string", description: "Corrected end time (required for propose_correction), e.g. '5:00 PM'" },
        proposalReason:    { type: "string", description: "Why the correction is being proposed (optional)" },
        lineItems:         { type: "array", description: "Corrected additional charges for propose_correction (the modal lets the family remove a charge); omit to keep the submitted ones", items: { type: "object" } },
      },
      required: ["clientId", "appointmentId", "action"],
    },
  },
  {
    name: "withdraw_job_application",
    description:
      "Withdraw your own pending application to a job post. The client/admin views stop showing it as active. " +
      "Only works while the application is still pending (not yet accepted, rejected, or interview-scheduled).",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        applicationId: { type: "string", description: "The job_applications document ID to withdraw" },
        reason:        { type: "string", description: "Optional short reason for withdrawing" },
      },
      required: ["caregiverId", "applicationId"],
    },
  },
  {
    name: "respond_to_booking_request",
    description:
      "Accept or decline a booking request a family sent you (e.g. when you text 'I can do it' or 'I can't make that'). " +
      "Accepting confirms the appointment and triggers the family's confirmation flow; declining frees it up for re-matching.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        appointmentId: { type: "string", description: "The appointment document ID for the pending booking request" },
        decision:      { type: "string", enum: ["accept", "decline"], description: "accept or decline" },
        message:       { type: "string", description: "Optional note to the family" },
      },
      required: ["caregiverId", "appointmentId", "decision"],
    },
  },
  {
    name: "start_shift",
    description:
      "Clock in / start a scheduled visit. Marks the visit in-progress and records the start time. " +
      "Safe to call more than once — if the visit is already started it just confirms the existing start.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        appointmentId: { type: "string", description: "The appointment document ID (provide this or shiftId)" },
        shiftId:       { type: "string", description: "The shifts document ID (provide this or appointmentId)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "complete_shift",
    description:
      "Clock out / complete a visit. Marks the visit completed and records the end time. " +
      "Idempotent — calling it again after the visit is already completed will NOT create a second billable record.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        appointmentId: { type: "string", description: "The appointment document ID (provide this or shiftId)" },
        shiftId:       { type: "string", description: "The shifts document ID (provide this or appointmentId)" },
        notes:         { type: "string", description: "Optional completion notes" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "update_shift_task",
    description:
      "Mark a visit care task / checklist item complete (or undo it). Reflects on the family and caregiver visit views. " +
      "Task keys follow the recipient_careNeed[_subtask] format the dashboard uses (e.g. '0_Medication' or '0_Bathing_Shower').",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string",  description: "Your caregiver document ID" },
        shiftId:     { type: "string",  description: "The shifts document ID for the visit" },
        taskKey:     { type: "string",  description: "The task key to toggle (recipient_careNeed[_subtask])" },
        completed:   { type: "boolean", description: "true to mark complete, false to undo (default true)" },
      },
      required: ["caregiverId", "shiftId", "taskKey"],
    },
  },
  {
    name: "submit_media_update",
    description:
      "Send a photo / media care update to the family for a visit. Appears in the care journal and live updates feed. " +
      "Use this when the caregiver shares a picture or video link of the senior during a shift.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        appointmentId: { type: "string", description: "The appointment document ID" },
        mediaUrl:      { type: "string", description: "URL of the uploaded photo/video" },
        caption:       { type: "string", description: "Optional caption / note for the family" },
        mediaType:     { type: "string", enum: ["photo", "video"], description: "photo or video (default photo)" },
      },
      required: ["caregiverId", "appointmentId", "mediaUrl"],
    },
  },
  {
    name: "respond_to_shift_hour_correction",
    description:
      "Respond to a client/admin correction on your submitted shift hours: accept the corrected hours, or push back to dispute them. " +
      "Only works when the shift hours are in a correction_proposed state (legacy correction_requested/disputed records are also accepted).",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "Your caregiver document ID" },
        appointmentId: { type: "string", description: "The appointment document ID (shiftHours doc id)" },
        decision:      { type: "string", enum: ["accept", "pushback"], description: "accept the corrected hours, or pushback to dispute" },
        message:       { type: "string", description: "Optional note (recommended when pushing back)" },
      },
      required: ["caregiverId", "appointmentId", "decision"],
    },
  },
  {
    name: "create_caregiver_referral",
    description:
      "Invite a referred caregiver by SMS. Writes a non-bookable referral record, sends the application link, " +
      "and keeps the referred caregiver gated on onboarding plus Checkr clear before bookability.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:    { type: "string", description: "The referring caregiver document ID" },
        phone:          { type: "string", description: "The referring caregiver's SMS phone number" },
        referredName:   { type: "string", description: "Name of the caregiver being referred" },
        referredPhone:  { type: "string", description: "Phone number to text the application link to" },
      },
      required: ["caregiverId", "phone", "referredName", "referredPhone"],
    },
  },
  {
    name: "create_support_ticket",
    description:
      "Create a support ticket for an issue that needs admin review.",
    input_schema: {
      type: "object",
      properties: {
        userId:      { type: "string", description: "Your user ID" },
        userType:    { type: "string", enum: ["client","caregiver"], description: "client or caregiver" },
        subject:     { type: "string", description: "Short subject line" },
        description: { type: "string", description: "Full description of the issue" },
        category:    { type: "string", enum: ["billing","booking","caregiver","technical","other"], description: "Issue category" },
      },
      required: ["userId", "userType", "subject", "description"],
    },
  },

  // ── Full-platform coverage tools ─────────────────────────────────────────
  {
    name: "start_interview_flow",
    description:
      "Start Evia's own scripted, step-by-step interview-scheduling flow for a caregiver — the PREFERRED way to " +
      "request an interview once the family is ready (e.g. after naming a caregiver, or right after finding a " +
      "match). This tool itself asks the family every remaining question (related job post, if any are open — date " +
      "— time — an optional note) one at a time and shows a full recap matching the website's 'Request Interview' " +
      "modal before sending — you do NOT need to collect any of that yourself, and should NOT call " +
      "schedule_interview directly for a new request. This tool ALREADY TEXTS THE FAMILY the first question itself " +
      "— do not send anything else this turn beyond a brief acknowledgment that you're setting up the interview, " +
      "if anything at all. The flow also lets the family back out cleanly at any point (\"never mind\"/\"cancel " +
      "this\") — you don't need to handle that yourself either.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The caregiver being interviewed." },
        applicationId: { type: "string", description: "Pass this when the family is interviewing someone who applied to a specific job post — the job is already known and won't be asked about again. Omit for a direct/matching-flow interview with no application involved." },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "schedule_interview",
    description:
      "Low-level interview commit — prefer start_interview_flow instead, which handles the whole conversation for " +
      "you and matches the website's Request Interview modal exactly. Only call this tool directly for an interview " +
      "OUTSIDE the scripted flow (e.g. respond_to_job_application's accept branch, which already knows the job and " +
      "caregiver deterministically). " +
      "Creates the interview record; the Google Meet link is generated and texted to both parties automatically " +
      "once the caregiver confirms via respond_to_interview_request — do NOT tell the family a link exists yet. " +
      "Same rules as the website's own Request Interview modal: the caregiver must be a real, currently-bookable " +
      "match, and families are capped at 5 interview requests per day — if you get a RATE_LIMITED error, tell them " +
      "honestly they've hit today's limit and to try again tomorrow. No interview-type question — the website " +
      "removed Phone/In-Person entirely (2026-09-08); every interview is video, always pass/default interviewType " +
      "to video. " +
      "The platform requires and enforces its own confirmation before this actually executes (it will show the " +
      "family the exact caregiver name it resolved and ask them to confirm) — do NOT ask the family to confirm the " +
      "caregiver a second time yourself first, just call it once you have the caregiverId and date/time.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "The client's user ID" },
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        applicationId: { type: "string", description: "The job_applications document ID (optional)" },
        preferredDate: { type: "string", description: "Date in YYYY-MM-DD format" },
        preferredTime: { type: "string", description: "Time in HH:MM (24h) format" },
        interviewType: { type: "string", enum: ["video","phone","in_person"], description: "Default: video — the website has no selector, every interview is video." },
        jobId:         { type: "string", description: "Optional — the job_posts document ID this interview relates to, if the family mentions a specific posted job." },
        notes:         { type: "string", description: "Optional — anything the family wants to flag for the interview (topics to discuss, etc.), same as the website modal's Notes field." },
      },
      required: ["clientId", "caregiverId", "preferredDate", "preferredTime"],
    },
  },
  {
    // 2026-09-09 (live-caught): "I'd already sent their info before. Want me
    // to send their profiles again?" has been a real, standing offer in the
    // no-new-match re-offer message since 2026-09-07 with nothing behind it —
    // there was no way to actually resend a caregiver's profile, only to send
    // one for the first time as part of a fresh match. This tool delivers on
    // that promise: same caption + tappable profile-link format the initial
    // match gallery sends (services/api.ts's /p/{id} share link, which
    // previews with the caregiver's name + photo).
    name: "resend_caregiver_profile",
    description:
      "Re-send a caregiver's profile card (rate, specialties, tappable link with their name + photo preview) to " +
      "the family — the same message format the initial match gallery sends. Use when the family asks to see a " +
      "caregiver's profile again (e.g. after 'I'd already sent their info before — want me to send it again?'), " +
      "or wants to resend/re-share someone's info for any reason. Pass the caregiverId from pendingMatches or " +
      "reofferableCaregivers — never guess an id from a name.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's user ID" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (from pendingMatches/reofferableCaregivers, never a name)" },
      },
      required: ["clientId", "caregiverId"],
    },
  },
  {
    name: "respond_to_interview_request",
    description:
      "Caregiver accepts or declines a scheduled interview. If proposing a new time, include proposedDate and proposedTime.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        interviewId:   { type: "string", description: "The video_interviews document ID" },
        decision:      { type: "string", enum: ["accept","decline"], description: "accept or decline" },
        proposedDate:  { type: "string", description: "Alternative date YYYY-MM-DD (when declining with counter-offer)" },
        proposedTime:  { type: "string", description: "Alternative time HH:MM (when declining with counter-offer)" },
        message:       { type: "string", description: "Optional message to the client" },
      },
      required: ["caregiverId", "interviewId", "decision"],
    },
  },
  {
    name: "get_care_team",
    description:
      "The website's My Care Team page, exactly: the Active tab (caregivers with an accepted booking that still has a scheduled " +
      "or in-progress visit) and the Past tab (cancelled/completed bookings, or accepted ones whose visits have all run out — the " +
      "most recent booking per caregiver; a caregiver is never in both). Each card: name, photo, 'Active booking' pill (active tab), " +
      "stars + review count or 'No reviews yet', verification, years of experience, $rate/hr (the booking's rate, else the profile " +
      "rate), the booking's schedule days, up to 3 specialties, 'Caring for: <recipients>', and its buttons — Message, Profile, and " +
      "Re-book (Past tab only, when the family already completed an interview with them). Optional query = the page's 'Search by " +
      "name…' box. Call when they ask 'who's on my team', 'my caregivers', 'who do I have', 'who used to help us'. Caregiver phone " +
      "numbers are never part of this page — messaging goes through send_caregiver_message.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        tab:      { type: "string", enum: ["active", "past", "both"], description: "Which tab to return (default both)." },
        query:    { type: "string", description: "The page's Search by name… box — case-insensitive name match." },
      },
      required: ["clientId"],
    },
  },
  {
    name: "edit_job_post",
    description:
      "Edit an existing OPEN job post — the website's Edit post modal (Care Requests > Posts > ... > Edit post), same " +
      "fields, same rules: description, rate or rateFlexible (flexible stores rate 0), jobFrequency, startDate, " +
      "endDate or ongoing (ongoing clears the end date), daysOfWeek, timeOfDay, careTypes (must stay non-empty), " +
      "petsInHome, smokingHousehold, caregiversNeeded, recipientsCount. Read the post's current values back to the " +
      "family (list_client_jobs) and confirm the exact changes before calling. Cannot change status — use " +
      "cancel_job_post for that.",
    input_schema: {
      type: "object",
      properties: {
        jobId:            { type: "string", description: "The job_posts document ID" },
        clientId:         { type: "string", description: "The client's user ID (ownership check)" },
        description:      { type: "string" },
        rate:             { type: "number", description: "Hourly rate" },
        rateFlexible:     { type: "boolean", description: "true = 'Rate flexible' (rate stored as 0)" },
        jobFrequency:     { type: "string", enum: ["occasional", "part-time", "full-time"] },
        startDate:        { type: "string", description: "YYYY-MM-DD" },
        endDate:          { type: "string", description: "YYYY-MM-DD — ignored when ongoing is true" },
        ongoing:          { type: "boolean" },
        daysOfWeek:       { type: "array", items: { type: "string" } },
        timeOfDay:        { type: "array", items: { type: "string" } },
        careTypes:        { type: "array", items: { type: "string" }, description: "At least one" },
        petsInHome:       { type: "boolean" },
        smokingHousehold: { type: "boolean" },
        caregiversNeeded: { type: "number" },
        recipientsCount:  { type: "number" },
      },
      required: ["jobId", "clientId"],
    },
  },
  {
    name: "send_client_message",
    description:
      "Send a message to a client on behalf of a caregiver. Delivers by text AND posts into the same chat thread the " +
      "family sees in their website Inbox, so this shows up as a real reply there, not just in this SMS conversation. " +
      "Tell the caregiver what you're sending before calling.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        clientId:    { type: "string", description: "The client's user ID (optional — resolved from recent appointments if omitted)" },
        message:     { type: "string", description: "The message to send to the client" },
      },
      required: ["caregiverId", "message"],
    },
  },
  {
    name: "get_payout_history",
    description:
      "Get a caregiver's recent payout records — dates, amounts, and transfer status from Stripe.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        limit:       { type: "number", description: "Number of payouts to return (default 5, max 20)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_recent_messages",
    description:
      "The website's Inbox page, exactly. Without counterpartId: the thread list — every conversation (newest first) minus " +
      "blocked or deleted ones, grouped like the page into My Care Team (caregivers on an accepted booking), Other Caregivers " +
      "and Support, each with the last message (or 'Start a conversation'), its time and unread count; 'query' is the page's " +
      "search box (name or last message). With counterpartId: that conversation's messages oldest → newest (hiding anything " +
      "before the family deleted it), and it marks the thread read exactly like opening it on the page. Use for 'what did " +
      "Basra say', 'any new messages', 'catch me up'.",
    input_schema: {
      type: "object",
      properties: {
        userId:       { type: "string", description: "The current user's ID (client or caregiver)" },
        counterpartId:{ type: "string", description: "Specific caregiver or client ID to filter (optional)" },
        limit:        { type: "number", description: "Messages to return for one conversation (default 20, max 50)" },
        query:        { type: "string", description: "The Inbox search box — filters the thread list by contact name or last message" },
        role:         { type: "string", enum: ["client", "caregiver"], description: "Whose inbox this is (default client)" },
      },
      required: ["userId"],
    },
  },

  // ── Platform-action tools (post-onboarding) ───────────────────────────────
  {
    name: "list_client_jobs",
    description:
      "The family's Care Requests > Posts tab: every job post with exactly what its card shows — title, status, type " +
      "(jobFrequency), start/end date, location, rate (or rate flexible), days, time of day, care types, description, " +
      "recipientsCount ('1 senior'), caregiversNeeded with hiredCount ('0 of 1 hired'), and pendingApplicantCount. " +
      "status 'open' = the Open pill, 'closed' = the Closed pill (anything not open).",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        status:   { type: "string", enum: ["open","closed","filled","cancelled","all"], description: "Filter (default: all)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "cancel_job_post",
    description:
      "Close an open job post. Only call after the client has explicitly confirmed they want to close it.",
    input_schema: {
      type: "object",
      properties: {
        jobId:    { type: "string", description: "The job_posts document ID" },
        clientId: { type: "string", description: "The client's user ID (ownership check)" },
      },
      required: ["jobId", "clientId"],
    },
  },
  {
    name: "list_job_applicants",
    description:
      "The website's View Applicants panel for one job post: pending applicants (same as the panel) with name, rate, " +
      "experience, cover note, and — exactly as the panel labels them — whether each is locked: label 'Hired' (accepted " +
      "booking), 'Booking Sent', 'Interviewed', or 'Interview Sent', else null when Request Interview / Decline are " +
      "available. Pass includeDecided:true to also see rejected/withdrawn applications.",
    input_schema: {
      type: "object",
      properties: {
        jobId:          { type: "string", description: "The job_posts document ID" },
        clientId:       { type: "string", description: "The client's user ID (access check)" },
        includeDecided: { type: "boolean", description: "Default false — pending only, like the panel" },
      },
      required: ["jobId", "clientId"],
    },
  },
  {
    name: "get_caregiver_earnings",
    description:
      "Get an earnings summary for a caregiver — total earned, pending balance, and recent visit count.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        daysBack:    { type: "number", description: "Days of history to include (default 30, max 90)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "update_caregiver_availability",
    description:
      "Add or remove days from a caregiver's weekly availability. Changes take effect immediately for job matching.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:        { type: "string", description: "The caregiver's Firestore document ID" },
        availableDays:      { type: "array", items: { type: "string" }, description: "Days to add (Monday, Tuesday, etc.)" },
        unavailableDays:    { type: "array", items: { type: "string" }, description: "Days to remove from availability" },
        preferredTimeOfDay: { type: "string", description: "Preferred time: morning, afternoon, evening, overnight, or flexible" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "browse_job_board",
    description:
      "Show open care jobs that a caregiver can apply to. Returns up to 5 matching jobs with care needs, schedule, and rate.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        limit:       { type: "number", description: "Max jobs to return (default 5, max 10)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_job_recommendations",
    description:
      "Get ranked job recommendations for a caregiver — sorted by match percentage based on their skills, " +
      "availability, and rate. Better than browse_job_board when the caregiver wants personalized suggestions.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        limit:       { type: "number", description: "Number of recommendations (default 5, max 10)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "submit_gps_checkin",
    description:
      "Submit a GPS-validated check-in for a caregiver arriving at a care visit. " +
      "Verifies the caregiver is within 200m of the address and notifies the family.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        appointmentId: { type: "string", description: "The appointment document ID" },
        latitude:      { type: "number", description: "Caregiver's current latitude" },
        longitude:     { type: "number", description: "Caregiver's current longitude" },
      },
      required: ["caregiverId", "appointmentId", "latitude", "longitude"],
    },
  },
  {
    name: "get_tax_summary",
    description:
      "Get a caregiver's annual earnings summary for tax purposes (1099-NEC). " +
      "Shows total earnings, hours, visit count, quarterly breakdown, and whether they meet the $600 threshold for a 1099.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        year:        { type: "number", description: "Tax year (e.g. 2024). Defaults to current year." },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_my_applications",
    description:
      "Get a caregiver's submitted job applications and their current status (pending, accepted, rejected).",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_pending_timesheets",
    description:
      "The website's Timesheets page, exactly. tab 'needs_review' (default) = the Needs Review pill: the caregiver's submitted hours " +
      "waiting on the family (Review & Approve), counters waiting on the family (Review & Respond), failed payments (Retry payment), " +
      "plus the ones waiting on someone else (correction sent, under review) — grouped by caregiver like the page. tab 'history' = " +
      "the History pill: approved / auto-approved / paid, with an optional from/to date range and the report totals (shifts, hours, pay). " +
      "Each row is the card: caregiver, date, clock in/out, hours (h:mm:ss), rate, base pay, additional charges, total, status label " +
      "and hint, correction timeline, and its button. Use for 'anything to approve', 'what did I pay Basra', 'my payment history'.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        tab:      { type: "string", enum: ["needs_review", "history"], description: "Which pill (default needs_review)" },
        from:     { type: "string", description: "History report start date, YYYY-MM-DD (optional)" },
        to:       { type: "string", description: "History report end date, YYYY-MM-DD (optional)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_care_journal_client",
    description: "The caregiver's notes from the family's completed visits — the running notes written during the visit and the closing note, from the shift record (what the Past Bookings card shows). Use for 'what did Basra write', 'any notes from this week'. Never describe how the person is doing beyond these words.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        limit:    { type: "number", description: "Number of entries (default 5, max 20)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_payment_update_link",
    description:
      "The website's Timesheets > Payment Method tab: whether a card is on file (brand + last 4) and the same button the page shows — " +
      "'Add a card' (a membership-page link when the family has no billing account yet) or 'Manage payment method' (a Stripe Billing " +
      "Portal link that returns to the Timesheets page). Send the link; never ask for card details in chat.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "retry_shift_payment",
    description:
      "Retry a failed visit payment. Use when the family says a payment failed and asks to run it again — " +
      "typically after they've fixed their card (get_payment_update_link). Only works on a shift whose " +
      "payment is currently in the failed state; re-charges the amount already owed for that visit. " +
      "Use get_shifts first if you don't know which visit's payment failed.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "The appointment/shift ID whose payment failed" },
        clientId:      { type: "string", description: "The client's user ID (ownership check)" },
      },
      required: ["appointmentId", "clientId"],
    },
  },
  {
    name: "send_onboarding_link",
    description:
      "Generate AND send a tappable onboarding/signup link directly to this chat. Use this whenever a family " +
      "or caregiver asks you to (re)send a subscription/payment, identity verification, profile photo, document " +
      "upload, background check, or payout-setup link. The tool sends the link itself — after it succeeds, just " +
      "briefly confirm (e.g. \"Sent! Tap the link to verify your identity\"). NEVER create a support ticket for a " +
      "link you can send with this tool. Pick the linkType that matches what they asked for. NEVER tell the user " +
      "a link is coming or being pulled up without calling this tool in the same turn — narrating a link does not " +
      "send anything.",
    input_schema: {
      type: "object",
      properties: {
        linkType: {
          type: "string",
          enum: [
            "client_payment",
            "client_identity",
            "caregiver_membership",
            "caregiver_photo",
            "caregiver_documents",
            "caregiver_background_check",
            "caregiver_payouts",
          ],
          description:
            "Which link to send. Families: client_payment (subscription / payment method setup), client_identity " +
            "(identity verification). Caregivers: caregiver_membership (annual membership), caregiver_photo, " +
            "caregiver_documents (certifications), caregiver_background_check, caregiver_payouts (Stripe payout setup).",
        },
      },
      required: ["linkType"],
    },
  },
  {
    name: "get_background_check_status",
    description:
      "Look up the caregiver's OWN background-check status (Checkr). Use when a caregiver asks \"what's the status " +
      "of my background check\", \"did my check come back\", or \"am I cleared yet\". Returns the current status so " +
      "you can answer directly instead of deflecting to support. Do not promise a specific completion time.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_payout_status",
    description:
      "Look up the caregiver's OWN Stripe payout (Connect) setup status. Use when a caregiver asks \"is my payout " +
      "set up\", \"can I get paid yet\", \"did my bank connect\", or asks you to set up / (re)send the payout link. " +
      "Returns the LIVE status so you answer truthfully — NEVER say payouts are live, ready, or set up unless " +
      "summary is \"active\". When summary is anything else, send the setup link with send_onboarding_link " +
      "(linkType caregiver_payouts) instead of claiming it's done.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_signup_completeness",
    description:
      "FINAL SIGNUP CHECK — audit the user's account for anything their signup missed. Works for BOTH roles: " +
      "caregivers (profile fields, photo, membership, background check, payout setup, visibility to families) and " +
      "families (membership payment, care-recipient profile, care plan). Use right after signup wraps up, or when " +
      "anyone asks \"did I miss anything\", \"is my profile complete\", \"am I all set\". Returns `missing` (real " +
      "gaps, each with a `fix`) and `optionalGaps` (nice-to-haves — never call these missing). Ground your answer " +
      "ONLY on this result: if `complete` is true say so plainly; if not, walk through the gaps and offer the fix — " +
      "when a fix names send_onboarding_link, call that tool when they say yes.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected on caregiver turns)" },
        clientId:    { type: "string", description: "The family/client's user ID (auto-injected on family turns)" },
      },
      required: [],
    },
  },
  // ── Checkr Candidate MCP bridge (docs.checkr.com/mcp) ──────────────────────
  // Pulls the caregiver's FULL redacted report straight from Checkr, gated by
  // Checkr's own candidate identity verification (email OTP). Flow:
  // request_checkr_verification → verify_checkr_otp → get_checkr_report.
  {
    name: "request_checkr_verification",
    description:
      "Start a secure Checkr identity-verification session so the caregiver's FULL background-check report can be " +
      "pulled with get_checkr_report. Checkr emails a one-time code to the caregiver's email on file with Checkr. " +
      "Use when get_background_check_status isn't enough — e.g. the caregiver asks which screenings ran, what a " +
      "\"consider\" result means for THEIR report, or why it's delayed. Confirm their email first; max 3 code sends " +
      "per session.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected)" },
        email:       { type: "string", description: "The caregiver's email — must match the email on their Checkr candidate record" },
      },
      required: ["caregiverId", "email"],
    },
  },
  {
    name: "verify_checkr_otp",
    description:
      "Complete Checkr identity verification with the one-time code the caregiver received by email after " +
      "request_checkr_verification. Max 3 attempts per session; on success get_checkr_report becomes available.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected)" },
        code:        { type: "string", description: "The one-time code from the caregiver's email" },
      },
      required: ["caregiverId", "code"],
    },
  },
  {
    name: "get_checkr_report",
    description:
      "Fetch the caregiver's latest background-check report details live from Checkr (status, result, individual " +
      "screenings, exceptions, candidate portal link) — all PII redacted by Checkr. Requires a verified session " +
      "(request_checkr_verification then verify_checkr_otp first). For a quick status answer use " +
      "get_background_check_status instead.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (auto-injected)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "request_shift_swap",
    description: "Initiate a shift swap request for a caregiver — finds available peer caregivers and broadcasts the coverage request. Only call after caregiver has confirmed which shift needs coverage.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The requesting caregiver's ID" },
        appointmentId: { type: "string", description: "The appointment that needs coverage" },
        reason:        { type: "string", description: "Reason for swap (optional)" },
      },
      required: ["caregiverId", "appointmentId"],
    },
  },
  {
    name: "accept_shift_swap",
    description: "Accept a pending shift swap request. Call when a caregiver says ACCEPT to an open swap offer.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:    { type: "string", description: "The accepting caregiver's ID" },
        caregiverName:  { type: "string", description: "The accepting caregiver's name" },
        swapRequestId:  { type: "string", description: "The shift_swap_requests document ID" },
      },
      required: ["caregiverId", "caregiverName", "swapRequestId"],
    },
  },
  {
    name: "cancel_shift_swap",
    description: "Cancel an open shift swap request initiated by this caregiver.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The requesting caregiver's ID" },
        swapRequestId: { type: "string", description: "The shift_swap_requests document ID" },
      },
      required: ["caregiverId", "swapRequestId"],
    },
  },
  // ── Account & profile ─────────────────────────────────────────────────────
  {
    name: "update_user_profile",
    description: "Update the client's own profile fields (name, address, photoUrl). Confirm changes with the family by reading back the new values before calling. If they want to change their PHONE number, pass requestPhoneChange:true instead — login here is by phone number, so a change is never a simple field edit: it emails a secure link to the address on file, and the actual new number is entered and verified there, never over SMS. Tell them to check their email; do NOT ask them for the new number yourself.",
    input_schema: {
      type: "object",
      properties: {
        userId:    { type: "string", description: "The user's ID" },
        firstName: { type: "string", description: "New first name (optional)" },
        lastName:  { type: "string", description: "New last name (optional)" },
        requestPhoneChange: { type: "boolean", description: "Set true to start a phone number change (see description) — this is a request flag, not the new number itself" },
        address:   { type: "string", description: "New street address (optional)" },
        city:      { type: "string", description: "New city (optional)" },
        state:     { type: "string", description: "New state (optional)" },
        zip:       { type: "string", description: "New ZIP code (optional)" },
        photoUrl:  { type: "string", description: "New profile photo URL (optional) — must be a real https link to an image. Never pass a typed word like 'skip' here; if the family declines a photo, leave it out." },
        photoFromMessage: { type: "boolean", description: "Set true to use the photo the family just attached in this conversation as their profile photo (pass phone too). Leave photoUrl out in that case." },
        phone:     { type: "string", description: "The family's phone (session id) — needed with photoFromMessage" },
      },
      required: ["userId"],
    },
  },
  {
    name: "request_email_change",
    description: "Recovery-email changes and confirmations — the same steps as the site's Account Settings. With newEmail: if the CURRENT recovery email is confirmed, an approval link goes to THAT address first (result.stage awaiting_old_approval; Evia also texts them that they can reply APPROVE from this phone instead, or NO); once approved, the new address gets its confirmation link (stage awaiting_new_confirm). Nothing changes until the new inbox's link is tapped. With resend:true (no newEmail): re-sends the confirmation link for the address already on file when it is not confirmed yet.",
    input_schema: {
      type: "object",
      properties: {
        userId:   { type: "string", description: "The user's ID" },
        newEmail: { type: "string", description: "The new email address (omit when resend is true)" },
        resend:   { type: "boolean", description: "true = re-send the confirmation link for the unconfirmed address already on file" },
      },
      required: ["userId"],
    },
  },
  // ── Favorites ─────────────────────────────────────────────────────────────
  {
    name: "save_caregiver_favorite",
    description: "Save a caregiver to the family's favorites list for quick access later.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's user ID" },
        caregiverId: { type: "string", description: "The caregiver to save" },
      },
      required: ["clientId", "caregiverId"],
    },
  },
  {
    name: "unsave_caregiver_favorite",
    description: "Remove a caregiver from the family's favorites list.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's user ID" },
        caregiverId: { type: "string", description: "The caregiver to remove" },
      },
      required: ["clientId", "caregiverId"],
    },
  },
  // ── Safety: block + report ────────────────────────────────────────────────
  {
    name: "set_block_status",
    description: "Block, unblock, or file an abuse report against another user. MANDATORY for action:'block' or 'report': confirm with the family first (who — and for 'report', what happened) and wait for explicit confirmation before calling. Unblocking needs no confirmation. Reporting tells the family ops will follow up within 24 hours.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The acting user's ID (the family)" },
        targetUserId:  { type: "string", description: "The user being blocked, unblocked, or reported" },
        action:        { type: "string", enum: ["block", "unblock", "report"], description: "block, unblock, or report" },
        reason:        { type: "string", description: "Optional reason for a block (helps ops triage)" },
        category:      { type: "string", description: "Required for action:'report'. One of: harassment, scam, safety_concern, inappropriate_content, other" },
        description:   { type: "string", description: "Required for action:'report'. Short description of what happened" },
      },
      required: ["userId", "targetUserId", "action"],
    },
  },
  {
    name: "delete_conversation",
    description: "Clear a message conversation from the requesting user's own Inbox (mirrors the website's 'Delete conversation' menu action). Only hides it for this user — the other party's copy and the message history are untouched, and it resurfaces automatically the next time either side sends a new message.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The user clearing the conversation (whose Inbox this affects)" },
        counterpartId: { type: "string", description: "The other person in the conversation (caregiver or client ID)" },
      },
      required: ["userId", "counterpartId"],
    },
  },
  {
    name: "mark_messages_read",
    description: "Mark all unread messages in a conversation as read and clear its unread badge (mirrors the website's Inbox automatically marking messages read when a conversation is opened). Use when the family/caregiver says something like 'mark my messages as read' or 'I've seen those'.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The user marking messages as read" },
        counterpartId: { type: "string", description: "The other person in the conversation (caregiver or client ID)" },
      },
      required: ["userId", "counterpartId"],
    },
  },
  {
    name: "edit_review",
    description: "Update a review the family already submitted for a caregiver — change the rating and/or comment. Use when they say 'change my review to 5 stars' or 'update what I wrote'. Only the review's author can edit it.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client who wrote the review" },
        reviewId: { type: "string", description: "The review ID to edit" },
        rating:   { type: "number", description: "New rating 1-5 (optional)" },
        comment:  { type: "string", description: "New comment text (optional)" },
      },
      required: ["clientId", "reviewId"],
    },
  },
  {
    name: "cancel_followup",
    description: "Cancel a previously scheduled follow-up (from schedule_followup) before it fires. Use when the family says 'never mind that follow-up' or 'cancel the check-in you set'. Pass the triggerId returned by schedule_followup.",
    input_schema: {
      type: "object",
      properties: {
        triggerId: { type: "string", description: "The follow-up triggerId returned by schedule_followup" },
        userId:    { type: "string", description: "The owning user — auto-injected; used to verify you own this follow-up" },
      },
      required: ["triggerId", "userId"],
    },
  },
  {
    name: "get_support_tickets",
    description:
      "List the support tickets a user has opened (via create_support_ticket or the web app). " +
      "Use when the user asks 'what's the status of my ticket?' or 'did anyone get back to me?'. " +
      "By default only open tickets are returned; pass includeResolved to also show closed ones.",
    input_schema: {
      type: "object",
      properties: {
        userId:          { type: "string",  description: "The user's Firestore document ID" },
        includeResolved: { type: "boolean", description: "Include resolved/closed tickets (default false)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "get_shifts",
    description:
      "List submitted shift-hour / timesheet records and their status (pending review, approved, paid, correction requested). " +
      "Pass caregiverId to see a caregiver's shifts, or clientId to see shifts logged against a family's account. " +
      "Use when someone asks 'did my hours go through?', 'which timesheets are still pending?', or 'what did I get paid for last week?'.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId)" },
        clientId:    { type: "string", description: "The client's Firestore document ID (provide this OR caregiverId)" },
        status:      { type: "string", description: "Optional filter, e.g. 'pending_client_review', 'approved', 'paid'" },
      },
      required: [],
    },
  },
  {
    name: "get_pending_schedule_amendments",
    description:
      "List schedule-change requests still awaiting the caregiver's answer — the OTHER kind of card on the site's " +
      "My Bookings > Requests tab (booking_amendments with status 'pending': a new recurring day or one-off visit " +
      "the family asked to add to an accepted booking via request_schedule_amendment). Pass clientId for a family's " +
      "own pending changes, or caregiverId for changes a caregiver still needs to accept/decline. Each result " +
      "carries its amendmentId for manage_booking action:'cancel_pending_amendment'. get_pending_booking_requests " +
      "does NOT include these.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's Firestore document ID (provide this OR caregiverId)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId)" },
      },
      required: [],
    },
  },
  {
    name: "get_past_visits",
    description:
      "List past visits — the site's My Bookings > Past Bookings tab exactly: this client's (or caregiver's) shifts " +
      "with status 'completed' or 'cancelled', newest first, with caregiver, date (and weekday), times, who cancelled, " +
      "and for completed visits the actual start/end stamps and paid flag. Use for 'when was the last visit', 'did " +
      "Tuesday's visit happen', 'which visits got cancelled', 'how many visits has Basra done'. " +
      "get_upcoming_appointments only covers scheduled/in-progress/needs_replacement visits, never these.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's Firestore document ID (provide this OR caregiverId)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId)" },
        limit:       { type: "number", description: "Max visits to return (default 20, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_resendable_booking_requests",
    description:
      "The website's Resend rows on Care Requests > Interviews: booking requests the caregiver declined or the " +
      "family cancelled that can be resent (the latest request per caregiver+job/interview, when it is declined or " +
      "cancelled — a newer pending/accepted request for the same pairing hides the row, exactly as the site does). " +
      "Call this for 'do I have a booking I can resend?', 'which requests were declined/cancelled?', or before " +
      "offering a resend. NEVER infer resendability from get_pending_booking_requests or get_past_visits — those " +
      "read different records. To actually resend, call start_resend_booking_flow.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's Firestore document ID" },
        caregiverId: { type: "string", description: "Optional — only requests with this caregiver" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_pending_booking_requests",
    description:
      "List booking requests still awaiting a response — matches the site's My Bookings > Requests tab exactly " +
      "(booking_requests with status 'pending'), on either side. Pass clientId to see requests a family has sent " +
      "that a caregiver hasn't accepted or declined yet, or caregiverId to see incoming requests a caregiver still " +
      "needs to accept or decline. Includes shift-replacement requests (isShiftReplacement:true) the same way the " +
      "site does. Use when someone asks 'did they respond yet?', 'what am I still waiting on?', 'what requests do " +
      "I need to answer?', or anything else about this tab — get_upcoming_appointments and get_pending_tasks do " +
      "NOT cover this (they query confirmed/scheduled visits and Evia's own internal task queue, never a pending " +
      "booking_requests doc), so this is the only tool that can answer it.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's Firestore document ID (provide this OR caregiverId) — requests THIS FAMILY sent" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId) — requests sent TO this caregiver" },
      },
      required: [],
    },
  },
  {
    name: "get_caregiver_availability",
    description:
      "Read a caregiver's current weekly availability before proposing changes — the day list, the weeklyAvailability time-window map, and preferred time of day. " +
      "Use this to confirm what's already set before calling update_caregiver_availability, so you don't re-ask for days the caregiver already has.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "update_care_journal_entry",
    description:
      "Correct an existing care journal entry the caregiver already logged — fix the notes, mood, meds given, or activities. " +
      "Use when the caregiver says 'I made a mistake on that entry' or 'add that I also gave her the evening dose'. " +
      "Only the caregiver who wrote the entry can edit it. Pass only the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver who authored the entry (ownership check)" },
        entryId:     { type: "string", description: "The care_journal document ID to update" },
        notes:       { type: "string", description: "Corrected notes text (optional)" },
        mood:        { type: "string", description: "Corrected mood (optional)" },
        medsGiven:   { type: "boolean", description: "Whether medications were administered (optional)" },
        activities:  { type: "array", items: { type: "string" }, description: "Corrected activities list (optional)" },
      },
      required: ["caregiverId", "entryId"],
    },
  },
  // ── CRUD/parity gap closures (agent-native audit 2026-07) ─────────────────
  {
    name: "archive_senior_profile",
    description:
      "Archive a senior's profile when care ends (soft-delete). The profile stops appearing in active care flows " +
      "but the care record is RETAINED — nothing is hard-deleted. " +
      "MANDATORY: read back whose profile you're archiving and wait for explicit confirmation before calling.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's profile document ID" },
        clientId: { type: "string", description: "The client's user ID" },
        reason:   { type: "string", description: "Optional reason (e.g. care ended, moved to facility)" },
      },
      required: ["seniorId", "clientId"],
    },
  },
  {
    name: "update_family_member",
    description:
      "Edit an existing family group member's details — display name, role, relationship to the senior, or whether " +
      "they receive care update notifications. Use remove_family_member to remove them entirely. " +
      "Confirm the specific change before calling.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The primary client's user ID" },
        memberPhone: { type: "string", description: "Phone number (E.164) of the family member to update" },
        memberName:  { type: "string", description: "Corrected display name (optional)" },
        role:        { type: "string", enum: ["primary", "family", "emergency_contact"], description: "Member's role in the care group (optional)" },
        relationship:{ type: "string", description: "Relationship to the senior, e.g. daughter, son, neighbor (optional)" },
        notificationsEnabled: { type: "boolean", description: "Whether this member receives care update messages (optional)" },
      },
      required: ["clientId", "memberPhone"],
    },
  },
  {
    name: "list_interviews",
    description:
      "List scheduled/pending video or phone interviews for the caller. Pass clientId for a family's interviews or " +
      "caregiverId for a caregiver's. Use before cancel_interview/reschedule_interview or when someone asks 'when " +
      "is my interview?'. Each result's scheduledTimeLocal is already in the family's local time (e.g. 'Monday, " +
      "September 7 at 5:00 PM') — always read dates/times from scheduledTimeLocal, never compute them yourself " +
      "from the raw scheduledTime (a UTC timestamp); converting several of these by hand is exactly how a real " +
      "reply once spliced one interview's real date onto a different interview's real time. If " +
      "reschedulePendingTimeLocal is set, someone (rescheduledBy) has proposed moving THIS interview to that time " +
      "— the real scheduledTime is still what's actually confirmed until accept_interview_reschedule is called by " +
      "the OTHER party (never the same party named in rescheduledBy).",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's user ID (provide this OR caregiverId)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId)" },
        // 2026-09-09 (live-caught): the old description listed "scheduled,
        // confirmed, cancelled" as valid values — none of those are real.
        // An interview is "requested" until the other side responds, then
        // "accepted" (not "confirmed", not "scheduled") or "declined". A
        // model call filtering on "scheduled" silently got zero results and
        // told the family "I don't see a scheduled interview" for one that
        // was actually sitting right there, accepted.
        status: {
          type: "string",
          enum: ["requested", "accepted", "declined", "completed", "cancelled"],
          description: "Optional filter. These are the ONLY real values — there is no 'scheduled' or 'confirmed' " +
            "status. requested = proposed, awaiting the other side's response. accepted = confirmed and upcoming " +
            "(this is what an interview you can still reschedule or join looks like). declined, completed, cancelled " +
            "are terminal.",
        },
      },
      required: [],
    },
  },
  {
    name: "cancel_interview",
    description:
      "Cancel a scheduled interview. Either participant can cancel their own interview; the other side is notified. " +
      "Call this as soon as they've expressed clear intent to cancel (e.g. 'cancel it', 'yes') — do NOT ask them " +
      "to confirm again yourself first. The platform already requires and enforces an explicit confirmation before " +
      "this executes, so asking twice just makes them confirm the same thing a second time. " +
      "To move the interview to a different time instead of cancelling, use reschedule_interview.",
    input_schema: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "The video_interviews document ID" },
        clientId:    { type: "string", description: "The client's user ID (when the family cancels)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (when the caregiver cancels)" },
        reason:      { type: "string", description: "Optional short reason passed to the other side" },
      },
      required: ["interviewId"],
    },
  },
  {
    name: "reschedule_interview",
    description:
      "Propose a new date/time for an already-scheduled interview (status requested or accepted) — the SAME " +
      "interview record, no cancellation, no new doc, same video call link. Matches the website's own Reschedule / " +
      "Propose different time button exactly. This only PROPOSES the new time — the real scheduled time does not " +
      "change until the other party confirms via accept_interview_reschedule. Use this instead of cancelling and " +
      "calling schedule_interview again, which loses the interview's history and sends a duplicate request. If the " +
      "other party already has a proposal pending on this interview, calling this again replaces it with a " +
      "counter-proposal (mirrors the website's 'Propose different time').",
    input_schema: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "The video_interviews document ID" },
        clientId:    { type: "string", description: "The client's user ID (when the family proposes)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (when the caregiver proposes)" },
        newDate:     { type: "string", description: "Proposed new date, YYYY-MM-DD" },
        newTime:     { type: "string", description: "Proposed new time, HH:MM (24h)" },
      },
      required: ["interviewId", "newDate", "newTime"],
    },
  },
  {
    name: "accept_interview_reschedule",
    description:
      "Confirm the OTHER party's pending proposed interview time (sent via reschedule_interview) — this is the " +
      "moment the interview's real scheduled time actually changes. Use list_interviews first if it's unclear " +
      "whether a proposal is pending or who proposed it — you cannot accept your own proposal, only the other " +
      "party's.",
    input_schema: {
      type: "object",
      properties: {
        interviewId: { type: "string", description: "The video_interviews document ID" },
        clientId:    { type: "string", description: "The client's user ID (when the family accepts)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (when the caregiver accepts)" },
      },
      required: ["interviewId"],
    },
  },
  {
    name: "delete_memory_file",
    description:
      "Delete one of Evia's memory files for a user entirely — the file content AND its search index. Permanent. " +
      "Use when the family asks you to forget a whole topic/file, or to clean up an ad-hoc offloaded file. " +
      "For correcting a single fact use edit_memory_file instead. " +
      "MANDATORY: read back which file you're deleting and wait for explicit confirmation before calling.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID" },
        file:   { type: "string", description: "Memory file slug (e.g. profile, health, family, recent_episodes, procedural, or an ad-hoc slug)" },
      },
      required: ["userId", "file"],
    },
  },
  {
    name: "list_blocked_users",
    description:
      "List the users this family has blocked (via set_block_status), with names where available. " +
      "Use before calling set_block_status or when they ask 'who have I blocked?'.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "list_shift_swaps",
    description:
      "List active shift swap requests for a caregiver — both their own outstanding coverage requests and open " +
      "swap offers from peers they could accept. Use before accept_shift_swap/cancel_shift_swap or when they ask " +
      "'any open swaps?' or 'did anyone pick up my shift?'.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
      },
      required: ["caregiverId"],
    },
  },
];

// Tools available to caregivers — scoped to what's relevant to their role
const CAREGIVER_TOOL_NAMES = new Set([
  "get_caregiver_appointments",
  "get_caregiver_info",
  "get_upcoming_appointments",
  "get_senior_profile",
  "read_memory_file",
  "update_memory_file",
  "edit_memory_file",
  "search_memory",
  "get_membership_page",
  "contact_support",
  "get_notifications",
  "get_account_settings",
  "update_caregiver_profile",
  "pause_account",
  "reactivate_account",
  "accept_shift",
  "decline_shift",
  "complete_task",
  "create_care_journal_entry",
  "apply_to_job",
  "request_instant_payout",
  "submit_shift_hours",
  "create_support_ticket",
  "get_caregiver_earnings",
  "update_caregiver_availability",
  "browse_job_board",
  "get_my_applications",
  "respond_to_interview_request",
  "send_client_message",
  "get_payout_history",
  "get_recent_messages",
  "delete_conversation",
  "mark_messages_read",
  "request_shift_swap",
  "accept_shift_swap",
  "cancel_shift_swap",
  "get_job_recommendations",
  "submit_gps_checkin",
  "get_tax_summary",
  "send_onboarding_link",
  "get_background_check_status",
  "get_payout_status",
  "get_signup_completeness",
  // U2 — caregiver action parity
  "withdraw_job_application",
  "respond_to_booking_request",
  "start_shift",
  "complete_shift",
  "update_shift_task",
  "submit_media_update",
  "respond_to_shift_hour_correction",
  "create_caregiver_referral",
  // Missing CRUD tools — reads + in-place updates
  "get_support_tickets",
  "get_shifts",
  "get_caregiver_availability",
  "update_care_journal_entry",
  // Requests-tab Q&A parity (2026-09-14) — matches CaregiverBookingsPage's
  // own Requests tab (booking_requests where caregiverId + status:'pending').
  "get_pending_booking_requests",
  // Requests/Past Bookings parity (2026-09-16): pending schedule changes and
  // completed/cancelled visits, both sides.
  "get_pending_schedule_amendments", "get_past_visits",
  // CRUD/parity gap closures (agent-native audit 2026-07)
  "list_interviews",
  "cancel_interview",
  "list_shift_swaps",
  // Outbound iMessage tapbacks (Linq reactions, 2026-07) — shared with clients
  "react_to_message",
  // Checkr Candidate MCP bridge (2026-07-09) — full report details, OTP-gated
  "request_checkr_verification",
  "verify_checkr_otp",
  "get_checkr_report",
  // Booking-pipeline parity (2026-08-30) — the caregiver's own accept/decline
  // of a family's schedule-change request.
  "respond_to_schedule_amendment",
  // Account Settings phone-recovery audit (2026-09-02) — delete_account looks
  // the account up in whichever collection has it, so it works for either
  // role. The phone-change entry point didn't need a new tool slot — it's
  // update_caregiver_profile's own phone:true flag (mirrors update_user_profile).
  "delete_account",
]);
export const CAREGIVER_TOOLS: McpTool[] = MCP_TOOLS.filter(t => CAREGIVER_TOOL_NAMES.has(t.name));

// Tools that exist ONLY for the caregiver role. Excluded from client turns so the
// client surface stays under OpenAI's 128-tool hard cap (otherwise capToolsForOpenAi
// drops an arbitrary tail — which silently hid set_block_status and the 2026-07
// CRUD tools from clients). Shared tools (memory, web, reminders, messaging reads,
// send_onboarding_link, get_caregiver_info/reviews) stay client-visible.
const CAREGIVER_ONLY_TOOL_NAMES = new Set([
  "get_caregiver_appointments",
  "update_caregiver_profile",
  // Scoping fix 2026-09-05 (client-tool capability audit): both operate on
  // "your own caregiver account" per their own descriptions — were reachable
  // from a client conversation too since neither was ever added here.
  "pause_account",
  "reactivate_account",
  "accept_shift",
  "decline_shift",
  "apply_to_job",
  "request_instant_payout",
  "submit_shift_hours",
  "get_caregiver_earnings",
  "update_caregiver_availability",
  "browse_job_board",
  "get_my_applications",
  "respond_to_interview_request",
  "send_client_message",
  "get_payout_history",
  "request_shift_swap",
  "accept_shift_swap",
  "cancel_shift_swap",
  "get_job_recommendations",
  "submit_gps_checkin",
  "get_tax_summary",
  "get_background_check_status",
  "get_payout_status",
  "withdraw_job_application",
  "respond_to_booking_request",
  "start_shift",
  "complete_shift",
  "update_shift_task",
  "submit_media_update",
  "respond_to_shift_hour_correction",
  "create_caregiver_referral",
  "get_shifts",
  "get_caregiver_availability",
  "list_shift_swaps",
  // Checkr Candidate MCP bridge (2026-07-09) — a caregiver's own report only
  "request_checkr_verification",
  "verify_checkr_otp",
  "get_checkr_report",
  // Booking-pipeline parity (2026-08-30) — caregiver-only accept/decline.
  "respond_to_schedule_amendment",
]);
export const CLIENT_TOOLS: McpTool[] = MCP_TOOLS.filter(t => !CAREGIVER_ONLY_TOOL_NAMES.has(t.name));

export async function handleToolCallForCaregiver(
  name: string,
  input: Record<string, unknown>,
  shadowMode = false,
): Promise<unknown> {
  return handleToolCall(name, input, shadowMode);
}

// ── MCP Resources ─────────────────────────────────────────────────────────────

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json";
}

export const MCP_RESOURCE_TEMPLATES: McpResource[] = [
  {
    uri: "cara://user/{userId}/preferences",
    name: "User Preferences",
    description: "Notification preferences, DND settings, and timezone for the user.",
    mimeType: "application/json",
  },
  {
    uri: "cara://senior/{seniorId}/profile",
    name: "Senior Profile",
    description: "Name, age, diagnoses, and care needs for the senior.",
    mimeType: "application/json",
  },
  {
    uri: "cara://user/{userId}/memory/{file}",
    name: "Memory File",
    description: "Evia's long-term memory file: profile, health, family, recent_episodes, or procedural.",
    mimeType: "application/json",
  },
];

export async function handleResourceRead(
  uri: string,
  params: Record<string, string>
): Promise<{ uri: string; mimeType: "application/json"; text: string } | null> {
  // cara://user/{userId}/preferences
  const prefMatch = uri.match(/^cara:\/\/user\/([^/]+)\/preferences$/);
  if (prefMatch) {
    const userId = params.userId ?? prefMatch[1];
    const prefs  = await getPreferences(userId).catch(() => null);
    if (!prefs) return null;
    return { uri, mimeType: "application/json", text: JSON.stringify(prefs) };
  }

  // cara://senior/{seniorId}/profile
  const seniorMatch = uri.match(/^cara:\/\/senior\/([^/]+)\/profile$/);
  if (seniorMatch) {
    const seniorId = params.seniorId ?? seniorMatch[1];
    // U6 (R17): this resource used to read legacy `seniors` only — the one
    // remaining legacy-first senior read in MCP. Same repository order as
    // get_senior_profile now: canonical senior_profiles, legacy fallback.
    const { profile } = await getSeniorProfileWithSource(seniorId, db);
    if (!profile) return null;
    return { uri, mimeType: "application/json", text: JSON.stringify(profile) };
  }

  // cara://user/{userId}/memory/{file}
  const memMatch = uri.match(/^cara:\/\/user\/([^/]+)\/memory\/([^/]+)$/);
  if (memMatch) {
    const userId = params.userId ?? memMatch[1];
    const file   = (params.file ?? memMatch[2]) as MemoryFile;
    const VALID  = new Set(["profile", "health", "family", "recent_episodes", "procedural"]);
    if (!VALID.has(file)) return null;
    const content = await readMemoryFile(userId, file).catch(() => null);
    if (content == null) return null;
    return { uri, mimeType: "application/json", text: JSON.stringify({ file, content }) };
  }

  return null;
}

// ── MCP Prompts ───────────────────────────────────────────────────────────────

export interface McpPrompt {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export const MCP_PROMPTS: McpPrompt[] = [
  {
    name: "morning-caregiver-briefing",
    description: "Pre-shift briefing sent to caregivers on the morning of a visit.",
    arguments: [
      { name: "caregiverName", description: "Caregiver's first name",          required: true },
      { name: "seniorName",    description: "Senior's name",                   required: true },
      { name: "schedule",      description: "Time and duration of visit",      required: false },
      { name: "address",       description: "Client address",                  required: true },
      { name: "mapsUrl",       description: "Google Maps URL",                 required: false },
      { name: "medLine",       description: "Medication reminder line",        required: false },
      { name: "verifiedNote",  description: "Background check verified note", required: false },
    ],
  },
];

export function handlePromptGet(name: string, args: Record<string, string>): string {
  switch (name) {
    case "morning-caregiver-briefing": {
      const { caregiverName, seniorName, schedule, address, mapsUrl, medLine, verifiedNote } = args;
      const extras = [
        schedule   ? `Visit time/duration: ${schedule}` : null,
        mapsUrl    ? `Maps link: ${mapsUrl}` : null,
        medLine    ? `Medications: ${medLine}` : null,
        verifiedNote ? `Background check: ${verifiedNote}` : null,
      ].filter(Boolean).join("\n");
      return [
        `You are Evia. Write a short, direct morning briefing text for caregiver ${caregiverName}.`,
        ``,
        `They have a visit today with ${seniorName} at ${address}.`,
        extras ? `Additional context:\n${extras}` : null,
        ``,
        `Write it like a quick heads-up from a trusted coordinator — not a manager, not a cheerleader.`,
        `Keep it under 100 words. Plain text only. End with: Reply ARRIVED when you get there.`,
      ].filter(Boolean).join("\n");
    }

    default:
      return `Prompt "${name}" not found.`;
  }
}

// Structured error response so Claude can reason about failures rather than hallucinating
function toolError(code: ToolErrorCode, message: string) {
  return { _toolError: true, success: false, code, message };
}

// Mirrors the website's own paywall (hooks/useAccessGates.tsx `gate(action, ...)`)
// exactly — identity verification first, then an active membership — for the
// SAME three action types the site gates: message, booking, interview. General
// browsing/Q&A was never gated on the site either, so this is deliberately NOT
// called from read-only or conversational paths. The rule itself lives in
// agents/clientAccessGate.ts (shared with the scripted flows). When the
// family's conversation can be found, the block is texted the way the site
// shows its modal (the modal's copy + its CTA link) and the tool result tells
// the agent to add nothing.
async function checkClientAccessGate(
  clientId: string | undefined,
  action: "message" | "booking" | "interview",
  opts: { phone?: unknown; caregiverName?: string } = {},
): Promise<ReturnType<typeof toolError> | null> {
  if (!clientId) return toolError("PERMISSION_DENIED", "Cannot verify who this is for — clientId is required.");
  const { checkClientAccess, textClientGateBlock, findClientSession } = await import("../agents/clientAccessGate");
  const res = await checkClientAccess(clientId, action, opts.caregiverName);
  if (res.ok) return null;
  const doing = action === "message" ? "messaging a caregiver" : action === "booking" ? "booking a caregiver" : "scheduling an interview";
  const code: ToolErrorCode = res.block === "identity" ? "IDENTITY_REQUIRED" : "MEMBERSHIP_REQUIRED";
  const need = res.block === "identity" ? "needs to complete identity verification" : "needs an active membership";
  const conv = await findClientSession(clientId, opts.phone).catch(() => null);
  if (conv) {
    await textClientGateBlock(conv.phone, conv.chatId, res.block, action, opts.caregiverName);
    return toolError(code, `This family ${need} before ${doing}. Evia has ALREADY texted them the ${res.block === "identity" ? "identity check" : "plan selection"} link — send NOTHING else this turn.`);
  }
  return toolError(code, res.block === "identity"
    ? `This family needs to complete identity verification before ${doing} — send them the identity verification link.`
    : `This family's membership isn't active — they need an active membership before ${doing}. Offer to send the membership payment link.`);
}

// Ownership gate for senior PHI reads. The owning client is recorded on
// senior_profiles as `userId` (new direct-onboarding docs) OR `clientId` (the
// household back-reference written by migrateSeniorsToHousehold — those docs
// have NO userId). Check both: a recorded owner that doesn't match the session
// client is denied. When NEITHER owner field is present the doc is genuinely
// owner-less; rather than leaving PHI readable by anyone (the prior behavior),
// fail closed — except for the legacy single-senior model where the profile was
// keyed by the client's own uid (seniorId === sessionClientId), which stays
// reachable by its rightful owner. Returns a toolError on denial, or null when
// access is allowed.
async function assertSeniorAccess(seniorId: string, sessionClientId: unknown) {
  const data = (await db.collection("senior_profiles").doc(seniorId).get()).data();
  const ownerId = data?.userId ?? data?.clientId;
  if (ownerId) {
    if (ownerId !== sessionClientId) {
      return toolError("PERMISSION_DENIED", "Not authorized to access this senior's data");
    }
    return null;
  }
  // No recorded owner — allow only the legacy self-owned case, else fail closed.
  if (seniorId !== sessionClientId) {
    return toolError("PERMISSION_DENIED", "Not authorized to access this senior's data");
  }
  return null;
}

// R11 (memory-grounding U4b): memory MUTATION tools must never trust a
// model-supplied userId. The dispatcher's caller (qaAgent) injects `phone`
// authoritatively after the model input spread, and agent_sessions/{phone}
// carries the verified account identity for that session — so the check is:
// input.userId must equal the session doc's userId. Fail closed: no phone, no
// session, no session userId, or a read error all refuse the mutation.
async function verifyMemoryToolIdentity(input: Record<string, unknown>) {
  const userId = stringInput(input, "userId");
  const phone  = stringInput(input, "phone");
  if (!userId) return toolError("INVALID_INPUT", "userId is required");
  if (!phone) {
    return toolError("PERMISSION_DENIED", "Memory changes require a verified session and cannot run without one.");
  }
  try {
    const session = await db.collection("agent_sessions").doc(phone).get();
    const sessionUserId = session.exists ? (session.data()?.userId as string | undefined) : undefined;
    if (!sessionUserId || sessionUserId !== userId) {
      return toolError("PERMISSION_DENIED", "Not authorized to change this user's memory.");
    }
  } catch {
    return toolError("UNAVAILABLE", "Could not verify the session identity — memory change refused.");
  }
  return null;
}

// MCP file mutations stage a pending fact-change operation before touching
// Storage. The worker owns cross-store cleanup and completion; a stage or audit
// failure leaves Storage untouched and the already-created operation retryable.
async function stageMcpMemoryFileChange(params: {
  kind: "correction" | "forget";
  userId: string;
  phone?: string;
  fileSlug: string;
  source: string;
  /** Retired text for tombstone stamping (edit path). NEVER persisted raw. */
  retiredText: string;
}): Promise<void> {
  const { stageMcpMemoryFileChange: stage } = await import("../memory/learnedFacts");
  const staged = await stage({
    kind: params.kind,
    userId: params.userId,
    phone: params.phone,
    fileSlug: params.fileSlug,
    retiredText: params.retiredText,
  });
  if (!staged.ok) throw new Error(`mcp_memory_change_stage_${staged.reason}`);

  // This is deliberately awaited. A missing audit write must not be hidden by
  // a successful Storage mutation; the staged operation remains pending for
  // worker reconciliation and the caller gets a retryable tool failure.
  await logAudit({
    eventType: params.kind === "forget" ? "memory_fact_forgotten" : "memory_fact_corrected",
    userId: params.userId,
    data: { source: params.source, file: params.fileSlug },
  });
}

function shouldTrackMcpTool(name: string): boolean {
  if (/^(get|list|search|read)_/.test(name)) return false;
  if (name === "find_nearby_caregivers") return false;
  if (name === "resume_execution_agent") return false;
  return true;
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function targetDocIdFromToolInput(input: Record<string, unknown>): string | undefined {
  return stringInput(input, "appointmentId") ??
    stringInput(input, "bookingRequestId") ??
    stringInput(input, "shiftId") ??
    stringInput(input, "seniorId") ??
    stringInput(input, "caregiverId") ??
    stringInput(input, "clientId") ??
    stringInput(input, "referralId") ??
    stringInput(input, "invoiceId") ??
    stringInput(input, "ticketId");
}

function toolFailureReason(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const data = result as Record<string, unknown>;
  // Some tools signal failure with a bare `{ error: true, message }` (e.g.
  // perform_web_action's catch) rather than _toolError/success:false — treat
  // that as a failure too, or it gets mis-recorded as "executed".
  if (data._toolError !== true && data.success !== false && data.error !== true) return undefined;
  const code = typeof data.code === "string" ? data.code : "TOOL_FAILED";
  // Sanitize the tool's message before it's persisted to the ledger/ops alerts
  // (same redaction applied to thrown exceptions on the catch path).
  const message = sanitizeErrorReason(typeof data.message === "string" ? data.message : "Tool returned failure");
  return `${code}: ${message}`.slice(0, 200);
}

// Raw exception messages can carry PII or secrets (a failed credential/login
// web action, a Stripe error echoing a customer email, a provider token in a
// URL). These reasons are persisted to the ledger / admin alerts AND fed back
// into Evia's operational context, so redact common sensitive patterns first.
function sanitizeErrorReason(reason: string): string {
  return reason
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [token]")
    .replace(/\b(?:sk|pk|rk|whsec|xox[abprs]|gh[pousr]|AKIA)[-_]?[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, "[secret]")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\b(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]")
    .replace(/(?:\+?\d[\s().-]?){10,}/g, "[phone]")
    .slice(0, 200);
}

function shouldAlertForToolFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  // Case-insensitive so casing variations in tool messages (e.g. "Payment
  // provider unavailable") still match the alert-worthy keywords.
  const r = reason.toLowerCase();
  return r.startsWith("unavailable") ||
    r.startsWith("conflict") ||
    r.includes("temporarily unavailable") ||
    r.includes("linq_send_failed") ||
    r.includes("payment") ||
    r.includes("healthcare");
}

async function recordMcpToolStatus(params: {
  name: string;
  input: Record<string, unknown>;
  status: "proposed" | "executed" | "failed";
  errorReason?: string;
}): Promise<void> {
  const { name, input, status, errorReason } = params;
  const phone = stringInput(input, "phone");
  const userId = stringInput(input, "userId") ?? stringInput(input, "clientId") ?? stringInput(input, "caregiverId");
  const role = stringInput(input, "userType") ?? stringInput(input, "role");
  await logAgentAction({
    actionType: "mcp_tool",
    status,
    userId,
    phone,
    role,
    sourceMessageId: stringInput(input, "sourceMessageId"),
    toolName: name,
    targetDocId: targetDocIdFromToolInput(input),
    ...(errorReason ? { errorReason } : {}),
    metadata: {
      trackedBy: "mcp_dispatcher",
    },
  });
}

// ── Tool executor ─────────────────────────────────────────────────────────────

// U11: shadow/dry-run isolation. When the shadow harness (U6) runs runQaAgent
// in parallel with a live handler, its tool calls must have ZERO side effects.
// This is the structural guarantee (KTD-9): only explicitly read-only tools run
// for real under shadowMode; EVERYTHING ELSE is synthesized (fail-closed), so a
// mutating tool — or the pending-action gate it would hit — can never execute.
// Conservative allowlist: a tool omitted here is treated as mutating (safe); a
// mutating tool must never be added here.
const READ_ONLY_TOOLS = new Set<string>([
  "get_senior_profile", "list_household_seniors", "get_pending_tasks",
  "suggest_upcoming_care", "get_care_team", "cara_knows",
  "get_upcoming_appointments", "get_caregiver_appointments", "get_caregiver_info",
  "get_pending_booking_requests",
  "get_pending_schedule_amendments", "get_past_visits", "get_calendar", "get_resendable_booking_requests",
  // find_nearby_caregivers is NOT here (2026-09-14): it took over the removed
  // find_replacement_caregivers' job of texting the family each caregiver's
  // profile card and writing pendingMatches, so it sends real SMS and must be
  // synthesized under shadow — the same double-send-audit lesson (2026-07-06)
  // that got the old tool off this list.
  "get_active_bookings",
  "get_membership_page", "contact_support", "get_invoice_history", "get_invoice_details",
  "get_payout_history", "get_caregiver_earnings", "get_pending_timesheets", "get_tax_summary",
  "get_care_journal_client", "get_care_plan",
  "get_recent_messages", "get_family_group",
  "read_memory_file", "search_memory",
  "list_client_jobs", "list_job_applicants", "browse_job_board",
  "get_job_recommendations", "get_my_applications", "get_background_check_status",
  "get_payout_status", "get_signup_completeness",
  // CRUD/parity gap closures (agent-native audit 2026-07) — pure reads only
  "list_interviews", "list_blocked_users", "list_shift_swaps",
  // get_checkr_report is a pure remote read (Checkr redacts PII; nothing is
  // consumed or mutated). request_checkr_verification / verify_checkr_otp are
  // NOT read-only — they send a real OTP email / burn a verify attempt.
  "get_checkr_report",
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

// Shared by schedule_interview and respond_to_job_application's "accept"
// branch — the website has no direct "accept this applicant" action at all;
// requesting an interview IS how a client shows interest in an applicant.
// Creates the video_interviews doc at status:"requested" (the website's own
// not-yet-agreed status — nothing, link or reminder, goes out until the
// caregiver confirms via respond_to_interview_request, same as a website-
// created request) and links it to the application WITHOUT touching the
// application's own status field: the website only ever sets job_applications
// status to 'pending'/'accepted'/'rejected' (accepted only at actual
// hire/booking time, in PostsPage.tsx's handleSendBooking) — a job_applications
// doc that leaves 'pending' any earlier than that would vanish from the
// client's own Applicants panel, which filters on status=='pending'.
// Delegates to the SAME shared implementation the website's own
// ScheduleInterviewModal → createVideoInterviewRequest callable uses
// (agents/videoInterviewRequest.ts) — same caregiver-eligibility check
// (publicCaregiverProfiles), same job-ownership check, same 5/day rate
// limit. Evia used to have its own independent write here with none of
// those checks (2026-09-06 parity fix).
// Shared by reschedule_interview / accept_interview_reschedule. Interviews
// live in video_interviews only — the site's collection. (The retired
// Evia-SMS `interviews` twin collection and its linkedInterviewId mirror were
// removed 2026-09-17; nothing writes it any more.)
async function resolveInterview(interviewId: string): Promise<{
  primary: FirebaseFirestore.DocumentSnapshot;
  iv:      FirebaseFirestore.DocumentData;
} | null> {
  const primary = await db.collection("video_interviews").doc(interviewId).get();
  if (!primary.exists) return null;
  return { primary, iv: primary.data()! };
}

// Shared error mapping for a VideoInterviewRequestError thrown either by the
// standalone resolve-only step (propose path) or by requestVideoInterview's
// full commit (confirmed path) — same shape either way.
function mapVideoInterviewRequestError(
  err: unknown,
  ctx: { clientId: string; caregiverId: string; scheduledTime: string; jobId?: string; applicationId?: string },
): Record<string, unknown> {
  if (err instanceof VideoInterviewRequestError) {
    // 2026-09-09: only a toolErrors COUNT was ever visible in turn metrics —
    // the actual reason had to be reconstructed from screenshots + guesswork
    // live-debugging a real failure. Log the real code/message server-side
    // so the next one is diagnosable directly from Cloud Functions logs.
    console.error("schedule_interview: caregiver resolution failed", {
      code: err.code, message: err.message, ...ctx,
    });
    // 2026-09-09: a name-fallback lookup matching MORE than one caregiver
    // this family was shown used to collapse into the same flat "not
    // available" error as a genuine no-match — leaving the agent nothing
    // to ask the family other than a dead end. Surface the tied candidates
    // (id + rate, the same shape the agent already shows families for
    // matches) so it can ask which one, then retry with the real id.
    if (err.code === "ambiguous") {
      return {
        success: false,
        ambiguous: true,
        candidates: err.candidates ?? [],
        message: err.message,
        note: "Do not guess which one they mean. Ask the family to distinguish between these caregivers (e.g. by their rate, or how you discussed each of them), then call this tool again with the correct caregiverId — always their real id from the candidates list, never their name.",
      };
    }
    const codeMap: Record<string, ToolErrorCode> = {
      "invalid-argument":     "INVALID_INPUT",
      "failed-precondition":  "NOT_FOUND",
      "permission-denied":    "PERMISSION_DENIED",
      "resource-exhausted":   "RATE_LIMITED",
    };
    return toolError(codeMap[err.code] ?? "INVALID_INPUT", err.message);
  }
  throw err;
}

async function createVideoInterviewRequestForTool(params: {
  clientId: string; caregiverId: string; applicationId?: string;
  preferredDate: string; preferredTime: string; interviewType?: string;
  jobId?: string; notes?: string;
  /** Resolves any open "interview" commitment (interviewPromiseNet.ts) the
   *  instant a real schedule_interview call actually succeeds. */
  phone?: string;
  /** Set by the MCP gate's confirmed re-dispatch — already validated against
   *  the stored pending action (tool name, phone, AND this exact input) by
   *  handleToolCall before execution ever reaches here. */
  confirmedActionId?: string;
  /** True for callers where the caregiverId is already deterministically
   *  known — not the model picking a name off a rendered list — so the
   *  confirm-the-real-name checkpoint below has nothing to protect against.
   *  respond_to_job_application sets this: its caregiverId comes straight
   *  from the specific job_applications doc being processed, never a name
   *  the model has to correctly match. Only schedule_interview (the model
   *  picks a caregiverId itself, from a list it saw earlier) needs the gate. */
  skipConfirmationGate?: boolean;
}): Promise<Record<string, unknown>> {
  const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType, jobId, notes, phone, confirmedActionId, skipConfirmationGate } = params;
  const { parseScheduledTimeMs } = await import("../utils/scheduledTime");
  const startMs = parseScheduledTimeMs(`${preferredDate}T${preferredTime}:00`);
  if (Number.isNaN(startMs)) return toolError("INVALID_INPUT", "preferredDate/preferredTime could not be parsed");
  const scheduledTime = new Date(startMs).toISOString();

  // 2026-09-12 live incident: the family asked to interview "Basra Yousuf" —
  // named from a list Evia had just shown them, each entry correctly paired
  // with its real caregiverId in Evia's own context — but the model's
  // schedule_interview call carried a DIFFERENT caregiver's id anyway. The
  // data was right; the model's own tool-argument selection was not.
  // Deliberately NOT routed through the generic ALWAYS_CONFIRM gate (which
  // intercepts before ANY tool-specific validation runs, masking
  // IDENTITY_REQUIRED/MEMBERSHIP_REQUIRED/INVALID_INPUT/ambiguous/NOT_FOUND
  // behind a flat PERMISSION_DENIED) — instead, resolve the caregiver FIRST
  // (identical validation to before, same errors, unchanged), and only once
  // that succeeds, show the family the REAL resolved name and require an
  // explicit confirmation before the interview actually gets created.
  if (!skipConfirmationGate && !confirmedActionId) {
    let resolved;
    try {
      resolved = await resolveCaregiverForInterview(caregiverId, phone);
    } catch (err) {
      return mapVideoInterviewRequestError(err, { clientId, caregiverId, scheduledTime, jobId, applicationId });
    }
    if (!phone) {
      // Mirrors the generic gate's own "no phone, can't confirm" refusal.
      return toolError("PERMISSION_DENIED", "This action requires explicit confirmation and cannot be executed without an SMS session.");
    }
    const action = await proposePendingAction({
      phone,
      userId: clientId,
      toolName: "schedule_interview",
      toolInput: {
        clientId, caregiverId: resolved.resolvedCaregiverId, applicationId, jobId, notes, phone,
        preferredDate, preferredTime, interviewType,
      },
    });
    return buildPendingActionStub(action);
  }

  try {
    const interview = await requestVideoInterview({
      clientId, caregiverId, scheduledTime, applicationId, interviewType, jobId, notes,
      source: "mcp:schedule_interview", phone,
    });
    if (phone) {
      const { resolveCommitment } = await import("../agents/commitmentTracker");
      await resolveCommitment(phone, "interview", "scheduled").catch(() => {});
    }
    return {
      success: true,
      interviewId: interview.id,
      caregiverId: interview.caregiverId,
      caregiverName: interview.caregiverName,
      scheduledTime: interview.scheduledTime,
      interviewType: interview.interviewType,
      note: "The interview request has been sent to the caregiver — I'll share the video link with both of you the moment they confirm. Do not tell the family a link exists yet.",
    };
  } catch (err) {
    return mapVideoInterviewRequestError(err, { clientId, caregiverId, scheduledTime, jobId, applicationId });
  }
}

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
  shadowMode = false,
): Promise<unknown> {
  // U11: under shadow, never execute a non-read-only tool — return a synthetic
  // "would-have-run" result the harness records as the shadow end-state.
  if (shadowMode && !READ_ONLY_TOOLS.has(name)) {
    return { _shadow: true, simulated: name, wouldRun: true, input };
  }
  // Runtime-enforced confirmation gate. High-risk tool calls (remove_family_member,
  // cancel_subscription, etc.) are intercepted on the
  // first call and turned into a pending-action stub for Claude to read.
  // The re-run from approvalHandler sets _confirmedActionId to bypass the gate.
  // See pendingActions.ts for the full design.
  const confirmedActionId = input._confirmedActionId as string | undefined;
  if (confirmedActionId) {
    delete input._confirmedActionId;
    // Validate the confirmation against the pending doc so the gate's safety
    // lives HERE, not in caller discipline: a forged, expired, already-resolved,
    // wrong-phone, or wrong-tool id is refused instead of blindly bypassing.
    // The legit re-run (approvalHandler) dispatches BEFORE resolving, so the
    // doc is still "awaiting" at this point.
    const pending = await getPendingActionById(confirmedActionId);
    // Pass the current input so a valid confirmation id can't be reused to commit
    // a DIFFERENT action than the one that was proposed/approved.
    const valid = isConfirmedActionValid(pending, name, input.phone as string | undefined, Date.now(), input);
    if (!valid) {
      console.warn("MCP gate: rejected invalid _confirmedActionId", {
        name, confirmedActionId, status: pending?.status,
      });
      return toolError("PERMISSION_DENIED", "This confirmation is no longer valid. Please try the action again.");
    }
  } else if (isHighRisk(name, input)) {
    const phone = input.phone as string | undefined;
    if (!phone) {
      // No phone means we can't enforce confirmation through the SMS round-trip
      // (e.g. a future web-callable code path). Refuse rather than execute,
      // since the safety guarantee is the whole point of the gate.
      console.warn("MCP gate: high-risk tool called without phone — refusing", { name });
      return toolError("PERMISSION_DENIED", "This action requires explicit confirmation and cannot be executed without an SMS session.");
    }
    let action;
    try {
      action = await proposePendingAction({
        phone,
        userId:    input.userId as string | undefined,
        toolName:  name,
        toolInput: input,
      });
    } catch (err) {
      // Fail closed: a healthcare action with no resolvable account holder is
      // refused, never executed (H-U4). Never fall back to the triggering phone.
      console.warn("MCP gate: proposePendingAction failed (fail-closed)", { name, err: sanitizeErrorReason(err instanceof Error ? err.message : String(err)) });
      return toolError("PERMISSION_DENIED",
        "I couldn't verify the primary account holder for this action, so I can't proceed. " +
        "Please have the account holder text me directly.");
    }
    console.info("MCP gate: proposed pending action", {
      phone,
      actionId: action.id,
      toolName: name,
      preview:  action.preview,
    });
    // H-U4: a healthcare action triggered by a secondary member routes its
    // approval to the ACCOUNT HOLDER. Send the proposal to them; tell the
    // requester it was routed (they cannot approve it themselves).
    if (action.approverPhone && action.triggeredByPhone && action.approverPhone !== action.triggeredByPhone) {
      try {
        const { sendViaInteractionAgent } = await import("../agents/caraAgent");
        await sendViaInteractionAgent(action.approverPhone, {
          content:     `${action.preview}? A family member asked me to handle this. Reply YES to approve or NO to decline.`,
          urgency:     "immediate",
          sourceAgent: "healthcare_approval",
          canDrop:     false,
        });
      } catch (e) {
        // The approval prompt never reached the account holder, so this action
        // is NOT actually routed. Surface the failure instead of returning a
        // misleading routed_to_account_holder:true — otherwise the requester is
        // told it's pending approval when nobody was ever asked.
        console.error("MCP gate: failed to send proposal to account holder", sanitizeErrorReason(e instanceof Error ? e.message : String(e)));
        return toolError(
          "UNAVAILABLE",
          "I couldn't reach the primary account holder to request approval just now. Please try again in a moment.",
        );
      }
      return {
        _pending_action: true,
        actionId: action.id,
        routed_to_account_holder: true,
        guidance:
          "Tell the family member you've sent this to the primary account holder to approve and you'll " +
          "let them know once it's confirmed. Do NOT ask them to confirm — only the account holder can.",
      };
    }
    return buildPendingActionStub(action);
  }

  // U6: confirmed money-moving tools execute at most once per confirmation. A
  // replay returns the cached result instead of re-firing the charge/payout.
  // (The full ToolHandler/runTool descriptor migration of every tool is the
  // deferred long tail; the production money-safety guarantee lands here.)
  if (confirmedActionId && IDEMPOTENT_CONFIRMED_TOOLS.has(name)) {
    const idemKey = toolExecutionKey(confirmedActionId, name, input);
    const claim = await claimToolExecution(idemKey);
    if (claim.cached) return claim.result;
    try {
      const r = await executeToolCall(name, input, confirmedActionId);
      const isErr = !!(r && typeof r === "object" && (r as { _toolError?: boolean })._toolError);
      await settleToolExecution(idemKey, isErr ? { ok: false } : { ok: true, result: r });
      return r;
    } catch (e) {
      await settleToolExecution(idemKey, { ok: false });
      throw e;
    }
  }
  return executeToolCall(name, input, confirmedActionId);
}

// The tool-execution body (the ~3,000-line switch), split from the confirmation
// gate so the gate + idempotency wrap live in handleToolCall and this stays a
// pure executor. `confirmedActionId` is threaded only to suppress the duplicate
// "proposed" audit entry on a confirmed re-run.
async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  confirmedActionId?: string,
): Promise<unknown> {
  const nowIso = new Date().toISOString();
  const daysBack  = Math.min((input.daysBack as number) ?? 30, 90);
  const daysAgo   = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const trackTool = shouldTrackMcpTool(name) && !confirmedActionId;
  if (trackTool) {
    // Await so the "proposed" audit entry is durably persisted BEFORE the tool's
    // (consequential, possibly non-idempotent) side effect runs — otherwise a
    // crash/early-return after execution could leave an executed action with no
    // preceding audit record. The .catch keeps a write failure non-blocking.
    await recordMcpToolStatus({ name, input, status: "proposed" }).catch((err) => {
      console.warn("MCP ledger proposed write failed", { name, err: sanitizeErrorReason(err instanceof Error ? err.message : String(err)) });
    });
  }

  try {
    const result = await (async (): Promise<unknown> => {
    switch (name) {
      case "get_senior_profile": {
        if (!input.seniorId) return toolError("INVALID_INPUT", "seniorId is required");
        const denied = await assertSeniorAccess(input.seniorId as string, input.clientId ?? input.userId);
        if (denied) return denied;
        logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_senior_profile").catch(() => {});
        // Canonical-first via the shared repository (U6/R17): senior_profiles —
        // the collection assertSeniorAccess authorized against — wins, so a
        // migrated household senior (random-id profile doc with no matching
        // `seniors` doc) doesn't return a false NOT_FOUND; the legacy `seniors`
        // collection is consulted only when no profile doc exists.
        const { profile } = await getSeniorProfileWithSource(input.seniorId as string, db);
        if (!profile) return toolError("NOT_FOUND", "Senior profile not found");
        return { success: true, results: profile, hasMore: false };
      }

      case "list_household_seniors": {
        const clientId = input.clientId as string;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: clientId, data: { source: "mcp:list_household_seniors" } }).catch(() => {});
        // The Care Plan page's recipient tabs (job_postings roster + orphaned plans).
        const page = await readCarePlanPage(clientId);
        return {
          success: true,
          results: page.recipients.map((r) => ({ key: r.key, name: r.name, firstName: r.firstName, lastName: r.lastName, relationship: r.relationship, age: r.age, isPrimary: r.isPrimary })),
          hasMore: false,
        };
      }

      case "get_upcoming_appointments": {
        if (!input.clientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.clientId as string, data: { source: "mcp:get_upcoming_appointments" } }).catch(() => {});
        // Business-timezone today — UTC drops tonight's visit during PT evenings
        const today = businessTodayStr();
        // The site's My Bookings > UPCOMING SHIFTS reads `shifts` only. The
        // legacy Evia-only `appointments` collection used to be merged in here
        // (2026-08-30) — live-caught 2026-09-17: Evia told a family "Thursday
        // 9/24 has two visits" that existed nowhere on the site, because old
        // `appointments` docs (written by the retired recurring_schedules
        // extender) were still being read. Evia reads what the site reads.
        // 'needs_replacement' included (2026-09-14): the site's list shows a
        // cancelled-by-caregiver visit alongside the scheduled ones (with its
        // Find Replacement / Skip buttons), and the agent needs its shiftId.
        const shiftSnap = await db.collection("shifts")
          .where("clientId", "==", input.clientId)
          .where("status", "in", ["scheduled", "in-progress", "needs_replacement"])
          .where("date", ">=", today)
          .orderBy("date", "asc")
          .limit(6)
          .get();
        // id is returned so the agent can pass a real shiftId to manage_booking /
        // get_callout_backups — data() alone left it with nothing to act on.
        const merged = shiftSnap.docs
          // displayStatus = the page's pill (Overdue for a scheduled visit whose time passed).
          .map((d): Record<string, unknown> => ({ id: d.id, ...d.data(), displayStatus: shiftDisplayStatus(d.data()), dayOfWeek: weekdayForDate(String(d.data().date ?? "")) }))
          .sort((a, b) => `${a.date}${a.startTime ?? ""}`.localeCompare(`${b.date}${b.startTime ?? ""}`));
        const docs = merged.slice(0, 5);
        return { success: true, results: docs, hasMore: merged.length > 5 };
      }

      case "find_nearby_caregivers": {
        const { clientId, phone } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        const arr = (v: unknown) => Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean) : undefined;
        const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
        const filters = {
          query:              typeof input.query === "string" ? input.query : undefined,
          maxDistanceMiles:   num(input.maxDistanceMiles),
          maxHourlyRate:      num(input.maxHourlyRate),
          minRating:          num(input.minRating),
          minExperienceYears: num(input.minExperienceYears),
          verifiedOnly:       input.verifiedOnly === true,
          transportationOnly: input.transportationOnly === true,
          specialties:        arr(input.specialties),
          languages:          arr(input.languages),
          sortBy:             (["rating", "price-low", "price-high"].includes(String(input.sortBy)) ? String(input.sortBy) : undefined) as "rating" | "price-low" | "price-high" | undefined,
          favoritesOnly:      input.favoritesOnly === true,
        };
        const sessionSnap = phone ? await db.collection("agent_sessions").doc(phone as string).get().catch(() => null) : null;
        const chatId = sessionSnap?.data()?.chatId as string | undefined;
        if (phone && chatId) {
          const shown = await presentCaregiverSearch({
            phone: phone as string, chatId, clientId: clientId as string, filters,
            offset: num(input.offset), limit: num(input.limit), source: "mcp:find_nearby_caregivers",
          });
          if (shown.status === "no_client") return toolError("NOT_FOUND", "No client account on this conversation");
          if (shown.status === "empty") {
            return {
              success: true, total: 0, sent: true,
              instruction: "This tool already texted the family the page's empty-state message (" +
                (shown.hasFilters ? "no caregivers match their filters — it suggested widening distance/rate or dropping a specialty" : "no caregivers available yet — it offered to post a care request") +
                "). Do NOT repeat it; your entire reply is at most one short line, or nothing.",
            };
          }
          return {
            success: true, total: shown.total, shownCount: shown.shown.length, offset: shown.offset, hasMore: shown.hasMore,
            shown: shown.shown.map((c) => ({ id: c.id, name: c.name, hourlyRate: c.hourlyRate, state: c.state })),
            instruction:
              "This tool already texted the family the '<N> caregivers found' line and each caregiver's card (name, rate, rating, experience, location, specialties, button state, tappable profile link) — do NOT repeat any of it. " +
              "Your entire reply is ONE short closing line asking which caregiver they'd like to meet (reply with a name or number); a pick goes to start_interview_flow with that caregiverId (or, for someone showing Re-book, start_booking_flow). " +
              (shown.hasMore ? "If they ask for more, call this again with the SAME filters and offset = " + (shown.offset + shown.shown.length) + "." : "That was everyone matching — if they ask for more, offer to widen the filters."),
          };
        }
        // No live chat (e.g. web chat) — return the page's data for the agent to describe.
        const result = await searchCaregivers(clientId as string, filters);
        return {
          success: true, total: result.total, hasLocation: result.hasLocation, filters: result.filters,
          caregivers: result.caregivers.slice(num(input.offset) ?? 0, (num(input.offset) ?? 0) + Math.min(Math.max(Math.trunc(num(input.limit) ?? 4), 1), 10)),
        };
      }

      case "get_caregiver_info": {
        // The caregiver profile page as data (agents/caregiverProfilePage.ts):
        // the same users/{id} + publicCaregiverProfiles/{id} merge the page
        // reads, its reviews query, and its six relationship queries for the
        // buttons. Before 2026-09-19 this read the raw `caregivers` doc, which
        // the site never shows a family.
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.caregiverId as string, data: { source: "mcp:get_caregiver_info" } }).catch(() => {});
        const { readCaregiverProfilePage } = await import("../agents/caregiverProfilePage");
        const reviewLimit = Math.min((input.reviewLimit as number) ?? 5, 20);
        const page = await readCaregiverProfilePage(String(input.caregiverId), typeof input.clientId === "string" && input.clientId ? input.clientId : null, reviewLimit);
        if (!page) return toolError("NOT_FOUND", "Caregiver not found");
        return {
          success: true,
          results: {
            ...page,
            // Kept for callers/tests that read the pre-page shape.
            averageRating: page.rating,
            totalReviews:  page.reviewCount,
            recentReviews: page.reviews,
          },
          instruction: page.published
            ? "This is the profile page as the family sees it. Answer only what they asked, from these fields; money = the page's figures (rate and billed). Offer the page's buttons for this family (actions), nothing else."
            : "This caregiver is not listed on the site yet (no published profile) — only their account record exists. Do not quote a rate, skills, or availability as facts; say the profile isn't published yet.",
        };
      }

      case "contact_support": {
        const { userId, message } = input as Record<string, unknown>;
        if (!userId || typeof message !== "string" || !message.trim()) return toolError("INVALID_INPUT", "userId and message are required");
        const { relayToTeam } = await import("../utils/supportRoom");
        const { roomId } = await relayToTeam({ userId: String(userId), text: message.trim().slice(0, 2000) });
        logAudit({ eventType: "support_message_relayed", userId: String(userId), data: { source: "mcp:contact_support", roomId } }).catch(() => {});
        return { success: true, roomId, instruction: "Tell them in one line that our team has their message and will reply here by text. Do not promise a time, and do not keep answering the thing they asked the team about." };
      }

      case "get_notifications": {
        // The bell as data (agents/notificationsPage.ts): the hook's query and
        // filter, its three writes, and the same destination per type as the
        // site (utils/notificationRoutes.ts). 2026-09-19.
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        const { readNotificationsPage, markNotificationsRead, deleteNotification } = await import("../agents/notificationsPage");
        const nfUid = String(input.userId);
        const nfAction = typeof input.action === "string" ? input.action : "list";
        if (nfAction === "mark_all_read" || nfAction === "mark_read") {
          if (nfAction === "mark_read" && !input.notificationId) return toolError("INVALID_INPUT", "notificationId is required for mark_read");
          const marked = await markNotificationsRead(nfUid, nfAction === "mark_read" ? String(input.notificationId) : undefined);
          return { success: true, marked, instruction: marked ? `Marked ${marked} as read — confirm in a few words.` : "Nothing was unread — say so." };
        }
        if (nfAction === "delete") {
          if (!input.notificationId) return toolError("INVALID_INPUT", "notificationId is required for delete");
          await deleteNotification(nfUid, String(input.notificationId));
          return { success: true, instruction: "Removed from their bell — confirm in a few words." };
        }
        const nfPage = await readNotificationsPage(nfUid, "client", { show: typeof input.show === "number" ? input.show : 5 });
        logAudit({ eventType: "health_data_accessed", userId: nfUid, data: { source: "mcp:get_notifications", total: nfPage.total, unread: nfPage.unreadCount } }).catch(() => {});
        return { success: true, results: nfPage, instruction: "This is the bell exactly as the site shows it. Answer from items; when you mention one, name the page it opens (page.label). Never invent a notification." };
      }

      case "get_account_settings": {
        // Account Settings as data (agents/accountSettingsPage.ts): Auth user +
        // users doc + the Membership page's record, the page's own fallbacks.
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:get_account_settings" } }).catch(() => {});
        const { readAccountSettingsPage } = await import("../agents/accountSettingsPage");
        const acct = await readAccountSettingsPage(String(input.userId));
        if (!acct) return toolError("NOT_FOUND", "Account not found");
        return { success: true, results: acct, instruction: "This is the Account Settings page as the family sees it. Answer from these rows; to change one, use the tool named in actions[] for that row and nothing else. Never quote a value that is not here." };
      }

      case "get_membership_page": {
        // The Membership page as data (agents/membershipPage.ts) — same record the
        // page reads (customers/{uid}/subscriptions), same card, same buttons.
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:get_membership_page" } }).catch(() => {});
        const { readMembershipPage } = await import("../agents/membershipPage");
        const role = (input.role === "caregiver" ? "caregiver" : "client") as "client" | "caregiver";
        const page = await readMembershipPage(input.userId as string, role);
        return {
          success: true, ...page, page: "Membership", url: `${getAppUrl()}${role === "caregiver" ? "/caregiver/payments" : "/client/membership"}`,
          ...(role === "client" ? { serviceFeeNote: "Plus a 9% service fee on each visit (minimum $1), covering payment processing and coordinating the visit. Caregivers keep 100% of their rate." } : {}),
        };
      }
      case "get_caregiver_booking_rate": {
        // U9b: read-only rate lookup extracted from request_booking. No write.
        const rate = await resolveCaregiverRate(String(input.caregiverId ?? ""));
        if (!rate.ok) return toolError(rate.code, rate.message);
        // The profile shows the billed rate next to the caregiver's (2026-09-19 fee): quote both.
        const { SHIFT_PLATFORM_FEE_RATE: feeRate, SHIFT_PLATFORM_FEE_MIN_DOLLARS: feeMin } = await import("../billing/config");
        return {
          success: true, caregiverId: String(input.caregiverId), caregiverName: rate.caregiverName, hourlyRate: rate.hourlyRate,
          serviceFeeRate: feeRate, serviceFeeMinDollars: feeMin,
          billedHourlyRate: Math.round(Number(rate.hourlyRate) * (1 + feeRate) * 100) / 100,
          note: `The caregiver keeps $${rate.hourlyRate}/hr; the family is billed $${(Number(rate.hourlyRate) * (1 + feeRate)).toFixed(2)}/hr (rate + ${Math.round(feeRate * 100)}% service fee).`,
        };
      }

      case "start_interview_flow": {
        const { clientId, caregiverId, applicationId, phone } = input as Record<string, unknown>;
        if (!clientId || !caregiverId) return toolError("INVALID_INPUT", "clientId and caregiverId are required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const ivSessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const ivSessionData = ivSessSnap.data();
        const ivChatId = ivSessionData?.chatId as string | undefined;
        if (!ivChatId || !ivSessionData) return toolError("NOT_FOUND", "No active conversation to start the interview flow in");
        const { startInterviewFlow } = await import("../agents/interviewFlow");
        const ivResult = await startInterviewFlow(phone as string, ivChatId, ivSessionData as any, {
          caregiverId: caregiverId as string,
          ...(applicationId ? { applicationId: applicationId as string } : {}),
        });
        if (!ivResult.started) {
          return {
            success: false, reason: ivResult.reason ?? "failed_to_start",
            instruction: "The family has already been told what went wrong (or asked who to interview) — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family to start the interview flow, in one message. Send NOTHING else this turn — not even a brief acknowledgment — it can arrive out of order against the flow's own message. The flow now owns the conversation until it finishes.",
        };
      }

      case "start_replacement_flow": {
        const { clientId, shiftId, phone } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!shiftId) return toolError("INVALID_INPUT", "shiftId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the replacement flow in");
        const { startReplacementFlow } = await import("../agents/replacementFlow");
        const result = await startReplacementFlow(phone as string, chatId, sessionData as any, { shiftId: shiftId as string });
        if (!result.started) {
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what went wrong — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family the candidates and the one question that starts the flow. Send NOTHING else this turn — not even an acknowledgment. The flow now owns the conversation until it finishes.",
        };
      }

      case "start_cancel_flow": {
        const { clientId, phone, initialText } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the cancel flow in");
        const { startCancelFlow } = await import("../agents/cancelFlow");
        const result = await startCancelFlow(phone as string, chatId, sessionData as any, {
          ...(typeof initialText === "string" && initialText ? { initialText } : {}),
        });
        if (!result.started) {
          return { success: false, reason: result.reason ?? "failed_to_start", instruction: "The family has already been told what was found (or not found) — do not repeat or add anything else this turn." };
        }
        return { success: true, instruction: "This tool already texted the family the next step. Send NOTHING else this turn — not even an acknowledgment. The flow now owns the conversation until it finishes." };
      }

      case "start_correction_flow": {
        const { clientId, phone, appointmentId, initialText } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the correction in");
        const { startCorrectionFlow } = await import("../agents/correctionFlow");
        const result = await startCorrectionFlow(phone as string, chatId, sessionData as any, {
          ...(typeof appointmentId === "string" && appointmentId ? { appointmentId } : {}),
          ...(typeof initialText === "string" && initialText ? { initialText } : {}),
        });
        if (!result.started) {
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what was found (or not found) — do not repeat or add anything else this turn.",
          };
        }
        return { success: true, instruction: "This tool already texted the family the first step of the correction — do not send anything else this turn." };
      }
      case "start_visit_request_flow": {
        const { clientId, phone, caregiverId, initialText } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the visit request in");
        const { startVisitRequestFlow } = await import("../agents/visitRequestFlow");
        const result = await startVisitRequestFlow(phone as string, chatId, sessionData as any, {
          ...(typeof caregiverId === "string" && caregiverId ? { caregiverId } : {}),
          ...(typeof initialText === "string" && initialText ? { initialText } : {}),
        });
        if (!result.started) {
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what was found (or not found) — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family the next step of the visit request. Send NOTHING else this turn — not even an acknowledgment. The flow now owns the conversation until it finishes.",
        };
      }

      case "get_calendar": {
        const { clientId: calClientId, fromDate: rawFrom, toDate: rawTo } = input as Record<string, unknown>;
        if (!calClientId) return toolError("INVALID_INPUT", "clientId is required");
        const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const from = isDate(rawFrom) ? rawFrom : businessTodayStr();
        const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
        let to = isDate(rawTo) ? rawTo : addDays(from, 6);
        if (to < from) return toolError("INVALID_INPUT", "toDate must be on or after fromDate");
        if (to > addDays(from, 62)) to = addDays(from, 62);
        const [shiftSnap, ivSnap] = await Promise.all([
          db.collection("shifts").where("clientId", "==", calClientId).where("date", ">=", from).where("date", "<=", to).orderBy("date", "asc").limit(400).get(),
          db.collection("video_interviews").where("clientId", "==", calClientId).get(),
        ]);
        const visits = shiftSnap.docs.map((d): Record<string, unknown> => {
          const s = d.data();
          const recipients = (Array.isArray(s.careRecipients) ? s.careRecipients : []) as Array<{ firstName?: string; name?: string }>;
          // The popover's buttons: scheduled → Message + Cancel; completed → Message.
          const actions = s.status === "scheduled" ? ["message", "cancel"] : s.status === "completed" ? ["message"] : [];
          return {
            id: d.id, date: s.date ?? null, dayOfWeek: weekdayForDate(String(s.date ?? "")),
            startTime: s.startTime ?? null, endTime: s.endTime ?? null,
            status: s.status ?? null,
            displayStatus: isShiftOverdue(s) ? "overdue" : (s.status ?? null),
            caregiverId: s.caregiverId ?? null, caregiverName: s.caregiverName ?? null,
            bookingRequestId: s.bookingRequestId ?? null,
            address: s.address ?? null,
            notes: s.notes || null,
            careRecipients: recipients.map((r) => r.firstName || r.name || "Recipient"),
            careNeeds: Array.isArray(s.careNeeds) ? s.careNeeds : [],
            tasksCompleted: Array.isArray(s.tasksCompleted) ? s.tasksCompleted : [],
            startedAt: s.startedAt ?? null, completedAt: s.completedAt ?? null, completionNotes: s.completionNotes ?? null,
            notesLog: Array.isArray(s.notesLog) ? s.notesLog : [],
            actions,
            ...(s.reschedulePendingDate ? { reschedulePendingDate: s.reschedulePendingDate, reschedulePendingStartTime: s.reschedulePendingStartTime ?? null, reschedulePendingEndTime: s.reschedulePendingEndTime ?? null, rescheduledBy: s.rescheduledBy ?? null } : {}),
          };
        }).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
        const CAL_IV_STATUSES = new Set(["requested", "accepted", "scheduled", "confirmed", "in-progress", "completed"]);
        const CAL_IV_CANCELLABLE = new Set(["requested", "accepted", "scheduled", "confirmed"]);
        const ivRows = ivSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>))
          .filter((iv) => CAL_IV_STATUSES.has(String(iv.status ?? "")))
          .map((iv) => {
            const ms = typeof iv.scheduledTime === "string" ? parseScheduledTimeMs(iv.scheduledTime) : NaN;
            const dateStr = Number.isFinite(ms) ? businessTodayStr(undefined, new Date(ms)) : null;
            const status = String(iv.status ?? "");
            const interviewType = String(iv.interviewType ?? "video");
            const meet = typeof iv.callUrl === "string" && iv.callUrl.startsWith("https://meet.google.com/");
            return {
              id: iv.id, caregiverId: iv.caregiverId ?? null, caregiverName: iv.caregiverName ?? null, status: status || null,
              // The popover's labels.
              statusLabel: status === "requested" ? "Pending" : status === "in-progress" ? "In Progress" : status.charAt(0).toUpperCase() + status.slice(1),
              interviewType, typeLabel: interviewType === "phone" ? "Phone Call" : interviewType === "in-person" ? "In Person" : "Video Call",
              date: dateStr, dayOfWeek: dateStr ? weekdayForDate(dateStr) : null,
              scheduledTime: iv.scheduledTime ?? null, scheduledTimeLocal: Number.isFinite(ms) ? formatInterviewTime(ms) : null,
              callUrl: meet ? String(iv.callUrl) : null,
              jobId: (iv.jobId as string | undefined) ?? null, jobTitle: (iv.jobTitle as string | undefined) ?? null, jobLocation: null as string | null,
              actions: [...(meet ? ["join_video_call"] : []), "message", ...(CAL_IV_CANCELLABLE.has(status) ? ["cancel"] : [])],
            };
          })
          .filter((iv) => iv.date && iv.date >= from && iv.date <= to)
          .sort((a, b) => String(a.scheduledTime).localeCompare(String(b.scheduledTime)));
        // The popover's job banner (title + location) from the linked post.
        const jobIds = Array.from(new Set(ivRows.map((iv) => iv.jobId).filter((j): j is string => !!j)));
        const jobDocs = await Promise.all(jobIds.map((j) => db.collection("job_posts").doc(j).get().catch(() => null)));
        const jobsById = new Map<string, Record<string, unknown>>();
        jobIds.forEach((j, idx) => { const d = jobDocs[idx]; if (d && d.exists) jobsById.set(j, (d.data() ?? {}) as Record<string, unknown>); });
        const interviews = ivRows.map((iv) => {
          const job = iv.jobId ? jobsById.get(iv.jobId) : undefined;
          if (!job) return iv;
          return { ...iv, jobTitle: iv.jobTitle ?? (job.title as string | undefined) ?? null, jobLocation: (job.location as string | undefined) || (job.city ? [job.city, job.state].filter(Boolean).join(", ") : null) };
        });
        return { success: true, fromDate: from, toDate: to, visits, interviews, visitCount: visits.length, interviewCount: interviews.length };
      }

      case "start_reschedule_flow": {
        const { clientId, phone, shiftId, date, startTime, endTime, initialText } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the reschedule flow in");
        const { startRescheduleFlow } = await import("../agents/rescheduleFlow");
        const result = await startRescheduleFlow(phone as string, chatId, sessionData as any, {
          ...(typeof shiftId === "string" && shiftId ? { shiftId } : {}),
          ...(typeof date === "string" && date ? { date } : {}),
          ...(typeof startTime === "string" && startTime ? { startTime } : {}),
          ...(typeof endTime === "string" && endTime ? { endTime } : {}),
          ...(typeof initialText === "string" && initialText ? { initialText } : {}),
          quiet: true,
        });
        if (!result.started) {
          if (result.reason === "no_visits") {
            return {
              success: false, reason: "no_visits", nothingSent: true,
              instruction: "The family has NO scheduled visits, so there is nothing to reschedule and NOTHING was texted. " +
                "If they were actually asking to set up / schedule an INTERVIEW with a caregiver (not to move a visit), call start_interview_flow now. " +
                `Otherwise tell them once, in your own words: ${result.message ?? "there are no upcoming scheduled visits to move."}`,
            };
          }
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what was found (or not found) — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family the next step of the reschedule flow. Send NOTHING else this turn — not even an acknowledgment. The flow now owns the conversation until it finishes.",
        };
      }

      case "start_resend_booking_flow": {
        const { clientId, phone, caregiverId, bookingRequestId } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the resend in");
        const { startResendBookingFlow } = await import("../agents/bookingFlow");
        const result = await startResendBookingFlow(phone as string, chatId, sessionData as any, {
          ...(typeof caregiverId === "string" && caregiverId ? { caregiverId } : {}),
          ...(typeof bookingRequestId === "string" && bookingRequestId ? { bookingRequestId } : {}),
        });
        if (!result.started) {
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what was found (or not found) — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family the pre-filled recap (or the pick list). Send NOTHING else this turn — not even an acknowledgment. The booking flow now owns the conversation until it finishes.",
        };
      }

      case "start_booking_flow": {
        const { clientId, caregiverId, interviewId, phone } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const sessionData = sessSnap.data();
        const chatId = sessionData?.chatId as string | undefined;
        if (!chatId || !sessionData) return toolError("NOT_FOUND", "No active conversation to start the booking flow in");
        const { startBookingFlow } = await import("../agents/bookingFlow");
        const result = await startBookingFlow(phone as string, chatId, sessionData as any, {
          ...(caregiverId ? { caregiverId: caregiverId as string } : {}),
          ...(interviewId ? { interviewId: interviewId as string } : {}),
        });
        if (!result.started) {
          return {
            success: false, reason: result.reason ?? "failed_to_start",
            instruction: "The family has already been told what went wrong (or asked who to book) — do not repeat or add anything else this turn.",
          };
        }
        return {
          success: true,
          instruction: "This tool already texted the family to start the booking flow, in one message. Send NOTHING else this turn — not even a brief acknowledgment — it can arrive out of order against the flow's own message. The flow now owns the conversation until it finishes.",
        };
      }

      case "trigger_emergency_alert": {
        return runActionNativeMcpWrite(name, input, async () => {
        // Parity with the EmergencySOS UI (dbService.triggerEmergencyAlert). clientId
        // is session-injected. Writes an active emergency_alerts doc + an admin_alert.
        const { clientId, note, location } = input;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required (auto-injected from session)");
        // Idempotency: a model retry / double-call must not spawn duplicate active
        // alerts (which double-pages ops). If this client already has an active
        // alert raised in the last 2 minutes, return it instead of raising another
        // — a genuine emergency that recent is already covered by the active one.
        // Single-equality query (no composite index) so the emergency path can't
        // fail on a missing index; per-client alert count is tiny.
        const recentAlerts = await db.collection("emergency_alerts")
          .where("initiatorId", "==", clientId)
          .limit(50)
          .get();
        const twoMinAgoMs = Date.now() - 2 * 60 * 1000;
        const activeRecent = recentAlerts.docs.find((d) => {
          const data = d.data();
          const ts = Date.parse((data.timestamp as string) ?? "");
          return data.status === "active" && !isNaN(ts) && ts >= twoMinAgoMs;
        });
        if (activeRecent) {
          return { success: true, alertId: activeRecent.id, status: "active", advise911: true, deduped: true };
        }
        const alertRef = await db.collection("emergency_alerts").add({
          initiatorId:     clientId,
          initiatorType:   "client",
          timestamp:       nowIso,
          ...(location ? { location } : {}),
          ...(note ? { note: String(note).slice(0, 500) } : {}),
          status:          "active",
          notifiedContacts: [],
          source:          "cara",
        });
        await db.collection("admin_alerts").add({
          type: "emergency_alert", title: "🚨 Emergency alert raised via Evia",
          clientId, alertId: alertRef.id, note: note ?? "", createdAt: nowIso, resolved: false,
        }).catch(() => {});
        logAudit({ eventType: "emergency_alert_raised", userId: clientId as string, data: { source: "mcp:trigger_emergency_alert", alertId: alertRef.id } }).catch(() => {});
        return { success: true, alertId: alertRef.id, status: "active", advise911: true };
        });
      }

      // 2026-09-14 (Hamse's call): rebuilt against the REAL data model. The
      // old implementation queried `appointments` — a legacy collection no
      // current visit (site or Evia) is written to anymore; a "Needs
      // Replacement" card lives on a `shifts` doc. Candidate search is a
      // faithful port of the site's own ReplacementPickerModal (see
      // agents/shiftReplacement.ts's header comment) rather than a stored
      // `backupCaregiverOptions` field, which the current pipeline never
      // populates.
      // 2026-09-14 (Hamse's call): sends the SAME profile-card gallery
      // format the initial matching flow sends (matchingAgent.ts's
      // runMatchingForClient / resend_caregiver_profile) — a tappable link
      // per candidate that auto-previews their name + photo, not just a
      // plain text list. Also writes pendingMatches/shownCaregiverIds/
      // knownNames the same way, so a later "send me Maria's profile again"
      // or "book Sam" resolves through the exact same machinery every other
      // caregiver-search path already uses — this flow was missing that
      // entirely before, unlike find_nearby_caregivers/find_replacement_
      // caregivers, which already send real profile cards.
      // Thin wrapper over the shared Find-Replacement building blocks in
      // agents/shiftReplacement.ts — the scripted replacementFlow.ts (the
      // preferred path) uses the exact same helpers, so both write the same thing.
      case "get_callout_backups": {
        const { clientId, shiftId, phone } = input;
        if (!clientId || !shiftId) return toolError("INVALID_INPUT", "shiftId is required");
        if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        const { loadReplacementShift, findReplacementCandidates, sendReplacementCandidateCards, describeVisitWindow } = await import("../agents/shiftReplacement");
        const loaded = await loadReplacementShift(clientId as string, shiftId as string);
        if (!loaded.ok) return toolError(loaded.code, loaded.message);
        const shift = loaded.shift;
        const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const chatId = sessSnap.data()?.chatId as string | undefined;
        if (!chatId) return toolError("NOT_FOUND", "No active conversation to send the candidates to");
        const candidates = await findReplacementCandidates(clientId as string, shift.caregiverId as string, shift as { careRecipients?: Array<{ careNeeds?: string[] }> });
        if (candidates.length === 0) {
          return { success: true, shiftId, caregivers: [], count: 0, instruction: "No candidates were found — tell the family plainly and ask if they'd like to search more broadly, or skip the replacement." };
        }
        await sendReplacementCandidateCards(phone as string, chatId, shiftId as string, candidates, nowIso);
        logAudit({ eventType: "message_sent", userId: clientId as string, data: { source: "mcp:get_callout_backups", shiftId, count: candidates.length } }).catch(() => {});
        // Same two fields the website's Find Replacement modal shows alongside
        // the candidate list (Date / Start / End, pre-filled from the visit):
        // the family confirms or changes them in the same breath as the pick.
        const visitWhen = describeVisitWindow(shift);
        return {
          success: true, shiftId, caregivers: candidates, count: candidates.length,
          originalVisit: { date: shift.date ?? null, startTime: shift.startTime ?? null, endTime: shift.endTime ?? null, display: visitWhen },
          instruction:
            "This tool already texted the family each candidate's profile card (tappable link with photo preview) — do not repeat their names/rates yourself. " +
            `Your ONE reply: ask which one they'd like to send the request to, and whether to keep the visit as is (${visitWhen}) or change the day/time — the same two choices the website's Find Replacement modal shows. ` +
            "Then call select_callout_backup with that caregiverId (from this result or pendingMatches, never guessed from a name); omit date/startTime/endTime to keep the original, pass them only if they asked for a change. No interview step — this sends a replacement booking request.",
        };
      }

      // Matches the site's own handleConfirmReplacement EXACTLY: creates a
      // real NEW booking_requests doc (the candidate gets the normal
      // accept/decline text, same as any fresh booking) rather than
      // reassigning the visit outright — the original shift stays
      // 'needs_replacement' until the candidate actually accepts. Only
      // bookkeeping (replacementRequestId/replacementCaregiverName) is
      // written onto the original shift here.
      case "select_callout_backup": {
        const { clientId, shiftId, backupCaregiverId, date, startTime, endTime } = input;
        if (!clientId || !shiftId || !backupCaregiverId) return toolError("INVALID_INPUT", "shiftId and backupCaregiverId are required");
        const { loadReplacementShift, createReplacementRequest } = await import("../agents/shiftReplacement");
        const loaded = await loadReplacementShift(clientId as string, shiftId as string);
        if (!loaded.ok) return toolError(loaded.code, loaded.message);
        const created = await createReplacementRequest({
          clientId: clientId as string, shiftId: shiftId as string, shift: loaded.shift, shiftRef: loaded.ref,
          backupCaregiverId: backupCaregiverId as string,
          ...(date ? { date: date as string } : {}),
          ...(startTime ? { startTime: startTime as string } : {}),
          ...(endTime ? { endTime: endTime as string } : {}),
          nowIso,
        });
        if (!created.ok) return toolError(created.code, created.message);
        logAudit({ eventType: "callout_backup_selected", userId: clientId as string, data: { source: "mcp:select_callout_backup", shiftId, backupCaregiverId, bookingRequestId: created.bookingRequestId } }).catch(() => {});
        return { success: true, shiftId, bookingRequestId: created.bookingRequestId, caregiverId: backupCaregiverId, caregiverName: created.caregiverName, status: "pending" };
      }

      case "send_referral": {
        const { userId, email } = input;
        if (!userId) return toolError("INVALID_INPUT", "userId is required (auto-injected from session)");
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return toolError("INVALID_INPUT", "a valid email is required");
        const userSnap = await db.collection("users").doc(userId as string).get();
        const userData = userSnap.data() || {};
        let referralCode = userData.referralCode as string | undefined;
        if (!referralCode) {
          referralCode = generateReferralCode();
          await db.collection("users").doc(userId as string).set({ referralCode }, { merge: true });
        }
        const userType = (userData.userType === "caregiver" ? "caregiver" : "client");
        await db.collection("referrals").add({
          referrerId: userId, referrerUserId: userId, referredEmail: String(email), status: "pending", referralCode, userType, createdAt: nowIso, source: "cara",
        });
        logAudit({ eventType: "referral_sent", userId: userId as string, data: { source: "mcp:send_referral" } }).catch(() => {});
        return { success: true, referralCode, invited: String(email) };
      }

      case "get_referral_status": {
        const { userId } = input;
        if (!userId) return toolError("INVALID_INPUT", "userId is required (auto-injected from session)");
        const userSnap = await db.collection("users").doc(userId as string).get();
        let referralCode = (userSnap.data()?.referralCode as string | undefined);
        if (!referralCode) {
          referralCode = generateReferralCode();
          await db.collection("users").doc(userId as string).set({ referralCode }, { merge: true });
        }
        const refSnap = await db.collection("referrals").where("referrerId", "==", userId).get();
        const referrals = refSnap.docs.map((d) => ({ email: d.data().referredEmail, status: d.data().status }));
        return { success: true, referralCode, totalReferred: referrals.length, referrals };
      }

      case "update_preferences": {
        const { userId, ...patch } = input;
        if (!userId) return toolError("INVALID_INPUT", "userId is required");
        logAudit({ eventType: "permissions_updated", userId: userId as string, data: { source: "mcp:update_preferences", patch } }).catch(() => {});
        await db.collection("user_preferences").doc(userId as string).set(patch, { merge: true });
        return { success: true, updated: true };
      }

      case "read_memory_file": {
        if (!input.userId || !input.file) return toolError("INVALID_INPUT", "userId and file are required");
        const requestedFile = String(input.file);
        // Transient tool_* pointers are per-turn working data and may be read
        // exactly while durable memory reconciliation is in progress. Every
        // durable file is masked so an MCP direct read cannot bypass the shared
        // Storage-memory suppression used by prompt assembly and cara_knows.
        if (!isTransientToolFile(requestedFile)) {
          const { getMemoryReconciliationState } = await import("../memory/memoryOperations");
          const reconciliation = await getMemoryReconciliationState(input.userId as string);
          if (reconciliation.storageMasked) {
            return { success: true, content: "", empty: true, reconciliationPending: true };
          }
        }
        // Reads accept any slug (canonical or ad-hoc offloaded files); the storage
        // layer sanitizes the name so it can never escape the user's prefix.
        logHealthDataAccessed(input.userId as string, input.userId as string, "mcp:read_memory_file").catch(() => {});
        const content = await readMemoryFile(input.userId as string, input.file as MemoryFile);
        return { success: true, content: content || "", empty: !content };
      }

      case "update_memory_file": {
        if (!input.userId || !input.file || !input.content) return toolError("INVALID_INPUT", "userId, file, and content are required");
        const VALID_FILES = new Set(["profile", "health", "family", "recent_episodes", "procedural"]);
        if (!VALID_FILES.has(input.file as string)) return toolError("INVALID_INPUT", `file must be one of: ${[...VALID_FILES].join(", ")}`);
        // R11 (U4b): never trust the model-supplied userId for a memory mutation.
        const updateIdentityError = await verifyMemoryToolIdentity(input);
        if (updateIdentityError) return updateIdentityError;
        // R23: appended content that restates a forgotten/superseded fact is a
        // typed refusal, never a silent re-store — same fingerprint check the
        // fact-extraction write guard uses (fail-open inside on lookup errors).
        // The explicit re-remember confirmation is the only path back in.
        const { findTombstonedRestatement } = await import("../memory/learnedFacts");
        const tombstonedHit = await findTombstonedRestatement(input.userId as string, input.content as string);
        if (tombstonedHit) {
          return toolError(
            "CONFLICT",
            "This content restates a fact the family previously asked Evia to forget or correct, so it was NOT saved. " +
            "Do not re-add it. If the user is explicitly asking to remember it again, ask them to confirm and it will be restored through the re-remember confirmation flow.",
          );
        }
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:update_memory_file", file: input.file } }).catch(() => {});
        const existing = await readMemoryFile(input.userId as string, input.file as MemoryFile);
        const updated  = existing
          ? `${existing.trimEnd()}\n\n${input.content}`
          : input.content as string;
        await writeMemoryFile(input.userId as string, input.file as MemoryFile, updated);
        return { success: true, updated: true };
      }

      case "edit_memory_file": {
        if (!input.userId || !input.file || !input.find) return toolError("INVALID_INPUT", "userId, file, and find are required");
        // R11 (U4b): never trust the model-supplied userId for a memory mutation.
        const editIdentityError = await verifyMemoryToolIdentity(input);
        if (editIdentityError) return editIdentityError;
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:edit_memory_file", file: input.file } }).catch(() => {});
        const existing = await readMemoryFile(input.userId as string, input.file as MemoryFile);
        if (!existing || !existing.includes(input.find as string)) {
          return { success: true, replaced: 0, matched: false };
        }
        await stageMcpMemoryFileChange({
          kind: String(input.replace ?? "").trim() ? "correction" : "forget",
          userId: input.userId as string,
          phone: stringInput(input, "phone"),
          fileSlug: String(input.file),
          source: "mcp:edit_memory_file",
          retiredText: input.find as string,
        });
        const replaced = await editMemoryFile(
          input.userId as string,
          input.file as MemoryFile,
          input.find as string,
          (input.replace as string) ?? ""
        );
        return { success: true, replaced, matched: replaced > 0 };
      }

      case "search_memory": {
        if (!input.userId || !input.query) return toolError("INVALID_INPUT", "userId and query are required");
        logHealthDataAccessed(input.userId as string, input.userId as string, "mcp:search_memory").catch(() => {});
        // Hybrid: substring (exact) ∪ semantic (cosine over text-embedding-3-small).
        // Falls back to substring automatically if the embedding API or key is unavailable.
        const hits = await searchMemoryHybrid(input.userId as string, input.query as string);
        return { success: true, hits, count: hits.length };
      }

      case "cara_knows": {
        // Memory transparency surface (Sprint 3 / roadmap §5.3). Returns the
        // family's full editable memory context — the same blob Evia already
        // sees in-prompt, but surfaced so they can verify or correct it.
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        logHealthDataAccessed(input.userId as string, input.userId as string, "mcp:cara_knows").catch(() => {});
        // U4b (KTD9/KTD10): while a correction/forget is still reconciling this
        // user's Storage memory, getMemoryContext returns "" by design — but
        // the generic "no memory files yet" fallback would read as amnesia.
        // Return the deterministic reconciliation-pending copy instead.
        try {
          const { getMemoryReconciliationState } = await import("../memory/memoryOperations");
          const reconciliation = await getMemoryReconciliationState(input.userId as string);
          if (reconciliation.storageMasked) {
            return {
              success: true,
              reconciliationPending: true,
              files: [],
              context: MEMORY_QUERY_RECONCILIATION_COPY,
            };
          }
        } catch {
          // Fail-open — the shared reader still masks the content itself.
        }
        const [context, files] = await Promise.all([
          getMemoryContext(input.userId as string),
          listMemoryFiles(input.userId as string),
        ]);
        return {
          success: true,
          files,
          context: context || "(no memory files on file yet — Evia is still building her picture of this family)",
        };
      }

      case "task": {
        // DeepAgents `task` pattern — dispatch to an ephemeral, stateless
        // sub-agent (see agents/ephemeralSubAgents.ts). Sub-agent does its own
        // narrow LLM call with a focused system prompt and returns one string.
        const description   = input.description   as string | undefined;
        const subagent_type = input.subagent_type as string | undefined;
        if (!description || !subagent_type) {
          return toolError("INVALID_INPUT", "description and subagent_type are required");
        }
        if (INTERNAL_SUB_AGENT_NAMES.has(subagent_type)) {
          return toolError("INVALID_INPUT", `subagent_type "${subagent_type}" is internal-only and cannot be invoked via task.`);
        }
        const result = await runEphemeralSubAgent({ description, subagentType: subagent_type });
        return {
          success:      true,
          output:       result.output,
          subagentType: result.subagentType,
          durationMs:   result.durationMs,
          modelUsed:    result.modelUsed,
        };
      }

      case "write_todos": {
        // Working-memory checklist (DeepAgents TodoListMiddleware port). Stored on
        // agent_sessions; injected into Evia's system prompt at the start of each
        // turn so she can see what's outstanding across the conversation.
        const { phone, items } = input as { phone?: string; items?: Array<{ task: string; status: string }> };
        if (!phone || !Array.isArray(items)) {
          return toolError("INVALID_INPUT", "phone and items[] are required");
        }
        const allowed = new Set(["pending", "in_progress", "completed"]);
        const sanitized = items
          .filter((it) => it && typeof it.task === "string" && allowed.has(it.status))
          .slice(0, 20) // cap — checklists this long usually mean Claude is over-decomposing
          .map((it) => ({ task: it.task.slice(0, 200), status: it.status }));

        await admin.firestore().collection("agent_sessions").doc(phone).set({
          todos:          sanitized,
          todosUpdatedAt: new Date().toISOString(),
        }, { merge: true });

        const pending     = sanitized.filter((t) => t.status === "pending").length;
        const inProgress  = sanitized.filter((t) => t.status === "in_progress").length;
        const completed   = sanitized.filter((t) => t.status === "completed").length;
        return { success: true, count: sanitized.length, pending, inProgress, completed };
      }

      case "manage_booking": {
        const { clientId, action, bookingRequestId, shiftId, amendmentId, date, startTime, endTime } = input;
        if (!clientId || !action) return toolError("INVALID_INPUT", "clientId and action are required");

        // The cancel actions share agents/bookingCancel.ts with the scripted
        // cancelFlow (2026-09-17) — one write shape per site button.
        if (action === "cancel_pending_request") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for cancel_pending_request");
          const r = await cancelPendingRequest(clientId as string, bookingRequestId as string, "mcp:manage_booking");
          if (!r.ok) return toolError(r.code, r.message);
          return { success: true, action, bookingRequestId };
        }

        if (action === "cancel_whole_booking") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for cancel_whole_booking");
          const r = await cancelWholeBooking(clientId as string, bookingRequestId as string, "mcp:manage_booking");
          if (!r.ok) return toolError(r.code, r.message);
          return { success: true, action, bookingRequestId, shiftsCancelled: r.shiftsCancelled ?? 0, ...(r.shiftsCancelled === 0 ? { alreadyCancelled: true } : {}) };
        }

        if (action === "cancel_visit") {
          if (!shiftId) return toolError("INVALID_INPUT", "shiftId is required for cancel_visit");
          const r = await cancelVisit(clientId as string, shiftId as string, "mcp:manage_booking");
          if (!r.ok) return toolError(r.code, r.message);
          return { success: true, action, shiftId };
        }

        if (action === "cancel_pending_amendment") {
          if (!amendmentId) return toolError("INVALID_INPUT", "amendmentId is required for cancel_pending_amendment");
          const r = await cancelPendingAmendment(clientId as string, amendmentId as string, "mcp:manage_booking");
          if (!r.ok) return toolError(r.code, r.message);
          return { success: true, action, amendmentId };
        }

        if (action === "withdraw_replacement_request") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for withdraw_replacement_request");
          const r = await withdrawReplacementRequest(clientId as string, bookingRequestId as string, "mcp:manage_booking");
          if (!r.ok) return toolError(r.code, r.message);
          return { success: true, action, bookingRequestId };
        }

        // Proposes a new date/time for an EXISTING shift IN PLACE — matches
        // the website's own reschedulePendingDate/StartTime/EndTime pattern
        // exactly (ClientVisitsPage.tsx's handleProposeReschedule). The
        // real date/startTime/endTime are untouched until the caregiver
        // accepts; onShiftStatusChanged (notificationTriggers.ts) already
        // watches for this exact field combination and texts the caregiver
        // automatically — no manual send here.
        if (action === "propose_reschedule") {
          if (!shiftId || !date || !startTime || !endTime) {
            return toolError("INVALID_INPUT", "shiftId, date, startTime, and endTime are required for propose_reschedule");
          }
          // Shared with rescheduleFlow.ts (agents/shiftReschedule.ts): same
          // status gate, same own-visit double-booking check the site runs
          // (fetchOwnShiftsForDate + rangeConflicts), same write.
          const loaded = await loadReschedulableShift(clientId as string, shiftId as string);
          if (!loaded.ok) return toolError(loaded.code, loaded.message);
          const proposed = await proposeShiftReschedule({
            clientId: clientId as string, shiftId: shiftId as string, shift: loaded.shift, shiftRef: loaded.ref,
            date: date as string, startTime: startTime as string, endTime: endTime as string,
            nowIso, source: "mcp:manage_booking",
          });
          if (!proposed.ok) {
            if (proposed.code === "CONFLICT") {
              return toolError("INVALID_INPUT",
                `That overlaps another visit with the same caregiver at ${formatHHMMForDisplay(proposed.conflict.startTime)}` +
                `${proposed.conflict.endTime ? `–${formatHHMMForDisplay(proposed.conflict.endTime)}` : ""} that day — ask the family for a different time`);
            }
            return toolError("INVALID_INPUT", proposed.message);
          }
          return { success: true, action, shiftId, date, startTime, endTime };
        }

        // Accept new time / Decline / Withdraw — the page's handleAcceptReschedule
        // and handleClearReschedule, via the shared helpers in shiftReschedule.ts
        // (accept re-runs the page's own-shift conflict check first).
        if (action === "accept_reschedule" || action === "clear_reschedule") {
          if (!shiftId) return toolError("INVALID_INPUT", `shiftId is required for ${action}`);
          const r = action === "accept_reschedule"
            ? await acceptRescheduleProposal(clientId as string, shiftId as string, nowIso, "mcp:manage_booking")
            : await clearRescheduleProposal(clientId as string, shiftId as string, "mcp:manage_booking");
          if (!r.ok) {
            if (r.code === "CONFLICT") {
              return toolError("INVALID_INPUT",
                `You already have another visit with the same caregiver at ${formatHHMMForDisplay(r.conflict.startTime)}` +
                `${r.conflict.endTime ? `–${formatHHMMForDisplay(r.conflict.endTime)}` : ""} that day — decline this proposal and suggest another time`);
            }
            return toolError(r.code, r.message);
          }
          return action === "accept_reschedule"
            ? { success: true, action, shiftId, date: r.date, startTime: r.startTime, endTime: r.endTime }
            : { success: true, action, shiftId };
        }

        return toolError("INVALID_INPUT", `Unknown action: ${action}`);
      }

      case "request_schedule_amendment": {
        const { bookingRequestId, clientId, date, startTime, endTime, notes, ongoing, newDays: rawNewDays, startDate: rawStart, endDate: rawEnd } = input as Record<string, unknown>;
        if (!bookingRequestId || !clientId) return toolError("INVALID_INPUT", "bookingRequestId and clientId are required");
        const brSnap = await db.collection("booking_requests").doc(bookingRequestId as string).get();
        if (!brSnap.exists) return toolError("NOT_FOUND", "Booking not found");
        const br = brSnap.data()!;
        if (br.clientId !== clientId) return toolError("PERMISSION_DENIED", "Booking does not belong to this client");
        if (!br.caregiverId) return toolError("INVALID_INPUT", "Booking has no caregiver");

        // Schedule.tsx: "+ Request Visit" and the modal's submit both run gate('booking', caregiverName).
        const amendGateError = await checkClientAccessGate(clientId as string, "booking", { phone: (input as Record<string, unknown>).phone, caregiverName: (br.caregiverName as string | undefined) ?? undefined });
        if (amendGateError) return amendGateError;

        // The modal's shape (newDays) or the legacy single-day form.
        const newDays: Record<string, VisitTimeBlock[]> = {};
        if (rawNewDays && typeof rawNewDays === "object") {
          for (const [k, v] of Object.entries(rawNewDays as Record<string, unknown>)) {
            const abbr = normDayAbbr(k);
            if (!abbr || !Array.isArray(v)) continue;
            const blocks = (v as Array<{ start?: unknown; end?: unknown }>).map((b) => ({ start: String(b?.start ?? ""), end: String(b?.end ?? "") }));
            if (blocks.some((b) => !blockToRange(b))) return toolError("INVALID_INPUT", `Each block needs HH:MM start/end with end after start (${abbr})`);
            if (blocks.length) newDays[abbr] = blocks;
          }
        } else if (date && startTime && endTime) {
          const block = { start: String(startTime), end: String(endTime) };
          if (!blockToRange(block)) return toolError("INVALID_INPUT", "startTime/endTime must be HH:MM with end after start");
          const abbr = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${date}T12:00:00Z`).getUTCDay()];
          newDays[abbr] = [block];
        }
        if (!Object.keys(newDays).length) return toolError("INVALID_INPUT", "Provide newDays, or date + startTime + endTime");
        const startDateStr = typeof rawStart === "string" && rawStart ? rawStart : (typeof date === "string" && date ? date : businessTodayStr());
        const isOngoing = rawNewDays ? ongoing !== false : Boolean(ongoing);
        const endDateStr = isOngoing ? null : (typeof rawEnd === "string" && rawEnd ? rawEnd : (typeof date === "string" ? date : null));

        // The modal's checks: overlap with the booking's own schedule / this
        // family's shifts with the caregiver, or a time the caregiver is
        // booked elsewhere — both refused, as the modal refuses them.
        const avail = await loadCaregiverAvailability(clientId as string, br.caregiverId as string);
        const schedule: Record<string, VisitTimeBlock[]> = {};
        for (const [k, v] of Object.entries((br.schedule?.dayShiftTimes ?? {}) as Record<string, unknown>)) {
          const abbr = normDayAbbr(k);
          if (!abbr) continue;
          const blocks = (Array.isArray(v) ? v : [v]) as Array<{ start?: string; end?: string }>;
          schedule[abbr] = blocks.filter((b) => b?.start && b?.end).map((b) => ({ start: String(b.start), end: String(b.end) }));
        }
        const bookingForCheck = { bookingId: brSnap.id, jobTitle: String(br.jobTitle ?? ""), address: String(br.address ?? ""), schedule };
        const warnings: string[] = [];
        for (const [abbr, blocks] of Object.entries(newDays)) {
          for (const block of blocks) {
            const c = checkVisitBlock(abbr as any, block, bookingForCheck, avail);
            if (c.overlap) return toolError("INVALID_INPUT", `${VISIT_DAY_FULL[abbr]} ${describeBlock(block)} overlaps a visit the family already has with ${br.caregiverName ?? "this caregiver"} (${describeBlock(c.overlap)}) — ask for a different time`);
            if (c.busy) return toolError("INVALID_INPUT", `${br.caregiverName ?? "The caregiver"} is already booked ${VISIT_DAY_FULL[abbr]} ${describeRange(c.busy)} — ask for a different time`);
            if (c.outsidePreferred) warnings.push(`${VISIT_DAY_FULL[abbr]} ${describeBlock(block)} is outside the caregiver's usual availability`);
          }
        }

        const { amendmentId } = await createScheduleAmendment({
          clientId: clientId as string,
          bookingRequestId: bookingRequestId as string,
          caregiverId: br.caregiverId as string,
          caregiverName: String(br.caregiverName ?? ""),
          newDays,
          notes: typeof notes === "string" ? notes : "",
          startDate: startDateStr,
          endDate: endDateStr,
          ongoing: isOngoing,
          source: "mcp:request_schedule_amendment",
        });
        return { success: true, amendmentId, ...(warnings.length ? { warnings } : {}) };
      }

      case "respond_to_schedule_amendment": {
        const { amendmentId, caregiverId, decision } = input;
        if (!amendmentId || !caregiverId || !decision) return toolError("INVALID_INPUT", "amendmentId, caregiverId, and decision are required");
        const amSnap = await db.collection("booking_amendments").doc(amendmentId as string).get();
        if (!amSnap.exists) return toolError("NOT_FOUND", "Amendment request not found");
        const am = amSnap.data()!;
        if (am.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Amendment does not belong to this caregiver");
        if (am.status !== "pending") return toolError("INVALID_INPUT", `Amendment already decided: ${am.status}`);

        if (decision === "decline") {
          await amSnap.ref.update({ status: "declined", respondedAt: nowIso });
          logAudit({ eventType: "amendment_declined", userId: caregiverId as string, data: { source: "mcp:respond_to_schedule_amendment", amendmentId } }).catch(() => {});
          return { success: true, decision: "declined", amendmentId };
        }

        // Accept — mirrors CaregiverBookingsPage.tsx's handleAcceptAmendment
        // exactly: generate the real shifts docs from amendment.newDays,
        // joined back via bookingRequestId, so this works identically whether
        // the caregiver accepts by text or by opening the website.
        const bookingSnap = am.bookingRequestId
          ? await db.collection("booking_requests").doc(am.bookingRequestId as string).get()
          : null;
        const booking = bookingSnap?.data() ?? {};
        const { nextOccurrenceOnOrAfter, addDays } = await import("../scheduled/shiftGenerator");
        const today = new Date().toISOString().split("T")[0];
        const generateFrom = (am.startDate as string) || today;
        const generateTo = am.ongoing ? addDays(today, 27) : ((am.endDate as string) || generateFrom);
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        const cgData = cgSnap.data() ?? {};
        const caregiverPhotoURL = (cgData.profilePhoto ?? cgData.photoURL ?? cgData.photo ?? null) as string | null;

        const shiftBase = {
          clientId:        booking.clientId ?? am.clientId,
          clientName:      booking.clientName ?? am.clientName ?? "",
          clientPhotoURL:  booking.clientPhotoURL ?? null,
          caregiverId,
          caregiverName:   booking.caregiverName ?? am.caregiverName ?? "",
          caregiverPhotoURL,
          status:          "scheduled",
          address:         booking.address ?? "",
          careNeeds:       booking.careNeeds ?? [],
          lifestylePreferences: booking.lifestylePreferences ?? [],
          rate:            booking.rate ?? null,
          paymentMethod:   booking.paymentMethod ?? null,
          // Same rule as the site's handleAcceptAmendment (2026-09-17): the
          // request's note, else the booking's general note.
          notes:           (am.notes as string) || (booking.notes as string) || "",
          careRecipients:  booking.careRecipients ?? [],
          emergencyContact: booking.emergencyContact ?? null,
          bookingRequestId: am.bookingRequestId ?? null,
          recurringWeekly: Boolean(am.ongoing),
          tasksCompleted:  [] as string[],
          createdAt:       nowIso,
        };

        const batch = db.batch();
        let count = 0;
        const newDays = (am.newDays ?? {}) as Record<string, Array<{ start: string; end: string }>>;
        for (const [day, blocks] of Object.entries(newDays)) {
          for (const block of blocks) {
            let dateStr = nextOccurrenceOnOrAfter(generateFrom, day);
            while (dateStr <= generateTo && count < 490) {
              batch.set(db.collection("shifts").doc(), { ...shiftBase, date: dateStr, startTime: block.start, endTime: block.end });
              count++;
              dateStr = addDays(dateStr, 7);
              if (!am.ongoing) break; // a one-off amendment produces exactly one shift
            }
          }
        }
        if (count > 0) await batch.commit();
        await amSnap.ref.update({ status: "accepted", respondedAt: nowIso });
        logAudit({ eventType: "amendment_accepted", userId: caregiverId as string, data: { source: "mcp:respond_to_schedule_amendment", amendmentId, shiftsCreated: count } }).catch(() => {});
        return { success: true, decision: "accepted", amendmentId, shiftsCreated: count };
      }

      // Caregiver-side counterpart to manage_booking's propose/accept/
      // clear_reschedule — same underlying shift-doc mechanism
      // (reschedulePendingDate/StartTime/EndTime, rescheduledBy), just
      // scoped by caregiverId instead of clientId. onShiftStatusChanged
      // (notificationTriggers.ts) already watches this field combination
      // and texts the family automatically — no manual send needed here.
      case "manage_shift_reschedule": {
        const { caregiverId, shiftId, action, date, startTime, endTime } = input;
        if (!caregiverId || !shiftId || !action) return toolError("INVALID_INPUT", "caregiverId, shiftId, and action are required");
        const shiftSnap = await db.collection("shifts").doc(shiftId as string).get();
        if (!shiftSnap.exists) return toolError("NOT_FOUND", "Visit not found");
        const shift = shiftSnap.data()!;
        if (shift.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Visit does not belong to this caregiver");

        if (action === "propose") {
          if (!date || !startTime || !endTime) return toolError("INVALID_INPUT", "date, startTime, and endTime are required for action:'propose'");
          const startMin = bookingTimeToMinutes(startTime);
          const endMin   = bookingTimeToMinutes(endTime);
          if (startMin === null || endMin === null || endMin <= startMin) {
            return toolError("INVALID_INPUT", "startTime/endTime must be 'HH:MM' with end after start");
          }
          if (shift.status !== "scheduled") return toolError("INVALID_INPUT", `Only a scheduled visit can be rescheduled this way (status: ${shift.status})`);
          await shiftSnap.ref.update({
            reschedulePendingDate: date,
            reschedulePendingStartTime: startTime,
            reschedulePendingEndTime: endTime,
            reschedulePendingAt: nowIso,
            rescheduledBy: "caregiver",
          });
          logAudit({ eventType: "shift_reschedule_proposed", userId: caregiverId as string, data: { source: "mcp:manage_shift_reschedule", shiftId } }).catch(() => {});
          return { success: true, action, shiftId, date, startTime, endTime };
        }

        if (action === "accept") {
          if (!shift.reschedulePendingDate) return toolError("INVALID_INPUT", "There's no pending reschedule proposal on this visit");
          if (shift.rescheduledBy !== "client") return toolError("INVALID_INPUT", "This proposal is your own — nothing to accept (use action:'decline' to withdraw it)");
          await shiftSnap.ref.update({
            date: shift.reschedulePendingDate,
            startTime: shift.reschedulePendingStartTime,
            endTime: shift.reschedulePendingEndTime,
            reschedulePendingDate: admin.firestore.FieldValue.delete(),
            reschedulePendingStartTime: admin.firestore.FieldValue.delete(),
            reschedulePendingEndTime: admin.firestore.FieldValue.delete(),
            reschedulePendingAt: admin.firestore.FieldValue.delete(),
            rescheduledBy: admin.firestore.FieldValue.delete(),
            rescheduleHistory: admin.firestore.FieldValue.arrayUnion({
              from: { date: shift.date, startTime: shift.startTime, endTime: shift.endTime ?? null },
              to:   { date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime ?? null },
              proposedBy: shift.rescheduledBy,
              proposedAt: shift.reschedulePendingAt ?? null,
              acceptedBy: "caregiver",
              acceptedAt: nowIso,
            }),
          });
          logAudit({ eventType: "shift_reschedule_accepted", userId: caregiverId as string, data: { source: "mcp:manage_shift_reschedule", shiftId } }).catch(() => {});
          return { success: true, action, shiftId, date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime };
        }

        if (action === "decline") {
          if (!shift.reschedulePendingDate) return toolError("INVALID_INPUT", "There's no pending reschedule proposal on this visit");
          await shiftSnap.ref.update({
            reschedulePendingDate: admin.firestore.FieldValue.delete(),
            reschedulePendingStartTime: admin.firestore.FieldValue.delete(),
            reschedulePendingEndTime: admin.firestore.FieldValue.delete(),
            reschedulePendingAt: admin.firestore.FieldValue.delete(),
            rescheduledBy: admin.firestore.FieldValue.delete(),
          });
          logAudit({ eventType: "shift_reschedule_cleared", userId: caregiverId as string, data: { source: "mcp:manage_shift_reschedule", shiftId } }).catch(() => {});
          return { success: true, action, shiftId };
        }

        return toolError("INVALID_INPUT", `Unknown action: ${action}`);
      }

      case "send_caregiver_message": {
        const { caregiverId, message, clientId } = input;
        if (!caregiverId || !message) return toolError("INVALID_INPUT", "caregiverId and message are required");
        const gateError = await checkClientAccessGate(clientId as string | undefined, "message", { phone: (input as Record<string, unknown>).phone });
        if (gateError) return gateError;
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        // Mirrors BrowseCaregivers.tsx: a hidden profile is never surfaced to
        // browse/message on the website, so Evia shouldn't relay to one either.
        if (cgSnap.data()?.profileVisibility === "hidden") {
          return toolError("NOT_FOUND", "Caregiver not found");
        }
        const caregiverName = (cgSnap.data()?.name as string | undefined) ?? "";
        // The Inbox composer (InboxView.tsx handleSend → chatService.sendMessage):
        // one message doc + the room update, nothing else. The caregiver is
        // notified by the SAME trigger a website-typed message fires
        // (onMessageSent: in-app bell + the message texted to them) — this tool
        // no longer sends its own SMS (2026-09-17, Inbox parity).
        const clientSnap = await db.collection("users").doc(clientId as string).get();
        const clientName = (clientSnap.data()?.name as string | undefined)
          ?? (clientSnap.data()?.firstName as string | undefined) ?? "";
        const { relayIntoSharedChatThread } = await import("../utils/chatThread");
        await relayIntoSharedChatThread({
          clientId: clientId as string, clientName,
          caregiverId: caregiverId as string, caregiverName,
          senderId: clientId as string, senderName: clientName,
          text: message as string,
        });
        logAudit({ eventType: "health_data_accessed", userId: clientId as string, data: { source: "mcp:send_caregiver_message", caregiverId } }).catch(() => {});
        return {
          success: true, sent: true, caregiverName,
          notification: { sent: true, via: "inbox" },
          instruction: "The message is in the shared Inbox thread and the caregiver is being notified exactly like a website message. Tell the family it's sent — nothing else.",
        };
      }

      case "request_location": {
        const { phone, chatId, reason } = input;
        if (!phone || !chatId) return toolError("INVALID_INPUT", "phone and chatId are required");
        const sessionSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const session = sessionSnap.data();
        const { canRequestNativeLocation } = await import("../utils/locationShare");
        const typedAskFallback = {
          success: true,
          nativePromptSent: false,
          fallback: "ask_typed_city_zip",
          message: "Native location prompt unavailable on this chat — ask the user to type their city and zip code.",
        };
        // Gate: 1:1 iMessage only. SMS/RCS/group → fall back to a typed ask.
        if (!canRequestNativeLocation(session as { service?: string; groupChatId?: string })) {
          return typedAskFallback;
        }
        const { requestLocation } = await import("../linq/client");
        const result = await requestLocation(chatId as string);
        // Stale-iMessage or any non-2xx (e.g. 409) → same typed-ask fallback.
        if (!result.requested) return typedAskFallback;
        // Persist the pending request so the scheduled nudge job (and onboarding)
        // can fall back to a typed ask if no pin arrives. TTL bounds the wait.
        await db.collection("agent_sessions").doc(phone as string).set({
          pendingLocationRequest: {
            source:    "mcp",
            reason:    (reason as string) ?? "",
            sentAt:    new Date().toISOString(),
            nudgeSent: false,
          },
          stateExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }, { merge: true });
        return {
          success: true,
          nativePromptSent: true,
          message: "Sent the native location prompt. The user's shared location will arrive as a separate message.",
        };
      }

      case "react_to_message": {
        const { phone, type, customEmoji } = input;
        if (!phone || !type) return toolError("INVALID_INPUT", "phone and type are required");
        const VALID_REACTIONS = new Set(["love", "like", "dislike", "laugh", "emphasize", "question", "custom"]);
        if (!VALID_REACTIONS.has(type as string)) {
          return toolError("INVALID_INPUT", `type must be one of: ${[...VALID_REACTIONS].join(", ")}`);
        }
        if (type === "custom" && !customEmoji) {
          return toolError("INVALID_INPUT", "customEmoji is required when type is 'custom'");
        }
        const sessionSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const session = sessionSnap.data() as
          | { service?: string; chatId?: string; lastInboundMessageId?: string }
          | undefined;
        const textFallback = (why: string) => ({
          success:  true,
          reacted:  false,
          fallback: "express_in_text",
          message:  `${why} — express the sentiment briefly in your text reply instead.`,
        });
        // Reactions are an iMessage feature; SMS/RCS can't render a tapback.
        if (session?.service !== "iMessage") {
          return textFallback("Reactions aren't supported on this chat (iMessage only)");
        }
        const targetMessageId = session?.lastInboundMessageId;
        if (!targetMessageId) {
          return textFallback("No recent message on file to react to");
        }
        const { addReaction } = await import("../linq/client");
        try {
          await addReaction({
            messageId:   targetMessageId,
            type:        type as import("../linq/client").LinqReactionType,
            customEmoji: customEmoji as string | undefined,
          });
        } catch (err) {
          // A reaction is a nicety — soft-fall back to text rather than surfacing
          // a tool error that would trip the recovery loop.
          console.warn("react_to_message: addReaction failed", {
            phone, targetMessageId, err: err instanceof Error ? err.message : String(err),
          });
          return textFallback("Couldn't add the reaction");
        }
        await db.collection("agent_reactions").add({
          chatId:    session?.chatId ?? null,
          messageId: targetMessageId,
          reaction:  type === "custom" ? (customEmoji as string) : (type as string),
          phone,
          direction: "outbound",
          operation: "added",
          reactedAt: new Date().toISOString(),
        }).catch(() => {/* audit only */});
        return {
          success: true,
          reacted: true,
          message: "Reaction added to the user's message. Only send a text reply if one is genuinely needed — the reaction may be the whole answer.",
        };
      }

      case "set_visit_update_frequency": {
        const { phone, frequencyMinutes, mode } = input;
        if (!phone) return toolError("INVALID_INPUT", "phone is required");
        if (mode === undefined && frequencyMinutes === undefined) {
          return toolError("INVALID_INPUT", "Provide frequencyMinutes (30–480) or mode ('default' | 'off')");
        }

        const sessionRef = db.collection("agent_sessions").doc(phone as string);
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists) return toolError("NOT_FOUND", "No session found for this phone");

        if (mode === "off") {
          await sessionRef.update({
            inShiftUpdatesPaused:  true,
            inShiftUpdateCadence:  admin.firestore.FieldValue.delete(),
          });
          return {
            success: true,
            setting: "off",
            message: "Mid-visit updates are off. Arrival notices and the end-of-visit summary still send. They can turn updates back on anytime.",
          };
        }
        if (mode === "default") {
          await sessionRef.update({
            inShiftUpdatesPaused: admin.firestore.FieldValue.delete(),
            inShiftUpdateCadence: admin.firestore.FieldValue.delete(),
          });
          return {
            success: true,
            setting: "default",
            message: "Mid-visit updates reset to the standard cadence — roughly every 2 hours during a visit.",
          };
        }

        const minutes = Number(frequencyMinutes);
        if (!Number.isFinite(minutes) || minutes < 30 || minutes > 480) {
          return toolError("INVALID_INPUT", "frequencyMinutes must be between 30 and 480");
        }
        await sessionRef.update({
          inShiftUpdatesPaused: admin.firestore.FieldValue.delete(),
          inShiftUpdateCadence: Math.round(minutes),
        });
        return {
          success: true,
          setting: `${Math.round(minutes)}m`,
          message: `Mid-visit updates will now come about every ${Math.round(minutes)} minutes during a visit.`,
        };
      }

      case "get_active_bookings": {
        if (!input.clientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.clientId as string, data: { source: "mcp:get_active_bookings" } }).catch(() => {});
        const bookings = await listActiveBookings(input.clientId as string);
        if (bookings.length === 0) return { success: true, bookings: [], total: 0, message: "No active bookings — the Active Bookings tab is empty" };
        return { success: true, bookings, total: bookings.length };
      }

      case "get_family_group": {
        if (!input.phone) return toolError("INVALID_INPUT", "phone is required");
        const snap = await db.collection("family_group_members")
          .where("primaryPhone", "==", input.phone)
          .get();
        return { success: true, members: snap.docs.map(d => d.data()), count: snap.size };
      }

      case "schedule_followup": {
        const { phone, userId, message: followUpMsg, scheduledAt, reason } = input;
        if (!phone || !userId || !followUpMsg || !scheduledAt) {
          return toolError("INVALID_INPUT", "phone, userId, message, and scheduledAt are required");
        }
        // Validate scheduledAt is in the future
        if (new Date(scheduledAt as string) <= new Date()) {
          return toolError("INVALID_INPUT", "scheduledAt must be in the future");
        }
        const { scheduleTrigger } = await import("../triggers/triggerEngine");
        const triggerId = await scheduleTrigger({
          userId:      userId      as string,
          phone:       phone       as string,
          type:        "custom",
          message:     followUpMsg as string,
          scheduledAt: scheduledAt as string,
          source:      "claude",
          intent:      reason      as string | undefined,
        } as any);
        if (!triggerId) {
          return { success: false, reason: "skipped_calibration_period" };
        }
        return { success: true, triggerId, scheduledAt };
      }

      case "get_caregiver_appointments": {
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        const daysAhead   = Math.min((input.daysAhead as number) ?? 7, 30);
        // Business-timezone window — UTC "today" dropped tonight's shift in PT evenings
        const today       = businessTodayStr();
        const futureLimitD = new Date(`${today}T12:00:00Z`);
        futureLimitD.setUTCDate(futureLimitD.getUTCDate() + daysAhead);
        const futureLimit = futureLimitD.toISOString().slice(0, 10);
        const snap = await db.collection("appointments")
          .where("caregiverId", "==", input.caregiverId)
          .where("date",        ">=", today)
          .where("date",        "<=", futureLimit)
          .where("status",      "in", ["confirmed", "pending_caregiver_confirmation"])
          .orderBy("date", "asc")
          .limit(11)
          .get();
        const docs = snap.docs.slice(0, 10).map(d => d.data());
        return { success: true, results: docs, hasMore: snap.docs.length > 10 };
      }

      case "get_pending_tasks": {
        // The site has no "tasks" list — what a family sees waiting on them is
        // spread across My Bookings (the Requests tab; the Review / Find
        // Replacement / Skip buttons), Care Requests > Interviews (Accept new
        // time), Care Plan (the review banner) and Payments (timesheets to
        // review). This is exactly that set, read from the same collections with
        // the same conditions — never an Evia-only queue. (It used to read
        // agent_tasks, the retired booking/replacement pipeline: live-caught
        // 2026-09-17 surfacing a "replacement choice" the site never showed.)
        const ptClientId = input.clientId as string | undefined;
        if (!ptClientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: ptClientId, data: { source: "mcp:get_pending_tasks" } }).catch(() => {});
        const [ptBrSnap, ptAmSnap, ptShiftSnap, ptIvRows, ptCpSnap, ptTsSnap, ptCounterSnap] = await Promise.all([
          db.collection("booking_requests").where("clientId", "==", ptClientId).where("status", "==", "pending").get(),
          db.collection("booking_amendments").where("clientId", "==", ptClientId).where("status", "==", "pending").get(),
          db.collection("shifts").where("clientId", "==", ptClientId).where("status", "in", ["scheduled", "needs_replacement"]).get(),
          listClientInterviews(ptClientId).catch(() => [] as Awaited<ReturnType<typeof listClientInterviews>>),
          db.collection("carePlans").doc(ptClientId).get(),
          db.collection("shiftHours").where("clientId", "==", ptClientId).where("status", "==", "pending_client_review").get(),
          // The page's banner counts a caregiver COUNTER awaiting the family too.
          db.collection("shiftHours").where("clientId", "==", ptClientId).where("status", "==", "caregiver_counter_proposed").get(),
        ]);
        const ptItems: Array<Record<string, unknown>> = [];
        ptBrSnap.docs.forEach((d) => {
          const r = d.data();
          ptItems.push({ kind: "booking_request_pending", waitingOn: "caregiver", page: "My Bookings > Requests", bookingRequestId: d.id, caregiverName: r.caregiverName ?? null, isResend: r.isResend === true, createdAt: r.createdAt ?? null });
        });
        ptAmSnap.docs.forEach((d) => {
          const a = d.data();
          ptItems.push({ kind: "visit_request_pending", waitingOn: "caregiver", page: "My Bookings > Requests", amendmentId: d.id, bookingRequestId: a.bookingRequestId ?? null, caregiverName: a.caregiverName ?? null, startDate: a.startDate ?? null, createdAt: a.createdAt ?? null });
        });
        ptShiftSnap.docs.forEach((d) => {
          const sh = d.data();
          const base = { shiftId: d.id, date: sh.date ?? null, dayOfWeek: weekdayForDate(String(sh.date ?? "")), startTime: sh.startTime ?? null, endTime: sh.endTime ?? null, caregiverName: sh.caregiverName ?? null };
          if (sh.status === "needs_replacement") {
            // ClientVisitsPage: Find Replacement always; Skip only while no replacement request is out.
            ptItems.push({ kind: "visit_needs_replacement", waitingOn: "you", page: "My Bookings > Active Bookings", actions: sh.replacementRequestId ? ["find_replacement"] : ["find_replacement", "skip"], replacementRequestId: sh.replacementRequestId ?? null, ...base });
          } else if (sh.reschedulePendingDate && sh.rescheduledBy) {
            // ClientVisitsPage: a caregiver proposal shows Review (accept/decline); the family's own proposal waits on the caregiver.
            ptItems.push({ kind: "visit_reschedule_proposal", waitingOn: sh.rescheduledBy === "caregiver" ? "you" : "caregiver", page: "My Bookings > Active Bookings", proposedDate: sh.reschedulePendingDate, proposedDayOfWeek: weekdayForDate(String(sh.reschedulePendingDate)), proposedStartTime: sh.reschedulePendingStartTime ?? null, proposedEndTime: sh.reschedulePendingEndTime ?? null, ...base });
          }
        });
        ptIvRows.forEach((iv) => {
          if (iv.rescheduleWaitingOn) ptItems.push({ kind: "interview_reschedule_proposal", waitingOn: iv.rescheduleWaitingOn, page: "Care Requests > Interviews", interviewId: iv.interviewId, caregiverName: iv.caregiverName, proposedTimeLocal: iv.reschedulePendingTimeLocal, actions: iv.actions });
          else if (iv.displayStatus === "pending") ptItems.push({ kind: "interview_request_pending", waitingOn: "caregiver", page: "Care Requests > Interviews", interviewId: iv.interviewId, caregiverName: iv.caregiverName, scheduledTimeLocal: iv.scheduledTimeLocal });
        });
        if (ptCpSnap.exists && !ptCpSnap.data()?.carePlanReviewedAt) ptItems.push({ kind: "care_plan_review", waitingOn: "you", page: "Care Plan", actions: ["looks_good"] });
        {
          // Same rule as the page's "N shifts to review" banner: submissions awaiting
          // the family's review + counters awaiting their answer. A correction the
          // caregiver is sitting on (Correction Sent) is NOT counted — nothing to do.
          const tsDocs = new Map<string, Record<string, unknown>>();
          for (const d of [...ptTsSnap.docs, ...ptCounterSnap.docs]) tsDocs.set(d.id, d.data());
          const awaitingReview = [...tsDocs.values()].filter((r) => r.status === "pending_client_review").length;
          const countersToAnswer = [...tsDocs.values()].filter((r) => r.status === "caregiver_counter_proposed").length;
          if (tsDocs.size) ptItems.push({ kind: "timesheets_to_review", waitingOn: "you", page: "Payments > Timesheets", count: tsDocs.size, awaitingReview, countersToAnswer });
        }
        const waitingOnYou = ptItems.filter((i) => i.waitingOn === "you").length;
        return {
          success: true,
          total: ptItems.length,
          waitingOnYou,
          items: ptItems,
          summary: ptItems.length === 0 ? "Nothing pending" : `${waitingOnYou} item(s) waiting on the family, ${ptItems.length - waitingOnYou} waiting on a caregiver`,
        };
      }

      default:
        break;
    }

    if (name === "suggest_upcoming_care") {
      const { clientId } = input as { clientId: string; phone?: string };
      const nextWeekStart = new Date();
      nextWeekStart.setDate(nextWeekStart.getDate() + 1);
      const nextWeekEnd = new Date();
      nextWeekEnd.setDate(nextWeekEnd.getDate() + 8);
      const startStr = nextWeekStart.toISOString().slice(0, 10);
      const endStr   = nextWeekEnd.toISOString().slice(0, 10);

      const apptSnap = await db.collection("appointments")
        .where("clientId", "==", clientId)
        .where("status",   "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date",     ">=", startStr)
        .where("date",     "<=", endStr)
        .limit(1)
        .get();

      const hasVisitNextWeek = !apptSnap.empty;

      // Check preferred caregiver availability (most recently booked)
      const recentAppt = await db.collection("appointments")
        .where("clientId", "==", clientId)
        .where("status",   "==", "completed")
        .orderBy("date",   "desc")
        .limit(1)
        .get();

      let preferredCaregiverAvailable = false;
      let caregiverName = "";
      let suggestedDate = startStr;

      if (!recentAppt.empty) {
        const lastAppt = recentAppt.docs[0].data();
        caregiverName  = lastAppt.caregiverName ?? "";
        const cgId     = lastAppt.caregiverId ?? "";
        if (cgId) {
          const cgSnap = await db.collection("caregivers").doc(cgId).get();
          const cgData = cgSnap.data();
          if (cgData && cgData.isAvailable !== false && cgData.status === "approved") {
            preferredCaregiverAvailable = true;
          }
        }
      }

      return { hasVisitNextWeek, preferredCaregiverAvailable, caregiverName, suggestedDate };
    }

    if (name === "get_care_plan") {
      const { clientId } = input as { clientId: string };
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      // The Care Plan page as one read (agents/carePlanPage.ts).
      const page = await readCarePlanPage(clientId);
      if (page.recipients.length === 0 && page.emergencyContacts.length === 0 && !page.setupContact) {
        return { success: true, carePlan: null, ...page, message: "No care plan on file yet — the Care Plan page is empty." };
      }
      // carePlan (raw recipientPlans + the contacts the page shows) kept for older callers.
      const carePlan: Record<string, unknown> = {
        recipientPlans: Object.fromEntries(page.recipients.map((r) => [r.key, r.plan])),
        locationPool: page.locationPool,
        emergencyContacts: page.emergencyContacts,
        carePlanReviewedAt: page.reviewed,
      };
      return { success: true, carePlan, ...page };
    }

    if (name === "update_care_plan") {
      const { clientId, field, value, action, recipientFirstName } = input as {
        clientId: string; field: string; value: unknown; action: "set" | "append" | "remove"; recipientFirstName?: string;
      };
      const ALLOWED_FIELDS = ["careNeeds", "careNeedDetails", "notes", "lifestyle", "careLocation", "emergencyContacts", "reviewed"];
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      if (!ALLOWED_FIELDS.includes(field)) {
        return { success: false, error: `Field '${field}' is not on the Care Plan page. Sections: ${ALLOWED_FIELDS.join(", ")}` };
      }

      // "Looks good" — carePlanReviewedAt (+ the page's one-time wizard-contact migration).
      if (field === "reviewed") {
        const r = await confirmCarePlanReviewed(clientId);
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field } }).catch(() => {});
        return { success: true, updated: field, action: "set", ...r };
      }

      // Emergency Contacts card — care_plans/{uid}.emergencyContacts via the page's own service write.
      if (field === "emergencyContacts") {
        const page = await readCarePlanPage(clientId);
        const digits = (p: unknown) => String(p ?? "").replace(/\D/g, "");
        const norm = (c: Record<string, unknown>) => ({
          id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
          name: String(c.name ?? "").trim(), relation: String(c.relation ?? c.relationship ?? "").trim(),
          phone: String(c.phone ?? "").replace(/[^\d+\-() ]/g, "").slice(0, 16), isPrimary: c.isPrimary === true,
        });
        let next = [...page.emergencyContacts];
        if (action === "append") {
          const c = norm((value ?? {}) as Record<string, unknown>);
          if (!c.name) return toolError("INVALID_INPUT", "The contact needs a name");
          if (digits(c.phone).length < 10) return toolError("INVALID_INPUT", "Phone number must be at least 10 digits");
          if (next.length + (page.setupContact ? 1 : 0) >= 2) return toolError("INVALID_INPUT", "The Emergency Contacts card holds at most 2 contacts (including the signup contact) — remove or edit one instead");
          next.push(c);
        } else if (action === "remove") {
          const v = (value ?? {}) as Record<string, unknown>;
          const before = next.length;
          next = next.filter((c) => !(v.id && c.id === v.id) && !(!v.id && v.name && c.name.toLowerCase() === String(v.name).toLowerCase()));
          if (next.length === before) return toolError("NOT_FOUND", "No emergency contact matched — get_care_plan lists them");
        } else {
          if (!Array.isArray(value)) return toolError("INVALID_INPUT", "emergencyContacts set needs an array of contacts");
          next = (value as Array<Record<string, unknown>>).map(norm);
          if (next.some((c) => !c.name)) return toolError("INVALID_INPUT", "Every contact needs a name");
          if (next.some((c) => c.phone && digits(c.phone).length < 10)) return toolError("INVALID_INPUT", "Phone number must be at least 10 digits");
        }
        await saveEmergencyContacts(clientId, next);
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, action } }).catch(() => {});
        return { success: true, updated: field, action, emergencyContacts: next };
      }

      // Everything else is a section of ONE recipient's plan (the page's saveSection).
      const res = await resolveRecipient(clientId, recipientFirstName);
      if (!res.ok) {
        return {
          success: false,
          error: res.reason === "ambiguous"
            ? "This household has more than one care recipient — say which one (recipientFirstName) before I update this."
            : res.reason === "not_found"
              ? `I don't see a care recipient named "${recipientFirstName}" on the Care Plan page.`
              : "I don't have a care recipient on file yet to attach this to.",
        };
      }
      const { recipient, page } = res;
      const plan = recipient.plan;

      if (field === "careNeeds") {
        const pills = (Array.isArray(value) ? value : [value]).map((v) => toCareType(String(v)));
        if (pills.some((p) => !p)) return toolError("INVALID_INPUT", `Care needs must be from the page's list: ${Object.keys(CARE_NEED_SUBS).join(", ")}`);
        let careNeeds: string[];
        if (action === "append") careNeeds = Array.from(new Set([...plan.careNeeds, ...(pills as string[])]));
        else if (action === "remove") careNeeds = plan.careNeeds.filter((n) => !(pills as string[]).includes(n));
        else careNeeds = Array.from(new Set(pills as string[]));
        // Dropping a need drops its sub-tasks, exactly like the page's toggle.
        const careNeedDetails = Object.fromEntries(Object.entries(plan.careNeedDetails ?? {}).filter(([need]) => careNeeds.includes(need)));
        const updated = await savePlanSection(clientId, recipient, { careNeeds, careNeedDetails });
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, action, recipient: recipient.key } }).catch(() => {});
        return { success: true, updated: field, action, recipient: recipient.name, careNeeds: updated.careNeeds, careNeedDetails: updated.careNeedDetails };
      }

      if (field === "careNeedDetails") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return toolError("INVALID_INPUT", "careNeedDetails needs { \"<need>\": [sub-tasks] }");
        const details: Record<string, string[]> = { ...(plan.careNeedDetails ?? {}) };
        for (const [rawNeed, rawSubs] of Object.entries(value as Record<string, unknown>)) {
          const need = toCareType(rawNeed);
          if (!need) return toolError("INVALID_INPUT", `"${rawNeed}" isn't one of the page's care needs`);
          if (!plan.careNeeds.includes(need)) return toolError("INVALID_INPUT", `${need} isn't selected for ${recipient.name} — add it to careNeeds first (the page only shows sub-tasks under a selected need)`);
          const allowed = CARE_NEED_SUBS[need] ?? [];
          const subs = (Array.isArray(rawSubs) ? rawSubs : [rawSubs]).map(String);
          const bad = subs.find((x) => !allowed.includes(x));
          if (bad) return toolError("INVALID_INPUT", `"${bad}" isn't a sub-task the page offers under ${need}: ${allowed.join(", ")}`);
          const cur = details[need] ?? [];
          details[need] = action === "append" ? Array.from(new Set([...cur, ...subs])) : action === "remove" ? cur.filter((x) => !subs.includes(x)) : subs;
        }
        const updated = await savePlanSection(clientId, recipient, { careNeedDetails: details });
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, action, recipient: recipient.key } }).catch(() => {});
        return { success: true, updated: field, action, recipient: recipient.name, careNeedDetails: updated.careNeedDetails };
      }

      if (field === "notes") {
        const updated = await savePlanSection(clientId, recipient, { notes: String(value ?? "").trim() });
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, recipient: recipient.key } }).catch(() => {});
        return { success: true, updated: field, action: "set", recipient: recipient.name, notes: updated.notes };
      }

      if (field === "lifestyle") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return toolError("INVALID_INPUT", "lifestyle requires an object of the fields to change");
        const updated = await savePlanSection(clientId, recipient, { lifestyle: { ...plan.lifestyle, ...(value as Record<string, unknown>) } as typeof plan.lifestyle });
        logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, recipient: recipient.key } }).catch(() => {});
        return { success: true, updated: field, action: "set", recipient: recipient.name, lifestyle: updated.lifestyle };
      }

      // careLocation
      const loc = value as { street?: string; city?: string; state?: string; zipCode?: string } | undefined;
      if (!loc?.street?.trim()) return toolError("INVALID_INPUT", "careLocation needs a street address (the page requires one)");
      const placed = await setRecipientLocation(clientId, recipient, page, loc);
      logAudit({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_care_plan", field, recipient: recipient.key } }).catch(() => {});
      return { success: true, updated: field, action: "set", recipient: recipient.name, location: placed.location, addedToPool: placed.addedToPool };
    }

    // ── New write tools ────────────────────────────────────────────────────────

    if (name === "update_caregiver_profile") {
      const { caregiverId, hourlyRate, bio, phone: actingPhone, requestPhoneChange, city, weeklyAvailability } = input as Record<string, unknown>;
      if (!caregiverId || !actingPhone) return toolError("INVALID_INPUT", "caregiverId and phone are required");
      const caregiverRef = db.collection("caregivers").doc(caregiverId as string);
      const caregiverSnap = await caregiverRef.get();
      if (!caregiverSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      // 2026-09-13 live incident: this used to read caregivers/{uid}.phone
      // directly, a field that never exists under the unified identity model
      // (real phone lives on users/{uid}.phone) — ownerPhone was always
      // undefined, so this check rejected EVERY caregiver unconditionally.
      const ownerPhone = await resolveCaregiverPhone(caregiverId as string);
      if (!ownerPhone || ownerPhone !== actingPhone) {
        return toolError("PERMISSION_DENIED", "You can only update your own caregiver profile");
      }
      if (requestPhoneChange === true) {
        const d = caregiverSnap.data() ?? {};
        const authEmail = await (async () => { try { return (await admin.auth().getUser(caregiverId as string))?.email?.trim(); } catch { return undefined; } })();
        const email = (d.email as string | undefined)?.trim() || authEmail;
        if (!email) {
          return {
            success: false,
            noEmailOnFile: true,
            guidance: "This account has no email on file, so there's no way to send a verification link. Ask them to set a recovery email first, then try again.",
          };
        }
        {
          // An unconfirmed recovery email proves nothing, so it is never used to
          // verify a phone change (the site's page says the same and offers Resend).
          const { isEmailVerified } = await import("../accountRecovery");
          if (!isEmailVerified(d)) {
            return {
              success: false,
              emailUnverified: true,
              guidance: "Their recovery email hasn't been confirmed yet, so it can't be used to verify a phone change. Offer to resend the confirmation link (request_email_change with resend:true); once they tap it, the phone change can go ahead.",
            };
          }
        }
        const name = ((d.firstName || d.name || "there") as string).split(" ")[0];
        const { requestPhoneChangeForAccount } = await import("../accountRecovery");
        await requestPhoneChangeForAccount({ uid: caregiverId as string, role: "caregiver", name }, email);
        logAudit({ eventType: "profile_updated", userId: caregiverId as string, data: { source: "mcp:update_caregiver_profile:phone" } }).catch(() => {});
        return { success: true, sentTo: email };
      }
      if (bio && typeof bio === "string" && bio.length > 2500) return toolError("INVALID_INPUT", "bio must be 2500 characters or fewer");
      if (hourlyRate != null) {
        const rate = Number(hourlyRate);
        if (!Number.isFinite(rate) || rate < 15 || rate > 150) {
          return toolError("INVALID_INPUT", "hourlyRate must be between 15 and 150");
        }
      }
      const patch: Record<string, unknown> = { updatedAt: nowIso };
      if (hourlyRate         != null) patch.hourlyRate         = Number(hourlyRate);
      if (bio                != null) patch.bio                = bio;
      if (city               != null) patch.city               = city;
      if (weeklyAvailability != null) patch.weeklyAvailability = weeklyAvailability;
      if (Object.keys(patch).length === 1) return toolError("INVALID_INPUT", "At least one field to update is required");
      await caregiverRef.set(patch, { merge: true });
      logAudit({ eventType: "profile_updated", userId: caregiverId as string, data: { source: "mcp:update_caregiver_profile", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => {});
      return { success: true, updated: Object.keys(patch).filter(k => k !== "updatedAt") };
    }

    if (name === "pause_account") {
      const { caregiverId, until, phone: actingPhone } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      if (!until || typeof until !== "string") return toolError("INVALID_INPUT", "until is required ('YYYY-MM-DD' or 'indefinite')");
      const snap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!snap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      // Ownership: the acting phone must own this caregiver doc. Fail CLOSED unless
      // BOTH phones exist and match — a missing/empty ownerPhone must not bypass the
      // check, and we do NOT trust a model-supplied caregiverId alone.
      // 2026-09-13 live incident: this used to read caregivers/{uid}.phone
      // directly, which never exists under the unified identity model — that
      // made ownerPhone always undefined, unconditionally rejecting every
      // caregiver regardless of who was asking.
      const ownerPhone = await resolveCaregiverPhone(caregiverId as string);
      if (!actingPhone || !ownerPhone || ownerPhone !== actingPhone) {
        return toolError("PERMISSION_DENIED", "You can only pause your own account");
      }
      await pauseCaregiver(caregiverId as string, until);
      logAudit({ eventType: "profile_updated", userId: caregiverId as string, data: { source: "mcp:pause_account", until } }).catch(() => {});
      return { success: true, paused: true, until };
    }

    if (name === "reactivate_account") {
      const { caregiverId, phone: actingPhone } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const snap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!snap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      // Fail CLOSED unless BOTH phones exist and match (see pause_account above).
      // 2026-09-13: reads via resolveCaregiverPhone, not caregivers/{uid}.phone
      // directly — see pause_account's comment for why the old read always failed.
      const ownerPhone = await resolveCaregiverPhone(caregiverId as string);
      if (!actingPhone || !ownerPhone || ownerPhone !== actingPhone) {
        return toolError("PERMISSION_DENIED", "You can only reactivate your own account");
      }
      await reactivateCaregiver(caregiverId as string);
      logAudit({ eventType: "profile_updated", userId: caregiverId as string, data: { source: "mcp:reactivate_account" } }).catch(() => {});
      return { success: true, reactivated: true };
    }

    if (name === "accept_shift" || name === "decline_shift") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { phone: actingPhone, chatId } = input as Record<string, unknown>;
      if (!actingPhone || !chatId) return toolError("INVALID_INPUT", "phone and chatId are required (auto-injected)");
      const { acceptCaregiverShiftOffer, declineCaregiverShiftOffer } = await import("../agents/shiftOffer");
      const res = name === "accept_shift"
        ? await acceptCaregiverShiftOffer(actingPhone as string, chatId as string)
        : await declineCaregiverShiftOffer(actingPhone as string, chatId as string);
      // _toolError so the loop's high-stakes is_error guard fires (these are
      // HIGH_STAKES_MUTATIONS — a plain success:false skips that hardening).
      if (res.status === "no_pending_offer") return { _toolError: true, success: false, reason: "no_pending_offer", message: "There's no pending shift offer to act on right now." };
      if (res.status === "not_pending" || res.status === "already_closed") return { _toolError: true, success: false, reason: res.status, message: "That offer is no longer open." };
      return { success: true, resolution: res.status };
      });
    }

    if (name === "add_family_member") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { seniorId, name: memberName, memberPhone, clientId } = input as Record<string, unknown>;
      if (!seniorId || !memberName || !memberPhone || !clientId) return toolError("INVALID_INPUT", "seniorId, name, memberPhone, and clientId are required");
      const seniorSnap = await db.collection("senior_profiles").doc(seniorId as string).get();
      if (!seniorSnap.exists) return toolError("NOT_FOUND", "Senior profile not found");
      const seniorData = seniorSnap.data()!;
      if (seniorData.userId && seniorData.userId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized to modify this senior's profile");
      const existing: Array<{ phone: string }> = seniorData.familyMembers ?? [];
      if (existing.some(m => m.phone === memberPhone)) return toolError("INVALID_INPUT", "This phone number is already a family member");
      await seniorSnap.ref.update({ familyMembers: admin.firestore.FieldValue.arrayUnion({ name: memberName, phone: memberPhone, addedAt: nowIso, addedBy: clientId }) });

      // Also register the member in the SAME records the inbound new-user router reads,
      // so when this member first texts in they're recognized as a secondary member
      // instead of creating a DUPLICATE account. The router checks both the primary
      // session's `groupMembers` array and the `family_group_members` collection.
      // Resolve the primary's phone by clientId lookup (authoritative). The
      // member being added is `memberPhone`; the acting user's `phone` is
      // auto-injected separately and is intentionally not used for the member.
      let primaryPhone: string | undefined;
      let memberDocId: string | undefined;
      {
        const primarySnap = await db.collection("agent_sessions")
          .where("userId", "==", clientId as string).limit(1).get();
        if (!primarySnap.empty) primaryPhone = primarySnap.docs[0].id;
        if (primaryPhone === memberPhone) primaryPhone = undefined; // never self-link
        if (primaryPhone) {
          await db.collection("agent_sessions").doc(primaryPhone).update({
            groupMembers: admin.firestore.FieldValue.arrayUnion(memberPhone),
          }).catch(() => {});
          const { familyMemberDocId } = await import("../agents/familyGroupManager");
          memberDocId = familyMemberDocId(primaryPhone, memberPhone as string);
          const memberRef = db.collection("family_group_members").doc(memberDocId);
          const memberSnap = await memberRef.get().catch(() => null);
          if (!memberSnap?.exists) {
            // Do NOT swallow silently: a failed index write means the inbound
            // router won't recognize this member and may spawn a duplicate
            // account, so surface it loudly for admin follow-up. Kept non-fatal
            // because senior_profiles.familyMembers (written above) is the
            // source of truth buildOrUpdateFamilyGroup reads, and the dup-guard
            // earlier in this handler would block a clean retry of the add.
            await memberRef.set({
              primaryPhone,
              memberPhone,
              memberName:  memberName ?? "Family member",
              userId:      clientId,
              seniorId,
              seniorName:  seniorData.name ?? seniorData.seniorName ?? null,
              addedAt:     nowIso,
              joinedAt:    null,
              source:      "mcp:add_family_member",
            }).catch((err) => {
              // Log only non-PII correlation IDs — phone numbers (and memberDocId,
              // which is derived from them) are PII and must not hit logs.
              console.error("add_family_member: family_group_members index write failed", { seniorId, clientId, error: err instanceof Error ? err.message : String(err) });
            });
          }
        }
      }

      const { buildOrUpdateFamilyGroup } = await import("../agents/familyGroupManager");
      let groupSync: { success: boolean; errorReason?: string } = { success: true };
      await buildOrUpdateFamilyGroup(seniorId as string).catch(async (err) => {
        const errorReason = err instanceof Error ? err.message : String(err);
        groupSync = { success: false, errorReason };
        const { logAgentAction } = await import("../observability/actionLedger");
        await logAgentAction({
          actionType: "family_group_sync",
          status: "failed",
          userId: clientId as string,
          role: "client",
          toolName: "add_family_member",
          targetCollection: "family_groups",
          targetDocId: seniorId as string,
          errorReason,
          metadata: {
            seniorId,
            memberName,
            memberPhone,
            source: "mcp:add_family_member",
            recipeId: "share_latest_update",
          },
        }).catch(() => {});
        await db.collection("admin_alerts").add({
          type: "family_group_sync_failed",
          severity: "high",
          priority: "high",
          resolved: false,
          clientId,
          seniorId,
          memberPhone,
          recipeId: "share_latest_update",
          sourceAgent: "mcp:add_family_member",
          errorReason,
          createdAt: nowIso,
        }).catch(() => {});
      });
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(
        memberPhone as string,
        `Hi - you've been added to ${seniorData.name ?? seniorData.seniorName ?? "your loved one's"} Evia care group. I'm Evia, and I'll send care updates here. You can text me questions anytime. Reply STOP to opt out.`,
        "mcp:add_family_member",
      );
      const { logAgentAction } = await import("../observability/actionLedger");
      logAudit({ eventType: "family_member_added", userId: clientId as string, data: { source: "mcp:add_family_member", seniorId, newMemberPhone: memberPhone, notificationSent: notification.sent } }).catch(() => {});
      logAudit({
        eventType: notification.sent ? "family_member_welcome_sent" : "family_member_welcome_failed",
        userId: clientId as string,
        data: { source: "mcp:add_family_member", seniorId, newMemberPhone: memberPhone, notification },
      }).catch(() => {});
      logAgentAction({
        actionType: "family_member_add",
        status: notification.sent ? "executed" : "failed",
        userId: clientId as string,
        role: "client",
        toolName: "add_family_member",
        targetCollection: "family_group_members",
        targetDocId: memberDocId ?? (typeof memberPhone === "string" ? String(memberPhone) : undefined),
        errorReason: notification.sent ? undefined : notification.reason,
        metadata: { seniorId, memberName, memberPhone, source: "mcp:add_family_member" },
      }).catch(() => {});
      return { success: true, added: true, name: memberName, phone: memberPhone, notification, groupSync };
      });
    }

    if (name === "remove_family_member") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { seniorId, clientId } = input as Record<string, unknown>;
      // Target is memberPhone only. `input.phone` is the acting user's phone
      // (auto-injected for the confirmation round-trip), so falling back to it
      // here would remove the actor themselves when memberPhone is missing.
      const targetPhone = input.memberPhone as unknown;
      if (!seniorId || !targetPhone || !clientId) return toolError("INVALID_INPUT", "seniorId, memberPhone, and clientId are required");
      const seniorSnap = await db.collection("senior_profiles").doc(seniorId as string).get();
      if (!seniorSnap.exists) return toolError("NOT_FOUND", "Senior profile not found");
      const seniorData = seniorSnap.data()!;
      if (seniorData.userId && seniorData.userId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized to modify this senior's profile");
      const { removeMemberFromGroup } = await import("../agents/familyGroupManager");
      const result = await removeMemberFromGroup(seniorId as string, targetPhone as string);
      const existingMembers: Array<Record<string, unknown>> = seniorData.familyMembers ?? [];
      const memberObj = existingMembers.find(m => m.phone === targetPhone);
      if (memberObj) await seniorSnap.ref.update({ familyMembers: admin.firestore.FieldValue.arrayRemove(memberObj) });
      // Tell the removed person they were removed — courtesy plus prevents
      // confusion when their next inbound stops getting Evia replies.
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(
        targetPhone as string,
        "You've been removed from an Evia care group. You won't get further updates here. Text STOP anytime to unsubscribe completely.",
        "mcp:remove_family_member",
      );
      logAudit({ eventType: "family_member_removed", userId: clientId as string, data: { source: "mcp:remove_family_member", seniorId, removedPhone: targetPhone, notificationSent: notification.sent } }).catch(() => {});
      const { logAgentAction } = await import("../observability/actionLedger");
      logAgentAction({
        actionType: "family_member_remove",
        status: notification.sent ? "executed" : "failed",
        userId: clientId as string,
        role: "client",
        toolName: "remove_family_member",
        targetCollection: "family_group_members",
        targetDocId: String(targetPhone),
        errorReason: notification.sent ? undefined : notification.reason,
        metadata: { seniorId, removedPhone: targetPhone, source: "mcp:remove_family_member" },
      }).catch(() => {});
      return { success: true, ...result, notification };
      });
    }

    if (name === "start_review_flow") {
      // The site's Leave a Review modal in text (agents/reviewFlow.ts). Replaced
      // submit_review (2026-09-19), which looked visits up in the legacy
      // `appointments` collection and wrote an Evia-only document shape.
      const { clientId, caregiverId, rating, phone } = input as Record<string, unknown>;
      if (!clientId || !caregiverId) return toolError("INVALID_INPUT", "clientId and caregiverId are required");
      if (!phone) return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
      const rvSessSnap = await db.collection("agent_sessions").doc(phone as string).get();
      const rvSession = rvSessSnap.data();
      const rvChatId = rvSession?.chatId as string | undefined;
      if (!rvChatId || !rvSession) return toolError("NOT_FOUND", "No active conversation to start the review in");
      const { startReviewFlow } = await import("../agents/reviewFlow");
      const rvResult = await startReviewFlow(phone as string, rvChatId, rvSession as any, {
        caregiverId: caregiverId as string,
        ...(Number.isInteger(rating) ? { rating: rating as number } : {}),
      });
      logAudit({ eventType: "review_submitted", userId: clientId as string, data: { source: "mcp:start_review_flow", caregiverId, started: rvResult.started, reason: rvResult.reason ?? null } }).catch(() => {});
      if (!rvResult.started) {
        return { success: false, reason: rvResult.reason ?? "failed_to_start", instruction: "The family has already been told why the review can't start (or that they already reviewed this caregiver) — do not repeat or add anything else this turn." };
      }
      return { success: true, instruction: "This tool already texted the family the first review question. Send NOTHING else this turn." };
    }

    if (name === "set_subscription_status") {
      const { clientId, action: subAction } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      if (subAction !== "cancel" && subAction !== "reactivate") {
        return toolError("INVALID_INPUT", "action must be 'cancel' or 'reactivate'");
      }
      if (subAction === "cancel") {
        // 2026-08-31 (Membership page audit): calls the SAME shared function
        // the website's v1-cancelSubscription callable calls, instead of a
        // separate reimplementation of the identical Stripe lookup+update. Also
        // stopped writing users/{uid}.subscriptionStatus:"canceling" — that
        // field is never touched by the real subscription lifecycle (the
        // customer.subscription.updated webhook writes membershipStatus, not
        // subscriptionStatus), so the write was actively wrong, not just dead,
        // and left Evia's own ambient context stuck saying "canceling" forever.
        // Matches the website exactly: write nothing directly, the webhook is
        // the single source of truth either way.
        const { cancelSubscriptionForUser } = await import("../stripe");
        let result;
        try {
          result = await cancelSubscriptionForUser(clientId as string);
        } catch (err) {
          if (err instanceof Error && err.message === "No active subscription found") {
            return toolError("NOT_FOUND", err.message);
          }
          throw err;
        }
        logAudit({ eventType: "subscription_cancelled", userId: clientId as string, data: { source: "mcp:set_subscription_status", subId: result.subId, periodEnd: result.periodEnd } }).catch(() => {});
        return { success: true, ...result };
      }
      const { reactivateSubscriptionForUser } = await import("../stripe");
      let result;
      try {
        result = await reactivateSubscriptionForUser(clientId as string);
      } catch (err) {
        if (err instanceof Error && err.message === "No canceled subscription found") {
          return toolError("NOT_FOUND", "No subscription found to reactivate");
        }
        throw err;
      }
      logAudit({ eventType: "subscription_reactivated", userId: clientId as string, data: { source: "mcp:set_subscription_status" } }).catch(() => {});
      return { success: true, ...result };
    }

    if (name === "create_care_journal_entry") {
      const { caregiverId, appointmentId, notes, mood, medsGiven, activities, recipientFirstName } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !notes) return toolError("INVALID_INPUT", "caregiverId, appointmentId, and notes are required");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
      // Recipient attribution: an explicit name from the caregiver wins, else
      // the appointment's own attribution rides along. Fail-soft: absent = the
      // household's sole recipient. Kill-switch aware for the explicit path.
      let recipientName: string | null = null;
      let recipientKey:  string | null = (appt.recipientKey as string | undefined) ?? null;
      try {
        const { multiRecipientScopingEnabled } = await import("../config/featureFlags");
        if (recipientFirstName && multiRecipientScopingEnabled()) {
          const { resolveRecipientKey } = await import("../agents/careRecipients");
          const webPlanSnap = await db.collection("carePlans").doc(appt.clientId as string).get();
          const res = resolveRecipientKey(
            Object.keys((webPlanSnap.data()?.recipientPlans ?? {}) as Record<string, unknown>),
            String(recipientFirstName));
          if (res.ok) { recipientKey = res.key; recipientName = String(recipientFirstName).trim().split(" ")[0]; }
        } else if (appt.seniorName) {
          recipientName = String(appt.seniorName);
        }
      } catch (e) { console.warn("[create_care_journal_entry] recipient attribution failed:", e); }
      const entryRef = await db.collection("care_journal").add({
        seniorId: appt.seniorId ?? appt.clientId, caregiverId, appointmentId,
        clientId: appt.clientId, notes, mood: mood ?? null,
        medsGiven: medsGiven ?? null, activities: activities ?? [],
        ...(recipientName ? { recipientName } : {}),
        ...(recipientKey  ? { recipientKey }  : {}),
        source: "cara_sms", timestamp: nowIso,
      });
      await apptSnap.ref.update({ journalEntryLogged: true }).catch(() => {});
      // U3: guarantee the family summary fires on this path too (previously only
      // the SMS care-notes path notified the family). Reuses the shared,
      // PHI-minimized sender so both write paths behave identically.
      try {
        const { sendFamilyShiftEndUpdate } = await import("../linq/routeCaregiver");
        await sendFamilyShiftEndUpdate({
          caregiverName: (appt.caregiverName as string) ?? "",
          clientId: appt.clientId,
          seniorId: (appt.seniorId ?? appt.clientId) as string,
          apptData: { ...appt, id: appointmentId },
          entry: { mood: mood ?? "", activities: activities ?? [], observations: notes, notes },
        });
      } catch (e) { console.error("[create_care_journal_entry] family summary failed", e); }
      logAudit({ eventType: "care_journal_created", userId: caregiverId as string, data: { source: "mcp:create_care_journal_entry", appointmentId, entryId: entryRef.id } }).catch(() => {});
      return { success: true, entryId: entryRef.id };
    }

    if (name === "create_senior_profile") {
      const { clientId, name: fullName, firstName, lastName, relationship, age, careNeeds, careNeedDetails, notes, location } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const [fromFullFirst, ...fromFullRest] = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
      const first = String(firstName ?? fromFullFirst ?? "").trim();
      const last = String(lastName ?? fromFullRest.join(" ") ?? "").trim();
      const loc = (location && typeof location === "object" ? location : {}) as Record<string, unknown>;
      const r = await addRecipient(clientId as string, {
        firstName: first, lastName: last, relationship: String(relationship ?? ""), age: (age as string | number | undefined) ?? "",
        careNeeds: Array.isArray(careNeeds) ? (careNeeds as string[]) : [],
        careNeedDetails: careNeedDetails && typeof careNeedDetails === "object" ? (careNeedDetails as Record<string, string[]>) : undefined,
        notes: typeof notes === "string" ? notes : "",
        location: { street: String(loc.street ?? ""), city: String(loc.city ?? ""), state: String(loc.state ?? ""), zipCode: String(loc.zipCode ?? "") },
      });
      if (!r.ok) return toolError("INVALID_INPUT", r.message);
      logAudit({ eventType: "senior_profile_created", userId: clientId as string, data: { source: "mcp:create_senior_profile", key: r.key } }).catch(() => {});
      return { success: true, key: r.key, name: r.name, message: `Added ${r.name} to the Care Plan.` };
    }

    if (name === "remove_care_recipient") {
      const { clientId, recipientFirstName } = input as Record<string, unknown>;
      if (!clientId || !recipientFirstName) return toolError("INVALID_INPUT", "clientId and recipientFirstName are required");
      const r = await removeRecipient(clientId as string, String(recipientFirstName));
      if (!r.ok) return toolError(r.code, r.message);
      logAudit({ eventType: "senior_profile_archived", userId: clientId as string, data: { source: "mcp:remove_care_recipient", recipientFirstName } }).catch(() => {});
      return { success: true, removed: r.removed };
    }

    if (name === "set_recipient_photo") {
      // The Care Plan page's recipient avatar (CarePlan.tsx handleRecipientPhotoUpload):
      // same storage folder, same roster field. Over text the "file" is the photo the
      // family attached, which the inbound media handler already stored.
      const { clientId, recipientFirstName, photoUrl, phone } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      let sourceUrl = typeof photoUrl === "string" && photoUrl ? photoUrl : "";
      if (!sourceUrl && typeof phone === "string" && phone) {
        const sess = (await db.collection("agent_sessions").doc(phone).get()).data();
        const last = sess?.lastSharedMedia as { url?: string; kind?: string } | undefined;
        if (last?.kind === "image" && last.url) sourceUrl = last.url;
      }
      if (!sourceUrl) {
        return toolError("INVALID_INPUT", `No photo to save. Ask the family to attach the photo here in the conversation — or, if photos don't come through on their phone, send them the Care Plan page to upload it: ${getAppUrl()}/client/care-plan`);
      }
      const { setRecipientPhoto } = await import("../agents/carePlanPage");
      const r = await setRecipientPhoto(clientId as string, { firstName: typeof recipientFirstName === "string" ? recipientFirstName : undefined, sourceUrl });
      if (!r.ok) return toolError(r.code, r.message + (r.options?.length ? ` Options: ${r.options.join(", ")}.` : ""));
      logAudit({ eventType: "senior_profile_updated", userId: clientId as string, data: { source: "mcp:set_recipient_photo", recipient: r.recipient.firstName } }).catch(() => {});
      return { success: true, recipient: r.recipient.name, photoURL: r.photoURL, instruction: "Tell the family the photo is saved on the Care Plan for that recipient — one short line." };
    }

    if (name === "delete_review") {
      const { clientId, reviewId } = input as Record<string, unknown>;
      if (!clientId || !reviewId) return toolError("INVALID_INPUT", "clientId and reviewId are required");
      const rSnap = await db.collection("reviews").doc(reviewId as string).get();
      if (!rSnap.exists) return toolError("NOT_FOUND", "Review not found");
      const review = rSnap.data()!;
      if (review.clientId !== clientId) return toolError("PERMISSION_DENIED", "Review does not belong to this client");
      await rSnap.ref.delete();
      if (review.appointmentId) {
        await db.collection("appointments").doc(review.appointmentId as string)
          .update({ hasReview: false, reviewId: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
      logAudit({ eventType: "review_deleted", userId: clientId as string, data: { source: "mcp:delete_review", reviewId, caregiverId: review.caregiverId } }).catch(() => {});
      return { success: true, reviewId };
    }

    if (name === "get_support_ticket") {
      const { userId, ticketId } = input as Record<string, unknown>;
      if (!userId || !ticketId) return toolError("INVALID_INPUT", "userId and ticketId are required");
      const tSnap = await db.collection("support_tickets").doc(ticketId as string).get();
      if (!tSnap.exists) return toolError("NOT_FOUND", "Support ticket not found");
      const ticket = tSnap.data()!;
      if (ticket.userId !== userId) return toolError("PERMISSION_DENIED", "Ticket does not belong to this user");
      return { success: true, ticket: { id: tSnap.id, subject: ticket.subject, status: ticket.status, category: ticket.category, createdAt: ticket.createdAt, resolved: ticket.resolved ?? false } };
    }

    if (name === "list_support_tickets") {
      const { userId } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      // where(userId) only + in-memory sort to avoid a composite index requirement.
      const tSnap = await db.collection("support_tickets").where("userId", "==", userId).limit(25).get().catch(() => null);
      if (!tSnap) return { success: true, tickets: [] };
      const tickets = tSnap.docs
        .map(d => { const t = d.data(); return { id: d.id, subject: t.subject, status: t.status, category: t.category, createdAt: t.createdAt as string, resolved: t.resolved ?? false }; })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 10);
      return { success: true, tickets, total: tickets.length };
    }

    if (name === "update_support_ticket") {
      const { userId, ticketId, action, message } = input as Record<string, unknown>;
      if (!userId || !ticketId || !action) return toolError("INVALID_INPUT", "userId, ticketId, and action are required");
      const tSnap = await db.collection("support_tickets").doc(ticketId as string).get();
      if (!tSnap.exists) return toolError("NOT_FOUND", "Support ticket not found");
      const ticket = tSnap.data()!;
      if (ticket.userId !== userId) return toolError("PERMISSION_DENIED", "Ticket does not belong to this user");
      if (action === "reopen") {
        await tSnap.ref.update({ status: "open", resolved: false, reopenedAt: nowIso });
      } else if (action === "add_response") {
        if (!message) return toolError("INVALID_INPUT", "message is required for add_response");
        await tSnap.ref.update({ userResponses: admin.firestore.FieldValue.arrayUnion({ text: message, at: nowIso }) });
      } else {
        return toolError("INVALID_INPUT", "action must be 'reopen' or 'add_response' (admin-only states cannot be set here)");
      }
      logAudit({ eventType: "support_ticket_updated", userId: userId as string, data: { source: "mcp:update_support_ticket", ticketId, action } }).catch(() => {});
      return { success: true, ticketId, action };
    }

    if (name === "log_match_feedback") {
      const { clientId, caregiverId, sentiment, note } = input as Record<string, unknown>;
      if (!clientId || !caregiverId || !note) return toolError("INVALID_INPUT", "clientId, caregiverId, and note are required");
      await db.collection("users").doc(clientId as string).collection("match_history").add({
        caregiverId, sentiment: sentiment ?? "neutral", note, source: "cara_sms", createdAt: nowIso,
      });
      logAudit({ eventType: "match_feedback_logged", userId: clientId as string, data: { source: "mcp:log_match_feedback", caregiverId, sentiment: sentiment ?? "neutral" } }).catch(() => {});
      return { success: true };
    }

    if (name === "create_job_post") {
      const {
        clientId, title, notes, careTypes, careNeedDetails, frequency, days, timeOfDay, hourlyRate, streetAddress,
        zipCode, startDate, endDate, careLevel, minHoursPerWeek, caregiversNeeded, careRecipients,
      } = input as Record<string, unknown>;
      // The page's "New Request" button runs gate('booking') (PostsPage.tsx / ClientDashboard.tsx).
      if (clientId) {
        const jpGateError = await checkClientAccessGate(clientId as string, "booking", { phone: (input as Record<string, unknown>).phone });
        if (jpGateError) return jpGateError;
      }
      // 2026-09-07: title/notes brought up to full parity with the website's
      // required 'Job title' (10-80 chars) and 'Details' (50-2500 chars)
      // fields — this tool previously had no way to collect either at all, so
      // every SMS-posted job got a generic auto-title and no description.
      // hourlyRate is now genuinely optional (omit for a flexible rate,
      // matching the website's "rate flexible" toggle) — buildWebJobPostDoc
      // already derives rateFlexible from a missing/zero rate on its own.
      if (!clientId || typeof title !== "string" || title.trim().length < 10 || title.trim().length > 80) {
        return toolError("INVALID_INPUT", "title is required, 10-80 characters");
      }
      if (typeof notes !== "string" || notes.trim().length < 50 || notes.trim().length > 2500) {
        return toolError("INVALID_INPUT", "notes (job description) is required, 50-2500 characters");
      }
      if (!Array.isArray(careTypes) || careTypes.length === 0 || !zipCode) {
        return toolError("INVALID_INPUT", "clientId, careTypes (non-empty), and zipCode are required");
      }
      const daysArr = Array.isArray(days) ? (days as string[]) : [];
      const todArr  = Array.isArray(timeOfDay) ? (timeOfDay as string[]) : [];
      // Same rule as onboarding's save_onboarding_field: zip is the source of
      // truth for city/state — the model is never asked or trusted to extract
      // a city from free text.
      const { lookupZipPlace } = await import("../utils/geocode");
      const place = await lookupZipPlace(zipCode as string);
      const ref = db.collection("job_posts").doc();
      // Web JobPost contract via the shared builder — the caregiver Job Board
      // renders title/location-string/rate; the old hand-rolled shape here
      // (summary + location OBJECT) rendered blank and could crash the board.
      const { buildWebJobPostDoc, mirrorJobPostRecipientsToWeb } = await import("../agents/jobPostContract");
      await ref.set(buildWebJobPostDoc({
        clientId:      clientId as string,
        source:        "cara_sms",
        title:         (title as string).trim(),
        description:   (notes as string).trim(),
        careTypes:     careTypes as string[],
        startDate:     (startDate ?? undefined) as string | undefined,
        endDate:       (endDate ?? undefined) as string | undefined,
        frequency:     (frequency ?? undefined) as string | undefined,
        days:          daysArr,
        timeOfDay:     todArr,
        hourlyRate:    hourlyRate as number | string | undefined,
        zipCode:       zipCode as string,
        city:          place?.city,
        state:         place?.state,
        lat:           place?.lat,
        lng:           place?.lng,
        careLevel:     (careLevel ?? undefined) as string | undefined,
        minHoursPerWeek: typeof minHoursPerWeek === "number" ? minHoursPerWeek : undefined,
        caregiversNeeded: typeof caregiversNeeded === "number" ? Math.min(4, Math.max(1, caregiversNeeded)) : undefined,
        recipientsCount: Array.isArray(careRecipients) ? Math.min(4, Math.max(1, careRecipients.length)) : undefined,
        intakeId:      ref.id,
      }));
      // Matches PostJobFlow.tsx's own post-submit mirror exactly (job_postings
      // roster + carePlans.recipientPlans/locationPool). Runs for EVERY
      // recipient this job covers, not just new ones — mirrorJobPostRecipientsToWeb
      // already safely no-ops the roster write for someone who matches the
      // existing primary recipient, while still syncing their care plan
      // (careNeeds/careNeedDetails/notes) to this job post. Before 2026-09-07
      // this only ran when careRecipients held a brand-new person, so an
      // existing-only recipient's care plan (and Notes) never got this job
      // post's details at all.
      if (Array.isArray(careRecipients) && careRecipients.length > 0) {
        await mirrorJobPostRecipientsToWeb({
          uid:             clientId as string,
          careRecipients:  careRecipients as { firstName: string; lastName?: string; relationship?: string }[],
          careTypes:       careTypes as string[],
          careNeedDetails: (careNeedDetails ?? undefined) as Record<string, unknown> | undefined,
          description:     (notes as string).trim(),
          streetAddress:   (streetAddress ?? undefined) as string | undefined,
          city:            place?.city,
          state:           place?.state,
          zipCode:         zipCode as string,
        }).catch(() => {});
      }
      logAudit({ eventType: "job_post_created", userId: clientId as string, data: { source: "mcp:create_job_post", jobId: ref.id } }).catch(() => {});
      return { success: true, jobId: ref.id, message: "Your job is posted — caregivers nearby will see it." };
    }

    if (name === "list_proactive_drafts") {
      const { userId } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const dSnap = await db.collection("proactive_drafts").where("userId", "==", userId).limit(50).get().catch(() => null);
      if (!dSnap) return { success: true, drafts: [] };
      const PENDING = new Set(["pending", "scheduled", "queued", "draft"]);
      const drafts = dSnap.docs
        .map(d => { const x = d.data(); return { id: d.id, summary: x.summary ?? x.content ?? x.message ?? "(draft)", status: x.status as string, scheduledFor: x.scheduledFor ?? x.sendAt ?? null }; })
        .filter(d => PENDING.has(String(d.status)));
      return { success: true, drafts, total: drafts.length };
    }

    if (name === "cancel_proactive_draft") {
      const { userId, draftId } = input as Record<string, unknown>;
      if (!userId || !draftId) return toolError("INVALID_INPUT", "userId and draftId are required");
      const dSnap = await db.collection("proactive_drafts").doc(draftId as string).get();
      if (!dSnap.exists) return toolError("NOT_FOUND", "Draft not found");
      const draft = dSnap.data()!;
      if (draft.userId !== userId) return toolError("PERMISSION_DENIED", "Draft does not belong to this user");
      if (draft.status === "sent") return toolError("INVALID_INPUT", "That message already went out — it can't be cancelled");
      await dSnap.ref.update({ status: "cancelled", cancelledAt: nowIso });
      logAudit({ eventType: "proactive_draft_cancelled", userId: userId as string, data: { source: "mcp:cancel_proactive_draft", draftId } }).catch(() => {});
      return { success: true, draftId };
    }

    if (name === "apply_to_job") {
      const { caregiverId, jobId, proposedRate, coverNote } = input as Record<string, unknown>;
      if (!caregiverId || !jobId) return toolError("INVALID_INPUT", "caregiverId and jobId are required");
      const jobSnap = await db.collection("job_posts").doc(jobId as string).get();
      if (!jobSnap.exists) return toolError("NOT_FOUND", "Job post not found");
      const job = jobSnap.data()!;
      if (job.status !== "open") return toolError("INVALID_INPUT", "This job post is no longer accepting applications");
      const dupSnap2 = await db.collection("job_applications").where("jobId", "==", jobId).where("caregiverId", "==", caregiverId).limit(1).get();
      if (!dupSnap2.empty) return toolError("INVALID_INPUT", "You have already applied to this job");
      const { jobApplicationSnapshot } = await import("../utils/jobApplicationDoc");
      const applicantSnap = await db.collection("caregivers").doc(caregiverId as string).get().catch(() => null);
      const applicant = applicantSnap?.exists ? applicantSnap.data()! : {};
      const appRef = await db.collection("job_applications").add({
        jobId, caregiverId, clientId: job.clientId,
        caregiverName: (applicant.name as string) ?? "",
        ...(applicant.photo ? { caregiverPhoto: applicant.photo } : {}),
        rating: typeof applicant.rating === "number" ? applicant.rating : null,
        ...jobApplicationSnapshot(job),
        proposedRate: proposedRate ?? null,
        // coverLetter is the canonical key the web reads; coverNote kept for SMS-side readers.
        coverLetter: (coverNote as string | undefined) ?? "",
        coverNote: coverNote ?? "",
        status: "pending", appliedAt: nowIso, source: "cara_sms",
      });
      // onJobApplicationCreate (notificationTriggers.ts) is the single source
      // of truth for texting the client about this — it fires on the write
      // above regardless of caller, so no manual send here.
      logAudit({ eventType: "job_application_submitted", userId: caregiverId as string, data: { source: "mcp:apply_to_job", jobId, applicationId: appRef.id } }).catch(() => {});
      return { success: true, applicationId: appRef.id };
    }

    if (name === "respond_to_job_application") {
      const { applicationId, clientId, decision, preferredDate, preferredTime, interviewType } = input as Record<string, unknown>;
      if (!applicationId || !clientId || !decision) return toolError("INVALID_INPUT", "applicationId, clientId, and decision are required");
      const appSnap2 = await db.collection("job_applications").doc(applicationId as string).get();
      if (!appSnap2.exists) return toolError("NOT_FOUND", "Application not found");
      const app = appSnap2.data()!;
      if (app.clientId !== clientId) return toolError("PERMISSION_DENIED", "Application does not belong to this client");
      if (app.status !== "pending") return toolError("INVALID_INPUT", `Application already decided: ${app.status}`);

      if (decision === "accept") {
        // The website has NO direct "accept this applicant" action at all —
        // the only path from "applied" to "hired" is schedule an interview →
        // interview completes → the client sends a booking (PostsPage.tsx's
        // handleSendBooking, which is the only place job_applications.status
        // ever becomes 'accepted', and the only place a job_posts doc closes).
        // This used to jump straight to "filled" + reject every other
        // applicant, copying a website hook (useJobApplications.ts's
        // acceptApplication) that is DEAD CODE — defined but never called
        // from any live component, confirmed via a full-codebase grep. Fixed
        // to do what accepting an applicant actually maps to on the live
        // site: requesting an interview with them.
        if (!preferredDate || !preferredTime) {
          return toolError("INVALID_INPUT", "preferredDate and preferredTime are required to accept an applicant — accepting means requesting an interview with them, the only path the website has from applied to hired");
        }
        const gateError = await checkClientAccessGate(clientId as string, "interview", { phone: (input as Record<string, unknown>).phone });
        if (gateError) return gateError;
        return createVideoInterviewRequestForTool({
          clientId: clientId as string, caregiverId: app.caregiverId as string,
          applicationId: applicationId as string,
          // The application already IS for a specific job — link it
          // automatically rather than making the model re-supply an id it
          // has no independent reason to already know.
          jobId: app.jobId as string | undefined,
          notes: input.notes as string | undefined,
          phone: input.phone as string | undefined,
          preferredDate: preferredDate as string, preferredTime: preferredTime as string,
          interviewType: interviewType as string | undefined,
          // caregiverId here is app.caregiverId — pulled straight from the
          // specific application doc being processed, not a name the model
          // picked off a list. No confirm-the-name checkpoint needed.
          skipConfirmationGate: true,
        });
      }

      // The website's Decline button (PostsPage.tsx handleDeclineApplicant),
      // exactly: status 'rejected' + declinedAt, and NOTHING sent to the
      // caregiver — they see "Application Rejected" on their Job Board. The
      // Evia-only "the family went with another caregiver" text was removed
      // 2026-09-16 (founder's call: match the site; a decline notification,
      // if ever wanted, belongs on the application trigger for both channels).
      await appSnap2.ref.update({ status: "rejected", declinedAt: admin.firestore.FieldValue.serverTimestamp() });
      logAudit({ eventType: "job_application_responded", userId: clientId as string, data: { source: "mcp:respond_to_job_application", applicationId, decision } }).catch(() => {});
      return { success: true, decision, applicationId };
    }

    if (name === "submit_interview_feedback") {
      const { interviewId, clientId, fitLevel, notes: fbNotes } = input as Record<string, unknown>;
      if (!interviewId || !clientId || !fitLevel) return toolError("INVALID_INPUT", "interviewId, clientId, and fitLevel are required");
      const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      if (iv.clientId !== clientId) return toolError("PERMISSION_DENIED", "Interview does not belong to this client");
      // Only "strong"/"no" are terminal (matches shouldNudgeInterviewFeedback's
      // own terminal check in interviewFeedbackNudge.ts) — a prior "maybe"
      // means the family was still deciding, not done deciding. Blocking here
      // unconditionally used to permanently lock out the real answer once it
      // finally came in: the feedback nudge keeps re-asking after "maybe" for
      // exactly this reason, but this guard rejected every one of those
      // replies with "already submitted," so the decision could never
      // actually be recorded. Found 2026-09-13 while confirming the nudge's
      // own fix (same date) was reachable end-to-end.
      if (iv.feedbackSubmitted === true && (iv.fitLevel === "strong" || iv.fitLevel === "no")) {
        return toolError("INVALID_INPUT", "Feedback already submitted for this interview");
      }
      const ivUpdate: Record<string, unknown> = { fitLevel, clientNotes: fbNotes ?? "", feedbackSubmitted: true, feedbackAt: nowIso };
      // Matches the website's "Mark as Completed" — done automatically here
      // since giving a fit decision IS confirming the interview happened, in
      // one conversational turn instead of two separate button clicks.
      if (iv.status !== "completed") {
        // Same rule as the page: a fit decision comes after "Mark as Completed",
        // which only appears once the interview time has passed.
        if (typeof iv.scheduledTime === "string" && parseScheduledTimeMs(iv.scheduledTime) > Date.now()) {
          return toolError("INVALID_INPUT", `That interview hasn't happened yet (${formatInterviewTime(parseScheduledTimeMs(iv.scheduledTime))}) — a fit decision comes after it`);
        }
        ivUpdate.status = "completed"; ivUpdate.completedAt = nowIso;
      }
      if (fitLevel === "strong") {
        // NOTE: this only records the decision (hire_decisions) — it does
        // NOT create a bookable record. There is no "hire_requests"
        // collection (removed 2026-09-13, was a dead end with no reader
        // that ever turned it into a real booking, plus dormant trigger
        // code that would have bypassed booking_requests entirely if ever
        // activated). The ONLY way this booking actually happens is the
        // scripted booking flow's Send Booking write (bookingSend.ts), the
        // same booking_requests doc the website's own button creates —
        // bookingFollowupNudge.ts follows up if the family stalls after this.
        //
        // Deliberately does NOT message the caregiver here (2026-09-13,
        // confirmed against the site): the site's own "strong fit"/hire
        // step has no caregiver-facing side effect at all — the caregiver
        // hears nothing until the real booking_requests doc is written
        // (its own Cloud Function trigger, onBookingRequestWrite, is what
        // notifies them). Messaging the caregiver at this earlier, no-
        // schedule-no-rate-yet stage would tell them something is coming
        // before there's an actual booking on the table.
        await db.collection("hire_decisions").add({ clientId, clientName: iv.clientName ?? "", caregiverId: iv.caregiverId, caregiverName: iv.caregiverName ?? "", decision: "hire", createdAt: nowIso }).catch(() => {});
      } else if (fitLevel === "no") {
        // Matches the website's "Not Selected" exactly: video_interviews →
        // 'declined' (declinedBy:'client') + a hire_decisions record.
        ivUpdate.status = "declined";
        ivUpdate.declinedBy = "client";
        await db.collection("hire_decisions").add({ clientId, clientName: iv.clientName ?? "", caregiverId: iv.caregiverId, caregiverName: iv.caregiverName ?? "", decision: "decline", createdAt: nowIso }).catch(() => {});
      }
      await ivSnap.ref.update(ivUpdate);
      await db.collection("admin_alerts").add({ type: "interview_feedback_submitted", fitLevel, interviewId, clientId, caregiverId: iv.caregiverId, priority: fitLevel === "strong" ? "high" : "low", resolved: false, createdAt: nowIso });
      logAudit({ eventType: "interview_feedback_submitted", userId: clientId as string, data: { source: "mcp:submit_interview_feedback", interviewId, fitLevel } }).catch(() => {});
      return { success: true, fitLevel };
    }

    if (name === "complete_interview") {
      const { interviewId, clientId } = input as Record<string, unknown>;
      if (!interviewId || !clientId) return toolError("INVALID_INPUT", "interviewId and clientId are required");
      const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      if (iv.clientId !== clientId) return toolError("PERMISSION_DENIED", "Interview does not belong to this client");
      if (iv.status === "completed") return { success: true, alreadyCompleted: true, interviewId, caregiverName: iv.caregiverName ?? null };
      if (!["accepted", "confirmed"].includes(iv.status as string)) {
        return toolError("INVALID_INPUT", `Cannot complete an interview that hasn't been confirmed yet (status: ${iv.status})`);
      }
      // The page's "Mark as Completed" button appears only once the scheduled
      // time has passed — an interview can't be completed before it happens.
      if (typeof iv.scheduledTime === "string" && parseScheduledTimeMs(iv.scheduledTime) > Date.now()) {
        return toolError("INVALID_INPUT", `That interview hasn't happened yet (${formatInterviewTime(parseScheduledTimeMs(iv.scheduledTime))}) — it can be marked completed after that time`);
      }
      // Terminal status — clear any leftover reschedule proposal, exactly as
      // the site's handleMarkInterviewComplete does (2026-09-16).
      await ivSnap.ref.update({
        status: "completed", completedAt: nowIso,
        reschedulePendingTime: admin.firestore.FieldValue.delete(),
        rescheduledBy:         admin.firestore.FieldValue.delete(),
      });
      logAudit({ eventType: "interview_completed", userId: clientId as string, data: { source: "mcp:complete_interview", interviewId } }).catch(() => {});
      return { success: true, interviewId, caregiverName: iv.caregiverName ?? null };
    }

    if (name === "request_instant_payout") {
      const { caregiverId, amountCents } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      // Single payout implementation shared with the app callable and the SMS
      // PAYOUT flow — eligibility, replay guard, Stripe idempotency key, and
      // the caregivers/{id}/payouts record all live there.
      const { executeInstantPayout, InstantPayoutError } = await import("../payoutCommon");
      try {
        const result = await executeInstantPayout({
          caregiverId: caregiverId as string,
          requestedCents: amountCents != null ? Number(amountCents) : null,
          source: "mcp",
        });
        logAudit({ eventType: "instant_payout_requested", userId: caregiverId as string, data: { source: "mcp:request_instant_payout", amountCents: result.amountCents, stripePayoutId: result.stripePayoutId } }).catch(() => {});
        return {
          success: true,
          amountCents: result.amountCents,
          amountDollars: `$${(result.amountCents / 100).toFixed(2)}`,
          fee: result.feeCents / 100,
          feeDollars: `$${(result.feeCents / 100).toFixed(2)}`,
          grossCents: result.grossCents,
          estimatedArrival: "within ~30 minutes",
        };
      } catch (err) {
        if (err instanceof InstantPayoutError) {
          return toolError(err.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT", err.message);
        }
        throw err;
      }
    }

    if (name === "submit_shift_hours") {
      return runActionNativeMcpWrite(name, input, async () => {
        const { caregiverId, appointmentId, clockInTime, clockOutTime, breakMinutes } = input as Record<string, unknown>;
        if (!caregiverId || !appointmentId || !clockInTime || !clockOutTime) {
          return toolError("INVALID_INPUT", "caregiverId, appointmentId, clockInTime, and clockOutTime are required");
        }
        if (Number(breakMinutes) > 0) {
          return toolError("INVALID_INPUT", "Break adjustments require billing review and cannot be submitted here");
        }

        const apptSnap = await db.collection("appointments").doc(String(appointmentId)).get();
        if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
        const appointment = apptSnap.data()!;
        if (appointment.caregiverId !== caregiverId) {
          return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
        }

        const startMs = apptStartMs(appointment.date, clockInTime);
        let endMs = apptStartMs(appointment.date, clockOutTime);
        const bookedWindow = bookedWindowMillis(appointment);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !bookedWindow) {
          return toolError("INVALID_INPUT", "Appointment or submitted times are not valid");
        }
        if (endMs <= startMs) {
          if (bookedWindow.end <= bookedWindow.start + 24 * 60 * 60 * 1000 && bookedWindow.end > startMs) {
            endMs += 24 * 60 * 60 * 1000;
          } else {
            return toolError("INVALID_INPUT", "Clock-out time must be after clock-in time");
          }
        }

        try {
          const result = await createValidatedShiftHours({
            appointmentId: String(appointmentId),
            actorUid: String(caregiverId),
            submittedStartTime: new Date(startMs).toISOString(),
            submittedEndTime: new Date(endMs).toISOString(),
            source: "mcp",
          });
          logAudit({
            eventType: "shift_hours_submitted",
            userId: String(caregiverId),
            data: {
              source: "mcp:submit_shift_hours",
              appointmentId,
              durationHours: result.totalHours,
              amountCents: result.grossPayCents,
              status: result.status,
            },
          }).catch(() => {});
          return {
            success: true,
            durationHours: result.totalHours,
            amountCents: result.grossPayCents,
            amountDollars: `$${(result.grossPayCents / 100).toFixed(2)}`,
            status: result.status,
            alreadyExisted: result.alreadyExisted,
          };
        } catch (error) {
          if (error instanceof ValidatedShiftHoursError) {
            const code = error.code === "not_found"
              ? "NOT_FOUND"
              : error.code === "forbidden"
                ? "PERMISSION_DENIED"
                : "INVALID_INPUT";
            return toolError(code, error.message);
          }
          throw error;
        }
      });
    }

    if (name === "review_shift_hours") {
      return runActionNativeMcpWrite(name, input, async () => {
      // The Timesheets review modal, exactly: the SAME server function the
      // website's v1-reviewShiftHours callable runs (billing/reviewShiftHours.ts
      // reviewShiftHoursAs) — approve / propose_correction / accept_counter /
      // escalate with its guards, writes and notifications. Nothing Evia-only.
      const { clientId, appointmentId, action, proposedStartTime, proposedEndTime, proposalReason, lineItems } = input as Record<string, unknown>;
      if (!clientId || !appointmentId || !action) return toolError("INVALID_INPUT", "clientId, appointmentId, and action are required");
      if (!["approve", "propose_correction", "accept_counter", "escalate"].includes(action as string)) {
        return toolError("INVALID_INPUT", "action must be approve, propose_correction, accept_counter, or escalate");
      }
      if (action === "propose_correction" && (!proposedStartTime || !proposedEndTime)) {
        return toolError("INVALID_INPUT", "proposedStartTime and proposedEndTime are both required to propose a correction");
      }
      const { reviewShiftHoursAs } = await import("../billing/reviewShiftHours");
      try {
        await reviewShiftHoursAs(clientId as string, {
          appointmentId: appointmentId as string, action: action as string,
          proposedStartTime: proposedStartTime as string | undefined, proposedEndTime: proposedEndTime as string | undefined,
          proposalReason: proposalReason as string | undefined, lineItems,
        });
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        const msg = err instanceof Error ? err.message : String(err);
        if (code === "not-found") return toolError("NOT_FOUND", "Shift hours submission not found");
        if (code === "permission-denied") return toolError("PERMISSION_DENIED", "Shift hours do not belong to this client");
        if (code === "failed-precondition" || code === "invalid-argument") return toolError("INVALID_INPUT", msg);
        throw err;
      }
      logAudit({ eventType: "shift_hours_reviewed", userId: clientId as string, data: { source: "mcp:review_shift_hours", appointmentId, action } }).catch(() => {});
      return { success: true, action, appointmentId };
      });
    }

    if (name === "withdraw_job_application") {
      const { caregiverId, applicationId, reason } = input as Record<string, unknown>;
      if (!caregiverId || !applicationId) return toolError("INVALID_INPUT", "caregiverId and applicationId are required");
      const appSnap = await db.collection("job_applications").doc(applicationId as string).get();
      if (!appSnap.exists) return toolError("NOT_FOUND", "Application not found");
      const app = appSnap.data()!;
      if (app.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Application does not belong to this caregiver");
      // Idempotent: already withdrawn → success-shaped no-op.
      if (app.status === "withdrawn") return { success: true, applicationId, status: "withdrawn", alreadyWithdrawn: true };
      if (app.status !== "pending") return toolError("INVALID_INPUT", `Application can no longer be withdrawn (status: ${app.status})`);
      await appSnap.ref.update({ status: "withdrawn", withdrawnAt: nowIso, withdrawReason: reason ?? "" });
      logAudit({ eventType: "job_application_withdrawn", userId: caregiverId as string, data: { source: "mcp:withdraw_job_application", applicationId, jobId: app.jobId } }).catch(() => {});
      return { success: true, applicationId, status: "withdrawn" };
    }

    // ── respond_to_booking_request (U2 — AE1) ───────────────────────────────────
    if (name === "respond_to_booking_request") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { caregiverId, appointmentId, decision, message: brMsg } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !decision) return toolError("INVALID_INPUT", "caregiverId, appointmentId, and decision are required");
      if (decision !== "accept" && decision !== "decline") return toolError("INVALID_INPUT", "decision must be 'accept' or 'decline'");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
      // Idempotent: already in the requested terminal state → success-shaped no-op.
      if (decision === "accept" && (appt.status === "confirmed" || appt.caregiverConfirmed === true)) {
        return { success: true, decision: "accept", appointmentId, status: "confirmed", alreadyResponded: true };
      }
      const declinedStates = ["declined_by_caregiver", "cancelled", "cancelled_by_client"];
      if (decision === "decline" && declinedStates.includes(appt.status as string)) {
        return { success: true, decision: "decline", appointmentId, status: appt.status, alreadyResponded: true };
      }
      const pendingStates = ["pending_caregiver_confirmation", "pending", "requested", "offered"];
      if (!pendingStates.includes(appt.status as string)) {
        return toolError("INVALID_INPUT", `This booking request is no longer awaiting a response (status: ${appt.status})`);
      }
      if (decision === "accept") {
        // Drive the same confirmation path the web/shift-offer flow uses.
        await apptSnap.ref.update({ status: "confirmed", caregiverConfirmed: true, caregiverConfirmedAt: nowIso });
      } else {
        await apptSnap.ref.update({ status: "declined_by_caregiver", caregiverConfirmed: false, cancellationReason: "declined_by_caregiver", declinedAt: nowIso, declineMessage: brMsg ?? "" });
      }
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_client_session" };
      if (appt.clientId) {
        const clientSessSnap = await db.collection("agent_sessions").where("userId", "==", appt.clientId).limit(1).get();
        if (!clientSessSnap.empty) {
          const { trySend } = await import("../utils/toolNotify");
          const cgData = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
          const cgName = cgData?.name ?? cgData?.firstName ?? "Your caregiver";
          const msg = decision === "accept"
            ? `Great news — ${cgName} accepted your booking request! The visit is confirmed.`
            : `${cgName} isn't able to take that visit. I'm already lining up other options for you.`;
          notification = await trySend(clientSessSnap.docs[0].id, msg, "mcp:respond_to_booking_request");
        }
      }
      logAudit({ eventType: "booking_request_responded", userId: caregiverId as string, data: { source: "mcp:respond_to_booking_request", appointmentId, decision, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, decision, appointmentId, status: decision === "accept" ? "confirmed" : "declined_by_caregiver", notification };
      });
    }

    // ── start_shift (U2) ────────────────────────────────────────────────────────
    if (name === "start_shift") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { caregiverId, appointmentId, shiftId } = input as Record<string, unknown>;
      if (!caregiverId || (!appointmentId && !shiftId)) return toolError("INVALID_INPUT", "caregiverId and one of appointmentId or shiftId are required");
      const coll = appointmentId ? "appointments" : "shifts";
      const docId = (appointmentId ?? shiftId) as string;
      const snap = await db.collection(coll).doc(docId).get();
      if (!snap.exists) return toolError("NOT_FOUND", "Visit not found");
      const visit = snap.data()!;
      if (visit.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "This visit does not belong to this caregiver");
      const inProgress = ["in_progress", "in-progress"];
      // Idempotent: already started → confirm the existing start rather than re-stamping.
      if (inProgress.includes(visit.status as string)) {
        return { success: true, appointmentId: appointmentId ?? null, shiftId: shiftId ?? null, status: visit.status, startedAt: visit.startedAt ?? null, alreadyStarted: true };
      }
      if (["completed", "cancelled", "cancelled_by_client"].includes(visit.status as string)) {
        return toolError("INVALID_INPUT", `Cannot start a visit that is already ${visit.status}`);
      }
      // A visit must be confirmed before it can be started — never let an
      // unconfirmed (pending/requested/offered) visit be marked as worked.
      if (["pending", "requested", "offered", "pending_caregiver_confirmation"].includes(visit.status as string)) {
        return toolError("INVALID_INPUT", `Cannot start a visit that hasn't been confirmed yet (status: ${visit.status})`);
      }
      // "in-progress" (hyphen) is the canonical started status for BOTH
      // collections. The old underscore write to appointments was invisible to
      // every hyphen reader — handleArrived's twin path, the in-shift-update +
      // task-nudge crons, the arrival trigger (appointmentUpdated.ts:95), the
      // family notification, and care-notes validStatuses — so an agent-tool
      // start silently disabled the whole in-shift experience.
      const startedStatus = "in-progress";
      await snap.ref.update({ status: startedStatus, startedAt: nowIso });
      logAudit({ eventType: "shift_started", userId: caregiverId as string, data: { source: "mcp:start_shift", collection: coll, docId } }).catch(() => {});
      return { success: true, appointmentId: appointmentId ?? null, shiftId: shiftId ?? null, status: startedStatus, startedAt: nowIso };
      });
    }

    // ── complete_shift (U2 — AE7, idempotent) ───────────────────────────────────
    if (name === "complete_shift") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { caregiverId, appointmentId, shiftId, notes: completeNotes } = input as Record<string, unknown>;
      if (!caregiverId || (!appointmentId && !shiftId)) return toolError("INVALID_INPUT", "caregiverId and one of appointmentId or shiftId are required");
      const coll = appointmentId ? "appointments" : "shifts";
      const docId = (appointmentId ?? shiftId) as string;
      const snap = await db.collection(coll).doc(docId).get();
      if (!snap.exists) return toolError("NOT_FOUND", "Visit not found");
      const visit = snap.data()!;
      if (visit.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "This visit does not belong to this caregiver");
      // AE7 idempotency: a billable shiftHours record keyed by the appointment is
      // the source of truth. If the visit is already completed OR shift hours
      // already exist, return a success-shaped no-op — never double-write/double-bill.
      const billingKey = (appointmentId as string | undefined) ?? (visit.appointmentId as string | undefined);
      if (billingKey) {
        const existingShift = await db.collection("shiftHours").doc(billingKey).get();
        if (existingShift.exists) {
          return { success: true, appointmentId: billingKey, shiftId: shiftId ?? null, status: "completed", alreadyCompleted: true, billableRecordExists: true };
        }
      }
      if (visit.status === "completed") {
        return { success: true, appointmentId: appointmentId ?? null, shiftId: shiftId ?? null, status: "completed", alreadyCompleted: true };
      }
      if (["cancelled", "cancelled_by_client"].includes(visit.status as string)) {
        return toolError("INVALID_INPUT", `Cannot complete a visit that is ${visit.status}`);
      }
      // Never bill for an unconfirmed visit: a pending/requested/offered visit
      // can't be completed (it was never confirmed, let alone worked).
      if (["pending", "requested", "offered", "pending_caregiver_confirmation"].includes(visit.status as string)) {
        return toolError("INVALID_INPUT", `Cannot complete a visit that hasn't been confirmed or started (status: ${visit.status})`);
      }
      await snap.ref.update({ status: "completed", completedAt: nowIso, ...(completeNotes ? { completionNotes: completeNotes } : {}) });
      logAudit({ eventType: "shift_completed", userId: caregiverId as string, data: { source: "mcp:complete_shift", collection: coll, docId } }).catch(() => {});
      return { success: true, appointmentId: appointmentId ?? null, shiftId: shiftId ?? null, status: "completed", completedAt: nowIso };
      });
    }

    // ── update_shift_task (U2) ──────────────────────────────────────────────────
    if (name === "update_shift_task") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { caregiverId, shiftId, taskKey } = input as Record<string, unknown>;
      const completed = input.completed == null ? true : Boolean(input.completed);
      if (!caregiverId || !shiftId || !taskKey) return toolError("INVALID_INPUT", "caregiverId, shiftId, and taskKey are required");
      const snap = await db.collection("shifts").doc(shiftId as string).get();
      if (!snap.exists) return toolError("NOT_FOUND", "Shift not found");
      const shift = snap.data()!;
      if (shift.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "This shift does not belong to this caregiver");
      const current: string[] = Array.isArray(shift.tasksCompleted) ? shift.tasksCompleted as string[] : [];
      const already = current.includes(taskKey as string);
      // Idempotent: the doc already reflects the desired state → no-op success.
      if (completed && already) return { success: true, shiftId, taskKey, completed: true, alreadyInState: true };
      if (!completed && !already) return { success: true, shiftId, taskKey, completed: false, alreadyInState: true };
      await snap.ref.update({
        tasksCompleted: completed
          ? admin.firestore.FieldValue.arrayUnion(taskKey)
          : admin.firestore.FieldValue.arrayRemove(taskKey),
      });
      logAudit({ eventType: "shift_task_updated", userId: caregiverId as string, data: { source: "mcp:update_shift_task", shiftId, taskKey, completed } }).catch(() => {});
      return { success: true, shiftId, taskKey, completed };
      });
    }

    // ── submit_media_update (U2) ────────────────────────────────────────────────
    if (name === "submit_media_update") {
      const { caregiverId, appointmentId, mediaUrl, caption, mediaType } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !mediaUrl) return toolError("INVALID_INPUT", "caregiverId, appointmentId, and mediaUrl are required");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
      const type = mediaType === "video" ? "video" : "photo";
      const entryRef = await db.collection("care_journal").add({
        seniorId: appt.seniorId ?? appt.clientId, caregiverId, appointmentId,
        clientId: appt.clientId,
        notes: (caption as string) ?? "",
        entryType: "media", mediaUrl, mediaType: type,
        media: [{ url: mediaUrl, type, caption: (caption as string) ?? "" }],
        mood: null, medsGiven: null, activities: [],
        source: "cara_sms", timestamp: nowIso,
      });
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_client_session" };
      if (appt.clientId) {
        const clientSessSnap = await db.collection("agent_sessions").where("userId", "==", appt.clientId).limit(1).get();
        if (!clientSessSnap.empty) {
          const { trySend } = await import("../utils/toolNotify");
          const cgData = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
          const cgName = cgData?.name ?? cgData?.firstName ?? "Your caregiver";
          notification = await trySend(clientSessSnap.docs[0].id, `${cgName} shared a new ${type} update: ${(caption as string) || "tap to view in the care journal."}`, "mcp:submit_media_update");
        }
      }
      logAudit({ eventType: "media_update_submitted", userId: caregiverId as string, data: { source: "mcp:submit_media_update", appointmentId, entryId: entryRef.id, mediaType: type } }).catch(() => {});
      return { success: true, entryId: entryRef.id, mediaType: type, notification };
    }

    // ── respond_to_shift_hour_correction (U2) ───────────────────────────────────
    if (name === "respond_to_shift_hour_correction") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { caregiverId, appointmentId, decision, message: corrMsg } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !decision) return toolError("INVALID_INPUT", "caregiverId, appointmentId, and decision are required");
      if (decision !== "accept" && decision !== "pushback") return toolError("INVALID_INPUT", "decision must be 'accept' or 'pushback'");
      const shiftSnap = await db.collection("shiftHours").doc(appointmentId as string).get();
      if (!shiftSnap.exists) return toolError("NOT_FOUND", "Shift hours submission not found");
      const shift = shiftSnap.data()!;
      if (shift.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Shift hours do not belong to this caregiver");
      const correctionStates = ["correction_proposed", "correction_requested", "disputed"];
      if (!correctionStates.includes(shift.status as string)) {
        return toolError("INVALID_INPUT", `These shift hours are not awaiting a correction response (status: ${shift.status})`);
      }
      const correctedHours = shift.correctedHours as number | null | undefined;
      if (decision === "accept") {
        // Accept the corrected hours: adopt them as the billable duration and
        // re-submit for the standard client review (auto-approve window).
        const upd: Record<string, unknown> = {
          status: "pending_client_review",
          caregiverCorrectionResponse: "accepted",
          correctionRespondedAt: nowIso,
          autoApproveAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
        if (correctedHours != null) {
          const rate = (shift.hourlyRate as number) ?? (shift.payRate as number) ?? 22;
          upd.durationHours = correctedHours;
          upd.submittedTotalHours = correctedHours;
          upd.amountCents = Math.round(correctedHours * rate * 100);
          upd.basePay = Math.round(correctedHours * rate * 100) / 100;
          upd.grossPay = Math.round(correctedHours * rate * 100) / 100;
        }
        await shiftSnap.ref.update(upd);
      } else {
        // Pushback requires admin mediation; never write the retired `disputed` state.
        await shiftSnap.ref.update({ status: "disputed_admin_review", caregiverCorrectionResponse: "pushback", correctionRespondedAt: nowIso, caregiverDisputeNote: corrMsg ?? "" });
        await db.collection("admin_alerts").add({ type: "shift_hour_dispute", appointmentId, caregiverId, clientId: shift.clientId ?? null, priority: "medium", resolved: false, createdAt: nowIso }).catch(() => {});
      }
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_client_session" };
      if (shift.clientId) {
        const clientSessSnap = await db.collection("agent_sessions").where("userId", "==", shift.clientId).limit(1).get();
        if (!clientSessSnap.empty) {
          const { trySend } = await import("../utils/toolNotify");
          const msg = decision === "accept"
            ? `Your caregiver accepted the corrected hours${correctedHours != null ? ` (${correctedHours}h)` : ""}. Reply APPROVE to finalize payment.`
            : `Your caregiver pushed back on the hour correction. ${(corrMsg as string) ?? "I flagged it for admin review."}`;
          notification = await trySend(clientSessSnap.docs[0].id, msg, "mcp:respond_to_shift_hour_correction");
        }
      }
      logAudit({ eventType: "shift_hour_correction_responded", userId: caregiverId as string, data: { source: "mcp:respond_to_shift_hour_correction", appointmentId, decision, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, decision, appointmentId, status: decision === "accept" ? "pending_client_review" : "disputed_admin_review", notification };
      });
    }

    // request_standard_payout was removed 2026-07-06: Stripe rejects manual
    // standard payouts on the automatic daily schedule our Connect accounts
    // use, and the daily auto-sweep already delivers earnings for free.
    // Instant payout (above) remains the only on-demand payout.

    if (name === "create_caregiver_referral") {
      return runActionNativeMcpWrite(name, input, async () => {
      const caregiverId = stringInput(input, "caregiverId");
      const phone = stringInput(input, "phone");
      const referredName = stringInput(input, "referredName");
      const referredPhone = stringInput(input, "referredPhone");
      if (!caregiverId || !phone || !referredName || !referredPhone) {
        return toolError("INVALID_INPUT", "caregiverId, phone, referredName, and referredPhone are required");
      }
      const referrerName = await resolveCaregiverReferralName(caregiverId, phone);
      const result = await createCaregiverReferralInvite({
        referrerUserId: caregiverId,
        referrerPhone: phone,
        referrerName,
        referredName,
        referredPhone,
        source: "cara_sms",
      });
      return {
        ...result,
        status: "invited",
        referredRole: "caregiver",
        checkrRequired: true,
      };
      });
    }

    if (name === "resume_execution_agent") {
      const { agentId, input: agentInput } = input as { agentId: string; input: string };
      if (!agentId || !agentInput) return toolError("INVALID_INPUT", "agentId and input are required");
      const { runExecutionAgentTurn } = await import("../agents/executionAgent");
      const reply = await runExecutionAgentTurn(agentId, agentInput);
      if (!reply) return toolError("UNAVAILABLE", "Execution agent is no longer active");
      return { success: true, reply };
    }

    if (name === "create_support_ticket") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { userId, userType, subject, description: ticketDesc, category } = input as Record<string, unknown>;
      if (!userId || !userType || !subject || !ticketDesc) return toolError("INVALID_INPUT", "userId, userType, subject, and description are required");
      const ticketRef = await db.collection("support_tickets").add({ userId, userType, subject, description: ticketDesc, category: category ?? "other", status: "open", source: "cara_sms", createdAt: nowIso, resolved: false });
      await db.collection("admin_alerts").add({ type: "support_ticket_created", ticketId: ticketRef.id, userId, userType, subject, priority: "medium", resolved: false, createdAt: nowIso });
      logAudit({ eventType: "support_ticket_created", userId: userId as string, data: { source: "mcp:create_support_ticket", ticketId: ticketRef.id, subject } }).catch(() => {});
      return { success: true, ticketId: ticketRef.id };
      });
    }

    // ── schedule_interview ──────────────────────────────────────────────────
    if (name === "schedule_interview") {
      const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType, jobId, notes } = input as Record<string, unknown>;
      if (!clientId || !caregiverId || !preferredDate || !preferredTime) return toolError("INVALID_INPUT", "clientId, caregiverId, preferredDate, and preferredTime are required");
      // Mirrors the website's own paywall for the same 'interview' action
      // (hooks/useAccessGates.tsx) — was entirely ungated here before.
      const gateError = await checkClientAccessGate(clientId as string, "interview", { phone: (input as Record<string, unknown>).phone });
      if (gateError) return gateError;

      return createVideoInterviewRequestForTool({
        clientId: clientId as string, caregiverId: caregiverId as string,
        applicationId: applicationId as string | undefined,
        jobId: jobId as string | undefined,
        notes: notes as string | undefined,
        phone: input.phone as string | undefined,
        preferredDate: preferredDate as string, preferredTime: preferredTime as string,
        interviewType: interviewType as string | undefined,
        confirmedActionId,
      });
    }

    // ── resend_caregiver_profile ────────────────────────────────────────────
    if (name === "resend_caregiver_profile") {
      const { clientId, caregiverId, phone } = input as Record<string, unknown>;
      if (!clientId || !caregiverId) return toolError("INVALID_INPUT", "clientId and caregiverId are required");
      if (!phone) return toolError("INVALID_INPUT", "phone is required");
      const sessSnap = await db.collection("agent_sessions").doc(phone as string).get();
      const chatId = sessSnap.data()?.chatId as string | undefined;
      if (!chatId) return toolError("NOT_FOUND", "No active conversation to send the profile to");
      // Same eligibility gate requestVideoInterview uses — only a caregiver
      // visible in the public, verification-gated projection can be shared.
      const cgSnap = await db.collection("publicCaregiverProfiles").doc(caregiverId as string).get();
      if (!cgSnap.exists) return toolError("NOT_FOUND", "That caregiver is no longer available");
      const cg = cgSnap.data() ?? {};
      const cgName = ((cg.name as string) || `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver";
      const rate = (cg.hourlyRate as number | undefined) ?? null;
      const specialties = ((cg.specialties as string[] | undefined) ?? []).slice(0, 3).join(", ");
      const { sendMessage } = await import("../linq/client");
      // Same caption + tappable-link format the initial match gallery sends
      // (matchingAgent.ts) — the link auto-previews with this caregiver's
      // name + photo via /p/{id}'s Open Graph tags, so no separate photo
      // bubble is needed.
      await sendMessage(chatId,
        `${cgName}${rate ? ` — $${rate}/hr` : ""}${specialties ? `\n${specialties}` : ""}\n` +
        `Tap to view ${cgName.split(" ")[0]}'s profile: ${getAppUrl()}/p/${caregiverId as string}`
      );
      logAudit({ eventType: "message_sent", userId: clientId as string, data: { source: "mcp:resend_caregiver_profile", caregiverId } }).catch(() => {});
      return {
        success: true,
        sent: true,
        caregiverName: cgName,
        instruction: "The profile has ALREADY been texted to the family — it lands before your reply. Do NOT repeat the name, rate, or link; just acknowledge briefly.",
      };
    }

    // ── respond_to_interview_request ────────────────────────────────────────
    if (name === "respond_to_interview_request") {
      const { caregiverId, interviewId, decision, proposedDate, proposedTime, message: ivMsg } = input as Record<string, unknown>;
      if (!caregiverId || !interviewId || !decision) return toolError("INVALID_INPUT", "caregiverId, interviewId, and decision are required");
      const { respondToInterviewRequest, InterviewResponseError } = await import("../agents/interviewResponse");
      try {
        const result = await respondToInterviewRequest({
          caregiverId: caregiverId as string,
          interviewId: interviewId as string,
          decision: decision === "accept" ? "accept" : "decline",
          proposedDate: proposedDate as string | undefined,
          proposedTime: proposedTime as string | undefined,
          message: ivMsg as string | undefined,
          source: "mcp:respond_to_interview_request",
        });
        return { success: true, decision, interviewId, callUrl: result.callUrl, proposedTime: result.proposedTime };
      } catch (err) {
        if (err instanceof InterviewResponseError) {
          return toolError(
            err.code === "not-found" ? "NOT_FOUND" : err.code === "permission-denied" ? "PERMISSION_DENIED" : "INVALID_INPUT",
            err.message,
          );
        }
        throw err;
      }
    }

    // ── get_care_team ───────────────────────────────────────────────────────
    if (name === "get_care_team") {
      const { clientId, tab, query } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");

      // components/client/MyCareTeam.tsx loadTeam, exactly.
      const [bookingsSnap, liveShiftsSnap, completedIvSnap] = await Promise.all([
        db.collection("booking_requests").where("clientId", "==", clientId).limit(100).get(),
        db.collection("shifts").where("clientId", "==", clientId).where("status", "in", ["scheduled", "in-progress"]).get(),
        db.collection("video_interviews").where("clientId", "==", clientId).where("status", "==", "completed").get(),
      ]);
      const completedInterviewIds = new Set<string>(completedIvSnap.docs.map((d) => String(d.data().caregiverId ?? "")).filter(Boolean));
      const activeBookingIds = new Set<string>(liveShiftsSnap.docs.map((d) => String(d.data().bookingRequestId ?? "")).filter(Boolean));

      type BookingPick = { bookingId: string; b: FirebaseFirestore.DocumentData };
      const activeByCg = new Map<string, BookingPick>();
      const pastByCg = new Map<string, BookingPick>();
      const tsOf = (b: FirebaseFirestore.DocumentData) => Number(b.updatedAt?.seconds ?? b.createdAt?.seconds ?? 0);
      for (const doc of bookingsSnap.docs) {
        const b = doc.data();
        const cid = b.caregiverId as string | undefined;
        if (!cid) continue;
        if (b.status === "accepted" && activeBookingIds.has(doc.id)) {
          activeByCg.set(cid, { bookingId: doc.id, b });
        } else if (["cancelled", "completed"].includes(String(b.status)) || (b.status === "accepted" && !activeBookingIds.has(doc.id))) {
          // Keep the most recent past booking per caregiver.
          const existing = pastByCg.get(cid);
          if (!existing || tsOf(b) > tsOf(existing.b)) pastByCg.set(cid, { bookingId: doc.id, b });
        }
      }
      // One card per caregiver — Active OR Past, never both.
      for (const cid of activeByCg.keys()) pastByCg.delete(cid);

      const buildCard = async (cid: string, pick: BookingPick, active: boolean) => {
        const cgSnap = await db.collection("publicCaregiverProfiles").doc(cid).get().catch(() => null);
        const cg = (cgSnap?.exists ? cgSnap.data() : {}) as Record<string, unknown>;
        const b = pick.b;
        const name = String(b.caregiverName || cg.name || `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim() || "Caregiver");
        const dst = b.schedule?.dayShiftTimes;
        const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
        const scheduleDays: string[] = (dst && typeof dst === "object" ? Object.keys(dst) : ((b.schedule?.days as string[] | undefined) ?? []))
          .slice().sort((x, y) => WEEK.indexOf(x.slice(0, 3).toLowerCase()) - WEEK.indexOf(y.slice(0, 3).toLowerCase()));
        const recipients = (Array.isArray(b.careRecipients) ? b.careRecipients : []) as Array<{ firstName?: string; name?: string }>;
        const rating = Number(cg.rating ?? 0);
        const reviewCount = Number(cg.reviewCount ?? cg.totalReviews ?? 0);
        const bookingRate = (b.rate as number | undefined) ?? null;
        const hourlyRate = Number(cg.hourlyRate ?? 0);
        const canRebook = !active && completedInterviewIds.has(cid);
        return {
          caregiverId:    cid,
          bookingId:      pick.bookingId,
          bookingStatus:  String(b.status ?? ""),
          name,
          photoURL:       (b.caregiverPhotoURL || cg.photoURL || cg.photo || cg.profilePhoto || cg.imageUrl || null) as string | null,
          active,
          statusLabel:    active ? "Active booking" : "Past",
          rating,
          reviewCount,
          ratingLabel:    reviewCount > 0 ? `${rating.toFixed(1)} (${reviewCount})` : "No reviews yet",
          verified:       cg.verificationStatus === "approved" || cg.verificationStatus === "checkr_clear",
          yearsExperience: Number(cg.yearsExperience ?? 0),
          rate:           bookingRate ?? (hourlyRate || null),
          scheduleDays,
          specialties:    ((cg.specializations ?? cg.specialties ?? []) as string[]).slice(0, 3),
          caringFor:      recipients.map((r) => r.firstName || r.name || "Recipient").join(", ") || null,
          careRecipients: recipients.map((r) => r.firstName || r.name || "Recipient"),
          actions:        ["message", "profile", ...(canRebook ? ["rebook"] : [])],
        };
      };

      const q = String(query ?? "").trim().toLowerCase();
      const byName = (c: { name: string }) => !q || c.name.toLowerCase().includes(q);
      const which = tab === "active" || tab === "past" ? tab : "both";
      const activeCards = which === "past" ? [] : (await Promise.all([...activeByCg.entries()].map(([cid, p]) => buildCard(cid, p, true)))).filter(byName);
      const pastCards = which === "active" ? [] : (await Promise.all([...pastByCg.entries()].map(([cid, p]) => buildCard(cid, p, false)))).filter(byName);
      const careTeam = [...activeCards, ...pastCards];
      return { success: true, active: activeCards, past: pastCards, careTeam, total: careTeam.length, activeCount: activeByCg.size };
    }

    // ── get_invoice_history ─────────────────────────────────────────────────
    if (name === "edit_job_post") {
      const {
        jobId, clientId, rate, rateFlexible, description, jobFrequency, startDate, endDate, ongoing,
        daysOfWeek, timeOfDay, careTypes, petsInHome, smokingHousehold, caregiversNeeded, recipientsCount,
      } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap.exists) return toolError("NOT_FOUND", "Job post not found");
      const jp = jpSnap.data()!;
      if (jp.clientId !== clientId) return toolError("PERMISSION_DENIED", "This job post does not belong to you");
      if (jp.status !== "open") return toolError("INVALID_INPUT", `Cannot edit a job post with status '${jp.status}'`);
      // The website's EditJobPostModal payload, field for field, with its
      // rules (2026-09-16): careTypes can't be emptied, rateFlexible stores
      // rate 0, ongoing clears the end date. job_posts is flat — no nested
      // schedule object.
      const upd: Record<string, unknown> = { updatedAt: nowIso };
      if (description != null) upd.description = String(description).slice(0, 500);
      if (jobFrequency != null) {
        if (!["occasional", "part-time", "full-time"].includes(String(jobFrequency))) return toolError("INVALID_INPUT", "jobFrequency must be occasional, part-time, or full-time");
        upd.jobFrequency = jobFrequency;
      }
      const flex = rateFlexible != null ? Boolean(rateFlexible) : Boolean(jp.rateFlexible);
      if (rateFlexible != null) upd.rateFlexible = flex;
      if (flex) { if (rateFlexible != null || rate != null) upd.rate = 0; }
      else if (rate != null) {
        if (typeof rate !== "number" || !(rate > 0)) return toolError("INVALID_INPUT", "rate must be a positive number (or set rateFlexible)");
        upd.rate = rate;
      }
      if (startDate != null) upd.startDate = startDate;
      const isOngoing = ongoing != null ? Boolean(ongoing) : Boolean(jp.ongoing);
      if (ongoing != null) upd.ongoing = isOngoing;
      if (isOngoing) { if (ongoing != null || endDate != null) upd.endDate = ""; }
      else if (endDate != null) upd.endDate = endDate;
      if (daysOfWeek != null) upd.daysOfWeek = daysOfWeek;
      if (timeOfDay  != null) upd.timeOfDay  = timeOfDay;
      if (careTypes != null) {
        if (!Array.isArray(careTypes) || careTypes.length === 0) return toolError("INVALID_INPUT", "Select at least one care type");
        upd.careTypes = careTypes;
      }
      if (petsInHome != null) upd.petsInHome = Boolean(petsInHome);
      if (smokingHousehold != null) upd.smokingHousehold = Boolean(smokingHousehold);
      if (caregiversNeeded != null) upd.caregiversNeeded = Math.max(1, Math.floor(Number(caregiversNeeded) || 1));
      if (recipientsCount != null) upd.recipientsCount = Math.max(1, Math.floor(Number(recipientsCount) || 1));
      if (Object.keys(upd).length === 1) return toolError("INVALID_INPUT", "Nothing to change — pass at least one field");
      await jpSnap.ref.update(upd);
      // job_postings (the onboarding-contract mirror, clientJobPostingContract.ts)
      // uses ITS OWN field names for two of these — jobDescription (not
      // description) and selectedDays (not daysOfWeek). Only the fields that
      // mirror there are written; everything else lives on job_posts alone.
      const postingsUpd: Record<string, unknown> = { updatedAt: nowIso, clientId };
      if (upd.rate        !== undefined) postingsUpd.rate           = upd.rate;
      if (upd.description !== undefined) postingsUpd.jobDescription = upd.description;
      if (upd.startDate   !== undefined) postingsUpd.startDate      = upd.startDate;
      if (upd.daysOfWeek  !== undefined) postingsUpd.selectedDays   = upd.daysOfWeek;
      if (upd.timeOfDay   !== undefined) postingsUpd.timeOfDay      = upd.timeOfDay;
      if (upd.jobFrequency !== undefined) postingsUpd.jobFrequency  = upd.jobFrequency;
      if (upd.caregiversNeeded !== undefined) postingsUpd.caregiversNeeded = upd.caregiversNeeded;
      await db.collection("job_postings").doc(clientId as string).set(postingsUpd, { merge: true });
      logAudit({ eventType: "job_post_edited", userId: clientId as string, data: { source: "mcp:edit_job_post", jobId, fields: Object.keys(upd) } }).catch(() => {});
      return { success: true, jobId, updatedFields: Object.keys(upd).filter(k => k !== "updatedAt") };
    }

    // ── send_client_message ─────────────────────────────────────────────────
    if (name === "send_client_message") {
      const { caregiverId, message, clientId: clientIdInput } = input as Record<string, unknown>;
      if (!caregiverId || !message) return toolError("INVALID_INPUT", "caregiverId and message are required");
      const cgGateSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      const cgGateData = cgGateSnap.data() ?? {};
      // Mirrors useCaregiverGate's gateMembership() — InboxView.tsx blocks a
      // caregiver with an inactive membership from sending in the composer;
      // Evia must apply the same lower-stakes membership-only check.
      const cgMembershipActive = cgGateData.membershipStatus === "active"
        || cgGateData.membershipStatus === "trialing"
        || (!cgGateData.membershipStatus && cgGateData.membershipPaid === true);
      if (!cgMembershipActive) {
        return toolError("MEMBERSHIP_REQUIRED", "This caregiver's membership isn't active — they need an active membership before messaging a family.");
      }
      let resolvedClientId = clientIdInput as string | undefined;

      // If clientId is omitted we MUST verify the caregiver has an active or
      // recent engagement with that client. Previously this auto-resolved from
      // the most-recent appointment regardless of age or status, which let a
      // dismissed caregiver message any past client (IDOR).
      if (!resolvedClientId) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const activeOrRecent = await db.collection("appointments")
          .where("caregiverId", "==", caregiverId)
          .where("status",      "in", ["confirmed", "in-progress", "in_progress", "completed"])
          .orderBy("date", "desc")
          .limit(5)
          .get();
        const eligible = activeOrRecent.docs.find((d) => {
          const data = d.data();
          const date = data.date as string | undefined;
          const status = data.status as string | undefined;
          // Confirmed/in-progress regardless of date; completed only if within 30 days.
          // (both spellings: hyphen is canonical, underscore = legacy MCP starts)
          if (status === "confirmed" || status === "in-progress" || status === "in_progress") return true;
          if (status === "completed" && date && date >= thirtyDaysAgo) return true;
          return false;
        });
        if (eligible) resolvedClientId = eligible.data().clientId as string;
      } else {
        // Explicit clientId still requires verifying the relationship exists —
        // anyone could otherwise pass an arbitrary clientId to address.
        const relationship = await db.collection("appointments")
          .where("caregiverId", "==", caregiverId)
          .where("clientId",    "==", resolvedClientId)
          .where("status",      "in", ["confirmed", "in-progress", "in_progress", "completed"])
          .limit(1)
          .get();
        if (relationship.empty) {
          return toolError("FORBIDDEN", "No active or recent engagement with that client — cannot send message.");
        }
      }

      if (!resolvedClientId) {
        return toolError("FORBIDDEN", "No active engagement with any client — cannot send message. Ask the family to book a visit first.");
      }

      const clientSnap = await db.collection("users").doc(resolvedClientId).get();
      const cgName = cgGateData.name ?? "Your caregiver";
      // The Inbox composer, caregiver side — the thread write only; onMessageSent
      // notifies the family (in-app + the message texted to them), same as a
      // message typed on the website.
      const clientName = (clientSnap.data()?.name as string | undefined)
        ?? (clientSnap.data()?.firstName as string | undefined) ?? "";
      const { relayIntoSharedChatThread } = await import("../utils/chatThread");
      await relayIntoSharedChatThread({
        clientId: resolvedClientId, clientName,
        caregiverId: caregiverId as string, caregiverName: cgName as string,
        senderId: caregiverId as string, senderName: cgName as string,
        text: message as string,
      });
      logAudit({ eventType: "caregiver_sent_message", userId: caregiverId as string, data: { source: "mcp:send_client_message", resolvedClientId, messageLength: (message as string).length } }).catch(() => {});
      return { success: true, sent: true, sentTo: resolvedClientId, notification: { sent: true, via: "inbox" } };
    }

    // ── get_payout_history ──────────────────────────────────────────────────
    if (name === "get_payout_history") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const limit11 = Math.min((input.limit as number) ?? 5, 20);
      const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const { getCaregiverPayoutFields: getPayoutHist } = await import("../caregiverPrivate");
      const payoutFieldsHist = await getPayoutHist(caregiverId as string, cgSnap.data() ?? null);
      if (!payoutFieldsHist.stripeAccountId) return { success: true, payouts: [], message: "No payout account set up yet. Complete Stripe Connect onboarding to start receiving payouts." };
      try {
        const { getStripeClient } = await import("../stripe");
        const sc = getStripeClient();
        const payoutList = await sc.payouts.list({ limit: limit11 }, { stripeAccount: payoutFieldsHist.stripeAccountId as string });
        const payouts = payoutList.data.map((p) => ({
          id:        p.id,
          amount:    `$${(p.amount / 100).toFixed(2)}`,
          status:    p.status,
          method:    p.method,
          arrivalDate: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
          createdAt: new Date(p.created * 1000).toISOString().slice(0, 10),
        }));
        return { success: true, payouts, hasMore: payoutList.has_more };
      } catch (stripeErr) {
        console.error("get_payout_history stripe error:", stripeErr);
        return toolError("UNAVAILABLE", "Could not fetch payout history from Stripe right now");
      }
    }

    // ── get_recent_messages — the website's Inbox page ───────────────────
    if (name === "get_recent_messages") {
      const { userId, counterpartId, query: inboxQuery, role } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const msgLimit = Math.min((input.limit as number) ?? 20, 50);
      const { listInboxRooms, readInboxThread } = await import("../agents/inboxPage");
      if (counterpartId) {
        // Opening one conversation: its messages (after this user's cutoff), marked read like the page does.
        const thread = await readInboxThread(userId as string, counterpartId as string, msgLimit);
        if (!thread) return { success: true, thread: null, message: "No conversation with that person yet — the Inbox row shows 'Start a conversation' until the first message." };
        return { success: true, thread };
      }
      const inbox = await listInboxRooms(userId as string, {
        role: role === "caregiver" ? "caregiver" : "client",
        ...(typeof inboxQuery === "string" && inboxQuery.trim() ? { query: inboxQuery } : {}),
      });
      return { success: true, ...inbox };
    }

    // ── list_client_jobs ────────────────────────────────────────────────────
    if (name === "list_client_jobs") {
      const { clientId, status } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      let query: admin.firestore.Query = db.collection("job_posts").where("clientId", "==", clientId);
      // 'closed' = the site's Closed pill (anything not open) — filtered in memory.
      if (status && status !== "all" && status !== "closed") query = query.where("status", "==", status);
      const snap = await query.orderBy("createdAt", "desc").limit(status === "closed" ? 30 : 10).get();
      const docs = snap.docs.filter((d) => status !== "closed" || d.data().status !== "open").slice(0, 10);
      // The card's two live counts (PostsPage.tsx): pending applications and
      // accepted bookings tied to the post ("0 of 1 hired").
      const jobs = await Promise.all(docs.map(async (d) => {
        const data = d.data();
        const [pendingApps, hiredBookings] = await Promise.all([
          db.collection("job_applications").where("jobId", "==", d.id).where("clientId", "==", clientId).where("status", "==", "pending").get().catch(() => null),
          db.collection("booking_requests").where("jobId", "==", d.id).where("clientId", "==", clientId).where("status", "==", "accepted").get().catch(() => null),
        ]);
        const location = [data.city, data.state, data.zipCode].filter(Boolean).join(", ");
        return {
          id:                   d.id,
          title:                data.title ?? data.summary ?? `Care job — ${(data.careTypes as string[] ?? []).slice(0, 2).join(", ")}`,
          status:               data.status,
          jobFrequency:         data.jobFrequency ?? null,
          rate:                 data.rate ?? null,
          rateFlexible:         data.rateFlexible === true || !data.rate,
          description:          data.description ?? "",
          startDate:            data.startDate ?? data.date ?? null,
          startDayOfWeek:       weekdayForDate(String(data.startDate ?? data.date ?? "")),
          endDate:              data.endDate || null,
          ongoing:              data.ongoing === true || !data.endDate,
          location:             location || null,
          daysOfWeek:           data.daysOfWeek ?? [],
          timeOfDay:            data.timeOfDay ?? [],
          careTypes:            data.careTypes ?? [],
          petsInHome:           data.petsInHome ?? null,
          smokingHousehold:     data.smokingHousehold ?? null,
          recipientsCount:      data.recipientsCount ?? null,
          caregiversNeeded:     data.caregiversNeeded ?? 1,
          hiredCount:           hiredBookings?.size ?? 0,
          pendingApplicantCount: pendingApps ? pendingApps.size : (data.applicantCount ?? 0),
          applicantCount:       data.applicantCount ?? 0,
          createdAt:            data.createdAt,
        };
      }));
      return { success: true, jobs, total: jobs.length };
    }

    // ── cancel_job_post ─────────────────────────────────────────────────────
    if (name === "cancel_job_post") {
      const { jobId, clientId } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap.exists) return toolError("NOT_FOUND", "Job post not found");
      const jp = jpSnap.data()!;
      if (jp.clientId !== clientId) return toolError("PERMISSION_DENIED", "This job post does not belong to you");
      // Matches the website's own cancelJobPost exactly (services/api.ts) — the
      // real status value is `cancelled`, not `closed` (which nothing ever
      // wrote); "already closed" means any non-"open" status, same as the
      // site's own Open/Closed tab split (PostsPage.tsx: closed = status !== 'open').
      if (jp.status !== "open") return toolError("INVALID_INPUT", "Job post is already closed");
      await jpSnap.ref.update({ status: "cancelled", updatedAt: nowIso });
      logAudit({ eventType: "job_post_cancelled", userId: clientId as string, data: { source: "mcp:cancel_job_post", jobId } }).catch(() => {});
      return { success: true, jobId };
    }

    // ── list_job_applicants ─────────────────────────────────────────────────
    if (name === "list_job_applicants") {
      const { jobId, clientId, includeDecided } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap2 = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap2.exists) return toolError("NOT_FOUND", "Job post not found");
      if (jpSnap2.data()!.clientId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized");
      // The panel (PostsPage.tsx openApplicantsPanel) lists pending
      // applications only, and labels each row from this family's
      // interviews/bookings with that caregiver — same data, same rule.
      const [appSnap3, ivSnap3, brSnap3] = await Promise.all([
        db.collection("job_applications").where("jobId", "==", jobId).where("clientId", "==", clientId).limit(25).get(),
        db.collection("video_interviews").where("clientId", "==", clientId).get().catch(() => null),
        db.collection("booking_requests").where("clientId", "==", clientId).get().catch(() => null),
      ]);
      const bookingByKey = new Map<string, { id: string; status: string; ms: number }>();
      for (const d of brSnap3?.docs ?? []) {
        const b = d.data();
        const key = `${b.caregiverId}_${b.jobId ?? b.interviewId ?? ""}`;
        const raw = b.updatedAt ?? b.createdAt;
        const ms = typeof raw === "string" ? Date.parse(raw) : (raw?.toMillis?.() ?? 0);
        const cur = bookingByKey.get(key);
        if (!cur || ms > cur.ms) bookingByKey.set(key, { id: d.id, status: String(b.status ?? ""), ms });
      }
      const applicants = await Promise.all(
        appSnap3.docs
          .filter((d) => includeDecided === true || (d.data().status ?? "pending") === "pending")
          .map(async (d) => {
            const app = d.data();
            const cgSnap = await db.collection("caregivers").doc(app.caregiverId as string).get();
            const cg = cgSnap.data() ?? {};
            // An interview scheduled from the caregiver's profile (no jobId)
            // still counts as an existing relationship — same as the panel.
            const iv = (ivSnap3?.docs ?? []).map((x) => x.data()).find((x) => x.caregiverId === app.caregiverId && (!x.jobId || x.jobId === jobId));
            const booking = bookingByKey.get(`${app.caregiverId}_${jobId}`);
            const isHired = booking?.status === "accepted";
            const hasBooking = !!booking;
            const interviewInProgress = !!iv && ["requested", "accepted", "scheduled", "confirmed"].includes(String(iv.status));
            const interviewDone = !!iv && iv.status === "completed";
            const locked = isHired || hasBooking || interviewInProgress || interviewDone;
            const label = isHired ? "Hired" : hasBooking ? "Booking Sent" : interviewDone ? "Interviewed" : interviewInProgress ? "Interview Sent" : null;
            return {
              applicationId:  d.id,
              caregiverName:  (app.caregiverName ?? cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Unknown",
              caregiverId:    app.caregiverId,
              hourlyRate:     cg.hourlyRate ?? cg.rate ?? app.caregiverRate ?? null,
              proposedRate:   app.proposedRate ?? null,
              experience:     cg.experience ?? cg.yearsExperience ?? null,
              coverNote:      app.coverLetter ?? app.coverNote ?? null,
              status:         app.status ?? "pending",
              appliedAt:      app.appliedAt,
              rating:         cg.rating ?? null,
              // The panel's lock state: when locked, Request Interview / Decline are unavailable.
              locked,
              label,
              interviewStatus: iv?.status ?? null,
              bookingStatus:   booking?.status ?? null,
            };
          })
      );
      return { success: true, applicants, total: applicants.length };
    }

    // ── get_caregiver_earnings ──────────────────────────────────────────────
    if (name === "get_caregiver_earnings") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const cgSnap5 = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap5.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const cg5 = cgSnap5.data()!;
      const earnSnap = await db
        .collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("status", "==", "completed")
        .where("isoDate", ">=", daysAgo)
        .orderBy("isoDate", "desc")
        .limit(50)
        .get();
      const totalEarned = earnSnap.docs.reduce((sum, d) => sum + ((d.data().cost as number) ?? 0), 0);
      const { getCaregiverPayoutFields: getPayoutEarn } = await import("../caregiverPrivate");
      const payoutFieldsEarn = await getPayoutEarn(caregiverId as string, cg5);
      return {
        success:          true,
        totalEarned:      Math.round(totalEarned * 100) / 100,
        pendingBalance:   cg5.pendingBalance    ?? 0,
        stripeSetup:      !!payoutFieldsEarn.stripeAccountId,
        payoutsEnabled:   !!payoutFieldsEarn.payoutsEnabled,
        recentVisitCount: earnSnap.size,
        periodDays:       daysBack,
      };
    }

    // ── get_background_check_status ─────────────────────────────────────────
    if (name === "get_background_check_status") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const cgBgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgBgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const bg = (cgBgSnap.data()?.backgroundCheckData ?? {}) as Record<string, unknown>;
      const status           = (bg.status as string | undefined) ?? null;
      const invitationStatus = (bg.invitationStatus as string | undefined) ?? null;
      const submitted        = !!bg.submittedAt || !!bg.checkrCandidateId;

      // Map raw Checkr state to a single friendly summary the agent can phrase.
      let summary: string;
      if (!submitted && !status)                                       summary = "not_started";
      else if (status === "clear")                                     summary = "passed";
      else if (status === "consider")                                  summary = "needs_review";
      else if (status === "suspended")                                 summary = "suspended";
      else if (invitationStatus === "expired" || invitationStatus === "canceled") summary = `invitation_${invitationStatus}`;
      else                                                             summary = "in_progress";

      logAudit({ eventType: "health_data_accessed", userId: caregiverId as string, data: { source: "mcp:get_background_check_status" } }).catch(() => {});
      return {
        success:          true,
        summary,
        status,
        invitationStatus,
        submittedAt:      bg.submittedAt ?? null,
        completedAt:      bg.completedAt ?? null,
        mvrIncluded:      !!bg.mvrIncluded,
      };
    }

    // ── get_payout_status ────────────────────────────────────────────────────
    // Live Stripe Connect setup status so the agent answers payout questions
    // truthfully (added 2026-07-14 after Evia falsely claimed payouts were live).
    // Firestore-only, like get_background_check_status: reads the flags the
    // stripeConnectWebhook stamps. Errs toward "not active" if a flag is missing,
    // so it never reports payouts live when they aren't.
    if (name === "get_payout_status") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const cgPaySnap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgPaySnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
      const pay = await getCaregiverPayoutFields(caregiverId as string, (cgPaySnap.data() ?? {}) as Record<string, unknown>);
      const payoutsEnabled     = pay.payoutsEnabled === true;
      const onboardingComplete = pay.stripeOnboardingComplete === true;
      const detailsSubmitted   = pay.detailsSubmitted === true;
      const hasStripeAccount   = !!pay.stripeAccountId;

      let summary: string;
      if (payoutsEnabled || onboardingComplete) summary = "active";        // paid out automatically; nothing to do
      else if (!hasStripeAccount)               summary = "not_started";   // link never opened
      else if (detailsSubmitted)                summary = "under_review";  // Stripe has details, still finishing
      else                                      summary = "incomplete";    // started but Stripe's form unfinished

      return {
        success:                  true,
        summary,
        payoutsEnabled,
        stripeOnboardingComplete: onboardingComplete,
        detailsSubmitted,
        hasStripeAccount,
      };
    }

    // ── get_signup_completeness ──────────────────────────────────────────────
    // Final post-signup audit for BOTH roles (added 2026-07-14, founder ask).
    // Firestore-only: checks the canonical docs each role's finalization writes
    // (caregivers/{id} + private/payout + users/{uid}; users/{uid} +
    // senior_profiles/{uid} + carePlans/{uid}) so the agent reports real gaps
    // instead of guessing. Distinguishes hard gaps (`missing`, each with a fix
    // the agent can act on) from `optionalGaps` (never blockers).
    if (name === "get_signup_completeness") {
      const { caregiverId, clientId } = input as Record<string, unknown>;
      const filled = (v: unknown): boolean => {
        if (v === undefined || v === null) return false;
        if (typeof v === "string") return v.trim().length > 0;
        if (typeof v === "number") return v > 0;
        if (Array.isArray(v)) return v.length > 0;
        return true;
      };

      // ── Caregiver audit ────────────────────────────────────────────────────
      if (caregiverId) {
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
        const userSnap = await db.collection("users").doc(caregiverId as string).get().catch(() => null);
        const user = (userSnap?.data() ?? {}) as Record<string, unknown>;

        const missing: Array<{ item: string; detail: string; fix: string }> = [];
        const optionalGaps: string[] = [];

        // Profile fields (canonical caregivers/{uid} names — buildCaregiverProfileMirror)
        const profileChecks: Array<[string, boolean, string]> = [
          ["name",         filled(cg.name), "ask for it and save with update_caregiver_profile"],
          ["city",         filled(cg.city), "ask for it and save with update_caregiver_profile"],
          ["hourly rate",  filled(cg.hourlyRate), "ask for it and save with update_caregiver_profile"],
          ["experience",   filled(cg.yearsExperience) || filled(cg.experience), "ask for it and save with update_caregiver_profile"],
          ["services",     filled(cg.skills) || filled(cg.services) || filled(cg.specialties), "ask what care services they offer and save with update_caregiver_profile"],
          ["availability", filled(cg.availability) || filled(cg.weeklyAvailability), "ask for it and save with update_caregiver_availability"],
          ["job type",     filled(cg.jobType) || filled(cg.jobTypes), "ask full-time/part-time/one-time and save with update_caregiver_profile"],
          ["email",        filled(cg.email) || filled(user.email), "ask for it and save with update_caregiver_profile"],
        ];
        for (const [item, ok, fix] of profileChecks) {
          if (!ok) missing.push({ item: `profile: ${item}`, detail: `The ${item} field on their profile is empty.`, fix });
        }
        if (!filled(cg.bio) && cg.bioSkipped !== true) {
          optionalGaps.push("bio (they can add a short intro anytime — families like it, but it's optional)");
        }
        if (!filled(cg.photo) && !filled(cg.profilePhoto) && !filled(cg.photoURL)) {
          missing.push({
            item: "profile photo",
            detail: "No profile photo — families see a blank avatar.",
            fix: "send_onboarding_link (linkType caregiver_photo)",
          });
        }
        if (!filled(cg.documents) && !filled(cg.certifications)) {
          optionalGaps.push("certifications/documents (CNA, HHA, etc. — optional but boosts trust; send_onboarding_link linkType caregiver_documents)");
        }

        // Gates
        const membershipActive = cg.membershipPaid === true || user.membershipStatus === "active" || user.subscriptionActive === true;
        if (!membershipActive) {
          missing.push({
            item: "membership payment",
            detail: `Their ${caregiverAnnualAmount()}/yr membership hasn't been recorded as paid.`,
            fix: "send_onboarding_link (linkType caregiver_membership)",
          });
        }
        const bg = (cg.backgroundCheckData ?? {}) as Record<string, unknown>;
        const bgStarted = filled(bg.status) || filled(bg.submittedAt) || filled(bg.checkrCandidateId);
        let backgroundCheck: string;
        if (bg.status === "clear") backgroundCheck = "cleared";
        else if (bgStarted)        backgroundCheck = "in_progress";
        else {
          backgroundCheck = "not_started";
          missing.push({
            item: "background check",
            detail: "Their background check hasn't been started.",
            fix: "send_onboarding_link (linkType caregiver_background_check)",
          });
        }
        const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
        const pay = await getCaregiverPayoutFields(caregiverId as string, cg);
        const payoutsLive = pay.payoutsEnabled === true || pay.stripeOnboardingComplete === true;
        if (!payoutsLive) {
          missing.push({
            item: "payout setup",
            detail: pay.stripeAccountId
              ? "They started Stripe payout setup but haven't finished (bank/terms pending) — they can't get paid yet."
              : "Stripe payout setup hasn't been started — they can't get paid yet.",
            fix: "send_onboarding_link (linkType caregiver_payouts)",
          });
        }
        const visibleToFamilies = cg.onboardingStatus === "profile_complete";
        if (!visibleToFamilies) {
          missing.push({
            item: "profile visibility",
            detail: "Their profile isn't marked complete yet, so families can't find them in search. This usually resolves when the steps above are finished.",
            fix: "finish the remaining signup steps; if everything else is done, create_support_ticket so the team can activate them",
          });
        }

        return {
          success: true,
          role: "caregiver",
          complete: missing.length === 0,
          missing,
          optionalGaps,
          status: {
            membershipActive,
            backgroundCheck,
            payoutsLive,
            visibleToFamilies,
          },
        };
      }

      // ── Client / family audit ──────────────────────────────────────────────
      if (clientId) {
        const uSnap = await db.collection("users").doc(clientId as string).get();
        if (!uSnap.exists) return toolError("NOT_FOUND", "User not found");
        const u = (uSnap.data() ?? {}) as Record<string, unknown>;
        const seniorSnap = await db.collection("senior_profiles").doc(clientId as string).get().catch(() => null);
        const senior = seniorSnap?.exists ? (seniorSnap.data() ?? {}) as Record<string, unknown> : null;
        const planSnap = await db.collection("carePlans").doc(clientId as string).get().catch(() => null);

        const missing: Array<{ item: string; detail: string; fix: string }> = [];
        const optionalGaps: string[] = [];

        // Matches checkClientAccessGate/the website's hasActiveMembership():
        // 'trialing' counts as active too — this was missing, so a client
        // still in their trial got wrongly told membership wasn't active.
        const membershipActive = u.subscriptionActive === true || u.membershipStatus === "active" || u.membershipStatus === "trialing";
        if (!membershipActive) {
          missing.push({
            item: "membership payment",
            detail: `Their ${clientMonthlyAmount()}/mo membership isn't active — Evia can't start the caregiver search without it.`,
            fix: "send_onboarding_link (linkType client_payment)",
          });
        }
        if (!senior || !filled(senior.name)) {
          missing.push({
            item: "care recipient profile",
            detail: "There's no profile for the person receiving care (name/needs).",
            fix: "ask who the care is for and save with create_senior_profile",
          });
        } else {
          if (!filled(senior.needs)) {
            missing.push({
              item: "care needs",
              detail: `${senior.name}'s profile has no care needs listed — matching can't rank caregivers well.`,
              // No tool currently patches senior_profiles.needs for an EXISTING
              // senior (only create_senior_profile sets it, at creation time) —
              // flagged as a pre-existing gap, not fixed here.
              fix: "ask what help they need — care needs is set at profile creation (create_senior_profile); there is no tool to patch it afterward yet",
            });
          }
          if (!filled(senior.location) && !filled(senior.zipCode)) {
            missing.push({
              item: "care location",
              detail: "No city/ZIP on the care recipient's profile — needed to match nearby caregivers.",
              // Same gap as above — senior_profiles.location/zipCode has no
              // post-creation edit path either.
              fix: "ask for the city or ZIP — location is set at profile creation (create_senior_profile); there is no tool to patch it afterward yet",
            });
          }
          if (!filled(senior.age)) optionalGaps.push("care recipient's age");
        }
        if (!planSnap?.exists) {
          optionalGaps.push("care plan (built automatically from intake — if absent, offer to capture their needs with update_care_plan)");
        }
        if (!filled(u.name)) optionalGaps.push("account holder's name");

        return {
          success: true,
          role: "client",
          complete: missing.length === 0,
          missing,
          optionalGaps,
          status: { membershipActive, hasCareRecipientProfile: !!senior, hasCarePlan: !!planSnap?.exists },
        };
      }

      return toolError("INVALID_INPUT", "caregiverId or clientId is required");
    }

    // ── Checkr Candidate MCP bridge ──────────────────────────────────────────
    // Sessions live on Checkr's side (1 hour, one candidate, Mcp-Session-Id
    // header). Each turn is a separate function invocation, so the session id
    // is persisted per caregiver in checkr_mcp_sessions and reused by the
    // verify/report tools.
    if (name === "request_checkr_verification") {
      const { caregiverId, email } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return toolError("INVALID_INPUT", "A valid email is required");
      }
      const checkrMcp = await import("./checkrMcpClient");
      if (!checkrMcp.isCheckrMcpConfigured()) {
        return toolError("UNAVAILABLE",
          "Checkr report lookup isn't configured yet — use get_background_check_status for the current status.");
      }
      try {
        const mcpSessionId = await checkrMcp.initializeCheckrSession();
        const result = await checkrMcp.callCheckrTool(mcpSessionId, "request_candidate_verification", { email });
        if (result.isError) {
          return { error: true, message: result.text || "Checkr couldn't send a verification code to that email." };
        }
        await db.collection("checkr_mcp_sessions").doc(caregiverId as string).set({
          sessionId: mcpSessionId,
          email,
          verified:  false,
          createdAt: nowIso,
          // Checkr sessions last 1h; expire ours slightly earlier so we never
          // hand the agent a session Checkr has already evicted.
          expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        });
        return {
          success: true,
          message: "Checkr emailed the caregiver a one-time code. Ask them for it, then call verify_checkr_otp.",
        };
      } catch (e) {
        console.error("[request_checkr_verification] error:", e);
        return { error: true, message: "I couldn't reach Checkr just now. Try again in a moment." };
      }
    }

    if (name === "verify_checkr_otp") {
      const { caregiverId, code } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      if (!code) return toolError("INVALID_INPUT", "code is required");
      const sessRef  = db.collection("checkr_mcp_sessions").doc(caregiverId as string);
      const sessSnap = await sessRef.get();
      const sess = sessSnap.exists ? (sessSnap.data() as Record<string, unknown>) : null;
      if (!sess || (sess.expiresAt as string) < new Date().toISOString()) {
        return toolError("NOT_FOUND",
          "No active Checkr verification session — call request_checkr_verification first.");
      }
      const checkrMcp = await import("./checkrMcpClient");
      try {
        const result = await checkrMcp.callCheckrTool(
          sess.sessionId as string,
          "verify_candidate_otp",
          { email: sess.email, code: String(code).trim() },
        );
        if (result.isError) {
          return { error: true, message: result.text || "That code didn't verify — Checkr allows 3 attempts per session." };
        }
        await sessRef.set({ verified: true, verifiedAt: nowIso }, { merge: true });
        return { success: true, message: "Identity verified with Checkr. get_checkr_report is now available." };
      } catch (e) {
        if (e instanceof checkrMcp.CheckrMcpError && e.sessionExpired) {
          await sessRef.delete().catch(() => {});
          return toolError("NOT_FOUND",
            "The Checkr session expired — start over with request_checkr_verification.");
        }
        console.error("[verify_checkr_otp] error:", e);
        return { error: true, message: "I couldn't verify that with Checkr just now. Try again in a moment." };
      }
    }

    if (name === "get_checkr_report") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const sessRef  = db.collection("checkr_mcp_sessions").doc(caregiverId as string);
      const sessSnap = await sessRef.get();
      const sess = sessSnap.exists ? (sessSnap.data() as Record<string, unknown>) : null;
      if (!sess || !sess.verified || (sess.expiresAt as string) < new Date().toISOString()) {
        return toolError("PERMISSION_DENIED",
          "Checkr identity verification needed first — call request_checkr_verification, then verify_checkr_otp.");
      }
      const checkrMcp = await import("./checkrMcpClient");
      try {
        const result = await checkrMcp.callCheckrTool(sess.sessionId as string, "get_report", {});
        if (result.isError) {
          return { error: true, message: result.text || "Checkr couldn't return the report just now." };
        }
        logAudit({ eventType: "health_data_accessed", userId: caregiverId as string, data: { source: "mcp:get_checkr_report" } }).catch(() => {});
        return { success: true, report: result.data ?? result.text };
      } catch (e) {
        if (e instanceof checkrMcp.CheckrMcpError && e.sessionExpired) {
          await sessRef.delete().catch(() => {});
          return toolError("NOT_FOUND",
            "The Checkr session expired — start over with request_checkr_verification.");
        }
        console.error("[get_checkr_report] error:", e);
        return { error: true, message: "I couldn't pull the report from Checkr just now. Try again in a moment." };
      }
    }

    // ── update_caregiver_availability ───────────────────────────────────────
    if (name === "update_caregiver_availability") {
      const { caregiverId, availableDays, unavailableDays, preferredTimeOfDay } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const cgSnap6 = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap6.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const upd6: Record<string, unknown> = { updatedAt: nowIso, availabilityUpdatedAt: nowIso };
      // arrayUnion and arrayRemove can't share the same update key — assigning both
      // to upd6["availability"] silently discarded the additions when a single call
      // carried availableDays AND unavailableDays. Compute the final list instead.
      const currentAvail = Array.isArray(cgSnap6.data()?.availability)
        ? [...(cgSnap6.data()!.availability as string[])]
        : [];
      let nextAvail: string[] | null = null;
      if (Array.isArray(availableDays) && availableDays.length > 0)
        nextAvail = [...new Set([...currentAvail, ...(availableDays as string[])])];
      if (Array.isArray(unavailableDays) && unavailableDays.length > 0) {
        const removed = new Set(unavailableDays as string[]);
        nextAvail = (nextAvail ?? currentAvail).filter((d) => !removed.has(d));
      }
      if (nextAvail !== null) upd6["availability"] = nextAvail;
      if (typeof preferredTimeOfDay === "string")
        upd6["preferredTimeOfDay"] = preferredTimeOfDay;
      // Web parity: the caregiver calendar and swap/replacement matching read the
      // weeklyAvailability map ({ monday: [{start,end}], ... }) — keep it in sync
      // with the day list. Added days get a default day-window slot if absent.
      const existingWeekly = (cgSnap6.data()?.weeklyAvailability ?? {}) as Record<string, Array<{ start: string; end: string }>>;
      if (Array.isArray(availableDays)) {
        for (const day of availableDays as string[]) {
          const key = day.toLowerCase();
          if (!existingWeekly[key]?.length) {
            const slotStart = preferredTimeOfDay === "evening" ? "16:00" : preferredTimeOfDay === "afternoon" ? "12:00" : "08:00";
            const slotEnd   = preferredTimeOfDay === "morning" ? "12:00" : preferredTimeOfDay === "afternoon" ? "17:00" : "20:00";
            upd6[`weeklyAvailability.${key}`] = [{ start: slotStart, end: slotEnd }];
          }
        }
      }
      if (Array.isArray(unavailableDays)) {
        for (const day of unavailableDays as string[]) {
          upd6[`weeklyAvailability.${day.toLowerCase()}`] = admin.firestore.FieldValue.delete();
        }
      }
      await cgSnap6.ref.update(upd6);
      logAudit({ eventType: "caregiver_availability_updated", userId: caregiverId as string, data: { source: "mcp:update_caregiver_availability", availableDays, unavailableDays } }).catch(() => {});

      // 2026-09-09 (Hamse's call): interview_requests removed entirely — this
      // used to auto-reject pending candidate-presentation/negotiation
      // records that conflicted with newly-unavailable days. With no new
      // interview_requests docs ever created going forward, there's nothing
      // left for this to find; a real, already-scheduled interview conflict
      // is a video_interviews concern, not something this tool handled.
      return { success: true, updated: { availableDays: availableDays ?? [], unavailableDays: unavailableDays ?? [], preferredTimeOfDay: preferredTimeOfDay ?? null }, conflictingInterviewsCancelled: 0 };
    }

    // ── browse_job_board ────────────────────────────────────────────────────
    if (name === "browse_job_board") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const cgSnap7 = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap7.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const cg7 = cgSnap7.data() || {};
      const limit7 = Math.min((input.limit as number) ?? 5, 10);
      const RADIUS_MILES = 25; // match the push-notification radius (jobNotifications.ts)

      const cgLat = (cg7.latitude ?? cg7.location?.latitude ?? cg7.location?.lat) as number | undefined;
      const cgLng = (cg7.longitude ?? cg7.location?.longitude ?? cg7.location?.lng) as number | undefined;
      const hasCoords = typeof cgLat === "number" && typeof cgLng === "number";

      const alreadyApplied = await db.collection("job_applications").where("caregiverId", "==", caregiverId).get();
      const appliedJobIds = new Set(alreadyApplied.docs.map((d) => d.data().jobId as string));
      // Pull a wider window since we filter by distance below.
      const jobsSnap = await db.collection("job_posts").where("status", "==", "open").orderBy("createdAt", "desc").limit(50).get();

      const { haversineMiles } = await import("../ai/scoring");
      const scoped = jobsSnap.docs
        .filter((d) => !appliedJobIds.has(d.id))
        .map((d) => {
          const data = d.data();
          const jLat = data.location?.lat ?? data.location?.latitude;
          const jLng = data.location?.lng ?? data.location?.longitude;
          const dist = (hasCoords && typeof jLat === "number" && typeof jLng === "number")
            ? haversineMiles(cgLat as number, cgLng as number, jLat, jLng)
            : undefined;
          return {
            jobId:      d.id,
            summary:    data.summary ?? "Care job",
            careNeeds:  data.careTypes ?? [],
            schedule:   data.schedule  ?? {},
            hourlyRate: data.hourlyRate ?? null,
            location:   data.location?.city ?? "Nearby",
            distanceMiles: dist !== undefined ? Math.round(dist) : null,
          };
        })
        // Geo-scope only when we can compute distance for the job. Jobs without
        // coordinates are kept (can't determine), but out-of-radius jobs are dropped.
        .filter((j) => j.distanceMiles === null || j.distanceMiles <= RADIUS_MILES)
        .sort((a, b) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999))
        .slice(0, limit7);

      return {
        success:   true,
        jobs:      scoped,
        total:     scoped.length,
        geoScoped: hasCoords,
        radiusMiles: RADIUS_MILES,
      };
    }

    // ── get_my_applications ─────────────────────────────────────────────────
    if (name === "get_my_applications") {
      const { caregiverId } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const myAppSnap = await db.collection("job_applications").where("caregiverId", "==", caregiverId).orderBy("appliedAt", "desc").limit(10).get();
      const applications = await Promise.all(
        myAppSnap.docs.map(async (d) => {
          const app = d.data();
          const jpSnap3 = await db.collection("job_posts").doc(app.jobId as string).get().catch(() => null);
          const jp3 = jpSnap3?.data() ?? {};
          return {
            applicationId: d.id,
            jobId:         app.jobId,
            jobSummary:    jp3.summary ?? `Care job`,
            jobStatus:     jp3.status  ?? "unknown",
            status:        app.status  ?? "pending",
            appliedAt:     app.appliedAt,
            proposedRate:  app.proposedRate ?? null,
          };
        })
      );
      return { success: true, applications, total: applications.length };
    }

    // ── get_pending_timesheets ──────────────────────────────────────────────
    if (name === "get_pending_timesheets") {
      // The website's Timesheets page (Payments.tsx), exactly — see agents/timesheetsPage.ts.
      const { clientId, tab, from, to } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const { readTimesheetsPage } = await import("../agents/timesheetsPage");
      const page = await readTimesheetsPage(clientId as string, {
        tab: tab === "history" ? "history" : "needs_review",
        ...(typeof from === "string" && from ? { from } : {}),
        ...(typeof to === "string" && to ? { to } : {}),
      });
      return { success: true, ...page, total: page.rows.length };
    }

    if (name === "get_care_journal_client") {
      // The caregiver's notes from completed visits — shifts.notesLog + the closing
      // note — exactly what the Past Bookings card shows and the recap texts carry.
      // Replaced the legacy care_journal read (2026-09-20): nothing on the site writes
      // or shows that collection. No orderBy: two equality filters + a JS sort avoids
      // a composite index.
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const limit9 = Math.min((input.limit as number) ?? 5, 20);
      logAudit({ eventType: "health_data_accessed", userId: clientId as string, data: { source: "mcp:get_care_journal_client" } }).catch(() => {});
      const vSnap = await db.collection("shifts").where("clientId", "==", clientId as string).where("status", "==", "completed").limit(60).get();
      const entries = vSnap.docs
        .map((d): Record<string, unknown> & { id: string } => ({ ...(d.data() as Record<string, unknown>), id: d.id }))
        .sort((a, b) => String(b.completedAt ?? b.date ?? "").localeCompare(String(a.completedAt ?? a.date ?? "")))
        .slice(0, limit9)
        .map((sh) => {
          const log = (Array.isArray(sh.notesLog) ? sh.notesLog : []) as Array<{ at?: string; text?: string }>;
          const closing = typeof sh.completionNotes === "string" && sh.completionNotes.trim() ? sh.completionNotes.trim() : null;
          const notes = [...log.map((n) => String(n.text ?? "").trim()).filter(Boolean), ...(closing ? [closing] : [])];
          return {
            shiftId:       sh.id,
            date:          sh.date ?? null,
            timestamp:     sh.completedAt ?? sh.date ?? null,
            caregiverName: sh.caregiverName ?? "Caregiver",
            notes:         notes.length ? notes.join(" | ") : null,
            notesLog:      log,
            closingNote:   closing,
            tasksDone:     Array.isArray(sh.tasksCompleted) ? sh.tasksCompleted.length : 0,
          };
        });
      return { success: true, entries, total: entries.length, instruction: "These are the caregiver's own words from completed visits (the Past Bookings card). Quote or paraphrase them only; never add observations about how anyone is doing. A visit with notes: null had no notes — say so." };
    }

    // ── get_payment_update_link ─────────────────────────────────────────────
    if (name === "get_payment_update_link") {
      // The Payment Method tab (Payments.tsx): customers/{uid}.stripeCustomerId decides
      // "Add a card" (→ the membership page) vs "Manage payment method" (Stripe Billing
      // Portal, back to /client/payments); "Card on file" is the live Stripe check the
      // page makes (v1-getPaymentMethodStatus, shared as getPaymentMethodStatusFor).
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const custSnap = await db.collection("customers").doc(clientId as string).get().catch(() => null);
      const stripeCustomerId = custSnap?.data()?.stripeCustomerId as string | undefined;
      const appUrl = getAppUrl();
      let card: { hasCard: boolean; brand?: string | null; last4?: string | null } = { hasCard: false };
      try {
        const { getPaymentMethodStatusFor } = await import("../stripe");
        card = await getPaymentMethodStatusFor(clientId as string);
      } catch (err) {
        console.warn("get_payment_update_link: card status check failed", err instanceof Error ? err.message : err);
      }
      if (!stripeCustomerId) {
        return {
          success: true, hasCard: false, cardOnFile: null, action: "add_card", url: `${appUrl}/client/membership`,
          message: "No card on file — the page's 'Add a card' sends the family to the membership page to add one. Send them that link; never ask for card details.",
        };
      }
      const { getStripeClient } = await import("../stripe");
      const session = await getStripeClient().billingPortal.sessions.create({
        customer:   stripeCustomerId,
        return_url: `${appUrl}/client/payments`,
      });
      logAudit({ eventType: "billing_portal_opened", userId: clientId as string, data: { source: "mcp:get_payment_update_link" } }).catch(() => {});
      return {
        success: true, hasCard: card.hasCard,
        cardOnFile: card.hasCard ? { brand: card.brand ?? null, last4: card.last4 ?? null } : null,
        action: card.hasCard ? "manage_payment_method" : "add_card",
        url: session.url, expiresIn: "5 minutes",
      };
    }

    if (name === "retry_shift_payment") {
      const { appointmentId, clientId } = input as Record<string, unknown>;
      if (!appointmentId || !clientId) return toolError("INVALID_INPUT", "appointmentId and clientId are required");

      const ref  = db.collection("shiftHours").doc(appointmentId as string);
      const snap = await ref.get();
      if (!snap.exists) return toolError("NOT_FOUND", "No shift record found for that appointment.");
      const shift = snap.data()!;
      if (shift.clientId !== clientId) return toolError("PERMISSION_DENIED", "This visit doesn't belong to this family.");
      if (shift.status !== "payment_failed") {
        return toolError(
          "INVALID_INPUT",
          `This visit's payment is not in a failed state (current status: ${shift.status}). ` +
          "Nothing to retry — if they think a payment is wrong, check get_shifts / get_invoice_history.",
        );
      }

      const retry = await resetShiftPaymentForRetry({
        appointmentId: appointmentId as string,
        shiftRef: ref,
        shift,
      });
      logAudit({ eventType: "shift_payment_retried", userId: clientId as string, data: { source: "mcp:retry_shift_payment", appointmentId, retryCount: retry.retryCount } }).catch(() => {});
      return {
        success: true,
        appointmentId,
        guidance:
          "The payment is being retried now. Tell the family you've re-run it and you'll let them know if it " +
          "fails again — do NOT promise it succeeded; the charge happens asynchronously. If it fails again, " +
          "send get_payment_update_link so they can fix their card.",
      };
    }

    // ── send_onboarding_link ────────────────────────────────────────────────
    if (name === "send_onboarding_link") {
      const { linkType, phone } = input as Record<string, unknown>;
      if (!phone) return toolError("INVALID_INPUT", "phone is required");
      const validTypes = [
        "client_payment", "client_identity", "caregiver_membership",
        "caregiver_photo", "caregiver_documents", "caregiver_background_check", "caregiver_payouts",
      ];
      if (!linkType || !validTypes.includes(linkType as string)) {
        return toolError("INVALID_INPUT", `linkType must be one of: ${validTypes.join(", ")}`);
      }
      try {
        const { runSendOnboardingLinkAction } = await import("../agents/actions/sendOnboardingLinkAction");
        return await runSendOnboardingLinkAction(
          { phone, linkType },
          {
            caller: "mcp",
            role: linkType === "client_payment" || linkType === "client_identity" ? "client" : "caregiver",
            phone: phone as string,
          },
        );
      } catch (err) {
        console.error("send_onboarding_link error:", err);
        return toolError("UNAVAILABLE", "Couldn't generate that link right now — try again in a moment.");
      }
    }

    // ── save_onboarding_field (U1) ──────────────────────────────────────────
    // The agent loop's per-field write during onboarding. Session-only mutation:
    // merges one field into agent_sessions/{phone}.onboardingData and returns the
    // required fields still missing for that role.
    if (name === "save_onboarding_field") {
      const { phone, role, fieldName } = input as Record<string, unknown>;
      const fieldValue = (input as Record<string, unknown>).fieldValue;
      if (!phone) return toolError("INVALID_INPUT", "phone is required");
      if (role !== "client" && role !== "caregiver") {
        return toolError("INVALID_INPUT", "role must be 'client' or 'caregiver'");
      }
      if (typeof fieldName !== "string" || !fieldName.trim()) {
        return toolError("INVALID_INPUT", "fieldName is required");
      }
      const { isAllowedField, missingRequiredFields, normalizeOnboardingFieldValue, isNumericOnboardingField, coerceNumericOnboardingField, CAREGIVER_JOB_TYPES } = await import("../agents/onboardingContract");
      if (!isAllowedField(role, fieldName)) {
        return toolError("INVALID_INPUT", `'${fieldName}' is not a collectable onboarding field for a ${role}.`);
      }
      if (fieldValue === undefined || fieldValue === null || (fieldValue === "" && !(role === "caregiver" && fieldName === "bio"))) {
        return toolError("INVALID_INPUT", "fieldValue is required");
      }
      // Numeric fields (daysPerWeek/hoursPerDay/age) must coerce to an in-range
      // number — never persist prose into them (a prod session stored
      // daysPerWeek: "santa clara" and the intake showed "santa clara days/week").
      if (isNumericOnboardingField(fieldName) && coerceNumericOnboardingField(fieldName, fieldValue) === null) {
        return {
          ok: true,
          saved: false,
          invalidValue: true,
          guidance: `"${String(fieldValue)}" isn't a valid ${fieldName} value — it must be a number. Re-read their message; if it doesn't actually answer ${fieldName}, save it to the right field instead and ask for ${fieldName} naturally.`,
        };
      }
      // Recovery email must actually look like an email — it's the sole
      // account-recovery channel if the phone is ever lost, so a malformed
      // save here can't be allowed to silently count as "collected" the way
      // an ordinary free-text field would.
      if (role === "client" && fieldName === "email" && typeof fieldValue === "string" && !/^\S+@\S+\.\S+$/.test(fieldValue.trim())) {
        return {
          ok: true,
          saved: false,
          invalidValue: true,
          guidance: `"${fieldValue}" doesn't look like a valid email address — ask them for it again.`,
        };
      }
      // Canonicalize enum-ish values the model may save in free-form casing
      // ("Full time" → "full_time"); otherwise the raw string is copied onto the
      // caregiver doc where matching expects occasional|part_time|full_time.
      // The recipient photo is a picture the family attached — the inbound media
      // handler stores it and fills this field itself. A typed reply is never a
      // photo (a prod account ended up with photoURL "skipped" → broken avatar).
      if (fieldName === "careRecipientPhotoURL" && !/^https?:\/\//i.test(String(fieldValue ?? "").trim())) {
        return {
          ok: true,
          saved: false,
          invalidValue: true,
          guidance: `careRecipientPhotoURL only takes the link of a photo the family actually attached — it is filled automatically when a picture comes in. "${String(fieldValue)}" is a typed reply, not a photo: save nothing for it. The photo is optional, so if they'd rather skip it just move on; they can text a picture any time or add one later from Account Settings.`,
        };
      }
      const normalizedValue = normalizeOnboardingFieldValue(fieldName, fieldValue);
      if (fieldName === "jobType" && typeof normalizedValue === "string" && !CAREGIVER_JOB_TYPES.has(normalizedValue)) {
        console.info("save_onboarding_field: jobType value not canonical after normalization — keeping raw", { phone, raw: fieldValue });
      }
      let onboardingDataPatch: Record<string, unknown> = { [fieldName]: normalizedValue };
      // Care-services canonicalization: keep the caregiver's RAW specialties as
      // profile flavor, and also write the canonical skills/services enum the
      // webapp checkboxes + matching engine read. Never let a canonicalization
      // failure lose the specialties — the raw value is already in the patch.
      if (role === "caregiver" && fieldName === "specialties") {
        try {
          const { canonicalizeCaregiverServices } = await import("../agents/caregiverServices");
          const canonical = await canonicalizeCaregiverServices(normalizedValue);
          if (canonical.length) {
            onboardingDataPatch = { specialties: normalizedValue, skills: canonical, services: canonical };
          }
        } catch (err) {
          console.error("save_onboarding_field: service canonicalization failed (keeping raw specialties):", err);
        }
      }
      // Availability shape guard: the model sometimes saves the caregiver's
      // words verbatim ("mornings and evenings") instead of the {days,hours}
      // object deriveWeeklyAvailability needs — the caregivers doc then keeps a
      // stale/missing weeklyAvailability and the webapp grid never updates.
      // Coerce every save into the canonical object at write time; on failure
      // the raw value stays (deriveWeeklyAvailability now parses strings too).
      if (role === "caregiver" && fieldName === "availability") {
        try {
          const { normalizeAvailabilityInput } = await import("../agents/caregiverAvailability");
          const canonical = await normalizeAvailabilityInput(normalizedValue);
          if (canonical) onboardingDataPatch = { availability: canonical };
        } catch (err) {
          console.error("save_onboarding_field: availability normalization failed (keeping raw):", err);
        }
      }
      if (role === "caregiver" && fieldName === "bio" && typeof fieldValue === "string") {
        try {
          const { quickComplete } = await import("../utils/openaiClient");
          const raw = await quickComplete(
            "Classify whether this caregiver is explicitly choosing to skip writing a public profile bio. Reply exactly SKIP or BIO. SKIP only for clear skip/no bio/not now intent. Otherwise BIO.",
            fieldValue,
            { maxTokens: 5 },
          );
          if (raw.trim().toUpperCase() === "SKIP") {
            onboardingDataPatch = { bio: "", bioSkipped: true };
          } else {
            onboardingDataPatch = { bio: fieldValue.trim(), bioSkipped: false };
          }
        } catch (err) {
          console.error("save_onboarding_field bio skip classification error:", err);
          return toolError("UNAVAILABLE", "Couldn't process that bio preference right now - ask the caregiver to share a short bio or confirm they want to skip it.");
        }
      }
      // Zip → city/state auto-derivation (2026-08-22) — mirrors the website
      // wizard's zippopotam.us lookup exactly, so the model is never asked (or
      // trusted) to extract a city from free text. Closes a live bug: a street
      // named "Campbell Ave" got mistaken for the city "Campbell" when the
      // model parsed a combined "what's your address" answer. City/state are
      // ALWAYS overwritten from a valid zip, matching the wizard's own
      // behavior of re-deriving them whenever the zip changes.
      if (role === "client" && fieldName === "zipCode" && typeof normalizedValue === "string") {
        const { lookupZipPlace } = await import("../utils/geocode");
        const place = await lookupZipPlace(normalizedValue).catch(() => null);
        if (place?.city) onboardingDataPatch = { ...onboardingDataPatch, city: place.city, state: place.state };
      }
      // "Is care at the same address?" confirmation (2026-08-22) — a live test
      // showed this question skipped entirely, with the model silently
      // assuming same-address and never asking. Now a required, explicitly
      // saved field; answering true auto-mirrors the already-collected home
      // fields into the care-address fields, matching the wizard's own
      // homeCity→city/homeZipCode→zipCode/homeStreet→street/homeState→state
      // copy (WIZARD QUESTION ORDER item 3).
      if (role === "client" && fieldName === "sameAsHomeAddress" && normalizedValue === true) {
        const existingSnap = await db.collection("agent_sessions").doc(phone as string).get();
        const existing = (existingSnap.data()?.onboardingData ?? {}) as Record<string, unknown>;
        onboardingDataPatch = {
          ...onboardingDataPatch,
          ...(existing.homeStreet   ? { street: existing.homeStreet }   : {}),
          ...(existing.homeCity     ? { city:   existing.homeCity }     : {}),
          ...(existing.homeZipCode  ? { zipCode: existing.homeZipCode } : {}),
          ...(existing.homeState    ? { state:  existing.homeState }    : {}),
        };
      }
      if (role === "client" && fieldName === "homeZipCode" && typeof normalizedValue === "string") {
        const { lookupZipPlace } = await import("../utils/geocode");
        const place = await lookupZipPlace(normalizedValue).catch(() => null);
        if (place?.city) onboardingDataPatch = { ...onboardingDataPatch, homeCity: place.city, homeState: place.state };
      }
      const ref  = db.collection("agent_sessions").doc(phone as string);
      await ref.set({ onboardingData: onboardingDataPatch }, { merge: true });
      // R-MEM-1/2: durable capture begins here, at name+number — this merge
      // persists every field as it's collected, and the webhook already logs each
      // onboarding message to Zep from first contact. On resume, the onboarding
      // directive (buildOnboardingDirective) reads this onboardingData so Evia
      // recalls what's known and never re-asks. The rich memory_files bootstrap
      // intentionally stays at completion (initializeMemoryFiles is uid-keyed; the
      // account uid does not exist until payment, so an early phone-keyed bootstrap
      // would orphan from the completion record). See onboardingContract notes.
      const snap = await ref.get();
      const data = (snap.data()?.onboardingData ?? {}) as Record<string, unknown>;
      // NOTE: client collection fields are intentionally NOT mirrored to
      // job_postings/senior_profiles/carePlans as each one is saved — matching
      // the web wizard, which writes nothing until its final step. The real
      // write happens once, at collection-complete (persistClientCareRecords,
      // called from handleClientShowCaregivers) and again at job-post
      // confirmation (buildAndSaveJobPost) — see clientJobPostingContract.ts.
      // Service-area gate (Santa Clara County only). When a location field is
      // saved, check coverage. Out → record a waitlist lead, park the session, and
      // tell the model to decline. need_zip → ask for a ZIP to confirm.
      if (fieldName === "city" || fieldName === "zipCode") {
        const { evaluateServiceArea } = await import("../config/serviceArea");
        const sa = evaluateServiceArea({ city: data.city as string, zip: (data.zipCode as string) || (data.city as string) });
        if (sa === "out") {
          const { parkOutOfArea } = await import("../agents/serviceAreaGate");
          await parkOutOfArea({ phone: phone as string, role, city: (data.city as string) ?? "", zipCode: (data.zipCode as string) ?? "", name: (data.firstName as string) ?? (data.name as string) ?? "", onboardingData: data });
          return { ok: true, outOfArea: true, complete: false, guidance: "This location is OUTSIDE Evia's service area (Santa Clara County, California only). Warmly tell the user we don't serve their area yet and that you've added them to our waitlist and will reach out when we expand. Do NOT collect any more fields and do NOT call complete_collection." };
        }
        if (sa === "need_zip" && fieldName === "city") {
          return { ok: true, fieldName, saved: true, missing: missingRequiredFields(role, data), needZip: true, guidance: "Saved the city, but it isn't recognized — ask the user for their ZIP code to confirm we cover their area before continuing." };
        }
      }
      const missing = missingRequiredFields(role, data);
      // Email confirmations kept getting garbled/truncated in the model's own
      // free-text reply (e.g. "Got it, hamse143@" — dropping the domain) even
      // with a system-prompt instruction not to. Handing back the exact saved
      // string right here, at the point of generation, is far more reliable
      // than a static instruction written elsewhere in the prompt.
      const emailGuidance = fieldName === "email"
        ? ` Confirm this back to them using this EXACT string, unmodified: "${normalizedValue}" — never abbreviate, truncate, or drop the domain.`
        : "";
      return {
        ok: true, fieldName, saved: true, missing, collectionComplete: missing.length === 0,
        ...(emailGuidance ? { guidance: emailGuidance.trim() } : {}),
      };
    }

    // ── complete_collection (U1) ────────────────────────────────────────────
    // Gate: only advances when every required field for the role is present.
    // Otherwise returns the missing list so the loop keeps collecting (R7). On
    // completion, sets the cursor to the first deterministic gate step.
    if (name === "complete_collection") {
      const { phone, role } = input as Record<string, unknown>;
      if (!phone) return toolError("INVALID_INPUT", "phone is required");
      if (role !== "client" && role !== "caregiver") {
        return toolError("INVALID_INPUT", "role must be 'client' or 'caregiver'");
      }
      const { missingRequiredFields, firstGateStep } = await import("../agents/onboardingContract");
      const ref  = db.collection("agent_sessions").doc(phone as string);
      const snap = await ref.get();
      const data = (snap.data()?.onboardingData ?? {}) as Record<string, unknown>;
      const missing = missingRequiredFields(role, data);
      if (missing.length > 0) {
        // ok:true so the model does NOT read this as a tool error (the error
        // convention is _toolError/ok:false). complete:false + missing tells it
        // to keep collecting, not to surface a failure to the user.
        return {
          ok: true,
          complete: false,
          missing,
          guidance: "Not done yet — call save_onboarding_field for each missing field, then call complete_collection again.",
        };
      }
      const nextStep = firstGateStep(role);
      await ref.set({ onboardingStep: nextStep }, { merge: true });
      return { ok: true, complete: true, nextStep, status: "collection_complete" };
    }

    // ── get_invoice_details ─────────────────────────────────────────────────
    // ── request_shift_swap ──────────────────────────────────────────────────
    if (name === "request_shift_swap") {
      const { caregiverId, appointmentId, reason } = input as Record<string, string>;
      const appt = await db.collection("appointments").doc(appointmentId).get();
      if (!appt.exists) return toolError("NOT_FOUND", "Appointment not found");
      const data = appt.data()!;
      const ref = await db.collection("shift_swap_requests").add({
        appointmentId,
        fromCaregiverId: caregiverId,
        fromCaregiverName: data.caregiverName ?? caregiverId,
        clientId: data.clientId,
        date: data.date,
        time: data.time,
        duration: data.duration,
        reason: reason ?? "",
        status: "open",
        candidatesContacted: [],
        candidateResponses: [],
        initiatedBy: "caregiver",
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      return { success: true, swapRequestId: ref.id, message: "Swap request created. Finding available caregivers now." };
    }

    // ── accept_shift_swap ───────────────────────────────────────────────────
    if (name === "accept_shift_swap") {
      const { caregiverId, caregiverName, swapRequestId } = input as Record<string, string>;
      const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
      const swapDoc = await swapRef.get();
      if (!swapDoc.exists) return toolError("NOT_FOUND", "Swap request not found");
      const swap = swapDoc.data()!;
      if (swap.status !== "open") return { _toolError: true, success: false, message: "This swap is no longer open." };
      await db.runTransaction(async (tx) => {
        tx.update(swapRef, { status: "accepted", toCaregiverId: caregiverId, toCaregiverName: caregiverName, acceptedAt: nowIso });
        tx.update(db.collection("appointments").doc(swap.appointmentId), { caregiverId, caregiverName, swapNote: `Swapped from ${swap.fromCaregiverName}` });
      });
      return { success: true, message: `Shift on ${formatDateForDisplay(swap.date)} transferred to ${caregiverName}.` };
    }

    // ── cancel_shift_swap ───────────────────────────────────────────────────
    if (name === "cancel_shift_swap") {
      const { caregiverId, swapRequestId } = input as Record<string, string>;
      const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
      const swapDoc = await swapRef.get();
      if (!swapDoc.exists) return toolError("NOT_FOUND", "Swap request not found");
      if (swapDoc.data()!.fromCaregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "You can only cancel your own swap requests");
      await swapRef.update({ status: "cancelled" });
      return { success: true };
    }

    // ── get_job_recommendations ─────────────────────────────────────────────
    if (name === "get_job_recommendations") {
      const { getJobRecommendationsForCaregiver } = await import("../agents/jobMatchRecommender");
      const caregiverId = input.caregiverId as string;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const limit = Math.min((input.limit as number) ?? 5, 10);
      const recs = await getJobRecommendationsForCaregiver(caregiverId, limit);
      if (!recs.length) return { recommendations: [], message: "No open jobs matching your profile right now." };
      return { recommendations: recs };
    }

    // ── submit_gps_checkin ──────────────────────────────────────────────────
    if (name === "submit_gps_checkin") {
      const { caregiverId, appointmentId } = input as Record<string, string>;
      const latitude  = input.latitude  as number;
      const longitude = input.longitude as number;
      if (!caregiverId || !appointmentId || latitude == null || longitude == null) {
        return toolError("INVALID_INPUT", "caregiverId, appointmentId, latitude, and longitude are required");
      }
      const apptSnap = await db.collection("appointments").doc(appointmentId).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      const seniorSnap = await db.collection("senior_profiles").doc(appt.clientId).get();
      const senior = seniorSnap.data();
      await db.collection("shift_checkins").add({
        appointmentId, caregiverId,
        caregiverName: appt.caregiverName,
        clientId: appt.clientId,
        checkinAt: nowIso,
        status: "arrived",
        gpsProvided: true,
        caregiverLat: latitude,
        caregiverLon: longitude,
        clientLat: senior?.latitude ?? null,
        clientLon: senior?.longitude ?? null,
      });
      return { success: true, message: "Checked in. The family has been notified." };
    }

    // ── get_tax_summary ─────────────────────────────────────────────────────
    if (name === "get_tax_summary") {
      const { getCaregiverTaxSummary } = await import("../billing/taxDocuments");
      const caregiverId = input.caregiverId as string;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const year = (input.year as number) ?? new Date().getFullYear();
      const summary = await getCaregiverTaxSummary(caregiverId, year);
      return summary;
    }

    // ── update_user_profile ─────────────────────────────────────────────────
    if (name === "update_user_profile") {
      const { userId, firstName, lastName, requestPhoneChange, address, city, state, zip, photoUrl, photoFromMessage, phone } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");

      // requestPhoneChange is a request flag, not a field write — login here
      // is by phone number, so a change always goes through the email
      // round-trip (a standalone tool for just this used to exist; folded in
      // here to stay under OpenAI's 128-tool cap rather than adding a tool).
      if (requestPhoneChange === true) {
        const snap = await db.collection("users").doc(userId as string).get();
        if (!snap.exists) return toolError("NOT_FOUND", "Account not found");
        const d = snap.data() ?? {};
        const authEmail = await (async () => { try { return (await admin.auth().getUser(userId as string))?.email?.trim(); } catch { return undefined; } })();
        const email = (d.email as string | undefined)?.trim() || authEmail;
        if (!email) {
          return {
            success: false,
            noEmailOnFile: true,
            guidance: "This account has no email on file, so there's no way to send a verification link. Ask them to set a recovery email first, then try again.",
          };
        }
        {
          // An unconfirmed recovery email proves nothing, so it is never used to
          // verify a phone change (the site's page says the same and offers Resend).
          const { isEmailVerified } = await import("../accountRecovery");
          if (!isEmailVerified(d)) {
            return {
              success: false,
              emailUnverified: true,
              guidance: "Their recovery email hasn't been confirmed yet, so it can't be used to verify a phone change. Offer to resend the confirmation link (request_email_change with resend:true); once they tap it, the phone change can go ahead.",
            };
          }
        }
        const name = ((d.displayName || d.firstName || d.name || "there") as string).split(" ")[0];
        const { requestPhoneChangeForAccount } = await import("../accountRecovery");
        await requestPhoneChangeForAccount({ uid: userId as string, role: "client", name }, email);
        logAudit({ eventType: "profile_updated", userId: userId as string, data: { source: "mcp:update_user_profile:phone" } }).catch(() => {});
        return { success: true, sentTo: email };
      }

      // Match the website's own field names exactly (components/client/AccountSettings.tsx):
      // it combines first/last into ONE `displayName` (never separate firstName/
      // lastName), writes address as `street`/`zipCode` (not `address`/`zip`) plus
      // a derived `location` ("City, State Zip") and legacy `careLocation` object,
      // and the photo field is `photoURL` (capital URL). Writing the old,
      // incompatible field names meant every edit made through Evia was invisible
      // on the site.
      const touchesName    = firstName != null || lastName != null;
      const touchesAddress = address != null || city != null || state != null || zip != null;
      let existing: Record<string, unknown> = {};
      if (touchesName || touchesAddress) {
        const existingSnap = await db.collection("users").doc(userId as string).get();
        existing = existingSnap.data() ?? {};
      }

      const patch: Record<string, unknown> = { updatedAt: nowIso };
      if (touchesName) {
        const currentDisplay = (existing.displayName as string | undefined)
          ?? (existing.firstName as string | undefined) ?? (existing.name as string | undefined) ?? "";
        const [curFirst, ...curRest] = currentDisplay.split(" ");
        const newFirst = (firstName as string | undefined) ?? curFirst ?? "";
        const newLast  = (lastName as string | undefined) ?? curRest.join(" ");
        patch.displayName = `${newFirst} ${newLast}`.trim();
      }
      let finalStreet = "", finalCity = "", finalState = "", finalZip = "";
      if (touchesAddress) {
        finalStreet = (address as string | undefined) ?? (existing.street as string | undefined) ?? "";
        finalCity   = (city    as string | undefined) ?? (existing.city   as string | undefined) ?? "";
        finalState  = (state   as string | undefined) ?? (existing.state  as string | undefined) ?? "";
        finalZip    = (zip     as string | undefined) ?? (existing.zipCode as string | undefined) ?? "";
        if (address != null) patch.street  = address;
        if (city    != null) patch.city    = city;
        if (state   != null) patch.state   = state;
        if (zip     != null) patch.zipCode = zip;
        patch.location = `${finalCity}, ${finalState} ${finalZip}`.trim();
        patch.careLocation = { address: finalStreet, zip: finalZip, city: finalCity, state: finalState };
      }
      // Profile photo — the same three writes as AccountSettings.tsx handlePhotoUpload
      // (storage profile_photos/{uid}/profile → users.photoURL, senior_profiles/{uid}.imageUrl,
      // Auth photoURL), done by agents/profilePhoto.ts. Over text the "file" is the photo
      // the family attached; a typed word is never a photo (a prod account had "skipped").
      let photoSource = typeof photoUrl === "string" && /^https?:\/\//i.test(photoUrl.trim()) ? photoUrl.trim() : "";
      if (photoUrl != null && photoUrl !== "" && !photoSource) {
        return toolError("INVALID_INPUT", "photoUrl must be a real https link to an image. A typed reply like 'skip' is not a photo — save nothing for the photo in that case.");
      }
      if (!photoSource && photoFromMessage === true) {
        if (typeof phone === "string" && phone) {
          const sess = (await db.collection("agent_sessions").doc(phone).get()).data();
          const last = sess?.lastSharedMedia as { url?: string; kind?: string } | undefined;
          if (last?.kind === "image" && last.url) photoSource = last.url;
        }
        if (!photoSource) {
          return toolError("INVALID_INPUT", `No photo attached. Ask the family to attach the photo here in the conversation — or, if photos don't come through on their phone, send them Account Settings to upload it: ${getAppUrl()}/client/account`);
        }
      }
      if (Object.keys(patch).length === 1 && !photoSource) {
        return toolError("INVALID_INPUT", "No fields to update");
      }
      await db.collection("users").doc(userId as string).set(patch, { merge: true });
      if (photoSource) {
        const { setClientProfilePhoto } = await import("../agents/profilePhoto");
        const saved = await setClientProfilePhoto(userId as string, photoSource);
        patch.photoURL = saved.photoURL;
      }
      // If address fields touched and this is a single-senior household, mirror
      // to the senior profile too — the Senior type only has `zipCode` and a
      // composite `location` string, no separate street/city/state fields.
      if (touchesAddress) {
        const seniorSnap = await db.collection("senior_profiles").where("userId", "==", userId).limit(2).get();
        if (seniorSnap.size === 1) {
          await seniorSnap.docs[0].ref.set({
            updatedAt: nowIso,
            zipCode:   finalZip,
            location:  patch.location,
          }, { merge: true }).catch(() => {});
        }
      }
      logAudit({ eventType: "profile_updated", userId: userId as string, data: { source: "mcp:update_user_profile", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => {});
      return {
        success: true,
        updated: Object.keys(patch).filter(k => k !== "updatedAt"),
      };
    }

    // ── delete_account (ALWAYS_CONFIRM-gated — see pendingActions.ts) ───────
    if (name === "delete_account") {
      const { userId } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const { deleteAccountForUser } = await import("../accountDeletion");
      try {
        await deleteAccountForUser(userId as string);
      } catch (err) {
        console.error("delete_account: deleteAccountForUser failed:", err);
        return toolError("UNAVAILABLE", "Couldn't delete the account right now — please try again shortly.");
      }
      logAudit({ eventType: "profile_updated", userId: userId as string, data: { source: "mcp:delete_account" } }).catch(() => {});
      return { success: true, deleted: true };
    }

    // ── request_email_change ────────────────────────────────────────────────
    if (name === "request_email_change") {
      const { userId, newEmail, resend } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      if (resend === true) {
        const { resendEmailConfirmation, maskEmail } = await import("../accountRecovery");
        const r = await resendEmailConfirmation(userId as string);
        logAudit({ eventType: "email_change_requested", userId: userId as string, data: { source: "mcp:request_email_change", resend: true } }).catch(() => {});
        return r.sentTo
          ? { success: true, resent: true, sentTo: maskEmail(r.sentTo), note: "Confirmation link re-sent. Tell them to tap it from that inbox (and to check Junk)." }
          : { success: true, resent: false, alreadyConfirmed: true, note: "Their recovery email is already confirmed — nothing to resend." };
      }
      if (!newEmail) return toolError("INVALID_INPUT", "newEmail is required (or pass resend:true)");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail as string)) {
        return toolError("INVALID_INPUT", "newEmail is not a valid email address");
      }
      // Check for an account already using that email
      const existing = await db.collection("users").where("email", "==", newEmail).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== userId) {
        return toolError("INVALID_INPUT", "An account already exists with that email address");
      }
      // Same server function as the site's Account Settings (role-aware, rate
      // limited, approval-first when the current address is confirmed).
      const { requestEmailChangeSelf, maskEmail } = await import("../accountRecovery");
      const start = await requestEmailChangeSelf(userId as string, newEmail as string);
      logAudit({ eventType: "email_change_requested", userId: userId as string, data: { source: "mcp:request_email_change", stage: start.stage, maskedEmail: maskEmail(newEmail as string) } }).catch(() => {});
      return start.stage === "awaiting_old_approval"
        ? {
            success: true,
            verificationSent: true,
            stage: start.stage,
            approvalSentTo: maskEmail(start.sentTo),
            newEmail,
            note: `An approval link went to their CURRENT recovery email (${maskEmail(start.sentTo)}), and Evia already texted them that they can reply APPROVE from this phone instead, or NO if it wasn't them. Only after approval does ${maskEmail(newEmail as string)} get its confirmation link. Say exactly that — do not tell them to check the new inbox yet.`,
          }
        : {
            success: true,
            verificationSent: true,
            stage: start.stage,
            newEmail,
            note: "Confirmation link sent to the new address. The change isn't live until they tap it from that inbox.",
          };
    }

    // ── save_caregiver_favorite ─────────────────────────────────────────────
    if (name === "save_caregiver_favorite") {
      const { clientId, caregiverId } = input as Record<string, unknown>;
      if (!clientId || !caregiverId) return toolError("INVALID_INPUT", "clientId and caregiverId are required");
      const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      await db.collection("users").doc(clientId as string).set({
        savedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
        updatedAt: nowIso,
      }, { merge: true });
      // Mirrors the website's logMatchSignal('favorited') call (services/matchFeedback.ts)
      // so a favorite through Evia feeds the same match-history/weighting data a
      // website favorite does.
      await db.collection("users").doc(clientId as string)
        .collection("match_history").doc(caregiverId as string).set({
          caregiverId,
          "signals.favorited": admin.firestore.FieldValue.serverTimestamp(),
          weight: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }).catch(() => {});
      logAudit({ eventType: "favorite_saved", userId: clientId as string, data: { source: "mcp:save_caregiver_favorite", caregiverId } }).catch(() => {});
      return { success: true, saved: true, caregiverName: cgSnap.data()?.name ?? "the caregiver" };
    }

    // ── unsave_caregiver_favorite ───────────────────────────────────────────
    if (name === "unsave_caregiver_favorite") {
      const { clientId, caregiverId } = input as Record<string, unknown>;
      if (!clientId || !caregiverId) return toolError("INVALID_INPUT", "clientId and caregiverId are required");
      await db.collection("users").doc(clientId as string).set({
        savedCaregiverIds: admin.firestore.FieldValue.arrayRemove(caregiverId),
        updatedAt: nowIso,
      }, { merge: true });
      logAudit({ eventType: "favorite_removed", userId: clientId as string, data: { source: "mcp:unsave_caregiver_favorite", caregiverId } }).catch(() => {});
      return { success: true, unsaved: true };
    }

    // ── set_block_status (block_user + unblock_user merged, 2026-08-31 — kept
    // both role tool surfaces under OpenAI's 128-tool cap when delete_conversation
    // was added) ──────────────────────────────────────────────────────────────
    if (name === "set_block_status") {
      const { userId, targetUserId, action: blockAction, reason } = input as Record<string, unknown>;
      if (!userId || !targetUserId || !blockAction) return toolError("INVALID_INPUT", "userId, targetUserId, and action are required");

      if (blockAction === "block") {
        if (userId === targetUserId) return toolError("INVALID_INPUT", "Cannot block yourself");
        // The Inbox menu's Block User (InboxView.tsx handleBlock): blockedUsers +
        // blockedUserProfiles.{id} = { name, photo } (what Account Settings' Blocked
        // list renders) — and nothing else; the site writes no alert.
        const blockedPub = await db.collection("publicCaregiverProfiles").doc(targetUserId as string).get();
        const blockedUser = blockedPub.exists ? null : await db.collection("users").doc(targetUserId as string).get();
        const bp = ((blockedPub.exists ? blockedPub.data() : blockedUser?.data()) ?? {}) as Record<string, unknown>;
        const blockedName = (bp.name as string | undefined) || [bp.firstName, bp.lastName].filter(Boolean).join(" ") || "";
        const blockedPhoto = (bp.photo as string | undefined) || (bp.imageUrl as string | undefined) || (bp.profilePhotoUrl as string | undefined) || (bp.photoURL as string | undefined) || "";
        await db.collection("users").doc(userId as string).set({
          blockedUsers: admin.firestore.FieldValue.arrayUnion(targetUserId),
          blockedUserProfiles: { [targetUserId as string]: { name: blockedName, photo: blockedPhoto } },
        }, { merge: true });
        logAudit({ eventType: "user_blocked", userId: userId as string, data: { source: "mcp:set_block_status", targetUserId, reason } }).catch(() => {});
        return { success: true, blocked: true };
      }

      if (blockAction === "unblock") {
        // Mirrors the website's own unblockUser (context/CareConnexContext.tsx)
        // exactly: split arrayRemove + a nested-field delete into two writes
        // (mixing those sentinels in one call can reject), clean up the
        // blockedUserProfiles map entry the block wrote, and hide the shared
        // chat thread until a new message arrives (same messagesCutoff/deletedAt
        // treatment as a manual conversation delete) — previously only
        // blockedUsers was cleared, so an Evia-initiated unblock still showed
        // the target as blocked on the website.
        const userRef = db.collection("users").doc(userId as string);
        await userRef.set({
          blockedUsers: admin.firestore.FieldValue.arrayRemove(targetUserId),
          updatedAt: nowIso,
        }, { merge: true });
        await userRef.set({
          [`blockedUserProfiles.${targetUserId}`]: admin.firestore.FieldValue.delete(),
        }, { merge: true }).catch(() => {}); // field may not exist on legacy blocks — safe to ignore
        try {
          const roomId = [userId, targetUserId].sort().join("_");
          const roomRef = db.collection("chatRooms").doc(roomId as string);
          const roomSnap = await roomRef.get();
          if (roomSnap.exists) {
            await roomRef.set({
              [`messagesCutoff.${userId}`]: admin.firestore.FieldValue.serverTimestamp(),
              [`deletedAt.${userId}`]:      admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
        } catch {
          // chatRoom update failing should not block the unblock itself
        }
        logAudit({ eventType: "user_unblocked", userId: userId as string, data: { source: "mcp:set_block_status", targetUserId } }).catch(() => {});
        return { success: true, unblocked: true };
      }

      if (blockAction === "report") {
        const { category, description: reportDescription } = input as Record<string, unknown>;
        if (!category || !reportDescription) return toolError("INVALID_INPUT", "category and description are required for action:'report'");
        const ALLOWED_CATEGORIES = new Set(["harassment", "scam", "safety_concern", "inappropriate_content", "other"]);
        if (!ALLOWED_CATEGORIES.has(category as string)) {
          return toolError("INVALID_INPUT", `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`);
        }
        // Match the website's own report shape exactly (components/InboxView.tsx's
        // handleReportSubmit) — different field names (reportedBy/reportedUser/
        // reportedUserName/reason/details), `reason` is one of its fixed
        // human-readable labels (not this tool's machine enum), a Timestamp
        // createdAt (not an ISO string), and it never writes `status` at all
        // (the admin list defaults a missing status to "new" client-side).
        // Writing our own incompatible shape meant SMS-filed reports showed as
        // "Unknown user" and never appeared as new in the admin queue.
        const REASON_LABELS: Record<string, string> = {
          harassment: "Harassment",
          scam: "Spam or scam",
          inappropriate_content: "Inappropriate behavior",
          safety_concern: "Other", // no direct site equivalent — kept in details below
          other: "Other",
        };
        const reportedUserSnap = await db.collection("users").doc(targetUserId as string).get();
        const reportedUserName = (reportedUserSnap.data()?.name as string | undefined)
          ?? (reportedUserSnap.data()?.displayName as string | undefined) ?? "";
        const details = category === "safety_concern"
          ? `[Safety concern] ${(reportDescription as string).slice(0, 2000)}`
          : (reportDescription as string).slice(0, 2000);
        const reportRef = await db.collection("reports").add({
          reportedBy:       userId,
          reportedUser:     targetUserId,
          reportedUserName,
          reason:           REASON_LABELS[category as string],
          details,
          createdAt:        admin.firestore.FieldValue.serverTimestamp(),
        });
        logAudit({ eventType: "user_reported", userId: userId as string, data: { source: "mcp:set_block_status", targetUserId, category, reportId: reportRef.id } }).catch(() => {});
        return { success: true, reported: true, reportId: reportRef.id, followUpWindow: "24h" };
      }

      return toolError("INVALID_INPUT", "action must be 'block', 'unblock', or 'report'");
    }

    // ── delete_conversation ─────────────────────────────────────────────────
    if (name === "delete_conversation") {
      const { userId, counterpartId } = input as Record<string, unknown>;
      if (!userId || !counterpartId) return toolError("INVALID_INPUT", "userId and counterpartId are required");
      const { chatRoomIdFor } = await import("../utils/chatThread");
      const roomId = chatRoomIdFor(userId as string, counterpartId as string);
      const roomRef = db.collection("chatRooms").doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) return toolError("NOT_FOUND", "No conversation found with that person.");
      // Mirrors services/chatService.ts's deleteConversation exactly: only sets
      // deletedAt for the requesting user — the other party's copy, and the
      // message history itself, are untouched. relayIntoSharedChatThread /
      // chatService.sendMessage already handle clearing this (and preserving
      // it as messagesCutoff) the next time either side sends a new message.
      await roomRef.set({ [`deletedAt.${userId}`]: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      logAudit({ eventType: "conversation_deleted", userId: userId as string, data: { source: "mcp:delete_conversation", counterpartId } }).catch(() => {});
      return { success: true, deleted: true };
    }

    // ── mark_messages_read ───────────────────────────────────────────────────
    if (name === "mark_messages_read") {
      const { userId, counterpartId } = input as Record<string, unknown>;
      if (!userId || !counterpartId) return toolError("INVALID_INPUT", "userId and counterpartId are required");
      const { chatRoomIdFor } = await import("../utils/chatThread");
      const roomId = chatRoomIdFor(userId as string, counterpartId as string);
      const roomRef = db.collection("chatRooms").doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) return toolError("NOT_FOUND", "No conversation found with that person.");
      // Mirrors services/chatService.ts's markMessagesAsRead exactly: every
      // still-unread message in the room gets isRead:true + this user added to
      // readBy (the site's own query has no senderId filter — it marks ANY
      // unread message in the room, including ones this user sent), then the
      // room's unreadCount for this user resets to 0.
      const unreadSnap = await roomRef.collection("messages").where("isRead", "==", false).get();
      let messagesMarkedRead = 0;
      await Promise.all(unreadSnap.docs.map(async (m) => {
        const readBy = (m.data()?.readBy as string[] | undefined) ?? [];
        if (readBy.includes(userId as string)) return;
        await m.ref.set({ isRead: true, readBy: admin.firestore.FieldValue.arrayUnion(userId) }, { merge: true });
        messagesMarkedRead++;
      }));
      await roomRef.set({ [`unreadCount.${userId}`]: 0 }, { merge: true });
      return { success: true, messagesMarkedRead };
    }

    // ── edit_review ─────────────────────────────────────────────────────────
    // Updates the family's own review. The caregiver's aggregate rating is kept
    // fresh by the `onReviewWritten` onWrite trigger (functions/src/index.ts),
    // which recomputes rating/reviewCount/star-counts from all reviews on every
    // write to `reviews/{id}` — including this update — so no inline recompute is
    // needed here.
    if (name === "edit_review") {
      const { clientId, reviewId, rating, comment } = input as Record<string, unknown>;
      if (!clientId || !reviewId) return toolError("INVALID_INPUT", "clientId and reviewId are required");
      if (rating === undefined && comment === undefined) return toolError("INVALID_INPUT", "Provide a new rating and/or comment.");
      const ref = db.collection("reviews").doc(reviewId as string);
      const snap = await ref.get();
      if (!snap.exists) return toolError("NOT_FOUND", "Review not found.");
      if (snap.data()?.clientId !== clientId) return toolError("PERMISSION_DENIED", "You can only edit your own review.");
      const update: Record<string, unknown> = { updatedAt: nowIso };
      if (rating !== undefined) {
        const r = Number(rating);
        if (!Number.isInteger(r) || r < 1 || r > 5) return toolError("INVALID_INPUT", "rating must be an integer from 1 to 5");
        update.rating = r;
      }
      if (comment !== undefined) update.comment = String(comment).slice(0, 2000);
      await ref.update(update);
      logAudit({ eventType: "review_edited", userId: clientId as string, data: { source: "mcp:edit_review", reviewId } }).catch(() => {});
      return { success: true, updated: true };
    }

    // ── cancel_followup ─────────────────────────────────────────────────────
    if (name === "cancel_followup") {
      const { triggerId, userId } = input as Record<string, unknown>;
      if (!triggerId || !userId) return toolError("INVALID_INPUT", "triggerId and userId are required");
      const ref = db.collection("proactive_triggers").doc(triggerId as string);
      const snap = await ref.get();
      if (!snap.exists) return toolError("NOT_FOUND", "Follow-up not found — it may have already fired or been cancelled.");
      // Always verify ownership and fail closed: a follow-up with no owner field,
      // or one owned by someone else, cannot be cancelled by this caller. Omitting
      // userId can no longer bypass the check (it is now required above).
      if (snap.data()?.userId !== userId) {
        return toolError("PERMISSION_DENIED", "Not authorized to cancel this follow-up.");
      }
      await ref.delete();
      logAudit({ eventType: "followup_cancelled", userId: (userId as string) ?? "", data: { source: "mcp:cancel_followup", triggerId } }).catch(() => {});
      return { success: true, cancelled: true };
    }

    // ── get_support_tickets ─────────────────────────────────────────────────
    if (name === "get_support_tickets") {
      const { userId: stUserId, includeResolved } = input as Record<string, unknown>;
      if (!stUserId) return toolError("INVALID_INPUT", "userId is required");
      const stSnap = await db.collection("support_tickets").where("userId", "==", stUserId).get();
      let tickets: Record<string, unknown>[] = stSnap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
      if (!includeResolved) {
        tickets = tickets.filter(t => t.resolved !== true && t.status !== "closed" && t.status !== "resolved");
      }
      tickets = tickets
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
        .slice(0, 20);
      return { success: true, tickets, count: tickets.length };
    }

    // ── get_refund_requests ─────────────────────────────────────────────────
    if (name === "get_shifts") {
      const { caregiverId: gsCgId, clientId: gsClientId, status: gsStatus } = input as Record<string, unknown>;
      if (!gsCgId && !gsClientId) return toolError("INVALID_INPUT", "Provide caregiverId or clientId");
      const gsField = gsCgId ? "caregiverId" : "clientId";
      const gsValue = gsCgId ?? gsClientId;
      const gsSnap = await db.collection("shiftHours").where(gsField, "==", gsValue).get();
      let shifts = gsSnap.docs.map(d => {
        const s = d.data() as Record<string, unknown>;
        // Real shiftHours fields — date/clockInTime/clockOutTime are never
        // written (createValidatedShiftHours.ts), so these always came back
        // null; final* wins over submitted* once a review has happened,
        // matching Payments.tsx's own display priority.
        const startTime = (s.finalStartTime ?? s.submittedStartTime) as string | undefined;
        const endTime   = (s.finalEndTime   ?? s.submittedEndTime)   as string | undefined;
        return {
          appointmentId: d.id,
          date:          startTime ? new Date(startTime).toISOString().slice(0, 10) : null,
          status:        s.status ?? null,
          durationHours: s.finalTotalHours ?? s.submittedTotalHours ?? null,
          amountCents:   s.amountCents ?? null,
          amountDollars: s.amountCents != null ? `$${(Number(s.amountCents) / 100).toFixed(2)}` : null,
          clockInTime:   startTime ?? null,
          clockOutTime:  endTime ?? null,
          caregiverName: s.caregiverName ?? null,
          clientName:    s.clientName ?? null,
        };
      });
      if (gsStatus) shifts = shifts.filter(s => s.status === gsStatus);
      shifts = shifts
        .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
        .slice(0, 20);
      return { success: true, shifts, count: shifts.length };
    }

    // ── get_resendable_booking_requests ──────────────────────────────────────
    // Same eligibility function the scripted resend flow uses (bookingFlow.ts
    // findResendableBookingRequests) — one rule, read and write.
    if (name === "get_resendable_booking_requests") {
      const { clientId: rsClientId, caregiverId: rsCgId } = input as Record<string, unknown>;
      if (!rsClientId) return toolError("INVALID_INPUT", "clientId is required");
      const { findResendableBookingRequests } = await import("../agents/bookingFlow");
      const options = await findResendableBookingRequests(rsClientId as string, typeof rsCgId === "string" && rsCgId ? rsCgId : undefined);
      return {
        success: true,
        requests: options.map((o) => ({
          bookingRequestId: o.id, caregiverId: o.caregiverId, caregiverName: o.caregiverName,
          jobTitle: o.jobTitle ?? null, statusLabel: o.statusLabel, interviewWhen: o.whenLabel ?? null,
        })),
        count: options.length,
        instruction: options.length
          ? "These are the site's Resend rows. If the family wants to resend one, call start_resend_booking_flow (pass caregiverId if they named one)."
          : "Nothing is resendable right now — say so plainly; do not offer a resend.",
      };
    }

    // ── get_pending_booking_requests ─────────────────────────────────────────
    // Matches the site's My Bookings > Requests tab exactly: booking_requests
    // where clientId (ClientVisitsPage.tsx) or caregiverId (CaregiverBookingsPage.tsx)
    // and status === 'pending'. get_upcoming_appointments/get_pending_tasks do
    // NOT cover this — they query appointments/shifts and Evia's own agent_tasks
    // queue, never a pending booking_requests doc (confirmed gap, 2026-09-14).
    if (name === "get_pending_booking_requests") {
      const { clientId: pbrClientId, caregiverId: pbrCgId } = input as Record<string, unknown>;
      if (!pbrClientId && !pbrCgId) return toolError("INVALID_INPUT", "Provide clientId or caregiverId");
      const pbrField = pbrClientId ? "clientId" : "caregiverId";
      const pbrValue = pbrClientId ?? pbrCgId;
      const pbrSnap = await db.collection("booking_requests")
        .where(pbrField, "==", pbrValue)
        .where("status", "==", "pending")
        .get();
      const requests = pbrSnap.docs
        .map((d): Record<string, unknown> => {
          const r = d.data() as Record<string, unknown>;
          const sch = (r.schedule ?? {}) as Record<string, unknown>;
          return {
            bookingRequestId:   d.id,
            clientId:           r.clientId ?? null,
            clientName:         r.clientName ?? null,
            caregiverId:        r.caregiverId ?? null,
            caregiverName:      r.caregiverName ?? null,
            hourlyRate:         r.rate ?? r.hourlyRate ?? null,
            schedule:           r.schedule ?? null,
            // One calendar day (startDate === endDate, not ongoing): describe it as one visit, never as a weekly schedule — same as the site's card.
            singleVisit:        !sch.ongoing && !!sch.startDate && sch.startDate === sch.endDate,
            isShiftReplacement: r.isShiftReplacement ?? false,
            isResend:           r.isResend ?? false,
            createdAt:          r.createdAt ?? null,
          };
        })
        .sort((a, b) => String((b as any).createdAt?.toDate?.() ?? b.createdAt ?? "").localeCompare(String((a as any).createdAt?.toDate?.() ?? a.createdAt ?? "")))
        .slice(0, 20);
      return { success: true, requests, count: requests.length };
    }

    // ── get_pending_schedule_amendments ──────────────────────────────────────
    // The Requests tab's second card type (ClientVisitsPage.tsx pendingAmendments):
    // booking_amendments where clientId (or caregiverId) and status === 'pending'.
    if (name === "get_pending_schedule_amendments") {
      const { clientId: psaClientId, caregiverId: psaCgId } = input as Record<string, unknown>;
      if (!psaClientId && !psaCgId) return toolError("INVALID_INPUT", "Provide clientId or caregiverId");
      const psaSnap = await db.collection("booking_amendments")
        .where(psaClientId ? "clientId" : "caregiverId", "==", psaClientId ?? psaCgId)
        .where("status", "==", "pending")
        .get();
      const amendments = psaSnap.docs
        .map((d): Record<string, unknown> => {
          const a = d.data() as Record<string, unknown>;
          const newDays = (a.newDays ?? {}) as Record<string, Array<{ start?: string; end?: string }>>;
          return {
            amendmentId:      d.id,
            bookingRequestId: a.bookingRequestId ?? null,
            clientId:         a.clientId ?? null,
            clientName:       a.clientName ?? null,
            caregiverId:      a.caregiverId ?? null,
            caregiverName:    a.caregiverName ?? null,
            type:             a.type ?? null,
            days:             Object.entries(newDays).map(([day, slots]) => ({ day, times: (slots ?? []).map((s) => `${s.start ?? ""}–${s.end ?? ""}`) })),
            startDate:        a.startDate ?? null,
            startDayOfWeek:   weekdayForDate(String(a.startDate ?? "")),
            endDate:          a.endDate ?? null,
            ongoing:          Boolean(a.ongoing),
            notes:            a.notes ?? "",
            createdAt:        a.createdAt ?? null,
          };
        })
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
        .slice(0, 20);
      return { success: true, amendments, count: amendments.length };
    }

    // ── get_past_visits ──────────────────────────────────────────────────────
    // The Past Bookings tab (ClientVisitsPage.tsx pastShifts): shifts with
    // status completed/cancelled, newest first. Uses the existing
    // (clientId|caregiverId, date DESC) index and filters status in memory.
    if (name === "get_past_visits") {
      const { clientId: pvClientId, caregiverId: pvCgId, limit: pvLimitRaw } = input as Record<string, unknown>;
      if (!pvClientId && !pvCgId) return toolError("INVALID_INPUT", "Provide clientId or caregiverId");
      const pvLimit = Math.min(Math.max(Number(pvLimitRaw) || 20, 1), 50);
      const pvSnap = await db.collection("shifts")
        .where(pvClientId ? "clientId" : "caregiverId", "==", pvClientId ?? pvCgId)
        .where("date", "<=", businessTodayStr())
        .orderBy("date", "desc")
        .limit(pvLimit * 3)
        .get();
      const visits = pvSnap.docs
        .filter((d) => d.data().status === "completed" || d.data().status === "cancelled")
        .map((d): Record<string, unknown> => {
          const s = d.data() as Record<string, unknown>;
          return {
            id:               d.id,
            bookingRequestId: s.bookingRequestId ?? null,
            date:             s.date ?? null,
            dayOfWeek:        weekdayForDate(String(s.date ?? "")),
            startTime:        s.startTime ?? null,
            endTime:          s.endTime ?? null,
            status:           s.status,
            clientId:         s.clientId ?? null,
            clientName:       s.clientName ?? null,
            caregiverId:      s.caregiverId ?? null,
            caregiverName:    s.caregiverName ?? null,
            cancelledBy:      s.cancelledBy ?? null,
            startedAt:        s.startedAt ?? null,
            completedAt:      s.completedAt ?? null,
            paid:             s.paid ?? null,
            // The Past Booking card's detail: tasks checked off, the visit log, the closing note.
            tasksCompleted:   Array.isArray(s.tasksCompleted) ? s.tasksCompleted : [],
            notesLog:         Array.isArray(s.notesLog) ? s.notesLog : [],
            completionNotes:  s.completionNotes ?? null,
          };
        })
        .sort((a, b) => `${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`))
        .slice(0, pvLimit);
      return { success: true, visits, count: visits.length, hasMore: pvSnap.docs.length > visits.length };
    }

    // ── get_caregiver_availability ──────────────────────────────────────────
    if (name === "get_caregiver_availability") {
      const { caregiverId: gaCgId } = input as Record<string, unknown>;
      if (!gaCgId) return toolError("INVALID_INPUT", "caregiverId is required");
      const gaSnap = await db.collection("caregivers").doc(gaCgId as string).get();
      if (!gaSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const ga = gaSnap.data()!;
      return {
        success:            true,
        availability:       ga.availability ?? [],
        weeklyAvailability: ga.weeklyAvailability ?? {},
        preferredTimeOfDay: ga.preferredTimeOfDay ?? null,
      };
    }

    // ── update_care_journal_entry ───────────────────────────────────────────
    if (name === "update_care_journal_entry") {
      const { caregiverId: ujCgId, entryId: ujEntryId, notes, mood, medsGiven, activities } =
        input as Record<string, unknown>;
      if (!ujCgId || !ujEntryId) return toolError("INVALID_INPUT", "caregiverId and entryId are required");
      const ujRef  = db.collection("care_journal").doc(ujEntryId as string);
      const ujSnap = await ujRef.get();
      if (!ujSnap.exists) return toolError("NOT_FOUND", "Care journal entry not found");
      if (ujSnap.data()?.caregiverId !== ujCgId) return toolError("PERMISSION_DENIED", "You can only edit entries you wrote");
      const ujUpdate: Record<string, unknown> = { updatedAt: nowIso };
      if (notes      !== undefined) ujUpdate.notes = notes;
      if (mood       !== undefined) ujUpdate.mood = mood;
      if (medsGiven  !== undefined) ujUpdate.medsGiven = medsGiven;
      if (activities !== undefined) ujUpdate.activities = activities;
      if (Object.keys(ujUpdate).length === 1) {
        return toolError("INVALID_INPUT", "Provide at least one field to update (notes, mood, medsGiven, or activities).");
      }
      await ujRef.update(ujUpdate);
      logAudit({ eventType: "care_journal_updated", userId: ujCgId as string, data: { source: "mcp:update_care_journal_entry", entryId: ujEntryId, fields: Object.keys(ujUpdate).filter(k => k !== "updatedAt") } }).catch(() => {});
      return { success: true, updated: true, entryId: ujEntryId };
    }

    // ── CRUD/parity gap closures (agent-native audit 2026-07) ───────────────

    // ── archive_senior_profile ──────────────────────────────────────────────
    // Soft-delete only: a status flag, never a document delete — care records
    // are retained (see AGENT_NATIVE_EXCLUSIONS.md "senior profile hard-delete").
    if (name === "archive_senior_profile") {
      const { seniorId, clientId, reason } = input as Record<string, unknown>;
      if (!seniorId || !clientId) return toolError("INVALID_INPUT", "seniorId and clientId are required");
      const seniorSnap = await db.collection("senior_profiles").doc(seniorId as string).get();
      if (!seniorSnap.exists) return toolError("NOT_FOUND", "Senior profile not found");
      const sd = seniorSnap.data()!;
      // Same owner resolution as assertSeniorAccess: userId (direct onboarding)
      // OR clientId (household back-reference docs, which carry no userId).
      const ownerId = sd.userId ?? sd.clientId;
      if (ownerId && ownerId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized to archive this senior's profile");
      if (!ownerId && seniorId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized to archive this senior's profile");
      if (sd.status === "archived") return { success: true, alreadyArchived: true, seniorId };
      await seniorSnap.ref.set({
        status:        "archived",
        archivedAt:    nowIso,
        archivedBy:    clientId,
        archiveReason: reason ?? null,
        updatedAt:     nowIso,
      }, { merge: true });
      logAudit({ eventType: "senior_profile_archived", userId: clientId as string, data: { source: "mcp:archive_senior_profile", seniorId, reason: reason ?? null } }).catch(() => {});
      return { success: true, archived: true, seniorId, retained: true };
    }

    // ── update_family_member ────────────────────────────────────────────────
    if (name === "update_family_member") {
      const { clientId, memberPhone, memberName, role, relationship, notificationsEnabled } =
        input as Record<string, unknown>;
      if (!clientId || !memberPhone) return toolError("INVALID_INPUT", "clientId and memberPhone are required");
      const patch: Record<string, unknown> = {};
      if (memberName   !== undefined) patch.memberName = memberName;
      if (role         !== undefined) patch.role = role;
      if (relationship !== undefined) patch.relationship = relationship;
      if (notificationsEnabled !== undefined) patch.notificationsEnabled = notificationsEnabled;
      if (Object.keys(patch).length === 0) {
        return toolError("INVALID_INPUT", "Provide at least one field to update (memberName, role, relationship, or notificationsEnabled).");
      }
      if (role !== undefined && !["primary", "family", "emergency_contact"].includes(String(role))) {
        return toolError("INVALID_INPUT", "role must be one of: primary, family, emergency_contact");
      }
      // Ownership is the query scope itself: only membership docs recorded under
      // THIS client's userId are reachable, so another family's member can never
      // be edited even with a guessed phone number.
      const memberSnap = await db.collection("family_group_members")
        .where("userId", "==", clientId)
        .where("memberPhone", "==", memberPhone)
        .limit(1)
        .get();
      if (memberSnap.empty) return toolError("NOT_FOUND", "No family group member with that phone number in this care group");
      await memberSnap.docs[0].ref.update({ ...patch, updatedAt: nowIso });
      logAudit({ eventType: "family_member_updated", userId: clientId as string, data: { source: "mcp:update_family_member", memberPhone, fields: Object.keys(patch) } }).catch(() => {});
      return { success: true, updated: true, memberPhone, fields: Object.keys(patch) };
    }

    // ── list_interviews ─────────────────────────────────────────────────────
    if (name === "list_interviews") {
      // 2026-09-08 (live-caught): scheduledTime is a raw UTC ISO string
      // ("2026-09-08T00:00:00.000Z" for what's actually 5pm Pacific on the
      // 7th). Asked to reason over a LIST of several similarly-timed
      // interviews with the same caregiver, the model has to mentally
      // convert every one of them from UTC before it can say which is
      // "today" or "at 5pm" — exactly the kind of per-item timezone
      // arithmetic that produced a real answer splicing one interview's real
      // date onto a different interview's real time. Precomputing a
      // human-readable Pacific label server-side (same helper the interview
      // reminders use) removes that mental-math step entirely.
      const scheduledTimeLocal = (iso: unknown): string | null => {
        if (typeof iso !== "string" || !iso) return null;
        const ms = parseScheduledTimeMs(iso);
        return Number.isNaN(ms) ? null : formatInterviewTime(ms);
      };
      const liClientId    = input.clientId as string | undefined;
      const liCaregiverId = input.caregiverId as string | undefined;
      const liStatus      = input.status as string | undefined;
      // Caller-scoped read: a caregiver session injects caregiverId, a client
      // session injects clientId — the query only ever returns the caller's own
      // interviews. Prefer the caregiver scope when both are present (caregiver
      // sessions also carry a userId).
      const field = liCaregiverId ? "caregiverId" : liClientId ? "clientId" : null;
      const id    = liCaregiverId ?? liClientId;
      if (!field || !id) return toolError("INVALID_INPUT", "clientId or caregiverId is required");
      // Family: the Care Requests > Interviews tab, one read (agents/interviewsTab.ts)
      // — every row joined to its job post banner, its booking status line and
      // the exact buttons the page shows, sorted the page's way.
      if (field === "clientId") {
        const interviews = await listClientInterviews(id, liStatus);
        console.log("list_interviews: query result", {
          field, id, statusFilter: liStatus ?? null, count: interviews.length,
          statusBreakdown: interviews.reduce((acc: Record<string, number>, iv) => { acc[iv.displayStatus] = (acc[iv.displayStatus] ?? 0) + 1; return acc; }, {}),
        });
        return { success: true, interviews, count: interviews.length };
      }
      // Caregiver: their own interviews from video_interviews (the site's
      // only interview collection — the retired Evia-SMS `interviews` twin
      // was dropped 2026-09-17).
      let q = db.collection("video_interviews").where(field, "==", id);
      if (liStatus) q = q.where("status", "==", liStatus);
      const liSnap = await q.limit(25).get();
      const interviews = liSnap.docs.map(d => {
        const iv = d.data();
        return {
          interviewId:   d.id,
          source:        "video_interviews",
          clientId:      iv.clientId ?? null,
          caregiverId:   iv.caregiverId ?? null,
          caregiverName: iv.caregiverName ?? null,
          clientName:    iv.clientName ?? null,
          scheduledTime: iv.scheduledTime ?? null,
          scheduledTimeLocal: scheduledTimeLocal(iv.scheduledTime),
          interviewType: iv.interviewType ?? "video",
          status:        iv.status ?? "requested",
          callUrl:       iv.callUrl ?? null,
          notes:         iv.notes ?? null,
          jobTitle:      iv.jobTitle ?? null,
          proposedTime:  iv.proposedTime ?? null,
          applicationId: iv.applicationId ?? null,
          reschedulePendingTime:      iv.reschedulePendingTime ?? null,
          reschedulePendingTimeLocal: scheduledTimeLocal(iv.reschedulePendingTime),
          rescheduledBy:              iv.rescheduledBy ?? null,
        };
      }).sort((a, b) => String(a.scheduledTime ?? "").localeCompare(String(b.scheduledTime ?? "")));
      console.log("list_interviews: query result", {
        field, id, statusFilter: liStatus ?? null, videoInterviewsCount: liSnap.docs.length,
        statusBreakdown: interviews.reduce((acc: Record<string, number>, iv) => { acc[iv.status] = (acc[iv.status] ?? 0) + 1; return acc; }, {}),
      });
      return { success: true, interviews, count: interviews.length };
    }

    // ── cancel_interview ────────────────────────────────────────────────────
    if (name === "cancel_interview") {
      const ciInterviewId = input.interviewId as string | undefined;
      const ciClientId    = input.clientId as string | undefined;
      const ciCaregiverId = input.caregiverId as string | undefined;
      const ciReason      = input.reason as string | undefined;
      if (!ciInterviewId) return toolError("INVALID_INPUT", "interviewId is required");
      const ivSnap = await db.collection("video_interviews").doc(ciInterviewId).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      // Either participant may cancel their own interview — nobody else's.
      const cancelledBy = ciCaregiverId && iv.caregiverId === ciCaregiverId
        ? "caregiver"
        : ciClientId && iv.clientId === ciClientId
          ? "client"
          : null;
      if (!cancelledBy) return toolError("PERMISSION_DENIED", "Interview does not belong to this user");
      if (iv.status === "cancelled") return { success: true, alreadyCancelled: true, interviewId: ciInterviewId };
      // The page's Cancel button exists only on pending/accepted rows.
      if (!["requested", "scheduled", "pending", "accepted", "confirmed"].includes(iv.status as string)) {
        return toolError("INVALID_INPUT", `Cannot cancel a ${iv.status} interview — only a pending or accepted one`);
      }
      const cancelPatch = {
        status:       "cancelled",
        cancelledAt:  nowIso,
        cancelledBy,
        cancelReason: ciReason ?? null,
        // Terminal status — clear any leftover reschedule proposal, exactly
        // as the site's handleCancelInterview does (2026-09-16).
        reschedulePendingTime: admin.firestore.FieldValue.delete(),
        rescheduledBy:         admin.firestore.FieldValue.delete(),
        // Tells onVideoInterviewWrite (notificationTriggers.ts) not to also
        // text the counterpart — this tool already does it below.
        cancelledViaAgent: true,
      };
      await ivSnap.ref.update(cancelPatch);
      // Retire the pending 1h reminder + follow-up for the dead interview
      // (also covered by onVideoInterviewLinkEnsure for web cancels).
      {
        const { cancelTriggersByRef } = await import("../triggers/triggerEngine");
        await cancelTriggersByRef(`video_interview_${ciInterviewId}`).catch(() => {});
      }
      // Notify the counterpart, following schedule_interview (caregiver via
      // trySend) / respond_to_interview_request (client via agent_sessions).
      const when = typeof iv.scheduledTime === "string" ? iv.scheduledTime.slice(0, 10) : "the scheduled time";
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_counterpart_phone" };
      if (cancelledBy === "client") {
        const cgPhone = await resolveCaregiverPhone(iv.caregiverId as string | undefined);
        if (cgPhone) {
          const { trySend } = await import("../utils/toolNotify");
          notification = await trySend(cgPhone, `The interview scheduled for ${when} has been cancelled by the family.${ciReason ? ` Reason: ${ciReason}` : ""}`, "mcp:cancel_interview");
        }
      } else {
        const clientSess = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
        const clientPhone = !clientSess.empty ? clientSess.docs[0].id : (iv.clientPhone as string | undefined);
        if (clientPhone) {
          const cgData = iv.caregiverId ? (await db.collection("caregivers").doc(iv.caregiverId as string).get()).data() : undefined;
          const cgName = cgData?.name ?? iv.caregiverName ?? "The caregiver";
          const { sendToPhone } = await import("../linq/client");
          const sent = await sendToPhone(clientPhone, `${cgName} cancelled the interview scheduled for ${when}.${ciReason ? ` Reason: ${ciReason}` : ""} Want me to find another time?`)
            .then(() => true)
            .catch(() => false);
          notification = sent ? { sent: true } : { sent: false, reason: "linq_send_failed" };
        }
      }
      logAudit({ eventType: "interview_cancelled", userId: (cancelledBy === "caregiver" ? ciCaregiverId : ciClientId) as string, data: { source: "mcp:cancel_interview", interviewId: ciInterviewId, cancelledBy, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, cancelled: true, interviewId: ciInterviewId, cancelledBy, notification };
    }

    // ── reschedule_interview ─────────────────────────────────────────────────
    // Mirrors the website's own Reschedule / Propose different time button
    // exactly (PostsPage.tsx / JobBoard.tsx, 2026-09-09): stores the proposal
    // in reschedulePendingTime/rescheduledBy WITHOUT touching the real
    // scheduledTime/status — those only change once accept_interview_reschedule
    // is called by the OTHER party. Replaces the old cancel_interview +
    // schedule_interview two-step, which lost the interview's history/link
    // and sent the caregiver a duplicate request.
    if (name === "reschedule_interview") {
      const riInterviewId = input.interviewId as string | undefined;
      const riClientId    = input.clientId as string | undefined;
      const riCaregiverId = input.caregiverId as string | undefined;
      const riNewDate     = input.newDate as string | undefined;
      const riNewTime     = input.newTime as string | undefined;
      if (!riInterviewId || !riNewDate || !riNewTime) {
        return toolError("INVALID_INPUT", "interviewId, newDate, and newTime are required");
      }

      const resolved = await resolveInterview(riInterviewId);
      if (!resolved) return toolError("NOT_FOUND", "Interview not found");
      const { primary, iv } = resolved;

      const proposedBy = riCaregiverId && iv.caregiverId === riCaregiverId
        ? "caregiver"
        : riClientId && iv.clientId === riClientId
          ? "client"
          : null;
      if (!proposedBy) return toolError("PERMISSION_DENIED", "Interview does not belong to this user");

      // The site's Reschedule / Propose new time shows on every pending or
      // accepted interview; stored statuses for those read as requested/
      // scheduled/pending and accepted/confirmed (PostsPage.tsx normalizes
      // them at ingestion). 2026-09-16: "scheduled" and "confirmed" used to
      // be refused here, so a site-created interview couldn't be moved.
      if (!["requested", "scheduled", "pending", "accepted", "confirmed"].includes(iv.status as string)) {
        return toolError("INVALID_INPUT", `Cannot reschedule a ${iv.status} interview`);
      }
      // The page shows Propose/Reschedule only on your TURN — never while your
      // own proposal is still out (that row only offers Cancel).
      if (iv.reschedulePendingTime && iv.rescheduledBy === proposedBy) {
        return toolError("INVALID_INPUT", "You already proposed a new time for this interview — it's waiting on the other party to confirm. Cancel the interview if it no longer works; otherwise wait for their answer.");
      }

      const startMs = parseScheduledTimeMs(`${riNewDate}T${riNewTime}:00`);
      if (Number.isNaN(startMs)) return toolError("INVALID_INPUT", "newDate/newTime could not be parsed");
      if (startMs <= Date.now()) return toolError("INVALID_INPUT", "The new time must be in the future");
      const newScheduledTime = new Date(startMs).toISOString();
      const displayTime = formatInterviewTime(startMs);

      const proposalPatch = {
        reschedulePendingTime: newScheduledTime,
        rescheduledBy:         proposedBy,
        // Tells onVideoInterviewWrite (notificationTriggers.ts) not to also
        // text the counterpart — this tool already does it below.
        rescheduledViaAgent:   true,
        // A stale marker from a PRIOR accept cycle (on this same interview,
        // rescheduled more than once) would otherwise wrongly suppress the
        // trigger's own SMS on a future site-driven accept that has nothing
        // to do with this tool.
        acceptedRescheduleViaAgent: admin.firestore.FieldValue.delete(),
        updatedAt:             nowIso,
      };
      await primary.ref.update(proposalPatch);

      // Notify whichever party did NOT propose this, following cancel_interview's
      // own notify convention (trySend for caregivers, Linq session for clients).
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_counterpart_phone" };
      if (proposedBy === "client") {
        const cgPhone = await resolveCaregiverPhone(iv.caregiverId as string | undefined);
        if (cgPhone) {
          const { trySend } = await import("../utils/toolNotify");
          const clName = (iv.clientName as string | undefined) ?? "The family";
          notification = await trySend(cgPhone, `${clName} proposed a new interview time: ${displayTime}. Reply here to confirm or suggest another time.`, "mcp:reschedule_interview");
        }
      } else {
        const clientSess  = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
        const clientPhone = !clientSess.empty ? clientSess.docs[0].id : (iv.clientPhone as string | undefined);
        if (clientPhone) {
          const cgData = iv.caregiverId ? (await db.collection("caregivers").doc(iv.caregiverId as string).get()).data() : undefined;
          const cgName = (cgData?.name as string | undefined) ?? (iv.caregiverName as string | undefined) ?? "Your caregiver";
          const { sendToPhone } = await import("../linq/client");
          const sent = await sendToPhone(clientPhone, `${cgName} proposed a new interview time: ${displayTime}. Reply here to confirm or suggest another time.`)
            .then(() => true)
            .catch(() => false);
          notification = sent ? { sent: true } : { sent: false, reason: "linq_send_failed" };
        }
      }

      logAudit({
        eventType: "interview_rescheduled",
        userId:    (proposedBy === "caregiver" ? riCaregiverId : riClientId) as string,
        data: { source: "mcp:reschedule_interview", interviewId: riInterviewId, proposedBy, notificationSent: notification.sent },
      }).catch(() => {});

      return {
        success: true,
        proposed: true,
        interviewId: riInterviewId,
        proposedBy,
        newScheduledTime,
        newScheduledTimeLocal: displayTime,
        notification,
        note: "This only proposes the new time — nothing is confirmed until the other party accepts. Do not tell them the interview has moved yet.",
      };
    }

    // ── accept_interview_reschedule ──────────────────────────────────────────
    // The moment the real scheduledTime actually changes — mirrors the
    // website's Accept new time button. Also clears remindersScheduledAt so
    // onVideoInterviewLinkEnsure (interviewLinkTrigger.ts) reprocesses and
    // reschedules the 1h-before reminder for the NEW time (it otherwise skips
    // re-processing once that field is already set from the original accept).
    if (name === "accept_interview_reschedule") {
      const arInterviewId = input.interviewId as string | undefined;
      const arClientId    = input.clientId as string | undefined;
      const arCaregiverId = input.caregiverId as string | undefined;
      if (!arInterviewId) return toolError("INVALID_INPUT", "interviewId is required");

      const resolved = await resolveInterview(arInterviewId);
      if (!resolved) return toolError("NOT_FOUND", "Interview not found");
      const { primary, iv } = resolved;

      const acceptedBy = arCaregiverId && iv.caregiverId === arCaregiverId
        ? "caregiver"
        : arClientId && iv.clientId === arClientId
          ? "client"
          : null;
      if (!acceptedBy) return toolError("PERMISSION_DENIED", "Interview does not belong to this user");

      if (!iv.reschedulePendingTime) {
        return toolError("INVALID_INPUT", "There is no pending reschedule proposal on this interview");
      }
      if (iv.rescheduledBy === acceptedBy) {
        return toolError("INVALID_INPUT", "You proposed this time yourself — waiting on the other party to accept it, not you");
      }

      const newScheduledTime = iv.reschedulePendingTime as string;
      const acceptPatch = {
        scheduledTime:         newScheduledTime,
        status:                "accepted",
        reschedulePendingTime: admin.firestore.FieldValue.delete(),
        rescheduledBy:         admin.firestore.FieldValue.delete(),
        rescheduledViaAgent:   admin.firestore.FieldValue.delete(),
        acceptedRescheduleViaAgent: true,
        remindersScheduledAt:  admin.firestore.FieldValue.delete(),
        updatedAt:             nowIso,
      };
      await primary.ref.update(acceptPatch);

      const displayTime = formatInterviewTime(Date.parse(newScheduledTime));

      // Notify whoever originally proposed it that their time is now confirmed.
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_counterpart_phone" };
      if (acceptedBy === "caregiver") {
        const clientSess  = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
        const clientPhone = !clientSess.empty ? clientSess.docs[0].id : (iv.clientPhone as string | undefined);
        if (clientPhone) {
          const cgData = iv.caregiverId ? (await db.collection("caregivers").doc(iv.caregiverId as string).get()).data() : undefined;
          const cgName = (cgData?.name as string | undefined) ?? (iv.caregiverName as string | undefined) ?? "Your caregiver";
          const { sendToPhone } = await import("../linq/client");
          const sent = await sendToPhone(clientPhone, `${cgName} confirmed the new interview time: ${displayTime}.`).then(() => true).catch(() => false);
          notification = sent ? { sent: true } : { sent: false, reason: "linq_send_failed" };
        }
      } else {
        const cgPhone = await resolveCaregiverPhone(iv.caregiverId as string | undefined);
        if (cgPhone) {
          const { trySend } = await import("../utils/toolNotify");
          const clName = (iv.clientName as string | undefined) ?? "The family";
          notification = await trySend(cgPhone, `${clName} confirmed the new interview time: ${displayTime}.`, "mcp:accept_interview_reschedule");
        }
      }

      logAudit({
        eventType: "interview_reschedule_accepted",
        userId:    (acceptedBy === "caregiver" ? arCaregiverId : arClientId) as string,
        data: { source: "mcp:accept_interview_reschedule", interviewId: arInterviewId, acceptedBy, notificationSent: notification.sent },
      }).catch(() => {});

      return {
        success: true,
        accepted: true,
        interviewId: arInterviewId,
        acceptedBy,
        newScheduledTime,
        newScheduledTimeLocal: displayTime,
        notification,
      };
    }

    // ── delete_memory_file ──────────────────────────────────────────────────
    if (name === "delete_memory_file") {
      if (!input.userId || !input.file) return toolError("INVALID_INPUT", "userId and file are required");
      // R11 (U4b): never trust the model-supplied userId for a memory mutation.
      const deleteIdentityError = await verifyMemoryToolIdentity(input);
      if (deleteIdentityError) return deleteIdentityError;
      logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:delete_memory_file", file: input.file } }).catch(() => {});
      const retiredText = await readMemoryFile(input.userId as string, input.file as MemoryFile);
      if (retiredText.trim()) {
        await stageMcpMemoryFileChange({
          kind: "forget",
          userId: input.userId as string,
          phone: stringInput(input, "phone"),
          fileSlug: String(input.file),
          source: "mcp:delete_memory_file",
          retiredText,
        });
      }
      const existed = await deleteMemoryFile(input.userId as string, input.file as MemoryFile);
      if (existed) {
        // The pending worker operation was staged before deleteMemoryFile.
        // It now re-runs Storage/embedding cleanup idempotently and reconciles
        // learned facts plus Zep before it can complete.
      }
      logAudit({ eventType: "memory_file_deleted", userId: input.userId as string, data: { source: "mcp:delete_memory_file", file: input.file, existed } }).catch(() => {});
      return { success: true, deleted: existed, existed };
    }

    // ── list_blocked_users ──────────────────────────────────────────────────
    if (name === "list_blocked_users") {
      const lbUserId = input.userId as string | undefined;
      if (!lbUserId) return toolError("INVALID_INPUT", "userId is required");
      const userSnap = await db.collection("users").doc(lbUserId).get();
      const blockedIds: string[] = (userSnap.data()?.blockedUsers ?? []).slice(0, 50);
      const blocked: Array<{ userId: string; name: string | null }> = [];
      for (const id of blockedIds) {
        let displayName: string | null = null;
        const uSnap = await db.collection("users").doc(id).get().catch(() => null);
        if (uSnap?.exists) displayName = (uSnap.data()?.name ?? uSnap.data()?.firstName ?? null) as string | null;
        if (!displayName) {
          const cSnap = await db.collection("caregivers").doc(id).get().catch(() => null);
          if (cSnap?.exists) displayName = (cSnap.data()?.name ?? cSnap.data()?.fullName ?? null) as string | null;
        }
        blocked.push({ userId: id, name: displayName });
      }
      return { success: true, blocked, count: blocked.length };
    }

    // ── list_shift_swaps ────────────────────────────────────────────────────
    if (name === "list_shift_swaps") {
      const lsCaregiverId = input.caregiverId as string | undefined;
      if (!lsCaregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      const swapFields = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
        const s = d.data();
        return {
          swapRequestId:     d.id,
          appointmentId:     s.appointmentId ?? null,
          date:              s.date ?? null,
          time:              s.time ?? null,
          reason:            s.reason ?? "",
          status:            s.status ?? "open",
          fromCaregiverId:   s.fromCaregiverId ?? null,
          fromCaregiverName: s.fromCaregiverName ?? null,
          expiresAt:         s.expiresAt ?? null,
        };
      };
      const [mineSnap, openSnap] = await Promise.all([
        db.collection("shift_swap_requests").where("fromCaregiverId", "==", lsCaregiverId).where("status", "in", ["open", "accepted"]).limit(20).get(),
        db.collection("shift_swap_requests").where("status", "==", "open").limit(30).get(),
      ]);
      const myRequests = mineSnap.docs.map(swapFields);
      const openOffers = openSnap.docs
        .map(swapFields)
        .filter(s => s.fromCaregiverId !== lsCaregiverId)
        .filter(s => !s.expiresAt || String(s.expiresAt) > nowIso)
        .slice(0, 10);
      return { success: true, myRequests, openOffers, count: myRequests.length + openOffers.length };
    }

    return toolError("INVALID_INPUT", `Unknown tool: ${name}`);
    })();
    if (trackTool) {
      // Post-execution observability must never fail an already-successful tool
      // call: a throw here would be caught by the outer catch and returned to
      // the caller as UNAVAILABLE even though `result` is valid. Isolate it.
      try {
        const errorReason = toolFailureReason(result);
        await recordMcpToolStatus({
          name,
          input,
          status: errorReason ? "failed" : "executed",
          ...(errorReason ? { errorReason } : {}),
        });
        if (shouldAlertForToolFailure(errorReason)) {
          await createCaraOpsAlert({
            type: "cara_tool_failed",
            severity: "medium",
            phone: stringInput(input, "phone"),
            userId: stringInput(input, "userId") ?? stringInput(input, "clientId") ?? stringInput(input, "caregiverId"),
            role: stringInput(input, "userType") ?? stringInput(input, "role"),
            source: "mcp_dispatcher",
            toolName: name,
            targetDocId: targetDocIdFromToolInput(input),
            message: `Evia tool failed: ${name}`,
            reason: errorReason,
          });
        }
      } catch (ledgerErr) {
        console.warn("MCP post-execution ledger/alert write failed (non-blocking)", { name, ledgerErr: sanitizeErrorReason(ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)) });
      }
    }
    return result;
  } catch (err) {
    // Sanitize before logging too — the raw error/stack can carry tokens, URLs,
    // or PII that must not land in Cloud Logging (same redaction as the persisted
    // errorReason below).
    const errorReason = sanitizeErrorReason(err instanceof Error ? err.message : String(err));
    console.error(`handleToolCall [${name}] error:`, errorReason);
    if (trackTool) {
      await recordMcpToolStatus({
        name,
        input,
        status: "failed",
        errorReason,
      }).catch((ledgerErr) => console.warn("MCP ledger failure write failed", { name, ledgerErr }));
      await createCaraOpsAlert({
        type: "cara_tool_exception",
        severity: "medium",
        phone: stringInput(input, "phone"),
        userId: stringInput(input, "userId") ?? stringInput(input, "clientId") ?? stringInput(input, "caregiverId"),
        role: stringInput(input, "userType") ?? stringInput(input, "role"),
        source: "mcp_dispatcher",
        toolName: name,
        targetDocId: targetDocIdFromToolInput(input),
        message: `Evia tool threw: ${name}`,
        reason: errorReason,
      }).catch(() => {});
    }
    return toolError("UNAVAILABLE", `Tool ${name} is temporarily unavailable`);
  }
}

async function runActionNativeMcpWrite(
  name: string,
  input: Record<string, unknown>,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  const { isSupportedMcpWriteAction, runMcpWriteCaraAction } = await import("../agents/actions/mcpWriteActionAdapter");
  if (!isSupportedMcpWriteAction(name)) return execute();
  try {
    return await runMcpWriteCaraAction(name, input, async () => {
      const result = await execute();
      if (isToolErrorResult(result)) throw new McpToolResultError(result);
      return result;
    });
  } catch (err) {
    if (err instanceof McpToolResultError) return err.result;
    const errorName = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    if (errorName === "CaraActionValidationError") {
      return toolError("INVALID_INPUT", message);
    }
    if (errorName === "CaraActionAccessError") {
      return toolError("PERMISSION_DENIED", message);
    }
    throw err;
  }
}

class McpToolResultError extends Error {
  constructor(readonly result: unknown) {
    super("MCP tool returned a structured error");
    this.name = "McpToolResultError";
  }
}

function isToolErrorResult(result: unknown): boolean {
  return !!(
    result &&
    typeof result === "object" &&
    (result as { _toolError?: boolean })._toolError === true
  );
}
