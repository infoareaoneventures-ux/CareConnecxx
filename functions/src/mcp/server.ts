import * as admin from "firebase-admin";
import { runMatchingForClient } from "../agents/matchingAgent";
import { logHealthDataAccessed, logBookingCreated, logAudit } from "../observability/auditLog";
import {
  readMemoryFile,
  writeMemoryFile,
  editMemoryFile,
  searchMemoryHybrid,
  getMemoryContext,
  listMemoryFiles,
  MemoryFile,
} from "../memory/memoryFiles";
import { getPreferences } from "../memory/preferences";
import { isHighRisk, proposePendingAction, buildPendingActionStub } from "../agents/pendingActions";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { runEphemeralSubAgent, buildTaskToolDescription, getPublicSubAgentNames, INTERNAL_SUB_AGENT_NAMES } from "../agents/ephemeralSubAgents";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

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
    description: "Search for available caregivers matching the client's care needs. Session context (phone, chatId, clientId) is injected automatically — do NOT ask the user for these.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "request_booking",
    description: "Create a booking request for a caregiver. Returns the booking task ID. clientId is injected automatically — do NOT ask the user for it.",
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
    name: "update_preferences",
    description: "Update Cara's notification preferences for the user (DND, active hours, etc.).",
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
    description: "Read one of Cara's long-term memory files for a user. Canonical files: profile, health, family, recent_episodes, procedural. May also be an ad-hoc slug returned by another tool (e.g. an offloaded large result like \"tool_get_invoice_history_...\").",
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
    description: "Append new information to one of Cara's long-term memory files for a user.",
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
      "Surgically correct a stored fact in one of Cara's memory files by find/replace, instead of appending a duplicate. " +
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
      "Return a clean digest of everything Cara remembers about this family — senior profile, " +
      "health, family relationships, recent episodes, procedural notes. " +
      "Call when the family asks 'what do you know about Mom?', 'what's on file?', 'remind me what we've told you', " +
      "'do you remember [topic]?', or any variation that asks Cara to surface her stored memory. " +
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
    description: "List the personal reminders the user has set up through Cara (e.g. 'remind me every Monday about medications').",
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
      "Create a personal recurring reminder for the user. Use when the family asks Cara to remind them of something on a schedule. " +
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
        message:    { type: "string", description: "The full text Cara will send as the reminder" },
      },
      required: ["phone", "userId", "label", "recurrence", "hour", "minute", "message"],
    },
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
        message:     { type: "string",  description: "The exact text Cara will send as the follow-up" },
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
      "Browse the web or take action on websites on behalf of the family. " +
      "Handles both public web lookups AND login-required portal actions.\n\n" +
      "PUBLIC (no login needed — always try search_web first, then these):\n" +
      "- actionType 'search': find results matching a query\n" +
      "- actionType 'fetch': get content from a specific URL\n" +
      "- actionType 'browse': full AI browser session for complex navigation\n\n" +
      "LOGIN-REQUIRED (set loginAction instead of actionType):\n" +
      "- loginAction 'schedule_appointment': book a doctor appointment on MyChart etc.\n" +
      "- loginAction 'pharmacy_refill': request a prescription refill on CVS/Walgreens\n" +
      "- loginAction 'insurance_check': check authorization or coverage status\n\n" +
      "If credentials aren't stored yet, Cara will collect them securely via iMessage before proceeding.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What to do or find, in plain English.",
        },
        url: {
          type: "string",
          description: "Optional starting URL if you already know the website.",
        },
        actionType: {
          type: "string",
          enum: ["search", "fetch", "browse"],
          description: "For public web actions (no login). search = fastest, fetch = page content, browse = full AI navigation.",
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
      required: ["task", "userId"],
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
      "Cancel the family's CareConnex membership. Cancels at end of billing period — scheduled visits are unaffected. " +
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
      "Request an instant payout of your earned balance. A 1.5% processing fee applies. " +
      "If no amount specified, requests full available balance.",
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
    name: "create_support_ticket",
    description:
      "Create a support ticket for an issue that needs human team follow-up. " +
      "The support team will respond within 24 hours.",
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
      "Notifies the caregiver and creates the interview record. Confirm date/time with client before calling.",
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
      "Get the revision history of a senior's care plan — who changed what and when. Returns up to 10 versions.",
    input_schema: {
      type: "object",
      properties: {
        seniorId: { type: "string", description: "The senior's profile document ID" },
        limit:    { type: "number", description: "Number of versions to return (default 5, max 10)" },
      },
      required: ["seniorId"],
    },
  },
  {
    name: "restore_care_plan_version",
    description:
      "Restore a previous version of the care plan. Confirm with the client before calling — this replaces the current care plan.",
    input_schema: {
      type: "object",
      properties: {
        seniorId:  { type: "string", description: "The senior's profile document ID" },
        versionId: { type: "string", description: "The carePlanVersions document ID to restore" },
        clientId:  { type: "string", description: "The client's user ID (ownership check)" },
      },
      required: ["seniorId", "versionId", "clientId"],
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
        paymentMethod:{ type: "string", enum: ["card","cash"], description: "New payment method" },
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
    name: "send_onboarding_link",
    description:
      "Generate AND send a tappable onboarding/signup link directly to this chat. Use this whenever a family " +
      "or caregiver asks you to (re)send a subscription/payment, identity verification, profile photo, document " +
      "upload, background check, or payout-setup link. The tool sends the link itself — after it succeeds, just " +
      "briefly confirm (e.g. \"Sent! Tap the link to verify your identity\"). NEVER create a support ticket for a " +
      "link you can send with this tool. Pick the linkType that matches what they asked for.",
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
        newsletter:           { type: "boolean", description: "Receive the CareConnex newsletter" },
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
]);
export const CAREGIVER_TOOLS: McpTool[] = MCP_TOOLS.filter(t => CAREGIVER_TOOL_NAMES.has(t.name));

export async function handleToolCallForCaregiver(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  if (name === "perform_web_action" && input.loginAction) {
    return { _toolError: true, message: "Login-required web actions are not available for caregivers." };
  }
  return handleToolCall(name, input);
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
    description: "Cara's long-term memory file: profile, health, family, recent_episodes, or procedural.",
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
        `You are Cara. Write a Sunday morning text to ${clientName} about ${seniorName}'s week.`,
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
        `You are Cara. Write a short, direct morning briefing text for caregiver ${caregiverName}.`,
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

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  // Runtime-enforced confirmation gate. High-risk tool calls (cancel_appointment,
  // remove_family_member, cancel_subscription, etc.) are intercepted on the
  // first call and turned into a pending-action stub for Claude to read.
  // The re-run from approvalHandler sets _confirmedActionId to bypass the gate.
  // See pendingActions.ts for the full design.
  const confirmedActionId = input._confirmedActionId as string | undefined;
  if (confirmedActionId) {
    delete input._confirmedActionId;
  } else if (isHighRisk(name, input)) {
    const phone = input.phone as string | undefined;
    if (!phone) {
      // No phone means we can't enforce confirmation through the SMS round-trip
      // (e.g. a future web-callable code path). Refuse rather than execute,
      // since the safety guarantee is the whole point of the gate.
      console.warn("MCP gate: high-risk tool called without phone — refusing", { name });
      return toolError("PERMISSION_DENIED", "This action requires explicit confirmation and cannot be executed without an SMS session.");
    }
    const action = await proposePendingAction({
      phone,
      userId:    input.userId as string | undefined,
      toolName:  name,
      toolInput: input,
    });
    console.info("MCP gate: proposed pending action", {
      phone,
      actionId: action.id,
      toolName: name,
      preview:  action.preview,
    });
    return buildPendingActionStub(action);
  }

  const nowIso = new Date().toISOString();
  const daysBack  = Math.min((input.daysBack as number) ?? 30, 90);
  const daysAgo   = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  try {
    switch (name) {
      case "get_senior_profile": {
        if (!input.seniorId) return toolError("INVALID_INPUT", "seniorId is required");
        const denied = await assertSeniorAccess(input.seniorId as string, input.clientId ?? input.userId);
        if (denied) return denied;
        logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_senior_profile").catch(() => {});
        const snap = await db.collection("seniors").doc(input.seniorId as string).get();
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
        const today = new Date().toISOString().slice(0, 10);
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
        const { phone, chatId, clientId } = input;
        if (!phone || !chatId || !clientId) return toolError("INVALID_INPUT", "phone, chatId, and clientId are required");
        logAudit({ eventType: "caregiver_matched", userId: clientId as string, data: { source: "mcp:find_replacement_caregivers" } }).catch(() => {});
        const sessionSnap    = await db.collection("agent_sessions").doc(phone as string).get();
        const session        = sessionSnap.data() ?? {};
        const clientSnap     = await db.collection("users").doc(clientId as string).get();
        const clientProfile  = clientSnap.data() ?? {};
        await runMatchingForClient(phone as string, chatId as string, session, clientProfile);
        return { success: true, triggered: true };
      }

      case "request_booking": {
        const { clientId, caregiverId, dates, startTime, endTime, phone } = input;
        if (!clientId || !caregiverId || !dates || !startTime || !endTime) {
          return toolError("INVALID_INPUT", "clientId, caregiverId, dates, startTime, endTime are required");
        }
        if (!phone) {
          return toolError("INVALID_INPUT", "phone is required (auto-injected from session)");
        }
        const dateList = (Array.isArray(dates) ? dates : [dates]) as string[];
        if (dateList.length === 0) return toolError("INVALID_INPUT", "at least one date is required");

        // Compute duration (hours) from "HH:MM" start/end times.
        const toMinutes = (t: string): number | null => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
          if (!m) return null;
          return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        };
        const startMin = toMinutes(startTime as string);
        const endMin   = toMinutes(endTime as string);
        if (startMin === null || endMin === null || endMin <= startMin) {
          return toolError("INVALID_INPUT", "startTime/endTime must be 'HH:MM' with end after start");
        }
        const durationHours = Math.round(((endMin - startMin) / 60) * 100) / 100;

        // Resolve caregiver name + rate from the caregiver doc.
        const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
        if (!cgSnap.exists) return toolError("NOT_FOUND", "caregiver not found");
        const cg = cgSnap.data() || {};
        const caregiverName = (cg.name ?? cg.fullName ?? "your caregiver") as string;
        const hourlyRate    = (typeof cg.hourlyRate === "number" ? cg.hourlyRate : 20) as number;

        const appointments = dateList.map((d) => ({
          date:          d,
          startTime:     startTime as string,
          endTime:       endTime as string,
          durationHours,
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
          caregiverName,
          appointments,
          hourlyRate,
        });
        if (!taskId) {
          // createBookingTask returns "" when it blocks the booking (e.g. bgcheck pending)
          // and has already messaged the family. Surface that to the agent.
          return { success: false, blocked: true, reason: "booking_blocked_pending_background_check" };
        }
        logBookingCreated(clientId as string, caregiverId as string, dateList).catch(() => {});
        return { success: true, taskId, status: "awaiting_approval" };
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
        // family's full editable memory context — the same blob Cara already
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
          context: context || "(no memory files on file yet — Cara is still building her picture of this family)",
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
        // agent_sessions; injected into Cara's system prompt at the start of each
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
        // Notify caregiver — surface success/failure so Cara doesn't claim
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

      case "get_caregiver_appointments": {
        if (!input.caregiverId) return toolError("INVALID_INPUT", "caregiverId is required");
        const daysAhead   = Math.min((input.daysAhead as number) ?? 7, 30);
        const today       = new Date().toISOString().slice(0, 10);
        const futureLimit = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
        const [taskSnap, interviewSnap] = await Promise.all([
          db.collection("agent_tasks")
            .where("clientId", "==", input.clientId)
            .where("status",   "in", ["awaiting_approval", "pending"])
            .limit(5)
            .get(),
          db.collection("interviews")
            .where("clientId", "==", input.clientId)
            .where("status",   "==", "awaiting_hire_decision")
            .limit(5)
            .get(),
        ]);
        const tasks      = taskSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const interviews = interviewSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const total      = tasks.length + interviews.length;
        return {
          success: true,
          total,
          tasks,
          interviews,
          summary: total === 0 ? "Nothing pending" : `${total} item(s) need your attention`,
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
        const {
          searchHealthcareProvider,
          fetchHealthcarePage,
          performBrowserAction,
          scheduleDoctorAppointment,
          requestPharmacyRefill,
          checkInsuranceAuthorization,
        } = await import("../browser/careWebActions");
        const { startCredentialCollection } = await import("../browser/credentialCollector");

        const task        = input.task        as string;
        const url         = input.url         as string | undefined;
        const actionType  = input.actionType  as "search" | "fetch" | "browse" | undefined;
        const loginAction = input.loginAction as "schedule_appointment" | "pharmacy_refill" | "insurance_check" | undefined;
        const userId2     = input.userId      as string;
        const phone2      = (input.phone      as string | undefined) ?? "unknown";
        const city        = input.city        as string | undefined;

        try {
          // ── Login-required portal actions ──────────────────────────────────
          if (loginAction) {
            switch (loginAction) {
              case "schedule_appointment": {
                const portalSvc = (input.portalService as string | undefined ?? "mychart") as import("../browser/credentialVault").PortalService;
                const result = await scheduleDoctorAppointment({
                  userId:          userId2,
                  phone:           phone2,
                  doctorName:      input.doctorName      as string ?? task,
                  specialty:       input.specialty       as string | undefined,
                  preferredDate:   input.preferredDate   as string | undefined,
                  appointmentType: input.appointmentType as string | undefined,
                  portalService:   portalSvc,
                });
                if (result.needsCredentials) {
                  await startCredentialCollection({
                    phone:   phone2,
                    userId:  userId2,
                    service: portalSvc,
                    reason:  `schedule an appointment with ${input.doctorName ?? "your doctor"}`,
                  });
                  return { status: "collecting_credentials" };
                }
                return result;
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

          // ── Public web actions ─────────────────────────────────────────────
          switch (actionType) {
            case "search": {
              const result = await searchHealthcareProvider({ userId: userId2, phone: phone2, query: task, city });
              return { found: result.found, summary: result.summary, results: result.results.slice(0, 3) };
            }

            case "fetch": {
              if (!url) return toolError("INVALID_INPUT", "url is required for fetch action");
              const result = await fetchHealthcarePage({ userId: userId2, phone: phone2, url });
              return { statusCode: result.statusCode, content: result.content.slice(0, 1500) };
            }

            case "browse": {
              const result = await performBrowserAction({ userId: userId2, phone: phone2, task, url, requiresLogin: false });
              return { success: result.success, result: result.result, sessionId: result.sessionId };
            }

            default:
              return toolError("INVALID_INPUT", "actionType or loginAction is required");
          }
        } catch (webErr) {
          console.error("[perform_web_action] error:", webErr);
          return { error: true, message: "I ran into a problem with that web action. Let me find the link for you instead." };
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

    if (name === "add_family_member") {
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
      await buildOrUpdateFamilyGroup(seniorId as string).catch(() => {});
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(
        memberPhone as string,
        `Hi - you've been added to ${seniorData.name ?? seniorData.seniorName ?? "your loved one's"} CareConnex care group. I'm Cara, and I'll send care updates here. You can text me questions anytime. Reply STOP to opt out.`,
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
      return { success: true, added: true, name: memberName, phone: memberPhone, notification };
    }

    if (name === "remove_family_member") {
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
      // confusion when their next inbound stops getting Cara replies.
      const { trySend } = await import("../utils/toolNotify");
      const notification = await trySend(
        targetPhone as string,
        "You've been removed from a CareConnex care group. You won't get further updates here. Text STOP anytime to unsubscribe completely.",
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
      logAudit({ eventType: "care_journal_created", userId: caregiverId as string, data: { source: "mcp:create_care_journal_entry", appointmentId, entryId: entryRef.id } }).catch(() => {});
      return { success: true, entryId: entryRef.id };
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
      const cgSnap3 = await db.collection("caregivers").doc(caregiverId as string).get();
      if (!cgSnap3.exists) return toolError("NOT_FOUND", "Caregiver not found");
      const cg3 = cgSnap3.data()!;
      if (!cg3.stripeAccountId) return toolError("INVALID_INPUT", "Stripe account not set up — complete onboarding first");
      if (!cg3.payoutsEnabled)  return toolError("INVALID_INPUT", "Payouts are not yet enabled on your account");
      const { getStripeClient } = await import("../stripe");
      const sc = getStripeClient();
      const balance = await sc.balance.retrieve({ stripeAccount: cg3.stripeAccountId as string });
      const availableCents = balance.available[0]?.amount ?? 0;
      if (availableCents <= 0) return toolError("INVALID_INPUT", "No available balance to pay out");
      const payoutCents = amountCents != null ? Number(amountCents) : availableCents;
      if (payoutCents > availableCents) return toolError("INVALID_INPUT", `Requested $${(payoutCents/100).toFixed(2)} exceeds available balance of $${(availableCents/100).toFixed(2)}`);
      await sc.payouts.create({ amount: payoutCents, currency: "usd", method: "instant" }, { stripeAccount: cg3.stripeAccountId as string });
      logAudit({ eventType: "instant_payout_requested", userId: caregiverId as string, data: { source: "mcp:request_instant_payout", amountCents: payoutCents } }).catch(() => {});
      return { success: true, amountCents: payoutCents, amountDollars: `$${(payoutCents/100).toFixed(2)}`, estimatedArrival: "within minutes" };
    }

    if (name === "submit_shift_hours") {
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
        paymentMethod: String(appt3.paymentMethod ?? "").toLowerCase().trim() === "cash" ? "cash" : "credit",
        status: "pending_client_review", submittedAt: nowIso,
        autoApproveAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
    }

    if (name === "review_shift_hours") {
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
      const { userId, userType, subject, description: ticketDesc, category } = input as Record<string, unknown>;
      if (!userId || !userType || !subject || !ticketDesc) return toolError("INVALID_INPUT", "userId, userType, subject, and description are required");
      const ticketRef = await db.collection("support_tickets").add({ userId, userType, subject, description: ticketDesc, category: category ?? "other", status: "open", source: "cara_sms", createdAt: nowIso, resolved: false });
      await db.collection("admin_alerts").add({ type: "support_ticket_created", ticketId: ticketRef.id, userId, userType, subject, priority: "medium", resolved: false, createdAt: nowIso });
      logAudit({ eventType: "support_ticket_created", userId: userId as string, data: { source: "mcp:create_support_ticket", ticketId: ticketRef.id, subject } }).catch(() => {});
      return { success: true, ticketId: ticketRef.id };
    }

    // ── schedule_interview ──────────────────────────────────────────────────
    if (name === "schedule_interview") {
      const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType } = input as Record<string, unknown>;
      if (!clientId || !caregiverId || !preferredDate || !preferredTime) return toolError("INVALID_INPUT", "clientId, caregiverId, preferredDate, and preferredTime are required");
      const scheduledTime = `${preferredDate}T${preferredTime}:00`;
      const ivRef = await db.collection("video_interviews").add({
        clientId,
        caregiverId,
        applicationId: applicationId ?? null,
        scheduledTime,
        interviewType:  interviewType ?? "video",
        status:        "scheduled",
        createdAt:      nowIso,
        feedbackSubmitted: false,
      });
      if (applicationId) {
        await db.collection("job_applications").doc(applicationId as string).update({ status: "interview_scheduled", interviewId: ivRef.id }).catch(() => {});
      }
      const cgSnap = await db.collection("caregivers").doc(caregiverId as string).get();
      const cgPhone = cgSnap.data()?.phone as string | undefined;
      let notification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "no_caregiver_phone" };
      if (cgPhone) {
        const clientSnap = await db.collection("users").doc(clientId as string).get();
        const clientName = clientSnap.data()?.name ?? "A family";
        const { trySend } = await import("../utils/toolNotify");
        notification = await trySend(cgPhone, `Interview scheduled! ${clientName} wants to meet ${preferredDate} at ${preferredTime}. Reply to confirm.`, "mcp:schedule_interview");
      }
      logAudit({ eventType: "interview_scheduled", userId: clientId as string, data: { source: "mcp:schedule_interview", interviewId: ivRef.id, caregiverId, scheduledTime, notificationSent: notification.sent } }).catch(() => {});
      return { success: true, interviewId: ivRef.id, scheduledTime, interviewType: interviewType ?? "video", notification };
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
      if (proposedDate && proposedTime) {
        upd.proposedTime = `${proposedDate}T${proposedTime}:00`;
      }
      await ivSnap.ref.update(upd);
      const clientSess = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
      if (!clientSess.empty) {
        const cgData = (await db.collection("caregivers").doc(caregiverId as string).get()).data();
        const cgName = cgData?.name ?? "The caregiver";
        const { sendToPhone } = await import("../linq/client");
        const notifyMsg = decision === "accept"
          ? `${cgName} confirmed the interview for ${iv.scheduledTime?.slice(0, 10) ?? "the scheduled time"}.`
          : proposedDate
            ? `${cgName} can't make the original time but is free ${proposedDate} at ${proposedTime ?? ""}.`
            : `${cgName} isn't available for the interview. ${(ivMsg as string) ?? ""}`.trim();
        await sendToPhone(clientSess.docs[0].id, notifyMsg).catch(() => {});
      }
      logAudit({ eventType: "interview_responded", userId: caregiverId as string, data: { source: "mcp:respond_to_interview_request", interviewId, decision } }).catch(() => {});
      return { success: true, decision, interviewId, proposedTime: proposedDate ? `${proposedDate}T${proposedTime}:00` : null };
    }

    // ── get_care_team ───────────────────────────────────────────────────────
    if (name === "get_care_team") {
      const { clientId } = input as Record<string, unknown>;
      if (!clientId) return toolError("INVALID_INPUT", "clientId is required");
      const today = new Date().toISOString().slice(0, 10);
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
          .where("status",      "in", ["confirmed", "in_progress", "completed"])
          .orderBy("date", "desc")
          .limit(5)
          .get();
        const eligible = activeOrRecent.docs.find((d) => {
          const data = d.data();
          const date = data.date as string | undefined;
          const status = data.status as string | undefined;
          // Confirmed/in-progress regardless of date; completed only if within 30 days.
          if (status === "confirmed" || status === "in_progress") return true;
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
          .where("status",      "in", ["confirmed", "in_progress", "completed"])
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
      const cg = cgSnap.data()!;
      if (!cg.stripeAccountId) return { success: true, payouts: [], message: "No payout account set up yet. Complete Stripe Connect onboarding to start receiving payouts." };
      try {
        const { getStripeClient } = await import("../stripe");
        const sc = getStripeClient();
        const payoutList = await sc.payouts.list({ limit: limit11 }, { stripeAccount: cg.stripeAccountId as string });
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
      return {
        success:          true,
        totalEarned:      Math.round(totalEarned * 100) / 100,
        pendingBalance:   cg5.pendingBalance    ?? 0,
        stripeSetup:      !!cg5.stripeAccountId,
        payoutsEnabled:   !!cg5.payoutsEnabled,
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
            const dayOfWeek = DAY_NAMES[new Date(scheduledDate).getDay()];
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
        const { sendOnboardingLink } = await import("../agents/onboardingConversation");
        const res = await sendOnboardingLink(phone as string, linkType as never);
        return { success: true, linkType: res.linkType, sent: true };
      } catch (err) {
        console.error("send_onboarding_link error:", err);
        return toolError("UNAVAILABLE", "Couldn't generate that link right now — try again in a moment.");
      }
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
      const { seniorId: cpSeniorId } = input as Record<string, string | undefined>;
      if (!cpSeniorId) return toolError("INVALID_INPUT", "seniorId is required");
      const cpLimit = Math.min((input.limit as number) ?? 5, 10);
      const cpSnap = await db.collection("senior_profiles").doc(cpSeniorId)
        .collection("carePlanVersions")
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
      const { seniorId: rSeniorId, versionId: rVersionId, clientId: rClientId } = input as Record<string, string | undefined>;
      if (!rSeniorId || !rVersionId || !rClientId) return toolError("INVALID_INPUT", "seniorId, versionId, and clientId are required");
      const rSenior = await db.collection("senior_profiles").doc(rSeniorId).get();
      if (!rSenior.exists) return toolError("NOT_FOUND", "Senior not found");
      const rVersionDoc = await db.collection("senior_profiles").doc(rSeniorId)
        .collection("carePlanVersions").doc(rVersionId).get();
      if (!rVersionDoc.exists) return toolError("NOT_FOUND", "Version not found");
      const rVersionData = rVersionDoc.data()!;
      // Save current plan as a version before restoring
      const rCurrentPlan = await db.collection("senior_profiles").doc(rSeniorId)
        .collection("care_plans").doc("active").get();
      if (rCurrentPlan.exists) {
        await db.collection("senior_profiles").doc(rSeniorId)
          .collection("carePlanVersions").add({
            ...rCurrentPlan.data(),
            savedAt:   nowIso,
            changedBy: rClientId,
            summary:   "Auto-saved before restore",
          });
      }
      // Restore the selected version
      await db.collection("senior_profiles").doc(rSeniorId)
        .collection("care_plans").doc("active").set(rVersionData.carePlan ?? rVersionData);
      logAudit({ eventType: "care_plan_restored", userId: rClientId, data: { source: "mcp:restore_care_plan_version", seniorId: rSeniorId, versionId: rVersionId } }).catch(() => {});
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

    return toolError("INVALID_INPUT", `Unknown tool: ${name}`);
  } catch (err) {
    console.error(`handleToolCall [${name}] error:`, err);
    return toolError("UNAVAILABLE", `Tool ${name} is temporarily unavailable`);
  }
}
