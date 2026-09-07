import * as admin from "firebase-admin";
import { runMatchingForClient } from "../agents/matchingAgent";
import { requestVideoInterview, VideoInterviewRequestError } from "../agents/videoInterviewRequest";
import { logHealthDataAccessed, logBookingCreated, logAudit } from "../observability/auditLog";
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
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { apptStartMs, businessTodayStr } from "../utils/scheduledTime";
import { canonicalApptFields } from "../utils/appointmentDoc";
import { isSeededCaregiver } from "../agents/actions/getCaregiverPreviewAction";
import { BILLING_AUTHORITY_VERSION, bookedWindowMillis, createValidatedShiftHours, ValidatedShiftHoursError } from "../billing/createValidatedShiftHours";
import { resolveShiftBillableAmount } from "../billing/shiftBillingAmounts";
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
import { caregiverAnnualAmount, clientMonthlyAmount } from "../config/pricing";
import { logAgentAction } from "../observability/actionLedger";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import {
  createCaregiverReferralInvite,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";

const db = admin.firestore();

// ── Booking quote primitive (U9b) ─────────────────────────────────────────────
// The read/compute concern extracted out of `request_booking` so the model can
// reason about a booking in steps — look up the rate, quote the cost, THEN commit
// — instead of one opaque all-or-nothing tool. This helper is pure (one Firestore
// READ + arithmetic, no writes), shared by `get_caregiver_booking_rate`,
// `quote_booking`, and reusable by the committing `request_booking` path.
// Shared literal union for structured tool failures (see toolError below).
type ToolErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "UNAVAILABLE" | "CONFLICT" | "FORBIDDEN" | "RATE_UNKNOWN" | "IDENTITY_REQUIRED" | "MEMBERSHIP_REQUIRED" | "RATE_LIMITED";

type BookingQuoteResult =
  | { ok: false; code: ToolErrorCode; message: string }
  | {
      ok: true;
      caregiverId:   string;
      caregiverName: string;
      hourlyRate:    number;
      durationHours: number;
      dates:         string[];
      // One line per visit date so the family sees exactly what they're paying for.
      lineItems:     Array<{ date: string; hours: number; amount: number }>;
      totalEstimate: number;
    };

// "HH:MM" → minutes since midnight, or null if malformed.
function bookingTimeToMinutes(t: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Legacy prod caregiver docs can carry hourlyRate as a STRING ("25", "$25"):
// the onboarding correction path stored the raw user text whenever Number()
// failed to parse it (onboardingConversation.ts), and update_signup_field
// accepts free-text field values. A caregiver with a perfectly good "25" on
// file must stay bookable, so coerce STRICT plain-numeric strings — trimmed,
// with at most one leading "$" stripped (the plausible user-typed shape).
// Anything else ("flexible", "25/hr", "", "abc") stays unknown: returns null.
function coerceHourlyRate(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\$/, "");
    // Strict shape: digits with an optional decimal part. Rejects "", "-5",
    // "Infinity", "25/hr", "1e3" — those are RATE_UNKNOWN, not a guess.
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

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
async function resolveCaregiverRate(
  caregiverId: string,
): Promise<{ ok: true; caregiverName: string; hourlyRate: number } | { ok: false; code: ToolErrorCode; message: string }> {
  if (!caregiverId) return { ok: false, code: "INVALID_INPUT", message: "caregiverId is required" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  if (!cgSnap.exists) return { ok: false, code: "NOT_FOUND", message: "caregiver not found" };
  const cg = cgSnap.data() || {};
  const caregiverName = (cg.name ?? cg.fullName ?? "your caregiver") as string;
  const hourlyRate = coerceHourlyRate(cg.hourlyRate);
  if (hourlyRate === null) {
    return {
      ok:   false,
      code: "RATE_UNKNOWN",
      message:
        `${caregiverName} has no hourly rate on file, so nothing was quoted or booked. ` +
        `Do NOT assume, invent, or state any dollar rate. Tell the family you need to confirm ` +
        `this caregiver's rate first, and do not quote or book until a real rate is on file. ` +
        `If the family needs this resolved now, use create_support_ticket so the team can confirm the caregiver's rate.`,
    };
  }
  return { ok: true, caregiverName, hourlyRate };
}

// Build a full cost quote for a proposed booking. No write — safe to call freely.
async function buildBookingQuote(input: {
  caregiverId?: unknown;
  dates?:       unknown;
  startTime?:   unknown;
  endTime?:     unknown;
}): Promise<BookingQuoteResult> {
  const caregiverId = String(input.caregiverId ?? "");
  if (!caregiverId || !input.dates || !input.startTime || !input.endTime) {
    return { ok: false, code: "INVALID_INPUT", message: "caregiverId, dates, startTime, endTime are required" };
  }
  const dateList = (Array.isArray(input.dates) ? input.dates : [input.dates]).map(String).filter(Boolean);
  if (dateList.length === 0) return { ok: false, code: "INVALID_INPUT", message: "at least one date is required" };

  const startMin = bookingTimeToMinutes(input.startTime);
  const endMin   = bookingTimeToMinutes(input.endTime);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return { ok: false, code: "INVALID_INPUT", message: "startTime/endTime must be 'HH:MM' with end after start" };
  }
  const durationHours = Math.round(((endMin - startMin) / 60) * 100) / 100;

  const rate = await resolveCaregiverRate(caregiverId);
  if (!rate.ok) return rate;

  const perVisit  = Math.round(durationHours * rate.hourlyRate * 100) / 100;
  const lineItems = dateList.map((date) => ({ date, hours: durationHours, amount: perVisit }));
  const totalEstimate = Math.round(perVisit * dateList.length * 100) / 100;

  return {
    ok:            true,
    caregiverId,
    caregiverName: rate.caregiverName,
    hourlyRate:    rate.hourlyRate,
    durationHours,
    dates:         dateList,
    lineItems,
    totalEstimate,
  };
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
    description: "List all seniors in a client's household. Returns name, age, and seniorId for each. Use this when a client with multiple seniors starts a conversation so you know who to ask about.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_care_journal",
    description: "Get recent care journal entries for a senior, including wellness, meals, medications, and notes.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's user ID" },
        limit:    { type: "number", description: "Number of entries to return (default 5)" },
      },
      required: ["seniorId"],
    },
  },
  {
    name: "get_upcoming_appointments",
    description: "Get upcoming confirmed or pending appointments for a client.",
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
      "Show a family real, currently-available caregivers near them — same ranking (distance, skills, " +
      "availability, rating) as the website's own Nearby Caregivers widget, with the same filters the " +
      "website's Browse Caregivers page offers. Call this ANY time a client asks to see, browse, or find " +
      "caregivers, at any point in their relationship with Evia — this is NOT gated on identity verification " +
      "or membership (browsing was never gated on the website either; only messaging, booking, and interview " +
      "requests are — use those tools' own gates for that). Always reads the family's CURRENT location and " +
      "care needs fresh; never rely on something they mentioned earlier in the conversation instead of " +
      "calling this again. Defaults to the top 4, matching the dashboard widget — if they ask to see more, " +
      "or want something more specific (a minimum rating, years of experience, a rate ceiling, further than " +
      "the default 25 miles), pass the matching filter instead of just re-calling with no changes. Every " +
      "caregiver this can ever return is already background-check cleared — that's a precondition of showing " +
      "up here at all, not an optional filter, so never ask the family whether they want that. Never re-shows " +
      "someone already shown this conversation — a follow-up call (e.g. a 'show me more' ask) automatically " +
      "excludes everyone already surfaced and returns new people instead.",
    input_schema: {
      type: "object",
      properties: {
        clientId:  { type: "string", description: "The client's user ID" },
        careNeeds: {
          type: "array", items: { type: "string" },
          description: "Optional — override the care needs on file if the family described something different in this request.",
        },
        limit: {
          type: "number",
          description: "How many caregivers to return (default 4, matching the dashboard widget; max 10). You don't need to raise this yourself for a 'show me more' ask — every call already excludes caregivers already shown, so calling again with no changes surfaces new people.",
        },
        maxDistanceMiles: {
          type: "number",
          description: "Override the default 25-mile radius when the family asks for a wider search.",
        },
        minRating: {
          type: "number",
          description: "Only show caregivers rated at least this (e.g. 4, 4.5) — mirrors the website's Rating filter (Any/3+/4+/4.5+).",
        },
        minExperienceYears: {
          type: "number",
          description: "Only show caregivers with at least this many years of experience — mirrors the website's Experience filter.",
        },
        maxHourlyRate: {
          type: "number",
          description: "Only show caregivers at or under this hourly rate — mirrors the website's Max Rate filter.",
        },
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
    description: "Get a caregiver's profile — name, rate, specialties, rating — AND their recent reviews, in one call.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's ID" },
        reviewLimit: { type: "number", description: "Max recent reviews to include (default 5, max 20)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_billing_summary",
    description: "Get the client's current subscription status and recent billing history.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The client's user ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "find_replacement_caregivers",
    description: "Find a REPLACEMENT caregiver for an existing booking — a specific visit or ongoing arrangement that's falling through (the current caregiver cancelled, isn't working out, etc.). This is NOT the tool for a general 'show me caregivers' / 'who's available near me' request — use find_nearby_caregivers for that (it has the real distance/skills/rating filters and matches what the website itself shows; this tool doesn't). Session context (phone, chatId, clientId) is injected automatically — do NOT ask the user for these. Optionally narrow the search with the filters below when the family is specific (e.g. 'find someone available mornings near 95020 who can do dementia care').",
    input_schema: {
      type: "object",
      properties: {
        needs:              { type: "string", description: "Specific care needs to bias matching, e.g. 'dementia care, mobility assistance' (optional)" },
        nearZip:            { type: "string", description: "ZIP code to center the search on, overriding the profile default (optional)" },
        availabilityWindow: { type: "string", description: "Desired availability, e.g. 'weekday mornings', 'overnights' (optional)" },
        radiusMiles:        { type: "number", description: "Search radius in miles (optional)" },
      },
      required: [],
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
    name: "quote_booking",
    description: "Estimate what a booking will COST without creating it: returns per-visit hours, the hourly rate, a line item per date, and the total estimate. Read-only — books nothing. Call this to tell the family the price first, then call request_booking to actually commit once they're happy. clientId is injected automatically.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string" },
        dates:       { type: "array", items: { type: "string" }, description: "ISO date strings (YYYY-MM-DD)" },
        startTime:   { type: "string", description: "e.g. '09:00'" },
        endTime:     { type: "string", description: "e.g. '17:00'" },
      },
      required: ["caregiverId", "dates", "startTime", "endTime"],
    },
  },
  {
    name: "request_booking",
    description: "Commit a booking request for a caregiver (the final step — this is the write). Returns the booking task ID; the family then approves it. Prefer calling quote_booking first so the family sees the cost before you commit. clientId is injected automatically — do NOT ask the user for it.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string" },
        dates:       { type: "array", items: { type: "string" }, description: "ISO date strings (YYYY-MM-DD)" },
        startTime:   { type: "string", description: "e.g. '09:00'" },
        endTime:     { type: "string", description: "e.g. '17:00'" },
        recipientFirstName: { type: "string", description: "First name of the care recipient this visit is for. Pass it whenever the household cares for more than one person (so the visit is attributed to the right person); omit for single-recipient households." },
        interviewId: { type: "string", description: "Pass this when the family is booking this caregiver right after a completed interview (e.g. after a 'strong' fit from submit_interview_feedback). Links the booking back to the job post and marks the caregiver's application accepted, matching the website's Send Booking Request flow. Omit for a direct/matching-flow booking with no job post involved." },
      },
      required: ["caregiverId", "dates", "startTime", "endTime"],
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
    description: "List the backup caregiver options for an appointment whose caregiver called out. Read-only. clientId is injected automatically — only the appointment's owner may view its backups.",
    input_schema: {
      type: "object",
      properties: { appointmentId: { type: "string" } },
      required: ["appointmentId"],
    },
  },
  {
    name: "select_callout_backup",
    description: "Assign a chosen backup caregiver to an appointment whose original caregiver called out. Reassigns the visit and notifies both parties. clientId is injected automatically — only the appointment's owner may select.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId:     { type: "string" },
        backupCaregiverId: { type: "string", description: "id of the backup caregiver to assign (from get_callout_backups)" },
      },
      required: ["appointmentId", "backupCaregiverId"],
    },
  },
  {
    name: "request_callout_refund",
    description: "Request a refund for an appointment when the caregiver called out and no suitable backup is available. Cancels the visit and files a refund request for admin review. clientId is injected automatically — only the appointment's owner may request.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string" },
        reason:        { type: "string", description: "Optional reason for the refund" },
      },
      required: ["appointmentId"],
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
          enum: ["cancel_pending_request", "cancel_whole_booking", "cancel_visit", "cancel_pending_amendment", "resend_booking"],
          description:
            "cancel_pending_request — withdraw a booking still awaiting the caregiver's YES/NO (needs bookingRequestId). " +
            "cancel_whole_booking — cancel an accepted booking, every still-scheduled visit under it (needs bookingRequestId). " +
            "cancel_visit — cancel ONE scheduled visit, leaving the rest of the booking active (needs shiftId). " +
            "cancel_pending_amendment — withdraw a schedule-change request still awaiting the caregiver's response (needs amendmentId). " +
            "resend_booking — resend a previously declined/cancelled booking request to the same caregiver (needs bookingRequestId).",
        },
        bookingRequestId: { type: "string", description: "The booking_requests document ID — required for cancel_pending_request, cancel_whole_booking, resend_booking" },
        shiftId:          { type: "string", description: "The shifts document ID — required for cancel_visit" },
        amendmentId:      { type: "string", description: "The booking_amendments document ID — required for cancel_pending_amendment" },
      },
      required: ["clientId", "action"],
    },
  },
  {
    name: "request_schedule_amendment",
    description:
      "Request a schedule change on an existing booking — either a one-off time change for a single visit (cancel the old " +
      "one first with cancel_visit, then call this for the replacement) or adding a new recurring day to an ongoing booking. " +
      "The caregiver must accept before the new visit(s) are added. Confirm before calling.",
    input_schema: {
      type: "object",
      properties: {
        bookingRequestId: { type: "string", description: "The booking_requests document ID this amendment applies to" },
        clientId:         { type: "string", description: "The client's user ID" },
        date:             { type: "string", description: "YYYY-MM-DD — the single date for a one-off time change" },
        startTime:        { type: "string", description: "e.g. '14:00'" },
        endTime:          { type: "string", description: "e.g. '16:00'" },
        notes:            { type: "string", description: "Optional note to the caregiver" },
        ongoing:          { type: "boolean", description: "true to add this as a standing recurring day, false (default) for a single one-off visit" },
      },
      required: ["bookingRequestId", "clientId", "date", "startTime", "endTime"],
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
    name: "send_caregiver_message",
    description:
      "Send a message to a caregiver on behalf of the family. Use when the family asks you to relay something to the caregiver. " +
      "Delivers by text AND posts into the same chat thread the family sees in their website Inbox, so a caregiver's reply " +
      "(sent via send_client_message) shows up there too, not just in this SMS conversation. " +
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
    name: "get_recurring_schedule",
    description: "Get the active recurring care schedule for a client — days of the week, times, caregiver, and status.",
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
      "Create an ADDITIONAL care recipient (senior) for this family's household — the same as the '+ Add' button on the website's Care Plan page. " +
      "Use when a family says they want to add another parent/relative they care for. " +
      "Do NOT use to edit the existing senior — there is no tool to patch an existing senior's name/needs/location after creation. The new profile is linked to the family automatically and shows up as a new tab on the Care Plan page.",
    input_schema: {
      type: "object",
      properties: {
        clientId:     { type: "string", description: "Injected automatically — the owning family account." },
        userId:       { type: "string", description: "Injected automatically." },
        name:         { type: "string", description: "The senior's name." },
        relationship: { type: "string", description: "Relationship to the family member, e.g. 'mother', 'father'." },
        age:          { type: "number", description: "The senior's age, if known." },
        needs:        { type: "array", items: { type: "string" }, description: "Care needs, e.g. ['mobility','medication reminders']." },
        conditions:   { type: "array", items: { type: "string" }, description: "Known conditions, if shared." },
        location:     { type: "string", description: "City or address, if different from the family's." },
      },
      required: ["clientId", "name"],
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
    name: "delete_review",
    description: "Delete a review the family previously left for a caregiver. Permanent — confirm before calling.",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, reviewId: { type: "string", description: "The review document id." } }, required: ["clientId", "reviewId"] },
  },
  {
    name: "delete_care_journal_entry",
    description: "Hide an incorrect care journal entry from the family view (soft-delete — the entry is retained in the care record). Confirm before calling.",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, entryId: { type: "string", description: "The care_journal document id." } }, required: ["clientId", "entryId"] },
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
    description: "Record the family's qualitative feedback about a caregiver match (e.g. 'great with mom but often late'). Feeds future matching. Distinct from submit_review (post-visit star rating).",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, caregiverId: { type: "string" }, sentiment: { type: "string", description: "'positive', 'neutral', or 'negative'" }, note: { type: "string" } }, required: ["clientId", "caregiverId", "note"] },
  },
  {
    name: "create_job_post",
    description: "Post a new caregiver job for the family so nearby caregivers can apply. Collect care needs, schedule, hourly rate, and a 5-digit zip code (required — never accept a typed city, the zip auto-derives it, same as onboarding); confirm, then call.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "Injected automatically." },
        careTypes:     { type: "array", items: { type: "string" } },
        frequency:     { type: "string", description: "e.g. 'weekly', 'one-time'" },
        days:          { type: "array", items: { type: "string" } },
        timeOfDay:     { type: "array", items: { type: "string" } },
        hourlyRate:    { type: "number" },
        streetAddress: { type: "string", description: "Optional street address — saved to the family's care plan, not shown on the public job post" },
        zipCode:       { type: "string", description: "5-digit zip — required, city/state are auto-derived from it" },
        startDate:     { type: "string", description: "YYYY-MM-DD" },
        endDate:       { type: "string", description: "YYYY-MM-DD — only if this is a date-limited request, not ongoing" },
        careLevel:          { type: "string", description: "Optional overall care level" },
        minHoursPerWeek:    { type: "number", description: "Optional minimum hours per week" },
        screeningQuestions: { type: "array", items: { type: "string" }, description: "Optional custom screening questions for applicants" },
        careRecipients: {
          type: "array",
          description: "Only if this covers a care recipient not already on file — each is saved to the family's roster and care plan.",
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
      required: ["clientId", "careTypes", "hourlyRate", "zipCode"],
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
      "Check for items that need the family's attention — pending booking approvals, " +
      "hire decisions after interviews, and unreviewed job applications. " +
      "Call this proactively when the family says hello or asks 'anything going on?'",
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
      "Get the structured care plan for a senior — includes medications, care needs, doctor contacts, dietary notes, and any special instructions. " +
      "Call this when the family asks about medications, care instructions, or what the caregiver should know.",
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
      "Update the care plan for a senior — care needs, general notes, lifestyle & preferences, care location, emergency contacts, or home access codes. " +
      "This is a non-medical marketplace: never solicit or record medications, diagnoses, or other medical details. " +
      "Always confirm the change with the family before calling. Tell them what you're updating.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        field:    { type: "string", description: "Which field to update: 'careNeeds', 'notes', 'lifestyle', 'careLocation', 'emergencyContacts', or 'accessCodes'" },
        value:    {
          description:
            "The new value. For array fields (careNeeds, emergencyContacts), pass an array. For string fields, pass a string. " +
            "emergencyContacts items: {name, relation, phone, isPrimary}. " +
            "lifestyle: a partial object of any of {favoriteActivities[], entertainment[], enjoysConversation, prefersQuiet, familyInArea, familyVisitFreq, friendsVisitors, friendsVisitFreq, hasAppointments, appointmentsDetails} — only the keys given are changed, others are left as they were (always action:'set'). " +
            "careLocation: {street, city, state, zipCode} — replaces the recipient's care address (always action:'set').",
        },
        action:   { type: "string", enum: ["set", "append", "remove"], description: "set = replace, append = add to array, remove = remove from array. lifestyle/careLocation only support 'set'." },
        recipientFirstName: { type: "string", description: "For 'careNeeds'/'notes'/'lifestyle'/'careLocation' only, when the household has more than one care recipient — the first name of who this update is about (optional; omit if there's only one)" },
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
    name: "submit_review",
    description:
      "Submit a public star rating and optional comment for a caregiver after a completed visit. " +
      "Rating must be 1–5. One review per appointment.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string",  description: "The caregiver's Firestore document ID" },
        appointmentId: { type: "string",  description: "The appointment document ID being reviewed" },
        clientId:      { type: "string",  description: "The client's user ID" },
        rating:        { type: "integer", minimum: 1, maximum: 5, description: "Star rating 1–5" },
        comment:       { type: "string",  description: "Optional written comment" },
      },
      required: ["caregiverId", "appointmentId", "clientId", "rating"],
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
    name: "manage_recurring_schedule",
    description:
      "Pause, resume, or cancel a recurring care schedule. " +
      "Cancel removes all future confirmed visits — confirm with family first.",
    input_schema: {
      type: "object",
      properties: {
        scheduleId:  { type: "string", description: "The recurring_schedules document ID" },
        clientId:    { type: "string", description: "The client's user ID" },
        action:      { type: "string", enum: ["pause", "resume", "cancel"], description: "Action to take" },
        pauseReason: { type: "string", description: "Optional reason for pausing" },
      },
      required: ["scheduleId", "clientId", "action"],
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
        message:        { type: "string", description: "Optional message to the caregiver (reject only)" },
      },
      required: ["applicationId", "clientId", "decision"],
    },
  },
  {
    name: "submit_interview_feedback",
    description:
      "Submit your decision after interviewing a caregiver. Also marks the interview completed (the website's own separate " +
      "'Mark as Completed' step, done automatically here since it's one turn in a conversation, not two button clicks). " +
      "Options: 'strong' (proceed to hire), 'maybe' (keep considering), 'no' (not a fit — matches the website's 'Not Selected').",
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
      "Request an instant payout of the caregiver's instantly-available balance — free, arrives within ~30 minutes. " +
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
    name: "schedule_interview",
    description:
      "Schedule a video interview between a client and a caregiver applicant. " +
      "Creates the interview record; the Google Meet link is generated and texted to both parties automatically " +
      "once the caregiver confirms via respond_to_interview_request — do NOT tell the family a link exists yet. " +
      "Confirm date/time with the client before calling. Same rules as the website's own Request Interview modal: " +
      "the caregiver must be a real, currently-bookable match, and families are capped at 5 interview requests per " +
      "day — if you get a RATE_LIMITED error, tell them honestly they've hit today's limit and to try again tomorrow. " +
      "The website's modal also offers interview type (video/phone/in-person), an optional related job post, and " +
      "optional notes — mention these are options if it fits naturally (e.g. after they name a caregiver: \"video, " +
      "phone, or in person? And anything you'd like me to note for the interview?\"), but never make them a required " +
      "extra question — video with no notes is a completely normal default, same as leaving the site's fields blank.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "The client's user ID" },
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        applicationId: { type: "string", description: "The job_applications document ID (optional)" },
        preferredDate: { type: "string", description: "Date in YYYY-MM-DD format" },
        preferredTime: { type: "string", description: "Time in HH:MM (24h) format" },
        interviewType: { type: "string", enum: ["video","phone","in_person"], description: "Default: video" },
        jobId:         { type: "string", description: "Optional — the job_posts document ID this interview relates to, if the family mentions a specific posted job." },
        notes:         { type: "string", description: "Optional — anything the family wants to flag for the interview (topics to discuss, etc.), same as the website modal's Notes field." },
      },
      required: ["clientId", "caregiverId", "preferredDate", "preferredTime"],
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
      "List a client's confirmed/active AND past caregivers — name, phone, rating, whether they're currently active, next scheduled visit, and who they're caring for. Matches the website's My Care Team page.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_invoice_history",
    description:
      "Get a client's past shift invoices — caregiver name, date, hours worked, amount, and payment status.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        limit:    { type: "number", description: "Number of invoices to return (default 5, max 20)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_invoice_details",
    description:
      "Get a detailed itemized breakdown of a client's invoice — each visit with date, caregiver, hours, rate, and amount. Use when client asks to see their bill.",
    input_schema: {
      type: "object",
      properties: {
        clientId:  { type: "string", description: "The client's user ID" },
        invoiceId: { type: "string", description: "Specific invoice ID (optional — omit for most recent)" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "create_refund_request",
    description:
      "Submit a refund request for a completed visit. Creates a pending refund for admin review. Only call after client has confirmed which visit and agreed to submit.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "The client's user ID" },
        appointmentId: { type: "string", description: "The appointment document ID to refund" },
        reason:        { type: "string", description: "Reason for refund (optional)" },
      },
      required: ["clientId", "appointmentId"],
    },
  },
  {
    name: "edit_job_post",
    description:
      "Edit an existing open job post. Only call after client has confirmed what to change. " +
      "Cannot change status — use cancel_job_post for that.",
    input_schema: {
      type: "object",
      properties: {
        jobId:        { type: "string", description: "The job_posts document ID" },
        clientId:     { type: "string", description: "The client's user ID (ownership check)" },
        rate:         { type: "number", description: "New hourly rate" },
        description:  { type: "string", description: "New job description" },
        startDate:    { type: "string", description: "New start date YYYY-MM-DD" },
        daysOfWeek:   { type: "array", items: { type: "string" }, description: "New days array" },
        timeOfDay:    { type: "array", items: { type: "string" }, description: "New time-of-day array" },
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
      "Get the most recent inbox messages between the user and their caregiver(s) or client(s). " +
      "Use when the user asks what was said, wants to catch up on messages, or references a prior conversation.",
    input_schema: {
      type: "object",
      properties: {
        userId:       { type: "string", description: "The current user's ID (client or caregiver)" },
        counterpartId:{ type: "string", description: "Specific caregiver or client ID to filter (optional)" },
        limit:        { type: "number", description: "Messages per thread to return (default 5, max 20)" },
      },
      required: ["userId"],
    },
  },

  // ── Platform-action tools (post-onboarding) ───────────────────────────────
  {
    name: "list_client_jobs",
    description:
      "List job posts created by this client. Returns open, filled, and closed postings with applicant counts.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        status:   { type: "string", enum: ["open","filled","cancelled","all"], description: "Filter by status (default: all)" },
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
      "List caregivers who applied to one of the client's job posts. Returns name, proposed rate, cover note, and status.",
    input_schema: {
      type: "object",
      properties: {
        jobId:    { type: "string", description: "The job_posts document ID" },
        clientId: { type: "string", description: "The client's user ID (access check)" },
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
      "List shift-hour submissions awaiting client approval. Returns caregiver name, date, hours, and amount owed.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "get_care_journal_client",
    description:
      "Get recent care journal entries for a client's senior — resolves the senior automatically from clientId. " +
      "Returns notes, mood, activities, and caregiver name for each entry.",
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
    name: "modify_recurring_schedule",
    description:
      "Change the days and/or times of an active recurring care schedule. " +
      "Cancels future appointments from the old schedule and generates new ones with the updated days/times. " +
      "Confirm with the client before calling.",
    input_schema: {
      type: "object",
      properties: {
        scheduleId:   { type: "string", description: "The recurring_schedules document ID" },
        clientId:     { type: "string", description: "The client's user ID (ownership check)" },
        newDays:      { type: "array", items: { type: "string" }, description: "New days of the week (e.g. ['Tuesday','Thursday']). Omit to keep current days." },
        newStartTime: { type: "string", description: "New start time HH:MM. Omit to keep current start time." },
        newEndTime:   { type: "string", description: "New end time HH:MM. Omit to keep current end time." },
      },
      required: ["scheduleId", "clientId"],
    },
  },
  {
    name: "get_payment_update_link",
    description:
      "Generate a Stripe Billing Portal link for the client to securely update their payment method. " +
      "Send this link to the client. Do NOT ask for card details directly.",
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
  {
    name: "initiate_client_swap",
    description: "Find available replacement caregivers for a specific visit date. Call when a client wants to swap their caregiver for a specific date.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "The client's user ID" },
        appointmentId: { type: "string", description: "The appointment to swap caregiver for" },
      },
      required: ["clientId", "appointmentId"],
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
        photoUrl:  { type: "string", description: "New profile photo URL (optional)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "update_communication_preferences",
    description: "Toggle the family's communication preferences. Confirm each change with them first.",
    input_schema: {
      type: "object",
      properties: {
        userId:               { type: "string", description: "The user's ID" },
        newsletter:           { type: "boolean", description: "Receive the Evia newsletter" },
        newMatchAlerts:       { type: "boolean", description: "Notify when new caregiver matches are found" },
        reviewNotifications:  { type: "boolean", description: "Notify when caregivers receive reviews" },
        privacyShowBookings:  { type: "boolean", description: "Show the family's booking calendar to caregivers" },
      },
      required: ["userId"],
    },
  },
  {
    name: "request_email_change",
    description: "Request a change of the family's email address. Sends a verification link to the new email; does NOT change the auth email until verified. Tell the family they'll need to click the link from the new inbox.",
    input_schema: {
      type: "object",
      properties: {
        userId:   { type: "string", description: "The user's ID" },
        newEmail: { type: "string", description: "The new email address" },
      },
      required: ["userId", "newEmail"],
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
  {
    name: "list_saved_caregivers",
    description: "List the family's saved/favorite caregivers, with name and rating.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
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
    name: "get_refund_requests",
    description:
      "List the refund requests a client has submitted and their review status. " +
      "Use when the family asks 'what happened with my refund?' or 'is my refund approved yet?'.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's Firestore document ID" },
      },
      required: ["clientId"],
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
      "caregiverId for a caregiver's. Use before cancel_interview or when someone asks 'when is my interview?'.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string", description: "The client's user ID (provide this OR caregiverId)" },
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID (provide this OR clientId)" },
        status:      { type: "string", description: "Optional filter: scheduled, confirmed, declined, cancelled, completed" },
      },
      required: [],
    },
  },
  {
    name: "cancel_interview",
    description:
      "Cancel a scheduled interview. Either participant can cancel their own interview; the other side is notified. " +
      "Confirm before calling. To propose a new time instead, caregivers should use respond_to_interview_request.",
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
  "get_care_journal",
  "get_senior_profile",
  "read_memory_file",
  "update_memory_file",
  "edit_memory_file",
  "search_memory",
  "get_billing_summary",
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
    name: "weekly-care-summary",
    description: "Sunday morning digest — summarizes the week's care visits and previews the upcoming week.",
    arguments: [
      { name: "clientName",     description: "Family member's first name",    required: true },
      { name: "seniorName",     description: "Senior's name",                 required: true },
      { name: "completedCount", description: "Number of completed visits",    required: true },
      { name: "journalContext", description: "Formatted journal entry lines", required: true },
      { name: "apptContext",    description: "Upcoming appointment lines",    required: true },
    ],
  },
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
    case "weekly-care-summary": {
      const { clientName, seniorName, completedCount, journalContext, apptContext } = args;
      return [
        `You are Evia. Write a Sunday morning text to ${clientName} about ${seniorName}'s week.`,
        ``,
        `Write it like you actually know both of them and genuinely care how the week went.`,
        `If it was a good week, let that warmth come through.`,
        `If there were concerns, acknowledge them honestly without being alarming.`,
        `Mention the upcoming week naturally — not as a list.`,
        ``,
        `Do not follow a format. Just tell them what matters most.`,
        `Under 200 words. Plain text only. No markdown. No bullet points.`,
        ``,
        `This week's data:`,
        `- ${completedCount} visit(s) completed`,
        `Journal entries:\n${journalContext || "None"}`,
        `Upcoming:\n${apptContext || "Nothing scheduled yet"}`,
      ].join("\n");
    }

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
// called from read-only or conversational paths, only these three action tools.
async function checkClientAccessGate(
  clientId: string | undefined,
  action: "message" | "booking" | "interview",
): Promise<ReturnType<typeof toolError> | null> {
  if (!clientId) return toolError("PERMISSION_DENIED", "Cannot verify who this is for — clientId is required.");
  const clientSnap = await db.collection("users").doc(clientId).get();
  const clientData = clientSnap.data() ?? {};
  if (clientData.identityCheckStatus !== "verified") {
    return toolError("IDENTITY_REQUIRED", `This family needs to complete identity verification before ${action === "message" ? "messaging a caregiver" : action === "booking" ? "booking a caregiver" : "scheduling an interview"} — send them the identity verification link.`);
  }
  const membershipActive = clientData.subscriptionActive === true
    || clientData.membershipStatus === "active"
    || clientData.membershipStatus === "trialing";
  if (!membershipActive) {
    return toolError("MEMBERSHIP_REQUIRED", `This family's membership isn't active — they need an active membership before ${action === "message" ? "messaging a caregiver" : action === "booking" ? "booking a caregiver" : "scheduling an interview"}. Offer to send the membership payment link.`);
  }
  return null;
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
  if (name === "find_replacement_caregivers") return false;
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
  // find_nearby_caregivers is a pure read: scores/ranks already-fetched
  // publicCaregiverProfiles docs and returns them — no writes, no SMS, no
  // side effects (unlike find_replacement_caregivers above).
  "find_nearby_caregivers",
  // find_replacement_caregivers was WRONGLY on this list (double-send audit
  // 2026-07-06): it texts the family (match gallery / status), writes
  // interview_requests + agent_sessions + admin_alerts, and resolves
  // commitments — a shadow run was sending real SMS. It is mutating; it must
  // be synthesized under shadow like every other side-effecting tool.
  "list_saved_caregivers",
  "get_recurring_schedule",
  "get_billing_summary", "get_invoice_history", "get_invoice_details",
  "get_payout_history", "get_caregiver_earnings", "get_pending_timesheets", "get_tax_summary",
  "get_care_journal", "get_care_journal_client", "get_care_plan",
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
async function createVideoInterviewRequestForTool(params: {
  clientId: string; caregiverId: string; applicationId?: string;
  preferredDate: string; preferredTime: string; interviewType?: string;
  jobId?: string; notes?: string;
  /** Resolves any open "interview" commitment (interviewPromiseNet.ts) the
   *  instant a real schedule_interview call actually succeeds. */
  phone?: string;
}): Promise<Record<string, unknown>> {
  const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType, jobId, notes, phone } = params;
  const { parseScheduledTimeMs } = await import("../utils/scheduledTime");
  const startMs = parseScheduledTimeMs(`${preferredDate}T${preferredTime}:00`);
  if (Number.isNaN(startMs)) return toolError("INVALID_INPUT", "preferredDate/preferredTime could not be parsed");
  const scheduledTime = new Date(startMs).toISOString();

  try {
    const interview = await requestVideoInterview({
      clientId, caregiverId, scheduledTime, applicationId, interviewType, jobId, notes,
      source: "mcp:schedule_interview",
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
    if (err instanceof VideoInterviewRequestError) {
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
        // New model: query senior_profiles where clientId field matches
        const snap = await db.collection("senior_profiles")
          .where("clientId", "==", clientId)
          .limit(10)
          .get();
        if (!snap.empty) {
          return { success: true, results: snap.docs.map(d => ({ seniorId: d.id, ...d.data() })), hasMore: false };
        }
        // Fallback: old-style single senior (doc ID === clientId)
        const single = await db.collection("senior_profiles").doc(clientId).get();
        if (single.exists) {
          return { success: true, results: [{ seniorId: clientId, ...single.data() }], hasMore: false };
        }
        return { success: true, results: [], hasMore: false };
      }

      case "get_care_journal": {
        if (!input.seniorId) return toolError("INVALID_INPUT", "seniorId is required");
        const denied = await assertSeniorAccess(input.seniorId as string, input.clientId ?? input.userId);
        if (denied) return denied;
        logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_care_journal").catch(() => {});
        const limit = Math.min((input.limit as number) ?? 5, 20);
        const snap = await db
          .collection("care_journal")
          .where("seniorId", "==", input.seniorId)
          .orderBy("timestamp", "desc")
          .limit(limit + 1)
          .get();
        const docs = snap.docs.slice(0, limit).map((d) => d.data());
        return { success: true, results: docs, hasMore: snap.docs.length > limit };
      }

      case "get_upcoming_appointments": {
        if (!input.clientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.clientId as string, data: { source: "mcp:get_upcoming_appointments" } }).catch(() => {});
        // Business-timezone today — UTC drops tonight's visit during PT evenings
        const today = businessTodayStr();
        // A booking made via the newer booking_requests/shifts pipeline (2026-08-30)
        // never appears in `appointments` at all — query both and merge so a
        // family always sees every upcoming visit regardless of which pipeline
        // created it. `shifts` statuses: 'scheduled' (not yet started) and
        // 'in-progress' (today's visit, already checked in) both count as upcoming.
        const [apptSnap, shiftSnap] = await Promise.all([
          db.collection("appointments")
            .where("clientId", "==", input.clientId)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .where("date", ">=", today)
            .orderBy("date", "asc")
            .limit(6)
            .get(),
          db.collection("shifts")
            .where("clientId", "==", input.clientId)
            .where("status", "in", ["scheduled", "in-progress"])
            .where("date", ">=", today)
            .orderBy("date", "asc")
            .limit(6)
            .get(),
        ]);
        const merged = [...apptSnap.docs, ...shiftSnap.docs]
          .map((d) => d.data())
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const docs = merged.slice(0, 5);
        return { success: true, results: docs, hasMore: merged.length > 5 };
      }

      case "find_nearby_caregivers": {
        const {
          clientId, careNeeds: careNeedsOverride, phone,
          limit: limitInput, maxDistanceMiles, minRating, minExperienceYears, maxHourlyRate,
        } = input as Record<string, unknown>;
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required");

        const { loadLiveClientLocation } = await import("../agents/onboardingConversation");
        const location = await loadLiveClientLocation(clientId as string).catch(() => null);
        if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
          return toolError("NOT_FOUND", "No location on file for this family yet — get their city/zip before calling this again.");
        }

        let careNeeds: string[] = Array.isArray(careNeedsOverride) ? careNeedsOverride as string[] : [];
        if (!careNeeds.length) {
          const seniorSnap = await db.collection("senior_profiles").doc(clientId as string).get();
          careNeeds = (seniorSnap.data()?.needs as string[] | undefined) ?? [];
        }

        const { isSeededCaregiver, buildCaregiverPreviewResult } = await import("../agents/actions/getCaregiverPreviewAction");
        const { scoreAndRankCaregivers } = await import("../agents/caregiverMatchScoring");

        // Never re-show someone this family has already been sent this
        // conversation — tracked on the session the same way rejectedCaregiverIds
        // excludes DECLINED caregivers (matchingAgent.ts). If excluding them
        // leaves nobody (the local pool is small and "show more" has been asked
        // enough times to exhaust it), trim to the last 3 shown and retry —
        // mirrors matchingAgent.ts's identical rejection-exhaustion escalation
        // rather than dead-ending the conversation.
        const sessionRef = phone ? db.collection("agent_sessions").doc(phone as string) : null;
        const shownIds: string[] = sessionRef
          ? ((await sessionRef.get()).data()?.shownCaregiverIds as string[] | undefined) ?? []
          : [];
        // 2026-09-06: a caregiver the family already interviewed and made a
        // real hire/decline decision on (hire_decisions) could still
        // resurface here as if new — matchingAgent.ts had the identical gap,
        // fixed the same way there. Correction (Hamse): a decline isn't
        // permanent (the family may reconsider), only a hire is — so
        // declinedIds joins the trimmable shownIds, and only hiredIds stays
        // in the never-trimmed set.
        const decisionDocs = (
          await db.collection("hire_decisions").where("clientId", "==", clientId as string).limit(200).get()
        ).docs;
        const hiredIds: string[] = decisionDocs
          .filter((d) => d.data().decision === "hire")
          .map((d) => d.data().caregiverId as string).filter(Boolean);
        const declinedIds: string[] = decisionDocs
          .filter((d) => d.data().decision === "decline")
          .map((d) => d.data().caregiverId as string).filter(Boolean);
        for (const id of declinedIds) if (!shownIds.includes(id)) shownIds.push(id);

        const poolSnap = await db.collection("publicCaregiverProfiles")
          .where("onboardingStatus", "==", "profile_complete")
          .limit(200)
          .get();
        const allRawDocs = poolSnap.docs
          .map((doc) => ({ id: doc.id, data: { ...doc.data(), id: doc.id } }))
          .filter(({ data }) => !isSeededCaregiver(data));

        const resultLimit = Math.min(Math.max(Math.trunc((limitInput as number) ?? 4), 1), 10);
        const distanceCap = typeof maxDistanceMiles === "number" ? maxDistanceMiles : 25;

        const scoreOpts = {
          clientLocations: [{ lat: location.lat as number, lng: location.lng as number }],
          clientCareNeeds: careNeeds,
          clientSchedule: undefined,
          needsTransportation: false,
        };
        const applyPostFilters = (c: { data: Record<string, unknown> }) => {
          const d = c.data;
          if (typeof minRating === "number" && (Number(d.rating) || 0) < minRating) return false;
          if (typeof minExperienceYears === "number") {
            const yrs = Number(d.yearsExperience ?? d.experience) || 0;
            if (yrs < minExperienceYears) return false;
          }
          if (typeof maxHourlyRate === "number" && Number(d.hourlyRate) > maxHourlyRate) return false;
          return true;
        };
        // Rank a wider pool than we'll show (30, not resultLimit) — the extra
        // filters below (rating/experience/rate, mirroring the website's
        // Browse Caregivers filter panel) apply AFTER ranking, so they narrow
        // from a real pool instead of starving whatever the top-N happened to
        // already be trimmed to.
        const runPass = (excludeIds: string[]) => {
          const rawDocs = allRawDocs.filter(({ id }) => !excludeIds.includes(id));
          let ranked = scoreAndRankCaregivers(rawDocs, { ...scoreOpts, maxDistance: distanceCap, applyHardFilters: true, limit: 30 });
          let widenedPass = false;
          if (ranked.length === 0) {
            ranked = scoreAndRankCaregivers(rawDocs, { ...scoreOpts, applyHardFilters: false, limit: 30 });
            widenedPass = ranked.length > 0;
          }
          return { matches: ranked.filter(applyPostFilters).slice(0, resultLimit), widened: widenedPass };
        };

        // hiredIds is never trimmed on retry, unlike shownIds — a caregiver
        // the family already hired should never resurface, no matter how
        // thin the pool gets.
        let { matches, widened } = runPass([...shownIds, ...hiredIds]);
        if (matches.length === 0 && shownIds.length > 0) {
          const trimmedShown = shownIds.slice(-3);
          ({ matches, widened } = runPass([...trimmedShown, ...hiredIds]));
          if (sessionRef) await sessionRef.set({ shownCaregiverIds: trimmedShown }, { merge: true }).catch(() => {});
        }

        if (sessionRef && matches.length > 0) {
          await sessionRef.set({
            shownCaregiverIds: admin.firestore.FieldValue.arrayUnion(...matches.map((m) => m.data.id as string)),
          }, { merge: true }).catch(() => {});
        }

        return buildCaregiverPreviewResult({
          caregivers: matches.map((m) => m.data),
          widened,
          city: location.city as string | undefined,
          careNeeds,
          itemLimit: resultLimit,
        });
      }

      case "get_caregiver_info": {
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.caregiverId as string, data: { source: "mcp:get_caregiver_info" } }).catch(() => {});
        const snap = await db.collection("caregivers").doc(input.caregiverId as string).get();
        if (!snap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        const d = snap.data()!;

        // Reviews — folded in from the former get_caregiver_reviews tool.
        const reviewLimit = Math.min((input.reviewLimit as number) ?? 5, 20);
        const reviewsSnap = await db
          .collection("reviews")
          .where("caregiverId", "==", input.caregiverId as string)
          .orderBy("createdAt", "desc")
          .limit(reviewLimit + 1)
          .get();
        const recentReviews = reviewsSnap.docs.slice(0, reviewLimit).map((rd) => {
          const r = rd.data();
          return { rating: r.rating, comment: r.comment ?? "", createdAt: r.createdAt };
        });
        const averageRating = typeof d.averageRating === "number"
          ? d.averageRating
          : (typeof d.rating === "number" ? d.rating : null);

        return {
          success: true,
          results: {
            name:                      `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim() || d.name,
            rating:                    d.rating,
            ratingCount:               d.ratingCount ?? 0,
            yearsExperience:           d.yearsExperience,
            specialties:               d.specialties ?? [],
            certifications:            d.certifications ?? [],
            backgroundCheckStatus:     d.backgroundCheckData?.status ?? "pending",
            backgroundCheckClearedAt:  d.backgroundCheckData?.clearedAt ?? null,
            isVerified:                d.status === "active",
            bookable:                  d.status === "active",
            hourlyRate:                d.hourlyRate,
            city:                      d.city,
            bio:                       d.bio ?? d.about ?? null,
            averageRating,
            totalReviews:              d.reviewCount ?? recentReviews.length,
            recentReviews,
            hasMoreReviews:            reviewsSnap.docs.length > reviewLimit,
          },
        };
      }

      case "get_billing_summary": {
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:get_billing_summary" } }).catch(() => {});
        const userId = input.userId as string;
        const [subSnap, invoiceSnap, paymentsSnap, userSnap] = await Promise.all([
          // The real subscription doc lives under customers/{uid}/subscriptions
          // (Stripe webhook writer, stripe.ts) — a top-level `subscriptions`
          // collection is never written by anything, so this always returned
          // null. Mirrors the same lookup cancel_subscription/reactivate_subscription
          // already use.
          db.collection("customers").doc(userId).collection("subscriptions").limit(1).get(),
          // Invoices are keyed by clientId (= the client's uid) per the canonical
          // invoicing.ts writer; querying userId returned nothing. Payments keep
          // userId, matching the Stripe writer (R7). Reuses the existing
          // invoices (clientId, createdAt DESC) composite.
          db.collection("invoices")
            .where("clientId", "==", userId)
            .orderBy("createdAt", "desc")
            .limit(3)
            .get(),
          db.collection("payments")
            .where("userId", "==", userId)
            .orderBy("createdAt", "desc")
            .limit(6)
            .get(),
          db.collection("users").doc(userId).get(),
        ]);
        const userDoc = userSnap.data() ?? {};
        return {
          success: true,
          subscription: subSnap.docs[0]?.data() ?? null,
          membershipStatus: (userDoc.membershipStatus ?? userDoc.subscriptionStatus ?? "unknown") as string,
          recentInvoices: invoiceSnap.docs.map((d) => d.data()),
          recentPayments: paymentsSnap.docs.map((d) => {
            const p = d.data();
            return {
              date:    (p.createdAt as any)?.toDate?.()?.toISOString?.() ?? p.createdAt,
              amount:  typeof p.amount === "number" ? `$${(p.amount / 100).toFixed(2)}` : p.amount,
              status:  p.status,
            };
          }),
        };
      }

      case "find_replacement_caregivers": {
        const { phone, chatId, clientId, needs, nearZip, availabilityWindow, radiusMiles } = input;
        if (!phone || !chatId || !clientId) return toolError("INVALID_INPUT", "phone, chatId, and clientId are required");
        logAudit({ eventType: "caregiver_matched", userId: clientId as string, data: { source: "mcp:find_replacement_caregivers" } }).catch(() => {});
        const sessionSnap    = await db.collection("agent_sessions").doc(phone as string).get();
        const session        = sessionSnap.data() ?? {};
        const clientSnap     = await db.collection("users").doc(clientId as string).get();
        const clientProfile  = clientSnap.data() ?? {};
        // Apply optional agent-supplied filters as overrides on the matching
        // intake (the object runMatchingForClient reads zipCode/careNeeds from),
        // so the agent can parameterize the search instead of an opaque zero-arg
        // call. Omitted filters leave the profile defaults untouched.
        //
        // 2026-09-03 fix: this used to spread the raw session doc ({...session}) —
        // but city/zipCode live nested under session.onboardingData, not at the
        // session's own top level (AgentSession has no such fields), so any call
        // without an explicit nearZip silently searched with NO location at all,
        // deterministically returning whatever the fallback ordering happened to
        // surface first (found while tracing why a client kept seeing the same
        // one caregiver on repeat, separate asks). Start from onboardingData
        // (which does have them), then prefer the client's LIVE current
        // location — same helper find_nearby_caregivers uses — since a frozen
        // onboarding-time snapshot can be stale or simply wrong.
        const liveLocation = await import("../agents/onboardingConversation")
          .then((m) => m.loadLiveClientLocation(clientId as string))
          .catch(() => null);
        const matchIntake: Record<string, unknown> = {
          ...(session.onboardingData as Record<string, unknown> ?? {}),
          ...(liveLocation ?? {}),
        };
        // Validate the agent-supplied overrides before applying them: a malformed
        // ZIP or an out-of-range radius must not flow into the matching intake.
        const needsOk  = typeof needs === "string" && !!needs;
        const zipOk    = typeof nearZip === "string" && /^\d{5}(-\d{4})?$/.test(nearZip);
        const availOk  = typeof availabilityWindow === "string" && !!availabilityWindow;
        const radiusOk = typeof radiusMiles === "number" && Number.isFinite(radiusMiles) && radiusMiles > 0 && radiusMiles <= 100;
        if (zipOk)    matchIntake.zipCode            = nearZip;
        if (needsOk)  matchIntake.careNeeds          = needs;
        if (availOk)  matchIntake.availabilityWindow = availabilityWindow;
        if (radiusOk) matchIntake.radiusMiles        = radiusMiles;
        // ONE VOICE: this runs the search synchronously. suppressConversationalSends
        // keeps matching from texting its own status/closer lines — the agent turn
        // that called us is about to speak, and the family must hear one voice, not
        // a canned tool message AND an agent reply back-to-back (double-send bug,
        // founder screenshot 2026-07-06). On a match the tool still delivers the
        // intro + photo gallery (artifacts only it can send); the tool result below
        // tells the agent exactly what the family has already seen and what its one
        // reply should be.
        const matchOutcome = await runMatchingForClient(
          phone as string, chatId as string, matchIntake, clientProfile,
          { suppressConversationalSends: true },
        );
        // Report only the filters that actually passed validation and were
        // applied — not the raw input (a malformed nearZip is reported as null).
        const filtersApplied = {
          needs:              needsOk  ? (needs as string) : null,
          nearZip:            zipOk    ? (nearZip as string) : null,
          availabilityWindow: availOk  ? (availabilityWindow as string) : null,
          radiusMiles:        radiusOk ? (radiusMiles as number) : null,
        };
        if (matchOutcome === "matched") {
          // Names the family was just shown — freshly written to the session by
          // runMatchingForClient. Given to the agent for follow-up context only.
          const freshSess = await db.collection("agent_sessions").doc(phone as string).get();
          const presented = ((freshSess.data()?.pendingMatches ?? []) as Array<{ name?: string; rate?: number }>)
            .map((m) => ({ name: m.name ?? "Caregiver", hourlyRate: m.rate ?? null }));
          return {
            success: true,
            outcome: "matched",
            // sent:true = self-delivering tool (same contract as send_onboarding_link):
            // the intro line + per-caregiver photo gallery already went to this chat.
            sent: true,
            matchesPresented: presented,
            instruction:
              "The family has ALREADY been texted an intro line plus each caregiver's photo, rate, and " +
              "numbered profile link — those messages land BEFORE your reply. Do NOT repeat the names, " +
              "rates, or links, and do NOT say 'I found N caregivers' again. Your entire reply must be " +
              "ONE short closing line asking which caregiver they'd like to meet (reply with a name or number).",
            filtersApplied,
          };
        }
        if (matchOutcome === "no_match") {
          // 2026-09-07: runMatchingForClient distinguishes "genuinely nobody
          // nearby" from "real people exist, they were just already shown
          // before" and writes the latter here when it applies — read it back
          // so the agent tells the truth instead of claiming zero
          // availability when real candidates actually exist.
          const freshSess = await db.collection("agent_sessions").doc(phone as string).get();
          const reofferable = ((freshSess.data()?.reofferableCaregivers ?? []) as Array<{ name?: string; hourlyRate?: number }>)
            .map((m) => ({ name: m.name ?? "Caregiver", hourlyRate: m.hourlyRate ?? null }));
          return {
            success: true,
            outcome: "no_match",
            matchesFound: 0,
            teamAlerted: true,
            reofferableCaregivers: reofferable,
            instruction: reofferable.length > 0
              ? `No NEW caregivers matched, but ${reofferable.map((c) => c.name).join(" and ")} — already sent to ` +
                "this family before — are still the closest real matches nearby. NOTHING has been texted to the " +
                "family — your reply is the only message they get. In ONE short warm message, be honest: say " +
                "these are still the best options near them and ask whether to resend those profiles or keep " +
                "looking for someone new. Do not claim nobody is available — that would be false."
              : "No caregivers matched right now. NOTHING has been texted to the family — your reply is the " +
                "only message they get. In ONE short warm message: be honest that you haven't found the right " +
                "match yet, that you're still actively searching, and that the team has been alerted and will " +
                "personally reach out. Do not invent caregiver names and do not promise a specific timeline.",
            filtersApplied,
          };
        }
        return {
          success: false,
          outcome: "failed",
          followUpTracked: true,
          instruction:
            "The search hit a technical snag; a retry is already scheduled and the care team was alerted. " +
            "NOTHING has been texted to the family — in ONE short message tell them you're pulling up " +
            "matches and will text names as soon as they come through. Stay warm and calm; never sound " +
            "broken or blame technology.",
          filtersApplied,
        };
      }

      case "get_caregiver_booking_rate": {
        // U9b: read-only rate lookup extracted from request_booking. No write.
        const rate = await resolveCaregiverRate(String(input.caregiverId ?? ""));
        if (!rate.ok) return toolError(rate.code, rate.message);
        return { success: true, caregiverId: String(input.caregiverId), caregiverName: rate.caregiverName, hourlyRate: rate.hourlyRate };
      }

      case "quote_booking": {
        // U9b: pure cost estimate — lets Evia show the family the price before
        // request_booking commits. No write; safe to call freely.
        const quote = await buildBookingQuote(input);
        if (!quote.ok) return toolError(quote.code, quote.message);
        return {
          success:       true,
          caregiverId:   quote.caregiverId,
          caregiverName: quote.caregiverName,
          hourlyRate:    quote.hourlyRate,
          durationHours: quote.durationHours,
          dates:         quote.dates,
          lineItems:     quote.lineItems,
          totalEstimate: quote.totalEstimate,
          committed:     false,
          note:          "Estimate only — nothing has been booked. Call request_booking to commit.",
        };
      }

      case "request_booking": {
        return runActionNativeMcpWrite(name, input, async () => {
        const { clientId, caregiverId, startTime, endTime, phone, recipientFirstName, interviewId } = input;
        // Session-injected ownership fields are checked here; the booking shape
        // (caregiverId/dates/times) + caregiver lookup are validated by the shared
        // quote primitive below, so the two paths can never diverge.
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required (auto-injected from session)");
        if (!phone)    return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        // Mirrors the website's own paywall for the same 'booking' action
        // (hooks/useAccessGates.tsx) — was entirely ungated here before.
        const gateError = await checkClientAccessGate(clientId as string, "booking");
        if (gateError) return gateError;

        // Commit via the SAME primitive quote_booking exposes (U9b): the duration,
        // rate, and caregiver name the family approved in the quote and the values
        // we book are computed by one function — no duplicated parse/lookup logic.
        const quote = await buildBookingQuote(input);
        if (!quote.ok) return toolError(quote.code, quote.message);

        const appointments = quote.dates.map((d) => ({
          date:          d,
          startTime:     startTime as string,
          endTime:       endTime as string,
          durationHours: quote.durationHours,
        }));

        // Recipient attribution (2026-07-16): resolve WHO this visit is for so
        // multi-recipient households get correctly-attributed appointments.
        // Only stamped when the household actually has 2+ recipients on file —
        // single-recipient households keep today's shape (absent = the sole
        // recipient, fail-soft everywhere). Ambiguity NEVER blocks the money
        // path: no name in a multi-home defaults to the primary senior + a note
        // the agent can use to confirm.
        let recipientName: string | undefined;
        let recipientKey:  string | undefined;
        let recipientResolved: "named" | "defaulted_primary" | undefined;
        try {
          const { multiRecipientScopingEnabled } = await import("../config/featureFlags");
          if (multiRecipientScopingEnabled()) {
            const { resolveRecipientKey, recipientPlanKey } = await import("../agents/careRecipients");
            const webPlanSnap = await db.collection("carePlans").doc(clientId as string).get();
            const plans = (webPlanSnap.data()?.recipientPlans ?? {}) as Record<string, Record<string, unknown>>;
            const planKeys = Object.keys(plans);
            if (planKeys.length > 1) {
              const res = resolveRecipientKey(planKeys, recipientFirstName ? String(recipientFirstName) : undefined);
              if (res.ok) {
                recipientKey  = res.key;
                recipientName = String(plans[res.key]?.name ?? recipientFirstName ?? "").trim() || undefined;
                recipientResolved = "named";
              } else {
                const userSnap = await db.collection("users").doc(clientId as string).get();
                const primary = String(userSnap.data()?.seniorName ?? "").trim();
                if (primary) {
                  recipientName = primary;
                  recipientKey  = recipientPlanKey(primary.split(" ")[0]);
                  recipientResolved = "defaulted_primary";
                }
              }
            }
          }
        } catch (e) {
          console.warn("[request_booking] recipient attribution failed (booking proceeds unattributed):", e);
        }

        // Job/interview linkage (2026-08-30): when this booking follows a
        // completed interview, resolve jobId/jobTitle/applicationId so the
        // booking_requests doc carries the same linkage handleSendBooking
        // stamps on the website, and the caregiver's application gets marked
        // accepted. Fail-soft throughout — a lookup miss or ownership
        // mismatch just proceeds as an unlinked booking, never blocks it.
        let jobId: string | undefined;
        let jobTitle: string | undefined;
        let applicationId: string | undefined;
        if (interviewId) {
          try {
            const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
            const iv = ivSnap.data();
            if (iv && iv.clientId === clientId && iv.caregiverId === caregiverId) {
              applicationId = iv.applicationId as string | undefined;
              if (applicationId) {
                const appSnap = await db.collection("job_applications").doc(applicationId).get();
                jobId = appSnap.data()?.jobId as string | undefined;
                if (jobId) {
                  const jobSnap = await db.collection("job_posts").doc(jobId).get();
                  jobTitle = jobSnap.data()?.title as string | undefined;
                }
              }
            }
          } catch (e) {
            console.warn("[request_booking] interview/job linkage lookup failed (booking proceeds unlinked):", e);
          }
        }

        // Route through the REAL booking path: createBookingTask writes an
        // `agent_tasks` `booking_confirmation` (which the YES/CONFIRM webhook flow and
        // executeBookings actually consume) and enforces the pending-bgcheck booking
        // guard. The old `booking_tasks` collection was read by nothing.
        const { createBookingTask } = await import("../agents/bookingExecutor");
        const taskId = await createBookingTask({
          clientPhone:   phone as string,
          clientId:      clientId as string,
          caregiverId:   caregiverId as string,
          caregiverName: quote.caregiverName,
          appointments,
          hourlyRate:    quote.hourlyRate,
          ...(recipientName ? { recipientName } : {}),
          ...(recipientKey  ? { recipientKey }  : {}),
          ...(jobId         ? { jobId }         : {}),
          ...(jobTitle      ? { jobTitle }      : {}),
          ...(interviewId   ? { interviewId: interviewId as string } : {}),
          ...(applicationId ? { applicationId } : {}),
        });
        if (!taskId) {
          // createBookingTask returns "" when it blocks the booking (e.g. bgcheck pending)
          // and has already messaged the family. Tell the agent explicitly so it
          // doesn't re-explain the block in its own words — the family must not
          // get two back-to-back messages saying the same thing (ONE VOICE).
          return {
            success: false,
            blocked: true,
            reason: "booking_blocked_pending_background_check",
            sent: true,
            instruction:
              "The family has ALREADY been texted a full explanation (background check still in progress, " +
              "they'll be notified the moment it clears, plus an offer to find another caregiver meanwhile). " +
              "Do NOT repeat or rephrase any of that. Reply with nothing beyond what genuinely adds — at " +
              "most one short line answering whatever else they asked, or nothing new at all.",
          };
        }
        logBookingCreated(clientId as string, caregiverId as string, quote.dates).catch(() => {});
        return {
          success: true, taskId, status: "awaiting_approval", estimatedTotal: quote.totalEstimate,
          ...(recipientResolved === "defaulted_primary" && recipientName
            ? { recipientResolved, recipientName,
                note: `This household has more than one care recipient and no recipientFirstName was given — the visit was attributed to ${recipientName}. If it's for someone else, confirm with the family and rebook with recipientFirstName.` }
            : {}),
        };
        });
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

      case "get_callout_backups": {
        const { clientId, appointmentId } = input;
        if (!clientId || !appointmentId) return toolError("INVALID_INPUT", "appointmentId is required");
        const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
        if (!apptSnap.exists) return toolError("NOT_FOUND", "appointment not found");
        const appt = apptSnap.data() || {};
        if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "This appointment does not belong to this client");
        const options = Array.isArray(appt.backupCaregiverOptions) ? appt.backupCaregiverOptions : [];
        return { success: true, appointmentId, caregivers: options, count: options.length };
      }

      case "select_callout_backup": {
        const { clientId, appointmentId, backupCaregiverId } = input;
        if (!clientId || !appointmentId || !backupCaregiverId) return toolError("INVALID_INPUT", "appointmentId and backupCaregiverId are required");
        const apptRef = db.collection("appointments").doc(appointmentId as string);
        const apptSnap = await apptRef.get();
        if (!apptSnap.exists) return toolError("NOT_FOUND", "appointment not found");
        const appt = apptSnap.data() || {};
        if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "This appointment does not belong to this client");
        const cgSnap = await db.collection("caregivers").doc(backupCaregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "caregiver not found");
        const cg = cgSnap.data() || {};
        const caregiverName = (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "your caregiver";
        await apptRef.update({
          caregiverId:          backupCaregiverId,
          caregiverName,
          status:               "confirmed",
          previousCaregiverId:  appt.caregiverId ?? null,
          caregiverSwitchedAt:  nowIso,
          needsBackup:          false,
          backupCaregiverOptions: admin.firestore.FieldValue.delete(),
        });
        logAudit({ eventType: "callout_backup_selected", userId: clientId as string, data: { source: "mcp:select_callout_backup", appointmentId, backupCaregiverId } }).catch(() => {});
        return { success: true, appointmentId, caregiverId: backupCaregiverId, caregiverName, status: "confirmed" };
      }

      case "request_callout_refund": {
        const { clientId, appointmentId, reason } = input;
        if (!clientId || !appointmentId) return toolError("INVALID_INPUT", "appointmentId is required");
        const apptRef = db.collection("appointments").doc(appointmentId as string);
        const apptSnap = await apptRef.get();
        if (!apptSnap.exists) return toolError("NOT_FOUND", "appointment not found");
        const appt = apptSnap.data() || {};
        if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "This appointment does not belong to this client");
        const refundReason = (reason as string) || "Caregiver called out, no suitable backup available";
        await apptRef.update({ status: "cancelled_refund_requested", refundRequestedAt: nowIso, refundReason, needsBackup: false });
        const refundRef = await db.collection("refundRequests").add({
          appointmentId, clientId, amount: appt.amount ?? 0, reason: refundReason, status: "requested", requestedAt: nowIso, createdAt: nowIso, source: "cara",
        });
        await db.collection("admin_alerts").add({
          type: "refund_request", title: "Refund request — caregiver callout (via Evia)",
          clientId, appointmentId, refundRequestId: refundRef.id, createdAt: nowIso, resolved: false,
        }).catch(() => {});
        logAudit({ eventType: "callout_refund_requested", userId: clientId as string, data: { source: "mcp:request_callout_refund", appointmentId, refundRequestId: refundRef.id } }).catch(() => {});
        return { success: true, refundRequestId: refundRef.id, status: "pending" };
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
        const { clientId, action, bookingRequestId, shiftId, amendmentId } = input;
        if (!clientId || !action) return toolError("INVALID_INPUT", "clientId and action are required");

        if (action === "cancel_pending_request") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for cancel_pending_request");
          const brSnap = await db.collection("booking_requests").doc(bookingRequestId as string).get();
          if (!brSnap.exists) return toolError("NOT_FOUND", "Booking request not found");
          const br = brSnap.data()!;
          if (br.clientId !== clientId) return toolError("PERMISSION_DENIED", "Booking request does not belong to this client");
          if (br.status !== "pending") return toolError("INVALID_INPUT", `Only a pending request can be cancelled this way (status: ${br.status})`);
          await brSnap.ref.update({ status: "cancelled" });
          // Also cancel the underlying negotiation so the caregiver isn't left
          // with a live YES/NO offer for a request the family just withdrew.
          // The booking_requests status write above already fires
          // onBookingRequestWrite (notificationTriggers.ts), which texts the
          // caregiver the same "withdrew" notice — a second manual text here
          // would double-send, so this only cancels the offer doc itself.
          if (br.agentTaskId) {
            await db.collection("agent_tasks").doc(br.agentTaskId as string).update({ status: "cancelled_by_client" }).catch(() => {});
            const offerSnap = await db.collection("shift_offers")
              .where("agentTaskId", "==", br.agentTaskId).where("status", "==", "pending").limit(1).get();
            if (!offerSnap.empty) {
              await offerSnap.docs[0].ref.update({ status: "cancelled" }).catch(() => {});
            }
          }
          logAudit({ eventType: "booking_request_cancelled", userId: clientId as string, data: { source: "mcp:manage_booking", action, bookingRequestId } }).catch(() => {});
          return { success: true, action, bookingRequestId };
        }

        if (action === "cancel_whole_booking") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for cancel_whole_booking");
          const brSnap = await db.collection("booking_requests").doc(bookingRequestId as string).get();
          if (!brSnap.exists) return toolError("NOT_FOUND", "Booking not found");
          const br = brSnap.data()!;
          if (br.clientId !== clientId) return toolError("PERMISSION_DENIED", "Booking does not belong to this client");
          if (br.status === "cancelled") return { success: true, action, alreadyCancelled: true, bookingRequestId };
          const shiftsSnap = await db.collection("shifts")
            .where("bookingRequestId", "==", bookingRequestId).where("status", "==", "scheduled").get();
          const batch = db.batch();
          shiftsSnap.docs.forEach((d) => batch.update(d.ref, { status: "cancelled", bulkCancelled: true }));
          await batch.commit();
          // booking_requests.status → cancelled fires onBookingRequestWrite
          // (notificationTriggers.ts), which texts the caregiver — no manual
          // send here, or the caregiver would get the notice twice.
          await brSnap.ref.update({ status: "cancelled" });
          logAudit({ eventType: "booking_cancelled", userId: clientId as string, data: { source: "mcp:manage_booking", action, bookingRequestId, shiftsCancelled: shiftsSnap.size } }).catch(() => {});
          return { success: true, action, bookingRequestId, shiftsCancelled: shiftsSnap.size };
        }

        if (action === "cancel_visit") {
          if (!shiftId) return toolError("INVALID_INPUT", "shiftId is required for cancel_visit");
          const shiftSnap = await db.collection("shifts").doc(shiftId as string).get();
          if (!shiftSnap.exists) return toolError("NOT_FOUND", "Visit not found");
          const shift = shiftSnap.data()!;
          if (shift.clientId !== clientId) return toolError("PERMISSION_DENIED", "Visit does not belong to this client");
          if (shift.status !== "scheduled") return toolError("INVALID_INPUT", `Only a scheduled visit can be cancelled this way (status: ${shift.status})`);
          // shifts.status → cancelled fires onShiftStatusChanged
          // (notificationTriggers.ts), which texts the caregiver — no manual
          // send here, or the caregiver would get the notice twice.
          await shiftSnap.ref.update({ status: "cancelled", cancelledBy: "client" });
          logAudit({ eventType: "shift_cancelled", userId: clientId as string, data: { source: "mcp:manage_booking", action, shiftId } }).catch(() => {});
          return { success: true, action, shiftId, date: shift.date };
        }

        if (action === "resend_booking") {
          if (!bookingRequestId) return toolError("INVALID_INPUT", "bookingRequestId is required for resend_booking");
          const brSnap = await db.collection("booking_requests").doc(bookingRequestId as string).get();
          if (!brSnap.exists) return toolError("NOT_FOUND", "Booking request not found");
          const br = brSnap.data()!;
          if (br.clientId !== clientId) return toolError("PERMISSION_DENIED", "Booking request does not belong to this client");
          if (!["declined", "cancelled"].includes(br.status as string)) {
            return toolError("INVALID_INPUT", `Only a declined or cancelled request can be resent (status: ${br.status})`);
          }
          await brSnap.ref.update({ status: "pending", isResend: true });
          let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
          if (br.caregiverId) {
            const cgSnap = await db.collection("caregivers").doc(br.caregiverId as string).get();
            const cgPhone = cgSnap.data()?.phone as string | undefined;
            if (cgPhone) {
              const { trySend } = await import("../utils/toolNotify");
              notification = await trySend(cgPhone, "A family would like to send you a booking request again — reply here to accept or decline.", "mcp:manage_booking");
            }
          }
          logAudit({ eventType: "booking_resent", userId: clientId as string, data: { source: "mcp:manage_booking", action, bookingRequestId } }).catch(() => {});
          return { success: true, action, bookingRequestId, notification };
        }

        if (action === "cancel_pending_amendment") {
          if (!amendmentId) return toolError("INVALID_INPUT", "amendmentId is required for cancel_pending_amendment");
          const amSnap = await db.collection("booking_amendments").doc(amendmentId as string).get();
          if (!amSnap.exists) return toolError("NOT_FOUND", "Amendment request not found");
          const am = amSnap.data()!;
          if (am.clientId !== clientId) return toolError("PERMISSION_DENIED", "Amendment does not belong to this client");
          if (am.status !== "pending") return toolError("INVALID_INPUT", `Only a pending amendment can be cancelled (status: ${am.status})`);
          await amSnap.ref.update({ status: "cancelled" });
          logAudit({ eventType: "amendment_cancelled", userId: clientId as string, data: { source: "mcp:manage_booking", action, amendmentId } }).catch(() => {});
          return { success: true, action, amendmentId };
        }

        return toolError("INVALID_INPUT", `Unknown action: ${action}`);
      }

      case "request_schedule_amendment": {
        const { bookingRequestId, clientId, date, startTime, endTime, notes, ongoing } = input;
        if (!bookingRequestId || !clientId || !date || !startTime || !endTime) {
          return toolError("INVALID_INPUT", "bookingRequestId, clientId, date, startTime, and endTime are required");
        }
        const brSnap = await db.collection("booking_requests").doc(bookingRequestId as string).get();
        if (!brSnap.exists) return toolError("NOT_FOUND", "Booking not found");
        const br = brSnap.data()!;
        if (br.clientId !== clientId) return toolError("PERMISSION_DENIED", "Booking does not belong to this client");
        // Matches the site's own shape exactly (Schedule.tsx's "+Request Visit"
        // modal) — scoped to a single date/day for a one-off time change
        // (ongoing:false, startDate===endDate), or a real recurring day when
        // ongoing:true.
        const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${date}T12:00:00`).getDay()];
        const amRef = db.collection("booking_amendments").doc();
        await amRef.set({
          bookingRequestId,
          clientId,
          clientName: br.clientName ?? "",
          caregiverId: br.caregiverId,
          caregiverName: br.caregiverName ?? "",
          status: "pending",
          type: "add_recurring_days",
          newDays: { [dayName]: [{ start: startTime, end: endTime }] },
          notes: notes ?? "",
          startDate: date,
          endDate: ongoing ? null : date,
          ongoing: Boolean(ongoing),
          createdAt: nowIso,
        });
        // onBookingAmendmentWrite (notificationTriggers.ts) is the single
        // source of truth for texting the caregiver about this — it fires on
        // the .set() above regardless of caller, so no manual send here.
        logAudit({ eventType: "amendment_requested", userId: clientId as string, data: { source: "mcp:request_schedule_amendment", amendmentId: amRef.id } }).catch(() => {});
        return { success: true, amendmentId: amRef.id };
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
          notes:           (am.notes as string) || "",
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

      case "send_caregiver_message": {
        const { caregiverId, message, clientId } = input;
        if (!caregiverId || !message) return toolError("INVALID_INPUT", "caregiverId and message are required");
        const gateError = await checkClientAccessGate(clientId as string | undefined, "message");
        if (gateError) return gateError;
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        // Mirrors BrowseCaregivers.tsx: a hidden profile is never surfaced to
        // browse/message on the website, so Evia shouldn't relay to one either.
        if (cgSnap.data()?.profileVisibility === "hidden") {
          return toolError("NOT_FOUND", "Caregiver not found");
        }
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (!cgPhone) return toolError("NOT_FOUND", "Caregiver phone not on file");
        const caregiverName = (cgSnap.data()?.name as string | undefined) ?? "";
        const { trySend } = await import("../utils/toolNotify");
        const notification = await trySend(cgPhone, `Message from family: ${message as string}`, "mcp:send_caregiver_message");
        // Also land the message in the same persisted chatRooms thread the
        // website's Inbox reads from (FindCaregivers.tsx's openChat) — the SMS
        // alone left no visible, two-way thread for the family to see replies
        // in. Fail-soft: a thread-write hiccup must never block the SMS relay,
        // which is the guaranteed-delivery path. Requires clientId, which is
        // optional on this tool's input — skip silently if it's absent.
        if (clientId) {
          try {
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
          } catch (err) {
            console.error("send_caregiver_message: chatRooms thread write failed (SMS still sent):", err);
          }
        }
        logAudit({ eventType: "health_data_accessed", userId: clientId as string ?? "", data: { source: "mcp:send_caregiver_message", caregiverId, notificationSent: notification.sent } }).catch(() => {});
        return { success: true, sent: notification.sent, caregiverName, notification };
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

      case "get_recurring_schedule": {
        if (!input.clientId) return toolError("INVALID_INPUT", "clientId is required");
        const snap = await db.collection("recurring_schedules")
          .where("clientId", "==", input.clientId)
          .where("status",   "==", "active")
          .limit(1)
          .get();
        if (snap.empty) return { success: true, schedule: null, message: "No active recurring schedule found" };
        return { success: true, schedule: snap.docs[0].data() };
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
        if (!input.clientId) return toolError("INVALID_INPUT", "clientId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.clientId as string, data: { source: "mcp:get_pending_tasks" } }).catch(() => {});
        // Note: an earlier version also queried `interviews` for status
        // "awaiting_hire_decision" — that status is written nowhere (the
        // awaiting-decision state lives in agent_sessions.pendingInterviewOutcome),
        // so the branch always returned empty and was removed.
        const taskSnap = await db.collection("agent_tasks")
          .where("clientId", "==", input.clientId)
          .where("status",   "in", ["awaiting_approval", "pending"])
          .limit(5)
          .get();
        // Oldest first with age surfaced — a 3-day-old approval should lead
        // the reply, not sit wherever Firestore returned it.
        const withAge = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
          const data = d.data();
          const createdMs = typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
          const ageHours = Number.isFinite(createdMs)
            ? Math.max(0, Math.floor((Date.now() - createdMs) / 3_600_000))
            : null;
          return { id: d.id, ...data, ageHours };
        };
        const byOldest = (a: { ageHours: number | null }, b: { ageHours: number | null }) =>
          (b.ageHours ?? -1) - (a.ageHours ?? -1);
        const tasks = taskSnap.docs.map(withAge).sort(byOldest);
        const total = tasks.length;
        return {
          success: true,
          total,
          tasks,
          interviews: [], // kept for response-shape compatibility (see note above)
          summary: total === 0 ? "Nothing pending" : `${total} item(s) need your attention`,
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
      // carePlans (camelCase) is the real, website-facing collection for
      // careNeeds/notes/lifestyle/locations (components/CarePlan.tsx's
      // recipientPlans). Emergency contacts are the one exception (2026-08-31
      // audit): the website's Care Plan page actually reads/edits its
      // Emergency Contacts card from the OLDER care_plans (snake_case) doc via
      // dbService.subscribeToCarePlan/updateCarePlan (services/api.ts) — its
      // camelCase `carePlans.emergencyContacts` copy (written by the page as a
      // secondary, redundant write) is never read by anything. Overlay it here
      // so Evia sees the same contacts the family actually sees.
      const [snap, legacySnap] = await Promise.all([
        db.collection("carePlans").doc(clientId).get(),
        db.collection("care_plans").doc(clientId).get(),
      ]);
      if (!snap.exists && !legacySnap.exists) return { success: true, carePlan: null, message: "No care plan on file yet." };
      const carePlan = { ...(snap.data() ?? {}) };
      if (legacySnap.exists && Array.isArray(legacySnap.data()?.emergencyContacts)) {
        carePlan.emergencyContacts = legacySnap.data()!.emergencyContacts;
      }
      return { success: true, carePlan };
    }

    if (name === "update_care_plan") {
      const { clientId, field, value, action, recipientFirstName } = input as {
        clientId: string; field: string; value: unknown; action: "set" | "append" | "remove";
        recipientFirstName?: string;
      };
      // Household-level only — this is a non-medical marketplace, so medical
      // fields (medications, diagnoses, dietary/routine detail, doctor
      // contacts) were removed (2026-08-22) along with the post-payment
      // care-plan interview that used to solicit them; the website never had
      // an equivalent feature for any of it.
      const ALLOWED_FIELDS = ["careNeeds", "notes", "lifestyle", "careLocation", "emergencyContacts", "accessCodes"];
      if (!ALLOWED_FIELDS.includes(field)) {
        return { success: false, error: `Field '${field}' is not updatable. Allowed: ${ALLOWED_FIELDS.join(", ")}` };
      }
      const nowIso = new Date().toISOString();

      // emergencyContacts lives on the OLDER care_plans (snake_case) doc — see
      // get_care_plan above. Everything else is on carePlans (camelCase).
      if (field === "emergencyContacts") {
        const legacyRef = db.collection("care_plans").doc(clientId);
        if (action === "append") {
          await legacyRef.set({ emergencyContacts: admin.firestore.FieldValue.arrayUnion(value), lastUpdatedBy: "cara", updatedAt: nowIso }, { merge: true });
        } else if (action === "remove") {
          await legacyRef.set({ emergencyContacts: admin.firestore.FieldValue.arrayRemove(value), lastUpdatedBy: "cara", updatedAt: nowIso }, { merge: true });
        } else {
          await legacyRef.set({ emergencyContacts: value, lastUpdatedBy: "cara", updatedAt: nowIso }, { merge: true });
        }
        return { success: true, updated: field, action };
      }

      // carePlans (camelCase) for everything else.
      const ref = db.collection("carePlans").doc(clientId);

      if (field === "accessCodes") {
        if (action === "append") {
          await ref.set({ accessCodes: admin.firestore.FieldValue.arrayUnion(value) }, { merge: true });
        } else if (action === "remove") {
          await ref.set({ accessCodes: admin.firestore.FieldValue.arrayRemove(value) }, { merge: true });
        } else {
          await ref.set({ accessCodes: value, updatedAt: nowIso }, { merge: true });
        }
        return { success: true, updated: field, action };
      }

      // careNeeds/notes/lifestyle/careLocation are all per-care-recipient on
      // the real doc (recipientPlans.{key}.*, CarePlan.tsx's getKey) — resolve
      // which recipient this update is about.
      const { resolveRecipientKey } = await import("../agents/careRecipients");
      const snap = await ref.get();
      const planKeys = Object.keys((snap.data()?.recipientPlans ?? {}) as Record<string, unknown>);
      const res = resolveRecipientKey(planKeys, recipientFirstName);
      if (!res.ok) {
        return {
          success: false,
          error: res.reason === "ambiguous"
            ? "This household has more than one care recipient — say which one (recipientFirstName) before I update this."
            : "I don't have a care recipient on file yet to attach this to.",
        };
      }

      if (field === "lifestyle") {
        // Shallow-merge the given keys into the existing lifestyle object first
        // (so a partial value like {prefersQuiet:true} doesn't wipe out
        // favoriteActivities etc.), then write it via the SAME dotted-path
        // convention careNeeds/notes already use below — targets only
        // recipientPlans.{key}.lifestyle, leaving careNeeds/notes/locations
        // for this same recipient untouched.
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return toolError("INVALID_INPUT", "lifestyle requires an object of the fields to change");
        }
        const existingLifestyle = ((snap.data()?.recipientPlans as Record<string, any> | undefined)?.[res.key]?.lifestyle ?? {}) as Record<string, unknown>;
        const merged = { ...existingLifestyle, ...(value as Record<string, unknown>) };
        await ref.set({ [`recipientPlans.${res.key}.lifestyle`]: merged }, { merge: true });
        return { success: true, updated: field, action: "set" };
      }

      if (field === "careLocation") {
        const loc = value as { street?: string; city?: string; state?: string; zipCode?: string } | undefined;
        if (!loc?.street || !loc?.zipCode) {
          return toolError("INVALID_INPUT", "careLocation requires at least street and zipCode");
        }
        const { lookupZipPlace } = await import("../utils/geocode");
        const place = await lookupZipPlace(loc.zipCode).catch(() => null);
        const locationEntry = {
          street: loc.street,
          city:   loc.city ?? place?.city ?? "",
          state:  loc.state ?? place?.state ?? "",
          zipCode: loc.zipCode,
          ...(place ? { lat: place.lat, lng: place.lng } : {}),
        };
        // Matches the site's own shape: the recipient's own locations array
        // (replaced — Evia collects one address at a time, unlike the site's
        // multi-address picker) plus the shared locationPool the site also
        // maintains, deduped by street+zip.
        const existingPool = (snap.data()?.locationPool as Array<{ street?: string; zipCode?: string }> | undefined) ?? [];
        const alreadyInPool = existingPool.some(l => l.street?.toLowerCase() === locationEntry.street.toLowerCase() && l.zipCode === locationEntry.zipCode);
        await ref.set({
          [`recipientPlans.${res.key}.locations`]: [locationEntry],
          ...(alreadyInPool ? {} : { locationPool: admin.firestore.FieldValue.arrayUnion(locationEntry) }),
        }, { merge: true });
        return { success: true, updated: field, action: "set" };
      }

      // careNeeds / notes
      const fieldPath = `recipientPlans.${res.key}.${field}`;
      if (action === "append") {
        await ref.set({ [fieldPath]: admin.firestore.FieldValue.arrayUnion(value) }, { merge: true });
      } else if (action === "remove") {
        await ref.set({ [fieldPath]: admin.firestore.FieldValue.arrayRemove(value) }, { merge: true });
      } else {
        await ref.set({ [fieldPath]: value, updatedAt: nowIso }, { merge: true });
      }
      return { success: true, updated: field, action };
    }

    // ── New write tools ────────────────────────────────────────────────────────

    if (name === "update_caregiver_profile") {
      const { caregiverId, hourlyRate, bio, phone: actingPhone, requestPhoneChange, city, weeklyAvailability } = input as Record<string, unknown>;
      if (!caregiverId || !actingPhone) return toolError("INVALID_INPUT", "caregiverId and phone are required");
      const caregiverRef = db.collection("caregivers").doc(caregiverId as string);
      const caregiverSnap = await caregiverRef.get();
      if (!caregiverSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const ownerPhone = caregiverSnap.data()?.phone;
      if (!ownerPhone || ownerPhone !== actingPhone) {
        return toolError("PERMISSION_DENIED", "You can only update your own caregiver profile");
      }
      if (requestPhoneChange === true) {
        const d = caregiverSnap.data() ?? {};
        const email = (d.email as string | undefined)?.trim();
        if (!email) {
          return {
            success: false,
            noEmailOnFile: true,
            guidance: "This account has no email on file, so there's no way to send a verification link. Ask them to set a recovery email first, then try again.",
          };
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
      const ownerPhone = snap.data()?.phone;
      // Ownership: the acting phone must own this caregiver doc. Fail CLOSED unless
      // BOTH phones exist and match — a missing/empty ownerPhone must not bypass the
      // check, and we do NOT trust a model-supplied caregiverId alone.
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
      const ownerPhone = snap.data()?.phone;
      // Fail CLOSED unless BOTH phones exist and match (see pause_account above).
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

    if (name === "submit_review") {
      const { caregiverId, appointmentId, clientId, rating, comment } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !clientId || rating == null) return toolError("INVALID_INPUT", "caregiverId, appointmentId, clientId, and rating are required");
      const ratingNum = Number(rating);
      if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) return toolError("INVALID_INPUT", "rating must be an integer from 1 to 5");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
      if (appt.hasReview === true) return toolError("INVALID_INPUT", "This appointment has already been reviewed");
      const dupSnap = await db.collection("reviews").where("appointmentId", "==", appointmentId).limit(1).get();
      if (!dupSnap.empty) return toolError("INVALID_INPUT", "A review for this appointment already exists");
      const reviewRef = await db.collection("reviews").add({ caregiverId, clientId, appointmentId, rating: ratingNum, comment: comment ?? "", source: "cara_sms", createdAt: nowIso });
      await apptSnap.ref.update({ hasReview: true, reviewId: reviewRef.id });
      const { onFeedbackSubmitted } = await import("../agents/feedbackAggregator");
      onFeedbackSubmitted(caregiverId as string, ratingNum, appointmentId as string, clientId as string).catch(err => console.error("submit_review aggregation error:", err));
      logAudit({ eventType: "review_submitted", userId: clientId as string, data: { source: "mcp:submit_review", caregiverId, appointmentId, rating: ratingNum } }).catch(() => {});
      return { success: true, reviewId: reviewRef.id, rating: ratingNum };
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

    if (name === "manage_recurring_schedule") {
      const { scheduleId, clientId, action, pauseReason } = input as Record<string, unknown>;
      if (!scheduleId || !clientId || !action) return toolError("INVALID_INPUT", "scheduleId, clientId, and action are required");
      const schedSnap = await db.collection("recurring_schedules").doc(scheduleId as string).get();
      if (!schedSnap.exists) return toolError("NOT_FOUND", "Recurring schedule not found");
      const sched = schedSnap.data()!;
      if (sched.clientId !== clientId) return toolError("PERMISSION_DENIED", "This schedule does not belong to this client");
      const today = nowIso.slice(0, 10);
      if (action === "pause") {
        if (sched.status === "paused")    return toolError("INVALID_INPUT", "Schedule is already paused");
        if (sched.status === "cancelled") return toolError("INVALID_INPUT", "Cannot pause a cancelled schedule");
        await schedSnap.ref.update({ status: "paused", pausedAt: nowIso, pausedReason: pauseReason ?? "client_request" });
        logAudit({ eventType: "recurring_schedule_updated", userId: clientId as string, data: { action: "pause", scheduleId } }).catch(() => {});
        return { success: true, action: "paused", scheduleId };
      }
      if (action === "resume") {
        if (sched.status !== "paused") return toolError("INVALID_INPUT", "Schedule is not currently paused");
        await schedSnap.ref.update({ status: "active", pausedAt: admin.firestore.FieldValue.delete(), pausedReason: admin.firestore.FieldValue.delete() });
        logAudit({ eventType: "recurring_schedule_updated", userId: clientId as string, data: { action: "resume", scheduleId } }).catch(() => {});
        return { success: true, action: "resumed", scheduleId };
      }
      if (action === "cancel") {
        if (sched.status === "cancelled") return toolError("INVALID_INPUT", "Schedule is already cancelled");
        // orderBy(date desc) shares the Q5 composite (recurringScheduleId,
        // status, date DESC) with modifyScheduleFlow/recurringScheduler; the
        // date> inequality already excludes missing dates and every match is
        // cancelled, so ordering does not change the batch.
        const futureSnap = await db.collection("appointments").where("recurringScheduleId", "==", scheduleId).where("date", ">", today).where("status", "in", ["confirmed"]).orderBy("date", "desc").get();
        const batch = db.batch();
        batch.update(schedSnap.ref, { status: "cancelled", cancelledAt: nowIso });
        for (const doc of futureSnap.docs) batch.update(doc.ref, { status: "cancelled_by_client", cancelledAt: nowIso });
        await batch.commit();
        logAudit({ eventType: "recurring_schedule_updated", userId: clientId as string, data: { action: "cancel", scheduleId, futureVisitsRemoved: futureSnap.size } }).catch(() => {});
        return { success: true, action: "cancelled", futureVisitsRemoved: futureSnap.size };
      }
      return toolError("INVALID_INPUT", `Unknown action '${action}'. Must be pause, resume, or cancel`);
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
      // clientId is injected session-authoritatively (qaAgent enrichment overrides
      // any model-supplied value), so ownership is bound to the caller (KTD-10).
      const { clientId, name: seniorName, relationship, age, needs, conditions, location } = input as Record<string, unknown>;
      if (!clientId || !seniorName) return toolError("INVALID_INPUT", "clientId and name are required");
      // New household seniors are NOT keyed by the client uid (that doc is the
      // primary senior); they get a random id stamped with userId == clientId so
      // the amended senior_profiles rule lets the owning family read them (KTD-10).
      const ref = await db.collection("senior_profiles").add({
        userId:       clientId,
        // clientId field REQUIRED for household reads — list_household_seniors
        // queries where("clientId","==",...) and the onboarding writes set it;
        // without it a tool-created senior is invisible to the household list.
        clientId:     clientId,
        name:         seniorName,
        relationship: relationship ?? null,
        age:          age ?? null,
        needs:        Array.isArray(needs) ? needs : [],
        conditions:   Array.isArray(conditions) ? conditions : [],
        // Onboarding-write shape parity: finalization stores conditions under
        // `diagnoses` — mirror it so readers of either field see the same data.
        diagnoses:    Array.isArray(conditions) ? conditions : [],
        location:     location ?? null,
        createdAt:    nowIso,
        source:       "cara_sms",
      });
      // Website-roster parity (2026-08-31 audit): senior_profiles is Evia's own
      // household model (family group, permissions, care team), but the Care
      // Plan/Booking pages' actual recipient roster is a COMPLETELY SEPARATE
      // model — job_postings/{clientId}.careRecipientFirstName + .additionalRecipients[]
      // — that this tool never touched, so a recipient added via Evia never
      // showed up as a tab on the site at all. Mirror into that model too,
      // exactly matching CarePlan.tsx's saveNewRecipient().
      const [firstName, ...lastParts] = String(seniorName).trim().split(/\s+/);
      const lastName = lastParts.join(" ");
      let jobPostingWriteFailed = false;
      try {
        const { recipientPlanKey } = await import("../agents/careRecipients");
        const jobRef = db.collection("job_postings").doc(clientId as string);
        const jobSnap = await jobRef.get();
        const jobData = jobSnap.data() ?? {};
        const isFirstRecipient = !jobData.careRecipientFirstName;
        if (isFirstRecipient) {
          await jobRef.set({
            careRecipientFirstName: firstName,
            careRecipientLastName:  lastName || "",
            relationship:           relationship ?? "",
            careRecipientAge:       age ?? null,
          }, { merge: true });
        } else {
          await jobRef.set({
            additionalRecipients: admin.firestore.FieldValue.arrayUnion({
              firstName, lastName: lastName || "", relationship: relationship ?? "", age: age ?? null,
            }),
          }, { merge: true });
        }
        const key = recipientPlanKey(firstName, lastName);
        await db.collection("carePlans").doc(clientId as string).set({
          recipientPlans: { [key]: { careNeeds: [], careNeedDetails: {}, notes: "", locations: [] } },
        }, { merge: true }).catch(async (err) => {
          if ((err as { code?: number })?.code === 5 /* NOT_FOUND */) {
            await db.collection("carePlans").doc(clientId as string).set({ recipientPlans: { [key]: { careNeeds: [], careNeedDetails: {}, notes: "", locations: [] } } });
          } else {
            throw err;
          }
        });
      } catch (err) {
        // Fail soft — the senior_profiles doc (this tool's original purpose)
        // is already created; don't lose that over a roster-mirror hiccup.
        jobPostingWriteFailed = true;
        console.error("[create_senior_profile] job_postings/carePlans mirror failed:", err);
      }
      logAudit({ eventType: "senior_profile_created", userId: clientId as string, data: { source: "mcp:create_senior_profile", seniorProfileId: ref.id, jobPostingWriteFailed } }).catch(() => {});
      return { success: true, seniorProfileId: ref.id, message: `Added ${seniorName} to the household.` };
    }

    if (name === "remove_care_recipient") {
      const { clientId, recipientFirstName } = input as Record<string, unknown>;
      if (!clientId || !recipientFirstName) return toolError("INVALID_INPUT", "clientId and recipientFirstName are required");
      const jobRef = db.collection("job_postings").doc(clientId as string);
      const jobSnap = await jobRef.get();
      if (!jobSnap.exists || !jobSnap.data()?.careRecipientFirstName) {
        return toolError("NOT_FOUND", "No care recipients on file for this household.");
      }
      const jobData = jobSnap.data()!;
      const additional = (jobData.additionalRecipients as Array<Record<string, unknown>> | undefined) ?? [];
      interface RosterEntry { firstName: unknown; lastName: unknown; relationship: unknown; age: unknown; isPrimary: boolean }
      const roster: RosterEntry[] = [
        { firstName: jobData.careRecipientFirstName as string, lastName: (jobData.careRecipientLastName as string) ?? "", relationship: jobData.relationship, age: jobData.careRecipientAge, isPrimary: true },
        ...additional.map((r) => ({ ...r, isPrimary: false }) as RosterEntry),
      ];
      const wanted = String(recipientFirstName).trim().toLowerCase();
      const matches = roster.filter((r) => String(r.firstName ?? "").trim().toLowerCase() === wanted);
      if (matches.length === 0) return toolError("NOT_FOUND", `No care recipient named "${recipientFirstName}" on file.`);
      if (matches.length > 1) return toolError("INVALID_INPUT", `More than one care recipient named "${recipientFirstName}" — this needs to be done on the website.`);
      if (roster.length === 1) return toolError("INVALID_INPUT", "Can't remove the only care recipient on the household.");
      const target = matches[0];
      const archived = { firstName: target.firstName, lastName: target.lastName, relationship: target.relationship, age: target.age, deletedAt: new Date().toISOString() };

      if (target.isPrimary) {
        const [newPrimary, ...remaining] = additional;
        if (newPrimary) {
          await jobRef.update({
            careRecipientFirstName: newPrimary.firstName,
            careRecipientLastName:  newPrimary.lastName ?? "",
            relationship:           newPrimary.relationship ?? "",
            careRecipientAge:       newPrimary.age ?? null,
            additionalRecipients:   remaining,
            deletedRecipients:      admin.firestore.FieldValue.arrayUnion(archived),
          });
        } else {
          await jobRef.update({
            careRecipientFirstName: admin.firestore.FieldValue.delete(),
            careRecipientLastName:  admin.firestore.FieldValue.delete(),
            relationship:           admin.firestore.FieldValue.delete(),
            careRecipientAge:       admin.firestore.FieldValue.delete(),
            deletedRecipients:      admin.firestore.FieldValue.arrayUnion(archived),
          });
        }
      } else {
        const remaining = additional.filter((r) => String(r.firstName ?? "").trim().toLowerCase() !== wanted);
        await jobRef.update({
          additionalRecipients: remaining,
          deletedRecipients:    admin.firestore.FieldValue.arrayUnion(archived),
        });
      }
      // Note: recipientPlans.{key} on carePlans is intentionally left in place,
      // matching the website's own deleteRecipient() — it orphans the plan data
      // rather than deleting it (site behavior, not an Evia shortcut).
      logAudit({ eventType: "senior_profile_archived", userId: clientId as string, data: { source: "mcp:remove_care_recipient", recipientFirstName } }).catch(() => {});
      return { success: true, removed: target.firstName };
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

    if (name === "delete_care_journal_entry") {
      const { clientId, entryId } = input as Record<string, unknown>;
      if (!clientId || !entryId) return toolError("INVALID_INPUT", "clientId and entryId are required");
      const eSnap = await db.collection("care_journal").doc(entryId as string).get();
      if (!eSnap.exists) return toolError("NOT_FOUND", "Journal entry not found");
      const entry = eSnap.data()!;
      if (entry.clientId !== clientId) return toolError("PERMISSION_DENIED", "Entry does not belong to this client");
      // Soft-delete: care_journal is an append-only audit record (firestore.rules
      // marks it never-client-deletable), so hide from the family view rather
      // than hard-delete — preserves the audit trail (Success Criterion #2).
      await eSnap.ref.update({ status: "hidden", hiddenAt: nowIso });
      logAudit({ eventType: "care_journal_hidden", userId: clientId as string, data: { source: "mcp:delete_care_journal_entry", entryId } }).catch(() => {});
      return { success: true, entryId, softDeleted: true };
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
        clientId, careTypes, frequency, days, timeOfDay, hourlyRate, streetAddress, zipCode, startDate, endDate,
        careLevel, minHoursPerWeek, screeningQuestions, careRecipients,
      } = input as Record<string, unknown>;
      if (!clientId || !Array.isArray(careTypes) || careTypes.length === 0 || hourlyRate == null || !zipCode) {
        return toolError("INVALID_INPUT", "clientId, careTypes (non-empty), hourlyRate, and zipCode are required");
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
        title:         place?.city ? `Care needed in ${place.city}` : "Care needed",
        careTypes:     careTypes as string[],
        startDate:     (startDate ?? undefined) as string | undefined,
        endDate:       (endDate ?? undefined) as string | undefined,
        frequency:     (frequency ?? undefined) as string | undefined,
        days:          daysArr,
        timeOfDay:     todArr,
        hourlyRate:    hourlyRate as number | string,
        zipCode:       zipCode as string,
        city:          place?.city,
        state:         place?.state,
        lat:           place?.lat,
        lng:           place?.lng,
        careLevel:     (careLevel ?? undefined) as string | undefined,
        minHoursPerWeek: typeof minHoursPerWeek === "number" ? minHoursPerWeek : undefined,
        screeningQuestions: Array.isArray(screeningQuestions) ? (screeningQuestions as string[]) : undefined,
        recipientsCount: Array.isArray(careRecipients) ? Math.min(4, Math.max(1, careRecipients.length)) : undefined,
        intakeId:      ref.id,
      }));
      // Matches PostJobFlow.tsx's own post-submit mirror exactly (job_postings
      // roster + carePlans.recipientPlans/locationPool) — only runs when the
      // family named a care recipient not already on file.
      if (Array.isArray(careRecipients) && careRecipients.length > 0) {
        await mirrorJobPostRecipientsToWeb({
          uid:            clientId as string,
          careRecipients: careRecipients as { firstName: string; lastName?: string; relationship?: string }[],
          careTypes:      careTypes as string[],
          streetAddress:  (streetAddress ?? undefined) as string | undefined,
          city:           place?.city,
          state:          place?.state,
          zipCode:        zipCode as string,
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
      const { applicationId, clientId, decision, message: decMsg, preferredDate, preferredTime, interviewType } = input as Record<string, unknown>;
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
        const gateError = await checkClientAccessGate(clientId as string, "interview");
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
        });
      }

      await appSnap2.ref.update({ status: "rejected", decidedAt: nowIso, decisionMessage: decMsg ?? "" });
      const cgSessSnap = await db.collection("agent_sessions").where("userId", "==", app.caregiverId).limit(1).get();
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_session" };
      if (!cgSessSnap.empty) {
        const { trySend } = await import("../utils/toolNotify");
        notification = await trySend(cgSessSnap.docs[0].id, "Thanks for applying — the family went with another caregiver this time. Keep an eye out for new jobs!", "mcp:respond_to_job_application");
      }
      logAudit({ eventType: "job_application_responded", userId: clientId as string, data: { source: "mcp:respond_to_job_application", applicationId, decision, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, decision, applicationId, notification };
    }

    if (name === "submit_interview_feedback") {
      const { interviewId, clientId, fitLevel, notes: fbNotes } = input as Record<string, unknown>;
      if (!interviewId || !clientId || !fitLevel) return toolError("INVALID_INPUT", "interviewId, clientId, and fitLevel are required");
      const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      if (iv.clientId !== clientId) return toolError("PERMISSION_DENIED", "Interview does not belong to this client");
      if (iv.feedbackSubmitted === true) return toolError("INVALID_INPUT", "Feedback already submitted for this interview");
      const ivUpdate: Record<string, unknown> = { fitLevel, clientNotes: fbNotes ?? "", feedbackSubmitted: true, feedbackAt: nowIso };
      // Matches the website's "Mark as Completed" — done automatically here
      // since giving a fit decision IS confirming the interview happened, in
      // one conversational turn instead of two separate button clicks.
      if (iv.status !== "completed") { ivUpdate.status = "completed"; ivUpdate.completedAt = nowIso; }
      let hireRequestCreated = false;
      if (fitLevel === "strong") {
        await db.collection("hire_requests").add({ clientId, caregiverId: iv.caregiverId, interviewId, status: "pending", createdAt: nowIso });
        await db.collection("hire_decisions").add({ clientId, clientName: iv.clientName ?? "", caregiverId: iv.caregiverId, caregiverName: iv.caregiverName ?? "", decision: "hire", createdAt: nowIso }).catch(() => {});
        hireRequestCreated = true;
        const cgSessSnap2 = await db.collection("agent_sessions").where("userId", "==", iv.caregiverId).limit(1).get();
        if (!cgSessSnap2.empty) {
          const { sendToPhone } = await import("../linq/client");
          await sendToPhone(cgSessSnap2.docs[0].id, "Great news — the family would like to move forward with you! They'll reach out soon to finalize the schedule.").catch(() => {});
        }
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
      return { success: true, fitLevel, hireRequestCreated };
    }

    if (name === "complete_interview") {
      const { interviewId, clientId } = input as Record<string, unknown>;
      if (!interviewId || !clientId) return toolError("INVALID_INPUT", "interviewId and clientId are required");
      const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      if (iv.clientId !== clientId) return toolError("PERMISSION_DENIED", "Interview does not belong to this client");
      if (iv.status === "completed") return { success: true, alreadyCompleted: true, interviewId };
      if (!["accepted", "confirmed"].includes(iv.status as string)) {
        return toolError("INVALID_INPUT", `Cannot complete an interview that hasn't been confirmed yet (status: ${iv.status})`);
      }
      await ivSnap.ref.update({ status: "completed", completedAt: nowIso });
      logAudit({ eventType: "interview_completed", userId: clientId as string, data: { source: "mcp:complete_interview", interviewId } }).catch(() => {});
      return { success: true, interviewId };
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
          fee: 0,
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
      const { clientId, appointmentId, action, proposedStartTime, proposedEndTime, proposalReason } = input as Record<string, unknown>;
      if (!clientId || !appointmentId || !action) return toolError("INVALID_INPUT", "clientId, appointmentId, and action are required");
      if (!["approve", "propose_correction", "accept_counter", "escalate"].includes(action as string)) {
        return toolError("INVALID_INPUT", "action must be approve, propose_correction, accept_counter, or escalate");
      }
      const shiftSnap = await db.collection("shiftHours").doc(appointmentId as string).get();
      if (!shiftSnap.exists) return toolError("NOT_FOUND", "Shift hours submission not found");
      const shift = shiftSnap.data()!;
      if (shift.clientId !== clientId) return toolError("PERMISSION_DENIED", "Shift hours do not belong to this client");
      // Mirrors reviewShiftHours' exact per-action status gate (functions/src/shiftHours.ts).
      if ((action === "approve" || action === "propose_correction") && shift.status !== "pending_client_review") {
        return toolError("INVALID_INPUT", `Shift hours already reviewed (status: ${shift.status})`);
      }
      if ((action === "accept_counter" || action === "escalate") && shift.status !== "caregiver_counter_proposed") {
        return toolError("INVALID_INPUT", `No counter-proposal to respond to (status: ${shift.status})`);
      }

      try {
        if (action === "approve") {
          const startTime = String(shift.submittedStartTime ?? "");
          const endTime = String(shift.submittedEndTime ?? "");
          const billable = resolveShiftBillableAmount({
            startTime, endTime,
            bookedRateDollars: Number(shift.payRate),
            lineItems: shift.lineItems,
          });
          await shiftSnap.ref.update({
            status: "approved",
            finalStartTime: startTime,
            finalEndTime: endTime,
            finalTotalHours: billable.totalHours,
            lineItems: billable.lineItems,
            lineItemsTotal: billable.lineItemsTotal,
            basePay: billable.basePay,
            grossPay: billable.grossPay,
            amountCents: billable.grossPayCents,
            requiresExplicitApproval: billable.requiresExplicitApproval,
            resolvedAt: nowIso,
            resolvedBy: "client",
            updatedAt: nowIso,
            correctionHistory: admin.firestore.FieldValue.arrayUnion({
              by: "client", action: "accepted", at: nowIso,
              startTime, endTime, hours: billable.totalHours,
              lineItems: billable.lineItems, lineItemsTotal: billable.lineItemsTotal,
              basePay: billable.basePay, grossPay: billable.grossPay,
            }),
          });
        } else if (action === "propose_correction") {
          if (!proposedStartTime || !proposedEndTime) {
            return toolError("INVALID_INPUT", "proposedStartTime and proposedEndTime are both required to propose a correction");
          }
          const billable = resolveShiftBillableAmount({
            startTime: String(proposedStartTime), endTime: String(proposedEndTime),
            bookedRateDollars: Number(shift.payRate),
            lineItems: shift.lineItems,
          });
          const correctionRespondByAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          await shiftSnap.ref.update({
            status: "correction_proposed",
            proposedStartTime: String(proposedStartTime),
            proposedEndTime: String(proposedEndTime),
            proposedTotalHours: billable.totalHours,
            proposedLineItems: billable.lineItems,
            proposedLineItemsTotal: billable.lineItemsTotal,
            proposedGrossPay: billable.grossPay,
            requiresExplicitApproval: billable.requiresExplicitApproval,
            proposalReason: proposalReason ?? null,
            proposedAt: nowIso,
            correctionRespondByAt,
            updatedAt: nowIso,
            correctionHistory: admin.firestore.FieldValue.arrayUnion({
              by: "client", action: "proposed_correction", at: nowIso,
              startTime: String(proposedStartTime), endTime: String(proposedEndTime),
              hours: billable.totalHours, basePay: billable.basePay,
              lineItems: billable.lineItems, lineItemsTotal: billable.lineItemsTotal,
              grossPay: billable.grossPay, note: proposalReason ?? null,
            }),
          });
          const cgSessSnap4 = await db.collection("agent_sessions").where("userId", "==", shift.caregiverId).limit(1).get();
          if (!cgSessSnap4.empty) {
            const { sendToPhone } = await import("../linq/client");
            await sendToPhone(cgSessSnap4.docs[0].id, `The family proposed a correction to your shift hours: ${proposedStartTime}–${proposedEndTime} (${billable.totalHours}h). Respond within 24h or it auto-accepts.`).catch(() => {});
          }
        } else if (action === "accept_counter") {
          if (!shift.counterStartTime || !shift.counterEndTime) {
            return toolError("INVALID_INPUT", "Counter-proposal data is missing on this shift");
          }
          const billable = resolveShiftBillableAmount({
            startTime: String(shift.counterStartTime), endTime: String(shift.counterEndTime),
            bookedRateDollars: Number(shift.payRate),
            lineItems: shift.counterLineItems,
          });
          await shiftSnap.ref.update({
            status: "approved",
            finalStartTime: shift.counterStartTime,
            finalEndTime: shift.counterEndTime,
            finalTotalHours: billable.totalHours,
            lineItems: billable.lineItems,
            lineItemsTotal: billable.lineItemsTotal,
            basePay: billable.basePay,
            grossPay: billable.grossPay,
            amountCents: billable.grossPayCents,
            requiresExplicitApproval: billable.requiresExplicitApproval,
            resolvedAt: nowIso,
            resolvedBy: "client",
            updatedAt: nowIso,
            correctionHistory: admin.firestore.FieldValue.arrayUnion({
              by: "client", action: "accepted", at: nowIso,
              startTime: shift.counterStartTime, endTime: shift.counterEndTime, hours: billable.totalHours,
              lineItems: billable.lineItems, lineItemsTotal: billable.lineItemsTotal,
              basePay: billable.basePay, grossPay: billable.grossPay,
            }),
          });
          const cgSessSnap5 = await db.collection("agent_sessions").where("userId", "==", shift.caregiverId).limit(1).get();
          if (!cgSessSnap5.empty) {
            const { sendToPhone } = await import("../linq/client");
            await sendToPhone(cgSessSnap5.docs[0].id, `The family accepted your counter-proposal (${billable.totalHours}h). Payment will be processed shortly.`).catch(() => {});
          }
        } else {
          // escalate
          await shiftSnap.ref.update({
            status: "disputed_admin_review",
            resolvedBy: null,
            updatedAt: nowIso,
            correctionHistory: admin.firestore.FieldValue.arrayUnion({ by: "client", action: "escalated", at: nowIso }),
          });
          const { notifyAdmins } = await import("../shiftHours");
          await notifyAdmins(
            "shift_hours_admin_review",
            "Shift hours dispute needs mediation",
            `${shift.clientName ?? "A client"} escalated a dispute with ${shift.caregiverName ?? "a caregiver"} for appointment ${appointmentId}.`,
            { appointmentId },
          ).catch(() => {});
        }
      } catch (error) {
        if (error instanceof Error) {
          return toolError("INVALID_INPUT", error.message);
        }
        throw error;
      }
      logAudit({ eventType: "shift_hours_reviewed", userId: clientId as string, data: { source: "mcp:review_shift_hours", appointmentId, action } }).catch(() => {});
      return { success: true, action, appointmentId };
      });
    }

    // ── withdraw_job_application (U2) ───────────────────────────────────────────
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
      const gateError = await checkClientAccessGate(clientId as string, "interview");
      if (gateError) return gateError;

      return createVideoInterviewRequestForTool({
        clientId: clientId as string, caregiverId: caregiverId as string,
        applicationId: applicationId as string | undefined,
        jobId: jobId as string | undefined,
        notes: notes as string | undefined,
        phone: input.phone as string | undefined,
        preferredDate: preferredDate as string, preferredTime: preferredTime as string,
        interviewType: interviewType as string | undefined,
      });
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
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const today = businessTodayStr();

      // Matches components/client/MyCareTeam.tsx exactly: a caregiver is
      // "active" only if their booking_requests doc is accepted AND still has
      // a scheduled shift (a caregiver can be accepted but have no shifts left
      // if the visits already ran out) — plus the legacy `appointments`
      // pipeline, merged the same way this session's other reminder/notify
      // fixes do it, so a caregiver booked either way shows up correctly.
      const [bookingsSnap, scheduledShiftsSnap, apptSnap] = await Promise.all([
        db.collection("booking_requests").where("clientId", "==", clientId).limit(100).get(),
        db.collection("shifts").where("clientId", "==", clientId).where("status", "==", "scheduled").get(),
        db.collection("appointments").where("clientId", "==", clientId).where("status", "in", ["confirmed", "completed", "in-progress"]).orderBy("date", "desc").limit(50).get(),
      ]);

      const activeBookingIds = new Set<string>();
      const nextShiftByBooking = new Map<string, string>();
      scheduledShiftsSnap.docs.forEach((d) => {
        const shift = d.data();
        const bid = shift.bookingRequestId as string | undefined;
        if (!bid) return;
        activeBookingIds.add(bid);
        const existing = nextShiftByBooking.get(bid);
        if (!existing || (shift.date as string) < existing) nextShiftByBooking.set(bid, shift.date as string);
      });

      interface TeamEntry { name?: string; caringFor?: string; nextShift: string | null; active: boolean }
      const active = new Map<string, TeamEntry>();
      const past   = new Map<string, TeamEntry>();

      bookingsSnap.docs.forEach((doc) => {
        const b = doc.data();
        const cid = b.caregiverId as string | undefined;
        if (!cid) return;
        const caringFor = Array.isArray(b.careRecipients)
          ? (b.careRecipients as Array<{ firstName?: string; name?: string }>).map((r) => r.firstName ?? r.name).filter(Boolean).join(", ")
          : undefined;
        if (b.status === "accepted" && activeBookingIds.has(doc.id)) {
          active.set(cid, { name: b.caregiverName, caringFor, nextShift: nextShiftByBooking.get(doc.id) ?? null, active: true });
        } else if (["cancelled", "declined", "completed"].includes(b.status as string) || (b.status === "accepted" && !activeBookingIds.has(doc.id))) {
          if (!past.has(cid)) past.set(cid, { name: b.caregiverName, caringFor, nextShift: null, active: false });
        }
      });

      // Legacy appointments — same active/past split, only fills in caregivers
      // the newer pipeline query above didn't already find.
      apptSnap.docs.forEach((d) => {
        const appt = d.data();
        const cid = appt.caregiverId as string | undefined;
        if (!cid || active.has(cid)) return;
        const isFuture = (appt.date as string) >= today;
        if (appt.status !== "completed" && isFuture) {
          const existing = active.get(cid);
          active.set(cid, { name: appt.caregiverName, nextShift: !existing?.nextShift || appt.date < existing.nextShift ? appt.date : existing.nextShift, active: true });
        } else if (!past.has(cid)) {
          past.set(cid, { name: appt.caregiverName, nextShift: null, active: false });
        }
      });
      // A caregiver active anywhere is never also listed as past.
      for (const cid of active.keys()) past.delete(cid);

      const entries = [...active.entries(), ...past.entries()].slice(0, 10);
      const careTeam = await Promise.all(
        entries.map(async ([cid, meta]) => {
          const cgSnap = await db.collection("caregivers").doc(cid).get();
          const cg = cgSnap.data() ?? {};
          return {
            caregiverId: cid,
            name:        cg.name ?? (`${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim() || meta.name) ?? "Caregiver",
            phone:       cg.phone ?? null,
            rating:      cg.rating ?? null,
            active:      meta.active,
            nextShift:   meta.nextShift,
            caringFor:   meta.caringFor || null,
          };
        })
      );
      return { success: true, careTeam, total: careTeam.length };
    }

    // ── get_invoice_history ─────────────────────────────────────────────────
    if (name === "get_invoice_history") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const limit10 = Math.min((input.limit as number) ?? 5, 20);
      const invSnap = await db.collection("shiftHours")
        .where("clientId", "==", clientId)
        // auto_approved (24h no-response auto-approve) is how most real shifts
        // resolve — omitting it left the client's own history mostly empty.
        .where("status", "in", ["approved", "auto_approved", "paid"])
        .orderBy("submittedAt", "desc")
        .limit(limit10)
        .get();
      const invoices = await Promise.all(
        invSnap.docs.map(async (d) => {
          const sh = d.data();
          const cgSnap = await db.collection("caregivers").doc(sh.caregiverId as string).get().catch(() => null);
          const cg = cgSnap?.data() ?? {};
          // Real shiftHours fields — see get_pending_timesheets' comment above;
          // same bug (date/durationHours never written), plus approvedAt was
          // reading reviewedAt, but reviewShiftHours (shiftHours.ts) writes
          // resolvedAt, not reviewedAt.
          const startTime = sh.finalStartTime ?? sh.submittedStartTime;
          return {
            invoiceId:     d.id,
            date:          startTime ? new Date(startTime as string).toISOString().slice(0, 10) : null,
            caregiverName: (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver",
            hours:         sh.finalTotalHours ?? sh.submittedTotalHours ?? null,
            amount:        `$${((sh.amountCents as number ?? 0) / 100).toFixed(2)}`,
            status:        sh.status,
            approvedAt:    sh.resolvedAt ?? null,
          };
        })
      );
      return { success: true, invoices, total: invoices.length };
    }

    // ── edit_job_post ───────────────────────────────────────────────────────
    if (name === "edit_job_post") {
      const { jobId, clientId, rate, description, startDate, daysOfWeek, timeOfDay } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap.exists) return toolError("NOT_FOUND", "Job post not found");
      const jp = jpSnap.data()!;
      if (jp.clientId !== clientId) return toolError("PERMISSION_DENIED", "This job post does not belong to you");
      if (jp.status !== "open") return toolError("INVALID_INPUT", `Cannot edit a job post with status '${jp.status}'`);
      // job_posts is flat (services/api.ts's createJobPost: rate/daysOfWeek/
      // timeOfDay, no nested `schedule` object and no `hourlyRate`) — writing
      // the nested shape below meant an edit made through Evia never showed
      // up on the site's own listing.
      const upd: Record<string, unknown> = { updatedAt: nowIso };
      if (rate        != null)  upd.rate          = rate;
      if (description != null)  upd.description   = (description as string).slice(0, 500);
      if (startDate   != null)  upd.startDate     = startDate;
      if (daysOfWeek  != null)  upd.daysOfWeek    = daysOfWeek;
      if (timeOfDay   != null)  upd.timeOfDay     = timeOfDay;
      await jpSnap.ref.update(upd);
      // job_postings (the onboarding-contract mirror, clientJobPostingContract.ts)
      // uses ITS OWN different field names for two of these — jobDescription
      // (not description) and selectedDays (not daysOfWeek) — rate/startDate/
      // timeOfDay happen to match. Spreading `upd` as-is would silently write
      // the wrong keys there too.
      const postingsUpd: Record<string, unknown> = { updatedAt: nowIso, clientId };
      if (rate        != null) postingsUpd.rate          = rate;
      if (description != null) postingsUpd.jobDescription = upd.description;
      if (startDate   != null) postingsUpd.startDate      = startDate;
      if (daysOfWeek  != null) postingsUpd.selectedDays   = daysOfWeek;
      if (timeOfDay   != null) postingsUpd.timeOfDay      = timeOfDay;
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
      const clientPhone = clientSnap.data()?.phone as string | undefined;
      if (!clientPhone) return toolError("NOT_FOUND", "Client phone number not found");
      const cgName = cgGateData.name ?? "Your caregiver";
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(clientPhone, `${cgName}: ${message}`, "mcp:send_client_message");
      // Also land the message in the same persisted chatRooms thread the
      // website's Inbox reads from — see send_caregiver_message for the other
      // direction. Fail-soft: never block the SMS relay on a thread-write hiccup.
      try {
        const clientName = (clientSnap.data()?.name as string | undefined)
          ?? (clientSnap.data()?.firstName as string | undefined) ?? "";
        const { relayIntoSharedChatThread } = await import("../utils/chatThread");
        await relayIntoSharedChatThread({
          clientId: resolvedClientId, clientName,
          caregiverId: caregiverId as string, caregiverName: cgName as string,
          senderId: caregiverId as string, senderName: cgName as string,
          text: message as string,
        });
      } catch (err) {
        console.error("send_client_message: chatRooms thread write failed (SMS still sent):", err);
      }
      logAudit({ eventType: "caregiver_sent_message", userId: caregiverId as string, data: { source: "mcp:send_client_message", resolvedClientId, messageLength: (message as string).length, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, sent: notification.sent, sentTo: resolvedClientId, notification };
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

    // ── get_recent_messages ─────────────────────────────────────────────────
    if (name === "get_recent_messages") {
      const { userId, counterpartId } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const msgLimit = Math.min((input.limit as number) ?? 5, 20);
      // Real caregiver<->client conversations live in chatRooms/{roomId}
      // (roomId = sorted [uid1,uid2].join('_'), see utils/chatThread.ts), the
      // same collection send_caregiver_message/send_client_message write to.
      // This tool previously read `threads`, which is only the Evia-assistant
      // chat-widget mirror (participants always [uid,'cara']), and ordered by
      // a field ('updatedAt') no chatRooms/threads doc has ever had — so it
      // always returned empty, regardless of counterpartId.
      const { chatRoomIdFor } = await import("../utils/chatThread");
      let roomRows: Array<{ id: string; data: () => FirebaseFirestore.DocumentData | undefined }>;
      if (counterpartId) {
        const roomId = chatRoomIdFor(userId as string, counterpartId as string);
        const roomSnap = await db.collection("chatRooms").doc(roomId).get();
        roomRows = roomSnap.exists ? [{ id: roomId, data: () => roomSnap.data() }] : [];
      } else {
        const roomsSnap = await db.collection("chatRooms")
          .where("participants", "array-contains", userId)
          .orderBy("lastMessageTimestamp", "desc")
          .limit(5)
          .get();
        roomRows = roomsSnap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
      }
      const results = await Promise.all(
        roomRows
          .filter((r) => !((r.data()?.deletedAt as Record<string, unknown> | undefined)?.[userId as string]))
          .map(async (r) => {
            const room = r.data() ?? {};
            const participants = (room.participants as string[]) ?? [];
            const participantNames = (room.participantNames as string[]) ?? [];
            const otherIdx = participants.findIndex((p) => p !== userId);
            const otherUserId = otherIdx >= 0 ? participants[otherIdx] : undefined;
            const otherName = (otherIdx >= 0 ? participantNames[otherIdx] : "") || "Unknown";
            const msgsSnap = await db.collection("chatRooms").doc(r.id).collection("messages")
              .orderBy("timestamp", "desc").limit(msgLimit).get();
            const messages = msgsSnap.docs.reverse().map((m) => {
              const msg = m.data();
              return {
                from:      msg.senderId === userId ? "you" : otherName,
                text:      (msg.text as string ?? "").slice(0, 200),
                timestamp: msg.timestamp,
              };
            });
            return { threadId: r.id, with: otherName, withId: otherUserId, messages };
          })
      );
      return { success: true, threads: results, total: results.length };
    }

    // ── list_client_jobs ────────────────────────────────────────────────────
    if (name === "list_client_jobs") {
      const { clientId, status } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      let query: admin.firestore.Query = db.collection("job_posts").where("clientId", "==", clientId);
      if (status && status !== "all") query = query.where("status", "==", status);
      const snap = await query.orderBy("createdAt", "desc").limit(10).get();
      const jobs = snap.docs.map((d) => {
        const data = d.data();
        return {
          id:             d.id,
          title:          data.summary ?? `Care job — ${(data.careTypes as string[] ?? []).slice(0,2).join(", ")}`,
          status:         data.status,
          // The doc has always had this field — it just never made it into
          // the response, so a client asking Evia their own posted rate had
          // no live answer available.
          rate:           data.rate,
          applicantCount: data.applicantCount ?? 0,
          createdAt:      data.createdAt,
          // job_posts is flat — there's no nested `schedule` object (see
          // edit_job_post above), so this always returned undefined.
          daysOfWeek:     data.daysOfWeek,
          timeOfDay:      data.timeOfDay,
        };
      });
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
      const { jobId, clientId } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap2 = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap2.exists) return toolError("NOT_FOUND", "Job post not found");
      if (jpSnap2.data()!.clientId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized");
      const appSnap3 = await db.collection("job_applications").where("jobId", "==", jobId).limit(10).get();
      const applicants = await Promise.all(
        appSnap3.docs.map(async (d) => {
          const app = d.data();
          const cgSnap = await db.collection("caregivers").doc(app.caregiverId as string).get();
          const cg = cgSnap.data() ?? {};
          return {
            applicationId:  d.id,
            caregiverName:  (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Unknown",
            caregiverId:    app.caregiverId,
            proposedRate:   app.proposedRate ?? null,
            // coverLetter is the canonical key (apply_to_job writes both, but
            // only as a compat alias for SMS-side readers — the website's own
            // apply flow writes ONLY coverLetter). Reading coverNote alone
            // silently returned null for every web-submitted application's
            // real cover letter — found live via a real applicant whose note
            // ("i'm hard worker") Evia denied having on file.
            coverNote:      app.coverLetter ?? app.coverNote ?? null,
            status:         app.status       ?? "pending",
            appliedAt:      app.appliedAt,
            rating:         cg.rating        ?? null,
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

      // Auto-reject pending interview_requests that fall on days no longer available
      let conflictsCancelled = 0;
      if (Array.isArray(unavailableDays) && (unavailableDays as string[]).length > 0) {
        const removedDays = (unavailableDays as string[]).map((d: string) => d.toLowerCase());
        const pendingInterviews = await db.collection("interview_requests")
          .where("caregiverId", "==", caregiverId)
          .where("status", "in", ["pending_presentation", "awaiting_caregiver_response", "scheduled"])
          .get();

        const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
        const conflictedRequests: Array<{ id: string; clientPhone: string; scheduledDate?: string }> = [];

        for (const doc of pendingInterviews.docs) {
          const req = doc.data();
          // Check if scheduled date falls on a removed day
          const scheduledDate = req.scheduledAt ?? req.proposedTime;
          if (scheduledDate) {
            // PT weekday — getDay() is the UTC weekday on Cloud Functions, so a
            // Z-form PT-evening interview read as the NEXT weekday (wrong
            // interviews cancelled / real conflicts kept).
            const { parseScheduledTimeMs: parseAvailMs } = await import("../utils/scheduledTime");
            const schedMs = parseAvailMs(String(scheduledDate));
            const dayOfWeek = Number.isFinite(schedMs)
              ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" })
                  .format(new Date(schedMs)).toLowerCase()
              : DAY_NAMES[new Date(scheduledDate).getDay()];
            if (removedDays.includes(dayOfWeek)) {
              conflictedRequests.push({ id: doc.id, clientPhone: req.clientPhone, scheduledDate });
            }
          }
        }

        for (const conflict of conflictedRequests) {
          await db.collection("interview_requests").doc(conflict.id).update({
            status:       "cancelled_availability",
            cancelledAt:  nowIso,
            cancelReason: "caregiver_removed_availability",
          }).catch(() => {});

          // Notify the client that this interview slot is no longer available
          if (conflict.clientPhone) {
            const clientSess = await db.collection("agent_sessions").doc(conflict.clientPhone).get().catch(() => null);
            if (clientSess?.exists) {
              const { sendToPhone } = await import("../linq/client");
              const cgData = cgSnap6.data();
              const cgName = cgData?.name ?? cgData?.firstName ?? "The caregiver";
              await sendToPhone(conflict.clientPhone,
                `${cgName} is no longer available on that day and your scheduled interview has been cancelled. ` +
                `Would you like me to find another time or a different caregiver?`
              ).catch(() => {});
              // Set state so client's next YES triggers rematching
              await db.collection("agent_sessions").doc(conflict.clientPhone).update({
                pendingRematch: { reason: "interview_cancelled_availability", caregiverId },
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              }).catch(() => {});
            }
          }
          conflictsCancelled++;
        }
      }

      return { success: true, updated: { availableDays: availableDays ?? [], unavailableDays: unavailableDays ?? [], preferredTimeOfDay: preferredTimeOfDay ?? null }, conflictingInterviewsCancelled: conflictsCancelled };
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
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const tsSnap = await db.collection("shiftHours").where("clientId", "==", clientId).where("status", "==", "pending_client_review").orderBy("submittedAt", "desc").limit(5).get();
      const timesheets = await Promise.all(
        tsSnap.docs.map(async (d) => {
          const ts = d.data();
          const cgSnap8 = await db.collection("caregivers").doc(ts.caregiverId as string).get().catch(() => null);
          const cg8 = cgSnap8?.data() ?? {};
          // Real shiftHours fields (createValidatedShiftHours.ts) — this used
          // to read date/clockInTime/clockOutTime/durationHours, none of which
          // are ever written, so every real record came back blank. Mirrors
          // Payments.tsx's own display priority: final* wins once set.
          const startTime = ts.finalStartTime ?? ts.submittedStartTime;
          const endTime   = ts.finalEndTime   ?? ts.submittedEndTime;
          return {
            appointmentId:  ts.appointmentId,
            caregiverName:  (cg8.name ?? `${cg8.firstName ?? ""} ${cg8.lastName ?? ""}`.trim()) || "Caregiver",
            date:           startTime ? new Date(startTime as string).toISOString().slice(0, 10) : null,
            clockIn:        startTime ?? null,
            clockOut:       endTime ?? null,
            hours:          ts.finalTotalHours ?? ts.submittedTotalHours ?? null,
            amountOwed:     `$${((ts.amountCents as number ?? 0) / 100).toFixed(2)}`,
            submittedAt:    ts.submittedAt,
          };
        })
      );
      return { success: true, timesheets, total: timesheets.length };
    }

    // ── get_care_journal_client ─────────────────────────────────────────────
    if (name === "get_care_journal_client") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const limit9 = Math.min((input.limit as number) ?? 5, 20);
      const userSnap = await db.collection("users").doc(clientId as string).get();
      const seniorId9 = userSnap.data()?.seniorId as string | undefined;
      if (!seniorId9) return toolError("NOT_FOUND", "No senior profile linked to this client");
      logHealthDataAccessed(clientId as string, seniorId9, "mcp:get_care_journal_client").catch(() => {});
      const jSnap = await db.collection("care_journal").where("seniorId", "==", seniorId9).orderBy("timestamp", "desc").limit(limit9).get();
      const entries = await Promise.all(
        jSnap.docs.map(async (d) => {
          const entry = d.data();
          const cgSnap9 = await db.collection("caregivers").doc(entry.caregiverId as string).get().catch(() => null);
          const cg9 = cgSnap9?.data() ?? {};
          return {
            timestamp:    entry.timestamp,
            caregiverName: (cg9.name ?? `${cg9.firstName ?? ""} ${cg9.lastName ?? ""}`.trim()) || "Caregiver",
            notes:        entry.notes       ?? null,
            // SMS/care-notes entries nest mood under wellness; surface it consistently.
            mood:         entry.mood        ?? entry.wellness?.mood ?? null,
            activities:   entry.activities  ?? [],
            wellness:     entry.wellness    ?? null,
          };
        })
      );
      return { success: true, entries, total: entries.length };
    }

    // ── modify_recurring_schedule ───────────────────────────────────────────
    if (name === "modify_recurring_schedule") {
      const { scheduleId, clientId, newDays, newStartTime, newEndTime } = input as Record<string, unknown>;
      if (!scheduleId || !clientId) return toolError("INVALID_INPUT", "scheduleId and clientId are required");
      if (!newDays && !newStartTime && !newEndTime) return toolError("INVALID_INPUT", "At least one of newDays, newStartTime, or newEndTime is required");

      const schedSnap = await db.collection("recurring_schedules").doc(scheduleId as string).get();
      if (!schedSnap.exists) return toolError("NOT_FOUND", "Recurring schedule not found");
      const sched = schedSnap.data()!;
      if (sched.clientId !== clientId) return toolError("PERMISSION_DENIED", "Schedule does not belong to this client");
      if (sched.status === "cancelled") return toolError("INVALID_INPUT", "Cannot modify a cancelled schedule");

      const resolvedDays  = (newDays  as string[] | undefined) ?? (sched.days  as string[]);
      const resolvedStart = (newStartTime as string | undefined) ?? (sched.startTime as string);
      const resolvedEnd   = (newEndTime   as string | undefined) ?? (sched.endTime   as string);

      // Validate times
      const timePattern = /^\d{2}:\d{2}$/;
      if (!timePattern.test(resolvedStart) || !timePattern.test(resolvedEnd)) {
        return toolError("INVALID_INPUT", "Start and end times must be in HH:MM format");
      }
      const [sh, sm] = resolvedStart.split(":").map(Number);
      const [eh, em] = resolvedEnd.split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) return toolError("INVALID_INPUT", "End time must be after start time");
      const newDurationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;

      const today = nowIso.slice(0, 10);

      // Cancel all future confirmed appointments from the old schedule.
      // orderBy(date desc) shares the Q5 composite; membership unchanged (see
      // the identical query in modifyScheduleFlow.ts).
      const futureSnap = await db.collection("appointments")
        .where("recurringScheduleId", "==", scheduleId)
        .where("date", ">", today)
        .where("status", "in", ["confirmed"])
        .orderBy("date", "desc")
        .get();

      const { generateRecurringDates } = await import("../scheduled/recurringScheduler");
      const newDatesArr = generateRecurringDates(today, resolvedDays, 4);

      const batchMs = db.batch();
      for (const doc of futureSnap.docs) {
        batchMs.update(doc.ref, { status: "cancelled_modified", cancelledAt: nowIso, cancelReason: "schedule_modified" });
      }
      batchMs.update(schedSnap.ref, {
        days: resolvedDays, startTime: resolvedStart, endTime: resolvedEnd,
        durationHours: newDurationHours, modifiedAt: nowIso,
        lastExtendedAt: nowIso, weeksBookedAhead: 4,
      });
      for (const { date } of newDatesArr) {
        const apptRef = db.collection("appointments").doc();
        batchMs.set(apptRef, {
          clientId,
          caregiverId:         sched.caregiverId,
          caregiverName:       sched.caregiverName,
          seniorName:          sched.seniorName || null,
          date, startTime: resolvedStart, endTime: resolvedEnd,
          durationHours: newDurationHours, hourlyRate: sched.hourlyRate,
          ...canonicalApptFields({ startTime: resolvedStart, durationHours: newDurationHours, hourlyRate: sched.hourlyRate as number | undefined }),
          status: "confirmed", recurringScheduleId: scheduleId,
          billingAuthority: BILLING_AUTHORITY_VERSION,
          humanApproved: true, createdByAgent: true, createdAt: nowIso,
        });
      }
      await batchMs.commit();

      // Notify caregiver
      const cgSnap = await db.collection("caregivers").doc(sched.caregiverId as string).get().catch(() => null);
      const cgPhone = cgSnap?.data()?.phone as string | undefined;
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
      if (cgPhone) {
        const { trySend } = await import("../utils/toolNotify");
        notification = await trySend(cgPhone,
          `Your recurring schedule with this family has been updated. New schedule: ${resolvedDays.join(", ")}, ${resolvedStart}–${resolvedEnd}. ` +
          `Old upcoming visits were replaced with new ones.`,
          "mcp:modify_recurring_schedule",
        );
      }

      logAudit({ eventType: "recurring_schedule_updated", userId: clientId as string, data: { source: "mcp:modify_recurring_schedule", scheduleId, newDays: resolvedDays, newStartTime: resolvedStart, newEndTime: resolvedEnd, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, scheduleId, newDays: resolvedDays, newStartTime: resolvedStart, newEndTime: resolvedEnd, newVisitsCreated: newDatesArr.length, oldVisitsCancelled: futureSnap.size, notification };
    }

    // ── get_payment_update_link ─────────────────────────────────────────────
    if (name === "get_payment_update_link") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");

      // customers/{uid} is the authoritative, immediately-written source (set
      // the instant Stripe Checkout starts, functions/src/stripe.ts) — the
      // rest of the codebase checks it first (shiftHours.ts's own payment
      // logic), falling back to the users/{uid} mirror, which is only written
      // later on the checkout.session.completed webhook. This tool used to
      // check users-only, so a client with an in-progress/abandoned checkout
      // (a customers doc, no users mirror yet) got wrongly told they had no
      // billing account at all.
      const custSnap = await db.collection("customers").doc(clientId as string).get().catch(() => null);
      let stripeCustomerId = custSnap?.data()?.stripeCustomerId as string | undefined;
      if (!stripeCustomerId) {
        const userSnap = await db.collection("users").doc(clientId as string).get();
        if (!userSnap.exists) return toolError("NOT_FOUND", "Client not found");
        stripeCustomerId = userSnap.data()?.stripeCustomerId as string | undefined;
      }
      if (!stripeCustomerId) return toolError("INVALID_INPUT", "No Stripe billing account found for this client. They may need to re-subscribe.");

      const { getStripeClient } = await import("../stripe");
      const sc = getStripeClient();

      const appUrl = getAppUrl();
      const session = await sc.billingPortal.sessions.create({
        customer:   stripeCustomerId,
        return_url: `${appUrl}/client/payments`,
      });

      logAudit({ eventType: "billing_portal_opened", userId: clientId as string, data: { source: "mcp:get_payment_update_link" } }).catch(() => {});
      return { success: true, url: session.url, expiresIn: "5 minutes" };
    }

    // ── retry_shift_payment ─────────────────────────────────────────────────
    // Agent mirror of the v1-retryShiftPayment callable (shiftHours.ts): reset a
    // payment_failed shift to 'approved' so the onShiftHoursApproved trigger
    // re-charges. Naturally idempotent — a replay finds status !== payment_failed
    // and refuses instead of double-charging.
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
    if (name === "get_invoice_details") {
      const { clientId: invClientId, invoiceId: invId } = input as Record<string, string | undefined>;
      if (!invClientId) return toolError("INVALID_INPUT", "clientId is required");
      // Real per-shift billing lives in shiftHours (same collection
      // get_invoice_history reads and hands its own doc ids back as
      // "invoiceId") — `invoices` is a separate, admin-only manual-invoicing
      // collection that's essentially always empty for a real client, so this
      // always 404'd before.
      let invDocs: admin.firestore.DocumentSnapshot[];
      if (invId) {
        const doc = await db.collection("shiftHours").doc(invId).get();
        invDocs = (doc.exists && doc.data()?.clientId === invClientId) ? [doc] : [];
      } else {
        const q = await db.collection("shiftHours")
          .where("clientId", "==", invClientId)
          .where("status", "in", ["approved", "auto_approved", "paid"])
          .orderBy("submittedAt", "desc")
          .limit(1)
          .get();
        invDocs = q.docs;
      }
      if (!invDocs.length) return toolError("NOT_FOUND", "No invoices found for this client.");
      const invoice = invDocs[0].data()!;
      const invStartTime = invoice.finalStartTime ?? invoice.submittedStartTime;
      return {
        invoiceId:     invDocs[0].id,
        caregiverName: invoice.caregiverName,
        date:          invStartTime ? new Date(invStartTime as string).toISOString().slice(0, 10) : null,
        status:        invoice.status,
        hours:         invoice.finalTotalHours ?? invoice.submittedTotalHours,
        total:         invoice.grossPay ?? (Number(invoice.amountCents ?? 0) / 100),
        lineItems:     invoice.lineItems ?? [],
        createdAt:     invoice.submittedAt,
      };
    }

    // ── create_refund_request ───────────────────────────────────────────────
    if (name === "create_refund_request") {
      const { clientId: rfClientId, appointmentId: rfApptId, reason: rfReason } = input as Record<string, string | undefined>;
      if (!rfClientId || !rfApptId) return toolError("INVALID_INPUT", "clientId and appointmentId are required");
      const refundAppt = await db.collection("appointments").doc(rfApptId).get();
      if (!refundAppt.exists) return toolError("NOT_FOUND", "Appointment not found");
      if (refundAppt.data()?.clientId !== rfClientId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
      const ref = db.collection("refundRequests").doc(`${rfApptId}:${rfClientId}`);
      try {
        await ref.create({
          clientId:      rfClientId,
          appointmentId: rfApptId,
          reason:        rfReason ?? "",
          status:        "requested",
          requestedAt:   nowIso,
          source:        "cara_self_service",
        });
      } catch (error: any) {
        if (error?.code !== 6 && !/already exists/i.test(String(error?.message ?? ""))) throw error;
      }
      return { success: true, requestId: ref.id, status: "requested", message: "Refund request submitted. Admin review within 24 hours." };
    }

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
      return { success: true, message: `Shift on ${swap.date} transferred to ${caregiverName}.` };
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

    // ── initiate_client_swap ────────────────────────────────────────────────
    if (name === "initiate_client_swap") {
      const { appointmentId } = input as Record<string, string>;
      const appt = await db.collection("appointments").doc(appointmentId).get();
      if (!appt.exists) return toolError("NOT_FOUND", "Appointment not found");
      const data = appt.data()!;
      const dayOfWeek = new Date(data.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
      const shiftHour = parseInt((data.time ?? "09:00").split(":")[0], 10);
      const snap = await db.collection("caregivers").where("verified", "==", true).limit(30).get();
      const options: Array<{ caregiverId: string; name: string; rate?: number }> = [];
      for (const doc of snap.docs) {
        if (doc.id === data.caregiverId) continue;
        const cg = doc.data();
        if (isSeededCaregiver(cg)) continue;
        if (!isCaregiverBookable(cg)) continue;
        const avail = cg.weeklyAvailability?.[dayOfWeek] as Array<{ start: string; end: string }> | undefined;
        if (!avail?.some(s => parseInt(s.start.split(":")[0], 10) <= shiftHour && shiftHour < parseInt(s.end.split(":")[0], 10))) continue;
        const conflict = await db.collection("appointments").where("caregiverId", "==", doc.id).where("date", "==", data.date).where("status", "in", ["confirmed"]).limit(1).get();
        if (!conflict.empty) continue;
        options.push({ caregiverId: doc.id, name: cg.name ?? cg.firstName ?? "Caregiver", rate: cg.hourlyRate });
        if (options.length >= 3) break;
      }
      if (!options.length) return { available: [], message: "No available caregivers found for that date." };
      return { available: options, appointmentDate: data.date, currentCaregiver: data.caregiverName };
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
      const { userId, firstName, lastName, requestPhoneChange, address, city, state, zip, photoUrl } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");

      // requestPhoneChange is a request flag, not a field write — login here
      // is by phone number, so a change always goes through the email
      // round-trip (a standalone tool for just this used to exist; folded in
      // here to stay under OpenAI's 128-tool cap rather than adding a tool).
      if (requestPhoneChange === true) {
        const snap = await db.collection("users").doc(userId as string).get();
        if (!snap.exists) return toolError("NOT_FOUND", "Account not found");
        const d = snap.data() ?? {};
        const email = (d.email as string | undefined)?.trim();
        if (!email) {
          return {
            success: false,
            noEmailOnFile: true,
            guidance: "This account has no email on file, so there's no way to send a verification link. Ask them to set a recovery email first, then try again.",
          };
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
      if (photoUrl  != null) patch.photoURL = photoUrl;
      if (Object.keys(patch).length === 1) {
        return toolError("INVALID_INPUT", "No fields to update");
      }
      await db.collection("users").doc(userId as string).set(patch, { merge: true });
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

    // ── update_communication_preferences ────────────────────────────────────
    if (name === "update_communication_preferences") {
      const { userId, newsletter, newMatchAlerts, reviewNotifications, privacyShowBookings } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const patch: Record<string, unknown> = { updatedAt: nowIso };
      if (newsletter           != null) patch.newsletter           = !!newsletter;
      if (newMatchAlerts       != null) patch.newMatchAlerts       = !!newMatchAlerts;
      if (reviewNotifications  != null) patch.reviewNotifications  = !!reviewNotifications;
      if (privacyShowBookings  != null) patch.privacyShowBookings  = !!privacyShowBookings;
      if (Object.keys(patch).length === 1) {
        return toolError("INVALID_INPUT", "No preference fields provided");
      }
      await db.collection("users").doc(userId as string).set(patch, { merge: true });
      logAudit({ eventType: "preferences_updated", userId: userId as string, data: { source: "mcp:update_communication_preferences", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => {});
      return { success: true, updated: Object.keys(patch).filter(k => k !== "updatedAt") };
    }

    // ── request_email_change ────────────────────────────────────────────────
    if (name === "request_email_change") {
      const { userId, newEmail } = input as Record<string, unknown>;
      if (!userId || !newEmail) return toolError("INVALID_INPUT", "userId and newEmail are required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail as string)) {
        return toolError("INVALID_INPUT", "newEmail is not a valid email address");
      }
      // Check for an account already using that email
      const existing = await db.collection("users").where("email", "==", newEmail).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== userId) {
        return toolError("INVALID_INPUT", "An account already exists with that email address");
      }
      const { requestEmailChangeForAccount } = await import("../accountRecovery");
      await requestEmailChangeForAccount(userId as string, "client", newEmail as string);
      logAudit({ eventType: "email_change_requested", userId: userId as string, data: { source: "mcp:request_email_change", maskedEmail: (newEmail as string).replace(/(.{2}).*(@.*)/, "$1***$2") } }).catch(() => {});
      return {
        success: true,
        verificationSent: true,
        newEmail,
        note: "Confirmation link sent to the new address. The change isn't live until they click it.",
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

    // ── list_saved_caregivers ───────────────────────────────────────────────
    if (name === "list_saved_caregivers") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const userSnap = await db.collection("users").doc(clientId as string).get();
      const ids = (userSnap.data()?.savedCaregiverIds as string[] | undefined) ?? [];
      if (ids.length === 0) return { success: true, caregivers: [], count: 0 };
      const caregivers: Array<Record<string, unknown>> = [];
      for (const id of ids.slice(0, 20)) {
        const cgSnap = await db.collection("caregivers").doc(id).get();
        if (!cgSnap.exists) continue;
        const cg = cgSnap.data()!;
        caregivers.push({
          id, name: cg.name ?? "",
          rate: cg.hourlyRate ?? null,
          rating: cg.averageRating ?? null,
          specialties: cg.specialties ?? [],
        });
      }
      return { success: true, caregivers, count: caregivers.length };
    }

    // ── set_block_status (block_user + unblock_user merged, 2026-08-31 — kept
    // both role tool surfaces under OpenAI's 128-tool cap when delete_conversation
    // was added) ──────────────────────────────────────────────────────────────
    if (name === "set_block_status") {
      const { userId, targetUserId, action: blockAction, reason } = input as Record<string, unknown>;
      if (!userId || !targetUserId || !blockAction) return toolError("INVALID_INPUT", "userId, targetUserId, and action are required");

      if (blockAction === "block") {
        if (userId === targetUserId) return toolError("INVALID_INPUT", "Cannot block yourself");
        await db.collection("users").doc(userId as string).set({
          blockedUsers: admin.firestore.FieldValue.arrayUnion(targetUserId),
          updatedAt: nowIso,
        }, { merge: true });
        // Surface to ops so abuse patterns become visible.
        db.collection("admin_alerts").add({
          type:        "user_blocked",
          userId,
          targetUserId,
          reason:      reason ?? null,
          severity:    "medium",
          resolved:    false,
          createdAt:   nowIso,
        }).catch(() => {});
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
        db.collection("admin_alerts").add({
          type:        "user_reported",
          reporterId:  userId,
          targetUserId,
          category,
          reportId:    reportRef.id,
          severity:    "medium",
          resolved:    false,
          createdAt:   nowIso,
        }).catch(() => {});
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
    if (name === "get_refund_requests") {
      const { clientId: rrClientId } = input as Record<string, unknown>;
      if (!rrClientId) return toolError("INVALID_INPUT", "clientId is required");
      const rrSnap = await db.collection("refundRequests").where("clientId", "==", rrClientId).get();
      const requests: Record<string, unknown>[] = rrSnap.docs
        .map((d): Record<string, unknown> => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
        .sort((a, b) => String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? "")))
        .slice(0, 20);
      return { success: true, requests, count: requests.length };
    }

    // ── get_shifts ──────────────────────────────────────────────────────────
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
      let q = db.collection("video_interviews").where(field, "==", id);
      if (liStatus) q = q.where("status", "==", liStatus);
      const liSnap = await q.limit(25).get();
      // SMS-scheduled interviews live in the separate `interviews` collection
      // (interviewAgent). Newer docs carry clientId/caregiverId, so the same
      // scoped query works; legacy docs without those fields simply don't
      // match — they predate the unified read and stay SMS-flow-only.
      let sq = db.collection("interviews").where(field, "==", id);
      if (liStatus) sq = sq.where("status", "==", liStatus);
      const smsSnap = await sq.limit(25).get().catch(() => ({ docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] }));
      // An Evia-SMS interview appears in BOTH collections: interviewAgent
      // mirrors the `interviews` doc into `video_interviews` with a
      // linkedInterviewId back-pointer. Surface only the mirror (it carries
      // callUrl + the calendar shape) and drop the `interviews` twin, so the
      // agent never sees — or cancels — the same interview under two ids.
      const mirroredIds = new Set(
        liSnap.docs.map(d => d.data().linkedInterviewId).filter((v): v is string => typeof v === "string" && !!v),
      );
      const interviews = [
        ...liSnap.docs.map(d => {
          const iv = d.data();
          return {
            interviewId:   d.id,
            source:        "video_interviews",
            clientId:      iv.clientId ?? null,
            caregiverId:   iv.caregiverId ?? null,
            caregiverName: iv.caregiverName ?? null,
            scheduledTime: iv.scheduledTime ?? null,
            interviewType: iv.interviewType ?? "video",
            status:        iv.status ?? "scheduled",
            callUrl:       iv.callUrl ?? null,
            proposedTime:  iv.proposedTime ?? null,
            applicationId: iv.applicationId ?? null,
          };
        }),
        ...smsSnap.docs.filter(d => !mirroredIds.has(d.id)).map(d => {
          const iv = d.data();
          return {
            interviewId:   d.id,
            source:        "interviews",
            clientId:      iv.clientId ?? null,
            caregiverId:   iv.caregiverId ?? null,
            caregiverName: iv.caregiverName ?? null,
            scheduledTime: iv.scheduledTime ?? null,
            interviewType: "video",
            status:        iv.status ?? "scheduled",
            callUrl:       iv.callUrl ?? null,
            proposedTime:  null,
            applicationId: null,
          };
        }),
      ].sort((a, b) => String(a.scheduledTime ?? "").localeCompare(String(b.scheduledTime ?? "")));
      return { success: true, interviews, count: interviews.length };
    }

    // ── cancel_interview ────────────────────────────────────────────────────
    if (name === "cancel_interview") {
      const ciInterviewId = input.interviewId as string | undefined;
      const ciClientId    = input.clientId as string | undefined;
      const ciCaregiverId = input.caregiverId as string | undefined;
      const ciReason      = input.reason as string | undefined;
      if (!ciInterviewId) return toolError("INVALID_INPUT", "interviewId is required");
      // Interviews live in two collections: video_interviews (web/MCP) and
      // interviews (SMS flow). list_interviews returns both, so cancel must
      // route to whichever holds the doc.
      let ivSnap = await db.collection("video_interviews").doc(ciInterviewId).get();
      if (!ivSnap.exists) {
        ivSnap = await db.collection("interviews").doc(ciInterviewId).get();
      }
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
      if (iv.status === "completed") return toolError("INVALID_INPUT", "Cannot cancel a completed interview");
      // Evia-SMS interviews exist TWICE: the `interviews` doc plus a
      // `video_interviews` mirror carrying a linkedInterviewId back-pointer
      // (interviewAgent). Cancelling only the doc the caller named leaves the
      // twin live — a ghost calendar entry with a working Join button, or 1h
      // reminder SMS (keyed on the `interviews` doc id) firing for a dead
      // interview — so resolve the twin and cancel both.
      let twinSnap: FirebaseFirestore.DocumentSnapshot | null = null;
      if (ivSnap.ref.parent.id === "video_interviews") {
        if (typeof iv.linkedInterviewId === "string" && iv.linkedInterviewId) {
          const s = await db.collection("interviews").doc(iv.linkedInterviewId).get().catch(() => null);
          twinSnap = s?.exists ? s : null;
        }
      } else {
        const mirror = await db.collection("video_interviews")
          .where("linkedInterviewId", "==", ciInterviewId)
          .limit(1)
          .get()
          .catch(() => null);
        twinSnap = mirror && !mirror.empty ? mirror.docs[0] : null;
      }
      const cancelPatch = {
        status:       "cancelled",
        cancelledAt:  nowIso,
        cancelledBy,
        cancelReason: ciReason ?? null,
        // Tells onVideoInterviewWrite (notificationTriggers.ts) not to also
        // text the counterpart — this tool already does it below, and the
        // legacy `interviews` collection has no trigger of its own to rely on
        // instead, so this manual send can't be removed the way the others were.
        cancelledViaAgent: true,
      };
      await ivSnap.ref.update(cancelPatch);
      if (twinSnap && twinSnap.data()?.status !== "cancelled") {
        await twinSnap.ref.update(cancelPatch).catch(() => {});
      }
      // Retire pending 1h reminders + follow-up for the dead interview — for
      // BOTH twins' refId namespaces (SMS reminders are keyed
      // interview_{interviews doc id}, web reminders video_interview_{video
      // doc id}). The video_interviews path is also covered by
      // onVideoInterviewLinkEnsure (web declines never pass through this
      // tool); SMS `interviews` docs have no status trigger, so this call is
      // their only cleanup.
      {
        const { cancelTriggersByRef } = await import("../triggers/triggerEngine");
        const refIds = new Set<string>([
          `${ivSnap.ref.parent.id === "video_interviews" ? "video_interview" : "interview"}_${ciInterviewId}`,
        ]);
        if (twinSnap) {
          refIds.add(`${twinSnap.ref.parent.id === "video_interviews" ? "video_interview" : "interview"}_${twinSnap.id}`);
        }
        await Promise.all([...refIds].map(r => cancelTriggersByRef(r).catch(() => {})));
      }
      // Notify the counterpart, following schedule_interview (caregiver via
      // trySend) / respond_to_interview_request (client via agent_sessions).
      const when = typeof iv.scheduledTime === "string" ? iv.scheduledTime.slice(0, 10) : "the scheduled time";
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_counterpart_phone" };
      if (cancelledBy === "client") {
        const cgSnap  = await db.collection("caregivers").doc(iv.caregiverId as string).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (cgPhone) {
          const { trySend } = await import("../utils/toolNotify");
          notification = await trySend(cgPhone, `The interview scheduled for ${when} has been cancelled by the family.${ciReason ? ` Reason: ${ciReason}` : ""}`, "mcp:cancel_interview");
        }
      } else {
        const clientSess = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
        // SMS-flow `interviews` docs carry clientPhone directly — use it when
        // no uid-keyed session matches (legacy docs without clientId).
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
