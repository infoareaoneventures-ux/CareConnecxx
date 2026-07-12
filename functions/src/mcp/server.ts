import * as admin from "firebase-admin";
import { runMatchingForClient } from "../agents/matchingAgent";
import { logHealthDataAccessed, logBookingCreated, logAudit } from "../observability/auditLog";
import {
  readMemoryFile,
  writeMemoryFile,
  editMemoryFile,
  deleteMemoryFile,
  searchMemoryHybrid,
  getMemoryContext,
  listMemoryFiles,
  MemoryFile,
} from "../memory/memoryFiles";
import { getPreferences } from "../memory/preferences";
import { isHighRisk, proposePendingAction, buildPendingActionStub, getPendingActionById, isConfirmedActionValid } from "../agents/pendingActions";
import { claimToolExecution, settleToolExecution, toolExecutionKey } from "./toolExecutionLedger";
import { pauseCaregiver, reactivateCaregiver } from "../agents/pauseAccount";
import { normalizePaymentMethod, isOfflinePaymentMethod, paymentMethodLabel } from "../billing/paymentMethods";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { businessTodayStr } from "../utils/scheduledTime";
import { isSeededCaregiver } from "../agents/actions/getCaregiverPreviewAction";

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
// nothing. The genuine confirmed-and-irreversible action is the real-world web
// submit (pharmacy refill / appointment commit), where a double-fire hits a
// third party. This ledger is defense-in-depth layered over claimPendingAction's
// single-fire claim.
export const IDEMPOTENT_CONFIRMED_TOOLS = new Set<string>([
  "perform_web_action",
]);
import { runEphemeralSubAgent, buildTaskToolDescription, getPublicSubAgentNames, INTERNAL_SUB_AGENT_NAMES } from "../agents/ephemeralSubAgents";
import { getAppUrl } from "../config/appUrl";
import { logAgentAction } from "../observability/actionLedger";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import {
  createCaregiverReferralInvite,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";
import { autoApproveAtIso } from "../config/slaConstants";

const db = admin.firestore();

// ── Booking quote primitive (U9b) ─────────────────────────────────────────────
// The read/compute concern extracted out of `request_booking` so the model can
// reason about a booking in steps — look up the rate, quote the cost, THEN commit
// — instead of one opaque all-or-nothing tool. This helper is pure (one Firestore
// READ + arithmetic, no writes), shared by `get_caregiver_booking_rate`,
// `quote_booking`, and reusable by the committing `request_booking` path.
type BookingQuoteResult =
  | { ok: false; code: string; message: string }
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

// Resolve caregiver name + hourly rate from the caregiver doc. Mirrors the
// fallbacks used by the live `request_booking` path (name/fullName, rate→$20)
// so a quote and the eventual booking agree.
async function resolveCaregiverRate(
  caregiverId: string,
): Promise<{ ok: true; caregiverName: string; hourlyRate: number } | { ok: false; code: string; message: string }> {
  if (!caregiverId) return { ok: false, code: "INVALID_INPUT", message: "caregiverId is required" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  if (!cgSnap.exists) return { ok: false, code: "NOT_FOUND", message: "caregiver not found" };
  const cg = cgSnap.data() || {};
  return {
    ok:            true,
    caregiverName: (cg.name ?? cg.fullName ?? "your caregiver") as string,
    hourlyRate:    (typeof cg.hourlyRate === "number" ? cg.hourlyRate : 20) as number,
  };
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
    name: "get_caregiver_info",
    description: "Get a caregiver's profile including name, rate, specialties, and rating.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's ID" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_caregiver_reviews",
    description: "Fetch reviews for a specific caregiver.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
        limit:       { type: "number", description: "Max reviews to return (default 5)" },
      },
      required: ["caregiverId"],
    },
  },
  {
    name: "get_health_signals",
    description: "Get health signals detected from recent care journal entries for a senior (last 30 days).",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's user ID" },
        daysBack: { type: "number", description: "Days of history to include (default 30, max 90)" },
      },
      required: ["seniorId"],
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
    description: "Search for available caregivers matching the client's care needs. Session context (phone, chatId, clientId) is injected automatically — do NOT ask the user for these. Optionally narrow the search with the filters below when the family is specific (e.g. 'find someone available mornings near 95020 who can do dementia care').",
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
    name: "log_health_flag",
    description: "Log a health concern flagged directly by the family member (not from a journal entry).",
    input_schema: {
      type: "object",
      properties: {
        seniorId:    { type: "string" },
        signalType:  { type: "string", description: "e.g. 'falls', 'appetite_loss', 'confusion'" },
        description: { type: "string" },
      },
      required: ["seniorId", "signalType", "description"],
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
    name: "cancel_appointment",
    description:
      "Cancel a confirmed appointment on behalf of the client. " +
      "IMPORTANT: Only call this after the family has explicitly confirmed they want to cancel (e.g. they said 'yes cancel it' or 'go ahead'). Never call without explicit confirmation.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "The Firestore document ID of the appointment" },
        clientId:      { type: "string", description: "The client's user ID (for ownership check)" },
        reason:        { type: "string", description: "Optional reason (e.g. 'client_request', 'plans changed')" },
      },
      required: ["appointmentId", "clientId"],
    },
  },
  {
    name: "send_caregiver_message",
    description:
      "Send a message to a caregiver on behalf of the family. Use when the family asks you to relay something to the caregiver. " +
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
    name: "list_user_reminders",
    description: "List the personal reminders the user has set up through Evia (e.g. 'remind me every Monday about medications').",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The user's phone number" },
      },
      required: ["phone"],
    },
  },
  {
    name: "create_reminder",
    description:
      "Create a personal recurring reminder for the user. Use when the family asks Evia to remind them of something on a schedule. " +
      "Confirm the schedule with the family before calling.",
    input_schema: {
      type: "object",
      properties: {
        phone:      { type: "string" },
        userId:     { type: "string" },
        label:      { type: "string", description: "Short name for the reminder, e.g. 'mom medications'" },
        recurrence: { type: "string", description: "One of: daily, weekly, monthly, once" },
        dayOfWeek:  { type: "number", description: "0=Sun … 6=Sat — only for weekly recurrence" },
        hour:       { type: "number", description: "24-hour format, 0–23" },
        minute:     { type: "number", description: "0–59" },
        message:    { type: "string", description: "The full text Evia will send as the reminder" },
      },
      required: ["phone", "userId", "label", "recurrence", "hour", "minute", "message"],
    },
  },
  {
    name: "update_reminder",
    description: "Update an existing personal reminder — change its time, schedule, label, or message. Use when the family says 'move my medication reminder to 8am' or 'change that reminder to weekdays'. Only the reminder's owner can update it; provide only the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        phone:      { type: "string" },
        triggerId:  { type: "string", description: "The reminder/trigger id (from list_user_reminders)" },
        label:      { type: "string" },
        recurrence: { type: "string", description: "One of: daily, weekly, monthly, once" },
        dayOfWeek:  { type: "number", description: "0=Sun … 6=Sat — only for weekly recurrence" },
        hour:       { type: "number", description: "24-hour format, 0–23" },
        minute:     { type: "number", description: "0–59" },
        message:    { type: "string" },
      },
      required: ["phone", "triggerId"],
    },
  },
  {
    name: "create_senior_profile",
    description:
      "Create an ADDITIONAL care recipient (senior) for this family's household. Use when a family says they want to add another parent/relative they care for. " +
      "Do NOT use to edit the existing senior — use update_senior_profile for that. The new profile is linked to the family automatically.",
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
    description: "Post a new caregiver job for the family so nearby caregivers can apply. Collect care needs, schedule, and hourly rate; confirm, then call.",
    input_schema: { type: "object", properties: { clientId: { type: "string", description: "Injected automatically." }, careTypes: { type: "array", items: { type: "string" } }, frequency: { type: "string", description: "e.g. 'weekly', 'one-time'" }, days: { type: "array", items: { type: "string" } }, timeOfDay: { type: "array", items: { type: "string" } }, hourlyRate: { type: "number" }, paymentMethod: { type: "string", description: "'card' (charged through the platform) or an offline method paid directly to the caregiver: 'cash', 'venmo', 'zelle'" }, city: { type: "string" }, startDate: { type: "string", description: "YYYY-MM-DD" } }, required: ["clientId", "careTypes", "hourlyRate"] },
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
    name: "delete_reminder",
    description: "Cancel and delete an active personal reminder. Only call after the user has confirmed they want to remove it.",
    input_schema: {
      type: "object",
      properties: {
        phone:     { type: "string", description: "The user's phone number" },
        triggerId: { type: "string", description: "The Firestore document ID of the user_triggers doc" },
      },
      required: ["phone", "triggerId"],
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
    name: "get_work_in_progress",
    description:
      "One unified view of everything Evia currently has in flight for this user — " +
      "open follow-up promises, active background tasks, pending approvals, presented " +
      "caregiver matches, and to-dos, with overdue items first. Call when the user asks " +
      "'what's happening', 'what are you working on for me', or 'any updates', and " +
      "before making a new promise so you can account for what's already owed.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The user's phone number (auto-injected)" },
      },
      required: [],
    },
  },
  {
    name: "search_web",
    description:
      "Fast web search for information about healthcare providers, pharmacies, " +
      "insurance, or anything else the family or caregiver needs to know. " +
      "Use this BEFORE perform_web_action for any lookup that doesn't require " +
      "navigating a specific website. Returns titles and URLs. " +
      "Examples: 'Dr. Peterson neurologist Atlanta phone number', " +
      "'CVS Peachtree hours', 'does Aetna cover in-home care Atlanta'.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query (1-200 characters)",
        },
        numResults: {
          type: "number",
          description: "Number of results to return (1-10, default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "perform_web_action",
    description:
      "Take a LOGIN-REQUIRED action on a healthcare portal on behalf of the family. " +
      "For public web lookups use the dedicated primitives instead (search_healthcare_provider, fetch_web_page, browse_web), or search_web.\n\n" +
      "Set loginAction to one of:\n" +
      "- 'schedule_appointment': book a doctor appointment on MyChart etc.\n" +
      "- 'pharmacy_refill': request a prescription refill on CVS/Walgreens\n" +
      "- 'insurance_check': check authorization or coverage status\n\n" +
      "If credentials aren't stored yet, Evia will collect them securely via iMessage before proceeding.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What to do, in plain English.",
        },
        loginAction: {
          type: "string",
          enum: ["schedule_appointment", "pharmacy_refill", "insurance_check"],
          description: "For login-required portal actions.",
        },
        userId:          { type: "string", description: "The user's Firestore ID" },
        phone:           { type: "string", description: "The user's phone number" },
        city:            { type: "string", description: "City for location-specific searches" },
        doctorName:      { type: "string", description: "Doctor name for appointment scheduling" },
        specialty:       { type: "string", description: "Doctor specialty" },
        preferredDate:   { type: "string", description: "Preferred date e.g. 'next Tuesday', 'May 20'" },
        appointmentType: { type: "string", description: "e.g. 'follow-up', 'annual physical'" },
        portalService:   { type: "string", description: "Portal to use: mychart, athenahealth, followmyhealth" },
        pharmacyService: {
          type: "string",
          enum: ["cvs", "walgreens", "riteaid"],
          description: "Pharmacy for refill requests",
        },
        medicationName:  { type: "string", description: "Medication name for refill" },
        rxNumber:        { type: "string", description: "Rx number for direct refill lookup" },
        insurer:         { type: "string", description: "Insurance company name e.g. 'Aetna', 'UnitedHealthcare'" },
        checkType: {
          type: "string",
          enum: ["coverage", "authorization", "claim_status"],
          description: "Type of insurance check",
        },
        referenceNumber: { type: "string", description: "Prior auth or claim reference number" },
        seniorName:      { type: "string", description: "Senior's name when account has multiple members" },
      },
      required: ["task", "userId", "loginAction"],
    },
  },
  {
    name: "search_healthcare_provider",
    description: "Public web search for healthcare providers/resources (no login). Use for 'find a cardiologist near me', 'urgent care in <city>'. Prefer search_web for general lookups.",
    input_schema: {
      type: "object",
      properties: {
        query:  { type: "string", description: "What to search for, in plain English." },
        city:   { type: "string", description: "City to scope the search to, if relevant." },
        userId: { type: "string", description: "Injected automatically." },
        phone:  { type: "string", description: "Injected automatically." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_web_page",
    description: "Fetch the content of a specific public URL (no login). Use when you already know the page to read.",
    input_schema: {
      type: "object",
      properties: {
        url:    { type: "string", description: "The URL to fetch." },
        userId: { type: "string", description: "Injected automatically." },
        phone:  { type: "string", description: "Injected automatically." },
      },
      required: ["url"],
    },
  },
  {
    name: "browse_web",
    description: "Run a public AI browser session for complex navigation that needs no login (multi-step lookups on public sites).",
    input_schema: {
      type: "object",
      properties: {
        task:   { type: "string", description: "What to do/find, in plain English." },
        url:    { type: "string", description: "Optional starting URL." },
        userId: { type: "string", description: "Injected automatically." },
        phone:  { type: "string", description: "Injected automatically." },
      },
      required: ["task"],
    },
  },
  {
    name: "manage_credentials",
    description:
      "Manage stored portal login credentials for this user. " +
      "Use when family asks: 'what logins do you have for me', " +
      "'remove my CVS login', 'update my MyChart password', " +
      "'do you have my Walgreens login?'",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "delete", "check"],
          description: "list = show all stored services, delete = remove one, check = verify one exists",
        },
        userId:  { type: "string", description: "The user's Firestore ID" },
        service: { type: "string", description: "Service key e.g. mychart, cvs, walgreens" },
      },
      required: ["action", "userId"],
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
      "Update the care plan for a senior. Use when the family reports a change: new medication, updated dosage, new diagnosis, dietary change, or special instructions. " +
      "Always confirm the change with the family before calling. Tell them what you're updating.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        field:    { type: "string", description: "Which field to update: 'medications', 'careNeeds', 'dietaryNotes', 'doctorContacts', 'specialInstructions', or 'notes'" },
        value:    { description: "The new value. For array fields (medications, careNeeds, doctorContacts), pass an array. For string fields, pass a string." },
        action:   { type: "string", enum: ["set", "append", "remove"], description: "set = replace, append = add to array, remove = remove from array" },
      },
      required: ["clientId", "field", "value", "action"],
    },
  },
  {
    name: "update_caregiver_profile",
    description:
      "Update your own caregiver profile — hourly rate, bio, phone, city, or weekly availability. " +
      "Only you can update your own profile. Changes take effect immediately.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:        { type: "string",  description: "Your caregiver Firestore document ID" },
        hourlyRate:         { type: "number",  description: "Your new hourly rate in dollars" },
        bio:                { type: "string",  description: "Your updated bio (max 2500 characters)" },
        phone:              { type: "string",  description: "Your new phone number" },
        city:               { type: "string",  description: "Your city" },
        weeklyAvailability: { type: "object",  description: "Object mapping day abbreviations to time windows" },
      },
      required: ["caregiverId"],
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
      "collecting). If complete, it hands off to the next setup step (payment / uploads) and you " +
      "should tell the user what's next in your own voice. Call ONLY when you believe collection is done.",
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
    name: "cancel_subscription",
    description:
      "Cancel the family's Evia membership. Cancels at end of billing period — scheduled visits are unaffected. " +
      "MANDATORY: tell the family when their subscription ends and confirm before calling.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
    },
  },
  {
    name: "reactivate_subscription",
    description:
      "Reverse a pending subscription cancellation. Keeps the membership active through the billing period.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
      },
      required: ["clientId"],
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
    name: "update_senior_profile",
    description:
      "Update specific fields on the senior's profile — emergency contact, physician, diagnoses, or allergies. " +
      "Confirm before calling.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's profile document ID" },
        clientId: { type: "string", description: "The client's user ID" },
        field: {
          type: "string",
          enum: ["emergencyContactName","emergencyContactPhone","primaryPhysicianName","primaryPhysicianPhone","diagnoses","allergies"],
          description: "Which field to update",
        },
        value:  { description: "New value. String for contact/physician fields; string for array append/remove." },
        action: { type: "string", enum: ["set","arrayUnion","arrayRemove"], description: "set = replace, arrayUnion = add to array, arrayRemove = remove from array" },
      },
      required: ["seniorId", "clientId", "field", "value", "action"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Move an existing confirmed appointment to a new date and/or time. " +
      "Checks caregiver availability. Confirm with family before calling. " +
      "IMPORTANT — a reschedule is usually NOT immediate. Inspect the returned `status`: " +
      "`pending_caregiver_confirmation` means the visit stays at its ORIGINAL time until the caregiver accepts — " +
      "tell the family you've asked the caregiver to confirm and will follow up, and do NOT say the reschedule is done. " +
      "Only `applied_directly` means the change already took effect.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "Appointment document ID to reschedule" },
        clientId:      { type: "string", description: "The client's user ID" },
        newDate:       { type: "string", description: "New date in YYYY-MM-DD format" },
        newTime:       { type: "string", description: "New start time in HH:MM format" },
      },
      required: ["appointmentId", "clientId", "newDate", "newTime"],
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
      "Accept or reject a caregiver's application to your job post. " +
      "Confirm before accepting — this notifies the caregiver and marks the job filled.",
    input_schema: {
      type: "object",
      properties: {
        applicationId: { type: "string", description: "The job_applications document ID" },
        clientId:      { type: "string", description: "The client's user ID" },
        decision:      { type: "string", enum: ["accept","reject"], description: "accept or reject" },
        message:       { type: "string", description: "Optional message to the caregiver" },
      },
      required: ["applicationId", "clientId", "decision"],
    },
  },
  {
    name: "submit_interview_feedback",
    description:
      "Submit your decision after interviewing a caregiver. " +
      "Options: 'strong' (proceed to hire), 'maybe' (keep considering), 'no' (not a fit).",
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
      "Approve or dispute a caregiver's submitted shift hours. " +
      "If disputing, provide the corrected duration in hours.",
    input_schema: {
      type: "object",
      properties: {
        clientId:       { type: "string", description: "The client's user ID" },
        appointmentId:  { type: "string", description: "The appointment document ID" },
        decision:       { type: "string", enum: ["approve","dispute"], description: "approve or dispute" },
        correctedHours: { type: "number", description: "Corrected duration in hours (required when disputing)" },
        reason:         { type: "string", description: "Reason for dispute" },
      },
      required: ["clientId", "appointmentId", "decision"],
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
      "Only works when the shift hours are in a correction_requested or disputed state.",
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
      "Creates the interview record, generates the Google Meet link (joinable from any phone browser, no account needed), " +
      "and texts the caregiver the link automatically. Returns callUrl — share it with the client in your reply. " +
      "Confirm date/time with client before calling.",
    input_schema: {
      type: "object",
      properties: {
        clientId:      { type: "string", description: "The client's user ID" },
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        applicationId: { type: "string", description: "The job_applications document ID (optional)" },
        preferredDate: { type: "string", description: "Date in YYYY-MM-DD format" },
        preferredTime: { type: "string", description: "Time in HH:MM (24h) format" },
        interviewType: { type: "string", enum: ["video","phone","in_person"], description: "Default: video" },
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
      "List a client's confirmed/active caregivers — their name, phone, rating, and next scheduled visit.",
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
    name: "get_care_plan_history",
    description:
      "Get the revision history of the client's care plan — who changed what and when. Returns up to 10 versions.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of versions to return (default 5, max 10)" },
      },
    },
  },
  {
    name: "restore_care_plan_version",
    description:
      "Restore a previous version of the care plan. Confirm with the client before calling — this replaces the current care plan.",
    input_schema: {
      type: "object",
      properties: {
        versionId: { type: "string", description: "The care-plan version document ID to restore (from get_care_plan_history)" },
        clientId:  { type: "string", description: "The client's user ID (auto-injected from session)" },
      },
      required: ["versionId"],
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
        paymentMethod:{ type: "string", enum: ["card","cash","venmo","zelle"], description: "New payment method — card is charged through the platform; cash/Venmo/Zelle are paid directly to the caregiver" },
      },
      required: ["jobId", "clientId"],
    },
  },
  {
    name: "send_client_message",
    description:
      "Send a message to a client on behalf of a caregiver. Tell the caregiver what you're sending before calling.",
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
        status:   { type: "string", enum: ["open","filled","closed","all"], description: "Filter by status (default: all)" },
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
    name: "update_booking_payment_method",
    description:
      "Switch how an upcoming confirmed booking is paid: credit (charged through Stripe) or an offline " +
      "method the family pays the caregiver directly (cash, venmo, zelle). Only allowed before the " +
      "booking starts. Confirm the new method with the family before calling.",
    input_schema: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "The appointment ID of the confirmed, not-yet-started booking" },
        clientId:      { type: "string", description: "The client's user ID (ownership check)" },
        paymentMethod: {
          type: "string",
          enum: ["credit", "cash", "venmo", "zelle"],
          description: "The new payment method",
        },
      },
      required: ["appointmentId", "clientId", "paymentMethod"],
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
    description: "Update the client's own profile fields (name, phone, address, photoUrl). Confirm changes with the family by reading back the new values before calling. Phone changes re-trigger OTP verification on the new number; tell the family they'll need to verify.",
    input_schema: {
      type: "object",
      properties: {
        userId:    { type: "string", description: "The user's ID" },
        firstName: { type: "string", description: "New first name (optional)" },
        lastName:  { type: "string", description: "New last name (optional)" },
        phone:     { type: "string", description: "New phone number in E.164 format, e.g. +15555550100 (optional)" },
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
    name: "block_user",
    description: "Block another user from messaging or otherwise interacting with this family. MANDATORY: read back who you're about to block and wait for explicit confirmation before calling.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The blocking user's ID (the family)" },
        targetUserId:  { type: "string", description: "The user being blocked" },
        reason:        { type: "string", description: "Optional reason (helps ops triage)" },
      },
      required: ["userId", "targetUserId"],
    },
  },
  {
    name: "unblock_user",
    description: "Remove a block on another user.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The unblocking user's ID" },
        targetUserId:  { type: "string", description: "The user to unblock" },
      },
      required: ["userId", "targetUserId"],
    },
  },
  {
    name: "report_user",
    description: "File a report against another user for abusive behavior. MANDATORY: confirm with the family what the report is about before calling, and tell them ops will follow up within 24 hours.",
    input_schema: {
      type: "object",
      properties: {
        userId:        { type: "string", description: "The reporting user's ID" },
        targetUserId:  { type: "string", description: "The reported user's ID" },
        category:      { type: "string", description: "One of: harassment, scam, safety_concern, inappropriate_content, other" },
        description:   { type: "string", description: "Short description of what happened" },
      },
      required: ["userId", "targetUserId", "category", "description"],
    },
  },
  // ── Care journal engagement ───────────────────────────────────────────────
  {
    name: "like_journal_entry",
    description: "Like a care journal entry the caregiver posted. Use when the family says something like 'tell Maria I love that photo'.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The user liking the entry" },
        entryId: { type: "string", description: "The care_journal entry ID" },
      },
      required: ["userId", "entryId"],
    },
  },
  {
    name: "unlike_journal_entry",
    description: "Remove a like from a care journal entry.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The user removing the like" },
        entryId: { type: "string", description: "The care_journal entry ID" },
      },
      required: ["userId", "entryId"],
    },
  },
  {
    name: "comment_on_journal_entry",
    description: "Add a comment to a care journal entry. The caregiver will see the comment. Use when a family says 'tell Maria thanks for the visit notes' or 'reply that the puzzle was a great idea'.",
    input_schema: {
      type: "object",
      properties: {
        userId:  { type: "string", description: "The user commenting" },
        entryId: { type: "string", description: "The care_journal entry ID" },
        comment: { type: "string", description: "The comment text" },
      },
      required: ["userId", "entryId", "comment"],
    },
  },
  {
    name: "delete_comment",
    description: "Delete a comment the user previously left on a care journal entry. Use when the family says 'delete my last comment' or 'remove what I said on that entry'. Only the comment's author can delete it.",
    input_schema: {
      type: "object",
      properties: {
        userId:    { type: "string", description: "The user who left the comment" },
        entryId:   { type: "string", description: "The care_journal entry ID" },
        commentId: { type: "string", description: "The comment ID to delete" },
      },
      required: ["userId", "entryId", "commentId"],
    },
  },
  {
    name: "edit_comment",
    description: "Edit the text of a comment the user previously left on a care journal entry. Use when the family says 'fix my comment to say …'. Only the comment's author can edit it.",
    input_schema: {
      type: "object",
      properties: {
        userId:    { type: "string", description: "The user who left the comment" },
        entryId:   { type: "string", description: "The care_journal entry ID" },
        commentId: { type: "string", description: "The comment ID to edit" },
        comment:   { type: "string", description: "The new comment text" },
      },
      required: ["userId", "entryId", "commentId", "comment"],
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
      "List the users this family has blocked (the block_user list), with names where available. " +
      "Use before block_user/unblock_user or when they ask 'who have I blocked?'.",
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
  {
    name: "confirm_cash_received",
    description:
      "Caregiver confirms they received an offline payment (cash, Venmo, or Zelle) for an approved shift. Marks the " +
      "shift-hours record paid. Only works for offline-payment shifts whose hours are already approved. Confirm the " +
      "shift with the caregiver before calling.",
    input_schema: {
      type: "object",
      properties: {
        caregiverId:   { type: "string", description: "The caregiver's Firestore document ID" },
        appointmentId: { type: "string", description: "The appointment/shiftHours document ID the payment was for" },
      },
      required: ["caregiverId", "appointmentId"],
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
  "log_health_flag",
  "read_memory_file",
  "update_memory_file",
  "edit_memory_file",
  "search_memory",
  "search_web",
  "perform_web_action",
  "list_user_reminders",
  "create_reminder",
  "delete_reminder",
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
  "request_shift_swap",
  "accept_shift_swap",
  "cancel_shift_swap",
  "get_job_recommendations",
  "submit_gps_checkin",
  "get_tax_summary",
  "send_onboarding_link",
  "get_caregiver_reviews",
  "get_background_check_status",
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
  "update_reminder",
  "update_care_journal_entry",
  // CRUD/parity gap closures (agent-native audit 2026-07)
  "list_interviews",
  "cancel_interview",
  "list_shift_swaps",
  "confirm_cash_received",
  // Unified work-in-progress view (agentic-reliability wave 2026-07)
  "get_work_in_progress",
  // Outbound iMessage tapbacks (Linq reactions, 2026-07) — shared with clients
  "react_to_message",
  // Checkr Candidate MCP bridge (2026-07-09) — full report details, OTP-gated
  "request_checkr_verification",
  "verify_checkr_otp",
  "get_checkr_report",
]);
export const CAREGIVER_TOOLS: McpTool[] = MCP_TOOLS.filter(t => CAREGIVER_TOOL_NAMES.has(t.name));

// Tools that exist ONLY for the caregiver role. Excluded from client turns so the
// client surface stays under OpenAI's 128-tool hard cap (otherwise capToolsForOpenAi
// drops an arbitrary tail — which silently hid block_user/report_user and the 2026-07
// CRUD tools from clients). Shared tools (memory, web, reminders, messaging reads,
// send_onboarding_link, get_caregiver_info/reviews) stay client-visible.
const CAREGIVER_ONLY_TOOL_NAMES = new Set([
  "get_caregiver_appointments",
  "update_caregiver_profile",
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
  "confirm_cash_received",
  "list_shift_swaps",
  // Checkr Candidate MCP bridge (2026-07-09) — a caregiver's own report only
  "request_checkr_verification",
  "verify_checkr_otp",
  "get_checkr_report",
]);
export const CLIENT_TOOLS: McpTool[] = MCP_TOOLS.filter(t => !CAREGIVER_ONLY_TOOL_NAMES.has(t.name));

export async function handleToolCallForCaregiver(
  name: string,
  input: Record<string, unknown>,
  shadowMode = false,
): Promise<unknown> {
  if (name === "perform_web_action" && input.loginAction) {
    return { _toolError: true, message: "Login-required web actions are not available for caregivers." };
  }
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
    const snap     = await db.collection("seniors").doc(seniorId).get();
    if (!snap.exists) return null;
    return { uri, mimeType: "application/json", text: JSON.stringify(snap.data()) };
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
function toolError(code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "UNAVAILABLE" | "CONFLICT" | "FORBIDDEN", message: string) {
  return { _toolError: true, success: false, code, message };
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
  // find_replacement_caregivers was WRONGLY on this list (double-send audit
  // 2026-07-06): it texts the family (match gallery / status), writes
  // interview_requests + agent_sessions + admin_alerts, and resolves
  // commitments — a shadow run was sending real SMS. It is mutating; it must
  // be synthesized under shadow like every other side-effecting tool.
  "get_caregiver_reviews", "list_saved_caregivers",
  "get_recurring_schedule", "list_user_reminders",
  "get_billing_summary", "get_invoice_history", "get_invoice_details",
  "get_payout_history", "get_caregiver_earnings", "get_pending_timesheets", "get_tax_summary",
  "get_care_journal", "get_care_journal_client", "get_care_plan", "get_care_plan_history",
  "get_health_signals", "get_recent_messages", "get_family_group",
  "read_memory_file", "search_memory", "search_web",
  "list_client_jobs", "list_job_applicants", "browse_job_board",
  "get_job_recommendations", "get_my_applications", "get_background_check_status",
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
  // Runtime-enforced confirmation gate. High-risk tool calls (cancel_appointment,
  // remove_family_member, cancel_subscription, etc.) are intercepted on the
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
        // Read from senior_profiles — the collection assertSeniorAccess authorized
        // against — so a migrated household senior (random-id profile doc with no
        // matching `seniors` doc) doesn't return a false NOT_FOUND. Fall back to
        // the legacy `seniors` collection only when no profile doc exists.
        const profileSnap = await db.collection("senior_profiles").doc(input.seniorId as string).get();
        const snap = profileSnap.exists
          ? profileSnap
          : await db.collection("seniors").doc(input.seniorId as string).get();
        if (!snap.exists) return toolError("NOT_FOUND", "Senior profile not found");
        const data = snap.data()!;
        return { success: true, results: data, hasMore: false };
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
        const snap = await db
          .collection("appointments")
          .where("clientId", "==", input.clientId)
          .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
          .where("date", ">=", today)
          .orderBy("date", "asc")
          .limit(6)
          .get();
        const docs = snap.docs.slice(0, 5).map((d) => d.data());
        return { success: true, results: docs, hasMore: snap.docs.length > 5 };
      }

      case "get_caregiver_info": {
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.caregiverId as string, data: { source: "mcp:get_caregiver_info" } }).catch(() => {});
        const snap = await db.collection("caregivers").doc(input.caregiverId as string).get();
        if (!snap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        const d = snap.data()!;
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
          },
        };
      }

      case "get_caregiver_reviews": {
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.caregiverId as string, data: { source: "mcp:get_caregiver_reviews" } }).catch(() => {});
        const limit = Math.min((input.limit as number) ?? 5, 20);
        const snap = await db
          .collection("reviews")
          .where("caregiverId", "==", input.caregiverId as string)
          .orderBy("createdAt", "desc")
          .limit(limit + 1)
          .get();
        const docs = snap.docs.slice(0, limit).map((d) => {
          const r = d.data();
          return { rating: r.rating, comment: r.comment ?? "", createdAt: r.createdAt };
        });
        const cgSnap = await db.collection("caregivers").doc(input.caregiverId as string).get();
        const cg = cgSnap.data() ?? {};
        const averageRating = typeof cg.averageRating === "number"
          ? cg.averageRating
          : (docs.length ? docs.reduce((s, r) => s + (r.rating ?? 0), 0) / docs.length : null);
        return {
          success: true,
          caregiverName: cg.name ?? "the caregiver",
          averageRating,
          totalReviews:  cg.reviewCount ?? docs.length,
          recentReviews: docs,
          hasMore: snap.docs.length > limit,
        };
      }

      case "get_health_signals": {
        if (!input.seniorId) return toolError("INVALID_INPUT", "seniorId is required");
        const denied = await assertSeniorAccess(input.seniorId as string, input.clientId ?? input.userId);
        if (denied) return denied;
        logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_health_signals").catch(() => {});
        const snap = await db
          .collection("health_signals")
          .where("seniorId", "==", input.seniorId)
          .where("detectedAt", ">=", daysAgo)
          .orderBy("detectedAt", "desc")
          .limit(21)
          .get();
        const docs = snap.docs.slice(0, 20).map((d) => d.data());
        return { success: true, results: docs, hasMore: snap.docs.length > 20, daysBack };
      }

      case "get_billing_summary": {
        if (!input.userId) return toolError("INVALID_INPUT", "userId is required");
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:get_billing_summary" } }).catch(() => {});
        const userId = input.userId as string;
        const [subSnap, invoiceSnap, paymentsSnap, userSnap] = await Promise.all([
          db.collection("subscriptions").doc(userId).get(),
          db.collection("invoices")
            .where("userId", "==", userId)
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
          subscription: subSnap.data() ?? null,
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
        const matchIntake: Record<string, unknown> = { ...session };
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
          return {
            success: true,
            outcome: "no_match",
            matchesFound: 0,
            teamAlerted: true,
            instruction:
              "No caregivers matched right now. NOTHING has been texted to the family — your reply is the " +
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
        const { clientId, caregiverId, dates, startTime, endTime, phone } = input;
        // Session-injected ownership fields are checked here; the booking shape
        // (caregiverId/dates/times) + caregiver lookup are validated by the shared
        // quote primitive below, so the two paths can never diverge.
        if (!clientId) return toolError("INVALID_INPUT", "clientId is required (auto-injected from session)");
        if (!phone)    return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");

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
        return { success: true, taskId, status: "awaiting_approval", estimatedTotal: quote.totalEstimate };
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
          appointmentId, clientId, amount: appt.amount ?? 0, reason: refundReason, status: "pending", createdAt: nowIso, source: "cara",
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

      case "log_health_flag": {
        if (!input.seniorId || !input.signalType) return toolError("INVALID_INPUT", "seniorId and signalType are required");
        logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:log_health_flag").catch(() => {});
        await db.collection("health_signals").add({
          seniorId:    input.seniorId,
          signalType:  input.signalType,
          description: input.description ?? "",
          severity:    "flag",
          source:      "family_report",
          detectedAt:  nowIso,
        });
        return { success: true, logged: true };
      }

      case "read_memory_file": {
        if (!input.userId || !input.file) return toolError("INVALID_INPUT", "userId and file are required");
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
        logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:edit_memory_file", file: input.file } }).catch(() => {});
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

      case "cancel_appointment": {
        const { appointmentId, clientId, reason } = input;
        if (!appointmentId || !clientId) return toolError("INVALID_INPUT", "appointmentId and clientId are required");
        const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
        if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
        const appt = apptSnap.data()!;
        if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
        if (["cancelled_by_client", "cancelled"].includes(appt.status)) {
          return toolError("INVALID_INPUT", "Appointment is already cancelled");
        }
        await apptSnap.ref.update({
          status:           "cancelled_by_client",
          cancelledAt:      nowIso,
          cancelledReason:  reason ?? "client_request",
        });
        // Notify caregiver — surface success/failure so Evia doesn't claim
        // the caregiver was reached when the message never went out.
        let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
        if (appt.caregiverId) {
          const cgSnap  = await db.collection("caregivers").doc(appt.caregiverId as string).get();
          const cgPhone = cgSnap.data()?.phone as string | undefined;
          if (cgPhone) {
            const { trySend } = await import("../utils/toolNotify");
            notification = await trySend(cgPhone,
              `The family has cancelled the visit on ${appt.date ?? ""}. Sorry for the inconvenience.`,
              "mcp:cancel_appointment",
            );
          }
        }
        logAudit({ eventType: "health_data_accessed", userId: clientId as string, data: { source: "mcp:cancel_appointment", appointmentId, notificationSent: notification.sent } }).catch(() => {});
        return { success: true, cancelled: true, appointmentId, date: appt.date, caregiverName: appt.caregiverName, notification };
      }

      case "send_caregiver_message": {
        const { caregiverId, message, clientId } = input;
        if (!caregiverId || !message) return toolError("INVALID_INPUT", "caregiverId and message are required");
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "Caregiver not found");
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (!cgPhone) return toolError("NOT_FOUND", "Caregiver phone not on file");
        const { trySend } = await import("../utils/toolNotify");
        const notification = await trySend(cgPhone, `Message from family: ${message as string}`, "mcp:send_caregiver_message");
        logAudit({ eventType: "health_data_accessed", userId: clientId as string ?? "", data: { source: "mcp:send_caregiver_message", caregiverId, notificationSent: notification.sent } }).catch(() => {});
        return { success: true, sent: notification.sent, caregiverName: cgSnap.data()?.name ?? "", notification };
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

      case "list_user_reminders": {
        if (!input.phone) return toolError("INVALID_INPUT", "phone is required");
        const snap = await db.collection("user_triggers")
          .where("phone",  "==", input.phone)
          .where("active", "==", true)
          .get();
        const reminders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return { success: true, reminders, count: reminders.length };
      }

      case "create_reminder": {
        const { phone, userId, label, recurrence, hour, minute, message: msg, dayOfWeek } = input;
        if (!phone || !userId || !label || !recurrence || hour == null || minute == null || !msg) {
          return toolError("INVALID_INPUT", "phone, userId, label, recurrence, hour, minute, message are required");
        }
        const { createUserTrigger } = await import("../triggers/userTriggerManager");
        const triggerId = await createUserTrigger(phone as string, userId as string, {
          label:      label      as string,
          recurrence: recurrence as "daily" | "weekly" | "monthly" | "once",
          dayOfWeek:  dayOfWeek  as number | undefined,
          hour:       hour       as number,
          minute:     minute     as number,
          message:    msg        as string,
        });
        return { success: true, triggerId, label };
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

      case "delete_reminder": {
        const { phone, triggerId } = input;
        if (!phone || !triggerId) return toolError("INVALID_INPUT", "phone and triggerId are required");
        const { deleteUserTrigger } = await import("../triggers/userTriggerManager");
        const deleted = await deleteUserTrigger(phone as string, triggerId as string);
        if (!deleted) return toolError("NOT_FOUND", "Reminder not found or does not belong to this user");
        return { success: true, deleted: true };
      }

      case "update_reminder": {
        const { phone, triggerId, label, recurrence, dayOfWeek, hour, minute, message: msg } = input;
        if (!phone || !triggerId) return toolError("INVALID_INPUT", "phone and triggerId are required");
        const patch: Record<string, unknown> = {};
        if (label      !== undefined) patch.label      = label;
        if (recurrence !== undefined) patch.recurrence = recurrence;
        if (dayOfWeek  !== undefined) patch.dayOfWeek  = dayOfWeek;
        if (hour       !== undefined) patch.hour       = hour;
        if (minute     !== undefined) patch.minute     = minute;
        if (msg        !== undefined) patch.message    = msg;
        if (Object.keys(patch).length === 0) return toolError("INVALID_INPUT", "provide at least one field to update");
        const { updateUserTrigger } = await import("../triggers/userTriggerManager");
        const updated = await updateUserTrigger(phone as string, triggerId as string, patch);
        if (!updated) return toolError("NOT_FOUND", "Reminder not found or does not belong to this user");
        return { success: true, updated: true, triggerId };
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

      case "get_work_in_progress": {
        const phoneW = (input.phone as string | undefined) ?? "";
        if (!phoneW) return toolError("INVALID_INPUT", "phone is required");
        const nowIso = new Date().toISOString();
        const ageHrs = (iso?: string) => {
          const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
          return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 3_600_000)) : null;
        };

        const [qaCommit, matchCommit, activeTaskSnap, taskSnap2, sessionSnap2] = await Promise.all([
          db.collection("pending_commitments").doc(`${phoneW}_qa_answer`).get(),
          db.collection("pending_commitments").doc(`${phoneW}_matching`).get(),
          db.collection("agent_tasks_active").doc(phoneW).get(),
          db.collection("agent_tasks")
            .where("clientPhone", "==", phoneW)
            .where("status", "in", ["pending", "awaiting_approval", "pending_bg_clear"])
            .limit(10)
            .get(),
          db.collection("agent_sessions").doc(phoneW).get(),
        ]);

        interface WipItem {
          kind: string; summary: string;
          dueAt: string | null; ageHours: number | null; overdue: boolean;
        }
        const items: WipItem[] = [];

        for (const snap of [qaCommit, matchCommit]) {
          if (!snap.exists || snap.data()?.status !== "open") continue;
          const c = snap.data()!;
          items.push({
            kind:     "promise",
            summary:  `Follow-up owed: ${String(c.promiseText ?? "").slice(0, 140)}`,
            dueAt:    (c.dueAt as string | undefined) ?? null,
            ageHours: ageHrs(c.createdAt as string | undefined),
            overdue:  ((c.dueAt as string | undefined) ?? "") < nowIso,
          });
        }
        if (activeTaskSnap.exists) {
          const t = activeTaskSnap.data()!;
          items.push({
            kind:     "background_task",
            summary:  String(t.description ?? t.statusText ?? t.type ?? "background task in progress").slice(0, 140),
            dueAt:    null,
            ageHours: ageHrs((t.startedAt ?? t.createdAt) as string | undefined),
            overdue:  false,
          });
        }
        for (const d of taskSnap2.docs) {
          const t = d.data();
          items.push({
            kind:     "pending_task",
            summary:  `${String(t.type ?? "task")} — ${String(t.status ?? "pending")}`.slice(0, 140),
            dueAt:    (t.expiresAt as string | undefined) ?? null,
            ageHours: ageHrs(t.createdAt as string | undefined),
            overdue:  !!(t.expiresAt && (t.expiresAt as string) < nowIso),
          });
        }
        const sess = sessionSnap2.data() ?? {};
        const todos = Array.isArray(sess.todos) ? sess.todos : [];
        for (const t of todos as Array<Record<string, unknown>>) {
          if (t?.status === "completed") continue;
          const label = String(t?.content ?? t?.text ?? t?.task ?? "").slice(0, 140);
          if (!label) continue;
          items.push({ kind: "todo", summary: label, dueAt: null, ageHours: null, overdue: false });
        }
        const matches = Array.isArray(sess.pendingMatches) ? sess.pendingMatches : [];
        if (matches.length > 0) {
          const names = (matches as Array<Record<string, unknown>>)
            .map((m) => String(m?.name ?? "")).filter(Boolean).slice(0, 5);
          items.push({
            kind:     "matches_presented",
            summary:  `Caregiver matches awaiting your pick: ${names.join(", ")}`,
            dueAt:    null,
            ageHours: ageHrs(sess.pendingMatchesSetAt as string | undefined),
            overdue:  false,
          });
        }

        // Overdue first, then nearest due date, then oldest.
        items.sort((a, b) =>
          Number(b.overdue) - Number(a.overdue) ||
          (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") ||
          (b.ageHours ?? -1) - (a.ageHours ?? -1)
        );

        return {
          success: true,
          total:   items.length,
          items,
          summary: items.length === 0
            ? "Nothing in flight — no open promises, tasks, or pending decisions."
            : `${items.length} item(s) in flight${items.some(i => i.overdue) ? ", including overdue follow-ups — address those first" : ""}.`,
        };
      }

      case "search_web": {
        const { searchWeb } = await import("../browser/browserbaseClient");
        const results = await searchWeb(
          input.query as string,
          (input.numResults as number | undefined) ?? 5
        );
        return { results };
      }

      case "perform_web_action": {
        // Login-required healthcare-portal actions only. Public web reads were
        // decomposed into search_healthcare_provider / fetch_web_page / browse_web (U9).
        const {
          findAppointmentSlots,
          bookAppointmentSlot,
          requestPharmacyRefill,
          checkInsuranceAuthorization,
        } = await import("../browser/careWebActions");
        const { startCredentialCollection } = await import("../browser/credentialCollector");

        const task        = input.task        as string;
        const loginAction = input.loginAction as "schedule_appointment" | "pharmacy_refill" | "insurance_check" | undefined;
        const userId2     = input.userId      as string;
        const phone2      = (input.phone      as string | undefined) ?? "unknown";

        try {
          // ── Login-required portal actions ──────────────────────────────────
          if (loginAction) {
            // H-U9: ship DARK behind the flag. Flag-off → coming-soon; nothing is
            // proposed or committed until the pre-launch gate closes.
            const { realWorldHealthcareActionsEnabled } = await import("../config/featureFlags");
            if (!realWorldHealthcareActionsEnabled()) {
              return {
                status: "coming_soon",
                message: "I can look up info and find the right links for you — taking action directly on your healthcare portals is coming soon.",
              };
            }
            // H-U7: the credential vault is userId-keyed — fail CLOSED if there's
            // no resolvable account, rather than silently missing the credential.
            if (!userId2 || userId2 === "unknown") {
              return toolError("PERMISSION_DENIED",
                "I can only do this on a registered account. Please make sure you're signed up, then try again.");
            }
            switch (loginAction) {
              case "schedule_appointment": {
                const portalSvc = (input.portalService as string | undefined ?? "mychart") as import("../browser/credentialVault").PortalService;
                const chosenSlot = input.chosenSlot as { provider: string; datetime: string; location?: string } | undefined;

                // PASS 2 (H-U3): commit the APPROVED slot. Reached only on the
                // confirmed re-run, which carries chosenSlot — the gate (keyed on
                // chosenSlot) already round-tripped the family's approval.
                if (chosenSlot) {
                  return await bookAppointmentSlot({
                    userId: userId2, phone: phone2, chosenSlot, portalService: portalSvc,
                  });
                }

                // PASS 1 (H-U3): read-only discovery (ungated). Returns a concrete
                // slot for the agent to propose; nothing is committed here.
                const found = await findAppointmentSlots({
                  userId:        userId2,
                  phone:         phone2,
                  doctorName:    input.doctorName    as string ?? task,
                  specialty:     input.specialty     as string | undefined,
                  preferredDate: input.preferredDate as string | undefined,
                  portalService: portalSvc,
                });
                if (found.needsCredentials) {
                  await startCredentialCollection({
                    phone:   phone2,
                    userId:  userId2,
                    service: portalSvc,
                    reason:  `schedule an appointment with ${input.doctorName ?? "your doctor"}`,
                  });
                  return { status: "collecting_credentials" };
                }
                return found;
              }

              case "pharmacy_refill": {
                const pharmSvc = (input.pharmacyService as "cvs" | "walgreens" | "riteaid" | undefined) ?? "cvs";
                const result = await requestPharmacyRefill({
                  userId:          userId2,
                  phone:           phone2,
                  pharmacyService: pharmSvc,
                  medicationName:  input.medicationName as string | undefined,
                  rxNumber:        input.rxNumber       as string | undefined,
                  seniorName:      input.seniorName     as string | undefined,
                });
                if (result.needsCredentials) {
                  await startCredentialCollection({
                    phone:   phone2,
                    userId:  userId2,
                    service: pharmSvc as import("../browser/credentialVault").PortalService,
                    reason:  "request a prescription refill",
                  });
                  return { status: "collecting_credentials" };
                }
                return result;
              }

              case "insurance_check": {
                const insurer = input.insurer as string ?? task;
                const { insurerToServiceKey } = await import("../browser/credentialVault");
                const result = await checkInsuranceAuthorization({
                  userId:              userId2,
                  phone:               phone2,
                  insurer,
                  checkType:           (input.checkType as "coverage" | "authorization" | "claim_status" | undefined) ?? "coverage",
                  serviceDescription:  input.task       as string | undefined,
                  referenceNumber:     input.referenceNumber as string | undefined,
                  seniorName:          input.seniorName  as string | undefined,
                });
                if (result.needsCredentials) {
                  await startCredentialCollection({
                    phone:   phone2,
                    userId:  userId2,
                    service: insurerToServiceKey(insurer),
                    reason:  `check your ${insurer} insurance`,
                  });
                  return { status: "collecting_credentials" };
                }
                return result;
              }
            }
          }

          // No loginAction → this tool is login-only now; public reads moved out.
          return toolError("INVALID_INPUT", "loginAction is required. For public web reads use search_healthcare_provider, fetch_web_page, or browse_web.");
        } catch (webErr) {
          console.error("[perform_web_action] error:", webErr);
          return { error: true, message: "I ran into a problem with that web action. Let me find the link for you instead." };
        }
      }

      // ── Public web primitives (U9 — decomposed from perform_web_action) ──────
      case "search_healthcare_provider": {
        const { searchHealthcareProvider } = await import("../browser/careWebActions");
        const userIdW = (input.userId as string | undefined) ?? "unknown";
        const phoneW  = (input.phone  as string | undefined) ?? "unknown";
        const query   = input.query as string | undefined;
        if (!query) return toolError("INVALID_INPUT", "query is required");
        try {
          const result = await searchHealthcareProvider({ userId: userIdW, phone: phoneW, query, city: input.city as string | undefined });
          return { found: result.found, summary: result.summary, results: result.results.slice(0, 3) };
        } catch (e) {
          console.error("[search_healthcare_provider] error:", e);
          return { error: true, message: "I couldn't run that search just now." };
        }
      }

      case "fetch_web_page": {
        const { fetchHealthcarePage } = await import("../browser/careWebActions");
        const userIdW = (input.userId as string | undefined) ?? "unknown";
        const phoneW  = (input.phone  as string | undefined) ?? "unknown";
        const url     = input.url as string | undefined;
        if (!url) return toolError("INVALID_INPUT", "url is required");
        try {
          const result = await fetchHealthcarePage({ userId: userIdW, phone: phoneW, url });
          return { statusCode: result.statusCode, content: result.content.slice(0, 1500) };
        } catch (e) {
          console.error("[fetch_web_page] error:", e);
          return { error: true, message: "I couldn't fetch that page just now." };
        }
      }

      case "browse_web": {
        const { performBrowserAction } = await import("../browser/careWebActions");
        const userIdW = (input.userId as string | undefined) ?? "unknown";
        const phoneW  = (input.phone  as string | undefined) ?? "unknown";
        const task    = input.task as string | undefined;
        if (!task) return toolError("INVALID_INPUT", "task is required");
        try {
          const result = await performBrowserAction({ userId: userIdW, phone: phoneW, task, url: input.url as string | undefined, requiresLogin: false });
          return { success: result.success, result: result.result, sessionId: result.sessionId };
        } catch (e) {
          console.error("[browse_web] error:", e);
          return { error: true, message: "I ran into a problem browsing for that." };
        }
      }

      case "manage_credentials": {
        const {
          listCredentials,
          deleteCredential,
          hasCredential,
        } = await import("../browser/credentialVault");

        const credUserId = input.userId  as string;
        const service    = input.service as import("../browser/credentialVault").PortalService | undefined;

        switch (input.action as string) {
          case "list": {
            const creds = await listCredentials(credUserId);
            return { credentials: creds, count: creds.length };
          }
          case "delete": {
            if (!service) return toolError("INVALID_INPUT", "service is required for delete");
            await deleteCredential(credUserId, service);
            return { deleted: true, service };
          }
          case "check": {
            if (!service) return toolError("INVALID_INPUT", "service is required for check");
            const exists = await hasCredential(credUserId, service);
            return { exists, service };
          }
          default:
            return toolError("INVALID_INPUT", `Unknown credentials action: ${input.action}`);
        }
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
      const snap = await db.collection("care_plans").doc(clientId).get();
      if (!snap.exists) return { success: true, carePlan: null, message: "No care plan on file yet." };
      return { success: true, carePlan: snap.data() };
    }

    if (name === "update_care_plan") {
      const { clientId, field, value, action } = input as {
        clientId: string; field: string; value: unknown; action: "set" | "append" | "remove";
      };
      const ALLOWED_FIELDS = ["medications", "careNeeds", "dietaryNotes", "doctorContacts", "specialInstructions", "notes"];
      if (!ALLOWED_FIELDS.includes(field)) {
        return { success: false, error: `Field '${field}' is not updatable. Allowed: ${ALLOWED_FIELDS.join(", ")}` };
      }
      const ref = db.collection("care_plans").doc(clientId);
      if (action === "append") {
        await ref.set({ [field]: admin.firestore.FieldValue.arrayUnion(value) }, { merge: true });
      } else if (action === "remove") {
        await ref.set({ [field]: admin.firestore.FieldValue.arrayRemove(value) }, { merge: true });
      } else {
        await ref.set({ [field]: value, updatedAt: new Date().toISOString() }, { merge: true });
      }
      return { success: true, updated: field, action };
    }

    // ── New write tools ────────────────────────────────────────────────────────

    if (name === "update_caregiver_profile") {
      const { caregiverId, hourlyRate, bio, phone: cgPhone, city, weeklyAvailability } = input as Record<string, unknown>;
      if (!caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
      if (bio && typeof bio === "string" && bio.length > 2500) return toolError("INVALID_INPUT", "bio must be 2500 characters or fewer");
      const patch: Record<string, unknown> = { updatedAt: nowIso };
      if (hourlyRate         != null) patch.hourlyRate         = hourlyRate;
      if (bio                != null) patch.bio                = bio;
      if (cgPhone            != null) patch.phone              = cgPhone;
      if (city               != null) patch.city               = city;
      if (weeklyAvailability != null) patch.weeklyAvailability = weeklyAvailability;
      if (Object.keys(patch).length === 1) return toolError("INVALID_INPUT", "At least one field to update is required");
      await db.collection("caregivers").doc(caregiverId as string).set(patch, { merge: true });
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
      if (res.status === "no_pending_offer") return { success: false, reason: "no_pending_offer", message: "There's no pending shift offer to act on right now." };
      if (res.status === "not_pending" || res.status === "already_closed") return { success: false, reason: res.status, message: "That offer is no longer open." };
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

    if (name === "cancel_subscription") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const subsSnap = await db.collection("customers").doc(clientId as string).collection("subscriptions").where("status", "in", ["active", "trialing"]).limit(1).get();
      if (subsSnap.empty) return toolError("NOT_FOUND", "No active subscription found");
      const subDoc  = subsSnap.docs[0];
      const subData = subDoc.data();
      if (subData.cancel_at_period_end === true) {
        const periodEnd = (subData.current_period_end as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? null;
        return { success: true, alreadyCancelling: true, periodEnd };
      }
      const { getStripeClient } = await import("../stripe");
      await getStripeClient().subscriptions.update(subDoc.id, { cancel_at_period_end: true });
      await db.collection("users").doc(clientId as string).set({ subscriptionStatus: "canceling" }, { merge: true });
      const periodEnd = (subData.current_period_end as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? null;
      logAudit({ eventType: "subscription_cancelled", userId: clientId as string, data: { source: "mcp:cancel_subscription", subId: subDoc.id, periodEnd } }).catch(() => {});
      return { success: true, cancelled: true, periodEnd, subId: subDoc.id };
    }

    if (name === "reactivate_subscription") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const subsSnap = await db.collection("customers").doc(clientId as string).collection("subscriptions").where("status", "in", ["active", "trialing"]).limit(1).get();
      if (subsSnap.empty) return toolError("NOT_FOUND", "No subscription found to reactivate");
      const subDoc  = subsSnap.docs[0];
      const subData = subDoc.data();
      if (subData.cancel_at_period_end !== true) return toolError("INVALID_INPUT", "Subscription is not set to cancel — nothing to reactivate");
      const { getStripeClient } = await import("../stripe");
      await getStripeClient().subscriptions.update(subDoc.id, { cancel_at_period_end: false });
      await db.collection("users").doc(clientId as string).set({ subscriptionStatus: "active" }, { merge: true });
      const periodEnd = (subData.current_period_end as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? null;
      logAudit({ eventType: "subscription_reactivated", userId: clientId as string, data: { source: "mcp:reactivate_subscription", subId: subDoc.id } }).catch(() => {});
      return { success: true, reactivated: true, periodEnd };
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
        const futureSnap = await db.collection("appointments").where("recurringScheduleId", "==", scheduleId).where("date", ">", today).where("status", "in", ["confirmed"]).get();
        const batch = db.batch();
        batch.update(schedSnap.ref, { status: "cancelled", cancelledAt: nowIso });
        for (const doc of futureSnap.docs) batch.update(doc.ref, { status: "cancelled_by_client", cancelledAt: nowIso });
        await batch.commit();
        logAudit({ eventType: "recurring_schedule_updated", userId: clientId as string, data: { action: "cancel", scheduleId, futureVisitsRemoved: futureSnap.size } }).catch(() => {});
        return { success: true, action: "cancelled", futureVisitsRemoved: futureSnap.size };
      }
      return toolError("INVALID_INPUT", `Unknown action '${action}'. Must be pause, resume, or cancel`);
    }

    if (name === "update_senior_profile") {
      const { seniorId, clientId, field, value, action } = input as Record<string, unknown>;
      if (!seniorId || !clientId || !field || value == null || !action) return toolError("INVALID_INPUT", "seniorId, clientId, field, value, and action are required");
      const ALLOWED = new Set(["emergencyContactName","emergencyContactPhone","primaryPhysicianName","primaryPhysicianPhone","diagnoses","allergies"]);
      const ARRAY_F = new Set(["diagnoses","allergies"]);
      if (!ALLOWED.has(field as string)) return toolError("INVALID_INPUT", `Field '${field}' is not updatable. Allowed: ${[...ALLOWED].join(", ")}`);
      if (!ARRAY_F.has(field as string) && (action === "arrayUnion" || action === "arrayRemove")) return toolError("INVALID_INPUT", `Field '${field}' is scalar — use action 'set'`);
      const seniorSnap = await db.collection("senior_profiles").doc(seniorId as string).get();
      if (!seniorSnap.exists) return toolError("NOT_FOUND", "Senior profile not found");
      const sd = seniorSnap.data()!;
      if (sd.userId && sd.userId !== clientId) return toolError("PERMISSION_DENIED", "Not authorized to update this senior's profile");
      const upd: Record<string, unknown> = { updatedAt: nowIso };
      if (action === "arrayUnion")       upd[field as string] = admin.firestore.FieldValue.arrayUnion(value);
      else if (action === "arrayRemove") upd[field as string] = admin.firestore.FieldValue.arrayRemove(value);
      else                               upd[field as string] = value;
      await seniorSnap.ref.set(upd, { merge: true });
      logAudit({ eventType: "senior_profile_updated", userId: clientId as string, data: { source: "mcp:update_senior_profile", seniorId, field, action } }).catch(() => {});
      return { success: true, updated: field, action };
    }

    if (name === "reschedule_appointment") {
      const { appointmentId, clientId, newDate, newTime } = input as Record<string, unknown>;
      if (!appointmentId || !clientId || !newDate || !newTime) return toolError("INVALID_INPUT", "appointmentId, clientId, newDate, and newTime are required");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
      if (["cancelled","cancelled_by_client","completed"].includes(appt.status as string)) return toolError("INVALID_INPUT", `Cannot reschedule an appointment with status '${appt.status}'`);
      const conflictSnap = await db.collection("appointments").where("caregiverId", "==", appt.caregiverId).where("date", "==", newDate).where("status", "in", ["confirmed","in-progress","pending_caregiver_confirmation"]).get();
      if (conflictSnap.docs.some(d => d.id !== appointmentId)) return toolError("CONFLICT", "The caregiver is not available at that date and time");
      const durationHours = (appt.durationHours as number) ?? 2;
      const [h, m] = (newTime as string).split(":").map(Number);
      const totalMins = h * 60 + m + durationHours * 60;
      const newEndTime = `${String(Math.floor(totalMins / 60) % 24).padStart(2,"0")}:${String(totalMins % 60).padStart(2,"0")}`;
      // The appointment does NOT move until the caregiver accepts the shift
      // offer — requestShiftTimeChange stamps pendingTimeChange and texts them
      // a YES/NO offer (shiftOffer.ts applies or discards the change).
      const { requestShiftTimeChange } = await import("../agents/shiftTimeChange");
      const tcResult = await requestShiftTimeChange({
        appointmentId: appointmentId as string,
        clientId:      clientId as string,
        clientPhone:   (input as Record<string, unknown>).phone as string | undefined,
        newDate:       newDate as string,
        newStartTime:  newTime as string,
        newEndTime,
      });
      if (!tcResult.ok) return toolError("INVALID_INPUT", `Could not request the reschedule (${tcResult.reason ?? "unknown error"})`);
      logAudit({ eventType: "appointment_rescheduled", userId: clientId as string, data: { source: "mcp:reschedule_appointment", appointmentId, newDate, newTime, status: tcResult.status } }).catch(() => {});
      if (tcResult.status === "applied_directly") {
        return { success: true, appointmentId, newDate, newTime, newEndTime, status: "applied_directly", note: "Caregiver had no phone on file — change applied and flagged for admin follow-up." };
      }
      return {
        success: true, appointmentId, newDate, newTime, newEndTime,
        status: "pending_caregiver_confirmation",
        note: `The visit stays at its original time until ${appt.caregiverName ?? "the caregiver"} accepts the new time. Tell the family you've asked the caregiver to confirm and will follow up — do NOT say the reschedule is done.`,
      };
    }

    if (name === "create_care_journal_entry") {
      const { caregiverId, appointmentId, notes, mood, medsGiven, activities } = input as Record<string, unknown>;
      if (!caregiverId || !appointmentId || !notes) return toolError("INVALID_INPUT", "caregiverId, appointmentId, and notes are required");
      const apptSnap = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt = apptSnap.data()!;
      if (appt.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
      const entryRef = await db.collection("care_journal").add({
        seniorId: appt.seniorId ?? appt.clientId, caregiverId, appointmentId,
        clientId: appt.clientId, notes, mood: mood ?? null,
        medsGiven: medsGiven ?? null, activities: activities ?? [],
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
      logAudit({ eventType: "senior_profile_created", userId: clientId as string, data: { source: "mcp:create_senior_profile", seniorProfileId: ref.id } }).catch(() => {});
      return { success: true, seniorProfileId: ref.id, message: `Added ${seniorName} to the household.` };
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
      const { clientId, careTypes, frequency, days, timeOfDay, hourlyRate, paymentMethod, city, startDate } = input as Record<string, unknown>;
      if (!clientId || !Array.isArray(careTypes) || careTypes.length === 0 || hourlyRate == null) {
        return toolError("INVALID_INPUT", "clientId, careTypes (non-empty), and hourlyRate are required");
      }
      const daysArr = Array.isArray(days) ? (days as string[]) : [];
      const todArr  = Array.isArray(timeOfDay) ? (timeOfDay as string[]) : [];
      const ref = db.collection("job_posts").doc();
      // Web JobPost contract via the shared builder — the caregiver Job Board
      // renders title/location-string/rate; the old hand-rolled shape here
      // (summary + location OBJECT) rendered blank and could crash the board.
      const { buildWebJobPostDoc } = await import("../agents/jobPostContract");
      await ref.set(buildWebJobPostDoc({
        clientId:      clientId as string,
        source:        "cara_sms",
        title:         city ? `Care needed in ${city}` : "Care needed",
        careTypes:     careTypes as string[],
        startDate:     (startDate ?? undefined) as string | undefined,
        frequency:     (frequency ?? undefined) as string | undefined,
        days:          daysArr,
        timeOfDay:     todArr,
        hourlyRate:    hourlyRate as number | string,
        paymentMethod: (paymentMethod ?? undefined) as string | undefined,
        city:          (city ?? undefined) as string | undefined,
        intakeId:      ref.id,
      }));
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
      const appRef = await db.collection("job_applications").add({ jobId, caregiverId, clientId: job.clientId, proposedRate: proposedRate ?? null, coverNote: coverNote ?? "", status: "pending", appliedAt: nowIso, source: "cara_sms" });
      const clientSessSnap = await db.collection("agent_sessions").where("userId", "==", job.clientId).limit(1).get();
      if (!clientSessSnap.empty) {
        const { sendViaInteractionAgent } = await import("../agents/caraAgent");
        await sendViaInteractionAgent(clientSessSnap.docs[0].id, { content: "A caregiver applied to your job post. Text 'show applications' to review.", urgency: "standard", sourceAgent: "mcp:apply_to_job", canDrop: true }).catch(() => {});
      }
      logAudit({ eventType: "job_application_submitted", userId: caregiverId as string, data: { source: "mcp:apply_to_job", jobId, applicationId: appRef.id } }).catch(() => {});
      return { success: true, applicationId: appRef.id };
    }

    if (name === "respond_to_job_application") {
      const { applicationId, clientId, decision, message: decMsg } = input as Record<string, unknown>;
      if (!applicationId || !clientId || !decision) return toolError("INVALID_INPUT", "applicationId, clientId, and decision are required");
      const appSnap2 = await db.collection("job_applications").doc(applicationId as string).get();
      if (!appSnap2.exists) return toolError("NOT_FOUND", "Application not found");
      const app = appSnap2.data()!;
      if (app.clientId !== clientId) return toolError("PERMISSION_DENIED", "Application does not belong to this client");
      if (app.status !== "pending") return toolError("INVALID_INPUT", `Application already decided: ${app.status}`);
      await appSnap2.ref.update({ status: decision === "accept" ? "accepted" : "rejected", decidedAt: nowIso, decisionMessage: decMsg ?? "" });
      if (decision === "accept") await db.collection("job_posts").doc(app.jobId as string).update({ status: "filled" }).catch(() => {});
      const cgSessSnap = await db.collection("agent_sessions").where("userId", "==", app.caregiverId).limit(1).get();
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_session" };
      if (!cgSessSnap.empty) {
        const { trySend } = await import("../utils/toolNotify");
        const msg = decision === "accept"
          ? "Great news — a family accepted your job application! They'll be in touch soon to finalize details."
          : "Thanks for applying — the family went with another caregiver this time. Keep an eye out for new jobs!";
        notification = await trySend(cgSessSnap.docs[0].id, msg, "mcp:respond_to_job_application");
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
      await ivSnap.ref.update({ fitLevel, clientNotes: fbNotes ?? "", feedbackSubmitted: true, feedbackAt: nowIso });
      let hireRequestCreated = false;
      if (fitLevel === "strong") {
        await db.collection("hire_requests").add({ clientId, caregiverId: iv.caregiverId, interviewId, status: "pending", createdAt: nowIso });
        hireRequestCreated = true;
        const cgSessSnap2 = await db.collection("agent_sessions").where("userId", "==", iv.caregiverId).limit(1).get();
        if (!cgSessSnap2.empty) {
          const { sendToPhone } = await import("../linq/client");
          await sendToPhone(cgSessSnap2.docs[0].id, "Great news — the family would like to move forward with you! They'll reach out soon to finalize the schedule.").catch(() => {});
        }
      }
      await db.collection("admin_alerts").add({ type: "interview_feedback_submitted", fitLevel, interviewId, clientId, caregiverId: iv.caregiverId, priority: fitLevel === "strong" ? "high" : "low", resolved: false, createdAt: nowIso });
      logAudit({ eventType: "interview_feedback_submitted", userId: clientId as string, data: { source: "mcp:submit_interview_feedback", interviewId, fitLevel } }).catch(() => {});
      return { success: true, fitLevel, hireRequestCreated };
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
      if (!caregiverId || !appointmentId || !clockInTime || !clockOutTime) return toolError("INVALID_INPUT", "caregiverId, appointmentId, clockInTime, and clockOutTime are required");
      const apptSnap3 = await db.collection("appointments").doc(appointmentId as string).get();
      if (!apptSnap3.exists) return toolError("NOT_FOUND", "Appointment not found");
      const appt3 = apptSnap3.data()!;
      if (appt3.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
      if (!["completed","in-progress","in_progress"].includes(appt3.status as string)) return toolError("INVALID_INPUT", "Shift hours can only be submitted for completed or in-progress visits");
      const existingShift = await db.collection("shiftHours").doc(appointmentId as string).get();
      if (existingShift.exists && existingShift.data()!.status !== "correction_requested") return toolError("INVALID_INPUT", "Shift hours already submitted for this appointment");
      const [inH, inM]   = (clockInTime  as string).split(":").map(Number);
      const [outH, outM] = (clockOutTime as string).split(":").map(Number);
      const totalMins3   = (outH * 60 + outM) - (inH * 60 + inM) - (Number(breakMinutes) || 0);
      if (totalMins3 <= 0) return toolError("INVALID_INPUT", "Clock-out time must be after clock-in time");
      const durationHours3 = Math.round((totalMins3 / 60) * 100) / 100;
      const hourlyRate3    = (appt3.hourlyRate as number) ?? 22;
      const amountCents3   = Math.round(durationHours3 * hourlyRate3 * 100);
      const grossPay3      = Math.round(durationHours3 * hourlyRate3 * 100) / 100;
      await db.collection("shiftHours").doc(appointmentId as string).set({
        appointmentId, caregiverId, clientId: appt3.clientId,
        caregiverName: (appt3.caregiverName as string) ?? "Caregiver",
        clientName: (appt3.clientName as string) ?? "Client",
        clockInTime, clockOutTime, breakMinutes: Number(breakMinutes) || 0,
        durationHours: durationHours3,
        submittedTotalHours: durationHours3,
        date: appt3.date, hourlyRate: hourlyRate3, payRate: hourlyRate3,
        amountCents: amountCents3,
        // Charge-engine fields (processShiftPayment reads grossPay/paymentMethod/currency)
        basePay: grossPay3, grossPay: grossPay3, currency: "usd",
        paymentMethod: normalizePaymentMethod(appt3.paymentMethod),
        status: "pending_client_review", submittedAt: nowIso,
        autoApproveAt: autoApproveAtIso(),
        paymentAttemptCount: 0,
      }, { merge: false });
      const clientSessSnap3 = await db.collection("agent_sessions").where("userId", "==", appt3.clientId).limit(1).get();
      if (!clientSessSnap3.empty) {
        const { sendViaInteractionAgent } = await import("../agents/caraAgent");
        const cgData3 = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
        const cgName3 = cgData3?.name ?? cgData3?.firstName ?? "Your caregiver";
        await sendViaInteractionAgent(clientSessSnap3.docs[0].id, { content: `${cgName3} submitted shift hours: ${clockInTime}–${clockOutTime} = ${durationHours3}h ($${(amountCents3/100).toFixed(2)}). Reply APPROVE or let me know if anything needs adjusting.`, urgency: "standard", sourceAgent: "mcp:submit_shift_hours", canDrop: false }).catch(() => {});
      }
      logAudit({ eventType: "shift_hours_submitted", userId: caregiverId as string, data: { source: "mcp:submit_shift_hours", appointmentId, durationHours: durationHours3, amountCents: amountCents3 } }).catch(() => {});
      return { success: true, durationHours: durationHours3, amountCents: amountCents3, amountDollars: `$${(amountCents3/100).toFixed(2)}` };
      });
    }

    if (name === "review_shift_hours") {
      return runActionNativeMcpWrite(name, input, async () => {
      const { clientId, appointmentId, decision, correctedHours, reason } = input as Record<string, unknown>;
      if (!clientId || !appointmentId || !decision) return toolError("INVALID_INPUT", "clientId, appointmentId, and decision are required");
      if (decision === "dispute" && correctedHours == null) return toolError("INVALID_INPUT", "correctedHours is required when disputing");
      const shiftSnap = await db.collection("shiftHours").doc(appointmentId as string).get();
      if (!shiftSnap.exists) return toolError("NOT_FOUND", "Shift hours submission not found");
      const shift = shiftSnap.data()!;
      if (shift.clientId !== clientId) return toolError("PERMISSION_DENIED", "Shift hours do not belong to this client");
      if (shift.status !== "pending_client_review") return toolError("INVALID_INPUT", `Shift hours already reviewed (status: ${shift.status})`);
      await shiftSnap.ref.update({ status: decision === "approve" ? "approved" : "disputed", reviewedAt: nowIso, correctedHours: correctedHours ?? null, disputeReason: reason ?? null });
      if (decision === "dispute") {
        const cgSessSnap4 = await db.collection("agent_sessions").where("userId", "==", shift.caregiverId).limit(1).get();
        if (!cgSessSnap4.empty) {
          const { sendToPhone } = await import("../linq/client");
          await sendToPhone(cgSessSnap4.docs[0].id, `The family reviewed your shift hours and suggested a correction: ${correctedHours}h. Text me if you'd like to discuss.`).catch(() => {});
        }
      }
      logAudit({ eventType: "shift_hours_reviewed", userId: clientId as string, data: { source: "mcp:review_shift_hours", appointmentId, decision } }).catch(() => {});
      return { success: true, decision, appointmentId };
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
      const correctionStates = ["correction_requested", "disputed"];
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
        // Pushback → keep it disputed for admin resolution.
        await shiftSnap.ref.update({ status: "disputed", caregiverCorrectionResponse: "pushback", correctionRespondedAt: nowIso, caregiverDisputeNote: corrMsg ?? "" });
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
      return { success: true, decision, appointmentId, status: decision === "accept" ? "pending_client_review" : "disputed", notification };
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
      const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType } = input as Record<string, unknown>;
      if (!clientId || !caregiverId || !preferredDate || !preferredTime) return toolError("INVALID_INPUT", "clientId, caregiverId, preferredDate, and preferredTime are required");

      // preferredDate/preferredTime are the client's wall-clock time — store a
      // timezone-aware instant (naive strings parse as UTC on GCF and shift
      // reminders ~8h for Pacific users)
      const { parseScheduledTimeMs, formatInterviewTime } = await import("../utils/scheduledTime");
      const startMs = parseScheduledTimeMs(`${preferredDate}T${preferredTime}:00`);
      if (Number.isNaN(startMs)) return toolError("INVALID_INPUT", "preferredDate/preferredTime could not be parsed");
      const scheduledTime = new Date(startMs).toISOString();

      const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      const cgData = cgSnap.data() ?? {};
      const cgPhone = cgData.phone as string | undefined;
      const caregiverName = ((cgData.name as string) ?? `${cgData.firstName ?? ""} ${cgData.lastName ?? ""}`.trim()) || "Caregiver";
      const clientSnap = await db.collection("users").doc(clientId as string).get();
      const clientName = (clientSnap.data()?.name as string) ?? "A family";

      // Pre-mint the doc id so the Meet link + .ics land in the create payload —
      // the link trigger sees a fully-linked doc and no-ops instead of racing us.
      const ivRef = db.collection("video_interviews").doc();
      let callUrl = "";
      let icsUrl  = "";
      try {
        const { createInterviewCallAssets } = await import("../agents/interviewLinks");
        ({ callUrl, icsUrl } = await createInterviewCallAssets({
          title:            `Care Interview — ${caregiverName}`,
          startTime:        scheduledTime,
          durationMinutes:  30,
          interviewId:      ivRef.id,
          icsStoragePrefix: "video_interviews",
        }));
      } catch {
        // Ops alert already raised inside the helper. Create the doc link-less;
        // the trigger retries generation on this create event and later writes.
      }

      await ivRef.set({
        clientId,
        caregiverId,
        applicationId: applicationId ?? null,
        clientName,
        caregiverName,
        scheduledTime,
        interviewType:  interviewType ?? "video",
        status:        "scheduled",
        createdAt:      nowIso,
        feedbackSubmitted: false,
        ...(callUrl ? {
          callUrl,
          ...(icsUrl ? { icsUrl } : {}),
          // The client receives the link in this chat turn via the tool result
          linkDelivery: { client: { status: "delivered_in_chat", at: nowIso } },
          // Hold the trigger's work window while we notify the caregiver below
          linkWork: { claimedAt: nowIso },
        } : {}),
      });
      if (applicationId) {
        await db.collection("job_applications").doc(applicationId as string).update({ status: "interview_scheduled", interviewId: ivRef.id }).catch(() => {});
      }

      const formatted = formatInterviewTime(startMs);
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
      if (cgPhone) {
        const { trySend } = await import("../utils/toolNotify");
        notification = await trySend(
          cgPhone,
          `Interview scheduled! ${clientName} wants to meet ${formatted}.` +
          (callUrl ? `\n\nJoin from your phone: ${callUrl}` : "") +
          `\n\nReply to confirm.`,
          "mcp:schedule_interview"
        );
      }
      if (callUrl) {
        const cgOutcome =
          notification.sent ? "sent"
          : notification.reason === "queued_for_retry"    ? "queued"
          : notification.reason === "recipient_opted_out" ? "skipped_opt_out"
          : notification.reason === "no_caregiver_phone"  ? "missing_phone"
          : null; // hard send failure — leave unset so the trigger retries
        await ivRef.update({
          ...(cgOutcome ? { "linkDelivery.caregiver": { status: cgOutcome, at: new Date().toISOString() } } : {}),
          "linkWork.claimedAt": admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      }
      logAudit({ eventType: "interview_scheduled", userId: clientId as string, data: { source: "mcp:schedule_interview", interviewId: ivRef.id, caregiverId, scheduledTime, notificationSent: notification.sent } }).catch(() => {});
      return {
        success: true,
        interviewId: ivRef.id,
        scheduledTime,
        interviewType: interviewType ?? "video",
        callUrl: callUrl || null,
        icsUrl:  icsUrl || null,
        notification,
        note: callUrl
          ? "Share the Google Meet link with the client in your reply — it is how they join, from any phone browser, no account needed."
          : "Link generation failed and has been flagged to ops; the link will be sent to both parties automatically once available.",
      };
    }

    // ── respond_to_interview_request ────────────────────────────────────────
    if (name === "respond_to_interview_request") {
      const { caregiverId, interviewId, decision, proposedDate, proposedTime, message: ivMsg } = input as Record<string, unknown>;
      if (!caregiverId || !interviewId || !decision) return toolError("INVALID_INPUT", "caregiverId, interviewId, and decision are required");
      const ivSnap = await db.collection("video_interviews").doc(interviewId as string).get();
      if (!ivSnap.exists) return toolError("NOT_FOUND", "Interview not found");
      const iv = ivSnap.data()!;
      if (iv.caregiverId !== caregiverId) return toolError("PERMISSION_DENIED", "Interview does not belong to this caregiver");
      const newStatus = decision === "accept" ? "confirmed" : "declined";
      const upd: Record<string, unknown> = { status: newStatus, respondedAt: nowIso };
      const { parseScheduledTimeMs: parseIvMs, formatInterviewTime: formatIvTime } = await import("../utils/scheduledTime");
      let proposedIso: string | null = null;
      if (proposedDate && proposedTime) {
        const proposedMs = parseIvMs(`${proposedDate}T${proposedTime}:00`);
        proposedIso = Number.isNaN(proposedMs) ? `${proposedDate}T${proposedTime}:00` : new Date(proposedMs).toISOString();
        upd.proposedTime = proposedIso;
      }
      await ivSnap.ref.update(upd);
      const clientSess = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
      if (!clientSess.empty) {
        const cgData = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
        const cgName = cgData?.name ?? "The caregiver";
        const { sendToPhone } = await import("../linq/client");
        const schedMs = parseIvMs(iv.scheduledTime ?? "");
        const whenText = Number.isNaN(schedMs) ? "the scheduled time" : formatIvTime(schedMs);
        const notifyMsg = decision === "accept"
          ? `${cgName} confirmed the interview for ${whenText}.` +
            (iv.callUrl ? `\n\nJoin from your phone: ${iv.callUrl}` : "")
          : proposedDate
            ? `${cgName} can't make the original time but is free ${proposedDate} at ${proposedTime ?? ""}.`
            : `${cgName} isn't available for the interview. ${(ivMsg as string) ?? ""}`.trim();
        await sendToPhone(clientSess.docs[0].id, notifyMsg).catch(() => {});
      }
      logAudit({ eventType: "interview_responded", userId: caregiverId as string, data: { source: "mcp:respond_to_interview_request", interviewId, decision } }).catch(() => {});
      return { success: true, decision, interviewId, callUrl: (iv.callUrl as string | undefined) ?? null, proposedTime: proposedIso };
    }

    // ── get_care_team ───────────────────────────────────────────────────────
    if (name === "get_care_team") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const today = businessTodayStr();
      const teamSnap = await db.collection("appointments")
        .where("clientId", "==", clientId)
        .where("status", "in", ["confirmed", "completed", "in-progress"])
        .orderBy("date", "desc")
        .limit(50)
        .get();
      const seenCaregivers = new Map<string, { nextShift: string | null; lastSeen: string }>();
      for (const d of teamSnap.docs) {
        const appt = d.data();
        const cid = appt.caregiverId as string;
        if (!seenCaregivers.has(cid)) {
          seenCaregivers.set(cid, { nextShift: appt.date >= today ? appt.date : null, lastSeen: appt.date });
        } else if (appt.date >= today && !seenCaregivers.get(cid)!.nextShift) {
          seenCaregivers.get(cid)!.nextShift = appt.date;
        }
      }
      const careTeam = await Promise.all(
        [...seenCaregivers.entries()].slice(0, 10).map(async ([cid, meta]) => {
          const cgSnap = await db.collection("caregivers").doc(cid).get();
          const cg = cgSnap.data() ?? {};
          return {
            caregiverId: cid,
            name:        cg.name ?? (`${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim() || "Caregiver"),
            phone:       cg.phone ?? null,
            rating:      cg.rating ?? null,
            nextShift:   meta.nextShift,
            lastSeen:    meta.lastSeen,
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
        .where("status", "in", ["approved", "paid"])
        .orderBy("submittedAt", "desc")
        .limit(limit10)
        .get();
      const invoices = await Promise.all(
        invSnap.docs.map(async (d) => {
          const sh = d.data();
          const cgSnap = await db.collection("caregivers").doc(sh.caregiverId as string).get().catch(() => null);
          const cg = cgSnap?.data() ?? {};
          return {
            invoiceId:     d.id,
            date:          sh.date,
            caregiverName: (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver",
            hours:         sh.durationHours,
            amount:        `$${((sh.amountCents as number ?? 0) / 100).toFixed(2)}`,
            status:        sh.status,
            approvedAt:    sh.reviewedAt ?? null,
          };
        })
      );
      return { success: true, invoices, total: invoices.length };
    }

    // ── edit_job_post ───────────────────────────────────────────────────────
    if (name === "edit_job_post") {
      const { jobId, clientId, rate, description, startDate, daysOfWeek, timeOfDay, paymentMethod } = input as Record<string, unknown>;
      if (!jobId || !clientId) return toolError("INVALID_INPUT", "jobId and clientId are required");
      const jpSnap = await db.collection("job_posts").doc(jobId as string).get();
      if (!jpSnap.exists) return toolError("NOT_FOUND", "Job post not found");
      const jp = jpSnap.data()!;
      if (jp.clientId !== clientId) return toolError("PERMISSION_DENIED", "This job post does not belong to you");
      if (jp.status !== "open") return toolError("INVALID_INPUT", `Cannot edit a job post with status '${jp.status}'`);
      const upd: Record<string, unknown> = { updatedAt: nowIso };
      if (rate        != null)  upd.hourlyRate    = rate;
      if (description != null)  upd.description   = (description as string).slice(0, 500);
      if (startDate   != null)  upd.startDate     = startDate;
      if (daysOfWeek  != null)  upd["schedule.days"] = daysOfWeek;
      if (timeOfDay   != null)  upd["schedule.timeOfDay"] = timeOfDay;
      if (paymentMethod != null) upd.paymentMethod = paymentMethod;
      await jpSnap.ref.update(upd);
      await db.collection("job_postings").doc(clientId as string).set({ ...upd, clientId }, { merge: true });
      logAudit({ eventType: "job_post_edited", userId: clientId as string, data: { source: "mcp:edit_job_post", jobId, fields: Object.keys(upd) } }).catch(() => {});
      return { success: true, jobId, updatedFields: Object.keys(upd).filter(k => k !== "updatedAt") };
    }

    // ── send_client_message ─────────────────────────────────────────────────
    if (name === "send_client_message") {
      const { caregiverId, message, clientId: clientIdInput } = input as Record<string, unknown>;
      if (!caregiverId || !message) return toolError("INVALID_INPUT", "caregiverId and message are required");
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
      const cgData = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
      const cgName = cgData?.name ?? "Your caregiver";
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(clientPhone, `${cgName}: ${message}`, "mcp:send_client_message");
      logAudit({ eventType: "caregiver_sent_message", userId: caregiverId as string, data: { source: "mcp:send_client_message", resolvedClientId, messageLength: (message as string).length, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, sentTo: resolvedClientId, notification };
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
      let threadsQuery: admin.firestore.Query = db.collection("threads").where("participants", "array-contains", userId);
      if (counterpartId) threadsQuery = threadsQuery.where("participants", "array-contains", counterpartId);
      const threadsSnap = await threadsQuery.orderBy("updatedAt", "desc").limit(5).get();
      const results = await Promise.all(
        threadsSnap.docs.map(async (t) => {
          const thread = t.data();
          const participants = (thread.participants as string[]) ?? [];
          const otherUserId = participants.find((p) => p !== userId);
          let otherName = "Unknown";
          if (otherUserId) {
            const cgSnap = await db.collection("caregivers").doc(otherUserId).get().catch(() => null);
            const uSnap  = await db.collection("users").doc(otherUserId).get().catch(() => null);
            const d = cgSnap?.data() ?? uSnap?.data() ?? {};
            otherName = d.name ?? (`${d.firstName ?? ""} ${d.lastName ?? ""}`.trim() || "Unknown");
          }
          const msgsSnap = await db.collection("threads").doc(t.id).collection("messages")
            .orderBy("timestamp", "desc").limit(msgLimit).get();
          const messages = msgsSnap.docs.reverse().map((m) => {
            const msg = m.data();
            return {
              from:      msg.senderId === userId ? "you" : otherName,
              text:      (msg.text as string ?? "").slice(0, 200),
              timestamp: msg.timestamp,
            };
          });
          return { threadId: t.id, with: otherName, messages };
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
          applicantCount: data.applicantCount ?? 0,
          createdAt:      data.createdAt,
          schedule:       data.schedule,
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
      if (jp.status === "closed" || jp.status === "cancelled") return toolError("INVALID_INPUT", "Job post is already closed");
      await jpSnap.ref.update({ status: "closed", closedAt: nowIso });
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
            coverNote:      app.coverNote    ?? null,
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
      if (Array.isArray(availableDays) && availableDays.length > 0)
        upd6["availability"] = admin.firestore.FieldValue.arrayUnion(...(availableDays as string[]));
      if (Array.isArray(unavailableDays) && unavailableDays.length > 0)
        upd6["availability"] = admin.firestore.FieldValue.arrayRemove(...(unavailableDays as string[]));
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
          return {
            appointmentId:  ts.appointmentId,
            caregiverName:  (cg8.name ?? `${cg8.firstName ?? ""} ${cg8.lastName ?? ""}`.trim()) || "Caregiver",
            date:           ts.date,
            clockIn:        ts.clockInTime,
            clockOut:       ts.clockOutTime,
            hours:          ts.durationHours,
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

      // Cancel all future confirmed appointments from the old schedule
      const futureSnap = await db.collection("appointments")
        .where("recurringScheduleId", "==", scheduleId)
        .where("date", ">", today)
        .where("status", "in", ["confirmed"])
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
          date, startTime: resolvedStart, endTime: resolvedEnd,
          durationHours: newDurationHours, hourlyRate: sched.hourlyRate,
          status: "confirmed", recurringScheduleId: scheduleId,
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

      const userSnap = await db.collection("users").doc(clientId as string).get();
      if (!userSnap.exists) return toolError("NOT_FOUND", "Client not found");
      const stripeCustomerId = userSnap.data()?.stripeCustomerId as string | undefined;
      if (!stripeCustomerId) return toolError("INVALID_INPUT", "No Stripe billing account found for this client. They may need to re-subscribe.");

      const { getStripeClient } = await import("../stripe");
      const sc = getStripeClient();

      const appUrl = getAppUrl();
      const session = await sc.billingPortal.sessions.create({
        customer:   stripeCustomerId,
        return_url: `${appUrl}/settings/billing`,
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

      await ref.update({ status: "approved", retryCount: (shift.retryCount ?? 0) + 1 });
      logAudit({ eventType: "shift_payment_retried", userId: clientId as string, data: { source: "mcp:retry_shift_payment", appointmentId, retryCount: (shift.retryCount ?? 0) + 1 } }).catch(() => {});
      return {
        success: true,
        appointmentId,
        guidance:
          "The payment is being retried now. Tell the family you've re-run it and you'll let them know if it " +
          "fails again — do NOT promise it succeeded; the charge happens asynchronously. If it fails again, " +
          "send get_payment_update_link so they can fix their card.",
      };
    }

    // ── update_booking_payment_method ───────────────────────────────────────
    // Agent mirror of the v1-updateBookingPaymentMethod callable
    // (paymentMethods.ts): same guards — owner only, confirmed status, not yet
    // started — so the two paths can never diverge on what's allowed.
    if (name === "update_booking_payment_method") {
      const { appointmentId, clientId, paymentMethod } = input as Record<string, unknown>;
      const { OFFLINE_PAYMENT_METHODS } = await import("../billing/paymentMethods");
      const validMethods = ["credit", ...OFFLINE_PAYMENT_METHODS];
      if (!appointmentId || !clientId) return toolError("INVALID_INPUT", "appointmentId and clientId are required");
      if (!validMethods.includes(paymentMethod as string)) {
        return toolError("INVALID_INPUT", `paymentMethod must be one of: ${validMethods.join(", ")}`);
      }

      const ref  = db.collection("appointments").doc(appointmentId as string);
      const snap = await ref.get();
      if (!snap.exists) return toolError("NOT_FOUND", "Appointment not found.");
      const appt = snap.data()!;
      if (appt.clientId !== clientId) return toolError("PERMISSION_DENIED", "This booking doesn't belong to this family.");
      if (appt.status !== "confirmed") {
        return toolError("INVALID_INPUT", "Payment method can only be changed on a confirmed booking that hasn't started.");
      }
      // "Already started" in PACIFIC wall-clock terms — `new Date("YYYY-MM-DD")`
      // is UTC midnight = 5pm PT the EVENING BEFORE, which blocked families
      // from changing payment method the night before the visit.
      const { parseScheduledTimeMs: parseStartMs } = await import("../utils/scheduledTime");
      const startIso = appt.isoDate || appt.date;
      const startRef = appt.startTime
        ? `${String(appt.date)}T${String(appt.startTime).slice(0, 5)}:00`
        : String(startIso ?? "");
      if (startIso && parseStartMs(startRef) <= Date.now()) {
        return toolError("INVALID_INPUT", "That booking has already started — the payment method can't be changed now.");
      }

      await ref.update({ paymentMethod, updatedAt: nowIso });
      logAudit({ eventType: "booking_payment_method_updated", userId: clientId as string, data: { source: "mcp:update_booking_payment_method", appointmentId, paymentMethod } }).catch(() => {});
      const offline = paymentMethod !== "credit";
      return {
        success: true,
        appointmentId,
        paymentMethod,
        guidance: offline
          ? `Confirm the switch to the family and remind them they'll pay the caregiver directly by ${paymentMethod}; the caregiver confirms receipt after the visit.`
          : "Confirm the switch to the family — this visit will be charged to their card on file.",
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
      const { isAllowedField, missingRequiredFields, normalizeOnboardingFieldValue, CAREGIVER_JOB_TYPES } = await import("../agents/onboardingContract");
      if (!isAllowedField(role, fieldName)) {
        return toolError("INVALID_INPUT", `'${fieldName}' is not a collectable onboarding field for a ${role}.`);
      }
      if (fieldValue === undefined || fieldValue === null || (fieldValue === "" && !(role === "caregiver" && fieldName === "bio"))) {
        return toolError("INVALID_INPUT", "fieldValue is required");
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
      return { ok: true, fieldName, saved: true, missing, collectionComplete: missing.length === 0 };
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
      let invDocs: admin.firestore.DocumentSnapshot[];
      if (invId) {
        const doc = await db.collection("invoices").doc(invId).get();
        invDocs = doc.exists ? [doc] : [];
      } else {
        const q = await db.collection("invoices")
          .where("clientId", "==", invClientId)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        invDocs = q.docs;
      }
      if (!invDocs.length) return toolError("NOT_FOUND", "No invoices found for this client.");
      const invoice = invDocs[0].data()!;
      return {
        invoiceId:     invDocs[0].id,
        invoiceNumber: invoice.invoiceNumber,
        status:        invoice.status,
        total:         invoice.total ?? invoice.amount,
        lineItems:     invoice.lineItems ?? [],
        carePeriod:    invoice.carePeriod,
        createdAt:     invoice.createdAt,
      };
    }

    // ── create_refund_request ───────────────────────────────────────────────
    if (name === "create_refund_request") {
      const { clientId: rfClientId, appointmentId: rfApptId, reason: rfReason } = input as Record<string, string | undefined>;
      if (!rfClientId || !rfApptId) return toolError("INVALID_INPUT", "clientId and appointmentId are required");
      const ref = await db.collection("refundRequests").add({
        clientId:      rfClientId,
        appointmentId: rfApptId,
        reason:        rfReason ?? "",
        status:        "pending_review",
        requestedAt:   nowIso,
        source:        "cara_self_service",
      });
      return { success: true, requestId: ref.id, message: "Refund request submitted. Admin review within 24 hours." };
    }

    // ── get_care_plan_history ───────────────────────────────────────────────
    if (name === "get_care_plan_history") {
      // Canonical path: care_plans/{clientId}/versions (bug-audit §6.1). clientId
      // is session-injected, so history is always scoped to the caller's own plan.
      const { clientId: cpClientId } = input as Record<string, string | undefined>;
      if (!cpClientId) return toolError("INVALID_INPUT", "clientId is required (auto-injected from session)");
      const cpLimit = Math.min((input.limit as number) ?? 5, 10);
      const cpSnap = await db.collection("care_plans").doc(cpClientId)
        .collection("versions")
        .orderBy("savedAt", "desc")
        .limit(cpLimit)
        .get();
      if (cpSnap.empty) return { versions: [], message: "No revision history yet." };
      return {
        versions: cpSnap.docs.map(d => ({
          versionId:  d.id,
          savedAt:    d.data().savedAt,
          changedBy:  d.data().changedBy,
          summary:    d.data().summary,
        })),
      };
    }

    // ── restore_care_plan_version ───────────────────────────────────────────
    if (name === "restore_care_plan_version") {
      // Canonical path: care_plans/{clientId} + its versions subcollection
      // (bug-audit §6.1/§6.2). clientId is session-injected, and the version is
      // read from THIS client's own subcollection — so a model-supplied versionId
      // can only ever address the caller's own plan (cross-household restore is
      // prevented by construction; no separate ownership check needed).
      const { versionId: rVersionId, clientId: rClientId } = input as Record<string, string | undefined>;
      if (!rVersionId || !rClientId) return toolError("INVALID_INPUT", "versionId is required (clientId auto-injected from session)");
      const rVersionDoc = await db.collection("care_plans").doc(rClientId)
        .collection("versions").doc(rVersionId).get();
      if (!rVersionDoc.exists) return toolError("NOT_FOUND", "Version not found");
      const rVersionData = rVersionDoc.data()!;
      const rPlan = (rVersionData.carePlan ?? rVersionData) as Record<string, unknown>;
      // Overwrite the live plan with the snapshot. This write fires
      // onCarePlanWrite, which records the restored state as the newest version —
      // and the pre-restore state is already in history (versioned when it was
      // last edited), so no explicit "save before restore" is needed.
      await db.collection("care_plans").doc(rClientId).set({ ...rPlan, updatedAt: nowIso });
      logAudit({ eventType: "care_plan_restored", userId: rClientId, data: { source: "mcp:restore_care_plan_version", versionId: rVersionId } }).catch(() => {});
      return { success: true, message: "Care plan restored to the selected version." };
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
      if (swap.status !== "open") return { success: false, message: "This swap is no longer open." };
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
      const { userId, firstName, lastName, phone, address, city, state, zip, photoUrl } = input as Record<string, unknown>;
      if (!userId) return toolError("INVALID_INPUT", "userId is required");
      const patch: Record<string, unknown> = { updatedAt: nowIso };
      if (firstName != null) patch.firstName = firstName;
      if (lastName  != null) patch.lastName  = lastName;
      if (address   != null) patch.address   = address;
      if (city      != null) patch.city      = city;
      if (state     != null) patch.state     = state;
      if (zip       != null) patch.zip       = zip;
      if (photoUrl  != null) patch.photoUrl  = photoUrl;
      // Phone changes trigger a re-verification — store as pendingPhone rather
      // than the live phone so the existing OTP flow can run before swapping.
      let phoneChangeRequested = false;
      if (phone != null) {
        if (!/^\+1\d{10}$/.test(phone as string)) {
          return toolError("INVALID_INPUT", "phone must be in E.164 format (+1XXXXXXXXXX)");
        }
        patch.pendingPhone = phone;
        patch.pendingPhoneAt = nowIso;
        phoneChangeRequested = true;
      }
      if (Object.keys(patch).length === 1) {
        return toolError("INVALID_INPUT", "No fields to update");
      }
      await db.collection("users").doc(userId as string).set(patch, { merge: true });
      // If address fields touched and this is a single-senior household, mirror
      // to the senior profile too.
      if (address != null || city != null || state != null || zip != null) {
        const seniorSnap = await db.collection("senior_profiles").where("userId", "==", userId).limit(2).get();
        if (seniorSnap.size === 1) {
          const seniorPatch: Record<string, unknown> = { updatedAt: nowIso };
          if (address != null) seniorPatch.address = address;
          if (city    != null) seniorPatch.city    = city;
          if (state   != null) seniorPatch.state   = state;
          if (zip     != null) seniorPatch.zip     = zip;
          await seniorSnap.docs[0].ref.set(seniorPatch, { merge: true }).catch(() => {});
        }
      }
      logAudit({ eventType: "profile_updated", userId: userId as string, data: { source: "mcp:update_user_profile", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => {});
      return {
        success: true,
        updated: Object.keys(patch).filter(k => k !== "updatedAt"),
        phoneChangeRequested,
        phoneVerificationNote: phoneChangeRequested
          ? "Phone change saved but not yet active — the new number needs to verify via OTP before it takes over."
          : undefined,
      };
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
      const token = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
      await db.collection("email_change_requests").doc(token).set({
        userId, newEmail, requestedAt: nowIso, status: "pending",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      await db.collection("users").doc(userId as string).set({ pendingEmail: newEmail, pendingEmailToken: token, pendingEmailAt: nowIso }, { merge: true });
      logAudit({ eventType: "email_change_requested", userId: userId as string, data: { source: "mcp:request_email_change", maskedEmail: (newEmail as string).replace(/(.{2}).*(@.*)/, "$1***$2") } }).catch(() => {});
      // Email-send is fire-and-forget for now — the actual link send is handled by
      // a separate triggered function watching email_change_requests writes.
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

    // ── block_user ──────────────────────────────────────────────────────────
    if (name === "block_user") {
      const { userId, targetUserId, reason } = input as Record<string, unknown>;
      if (!userId || !targetUserId) return toolError("INVALID_INPUT", "userId and targetUserId are required");
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
      logAudit({ eventType: "user_blocked", userId: userId as string, data: { source: "mcp:block_user", targetUserId, reason } }).catch(() => {});
      return { success: true, blocked: true };
    }

    // ── unblock_user ────────────────────────────────────────────────────────
    if (name === "unblock_user") {
      const { userId, targetUserId } = input as Record<string, unknown>;
      if (!userId || !targetUserId) return toolError("INVALID_INPUT", "userId and targetUserId are required");
      await db.collection("users").doc(userId as string).set({
        blockedUsers: admin.firestore.FieldValue.arrayRemove(targetUserId),
        updatedAt: nowIso,
      }, { merge: true });
      logAudit({ eventType: "user_unblocked", userId: userId as string, data: { source: "mcp:unblock_user", targetUserId } }).catch(() => {});
      return { success: true, unblocked: true };
    }

    // ── report_user ─────────────────────────────────────────────────────────
    if (name === "report_user") {
      const { userId, targetUserId, category, description } = input as Record<string, unknown>;
      if (!userId || !targetUserId || !category || !description) return toolError("INVALID_INPUT", "userId, targetUserId, category, and description are required");
      const ALLOWED_CATEGORIES = new Set(["harassment", "scam", "safety_concern", "inappropriate_content", "other"]);
      if (!ALLOWED_CATEGORIES.has(category as string)) {
        return toolError("INVALID_INPUT", `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`);
      }
      const reportRef = await db.collection("reports").add({
        reporterId:    userId,
        targetUserId,
        category,
        description:   (description as string).slice(0, 2000),
        source:        "cara_sms",
        status:        "open",
        createdAt:     nowIso,
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
      logAudit({ eventType: "user_reported", userId: userId as string, data: { source: "mcp:report_user", targetUserId, category, reportId: reportRef.id } }).catch(() => {});
      return { success: true, reported: true, reportId: reportRef.id, followUpWindow: "24h" };
    }

    // ── like_journal_entry ──────────────────────────────────────────────────
    if (name === "like_journal_entry") {
      const { userId, entryId } = input as Record<string, unknown>;
      if (!userId || !entryId) return toolError("INVALID_INPUT", "userId and entryId are required");
      const entryRef = db.collection("care_journal").doc(entryId as string);
      const entrySnap = await entryRef.get();
      if (!entrySnap.exists) return toolError("NOT_FOUND", "Care journal entry not found");
      await entryRef.set({
        likedBy: admin.firestore.FieldValue.arrayUnion(userId),
        likeCount: admin.firestore.FieldValue.increment(1),
      }, { merge: true });
      logAudit({ eventType: "journal_liked", userId: userId as string, data: { source: "mcp:like_journal_entry", entryId } }).catch(() => {});
      return { success: true, liked: true };
    }

    // ── unlike_journal_entry ────────────────────────────────────────────────
    if (name === "unlike_journal_entry") {
      const { userId, entryId } = input as Record<string, unknown>;
      if (!userId || !entryId) return toolError("INVALID_INPUT", "userId and entryId are required");
      const entryRef = db.collection("care_journal").doc(entryId as string);
      await entryRef.set({
        likedBy: admin.firestore.FieldValue.arrayRemove(userId),
        likeCount: admin.firestore.FieldValue.increment(-1),
      }, { merge: true });
      logAudit({ eventType: "journal_unliked", userId: userId as string, data: { source: "mcp:unlike_journal_entry", entryId } }).catch(() => {});
      return { success: true, unliked: true };
    }

    // ── comment_on_journal_entry ────────────────────────────────────────────
    if (name === "comment_on_journal_entry") {
      const { userId, entryId, comment } = input as Record<string, unknown>;
      if (!userId || !entryId || !comment) return toolError("INVALID_INPUT", "userId, entryId, and comment are required");
      const entryRef = db.collection("care_journal").doc(entryId as string);
      const entrySnap = await entryRef.get();
      if (!entrySnap.exists) return toolError("NOT_FOUND", "Care journal entry not found");
      const commentRef = await entryRef.collection("comments").add({
        userId,
        comment: (comment as string).slice(0, 2000),
        createdAt: nowIso,
      });
      await entryRef.set({ commentCount: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
      // Best-effort notify caregiver so the comment actually reaches them.
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
      const entry = entrySnap.data()!;
      if (entry.caregiverId) {
        const cgSnap = await db.collection("caregivers").doc(entry.caregiverId as string).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (cgPhone) {
          const { trySend } = await import("../utils/toolNotify");
          notification = await trySend(cgPhone, `New comment on your care journal entry: "${(comment as string).slice(0, 120)}"`, "mcp:comment_on_journal_entry");
        }
      }
      logAudit({ eventType: "journal_comment_added", userId: userId as string, data: { source: "mcp:comment_on_journal_entry", entryId, commentId: commentRef.id, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, commentId: commentRef.id, notification };
    }

    // ── delete_comment ──────────────────────────────────────────────────────
    if (name === "delete_comment") {
      const { userId, entryId, commentId } = input as Record<string, unknown>;
      if (!userId || !entryId || !commentId) return toolError("INVALID_INPUT", "userId, entryId, and commentId are required");
      const commentRef = db.collection("care_journal").doc(entryId as string).collection("comments").doc(commentId as string);
      const entryRef   = db.collection("care_journal").doc(entryId as string);
      // Existence check, ownership check, delete, and the commentCount decrement
      // run in one transaction so concurrent deletes of the same entry can't
      // double-decrement (or drop the count) — they all commit or none do.
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(commentRef);
        if (!snap.exists) return { error: "NOT_FOUND" as const };
        if (snap.data()?.userId !== userId) return { error: "PERMISSION_DENIED" as const };
        tx.delete(commentRef);
        tx.set(entryRef, { commentCount: admin.firestore.FieldValue.increment(-1) }, { merge: true });
        return { error: null };
      });
      if (outcome.error === "NOT_FOUND") return toolError("NOT_FOUND", "Comment not found.");
      if (outcome.error === "PERMISSION_DENIED") return toolError("PERMISSION_DENIED", "You can only delete your own comments.");
      logAudit({ eventType: "journal_comment_deleted", userId: userId as string, data: { source: "mcp:delete_comment", entryId, commentId } }).catch(() => {});
      return { success: true, deleted: true };
    }

    // ── edit_comment ──────────────────────────────────────────────────────────
    if (name === "edit_comment") {
      const { userId, entryId, commentId, comment } = input as Record<string, unknown>;
      if (!userId || !entryId || !commentId || !comment) return toolError("INVALID_INPUT", "userId, entryId, commentId, and comment are required");
      const commentRef = db.collection("care_journal").doc(entryId as string).collection("comments").doc(commentId as string);
      // Verify existence + author ownership in a transaction, then update the text.
      let abort: { code: string; message: string } | null = null;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(commentRef);
        if (!snap.exists) { abort = { code: "NOT_FOUND", message: "Comment not found." }; return; }
        if (snap.data()?.userId !== userId) { abort = { code: "PERMISSION_DENIED", message: "You can only edit your own comments." }; return; }
        tx.update(commentRef, { comment: (comment as string).slice(0, 2000), editedAt: nowIso });
      });
      if (abort) return toolError(abort.code, abort.message);
      logAudit({ eventType: "journal_comment_edited", userId: userId as string, data: { source: "mcp:edit_comment", entryId, commentId } }).catch(() => {});
      return { success: true, edited: true };
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
        return {
          appointmentId: d.id,
          date:          s.date ?? null,
          status:        s.status ?? null,
          durationHours: s.durationHours ?? s.submittedTotalHours ?? null,
          amountCents:   s.amountCents ?? null,
          amountDollars: s.amountCents != null ? `$${(Number(s.amountCents) / 100).toFixed(2)}` : null,
          clockInTime:   s.clockInTime ?? null,
          clockOutTime:  s.clockOutTime ?? null,
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

    // ── update_reminder ─────────────────────────────────────────────────────
    if (name === "update_reminder") {
      const { phone: urPhone, triggerId: urTriggerId, label, recurrence, dayOfWeek, hour, minute, message: urMsg } =
        input as Record<string, unknown>;
      if (!urPhone || !urTriggerId) return toolError("INVALID_INPUT", "phone and triggerId are required");
      const patch: Record<string, unknown> = {};
      if (label      !== undefined) patch.label = label;
      if (recurrence !== undefined) patch.recurrence = recurrence;
      if (dayOfWeek  !== undefined) patch.dayOfWeek = dayOfWeek;
      if (hour       !== undefined) patch.hour = hour;
      if (minute     !== undefined) patch.minute = minute;
      if (urMsg      !== undefined) patch.message = urMsg;
      if (Object.keys(patch).length === 0) {
        return toolError("INVALID_INPUT", "Provide at least one field to update (label, recurrence, dayOfWeek, hour, minute, or message).");
      }
      const { updateUserTrigger } = await import("../triggers/userTriggerManager");
      const updated = await updateUserTrigger(urPhone as string, urTriggerId as string, patch as Parameters<typeof updateUserTrigger>[2]);
      if (!updated) return toolError("NOT_FOUND", "Reminder not found or does not belong to this user");
      return { success: true, updated: true, triggerId: urTriggerId };
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
      logAudit({ eventType: "health_data_accessed", userId: input.userId as string, data: { source: "mcp:delete_memory_file", file: input.file } }).catch(() => {});
      const existed = await deleteMemoryFile(input.userId as string, input.file as MemoryFile);
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

    // ── confirm_cash_received ───────────────────────────────────────────────
    // Mirror of the web's confirmCashReceived (services/api.ts): caregiver-owned
    // offline shift (cash/Venmo/Zelle), approved/auto_approved → paid. Idempotent
    // on SMS retry — an already-paid shift returns a no-op success, never a
    // double transition. (Tool name keeps "cash" for prompt/contract stability.)
    if (name === "confirm_cash_received") {
      const { caregiverId: ccCgId, appointmentId: ccApptId } = input as Record<string, unknown>;
      if (!ccCgId || !ccApptId) return toolError("INVALID_INPUT", "caregiverId and appointmentId are required");
      const shiftRef  = db.collection("shiftHours").doc(ccApptId as string);
      const shiftSnap = await shiftRef.get();
      if (!shiftSnap.exists) return toolError("NOT_FOUND", "Shift hours record not found");
      const shift = shiftSnap.data()!;
      if (shift.caregiverId !== ccCgId) return toolError("PERMISSION_DENIED", "Only the caregiver on this shift can confirm payment receipt");
      if (!isOfflinePaymentMethod(shift.paymentMethod)) return toolError("INVALID_INPUT", "This shift is not an offline (cash/Venmo/Zelle) payment");
      if (shift.status === "paid") return { success: true, alreadyPaid: true, appointmentId: ccApptId };
      if (shift.status !== "approved" && shift.status !== "auto_approved") {
        return toolError("INVALID_INPUT", `Shift hours must be approved before confirming payment (current status: ${shift.status})`);
      }
      const ccMethod = normalizePaymentMethod(shift.paymentMethod);
      await shiftRef.update({
        status:          "paid",
        paidMethod:      ccMethod,
        paidAt:          nowIso,
        cashConfirmedAt: nowIso,
        updatedAt:       nowIso,
      });
      logAudit({ eventType: "cash_payment_confirmed", userId: ccCgId as string, data: { source: "mcp:confirm_cash_received", appointmentId: ccApptId, method: ccMethod } }).catch(() => {});
      return { success: true, paid: true, method: ccMethod, appointmentId: ccApptId };
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
            severity: name === "perform_web_action" ? "high" : "medium",
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
        severity: name === "perform_web_action" ? "high" : "medium",
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
