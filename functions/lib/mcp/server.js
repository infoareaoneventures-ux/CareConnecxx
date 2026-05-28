"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_PROMPTS = exports.MCP_RESOURCE_TEMPLATES = exports.CAREGIVER_TOOLS = exports.MCP_TOOLS = void 0;
exports.handleToolCallForCaregiver = handleToolCallForCaregiver;
exports.handleResourceRead = handleResourceRead;
exports.handlePromptGet = handlePromptGet;
exports.handleToolCall = handleToolCall;
const admin = __importStar(require("firebase-admin"));
const matchingAgent_1 = require("../agents/matchingAgent");
const auditLog_1 = require("../observability/auditLog");
const memoryFiles_1 = require("../memory/memoryFiles");
const preferences_1 = require("../memory/preferences");
const pendingActions_1 = require("../agents/pendingActions");
const ephemeralSubAgents_1 = require("../agents/ephemeralSubAgents");
const db = admin.firestore();
exports.MCP_TOOLS = [
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
                limit: { type: "number", description: "Number of entries to return (default 5)" },
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
                limit: { type: "number", description: "Max reviews to return (default 5)" },
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
                dates: { type: "array", items: { type: "string" }, description: "ISO date strings (YYYY-MM-DD)" },
                startTime: { type: "string", description: "e.g. '09:00'" },
                endTime: { type: "string", description: "e.g. '17:00'" },
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
                userId: { type: "string" },
                dndEnabled: { type: "boolean" },
                dndStart: { type: "string", description: "HH:MM e.g. '22:00'" },
                dndEnd: { type: "string", description: "HH:MM e.g. '08:00'" },
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
                seniorId: { type: "string" },
                signalType: { type: "string", description: "e.g. 'falls', 'appetite_loss', 'confusion'" },
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
                file: { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
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
                userId: { type: "string", description: "The user's ID" },
                file: { type: "string", description: "One of: profile, health, family, recent_episodes, procedural" },
                content: { type: "string", description: "Markdown content to append to the file" },
            },
            required: ["userId", "file", "content"],
        },
    },
    {
        name: "edit_memory_file",
        description: "Surgically correct a stored fact in one of Cara's memory files by find/replace, instead of appending a duplicate. " +
            "Use when a previously stored detail changes (e.g. the family says 'Mom is 82, not 78'). Returns how many occurrences were replaced.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The user's ID" },
                file: { type: "string", description: "Memory file slug (e.g. profile, health, family, recent_episodes, procedural)" },
                find: { type: "string", description: "Exact text currently in the file to replace" },
                replace: { type: "string", description: "Replacement text" },
            },
            required: ["userId", "file", "find", "replace"],
        },
    },
    {
        name: "search_memory",
        description: "Search across all of a user's long-term memory files for a keyword or phrase and return the matching sections. " +
            "Use to retrieve a specific remembered detail without loading every memory file.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The user's ID" },
                query: { type: "string", description: "Keyword or phrase to search for" },
            },
            required: ["userId", "query"],
        },
    },
    {
        name: "write_todos",
        description: "Scaffold a checklist of the steps you intend to take in this conversation. Use when the family's request has 3+ distinct steps " +
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
                            task: { type: "string" },
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
        description: "Return a clean digest of everything Cara remembers about this family — senior profile, " +
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
        description: (0, ephemeralSubAgents_1.buildTaskToolDescription)(),
        input_schema: {
            type: "object",
            properties: {
                description: { type: "string", description: "The specific work the sub-agent should do. Include all the context the sub-agent needs — it does not see the conversation history." },
                subagent_type: { type: "string", enum: (0, ephemeralSubAgents_1.getPublicSubAgentNames)(), description: "Which sub-agent to delegate to." },
            },
            required: ["description", "subagent_type"],
        },
    },
    {
        name: "cancel_appointment",
        description: "Cancel a confirmed appointment on behalf of the client. " +
            "IMPORTANT: Only call this after the family has explicitly confirmed they want to cancel (e.g. they said 'yes cancel it' or 'go ahead'). Never call without explicit confirmation.",
        input_schema: {
            type: "object",
            properties: {
                appointmentId: { type: "string", description: "The Firestore document ID of the appointment" },
                clientId: { type: "string", description: "The client's user ID (for ownership check)" },
                reason: { type: "string", description: "Optional reason (e.g. 'client_request', 'plans changed')" },
            },
            required: ["appointmentId", "clientId"],
        },
    },
    {
        name: "send_caregiver_message",
        description: "Send a message to a caregiver on behalf of the family. Use when the family asks you to relay something to the caregiver. " +
            "Tell the family what you're sending before you call this tool.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                message: { type: "string", description: "The message text to send to the caregiver" },
                clientId: { type: "string", description: "The client's user ID (for audit log)" },
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
        description: "Create a personal recurring reminder for the user. Use when the family asks Cara to remind them of something on a schedule. " +
            "Confirm the schedule with the family before calling.",
        input_schema: {
            type: "object",
            properties: {
                phone: { type: "string" },
                userId: { type: "string" },
                label: { type: "string", description: "Short name for the reminder, e.g. 'mom medications'" },
                recurrence: { type: "string", description: "One of: daily, weekly, monthly, once" },
                dayOfWeek: { type: "number", description: "0=Sun … 6=Sat — only for weekly recurrence" },
                hour: { type: "number", description: "24-hour format, 0–23" },
                minute: { type: "number", description: "0–59" },
                message: { type: "string", description: "The full text Cara will send as the reminder" },
            },
            required: ["phone", "userId", "label", "recurrence", "hour", "minute", "message"],
        },
    },
    {
        name: "schedule_followup",
        description: "Schedule a one-time proactive follow-up message to send to the family at a future time. " +
            "Use this when the family mentions a future event (doctor appointment, test results, family visit, procedure) and a check-in would be natural. " +
            "Examples: 'Mom has her MRI Thursday' → schedule a follow-up Friday morning. 'We're trying a new medication this week' → schedule 3 days out. " +
            "Do NOT use for recurring reminders (use create_reminder instead). Do NOT schedule without a clear reason.",
        input_schema: {
            type: "object",
            properties: {
                phone: { type: "string", description: "The family's phone number" },
                userId: { type: "string", description: "The family's user ID" },
                message: { type: "string", description: "The exact text Cara will send as the follow-up" },
                scheduledAt: { type: "string", description: "ISO 8601 datetime for when to send (e.g. '2026-05-20T09:00:00.000Z')" },
                reason: { type: "string", description: "One-sentence reason why this follow-up makes sense (for context at fire time)" },
            },
            required: ["phone", "userId", "message", "scheduledAt", "reason"],
        },
    },
    {
        name: "resume_execution_agent",
        description: "Route a family message to an active background execution agent (e.g. a matching agent that presented caregivers). " +
            "Use this when the family is asking a follow-up question about an ongoing task — 'tell me more about the second one', " +
            "'what's her experience with dementia?', 'what's her rate again?'. " +
            "The agent has full context of the task. Return its response EXACTLY as-is, without rephrasing or adding to it.",
        input_schema: {
            type: "object",
            properties: {
                agentId: { type: "string", description: "The execution agent document ID from ACTIVE EXECUTION AGENT context" },
                input: { type: "string", description: "The family's message to pass to the agent" },
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
                phone: { type: "string", description: "The user's phone number" },
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
                daysAhead: { type: "number", description: "How many days ahead to look (default 7, max 30)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_pending_tasks",
        description: "Check for items that need the family's attention — pending booking approvals, " +
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
        description: "Fast web search for information about healthcare providers, pharmacies, " +
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
        description: "Browse the web or take action on websites on behalf of the family. " +
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
                userId: { type: "string", description: "The user's Firestore ID" },
                phone: { type: "string", description: "The user's phone number" },
                city: { type: "string", description: "City for location-specific searches" },
                doctorName: { type: "string", description: "Doctor name for appointment scheduling" },
                specialty: { type: "string", description: "Doctor specialty" },
                preferredDate: { type: "string", description: "Preferred date e.g. 'next Tuesday', 'May 20'" },
                appointmentType: { type: "string", description: "e.g. 'follow-up', 'annual physical'" },
                portalService: { type: "string", description: "Portal to use: mychart, athenahealth, followmyhealth" },
                pharmacyService: {
                    type: "string",
                    enum: ["cvs", "walgreens", "riteaid"],
                    description: "Pharmacy for refill requests",
                },
                medicationName: { type: "string", description: "Medication name for refill" },
                rxNumber: { type: "string", description: "Rx number for direct refill lookup" },
                insurer: { type: "string", description: "Insurance company name e.g. 'Aetna', 'UnitedHealthcare'" },
                checkType: {
                    type: "string",
                    enum: ["coverage", "authorization", "claim_status"],
                    description: "Type of insurance check",
                },
                referenceNumber: { type: "string", description: "Prior auth or claim reference number" },
                seniorName: { type: "string", description: "Senior's name when account has multiple members" },
            },
            required: ["task", "userId"],
        },
    },
    {
        name: "manage_credentials",
        description: "Manage stored portal login credentials for this user. " +
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
                userId: { type: "string", description: "The user's Firestore ID" },
                service: { type: "string", description: "Service key e.g. mychart, cvs, walgreens" },
            },
            required: ["action", "userId"],
        },
    },
    {
        name: "suggest_upcoming_care",
        description: "Check if the client has upcoming care coverage and whether a preferred caregiver has availability. " +
            "Call this when the family is chatting casually and you want to proactively surface a relevant booking opportunity. " +
            "Returns: hasVisitNextWeek (boolean), preferredCaregiverAvailable (boolean), caregiverName, suggestedDate.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                phone: { type: "string", description: "The client's phone number" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "get_care_plan",
        description: "Get the structured care plan for a senior — includes medications, care needs, doctor contacts, dietary notes, and any special instructions. " +
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
        description: "Update the care plan for a senior. Use when the family reports a change: new medication, updated dosage, new diagnosis, dietary change, or special instructions. " +
            "Always confirm the change with the family before calling. Tell them what you're updating.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                field: { type: "string", description: "Which field to update: 'medications', 'careNeeds', 'dietaryNotes', 'doctorContacts', 'specialInstructions', or 'notes'" },
                value: { description: "The new value. For array fields (medications, careNeeds, doctorContacts), pass an array. For string fields, pass a string." },
                action: { type: "string", enum: ["set", "append", "remove"], description: "set = replace, append = add to array, remove = remove from array" },
            },
            required: ["clientId", "field", "value", "action"],
        },
    },
    {
        name: "update_caregiver_profile",
        description: "Update your own caregiver profile — hourly rate, bio, phone, city, or weekly availability. " +
            "Only you can update your own profile. Changes take effect immediately.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "Your caregiver Firestore document ID" },
                hourlyRate: { type: "number", description: "Your new hourly rate in dollars" },
                bio: { type: "string", description: "Your updated bio (max 2500 characters)" },
                phone: { type: "string", description: "Your new phone number" },
                city: { type: "string", description: "Your city" },
                weeklyAvailability: { type: "object", description: "Object mapping day abbreviations to time windows" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "add_family_member",
        description: "Add a new family member to this care group. They receive a welcome SMS and start getting updates. " +
            "Only the primary client can add members.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's profile document ID" },
                name: { type: "string", description: "The new member's name" },
                phone: { type: "string", description: "The new member's phone number" },
                clientId: { type: "string", description: "The primary client's user ID" },
            },
            required: ["seniorId", "name", "phone", "clientId"],
        },
    },
    {
        name: "remove_family_member",
        description: "Remove a family member from this care group. They stop receiving updates. " +
            "IMPORTANT: Only call after the primary client has explicitly confirmed.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's profile document ID" },
                phone: { type: "string", description: "Phone number of the member to remove" },
                clientId: { type: "string", description: "The primary client's user ID" },
            },
            required: ["seniorId", "phone", "clientId"],
        },
    },
    {
        name: "submit_review",
        description: "Submit a public star rating and optional comment for a caregiver after a completed visit. " +
            "Rating must be 1–5. One review per appointment.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                appointmentId: { type: "string", description: "The appointment document ID being reviewed" },
                clientId: { type: "string", description: "The client's user ID" },
                rating: { type: "integer", minimum: 1, maximum: 5, description: "Star rating 1–5" },
                comment: { type: "string", description: "Optional written comment" },
            },
            required: ["caregiverId", "appointmentId", "clientId", "rating"],
        },
    },
    {
        name: "cancel_subscription",
        description: "Cancel the family's CareConnex membership. Cancels at end of billing period — scheduled visits are unaffected. " +
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
        description: "Reverse a pending subscription cancellation. Keeps the membership active through the billing period.",
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
        description: "Pause, resume, or cancel a recurring care schedule. " +
            "Cancel removes all future confirmed visits — confirm with family first.",
        input_schema: {
            type: "object",
            properties: {
                scheduleId: { type: "string", description: "The recurring_schedules document ID" },
                clientId: { type: "string", description: "The client's user ID" },
                action: { type: "string", enum: ["pause", "resume", "cancel"], description: "Action to take" },
                pauseReason: { type: "string", description: "Optional reason for pausing" },
            },
            required: ["scheduleId", "clientId", "action"],
        },
    },
    {
        name: "update_senior_profile",
        description: "Update specific fields on the senior's profile — emergency contact, physician, diagnoses, or allergies. " +
            "Confirm before calling.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's profile document ID" },
                clientId: { type: "string", description: "The client's user ID" },
                field: {
                    type: "string",
                    enum: ["emergencyContactName", "emergencyContactPhone", "primaryPhysicianName", "primaryPhysicianPhone", "diagnoses", "allergies"],
                    description: "Which field to update",
                },
                value: { description: "New value. String for contact/physician fields; string for array append/remove." },
                action: { type: "string", enum: ["set", "arrayUnion", "arrayRemove"], description: "set = replace, arrayUnion = add to array, arrayRemove = remove from array" },
            },
            required: ["seniorId", "clientId", "field", "value", "action"],
        },
    },
    {
        name: "reschedule_appointment",
        description: "Move an existing confirmed appointment to a new date and/or time. " +
            "Checks caregiver availability. Confirm with family before calling.",
        input_schema: {
            type: "object",
            properties: {
                appointmentId: { type: "string", description: "Appointment document ID to reschedule" },
                clientId: { type: "string", description: "The client's user ID" },
                newDate: { type: "string", description: "New date in YYYY-MM-DD format" },
                newTime: { type: "string", description: "New start time in HH:MM format" },
            },
            required: ["appointmentId", "clientId", "newDate", "newTime"],
        },
    },
    {
        name: "create_care_journal_entry",
        description: "Create a care journal entry after a visit — notes, mood, whether medications were given, activities. " +
            "Used by caregivers to log what happened during the shift.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "Your caregiver document ID" },
                appointmentId: { type: "string", description: "The appointment document ID" },
                notes: { type: "string", description: "Visit notes" },
                mood: { type: "string", enum: ["good", "fair", "poor"], description: "Senior's mood during visit" },
                medsGiven: { type: "boolean", description: "Whether medications were administered" },
                activities: { type: "array", items: { type: "string" }, description: "Activities done during the visit" },
            },
            required: ["caregiverId", "appointmentId", "notes"],
        },
    },
    {
        name: "apply_to_job",
        description: "Apply to an open job post. Optionally include a proposed hourly rate and a short cover note.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "Your caregiver document ID" },
                jobId: { type: "string", description: "The job_posts document ID" },
                proposedRate: { type: "number", description: "Your proposed hourly rate" },
                coverNote: { type: "string", description: "Brief cover note to the client" },
            },
            required: ["caregiverId", "jobId"],
        },
    },
    {
        name: "respond_to_job_application",
        description: "Accept or reject a caregiver's application to your job post. " +
            "Confirm before accepting — this notifies the caregiver and marks the job filled.",
        input_schema: {
            type: "object",
            properties: {
                applicationId: { type: "string", description: "The job_applications document ID" },
                clientId: { type: "string", description: "The client's user ID" },
                decision: { type: "string", enum: ["accept", "reject"], description: "accept or reject" },
                message: { type: "string", description: "Optional message to the caregiver" },
            },
            required: ["applicationId", "clientId", "decision"],
        },
    },
    {
        name: "submit_interview_feedback",
        description: "Submit your decision after interviewing a caregiver. " +
            "Options: 'strong' (proceed to hire), 'maybe' (keep considering), 'no' (not a fit).",
        input_schema: {
            type: "object",
            properties: {
                interviewId: { type: "string", description: "The video_interviews document ID" },
                clientId: { type: "string", description: "The client's user ID" },
                fitLevel: { type: "string", enum: ["strong", "maybe", "no"], description: "Fit assessment" },
                notes: { type: "string", description: "Optional notes" },
            },
            required: ["interviewId", "clientId", "fitLevel"],
        },
    },
    {
        name: "request_instant_payout",
        description: "Request an instant payout of your earned balance. A 1.5% processing fee applies. " +
            "If no amount specified, requests full available balance.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "Your caregiver document ID" },
                amountCents: { type: "integer", description: "Amount in cents (optional — omit for full balance)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "submit_shift_hours",
        description: "Submit your actual clock-in and clock-out times for a completed visit. " +
            "The client will review and approve before payment is processed.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "Your caregiver document ID" },
                appointmentId: { type: "string", description: "The appointment document ID" },
                clockInTime: { type: "string", description: "Clock-in time in HH:MM format" },
                clockOutTime: { type: "string", description: "Clock-out time in HH:MM format" },
                breakMinutes: { type: "integer", description: "Break duration in minutes (default 0)" },
            },
            required: ["caregiverId", "appointmentId", "clockInTime", "clockOutTime"],
        },
    },
    {
        name: "review_shift_hours",
        description: "Approve or dispute a caregiver's submitted shift hours. " +
            "If disputing, provide the corrected duration in hours.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                appointmentId: { type: "string", description: "The appointment document ID" },
                decision: { type: "string", enum: ["approve", "dispute"], description: "approve or dispute" },
                correctedHours: { type: "number", description: "Corrected duration in hours (required when disputing)" },
                reason: { type: "string", description: "Reason for dispute" },
            },
            required: ["clientId", "appointmentId", "decision"],
        },
    },
    {
        name: "create_support_ticket",
        description: "Create a support ticket for an issue that needs human team follow-up. " +
            "The support team will respond within 24 hours.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "Your user ID" },
                userType: { type: "string", enum: ["client", "caregiver"], description: "client or caregiver" },
                subject: { type: "string", description: "Short subject line" },
                description: { type: "string", description: "Full description of the issue" },
                category: { type: "string", enum: ["billing", "booking", "caregiver", "technical", "other"], description: "Issue category" },
            },
            required: ["userId", "userType", "subject", "description"],
        },
    },
    // ── Full-platform coverage tools ─────────────────────────────────────────
    {
        name: "schedule_interview",
        description: "Schedule a video interview between a client and a caregiver applicant. " +
            "Notifies the caregiver and creates the interview record. Confirm date/time with client before calling.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                applicationId: { type: "string", description: "The job_applications document ID (optional)" },
                preferredDate: { type: "string", description: "Date in YYYY-MM-DD format" },
                preferredTime: { type: "string", description: "Time in HH:MM (24h) format" },
                interviewType: { type: "string", enum: ["video", "phone", "in_person"], description: "Default: video" },
            },
            required: ["clientId", "caregiverId", "preferredDate", "preferredTime"],
        },
    },
    {
        name: "respond_to_interview_request",
        description: "Caregiver accepts or declines a scheduled interview. If proposing a new time, include proposedDate and proposedTime.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                interviewId: { type: "string", description: "The video_interviews document ID" },
                decision: { type: "string", enum: ["accept", "decline"], description: "accept or decline" },
                proposedDate: { type: "string", description: "Alternative date YYYY-MM-DD (when declining with counter-offer)" },
                proposedTime: { type: "string", description: "Alternative time HH:MM (when declining with counter-offer)" },
                message: { type: "string", description: "Optional message to the client" },
            },
            required: ["caregiverId", "interviewId", "decision"],
        },
    },
    {
        name: "get_care_team",
        description: "List a client's confirmed/active caregivers — their name, phone, rating, and next scheduled visit.",
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
        description: "Get a client's past shift invoices — caregiver name, date, hours worked, amount, and payment status.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                limit: { type: "number", description: "Number of invoices to return (default 5, max 20)" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "get_invoice_details",
        description: "Get a detailed itemized breakdown of a client's invoice — each visit with date, caregiver, hours, rate, and amount. Use when client asks to see their bill.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                invoiceId: { type: "string", description: "Specific invoice ID (optional — omit for most recent)" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "create_refund_request",
        description: "Submit a refund request for a completed visit. Creates a pending refund for admin review. Only call after client has confirmed which visit and agreed to submit.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                appointmentId: { type: "string", description: "The appointment document ID to refund" },
                reason: { type: "string", description: "Reason for refund (optional)" },
            },
            required: ["clientId", "appointmentId"],
        },
    },
    {
        name: "get_care_plan_history",
        description: "Get the revision history of a senior's care plan — who changed what and when. Returns up to 10 versions.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's profile document ID" },
                limit: { type: "number", description: "Number of versions to return (default 5, max 10)" },
            },
            required: ["seniorId"],
        },
    },
    {
        name: "restore_care_plan_version",
        description: "Restore a previous version of the care plan. Confirm with the client before calling — this replaces the current care plan.",
        input_schema: {
            type: "object",
            properties: {
                seniorId: { type: "string", description: "The senior's profile document ID" },
                versionId: { type: "string", description: "The carePlanVersions document ID to restore" },
                clientId: { type: "string", description: "The client's user ID (ownership check)" },
            },
            required: ["seniorId", "versionId", "clientId"],
        },
    },
    {
        name: "edit_job_post",
        description: "Edit an existing open job post. Only call after client has confirmed what to change. " +
            "Cannot change status — use cancel_job_post for that.",
        input_schema: {
            type: "object",
            properties: {
                jobId: { type: "string", description: "The job_posts document ID" },
                clientId: { type: "string", description: "The client's user ID (ownership check)" },
                rate: { type: "number", description: "New hourly rate" },
                description: { type: "string", description: "New job description" },
                startDate: { type: "string", description: "New start date YYYY-MM-DD" },
                daysOfWeek: { type: "array", items: { type: "string" }, description: "New days array" },
                timeOfDay: { type: "array", items: { type: "string" }, description: "New time-of-day array" },
                paymentMethod: { type: "string", enum: ["card", "cash"], description: "New payment method" },
            },
            required: ["jobId", "clientId"],
        },
    },
    {
        name: "send_client_message",
        description: "Send a message to a client on behalf of a caregiver. Tell the caregiver what you're sending before calling.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                clientId: { type: "string", description: "The client's user ID (optional — resolved from recent appointments if omitted)" },
                message: { type: "string", description: "The message to send to the client" },
            },
            required: ["caregiverId", "message"],
        },
    },
    {
        name: "get_payout_history",
        description: "Get a caregiver's recent payout records — dates, amounts, and transfer status from Stripe.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                limit: { type: "number", description: "Number of payouts to return (default 5, max 20)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_recent_messages",
        description: "Get the most recent inbox messages between the user and their caregiver(s) or client(s). " +
            "Use when the user asks what was said, wants to catch up on messages, or references a prior conversation.",
        input_schema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "The current user's ID (client or caregiver)" },
                counterpartId: { type: "string", description: "Specific caregiver or client ID to filter (optional)" },
                limit: { type: "number", description: "Messages per thread to return (default 5, max 20)" },
            },
            required: ["userId"],
        },
    },
    // ── Platform-action tools (post-onboarding) ───────────────────────────────
    {
        name: "list_client_jobs",
        description: "List job posts created by this client. Returns open, filled, and closed postings with applicant counts.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                status: { type: "string", enum: ["open", "filled", "closed", "all"], description: "Filter by status (default: all)" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "cancel_job_post",
        description: "Close an open job post. Only call after the client has explicitly confirmed they want to close it.",
        input_schema: {
            type: "object",
            properties: {
                jobId: { type: "string", description: "The job_posts document ID" },
                clientId: { type: "string", description: "The client's user ID (ownership check)" },
            },
            required: ["jobId", "clientId"],
        },
    },
    {
        name: "list_job_applicants",
        description: "List caregivers who applied to one of the client's job posts. Returns name, proposed rate, cover note, and status.",
        input_schema: {
            type: "object",
            properties: {
                jobId: { type: "string", description: "The job_posts document ID" },
                clientId: { type: "string", description: "The client's user ID (access check)" },
            },
            required: ["jobId", "clientId"],
        },
    },
    {
        name: "get_caregiver_earnings",
        description: "Get an earnings summary for a caregiver — total earned, pending balance, and recent visit count.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                daysBack: { type: "number", description: "Days of history to include (default 30, max 90)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "update_caregiver_availability",
        description: "Add or remove days from a caregiver's weekly availability. Changes take effect immediately for job matching.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                availableDays: { type: "array", items: { type: "string" }, description: "Days to add (Monday, Tuesday, etc.)" },
                unavailableDays: { type: "array", items: { type: "string" }, description: "Days to remove from availability" },
                preferredTimeOfDay: { type: "string", description: "Preferred time: morning, afternoon, evening, overnight, or flexible" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "browse_job_board",
        description: "Show open care jobs that a caregiver can apply to. Returns up to 5 matching jobs with care needs, schedule, and rate.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                limit: { type: "number", description: "Max jobs to return (default 5, max 10)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_job_recommendations",
        description: "Get ranked job recommendations for a caregiver — sorted by match percentage based on their skills, " +
            "availability, and rate. Better than browse_job_board when the caregiver wants personalized suggestions.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                limit: { type: "number", description: "Number of recommendations (default 5, max 10)" },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "submit_gps_checkin",
        description: "Submit a GPS-validated check-in for a caregiver arriving at a care visit. " +
            "Verifies the caregiver is within 200m of the address and notifies the family.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                appointmentId: { type: "string", description: "The appointment document ID" },
                latitude: { type: "number", description: "Caregiver's current latitude" },
                longitude: { type: "number", description: "Caregiver's current longitude" },
            },
            required: ["caregiverId", "appointmentId", "latitude", "longitude"],
        },
    },
    {
        name: "get_tax_summary",
        description: "Get a caregiver's annual earnings summary for tax purposes (1099-NEC). " +
            "Shows total earnings, hours, visit count, quarterly breakdown, and whether they meet the $600 threshold for a 1099.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The caregiver's Firestore document ID" },
                year: { type: "number", description: "Tax year (e.g. 2024). Defaults to current year." },
            },
            required: ["caregiverId"],
        },
    },
    {
        name: "get_my_applications",
        description: "Get a caregiver's submitted job applications and their current status (pending, accepted, rejected).",
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
        description: "List shift-hour submissions awaiting client approval. Returns caregiver name, date, hours, and amount owed.",
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
        description: "Get recent care journal entries for a client's senior — resolves the senior automatically from clientId. " +
            "Returns notes, mood, activities, and caregiver name for each entry.",
        input_schema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "The client's user ID" },
                limit: { type: "number", description: "Number of entries (default 5, max 20)" },
            },
            required: ["clientId"],
        },
    },
    {
        name: "modify_recurring_schedule",
        description: "Change the days and/or times of an active recurring care schedule. " +
            "Cancels future appointments from the old schedule and generates new ones with the updated days/times. " +
            "Confirm with the client before calling.",
        input_schema: {
            type: "object",
            properties: {
                scheduleId: { type: "string", description: "The recurring_schedules document ID" },
                clientId: { type: "string", description: "The client's user ID (ownership check)" },
                newDays: { type: "array", items: { type: "string" }, description: "New days of the week (e.g. ['Tuesday','Thursday']). Omit to keep current days." },
                newStartTime: { type: "string", description: "New start time HH:MM. Omit to keep current start time." },
                newEndTime: { type: "string", description: "New end time HH:MM. Omit to keep current end time." },
            },
            required: ["scheduleId", "clientId"],
        },
    },
    {
        name: "get_payment_update_link",
        description: "Generate a Stripe Billing Portal link for the client to securely update their payment method. " +
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
        name: "request_shift_swap",
        description: "Initiate a shift swap request for a caregiver — finds available peer caregivers and broadcasts the coverage request. Only call after caregiver has confirmed which shift needs coverage.",
        input_schema: {
            type: "object",
            properties: {
                caregiverId: { type: "string", description: "The requesting caregiver's ID" },
                appointmentId: { type: "string", description: "The appointment that needs coverage" },
                reason: { type: "string", description: "Reason for swap (optional)" },
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
                caregiverId: { type: "string", description: "The accepting caregiver's ID" },
                caregiverName: { type: "string", description: "The accepting caregiver's name" },
                swapRequestId: { type: "string", description: "The shift_swap_requests document ID" },
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
                caregiverId: { type: "string", description: "The requesting caregiver's ID" },
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
                clientId: { type: "string", description: "The client's user ID" },
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
                userId: { type: "string", description: "The user's ID" },
                firstName: { type: "string", description: "New first name (optional)" },
                lastName: { type: "string", description: "New last name (optional)" },
                phone: { type: "string", description: "New phone number in E.164 format, e.g. +15555550100 (optional)" },
                address: { type: "string", description: "New street address (optional)" },
                city: { type: "string", description: "New city (optional)" },
                state: { type: "string", description: "New state (optional)" },
                zip: { type: "string", description: "New ZIP code (optional)" },
                photoUrl: { type: "string", description: "New profile photo URL (optional)" },
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
                userId: { type: "string", description: "The user's ID" },
                newsletter: { type: "boolean", description: "Receive the CareConnex newsletter" },
                newMatchAlerts: { type: "boolean", description: "Notify when new caregiver matches are found" },
                reviewNotifications: { type: "boolean", description: "Notify when caregivers receive reviews" },
                privacyShowBookings: { type: "boolean", description: "Show the family's booking calendar to caregivers" },
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
                userId: { type: "string", description: "The user's ID" },
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
                clientId: { type: "string", description: "The client's user ID" },
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
                clientId: { type: "string", description: "The client's user ID" },
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
                userId: { type: "string", description: "The blocking user's ID (the family)" },
                targetUserId: { type: "string", description: "The user being blocked" },
                reason: { type: "string", description: "Optional reason (helps ops triage)" },
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
                userId: { type: "string", description: "The unblocking user's ID" },
                targetUserId: { type: "string", description: "The user to unblock" },
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
                userId: { type: "string", description: "The reporting user's ID" },
                targetUserId: { type: "string", description: "The reported user's ID" },
                category: { type: "string", description: "One of: harassment, scam, safety_concern, inappropriate_content, other" },
                description: { type: "string", description: "Short description of what happened" },
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
                userId: { type: "string", description: "The user liking the entry" },
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
                userId: { type: "string", description: "The user removing the like" },
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
                userId: { type: "string", description: "The user commenting" },
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
]);
exports.CAREGIVER_TOOLS = exports.MCP_TOOLS.filter(t => CAREGIVER_TOOL_NAMES.has(t.name));
async function handleToolCallForCaregiver(name, input) {
    if (name === "perform_web_action" && input.loginAction) {
        return { _toolError: true, message: "Login-required web actions are not available for caregivers." };
    }
    return handleToolCall(name, input);
}
exports.MCP_RESOURCE_TEMPLATES = [
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
async function handleResourceRead(uri, params) {
    var _a, _b, _c, _d;
    // cara://user/{userId}/preferences
    const prefMatch = uri.match(/^cara:\/\/user\/([^/]+)\/preferences$/);
    if (prefMatch) {
        const userId = (_a = params.userId) !== null && _a !== void 0 ? _a : prefMatch[1];
        const prefs = await (0, preferences_1.getPreferences)(userId).catch(() => null);
        if (!prefs)
            return null;
        return { uri, mimeType: "application/json", text: JSON.stringify(prefs) };
    }
    // cara://senior/{seniorId}/profile
    const seniorMatch = uri.match(/^cara:\/\/senior\/([^/]+)\/profile$/);
    if (seniorMatch) {
        const seniorId = (_b = params.seniorId) !== null && _b !== void 0 ? _b : seniorMatch[1];
        const snap = await db.collection("seniors").doc(seniorId).get();
        if (!snap.exists)
            return null;
        return { uri, mimeType: "application/json", text: JSON.stringify(snap.data()) };
    }
    // cara://user/{userId}/memory/{file}
    const memMatch = uri.match(/^cara:\/\/user\/([^/]+)\/memory\/([^/]+)$/);
    if (memMatch) {
        const userId = (_c = params.userId) !== null && _c !== void 0 ? _c : memMatch[1];
        const file = ((_d = params.file) !== null && _d !== void 0 ? _d : memMatch[2]);
        const VALID = new Set(["profile", "health", "family", "recent_episodes", "procedural"]);
        if (!VALID.has(file))
            return null;
        const content = await (0, memoryFiles_1.readMemoryFile)(userId, file).catch(() => null);
        if (content == null)
            return null;
        return { uri, mimeType: "application/json", text: JSON.stringify({ file, content }) };
    }
    return null;
}
exports.MCP_PROMPTS = [
    {
        name: "weekly-care-summary",
        description: "Sunday morning digest — summarizes the week's care visits and previews the upcoming week.",
        arguments: [
            { name: "clientName", description: "Family member's first name", required: true },
            { name: "seniorName", description: "Senior's name", required: true },
            { name: "completedCount", description: "Number of completed visits", required: true },
            { name: "journalContext", description: "Formatted journal entry lines", required: true },
            { name: "apptContext", description: "Upcoming appointment lines", required: true },
        ],
    },
    {
        name: "morning-caregiver-briefing",
        description: "Pre-shift briefing sent to caregivers on the morning of a visit.",
        arguments: [
            { name: "caregiverName", description: "Caregiver's first name", required: true },
            { name: "seniorName", description: "Senior's name", required: true },
            { name: "schedule", description: "Time and duration of visit", required: false },
            { name: "address", description: "Client address", required: true },
            { name: "mapsUrl", description: "Google Maps URL", required: false },
            { name: "medLine", description: "Medication reminder line", required: false },
            { name: "verifiedNote", description: "Background check verified note", required: false },
        ],
    },
];
function handlePromptGet(name, args) {
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
                schedule ? `Visit time/duration: ${schedule}` : null,
                mapsUrl ? `Maps link: ${mapsUrl}` : null,
                medLine ? `Medications: ${medLine}` : null,
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
function toolError(code, message) {
    return { _toolError: true, success: false, code, message };
}
// ── Tool executor ─────────────────────────────────────────────────────────────
async function handleToolCall(name, input) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56, _57, _58, _59, _60, _61, _62, _63, _64, _65, _66, _67, _68, _69, _70, _71, _72, _73, _74, _75, _76, _77, _78, _79, _80, _81, _82, _83, _84, _85, _86, _87, _88, _89;
    // Runtime-enforced confirmation gate. High-risk tool calls (cancel_appointment,
    // remove_family_member, cancel_subscription, etc.) are intercepted on the
    // first call and turned into a pending-action stub for Claude to read.
    // The re-run from approvalHandler sets _confirmedActionId to bypass the gate.
    // See pendingActions.ts for the full design.
    const confirmedActionId = input._confirmedActionId;
    if (confirmedActionId) {
        delete input._confirmedActionId;
    }
    else if ((0, pendingActions_1.isHighRisk)(name, input)) {
        const phone = input.phone;
        if (!phone) {
            // No phone means we can't enforce confirmation through the SMS round-trip
            // (e.g. a future web-callable code path). Refuse rather than execute,
            // since the safety guarantee is the whole point of the gate.
            console.warn("MCP gate: high-risk tool called without phone — refusing", { name });
            return toolError("PERMISSION_DENIED", "This action requires explicit confirmation and cannot be executed without an SMS session.");
        }
        const action = await (0, pendingActions_1.proposePendingAction)({
            phone,
            userId: input.userId,
            toolName: name,
            toolInput: input,
        });
        console.info("MCP gate: proposed pending action", {
            phone,
            actionId: action.id,
            toolName: name,
            preview: action.preview,
        });
        return (0, pendingActions_1.buildPendingActionStub)(action);
    }
    const nowIso = new Date().toISOString();
    const daysBack = Math.min((_a = input.daysBack) !== null && _a !== void 0 ? _a : 30, 90);
    const daysAgo = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    try {
        switch (name) {
            case "get_senior_profile": {
                if (!input.seniorId)
                    return toolError("INVALID_INPUT", "seniorId is required");
                (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_senior_profile").catch(() => { });
                const snap = await db.collection("seniors").doc(input.seniorId).get();
                if (!snap.exists)
                    return toolError("NOT_FOUND", "Senior profile not found");
                const data = snap.data();
                return { success: true, results: data, hasMore: false };
            }
            case "list_household_seniors": {
                const clientId = input.clientId;
                if (!clientId)
                    return toolError("INVALID_INPUT", "clientId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: clientId, data: { source: "mcp:list_household_seniors" } }).catch(() => { });
                // New model: query senior_profiles where clientId field matches
                const snap = await db.collection("senior_profiles")
                    .where("clientId", "==", clientId)
                    .limit(10)
                    .get();
                if (!snap.empty) {
                    return { success: true, results: snap.docs.map(d => (Object.assign({ seniorId: d.id }, d.data()))), hasMore: false };
                }
                // Fallback: old-style single senior (doc ID === clientId)
                const single = await db.collection("senior_profiles").doc(clientId).get();
                if (single.exists) {
                    return { success: true, results: [Object.assign({ seniorId: clientId }, single.data())], hasMore: false };
                }
                return { success: true, results: [], hasMore: false };
            }
            case "get_care_journal": {
                if (!input.seniorId)
                    return toolError("INVALID_INPUT", "seniorId is required");
                (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_care_journal").catch(() => { });
                const limit = Math.min((_b = input.limit) !== null && _b !== void 0 ? _b : 5, 20);
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
                if (!input.clientId)
                    return toolError("INVALID_INPUT", "clientId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.clientId, data: { source: "mcp:get_upcoming_appointments" } }).catch(() => { });
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
                if (!input.caregiverId)
                    return toolError("INVALID_INPUT", "caregiverId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.caregiverId, data: { source: "mcp:get_caregiver_info" } }).catch(() => { });
                const snap = await db.collection("caregivers").doc(input.caregiverId).get();
                if (!snap.exists)
                    return toolError("NOT_FOUND", "Caregiver not found");
                const d = snap.data();
                return {
                    success: true,
                    results: {
                        name: `${(_c = d.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = d.lastName) !== null && _d !== void 0 ? _d : ""}`.trim() || d.name,
                        rating: d.rating,
                        ratingCount: (_e = d.ratingCount) !== null && _e !== void 0 ? _e : 0,
                        yearsExperience: d.yearsExperience,
                        specialties: (_f = d.specialties) !== null && _f !== void 0 ? _f : [],
                        certifications: (_g = d.certifications) !== null && _g !== void 0 ? _g : [],
                        backgroundCheckStatus: (_j = (_h = d.backgroundCheckData) === null || _h === void 0 ? void 0 : _h.status) !== null && _j !== void 0 ? _j : "pending",
                        backgroundCheckClearedAt: (_l = (_k = d.backgroundCheckData) === null || _k === void 0 ? void 0 : _k.clearedAt) !== null && _l !== void 0 ? _l : null,
                        isVerified: d.status === "active",
                        bookable: d.status === "active",
                        hourlyRate: d.hourlyRate,
                        city: d.city,
                        bio: (_o = (_m = d.bio) !== null && _m !== void 0 ? _m : d.about) !== null && _o !== void 0 ? _o : null,
                    },
                };
            }
            case "get_caregiver_reviews": {
                if (!input.caregiverId)
                    return toolError("INVALID_INPUT", "caregiverId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.caregiverId, data: { source: "mcp:get_caregiver_reviews" } }).catch(() => { });
                const limit = Math.min((_p = input.limit) !== null && _p !== void 0 ? _p : 5, 20);
                const snap = await db
                    .collection("reviews")
                    .where("caregiverId", "==", input.caregiverId)
                    .orderBy("createdAt", "desc")
                    .limit(limit + 1)
                    .get();
                const docs = snap.docs.slice(0, limit).map((d) => {
                    var _a;
                    const r = d.data();
                    return { rating: r.rating, comment: (_a = r.comment) !== null && _a !== void 0 ? _a : "", createdAt: r.createdAt };
                });
                const cgSnap = await db.collection("caregivers").doc(input.caregiverId).get();
                const cg = (_q = cgSnap.data()) !== null && _q !== void 0 ? _q : {};
                const averageRating = typeof cg.averageRating === "number"
                    ? cg.averageRating
                    : (docs.length ? docs.reduce((s, r) => { var _a; return s + ((_a = r.rating) !== null && _a !== void 0 ? _a : 0); }, 0) / docs.length : null);
                return {
                    success: true,
                    caregiverName: (_r = cg.name) !== null && _r !== void 0 ? _r : "the caregiver",
                    averageRating,
                    totalReviews: (_s = cg.reviewCount) !== null && _s !== void 0 ? _s : docs.length,
                    recentReviews: docs,
                    hasMore: snap.docs.length > limit,
                };
            }
            case "get_health_signals": {
                if (!input.seniorId)
                    return toolError("INVALID_INPUT", "seniorId is required");
                (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:get_health_signals").catch(() => { });
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
                if (!input.userId)
                    return toolError("INVALID_INPUT", "userId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.userId, data: { source: "mcp:get_billing_summary" } }).catch(() => { });
                const userId = input.userId;
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
                const userDoc = (_t = userSnap.data()) !== null && _t !== void 0 ? _t : {};
                return {
                    success: true,
                    subscription: (_u = subSnap.data()) !== null && _u !== void 0 ? _u : null,
                    membershipStatus: ((_w = (_v = userDoc.membershipStatus) !== null && _v !== void 0 ? _v : userDoc.subscriptionStatus) !== null && _w !== void 0 ? _w : "unknown"),
                    recentInvoices: invoiceSnap.docs.map((d) => d.data()),
                    recentPayments: paymentsSnap.docs.map((d) => {
                        var _a, _b, _c, _d, _e;
                        const p = d.data();
                        return {
                            date: (_e = (_d = (_c = (_b = (_a = p.createdAt) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c.toISOString) === null || _d === void 0 ? void 0 : _d.call(_c)) !== null && _e !== void 0 ? _e : p.createdAt,
                            amount: typeof p.amount === "number" ? `$${(p.amount / 100).toFixed(2)}` : p.amount,
                            status: p.status,
                        };
                    }),
                };
            }
            case "find_replacement_caregivers": {
                const { phone, chatId, clientId } = input;
                if (!phone || !chatId || !clientId)
                    return toolError("INVALID_INPUT", "phone, chatId, and clientId are required");
                (0, auditLog_1.logAudit)({ eventType: "caregiver_matched", userId: clientId, data: { source: "mcp:find_replacement_caregivers" } }).catch(() => { });
                const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
                const session = (_x = sessionSnap.data()) !== null && _x !== void 0 ? _x : {};
                const clientSnap = await db.collection("users").doc(clientId).get();
                const clientProfile = (_y = clientSnap.data()) !== null && _y !== void 0 ? _y : {};
                await (0, matchingAgent_1.runMatchingForClient)(phone, chatId, session, clientProfile);
                return { success: true, triggered: true };
            }
            case "request_booking": {
                const { clientId, caregiverId, dates, startTime, endTime } = input;
                if (!clientId || !caregiverId || !dates || !startTime || !endTime) {
                    return toolError("INVALID_INPUT", "clientId, caregiverId, dates, startTime, endTime are required");
                }
                const ref = await db.collection("booking_tasks").add({
                    clientId, caregiverId, dates, startTime, endTime,
                    status: "pending",
                    source: "qa_agent",
                    createdAt: nowIso,
                });
                (0, auditLog_1.logBookingCreated)(clientId, caregiverId, dates).catch(() => { });
                return { success: true, taskId: ref.id };
            }
            case "update_preferences": {
                const { userId } = input, patch = __rest(input, ["userId"]);
                if (!userId)
                    return toolError("INVALID_INPUT", "userId is required");
                (0, auditLog_1.logAudit)({ eventType: "permissions_updated", userId: userId, data: { source: "mcp:update_preferences", patch } }).catch(() => { });
                await db.collection("user_preferences").doc(userId).set(patch, { merge: true });
                return { success: true, updated: true };
            }
            case "log_health_flag": {
                if (!input.seniorId || !input.signalType)
                    return toolError("INVALID_INPUT", "seniorId and signalType are required");
                (0, auditLog_1.logHealthDataAccessed)(input.seniorId, input.seniorId, "mcp:log_health_flag").catch(() => { });
                await db.collection("health_signals").add({
                    seniorId: input.seniorId,
                    signalType: input.signalType,
                    description: (_z = input.description) !== null && _z !== void 0 ? _z : "",
                    severity: "flag",
                    source: "family_report",
                    detectedAt: nowIso,
                });
                return { success: true, logged: true };
            }
            case "read_memory_file": {
                if (!input.userId || !input.file)
                    return toolError("INVALID_INPUT", "userId and file are required");
                // Reads accept any slug (canonical or ad-hoc offloaded files); the storage
                // layer sanitizes the name so it can never escape the user's prefix.
                (0, auditLog_1.logHealthDataAccessed)(input.userId, input.userId, "mcp:read_memory_file").catch(() => { });
                const content = await (0, memoryFiles_1.readMemoryFile)(input.userId, input.file);
                return { success: true, content: content || "", empty: !content };
            }
            case "update_memory_file": {
                if (!input.userId || !input.file || !input.content)
                    return toolError("INVALID_INPUT", "userId, file, and content are required");
                const VALID_FILES = new Set(["profile", "health", "family", "recent_episodes", "procedural"]);
                if (!VALID_FILES.has(input.file))
                    return toolError("INVALID_INPUT", `file must be one of: ${[...VALID_FILES].join(", ")}`);
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.userId, data: { source: "mcp:update_memory_file", file: input.file } }).catch(() => { });
                const existing = await (0, memoryFiles_1.readMemoryFile)(input.userId, input.file);
                const updated = existing
                    ? `${existing.trimEnd()}\n\n${input.content}`
                    : input.content;
                await (0, memoryFiles_1.writeMemoryFile)(input.userId, input.file, updated);
                return { success: true, updated: true };
            }
            case "edit_memory_file": {
                if (!input.userId || !input.file || !input.find)
                    return toolError("INVALID_INPUT", "userId, file, and find are required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.userId, data: { source: "mcp:edit_memory_file", file: input.file } }).catch(() => { });
                const replaced = await (0, memoryFiles_1.editMemoryFile)(input.userId, input.file, input.find, (_0 = input.replace) !== null && _0 !== void 0 ? _0 : "");
                return { success: true, replaced, matched: replaced > 0 };
            }
            case "search_memory": {
                if (!input.userId || !input.query)
                    return toolError("INVALID_INPUT", "userId and query are required");
                (0, auditLog_1.logHealthDataAccessed)(input.userId, input.userId, "mcp:search_memory").catch(() => { });
                // Hybrid: substring (exact) ∪ semantic (cosine over text-embedding-3-small).
                // Falls back to substring automatically if the embedding API or key is unavailable.
                const hits = await (0, memoryFiles_1.searchMemoryHybrid)(input.userId, input.query);
                return { success: true, hits, count: hits.length };
            }
            case "cara_knows": {
                // Memory transparency surface (Sprint 3 / roadmap §5.3). Returns the
                // family's full editable memory context — the same blob Cara already
                // sees in-prompt, but surfaced so they can verify or correct it.
                if (!input.userId)
                    return toolError("INVALID_INPUT", "userId is required");
                (0, auditLog_1.logHealthDataAccessed)(input.userId, input.userId, "mcp:cara_knows").catch(() => { });
                const [context, files] = await Promise.all([
                    (0, memoryFiles_1.getMemoryContext)(input.userId),
                    (0, memoryFiles_1.listMemoryFiles)(input.userId),
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
                const description = input.description;
                const subagent_type = input.subagent_type;
                if (!description || !subagent_type) {
                    return toolError("INVALID_INPUT", "description and subagent_type are required");
                }
                if (ephemeralSubAgents_1.INTERNAL_SUB_AGENT_NAMES.has(subagent_type)) {
                    return toolError("INVALID_INPUT", `subagent_type "${subagent_type}" is internal-only and cannot be invoked via task.`);
                }
                const result = await (0, ephemeralSubAgents_1.runEphemeralSubAgent)({ description, subagentType: subagent_type });
                return {
                    success: true,
                    output: result.output,
                    subagentType: result.subagentType,
                    durationMs: result.durationMs,
                    modelUsed: result.modelUsed,
                };
            }
            case "write_todos": {
                // Working-memory checklist (DeepAgents TodoListMiddleware port). Stored on
                // agent_sessions; injected into Cara's system prompt at the start of each
                // turn so she can see what's outstanding across the conversation.
                const { phone, items } = input;
                if (!phone || !Array.isArray(items)) {
                    return toolError("INVALID_INPUT", "phone and items[] are required");
                }
                const allowed = new Set(["pending", "in_progress", "completed"]);
                const sanitized = items
                    .filter((it) => it && typeof it.task === "string" && allowed.has(it.status))
                    .slice(0, 20) // cap — checklists this long usually mean Claude is over-decomposing
                    .map((it) => ({ task: it.task.slice(0, 200), status: it.status }));
                await admin.firestore().collection("agent_sessions").doc(phone).set({
                    todos: sanitized,
                    todosUpdatedAt: new Date().toISOString(),
                }, { merge: true });
                const pending = sanitized.filter((t) => t.status === "pending").length;
                const inProgress = sanitized.filter((t) => t.status === "in_progress").length;
                const completed = sanitized.filter((t) => t.status === "completed").length;
                return { success: true, count: sanitized.length, pending, inProgress, completed };
            }
            case "cancel_appointment": {
                const { appointmentId, clientId, reason } = input;
                if (!appointmentId || !clientId)
                    return toolError("INVALID_INPUT", "appointmentId and clientId are required");
                const apptSnap = await db.collection("appointments").doc(appointmentId).get();
                if (!apptSnap.exists)
                    return toolError("NOT_FOUND", "Appointment not found");
                const appt = apptSnap.data();
                if (appt.clientId !== clientId)
                    return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
                if (["cancelled_by_client", "cancelled"].includes(appt.status)) {
                    return toolError("INVALID_INPUT", "Appointment is already cancelled");
                }
                await apptSnap.ref.update({
                    status: "cancelled_by_client",
                    cancelledAt: nowIso,
                    cancelledReason: reason !== null && reason !== void 0 ? reason : "client_request",
                });
                // Notify caregiver — surface success/failure so Cara doesn't claim
                // the caregiver was reached when the message never went out.
                let notification = { sent: false, reason: "no_caregiver_phone" };
                if (appt.caregiverId) {
                    const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
                    const cgPhone = (_1 = cgSnap.data()) === null || _1 === void 0 ? void 0 : _1.phone;
                    if (cgPhone) {
                        const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                        notification = await trySend(cgPhone, `The family has cancelled the visit on ${(_2 = appt.date) !== null && _2 !== void 0 ? _2 : ""}. Sorry for the inconvenience.`, "mcp:cancel_appointment");
                    }
                }
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: clientId, data: { source: "mcp:cancel_appointment", appointmentId, notificationSent: notification.sent } }).catch(() => { });
                return { success: true, cancelled: true, appointmentId, date: appt.date, caregiverName: appt.caregiverName, notification };
            }
            case "send_caregiver_message": {
                const { caregiverId, message, clientId } = input;
                if (!caregiverId || !message)
                    return toolError("INVALID_INPUT", "caregiverId and message are required");
                const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
                if (!cgSnap.exists)
                    return toolError("NOT_FOUND", "Caregiver not found");
                const cgPhone = (_3 = cgSnap.data()) === null || _3 === void 0 ? void 0 : _3.phone;
                if (!cgPhone)
                    return toolError("NOT_FOUND", "Caregiver phone not on file");
                const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                const notification = await trySend(cgPhone, `Message from family: ${message}`, "mcp:send_caregiver_message");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: (_4 = clientId) !== null && _4 !== void 0 ? _4 : "", data: { source: "mcp:send_caregiver_message", caregiverId, notificationSent: notification.sent } }).catch(() => { });
                return { success: true, sent: notification.sent, caregiverName: (_6 = (_5 = cgSnap.data()) === null || _5 === void 0 ? void 0 : _5.name) !== null && _6 !== void 0 ? _6 : "", notification };
            }
            case "get_recurring_schedule": {
                if (!input.clientId)
                    return toolError("INVALID_INPUT", "clientId is required");
                const snap = await db.collection("recurring_schedules")
                    .where("clientId", "==", input.clientId)
                    .where("status", "==", "active")
                    .limit(1)
                    .get();
                if (snap.empty)
                    return { success: true, schedule: null, message: "No active recurring schedule found" };
                return { success: true, schedule: snap.docs[0].data() };
            }
            case "get_family_group": {
                if (!input.phone)
                    return toolError("INVALID_INPUT", "phone is required");
                const snap = await db.collection("family_group_members")
                    .where("primaryPhone", "==", input.phone)
                    .get();
                return { success: true, members: snap.docs.map(d => d.data()), count: snap.size };
            }
            case "list_user_reminders": {
                if (!input.phone)
                    return toolError("INVALID_INPUT", "phone is required");
                const snap = await db.collection("user_triggers")
                    .where("phone", "==", input.phone)
                    .where("active", "==", true)
                    .get();
                const reminders = snap.docs.map(d => (Object.assign({ id: d.id }, d.data())));
                return { success: true, reminders, count: reminders.length };
            }
            case "create_reminder": {
                const { phone, userId, label, recurrence, hour, minute, message: msg, dayOfWeek } = input;
                if (!phone || !userId || !label || !recurrence || hour == null || minute == null || !msg) {
                    return toolError("INVALID_INPUT", "phone, userId, label, recurrence, hour, minute, message are required");
                }
                const { createUserTrigger } = await Promise.resolve().then(() => __importStar(require("../triggers/userTriggerManager")));
                const triggerId = await createUserTrigger(phone, userId, {
                    label: label,
                    recurrence: recurrence,
                    dayOfWeek: dayOfWeek,
                    hour: hour,
                    minute: minute,
                    message: msg,
                });
                return { success: true, triggerId, label };
            }
            case "schedule_followup": {
                const { phone, userId, message: followUpMsg, scheduledAt, reason } = input;
                if (!phone || !userId || !followUpMsg || !scheduledAt) {
                    return toolError("INVALID_INPUT", "phone, userId, message, and scheduledAt are required");
                }
                // Validate scheduledAt is in the future
                if (new Date(scheduledAt) <= new Date()) {
                    return toolError("INVALID_INPUT", "scheduledAt must be in the future");
                }
                const { scheduleTrigger } = await Promise.resolve().then(() => __importStar(require("../triggers/triggerEngine")));
                const triggerId = await scheduleTrigger({
                    userId: userId,
                    phone: phone,
                    type: "custom",
                    message: followUpMsg,
                    scheduledAt: scheduledAt,
                    source: "claude",
                    intent: reason,
                });
                if (!triggerId) {
                    return { success: false, reason: "skipped_calibration_period" };
                }
                return { success: true, triggerId, scheduledAt };
            }
            case "delete_reminder": {
                const { phone, triggerId } = input;
                if (!phone || !triggerId)
                    return toolError("INVALID_INPUT", "phone and triggerId are required");
                const { deleteUserTrigger } = await Promise.resolve().then(() => __importStar(require("../triggers/userTriggerManager")));
                const deleted = await deleteUserTrigger(phone, triggerId);
                if (!deleted)
                    return toolError("NOT_FOUND", "Reminder not found or does not belong to this user");
                return { success: true, deleted: true };
            }
            case "get_caregiver_appointments": {
                if (!input.caregiverId)
                    return toolError("INVALID_INPUT", "caregiverId is required");
                const daysAhead = Math.min((_7 = input.daysAhead) !== null && _7 !== void 0 ? _7 : 7, 30);
                const today = new Date().toISOString().slice(0, 10);
                const futureLimit = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                const snap = await db.collection("appointments")
                    .where("caregiverId", "==", input.caregiverId)
                    .where("date", ">=", today)
                    .where("date", "<=", futureLimit)
                    .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
                    .orderBy("date", "asc")
                    .limit(11)
                    .get();
                const docs = snap.docs.slice(0, 10).map(d => d.data());
                return { success: true, results: docs, hasMore: snap.docs.length > 10 };
            }
            case "get_pending_tasks": {
                if (!input.clientId)
                    return toolError("INVALID_INPUT", "clientId is required");
                (0, auditLog_1.logAudit)({ eventType: "health_data_accessed", userId: input.clientId, data: { source: "mcp:get_pending_tasks" } }).catch(() => { });
                const [taskSnap, interviewSnap] = await Promise.all([
                    db.collection("agent_tasks")
                        .where("clientId", "==", input.clientId)
                        .where("status", "in", ["awaiting_approval", "pending"])
                        .limit(5)
                        .get(),
                    db.collection("interviews")
                        .where("clientId", "==", input.clientId)
                        .where("status", "==", "awaiting_hire_decision")
                        .limit(5)
                        .get(),
                ]);
                const tasks = taskSnap.docs.map(d => (Object.assign({ id: d.id }, d.data())));
                const interviews = interviewSnap.docs.map(d => (Object.assign({ id: d.id }, d.data())));
                const total = tasks.length + interviews.length;
                return {
                    success: true,
                    total,
                    tasks,
                    interviews,
                    summary: total === 0 ? "Nothing pending" : `${total} item(s) need your attention`,
                };
            }
            case "search_web": {
                const { searchWeb } = await Promise.resolve().then(() => __importStar(require("../browser/browserbaseClient")));
                const results = await searchWeb(input.query, (_8 = input.numResults) !== null && _8 !== void 0 ? _8 : 5);
                return { results };
            }
            case "perform_web_action": {
                const { searchHealthcareProvider, fetchHealthcarePage, performBrowserAction, scheduleDoctorAppointment, requestPharmacyRefill, checkInsuranceAuthorization, } = await Promise.resolve().then(() => __importStar(require("../browser/careWebActions")));
                const { startCredentialCollection } = await Promise.resolve().then(() => __importStar(require("../browser/credentialCollector")));
                const task = input.task;
                const url = input.url;
                const actionType = input.actionType;
                const loginAction = input.loginAction;
                const userId2 = input.userId;
                const phone2 = (_9 = input.phone) !== null && _9 !== void 0 ? _9 : "unknown";
                const city = input.city;
                try {
                    // ── Login-required portal actions ──────────────────────────────────
                    if (loginAction) {
                        switch (loginAction) {
                            case "schedule_appointment": {
                                const portalSvc = ((_10 = input.portalService) !== null && _10 !== void 0 ? _10 : "mychart");
                                const result = await scheduleDoctorAppointment({
                                    userId: userId2,
                                    phone: phone2,
                                    doctorName: (_11 = input.doctorName) !== null && _11 !== void 0 ? _11 : task,
                                    specialty: input.specialty,
                                    preferredDate: input.preferredDate,
                                    appointmentType: input.appointmentType,
                                    portalService: portalSvc,
                                });
                                if (result.needsCredentials) {
                                    await startCredentialCollection({
                                        phone: phone2,
                                        userId: userId2,
                                        service: portalSvc,
                                        reason: `schedule an appointment with ${(_12 = input.doctorName) !== null && _12 !== void 0 ? _12 : "your doctor"}`,
                                    });
                                    return { status: "collecting_credentials" };
                                }
                                return result;
                            }
                            case "pharmacy_refill": {
                                const pharmSvc = (_13 = input.pharmacyService) !== null && _13 !== void 0 ? _13 : "cvs";
                                const result = await requestPharmacyRefill({
                                    userId: userId2,
                                    phone: phone2,
                                    pharmacyService: pharmSvc,
                                    medicationName: input.medicationName,
                                    rxNumber: input.rxNumber,
                                    seniorName: input.seniorName,
                                });
                                if (result.needsCredentials) {
                                    await startCredentialCollection({
                                        phone: phone2,
                                        userId: userId2,
                                        service: pharmSvc,
                                        reason: "request a prescription refill",
                                    });
                                    return { status: "collecting_credentials" };
                                }
                                return result;
                            }
                            case "insurance_check": {
                                const insurer = (_14 = input.insurer) !== null && _14 !== void 0 ? _14 : task;
                                const { insurerToServiceKey } = await Promise.resolve().then(() => __importStar(require("../browser/credentialVault")));
                                const result = await checkInsuranceAuthorization({
                                    userId: userId2,
                                    phone: phone2,
                                    insurer,
                                    checkType: (_15 = input.checkType) !== null && _15 !== void 0 ? _15 : "coverage",
                                    serviceDescription: input.task,
                                    referenceNumber: input.referenceNumber,
                                    seniorName: input.seniorName,
                                });
                                if (result.needsCredentials) {
                                    await startCredentialCollection({
                                        phone: phone2,
                                        userId: userId2,
                                        service: insurerToServiceKey(insurer),
                                        reason: `check your ${insurer} insurance`,
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
                            if (!url)
                                return toolError("INVALID_INPUT", "url is required for fetch action");
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
                }
                catch (webErr) {
                    console.error("[perform_web_action] error:", webErr);
                    return { error: true, message: "I ran into a problem with that web action. Let me find the link for you instead." };
                }
            }
            case "manage_credentials": {
                const { listCredentials, deleteCredential, hasCredential, } = await Promise.resolve().then(() => __importStar(require("../browser/credentialVault")));
                const credUserId = input.userId;
                const service = input.service;
                switch (input.action) {
                    case "list": {
                        const creds = await listCredentials(credUserId);
                        return { credentials: creds, count: creds.length };
                    }
                    case "delete": {
                        if (!service)
                            return toolError("INVALID_INPUT", "service is required for delete");
                        await deleteCredential(credUserId, service);
                        return { deleted: true, service };
                    }
                    case "check": {
                        if (!service)
                            return toolError("INVALID_INPUT", "service is required for check");
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
            const { clientId } = input;
            const nextWeekStart = new Date();
            nextWeekStart.setDate(nextWeekStart.getDate() + 1);
            const nextWeekEnd = new Date();
            nextWeekEnd.setDate(nextWeekEnd.getDate() + 8);
            const startStr = nextWeekStart.toISOString().slice(0, 10);
            const endStr = nextWeekEnd.toISOString().slice(0, 10);
            const apptSnap = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
                .where("date", ">=", startStr)
                .where("date", "<=", endStr)
                .limit(1)
                .get();
            const hasVisitNextWeek = !apptSnap.empty;
            // Check preferred caregiver availability (most recently booked)
            const recentAppt = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "completed")
                .orderBy("date", "desc")
                .limit(1)
                .get();
            let preferredCaregiverAvailable = false;
            let caregiverName = "";
            let suggestedDate = startStr;
            if (!recentAppt.empty) {
                const lastAppt = recentAppt.docs[0].data();
                caregiverName = (_16 = lastAppt.caregiverName) !== null && _16 !== void 0 ? _16 : "";
                const cgId = (_17 = lastAppt.caregiverId) !== null && _17 !== void 0 ? _17 : "";
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
            const { clientId } = input;
            const snap = await db.collection("care_plans").doc(clientId).get();
            if (!snap.exists)
                return { success: true, carePlan: null, message: "No care plan on file yet." };
            return { success: true, carePlan: snap.data() };
        }
        if (name === "update_care_plan") {
            const { clientId, field, value, action } = input;
            const ALLOWED_FIELDS = ["medications", "careNeeds", "dietaryNotes", "doctorContacts", "specialInstructions", "notes"];
            if (!ALLOWED_FIELDS.includes(field)) {
                return { success: false, error: `Field '${field}' is not updatable. Allowed: ${ALLOWED_FIELDS.join(", ")}` };
            }
            const ref = db.collection("care_plans").doc(clientId);
            if (action === "append") {
                await ref.set({ [field]: admin.firestore.FieldValue.arrayUnion(value) }, { merge: true });
            }
            else if (action === "remove") {
                await ref.set({ [field]: admin.firestore.FieldValue.arrayRemove(value) }, { merge: true });
            }
            else {
                await ref.set({ [field]: value, updatedAt: new Date().toISOString() }, { merge: true });
            }
            return { success: true, updated: field, action };
        }
        // ── New write tools ────────────────────────────────────────────────────────
        if (name === "update_caregiver_profile") {
            const { caregiverId, hourlyRate, bio, phone: cgPhone, city, weeklyAvailability } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            if (bio && typeof bio === "string" && bio.length > 2500)
                return toolError("INVALID_INPUT", "bio must be 2500 characters or fewer");
            const patch = { updatedAt: nowIso };
            if (hourlyRate != null)
                patch.hourlyRate = hourlyRate;
            if (bio != null)
                patch.bio = bio;
            if (cgPhone != null)
                patch.phone = cgPhone;
            if (city != null)
                patch.city = city;
            if (weeklyAvailability != null)
                patch.weeklyAvailability = weeklyAvailability;
            if (Object.keys(patch).length === 1)
                return toolError("INVALID_INPUT", "At least one field to update is required");
            await db.collection("caregivers").doc(caregiverId).set(patch, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "profile_updated", userId: caregiverId, data: { source: "mcp:update_caregiver_profile", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => { });
            return { success: true, updated: Object.keys(patch).filter(k => k !== "updatedAt") };
        }
        if (name === "add_family_member") {
            const { seniorId, name: memberName, phone: memberPhone, clientId } = input;
            if (!seniorId || !memberName || !memberPhone || !clientId)
                return toolError("INVALID_INPUT", "seniorId, name, phone, and clientId are required");
            const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
            if (!seniorSnap.exists)
                return toolError("NOT_FOUND", "Senior profile not found");
            const seniorData = seniorSnap.data();
            if (seniorData.userId && seniorData.userId !== clientId)
                return toolError("PERMISSION_DENIED", "Not authorized to modify this senior's profile");
            const existing = (_18 = seniorData.familyMembers) !== null && _18 !== void 0 ? _18 : [];
            if (existing.some(m => m.phone === memberPhone))
                return toolError("INVALID_INPUT", "This phone number is already a family member");
            await seniorSnap.ref.update({ familyMembers: admin.firestore.FieldValue.arrayUnion({ name: memberName, phone: memberPhone, addedAt: nowIso, addedBy: clientId }) });
            const { buildOrUpdateFamilyGroup } = await Promise.resolve().then(() => __importStar(require("../agents/familyGroupManager")));
            await buildOrUpdateFamilyGroup(seniorId).catch(() => { });
            const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
            const notification = await trySend(memberPhone, "Hi! You've been added to a CareConnex care group. You'll receive updates about your loved one's care here. Text any question anytime.", "mcp:add_family_member");
            (0, auditLog_1.logAudit)({ eventType: "family_member_added", userId: clientId, data: { source: "mcp:add_family_member", seniorId, newMemberPhone: memberPhone, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, added: true, name: memberName, phone: memberPhone, notification };
        }
        if (name === "remove_family_member") {
            const { seniorId, phone: targetPhone, clientId } = input;
            if (!seniorId || !targetPhone || !clientId)
                return toolError("INVALID_INPUT", "seniorId, phone, and clientId are required");
            const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
            if (!seniorSnap.exists)
                return toolError("NOT_FOUND", "Senior profile not found");
            const seniorData = seniorSnap.data();
            if (seniorData.userId && seniorData.userId !== clientId)
                return toolError("PERMISSION_DENIED", "Not authorized to modify this senior's profile");
            const { removeMemberFromGroup } = await Promise.resolve().then(() => __importStar(require("../agents/familyGroupManager")));
            const result = await removeMemberFromGroup(seniorId, targetPhone);
            const existingMembers = (_19 = seniorData.familyMembers) !== null && _19 !== void 0 ? _19 : [];
            const memberObj = existingMembers.find(m => m.phone === targetPhone);
            if (memberObj)
                await seniorSnap.ref.update({ familyMembers: admin.firestore.FieldValue.arrayRemove(memberObj) });
            // Tell the removed person they were removed — courtesy plus prevents
            // confusion when their next inbound stops getting Cara replies.
            const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
            const notification = await trySend(targetPhone, "You've been removed from a CareConnex care group. You won't get further updates here. Text STOP anytime to unsubscribe completely.", "mcp:remove_family_member");
            (0, auditLog_1.logAudit)({ eventType: "family_member_removed", userId: clientId, data: { source: "mcp:remove_family_member", seniorId, removedPhone: targetPhone, notificationSent: notification.sent } }).catch(() => { });
            return Object.assign(Object.assign({ success: true }, result), { notification });
        }
        if (name === "submit_review") {
            const { caregiverId, appointmentId, clientId, rating, comment } = input;
            if (!caregiverId || !appointmentId || !clientId || rating == null)
                return toolError("INVALID_INPUT", "caregiverId, appointmentId, clientId, and rating are required");
            const ratingNum = Number(rating);
            if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5)
                return toolError("INVALID_INPUT", "rating must be an integer from 1 to 5");
            const apptSnap = await db.collection("appointments").doc(appointmentId).get();
            if (!apptSnap.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const appt = apptSnap.data();
            if (appt.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
            if (appt.hasReview === true)
                return toolError("INVALID_INPUT", "This appointment has already been reviewed");
            const dupSnap = await db.collection("reviews").where("appointmentId", "==", appointmentId).limit(1).get();
            if (!dupSnap.empty)
                return toolError("INVALID_INPUT", "A review for this appointment already exists");
            const reviewRef = await db.collection("reviews").add({ caregiverId, clientId, appointmentId, rating: ratingNum, comment: comment !== null && comment !== void 0 ? comment : "", source: "cara_sms", createdAt: nowIso });
            await apptSnap.ref.update({ hasReview: true, reviewId: reviewRef.id });
            const { onFeedbackSubmitted } = await Promise.resolve().then(() => __importStar(require("../agents/feedbackAggregator")));
            onFeedbackSubmitted(caregiverId, ratingNum, appointmentId, clientId).catch(err => console.error("submit_review aggregation error:", err));
            (0, auditLog_1.logAudit)({ eventType: "review_submitted", userId: clientId, data: { source: "mcp:submit_review", caregiverId, appointmentId, rating: ratingNum } }).catch(() => { });
            return { success: true, reviewId: reviewRef.id, rating: ratingNum };
        }
        if (name === "cancel_subscription") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const subsSnap = await db.collection("customers").doc(clientId).collection("subscriptions").where("status", "in", ["active", "trialing"]).limit(1).get();
            if (subsSnap.empty)
                return toolError("NOT_FOUND", "No active subscription found");
            const subDoc = subsSnap.docs[0];
            const subData = subDoc.data();
            if (subData.cancel_at_period_end === true) {
                const periodEnd = (_24 = (_23 = (_22 = (_21 = (_20 = subData.current_period_end) === null || _20 === void 0 ? void 0 : _20.toDate) === null || _21 === void 0 ? void 0 : _21.call(_20)) === null || _22 === void 0 ? void 0 : _22.toISOString) === null || _23 === void 0 ? void 0 : _23.call(_22)) !== null && _24 !== void 0 ? _24 : null;
                return { success: true, alreadyCancelling: true, periodEnd };
            }
            const { getStripeClient } = await Promise.resolve().then(() => __importStar(require("../stripe")));
            await getStripeClient().subscriptions.update(subDoc.id, { cancel_at_period_end: true });
            await db.collection("users").doc(clientId).set({ subscriptionStatus: "canceling" }, { merge: true });
            const periodEnd = (_29 = (_28 = (_27 = (_26 = (_25 = subData.current_period_end) === null || _25 === void 0 ? void 0 : _25.toDate) === null || _26 === void 0 ? void 0 : _26.call(_25)) === null || _27 === void 0 ? void 0 : _27.toISOString) === null || _28 === void 0 ? void 0 : _28.call(_27)) !== null && _29 !== void 0 ? _29 : null;
            (0, auditLog_1.logAudit)({ eventType: "subscription_cancelled", userId: clientId, data: { source: "mcp:cancel_subscription", subId: subDoc.id, periodEnd } }).catch(() => { });
            return { success: true, cancelled: true, periodEnd, subId: subDoc.id };
        }
        if (name === "reactivate_subscription") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const subsSnap = await db.collection("customers").doc(clientId).collection("subscriptions").where("status", "in", ["active", "trialing"]).limit(1).get();
            if (subsSnap.empty)
                return toolError("NOT_FOUND", "No subscription found to reactivate");
            const subDoc = subsSnap.docs[0];
            const subData = subDoc.data();
            if (subData.cancel_at_period_end !== true)
                return toolError("INVALID_INPUT", "Subscription is not set to cancel — nothing to reactivate");
            const { getStripeClient } = await Promise.resolve().then(() => __importStar(require("../stripe")));
            await getStripeClient().subscriptions.update(subDoc.id, { cancel_at_period_end: false });
            await db.collection("users").doc(clientId).set({ subscriptionStatus: "active" }, { merge: true });
            const periodEnd = (_34 = (_33 = (_32 = (_31 = (_30 = subData.current_period_end) === null || _30 === void 0 ? void 0 : _30.toDate) === null || _31 === void 0 ? void 0 : _31.call(_30)) === null || _32 === void 0 ? void 0 : _32.toISOString) === null || _33 === void 0 ? void 0 : _33.call(_32)) !== null && _34 !== void 0 ? _34 : null;
            (0, auditLog_1.logAudit)({ eventType: "subscription_reactivated", userId: clientId, data: { source: "mcp:reactivate_subscription", subId: subDoc.id } }).catch(() => { });
            return { success: true, reactivated: true, periodEnd };
        }
        if (name === "manage_recurring_schedule") {
            const { scheduleId, clientId, action, pauseReason } = input;
            if (!scheduleId || !clientId || !action)
                return toolError("INVALID_INPUT", "scheduleId, clientId, and action are required");
            const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
            if (!schedSnap.exists)
                return toolError("NOT_FOUND", "Recurring schedule not found");
            const sched = schedSnap.data();
            if (sched.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "This schedule does not belong to this client");
            const today = nowIso.slice(0, 10);
            if (action === "pause") {
                if (sched.status === "paused")
                    return toolError("INVALID_INPUT", "Schedule is already paused");
                if (sched.status === "cancelled")
                    return toolError("INVALID_INPUT", "Cannot pause a cancelled schedule");
                await schedSnap.ref.update({ status: "paused", pausedAt: nowIso, pausedReason: pauseReason !== null && pauseReason !== void 0 ? pauseReason : "client_request" });
                (0, auditLog_1.logAudit)({ eventType: "recurring_schedule_updated", userId: clientId, data: { action: "pause", scheduleId } }).catch(() => { });
                return { success: true, action: "paused", scheduleId };
            }
            if (action === "resume") {
                if (sched.status !== "paused")
                    return toolError("INVALID_INPUT", "Schedule is not currently paused");
                await schedSnap.ref.update({ status: "active", pausedAt: admin.firestore.FieldValue.delete(), pausedReason: admin.firestore.FieldValue.delete() });
                (0, auditLog_1.logAudit)({ eventType: "recurring_schedule_updated", userId: clientId, data: { action: "resume", scheduleId } }).catch(() => { });
                return { success: true, action: "resumed", scheduleId };
            }
            if (action === "cancel") {
                if (sched.status === "cancelled")
                    return toolError("INVALID_INPUT", "Schedule is already cancelled");
                const futureSnap = await db.collection("appointments").where("recurringScheduleId", "==", scheduleId).where("date", ">", today).where("status", "in", ["confirmed"]).get();
                const batch = db.batch();
                batch.update(schedSnap.ref, { status: "cancelled", cancelledAt: nowIso });
                for (const doc of futureSnap.docs)
                    batch.update(doc.ref, { status: "cancelled_by_client", cancelledAt: nowIso });
                await batch.commit();
                (0, auditLog_1.logAudit)({ eventType: "recurring_schedule_updated", userId: clientId, data: { action: "cancel", scheduleId, futureVisitsRemoved: futureSnap.size } }).catch(() => { });
                return { success: true, action: "cancelled", futureVisitsRemoved: futureSnap.size };
            }
            return toolError("INVALID_INPUT", `Unknown action '${action}'. Must be pause, resume, or cancel`);
        }
        if (name === "update_senior_profile") {
            const { seniorId, clientId, field, value, action } = input;
            if (!seniorId || !clientId || !field || value == null || !action)
                return toolError("INVALID_INPUT", "seniorId, clientId, field, value, and action are required");
            const ALLOWED = new Set(["emergencyContactName", "emergencyContactPhone", "primaryPhysicianName", "primaryPhysicianPhone", "diagnoses", "allergies"]);
            const ARRAY_F = new Set(["diagnoses", "allergies"]);
            if (!ALLOWED.has(field))
                return toolError("INVALID_INPUT", `Field '${field}' is not updatable. Allowed: ${[...ALLOWED].join(", ")}`);
            if (!ARRAY_F.has(field) && (action === "arrayUnion" || action === "arrayRemove"))
                return toolError("INVALID_INPUT", `Field '${field}' is scalar — use action 'set'`);
            const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
            if (!seniorSnap.exists)
                return toolError("NOT_FOUND", "Senior profile not found");
            const sd = seniorSnap.data();
            if (sd.userId && sd.userId !== clientId)
                return toolError("PERMISSION_DENIED", "Not authorized to update this senior's profile");
            const upd = { updatedAt: nowIso };
            if (action === "arrayUnion")
                upd[field] = admin.firestore.FieldValue.arrayUnion(value);
            else if (action === "arrayRemove")
                upd[field] = admin.firestore.FieldValue.arrayRemove(value);
            else
                upd[field] = value;
            await seniorSnap.ref.set(upd, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "senior_profile_updated", userId: clientId, data: { source: "mcp:update_senior_profile", seniorId, field, action } }).catch(() => { });
            return { success: true, updated: field, action };
        }
        if (name === "reschedule_appointment") {
            const { appointmentId, clientId, newDate, newTime } = input;
            if (!appointmentId || !clientId || !newDate || !newTime)
                return toolError("INVALID_INPUT", "appointmentId, clientId, newDate, and newTime are required");
            const apptSnap = await db.collection("appointments").doc(appointmentId).get();
            if (!apptSnap.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const appt = apptSnap.data();
            if (appt.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Appointment does not belong to this client");
            if (["cancelled", "cancelled_by_client", "completed"].includes(appt.status))
                return toolError("INVALID_INPUT", `Cannot reschedule an appointment with status '${appt.status}'`);
            const conflictSnap = await db.collection("appointments").where("caregiverId", "==", appt.caregiverId).where("date", "==", newDate).where("status", "in", ["confirmed", "in-progress", "pending_caregiver_confirmation"]).get();
            if (conflictSnap.docs.some(d => d.id !== appointmentId))
                return toolError("CONFLICT", "The caregiver is not available at that date and time");
            const durationHours = (_35 = appt.durationHours) !== null && _35 !== void 0 ? _35 : 2;
            const [h, m] = newTime.split(":").map(Number);
            const totalMins = h * 60 + m + durationHours * 60;
            const newEndTime = `${String(Math.floor(totalMins / 60) % 24).padStart(2, "0")}:${String(totalMins % 60).padStart(2, "0")}`;
            await apptSnap.ref.update({ date: newDate, startTime: newTime, endTime: newEndTime, rescheduledAt: nowIso, previousDate: appt.date, previousStartTime: appt.startTime });
            const cgSnap2 = await db.collection("caregivers").doc(appt.caregiverId).get();
            const cgPhone2 = (_36 = cgSnap2.data()) === null || _36 === void 0 ? void 0 : _36.phone;
            let notification = { sent: false, reason: "no_caregiver_phone" };
            if (cgPhone2) {
                const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                notification = await trySend(cgPhone2, `Your appointment has been moved to ${newDate} at ${newTime}. Please confirm you can still make it.`, "mcp:reschedule_appointment");
            }
            (0, auditLog_1.logAudit)({ eventType: "appointment_rescheduled", userId: clientId, data: { source: "mcp:reschedule_appointment", appointmentId, newDate, newTime, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, appointmentId, newDate, newTime, newEndTime, notification };
        }
        if (name === "create_care_journal_entry") {
            const { caregiverId, appointmentId, notes, mood, medsGiven, activities } = input;
            if (!caregiverId || !appointmentId || !notes)
                return toolError("INVALID_INPUT", "caregiverId, appointmentId, and notes are required");
            const apptSnap = await db.collection("appointments").doc(appointmentId).get();
            if (!apptSnap.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const appt = apptSnap.data();
            if (appt.caregiverId !== caregiverId)
                return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
            const entryRef = await db.collection("care_journal").add({
                seniorId: (_37 = appt.seniorId) !== null && _37 !== void 0 ? _37 : appt.clientId, caregiverId, appointmentId,
                clientId: appt.clientId, notes, mood: mood !== null && mood !== void 0 ? mood : null,
                medsGiven: medsGiven !== null && medsGiven !== void 0 ? medsGiven : null, activities: activities !== null && activities !== void 0 ? activities : [],
                source: "cara_sms", timestamp: nowIso,
            });
            await apptSnap.ref.update({ journalEntryLogged: true }).catch(() => { });
            (0, auditLog_1.logAudit)({ eventType: "care_journal_created", userId: caregiverId, data: { source: "mcp:create_care_journal_entry", appointmentId, entryId: entryRef.id } }).catch(() => { });
            return { success: true, entryId: entryRef.id };
        }
        if (name === "apply_to_job") {
            const { caregiverId, jobId, proposedRate, coverNote } = input;
            if (!caregiverId || !jobId)
                return toolError("INVALID_INPUT", "caregiverId and jobId are required");
            const jobSnap = await db.collection("job_posts").doc(jobId).get();
            if (!jobSnap.exists)
                return toolError("NOT_FOUND", "Job post not found");
            const job = jobSnap.data();
            if (job.status !== "open")
                return toolError("INVALID_INPUT", "This job post is no longer accepting applications");
            const dupSnap2 = await db.collection("job_applications").where("jobId", "==", jobId).where("caregiverId", "==", caregiverId).limit(1).get();
            if (!dupSnap2.empty)
                return toolError("INVALID_INPUT", "You have already applied to this job");
            const appRef = await db.collection("job_applications").add({ jobId, caregiverId, clientId: job.clientId, proposedRate: proposedRate !== null && proposedRate !== void 0 ? proposedRate : null, coverNote: coverNote !== null && coverNote !== void 0 ? coverNote : "", status: "pending", appliedAt: nowIso, source: "cara_sms" });
            const clientSessSnap = await db.collection("agent_sessions").where("userId", "==", job.clientId).limit(1).get();
            if (!clientSessSnap.empty) {
                const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("../agents/caraAgent")));
                await sendViaInteractionAgent(clientSessSnap.docs[0].id, { content: "A caregiver applied to your job post. Text 'show applications' to review.", urgency: "standard", sourceAgent: "mcp:apply_to_job", canDrop: true }).catch(() => { });
            }
            (0, auditLog_1.logAudit)({ eventType: "job_application_submitted", userId: caregiverId, data: { source: "mcp:apply_to_job", jobId, applicationId: appRef.id } }).catch(() => { });
            return { success: true, applicationId: appRef.id };
        }
        if (name === "respond_to_job_application") {
            const { applicationId, clientId, decision, message: decMsg } = input;
            if (!applicationId || !clientId || !decision)
                return toolError("INVALID_INPUT", "applicationId, clientId, and decision are required");
            const appSnap2 = await db.collection("job_applications").doc(applicationId).get();
            if (!appSnap2.exists)
                return toolError("NOT_FOUND", "Application not found");
            const app = appSnap2.data();
            if (app.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Application does not belong to this client");
            if (app.status !== "pending")
                return toolError("INVALID_INPUT", `Application already decided: ${app.status}`);
            await appSnap2.ref.update({ status: decision === "accept" ? "accepted" : "rejected", decidedAt: nowIso, decisionMessage: decMsg !== null && decMsg !== void 0 ? decMsg : "" });
            if (decision === "accept")
                await db.collection("job_posts").doc(app.jobId).update({ status: "filled" }).catch(() => { });
            const cgSessSnap = await db.collection("agent_sessions").where("userId", "==", app.caregiverId).limit(1).get();
            let notification = { sent: false, reason: "no_caregiver_session" };
            if (!cgSessSnap.empty) {
                const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                const msg = decision === "accept"
                    ? "Great news — a family accepted your job application! They'll be in touch soon to finalize details."
                    : "Thanks for applying — the family went with another caregiver this time. Keep an eye out for new jobs!";
                notification = await trySend(cgSessSnap.docs[0].id, msg, "mcp:respond_to_job_application");
            }
            (0, auditLog_1.logAudit)({ eventType: "job_application_responded", userId: clientId, data: { source: "mcp:respond_to_job_application", applicationId, decision, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, decision, applicationId, notification };
        }
        if (name === "submit_interview_feedback") {
            const { interviewId, clientId, fitLevel, notes: fbNotes } = input;
            if (!interviewId || !clientId || !fitLevel)
                return toolError("INVALID_INPUT", "interviewId, clientId, and fitLevel are required");
            const ivSnap = await db.collection("video_interviews").doc(interviewId).get();
            if (!ivSnap.exists)
                return toolError("NOT_FOUND", "Interview not found");
            const iv = ivSnap.data();
            if (iv.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Interview does not belong to this client");
            if (iv.feedbackSubmitted === true)
                return toolError("INVALID_INPUT", "Feedback already submitted for this interview");
            await ivSnap.ref.update({ fitLevel, clientNotes: fbNotes !== null && fbNotes !== void 0 ? fbNotes : "", feedbackSubmitted: true, feedbackAt: nowIso });
            let hireRequestCreated = false;
            if (fitLevel === "strong") {
                await db.collection("hire_requests").add({ clientId, caregiverId: iv.caregiverId, interviewId, status: "pending", createdAt: nowIso });
                hireRequestCreated = true;
                const cgSessSnap2 = await db.collection("agent_sessions").where("userId", "==", iv.caregiverId).limit(1).get();
                if (!cgSessSnap2.empty) {
                    const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("../linq/client")));
                    await sendToPhone(cgSessSnap2.docs[0].id, "Great news — the family would like to move forward with you! They'll reach out soon to finalize the schedule.").catch(() => { });
                }
            }
            await db.collection("admin_alerts").add({ type: "interview_feedback_submitted", fitLevel, interviewId, clientId, caregiverId: iv.caregiverId, priority: fitLevel === "strong" ? "high" : "low", resolved: false, createdAt: nowIso });
            (0, auditLog_1.logAudit)({ eventType: "interview_feedback_submitted", userId: clientId, data: { source: "mcp:submit_interview_feedback", interviewId, fitLevel } }).catch(() => { });
            return { success: true, fitLevel, hireRequestCreated };
        }
        if (name === "request_instant_payout") {
            const { caregiverId, amountCents } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const cgSnap3 = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap3.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            const cg3 = cgSnap3.data();
            if (!cg3.stripeAccountId)
                return toolError("INVALID_INPUT", "Stripe account not set up — complete onboarding first");
            if (!cg3.payoutsEnabled)
                return toolError("INVALID_INPUT", "Payouts are not yet enabled on your account");
            const { getStripeClient } = await Promise.resolve().then(() => __importStar(require("../stripe")));
            const sc = getStripeClient();
            const balance = await sc.balance.retrieve({ stripeAccount: cg3.stripeAccountId });
            const availableCents = (_39 = (_38 = balance.available[0]) === null || _38 === void 0 ? void 0 : _38.amount) !== null && _39 !== void 0 ? _39 : 0;
            if (availableCents <= 0)
                return toolError("INVALID_INPUT", "No available balance to pay out");
            const payoutCents = amountCents != null ? Number(amountCents) : availableCents;
            if (payoutCents > availableCents)
                return toolError("INVALID_INPUT", `Requested $${(payoutCents / 100).toFixed(2)} exceeds available balance of $${(availableCents / 100).toFixed(2)}`);
            await sc.payouts.create({ amount: payoutCents, currency: "usd", method: "instant" }, { stripeAccount: cg3.stripeAccountId });
            (0, auditLog_1.logAudit)({ eventType: "instant_payout_requested", userId: caregiverId, data: { source: "mcp:request_instant_payout", amountCents: payoutCents } }).catch(() => { });
            return { success: true, amountCents: payoutCents, amountDollars: `$${(payoutCents / 100).toFixed(2)}`, estimatedArrival: "within minutes" };
        }
        if (name === "submit_shift_hours") {
            const { caregiverId, appointmentId, clockInTime, clockOutTime, breakMinutes } = input;
            if (!caregiverId || !appointmentId || !clockInTime || !clockOutTime)
                return toolError("INVALID_INPUT", "caregiverId, appointmentId, clockInTime, and clockOutTime are required");
            const apptSnap3 = await db.collection("appointments").doc(appointmentId).get();
            if (!apptSnap3.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const appt3 = apptSnap3.data();
            if (appt3.caregiverId !== caregiverId)
                return toolError("PERMISSION_DENIED", "Appointment does not belong to this caregiver");
            if (!["completed", "in-progress", "in_progress"].includes(appt3.status))
                return toolError("INVALID_INPUT", "Shift hours can only be submitted for completed or in-progress visits");
            const existingShift = await db.collection("shiftHours").doc(appointmentId).get();
            if (existingShift.exists && existingShift.data().status !== "correction_requested")
                return toolError("INVALID_INPUT", "Shift hours already submitted for this appointment");
            const [inH, inM] = clockInTime.split(":").map(Number);
            const [outH, outM] = clockOutTime.split(":").map(Number);
            const totalMins3 = (outH * 60 + outM) - (inH * 60 + inM) - (Number(breakMinutes) || 0);
            if (totalMins3 <= 0)
                return toolError("INVALID_INPUT", "Clock-out time must be after clock-in time");
            const durationHours3 = Math.round((totalMins3 / 60) * 100) / 100;
            const hourlyRate3 = (_40 = appt3.hourlyRate) !== null && _40 !== void 0 ? _40 : 22;
            const amountCents3 = Math.round(durationHours3 * hourlyRate3 * 100);
            await db.collection("shiftHours").doc(appointmentId).set({ appointmentId, caregiverId, clientId: appt3.clientId, clockInTime, clockOutTime, breakMinutes: Number(breakMinutes) || 0, durationHours: durationHours3, date: appt3.date, hourlyRate: hourlyRate3, amountCents: amountCents3, status: "pending_client_review", submittedAt: nowIso, paymentAttemptCount: 0 }, { merge: false });
            const clientSessSnap3 = await db.collection("agent_sessions").where("userId", "==", appt3.clientId).limit(1).get();
            if (!clientSessSnap3.empty) {
                const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("../agents/caraAgent")));
                const cgData3 = (await db.collection("caregivers").doc(caregiverId).get()).data();
                const cgName3 = (_42 = (_41 = cgData3 === null || cgData3 === void 0 ? void 0 : cgData3.name) !== null && _41 !== void 0 ? _41 : cgData3 === null || cgData3 === void 0 ? void 0 : cgData3.firstName) !== null && _42 !== void 0 ? _42 : "Your caregiver";
                await sendViaInteractionAgent(clientSessSnap3.docs[0].id, { content: `${cgName3} submitted shift hours: ${clockInTime}–${clockOutTime} = ${durationHours3}h ($${(amountCents3 / 100).toFixed(2)}). Reply APPROVE or let me know if anything needs adjusting.`, urgency: "standard", sourceAgent: "mcp:submit_shift_hours", canDrop: false }).catch(() => { });
            }
            (0, auditLog_1.logAudit)({ eventType: "shift_hours_submitted", userId: caregiverId, data: { source: "mcp:submit_shift_hours", appointmentId, durationHours: durationHours3, amountCents: amountCents3 } }).catch(() => { });
            return { success: true, durationHours: durationHours3, amountCents: amountCents3, amountDollars: `$${(amountCents3 / 100).toFixed(2)}` };
        }
        if (name === "review_shift_hours") {
            const { clientId, appointmentId, decision, correctedHours, reason } = input;
            if (!clientId || !appointmentId || !decision)
                return toolError("INVALID_INPUT", "clientId, appointmentId, and decision are required");
            if (decision === "dispute" && correctedHours == null)
                return toolError("INVALID_INPUT", "correctedHours is required when disputing");
            const shiftSnap = await db.collection("shiftHours").doc(appointmentId).get();
            if (!shiftSnap.exists)
                return toolError("NOT_FOUND", "Shift hours submission not found");
            const shift = shiftSnap.data();
            if (shift.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Shift hours do not belong to this client");
            if (shift.status !== "pending_client_review")
                return toolError("INVALID_INPUT", `Shift hours already reviewed (status: ${shift.status})`);
            await shiftSnap.ref.update({ status: decision === "approve" ? "approved" : "disputed", reviewedAt: nowIso, correctedHours: correctedHours !== null && correctedHours !== void 0 ? correctedHours : null, disputeReason: reason !== null && reason !== void 0 ? reason : null });
            if (decision === "dispute") {
                const cgSessSnap4 = await db.collection("agent_sessions").where("userId", "==", shift.caregiverId).limit(1).get();
                if (!cgSessSnap4.empty) {
                    const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("../linq/client")));
                    await sendToPhone(cgSessSnap4.docs[0].id, `The family reviewed your shift hours and suggested a correction: ${correctedHours}h. Text me if you'd like to discuss.`).catch(() => { });
                }
            }
            (0, auditLog_1.logAudit)({ eventType: "shift_hours_reviewed", userId: clientId, data: { source: "mcp:review_shift_hours", appointmentId, decision } }).catch(() => { });
            return { success: true, decision, appointmentId };
        }
        if (name === "resume_execution_agent") {
            const { agentId, input: agentInput } = input;
            if (!agentId || !agentInput)
                return toolError("INVALID_INPUT", "agentId and input are required");
            const { runExecutionAgentTurn } = await Promise.resolve().then(() => __importStar(require("../agents/executionAgent")));
            const reply = await runExecutionAgentTurn(agentId, agentInput);
            if (!reply)
                return toolError("UNAVAILABLE", "Execution agent is no longer active");
            return { success: true, reply };
        }
        if (name === "create_support_ticket") {
            const { userId, userType, subject, description: ticketDesc, category } = input;
            if (!userId || !userType || !subject || !ticketDesc)
                return toolError("INVALID_INPUT", "userId, userType, subject, and description are required");
            const ticketRef = await db.collection("support_tickets").add({ userId, userType, subject, description: ticketDesc, category: category !== null && category !== void 0 ? category : "other", status: "open", source: "cara_sms", createdAt: nowIso, resolved: false });
            await db.collection("admin_alerts").add({ type: "support_ticket_created", ticketId: ticketRef.id, userId, userType, subject, priority: "medium", resolved: false, createdAt: nowIso });
            (0, auditLog_1.logAudit)({ eventType: "support_ticket_created", userId: userId, data: { source: "mcp:create_support_ticket", ticketId: ticketRef.id, subject } }).catch(() => { });
            return { success: true, ticketId: ticketRef.id };
        }
        // ── schedule_interview ──────────────────────────────────────────────────
        if (name === "schedule_interview") {
            const { clientId, caregiverId, applicationId, preferredDate, preferredTime, interviewType } = input;
            if (!clientId || !caregiverId || !preferredDate || !preferredTime)
                return toolError("INVALID_INPUT", "clientId, caregiverId, preferredDate, and preferredTime are required");
            const scheduledTime = `${preferredDate}T${preferredTime}:00`;
            const ivRef = await db.collection("video_interviews").add({
                clientId,
                caregiverId,
                applicationId: applicationId !== null && applicationId !== void 0 ? applicationId : null,
                scheduledTime,
                interviewType: interviewType !== null && interviewType !== void 0 ? interviewType : "video",
                status: "scheduled",
                createdAt: nowIso,
                feedbackSubmitted: false,
            });
            if (applicationId) {
                await db.collection("job_applications").doc(applicationId).update({ status: "interview_scheduled", interviewId: ivRef.id }).catch(() => { });
            }
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgPhone = (_43 = cgSnap.data()) === null || _43 === void 0 ? void 0 : _43.phone;
            let notification = { sent: false, reason: "no_caregiver_phone" };
            if (cgPhone) {
                const clientSnap = await db.collection("users").doc(clientId).get();
                const clientName = (_45 = (_44 = clientSnap.data()) === null || _44 === void 0 ? void 0 : _44.name) !== null && _45 !== void 0 ? _45 : "A family";
                const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                notification = await trySend(cgPhone, `Interview scheduled! ${clientName} wants to meet ${preferredDate} at ${preferredTime}. Reply to confirm.`, "mcp:schedule_interview");
            }
            (0, auditLog_1.logAudit)({ eventType: "interview_scheduled", userId: clientId, data: { source: "mcp:schedule_interview", interviewId: ivRef.id, caregiverId, scheduledTime, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, interviewId: ivRef.id, scheduledTime, interviewType: interviewType !== null && interviewType !== void 0 ? interviewType : "video", notification };
        }
        // ── respond_to_interview_request ────────────────────────────────────────
        if (name === "respond_to_interview_request") {
            const { caregiverId, interviewId, decision, proposedDate, proposedTime, message: ivMsg } = input;
            if (!caregiverId || !interviewId || !decision)
                return toolError("INVALID_INPUT", "caregiverId, interviewId, and decision are required");
            const ivSnap = await db.collection("video_interviews").doc(interviewId).get();
            if (!ivSnap.exists)
                return toolError("NOT_FOUND", "Interview not found");
            const iv = ivSnap.data();
            if (iv.caregiverId !== caregiverId)
                return toolError("PERMISSION_DENIED", "Interview does not belong to this caregiver");
            const newStatus = decision === "accept" ? "confirmed" : "declined";
            const upd = { status: newStatus, respondedAt: nowIso };
            if (proposedDate && proposedTime) {
                upd.proposedTime = `${proposedDate}T${proposedTime}:00`;
            }
            await ivSnap.ref.update(upd);
            const clientSess = await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
            if (!clientSess.empty) {
                const cgData = (await db.collection("caregivers").doc(caregiverId).get()).data();
                const cgName = (_46 = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _46 !== void 0 ? _46 : "The caregiver";
                const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("../linq/client")));
                const notifyMsg = decision === "accept"
                    ? `${cgName} confirmed the interview for ${(_48 = (_47 = iv.scheduledTime) === null || _47 === void 0 ? void 0 : _47.slice(0, 10)) !== null && _48 !== void 0 ? _48 : "the scheduled time"}.`
                    : proposedDate
                        ? `${cgName} can't make the original time but is free ${proposedDate} at ${proposedTime !== null && proposedTime !== void 0 ? proposedTime : ""}.`
                        : `${cgName} isn't available for the interview. ${(_49 = ivMsg) !== null && _49 !== void 0 ? _49 : ""}`.trim();
                await sendToPhone(clientSess.docs[0].id, notifyMsg).catch(() => { });
            }
            (0, auditLog_1.logAudit)({ eventType: "interview_responded", userId: caregiverId, data: { source: "mcp:respond_to_interview_request", interviewId, decision } }).catch(() => { });
            return { success: true, decision, interviewId, proposedTime: proposedDate ? `${proposedDate}T${proposedTime}:00` : null };
        }
        // ── get_care_team ───────────────────────────────────────────────────────
        if (name === "get_care_team") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const today = new Date().toISOString().slice(0, 10);
            const teamSnap = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "in", ["confirmed", "completed", "in-progress"])
                .orderBy("date", "desc")
                .limit(50)
                .get();
            const seenCaregivers = new Map();
            for (const d of teamSnap.docs) {
                const appt = d.data();
                const cid = appt.caregiverId;
                if (!seenCaregivers.has(cid)) {
                    seenCaregivers.set(cid, { nextShift: appt.date >= today ? appt.date : null, lastSeen: appt.date });
                }
                else if (appt.date >= today && !seenCaregivers.get(cid).nextShift) {
                    seenCaregivers.get(cid).nextShift = appt.date;
                }
            }
            const careTeam = await Promise.all([...seenCaregivers.entries()].slice(0, 10).map(async ([cid, meta]) => {
                var _a, _b, _c, _d, _e, _f;
                const cgSnap = await db.collection("caregivers").doc(cid).get();
                const cg = (_a = cgSnap.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    caregiverId: cid,
                    name: (_b = cg.name) !== null && _b !== void 0 ? _b : (`${(_c = cg.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg.lastName) !== null && _d !== void 0 ? _d : ""}`.trim() || "Caregiver"),
                    phone: (_e = cg.phone) !== null && _e !== void 0 ? _e : null,
                    rating: (_f = cg.rating) !== null && _f !== void 0 ? _f : null,
                    nextShift: meta.nextShift,
                    lastSeen: meta.lastSeen,
                };
            }));
            return { success: true, careTeam, total: careTeam.length };
        }
        // ── get_invoice_history ─────────────────────────────────────────────────
        if (name === "get_invoice_history") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const limit10 = Math.min((_50 = input.limit) !== null && _50 !== void 0 ? _50 : 5, 20);
            const invSnap = await db.collection("shiftHours")
                .where("clientId", "==", clientId)
                .where("status", "in", ["approved", "paid"])
                .orderBy("submittedAt", "desc")
                .limit(limit10)
                .get();
            const invoices = await Promise.all(invSnap.docs.map(async (d) => {
                var _a, _b, _c, _d, _e, _f;
                const sh = d.data();
                const cgSnap = await db.collection("caregivers").doc(sh.caregiverId).get().catch(() => null);
                const cg = (_a = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    invoiceId: d.id,
                    date: sh.date,
                    caregiverName: ((_b = cg.name) !== null && _b !== void 0 ? _b : `${(_c = cg.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg.lastName) !== null && _d !== void 0 ? _d : ""}`.trim()) || "Caregiver",
                    hours: sh.durationHours,
                    amount: `$${(((_e = sh.amountCents) !== null && _e !== void 0 ? _e : 0) / 100).toFixed(2)}`,
                    status: sh.status,
                    approvedAt: (_f = sh.reviewedAt) !== null && _f !== void 0 ? _f : null,
                };
            }));
            return { success: true, invoices, total: invoices.length };
        }
        // ── edit_job_post ───────────────────────────────────────────────────────
        if (name === "edit_job_post") {
            const { jobId, clientId, rate, description, startDate, daysOfWeek, timeOfDay, paymentMethod } = input;
            if (!jobId || !clientId)
                return toolError("INVALID_INPUT", "jobId and clientId are required");
            const jpSnap = await db.collection("job_posts").doc(jobId).get();
            if (!jpSnap.exists)
                return toolError("NOT_FOUND", "Job post not found");
            const jp = jpSnap.data();
            if (jp.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "This job post does not belong to you");
            if (jp.status !== "open")
                return toolError("INVALID_INPUT", `Cannot edit a job post with status '${jp.status}'`);
            const upd = { updatedAt: nowIso };
            if (rate != null)
                upd.hourlyRate = rate;
            if (description != null)
                upd.description = description.slice(0, 500);
            if (startDate != null)
                upd.startDate = startDate;
            if (daysOfWeek != null)
                upd["schedule.days"] = daysOfWeek;
            if (timeOfDay != null)
                upd["schedule.timeOfDay"] = timeOfDay;
            if (paymentMethod != null)
                upd.paymentMethod = paymentMethod;
            await jpSnap.ref.update(upd);
            await db.collection("job_postings").doc(clientId).set(Object.assign(Object.assign({}, upd), { clientId }), { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "job_post_edited", userId: clientId, data: { source: "mcp:edit_job_post", jobId, fields: Object.keys(upd) } }).catch(() => { });
            return { success: true, jobId, updatedFields: Object.keys(upd).filter(k => k !== "updatedAt") };
        }
        // ── send_client_message ─────────────────────────────────────────────────
        if (name === "send_client_message") {
            const { caregiverId, message, clientId: clientIdInput } = input;
            if (!caregiverId || !message)
                return toolError("INVALID_INPUT", "caregiverId and message are required");
            let resolvedClientId = clientIdInput;
            // If clientId is omitted we MUST verify the caregiver has an active or
            // recent engagement with that client. Previously this auto-resolved from
            // the most-recent appointment regardless of age or status, which let a
            // dismissed caregiver message any past client (IDOR).
            if (!resolvedClientId) {
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                const activeOrRecent = await db.collection("appointments")
                    .where("caregiverId", "==", caregiverId)
                    .where("status", "in", ["confirmed", "in_progress", "completed"])
                    .orderBy("date", "desc")
                    .limit(5)
                    .get();
                const eligible = activeOrRecent.docs.find((d) => {
                    const data = d.data();
                    const date = data.date;
                    const status = data.status;
                    // Confirmed/in-progress regardless of date; completed only if within 30 days.
                    if (status === "confirmed" || status === "in_progress")
                        return true;
                    if (status === "completed" && date && date >= thirtyDaysAgo)
                        return true;
                    return false;
                });
                if (eligible)
                    resolvedClientId = eligible.data().clientId;
            }
            else {
                // Explicit clientId still requires verifying the relationship exists —
                // anyone could otherwise pass an arbitrary clientId to address.
                const relationship = await db.collection("appointments")
                    .where("caregiverId", "==", caregiverId)
                    .where("clientId", "==", resolvedClientId)
                    .where("status", "in", ["confirmed", "in_progress", "completed"])
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
            const clientPhone = (_51 = clientSnap.data()) === null || _51 === void 0 ? void 0 : _51.phone;
            if (!clientPhone)
                return toolError("NOT_FOUND", "Client phone number not found");
            const cgData = (await db.collection("caregivers").doc(caregiverId).get()).data();
            const cgName = (_52 = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _52 !== void 0 ? _52 : "Your caregiver";
            const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
            const notification = await trySend(clientPhone, `${cgName}: ${message}`, "mcp:send_client_message");
            (0, auditLog_1.logAudit)({ eventType: "caregiver_sent_message", userId: caregiverId, data: { source: "mcp:send_client_message", resolvedClientId, messageLength: message.length, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, sentTo: resolvedClientId, notification };
        }
        // ── get_payout_history ──────────────────────────────────────────────────
        if (name === "get_payout_history") {
            const { caregiverId } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const limit11 = Math.min((_53 = input.limit) !== null && _53 !== void 0 ? _53 : 5, 20);
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            const cg = cgSnap.data();
            if (!cg.stripeAccountId)
                return { success: true, payouts: [], message: "No payout account set up yet. Complete Stripe Connect onboarding to start receiving payouts." };
            try {
                const { getStripeClient } = await Promise.resolve().then(() => __importStar(require("../stripe")));
                const sc = getStripeClient();
                const payoutList = await sc.payouts.list({ limit: limit11 }, { stripeAccount: cg.stripeAccountId });
                const payouts = payoutList.data.map((p) => ({
                    id: p.id,
                    amount: `$${(p.amount / 100).toFixed(2)}`,
                    status: p.status,
                    method: p.method,
                    arrivalDate: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
                    createdAt: new Date(p.created * 1000).toISOString().slice(0, 10),
                }));
                return { success: true, payouts, hasMore: payoutList.has_more };
            }
            catch (stripeErr) {
                console.error("get_payout_history stripe error:", stripeErr);
                return toolError("UNAVAILABLE", "Could not fetch payout history from Stripe right now");
            }
        }
        // ── get_recent_messages ─────────────────────────────────────────────────
        if (name === "get_recent_messages") {
            const { userId, counterpartId } = input;
            if (!userId)
                return toolError("INVALID_INPUT", "userId is required");
            const msgLimit = Math.min((_54 = input.limit) !== null && _54 !== void 0 ? _54 : 5, 20);
            let threadsQuery = db.collection("threads").where("participants", "array-contains", userId);
            if (counterpartId)
                threadsQuery = threadsQuery.where("participants", "array-contains", counterpartId);
            const threadsSnap = await threadsQuery.orderBy("updatedAt", "desc").limit(5).get();
            const results = await Promise.all(threadsSnap.docs.map(async (t) => {
                var _a, _b, _c, _d, _e, _f;
                const thread = t.data();
                const participants = (_a = thread.participants) !== null && _a !== void 0 ? _a : [];
                const otherUserId = participants.find((p) => p !== userId);
                let otherName = "Unknown";
                if (otherUserId) {
                    const cgSnap = await db.collection("caregivers").doc(otherUserId).get().catch(() => null);
                    const uSnap = await db.collection("users").doc(otherUserId).get().catch(() => null);
                    const d = (_c = (_b = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) !== null && _b !== void 0 ? _b : uSnap === null || uSnap === void 0 ? void 0 : uSnap.data()) !== null && _c !== void 0 ? _c : {};
                    otherName = (_d = d.name) !== null && _d !== void 0 ? _d : (`${(_e = d.firstName) !== null && _e !== void 0 ? _e : ""} ${(_f = d.lastName) !== null && _f !== void 0 ? _f : ""}`.trim() || "Unknown");
                }
                const msgsSnap = await db.collection("threads").doc(t.id).collection("messages")
                    .orderBy("timestamp", "desc").limit(msgLimit).get();
                const messages = msgsSnap.docs.reverse().map((m) => {
                    var _a;
                    const msg = m.data();
                    return {
                        from: msg.senderId === userId ? "you" : otherName,
                        text: ((_a = msg.text) !== null && _a !== void 0 ? _a : "").slice(0, 200),
                        timestamp: msg.timestamp,
                    };
                });
                return { threadId: t.id, with: otherName, messages };
            }));
            return { success: true, threads: results, total: results.length };
        }
        // ── list_client_jobs ────────────────────────────────────────────────────
        if (name === "list_client_jobs") {
            const { clientId, status } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            let query = db.collection("job_posts").where("clientId", "==", clientId);
            if (status && status !== "all")
                query = query.where("status", "==", status);
            const snap = await query.orderBy("createdAt", "desc").limit(10).get();
            const jobs = snap.docs.map((d) => {
                var _a, _b, _c;
                const data = d.data();
                return {
                    id: d.id,
                    title: (_a = data.summary) !== null && _a !== void 0 ? _a : `Care job — ${((_b = data.careTypes) !== null && _b !== void 0 ? _b : []).slice(0, 2).join(", ")}`,
                    status: data.status,
                    applicantCount: (_c = data.applicantCount) !== null && _c !== void 0 ? _c : 0,
                    createdAt: data.createdAt,
                    schedule: data.schedule,
                };
            });
            return { success: true, jobs, total: jobs.length };
        }
        // ── cancel_job_post ─────────────────────────────────────────────────────
        if (name === "cancel_job_post") {
            const { jobId, clientId } = input;
            if (!jobId || !clientId)
                return toolError("INVALID_INPUT", "jobId and clientId are required");
            const jpSnap = await db.collection("job_posts").doc(jobId).get();
            if (!jpSnap.exists)
                return toolError("NOT_FOUND", "Job post not found");
            const jp = jpSnap.data();
            if (jp.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "This job post does not belong to you");
            if (jp.status === "closed" || jp.status === "cancelled")
                return toolError("INVALID_INPUT", "Job post is already closed");
            await jpSnap.ref.update({ status: "closed", closedAt: nowIso });
            (0, auditLog_1.logAudit)({ eventType: "job_post_cancelled", userId: clientId, data: { source: "mcp:cancel_job_post", jobId } }).catch(() => { });
            return { success: true, jobId };
        }
        // ── list_job_applicants ─────────────────────────────────────────────────
        if (name === "list_job_applicants") {
            const { jobId, clientId } = input;
            if (!jobId || !clientId)
                return toolError("INVALID_INPUT", "jobId and clientId are required");
            const jpSnap2 = await db.collection("job_posts").doc(jobId).get();
            if (!jpSnap2.exists)
                return toolError("NOT_FOUND", "Job post not found");
            if (jpSnap2.data().clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Not authorized");
            const appSnap3 = await db.collection("job_applications").where("jobId", "==", jobId).limit(10).get();
            const applicants = await Promise.all(appSnap3.docs.map(async (d) => {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                const app = d.data();
                const cgSnap = await db.collection("caregivers").doc(app.caregiverId).get();
                const cg = (_a = cgSnap.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    applicationId: d.id,
                    caregiverName: ((_b = cg.name) !== null && _b !== void 0 ? _b : `${(_c = cg.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg.lastName) !== null && _d !== void 0 ? _d : ""}`.trim()) || "Unknown",
                    caregiverId: app.caregiverId,
                    proposedRate: (_e = app.proposedRate) !== null && _e !== void 0 ? _e : null,
                    coverNote: (_f = app.coverNote) !== null && _f !== void 0 ? _f : null,
                    status: (_g = app.status) !== null && _g !== void 0 ? _g : "pending",
                    appliedAt: app.appliedAt,
                    rating: (_h = cg.rating) !== null && _h !== void 0 ? _h : null,
                };
            }));
            return { success: true, applicants, total: applicants.length };
        }
        // ── get_caregiver_earnings ──────────────────────────────────────────────
        if (name === "get_caregiver_earnings") {
            const { caregiverId } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const cgSnap5 = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap5.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            const cg5 = cgSnap5.data();
            const earnSnap = await db
                .collection("appointments")
                .where("caregiverId", "==", caregiverId)
                .where("status", "==", "completed")
                .where("isoDate", ">=", daysAgo)
                .orderBy("isoDate", "desc")
                .limit(50)
                .get();
            const totalEarned = earnSnap.docs.reduce((sum, d) => { var _a; return sum + ((_a = d.data().cost) !== null && _a !== void 0 ? _a : 0); }, 0);
            return {
                success: true,
                totalEarned: Math.round(totalEarned * 100) / 100,
                pendingBalance: (_55 = cg5.pendingBalance) !== null && _55 !== void 0 ? _55 : 0,
                stripeSetup: !!cg5.stripeAccountId,
                payoutsEnabled: !!cg5.payoutsEnabled,
                recentVisitCount: earnSnap.size,
                periodDays: daysBack,
            };
        }
        // ── update_caregiver_availability ───────────────────────────────────────
        if (name === "update_caregiver_availability") {
            const { caregiverId, availableDays, unavailableDays, preferredTimeOfDay } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const cgSnap6 = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap6.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            const upd6 = { updatedAt: nowIso };
            if (Array.isArray(availableDays) && availableDays.length > 0)
                upd6["availability"] = admin.firestore.FieldValue.arrayUnion(...availableDays);
            if (Array.isArray(unavailableDays) && unavailableDays.length > 0)
                upd6["availability"] = admin.firestore.FieldValue.arrayRemove(...unavailableDays);
            if (typeof preferredTimeOfDay === "string")
                upd6["preferredTimeOfDay"] = preferredTimeOfDay;
            await cgSnap6.ref.update(upd6);
            (0, auditLog_1.logAudit)({ eventType: "caregiver_availability_updated", userId: caregiverId, data: { source: "mcp:update_caregiver_availability", availableDays, unavailableDays } }).catch(() => { });
            // Auto-reject pending interview_requests that fall on days no longer available
            let conflictsCancelled = 0;
            if (Array.isArray(unavailableDays) && unavailableDays.length > 0) {
                const removedDays = unavailableDays.map((d) => d.toLowerCase());
                const pendingInterviews = await db.collection("interview_requests")
                    .where("caregiverId", "==", caregiverId)
                    .where("status", "in", ["pending_presentation", "awaiting_caregiver_response", "scheduled"])
                    .get();
                const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
                const conflictedRequests = [];
                for (const doc of pendingInterviews.docs) {
                    const req = doc.data();
                    // Check if scheduled date falls on a removed day
                    const scheduledDate = (_56 = req.scheduledAt) !== null && _56 !== void 0 ? _56 : req.proposedTime;
                    if (scheduledDate) {
                        const dayOfWeek = DAY_NAMES[new Date(scheduledDate).getDay()];
                        if (removedDays.includes(dayOfWeek)) {
                            conflictedRequests.push({ id: doc.id, clientPhone: req.clientPhone, scheduledDate });
                        }
                    }
                }
                for (const conflict of conflictedRequests) {
                    await db.collection("interview_requests").doc(conflict.id).update({
                        status: "cancelled_availability",
                        cancelledAt: nowIso,
                        cancelReason: "caregiver_removed_availability",
                    }).catch(() => { });
                    // Notify the client that this interview slot is no longer available
                    if (conflict.clientPhone) {
                        const clientSess = await db.collection("agent_sessions").doc(conflict.clientPhone).get().catch(() => null);
                        if (clientSess === null || clientSess === void 0 ? void 0 : clientSess.exists) {
                            const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("../linq/client")));
                            const cgData = cgSnap6.data();
                            const cgName = (_58 = (_57 = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _57 !== void 0 ? _57 : cgData === null || cgData === void 0 ? void 0 : cgData.firstName) !== null && _58 !== void 0 ? _58 : "The caregiver";
                            await sendToPhone(conflict.clientPhone, `${cgName} is no longer available on that day and your scheduled interview has been cancelled. ` +
                                `Would you like me to find another time or a different caregiver?`).catch(() => { });
                            // Set state so client's next YES triggers rematching
                            await db.collection("agent_sessions").doc(conflict.clientPhone).update({
                                pendingRematch: { reason: "interview_cancelled_availability", caregiverId },
                                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                            }).catch(() => { });
                        }
                    }
                    conflictsCancelled++;
                }
            }
            return { success: true, updated: { availableDays: availableDays !== null && availableDays !== void 0 ? availableDays : [], unavailableDays: unavailableDays !== null && unavailableDays !== void 0 ? unavailableDays : [], preferredTimeOfDay: preferredTimeOfDay !== null && preferredTimeOfDay !== void 0 ? preferredTimeOfDay : null }, conflictingInterviewsCancelled: conflictsCancelled };
        }
        // ── browse_job_board ────────────────────────────────────────────────────
        if (name === "browse_job_board") {
            const { caregiverId } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const cgSnap7 = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap7.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            const limit7 = Math.min((_59 = input.limit) !== null && _59 !== void 0 ? _59 : 5, 10);
            const alreadyApplied = await db.collection("job_applications").where("caregiverId", "==", caregiverId).get();
            const appliedJobIds = new Set(alreadyApplied.docs.map((d) => d.data().jobId));
            const jobsSnap = await db.collection("job_posts").where("status", "==", "open").orderBy("createdAt", "desc").limit(20).get();
            const jobs7 = jobsSnap.docs
                .filter((d) => !appliedJobIds.has(d.id))
                .slice(0, limit7)
                .map((d) => {
                var _a, _b, _c, _d, _e, _f;
                const data = d.data();
                return {
                    jobId: d.id,
                    summary: (_a = data.summary) !== null && _a !== void 0 ? _a : "Care job",
                    careNeeds: (_b = data.careTypes) !== null && _b !== void 0 ? _b : [],
                    schedule: (_c = data.schedule) !== null && _c !== void 0 ? _c : {},
                    hourlyRate: (_d = data.hourlyRate) !== null && _d !== void 0 ? _d : null,
                    location: (_f = (_e = data.location) === null || _e === void 0 ? void 0 : _e.city) !== null && _f !== void 0 ? _f : "Nearby",
                };
            });
            return { success: true, jobs: jobs7, total: jobs7.length };
        }
        // ── get_my_applications ─────────────────────────────────────────────────
        if (name === "get_my_applications") {
            const { caregiverId } = input;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const myAppSnap = await db.collection("job_applications").where("caregiverId", "==", caregiverId).orderBy("appliedAt", "desc").limit(10).get();
            const applications = await Promise.all(myAppSnap.docs.map(async (d) => {
                var _a, _b, _c, _d, _e;
                const app = d.data();
                const jpSnap3 = await db.collection("job_posts").doc(app.jobId).get().catch(() => null);
                const jp3 = (_a = jpSnap3 === null || jpSnap3 === void 0 ? void 0 : jpSnap3.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    applicationId: d.id,
                    jobId: app.jobId,
                    jobSummary: (_b = jp3.summary) !== null && _b !== void 0 ? _b : `Care job`,
                    jobStatus: (_c = jp3.status) !== null && _c !== void 0 ? _c : "unknown",
                    status: (_d = app.status) !== null && _d !== void 0 ? _d : "pending",
                    appliedAt: app.appliedAt,
                    proposedRate: (_e = app.proposedRate) !== null && _e !== void 0 ? _e : null,
                };
            }));
            return { success: true, applications, total: applications.length };
        }
        // ── get_pending_timesheets ──────────────────────────────────────────────
        if (name === "get_pending_timesheets") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const tsSnap = await db.collection("shiftHours").where("clientId", "==", clientId).where("status", "==", "pending_client_review").orderBy("submittedAt", "desc").limit(5).get();
            const timesheets = await Promise.all(tsSnap.docs.map(async (d) => {
                var _a, _b, _c, _d, _e;
                const ts = d.data();
                const cgSnap8 = await db.collection("caregivers").doc(ts.caregiverId).get().catch(() => null);
                const cg8 = (_a = cgSnap8 === null || cgSnap8 === void 0 ? void 0 : cgSnap8.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    appointmentId: ts.appointmentId,
                    caregiverName: ((_b = cg8.name) !== null && _b !== void 0 ? _b : `${(_c = cg8.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg8.lastName) !== null && _d !== void 0 ? _d : ""}`.trim()) || "Caregiver",
                    date: ts.date,
                    clockIn: ts.clockInTime,
                    clockOut: ts.clockOutTime,
                    hours: ts.durationHours,
                    amountOwed: `$${(((_e = ts.amountCents) !== null && _e !== void 0 ? _e : 0) / 100).toFixed(2)}`,
                    submittedAt: ts.submittedAt,
                };
            }));
            return { success: true, timesheets, total: timesheets.length };
        }
        // ── get_care_journal_client ─────────────────────────────────────────────
        if (name === "get_care_journal_client") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const limit9 = Math.min((_60 = input.limit) !== null && _60 !== void 0 ? _60 : 5, 20);
            const userSnap = await db.collection("users").doc(clientId).get();
            const seniorId9 = (_61 = userSnap.data()) === null || _61 === void 0 ? void 0 : _61.seniorId;
            if (!seniorId9)
                return toolError("NOT_FOUND", "No senior profile linked to this client");
            (0, auditLog_1.logHealthDataAccessed)(clientId, seniorId9, "mcp:get_care_journal_client").catch(() => { });
            const jSnap = await db.collection("care_journal").where("seniorId", "==", seniorId9).orderBy("timestamp", "desc").limit(limit9).get();
            const entries = await Promise.all(jSnap.docs.map(async (d) => {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                const entry = d.data();
                const cgSnap9 = await db.collection("caregivers").doc(entry.caregiverId).get().catch(() => null);
                const cg9 = (_a = cgSnap9 === null || cgSnap9 === void 0 ? void 0 : cgSnap9.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    timestamp: entry.timestamp,
                    caregiverName: ((_b = cg9.name) !== null && _b !== void 0 ? _b : `${(_c = cg9.firstName) !== null && _c !== void 0 ? _c : ""} ${(_d = cg9.lastName) !== null && _d !== void 0 ? _d : ""}`.trim()) || "Caregiver",
                    notes: (_e = entry.notes) !== null && _e !== void 0 ? _e : null,
                    mood: (_f = entry.mood) !== null && _f !== void 0 ? _f : null,
                    activities: (_g = entry.activities) !== null && _g !== void 0 ? _g : [],
                    wellness: (_h = entry.wellness) !== null && _h !== void 0 ? _h : null,
                };
            }));
            return { success: true, entries, total: entries.length };
        }
        // ── modify_recurring_schedule ───────────────────────────────────────────
        if (name === "modify_recurring_schedule") {
            const { scheduleId, clientId, newDays, newStartTime, newEndTime } = input;
            if (!scheduleId || !clientId)
                return toolError("INVALID_INPUT", "scheduleId and clientId are required");
            if (!newDays && !newStartTime && !newEndTime)
                return toolError("INVALID_INPUT", "At least one of newDays, newStartTime, or newEndTime is required");
            const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
            if (!schedSnap.exists)
                return toolError("NOT_FOUND", "Recurring schedule not found");
            const sched = schedSnap.data();
            if (sched.clientId !== clientId)
                return toolError("PERMISSION_DENIED", "Schedule does not belong to this client");
            if (sched.status === "cancelled")
                return toolError("INVALID_INPUT", "Cannot modify a cancelled schedule");
            const resolvedDays = (_62 = newDays) !== null && _62 !== void 0 ? _62 : sched.days;
            const resolvedStart = (_63 = newStartTime) !== null && _63 !== void 0 ? _63 : sched.startTime;
            const resolvedEnd = (_64 = newEndTime) !== null && _64 !== void 0 ? _64 : sched.endTime;
            // Validate times
            const timePattern = /^\d{2}:\d{2}$/;
            if (!timePattern.test(resolvedStart) || !timePattern.test(resolvedEnd)) {
                return toolError("INVALID_INPUT", "Start and end times must be in HH:MM format");
            }
            const [sh, sm] = resolvedStart.split(":").map(Number);
            const [eh, em] = resolvedEnd.split(":").map(Number);
            if (eh * 60 + em <= sh * 60 + sm)
                return toolError("INVALID_INPUT", "End time must be after start time");
            const newDurationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
            const today = nowIso.slice(0, 10);
            // Cancel all future confirmed appointments from the old schedule
            const futureSnap = await db.collection("appointments")
                .where("recurringScheduleId", "==", scheduleId)
                .where("date", ">", today)
                .where("status", "in", ["confirmed"])
                .get();
            const { generateRecurringDates } = await Promise.resolve().then(() => __importStar(require("../scheduled/recurringScheduler")));
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
                    caregiverId: sched.caregiverId,
                    caregiverName: sched.caregiverName,
                    date, startTime: resolvedStart, endTime: resolvedEnd,
                    durationHours: newDurationHours, hourlyRate: sched.hourlyRate,
                    status: "confirmed", recurringScheduleId: scheduleId,
                    humanApproved: true, createdByAgent: true, createdAt: nowIso,
                });
            }
            await batchMs.commit();
            // Notify caregiver
            const cgSnap = await db.collection("caregivers").doc(sched.caregiverId).get().catch(() => null);
            const cgPhone = (_65 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _65 === void 0 ? void 0 : _65.phone;
            let notification = { sent: false, reason: "no_caregiver_phone" };
            if (cgPhone) {
                const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                notification = await trySend(cgPhone, `Your recurring schedule with this family has been updated. New schedule: ${resolvedDays.join(", ")}, ${resolvedStart}–${resolvedEnd}. ` +
                    `Old upcoming visits were replaced with new ones.`, "mcp:modify_recurring_schedule");
            }
            (0, auditLog_1.logAudit)({ eventType: "recurring_schedule_updated", userId: clientId, data: { source: "mcp:modify_recurring_schedule", scheduleId, newDays: resolvedDays, newStartTime: resolvedStart, newEndTime: resolvedEnd, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, scheduleId, newDays: resolvedDays, newStartTime: resolvedStart, newEndTime: resolvedEnd, newVisitsCreated: newDatesArr.length, oldVisitsCancelled: futureSnap.size, notification };
        }
        // ── get_payment_update_link ─────────────────────────────────────────────
        if (name === "get_payment_update_link") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const userSnap = await db.collection("users").doc(clientId).get();
            if (!userSnap.exists)
                return toolError("NOT_FOUND", "Client not found");
            const stripeCustomerId = (_66 = userSnap.data()) === null || _66 === void 0 ? void 0 : _66.stripeCustomerId;
            if (!stripeCustomerId)
                return toolError("INVALID_INPUT", "No Stripe billing account found for this client. They may need to re-subscribe.");
            const { getStripeClient } = await Promise.resolve().then(() => __importStar(require("../stripe")));
            const sc = getStripeClient();
            const appUrl = (_67 = process.env.APP_URL) !== null && _67 !== void 0 ? _67 : "https://cara.app";
            const session = await sc.billingPortal.sessions.create({
                customer: stripeCustomerId,
                return_url: `${appUrl}/settings/billing`,
            });
            (0, auditLog_1.logAudit)({ eventType: "billing_portal_opened", userId: clientId, data: { source: "mcp:get_payment_update_link" } }).catch(() => { });
            return { success: true, url: session.url, expiresIn: "5 minutes" };
        }
        // ── get_invoice_details ─────────────────────────────────────────────────
        if (name === "get_invoice_details") {
            const { clientId: invClientId, invoiceId: invId } = input;
            if (!invClientId)
                return toolError("INVALID_INPUT", "clientId is required");
            let invDocs;
            if (invId) {
                const doc = await db.collection("invoices").doc(invId).get();
                invDocs = doc.exists ? [doc] : [];
            }
            else {
                const q = await db.collection("invoices")
                    .where("clientId", "==", invClientId)
                    .orderBy("createdAt", "desc")
                    .limit(1)
                    .get();
                invDocs = q.docs;
            }
            if (!invDocs.length)
                return toolError("NOT_FOUND", "No invoices found for this client.");
            const invoice = invDocs[0].data();
            return {
                invoiceId: invDocs[0].id,
                invoiceNumber: invoice.invoiceNumber,
                status: invoice.status,
                total: (_68 = invoice.total) !== null && _68 !== void 0 ? _68 : invoice.amount,
                lineItems: (_69 = invoice.lineItems) !== null && _69 !== void 0 ? _69 : [],
                carePeriod: invoice.carePeriod,
                createdAt: invoice.createdAt,
            };
        }
        // ── create_refund_request ───────────────────────────────────────────────
        if (name === "create_refund_request") {
            const { clientId: rfClientId, appointmentId: rfApptId, reason: rfReason } = input;
            if (!rfClientId || !rfApptId)
                return toolError("INVALID_INPUT", "clientId and appointmentId are required");
            const ref = await db.collection("refundRequests").add({
                clientId: rfClientId,
                appointmentId: rfApptId,
                reason: rfReason !== null && rfReason !== void 0 ? rfReason : "",
                status: "pending_review",
                requestedAt: nowIso,
                source: "cara_self_service",
            });
            return { success: true, requestId: ref.id, message: "Refund request submitted. Admin review within 24 hours." };
        }
        // ── get_care_plan_history ───────────────────────────────────────────────
        if (name === "get_care_plan_history") {
            const { seniorId: cpSeniorId } = input;
            if (!cpSeniorId)
                return toolError("INVALID_INPUT", "seniorId is required");
            const cpLimit = Math.min((_70 = input.limit) !== null && _70 !== void 0 ? _70 : 5, 10);
            const cpSnap = await db.collection("senior_profiles").doc(cpSeniorId)
                .collection("carePlanVersions")
                .orderBy("savedAt", "desc")
                .limit(cpLimit)
                .get();
            if (cpSnap.empty)
                return { versions: [], message: "No revision history yet." };
            return {
                versions: cpSnap.docs.map(d => ({
                    versionId: d.id,
                    savedAt: d.data().savedAt,
                    changedBy: d.data().changedBy,
                    summary: d.data().summary,
                })),
            };
        }
        // ── restore_care_plan_version ───────────────────────────────────────────
        if (name === "restore_care_plan_version") {
            const { seniorId: rSeniorId, versionId: rVersionId, clientId: rClientId } = input;
            if (!rSeniorId || !rVersionId || !rClientId)
                return toolError("INVALID_INPUT", "seniorId, versionId, and clientId are required");
            const rSenior = await db.collection("senior_profiles").doc(rSeniorId).get();
            if (!rSenior.exists)
                return toolError("NOT_FOUND", "Senior not found");
            const rVersionDoc = await db.collection("senior_profiles").doc(rSeniorId)
                .collection("carePlanVersions").doc(rVersionId).get();
            if (!rVersionDoc.exists)
                return toolError("NOT_FOUND", "Version not found");
            const rVersionData = rVersionDoc.data();
            // Save current plan as a version before restoring
            const rCurrentPlan = await db.collection("senior_profiles").doc(rSeniorId)
                .collection("care_plans").doc("active").get();
            if (rCurrentPlan.exists) {
                await db.collection("senior_profiles").doc(rSeniorId)
                    .collection("carePlanVersions").add(Object.assign(Object.assign({}, rCurrentPlan.data()), { savedAt: nowIso, changedBy: rClientId, summary: "Auto-saved before restore" }));
            }
            // Restore the selected version
            await db.collection("senior_profiles").doc(rSeniorId)
                .collection("care_plans").doc("active").set((_71 = rVersionData.carePlan) !== null && _71 !== void 0 ? _71 : rVersionData);
            (0, auditLog_1.logAudit)({ eventType: "care_plan_restored", userId: rClientId, data: { source: "mcp:restore_care_plan_version", seniorId: rSeniorId, versionId: rVersionId } }).catch(() => { });
            return { success: true, message: "Care plan restored to the selected version." };
        }
        // ── request_shift_swap ──────────────────────────────────────────────────
        if (name === "request_shift_swap") {
            const { caregiverId, appointmentId, reason } = input;
            const appt = await db.collection("appointments").doc(appointmentId).get();
            if (!appt.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const data = appt.data();
            const ref = await db.collection("shift_swap_requests").add({
                appointmentId,
                fromCaregiverId: caregiverId,
                fromCaregiverName: (_72 = data.caregiverName) !== null && _72 !== void 0 ? _72 : caregiverId,
                clientId: data.clientId,
                date: data.date,
                time: data.time,
                duration: data.duration,
                reason: reason !== null && reason !== void 0 ? reason : "",
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
            const { caregiverId, caregiverName, swapRequestId } = input;
            const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
            const swapDoc = await swapRef.get();
            if (!swapDoc.exists)
                return toolError("NOT_FOUND", "Swap request not found");
            const swap = swapDoc.data();
            if (swap.status !== "open")
                return { success: false, message: "This swap is no longer open." };
            await db.runTransaction(async (tx) => {
                tx.update(swapRef, { status: "accepted", toCaregiverId: caregiverId, toCaregiverName: caregiverName, acceptedAt: nowIso });
                tx.update(db.collection("appointments").doc(swap.appointmentId), { caregiverId, caregiverName, swapNote: `Swapped from ${swap.fromCaregiverName}` });
            });
            return { success: true, message: `Shift on ${swap.date} transferred to ${caregiverName}.` };
        }
        // ── cancel_shift_swap ───────────────────────────────────────────────────
        if (name === "cancel_shift_swap") {
            const { caregiverId, swapRequestId } = input;
            const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
            const swapDoc = await swapRef.get();
            if (!swapDoc.exists)
                return toolError("NOT_FOUND", "Swap request not found");
            if (swapDoc.data().fromCaregiverId !== caregiverId)
                return toolError("PERMISSION_DENIED", "You can only cancel your own swap requests");
            await swapRef.update({ status: "cancelled" });
            return { success: true };
        }
        // ── initiate_client_swap ────────────────────────────────────────────────
        if (name === "initiate_client_swap") {
            const { appointmentId } = input;
            const appt = await db.collection("appointments").doc(appointmentId).get();
            if (!appt.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const data = appt.data();
            const dayOfWeek = new Date(data.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
            const shiftHour = parseInt(((_73 = data.time) !== null && _73 !== void 0 ? _73 : "09:00").split(":")[0], 10);
            const snap = await db.collection("caregivers").where("verified", "==", true).limit(30).get();
            const options = [];
            for (const doc of snap.docs) {
                if (doc.id === data.caregiverId)
                    continue;
                const cg = doc.data();
                const avail = (_74 = cg.weeklyAvailability) === null || _74 === void 0 ? void 0 : _74[dayOfWeek];
                if (!(avail === null || avail === void 0 ? void 0 : avail.some(s => parseInt(s.start.split(":")[0], 10) <= shiftHour && shiftHour < parseInt(s.end.split(":")[0], 10))))
                    continue;
                const conflict = await db.collection("appointments").where("caregiverId", "==", doc.id).where("date", "==", data.date).where("status", "in", ["confirmed"]).limit(1).get();
                if (!conflict.empty)
                    continue;
                options.push({ caregiverId: doc.id, name: (_76 = (_75 = cg.name) !== null && _75 !== void 0 ? _75 : cg.firstName) !== null && _76 !== void 0 ? _76 : "Caregiver", rate: cg.hourlyRate });
                if (options.length >= 3)
                    break;
            }
            if (!options.length)
                return { available: [], message: "No available caregivers found for that date." };
            return { available: options, appointmentDate: data.date, currentCaregiver: data.caregiverName };
        }
        // ── get_job_recommendations ─────────────────────────────────────────────
        if (name === "get_job_recommendations") {
            const { getJobRecommendationsForCaregiver } = await Promise.resolve().then(() => __importStar(require("../agents/jobMatchRecommender")));
            const caregiverId = input.caregiverId;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const limit = Math.min((_77 = input.limit) !== null && _77 !== void 0 ? _77 : 5, 10);
            const recs = await getJobRecommendationsForCaregiver(caregiverId, limit);
            if (!recs.length)
                return { recommendations: [], message: "No open jobs matching your profile right now." };
            return { recommendations: recs };
        }
        // ── submit_gps_checkin ──────────────────────────────────────────────────
        if (name === "submit_gps_checkin") {
            const { caregiverId, appointmentId } = input;
            const latitude = input.latitude;
            const longitude = input.longitude;
            if (!caregiverId || !appointmentId || latitude == null || longitude == null) {
                return toolError("INVALID_INPUT", "caregiverId, appointmentId, latitude, and longitude are required");
            }
            const apptSnap = await db.collection("appointments").doc(appointmentId).get();
            if (!apptSnap.exists)
                return toolError("NOT_FOUND", "Appointment not found");
            const appt = apptSnap.data();
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
                clientLat: (_78 = senior === null || senior === void 0 ? void 0 : senior.latitude) !== null && _78 !== void 0 ? _78 : null,
                clientLon: (_79 = senior === null || senior === void 0 ? void 0 : senior.longitude) !== null && _79 !== void 0 ? _79 : null,
            });
            return { success: true, message: "Checked in. The family has been notified." };
        }
        // ── get_tax_summary ─────────────────────────────────────────────────────
        if (name === "get_tax_summary") {
            const { getCaregiverTaxSummary } = await Promise.resolve().then(() => __importStar(require("../billing/taxDocuments")));
            const caregiverId = input.caregiverId;
            if (!caregiverId)
                return toolError("INVALID_INPUT", "caregiverId is required");
            const year = (_80 = input.year) !== null && _80 !== void 0 ? _80 : new Date().getFullYear();
            const summary = await getCaregiverTaxSummary(caregiverId, year);
            return summary;
        }
        // ── update_user_profile ─────────────────────────────────────────────────
        if (name === "update_user_profile") {
            const { userId, firstName, lastName, phone, address, city, state, zip, photoUrl } = input;
            if (!userId)
                return toolError("INVALID_INPUT", "userId is required");
            const patch = { updatedAt: nowIso };
            if (firstName != null)
                patch.firstName = firstName;
            if (lastName != null)
                patch.lastName = lastName;
            if (address != null)
                patch.address = address;
            if (city != null)
                patch.city = city;
            if (state != null)
                patch.state = state;
            if (zip != null)
                patch.zip = zip;
            if (photoUrl != null)
                patch.photoUrl = photoUrl;
            // Phone changes trigger a re-verification — store as pendingPhone rather
            // than the live phone so the existing OTP flow can run before swapping.
            let phoneChangeRequested = false;
            if (phone != null) {
                if (!/^\+1\d{10}$/.test(phone)) {
                    return toolError("INVALID_INPUT", "phone must be in E.164 format (+1XXXXXXXXXX)");
                }
                patch.pendingPhone = phone;
                patch.pendingPhoneAt = nowIso;
                phoneChangeRequested = true;
            }
            if (Object.keys(patch).length === 1) {
                return toolError("INVALID_INPUT", "No fields to update");
            }
            await db.collection("users").doc(userId).set(patch, { merge: true });
            // If address fields touched and this is a single-senior household, mirror
            // to the senior profile too.
            if (address != null || city != null || state != null || zip != null) {
                const seniorSnap = await db.collection("senior_profiles").where("userId", "==", userId).limit(2).get();
                if (seniorSnap.size === 1) {
                    const seniorPatch = { updatedAt: nowIso };
                    if (address != null)
                        seniorPatch.address = address;
                    if (city != null)
                        seniorPatch.city = city;
                    if (state != null)
                        seniorPatch.state = state;
                    if (zip != null)
                        seniorPatch.zip = zip;
                    await seniorSnap.docs[0].ref.set(seniorPatch, { merge: true }).catch(() => { });
                }
            }
            (0, auditLog_1.logAudit)({ eventType: "profile_updated", userId: userId, data: { source: "mcp:update_user_profile", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => { });
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
            const { userId, newsletter, newMatchAlerts, reviewNotifications, privacyShowBookings } = input;
            if (!userId)
                return toolError("INVALID_INPUT", "userId is required");
            const patch = { updatedAt: nowIso };
            if (newsletter != null)
                patch.newsletter = !!newsletter;
            if (newMatchAlerts != null)
                patch.newMatchAlerts = !!newMatchAlerts;
            if (reviewNotifications != null)
                patch.reviewNotifications = !!reviewNotifications;
            if (privacyShowBookings != null)
                patch.privacyShowBookings = !!privacyShowBookings;
            if (Object.keys(patch).length === 1) {
                return toolError("INVALID_INPUT", "No preference fields provided");
            }
            await db.collection("users").doc(userId).set(patch, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "preferences_updated", userId: userId, data: { source: "mcp:update_communication_preferences", fields: Object.keys(patch).filter(k => k !== "updatedAt") } }).catch(() => { });
            return { success: true, updated: Object.keys(patch).filter(k => k !== "updatedAt") };
        }
        // ── request_email_change ────────────────────────────────────────────────
        if (name === "request_email_change") {
            const { userId, newEmail } = input;
            if (!userId || !newEmail)
                return toolError("INVALID_INPUT", "userId and newEmail are required");
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
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
            await db.collection("users").doc(userId).set({ pendingEmail: newEmail, pendingEmailToken: token, pendingEmailAt: nowIso }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "email_change_requested", userId: userId, data: { source: "mcp:request_email_change", maskedEmail: newEmail.replace(/(.{2}).*(@.*)/, "$1***$2") } }).catch(() => { });
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
            const { clientId, caregiverId } = input;
            if (!clientId || !caregiverId)
                return toolError("INVALID_INPUT", "clientId and caregiverId are required");
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            if (!cgSnap.exists)
                return toolError("NOT_FOUND", "Caregiver not found");
            await db.collection("users").doc(clientId).set({
                savedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
                updatedAt: nowIso,
            }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "favorite_saved", userId: clientId, data: { source: "mcp:save_caregiver_favorite", caregiverId } }).catch(() => { });
            return { success: true, saved: true, caregiverName: (_82 = (_81 = cgSnap.data()) === null || _81 === void 0 ? void 0 : _81.name) !== null && _82 !== void 0 ? _82 : "the caregiver" };
        }
        // ── unsave_caregiver_favorite ───────────────────────────────────────────
        if (name === "unsave_caregiver_favorite") {
            const { clientId, caregiverId } = input;
            if (!clientId || !caregiverId)
                return toolError("INVALID_INPUT", "clientId and caregiverId are required");
            await db.collection("users").doc(clientId).set({
                savedCaregiverIds: admin.firestore.FieldValue.arrayRemove(caregiverId),
                updatedAt: nowIso,
            }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "favorite_removed", userId: clientId, data: { source: "mcp:unsave_caregiver_favorite", caregiverId } }).catch(() => { });
            return { success: true, unsaved: true };
        }
        // ── list_saved_caregivers ───────────────────────────────────────────────
        if (name === "list_saved_caregivers") {
            const { clientId } = input;
            if (!clientId)
                return toolError("INVALID_INPUT", "clientId is required");
            const userSnap = await db.collection("users").doc(clientId).get();
            const ids = (_84 = (_83 = userSnap.data()) === null || _83 === void 0 ? void 0 : _83.savedCaregiverIds) !== null && _84 !== void 0 ? _84 : [];
            if (ids.length === 0)
                return { success: true, caregivers: [], count: 0 };
            const caregivers = [];
            for (const id of ids.slice(0, 20)) {
                const cgSnap = await db.collection("caregivers").doc(id).get();
                if (!cgSnap.exists)
                    continue;
                const cg = cgSnap.data();
                caregivers.push({
                    id, name: (_85 = cg.name) !== null && _85 !== void 0 ? _85 : "",
                    rate: (_86 = cg.hourlyRate) !== null && _86 !== void 0 ? _86 : null,
                    rating: (_87 = cg.averageRating) !== null && _87 !== void 0 ? _87 : null,
                    specialties: (_88 = cg.specialties) !== null && _88 !== void 0 ? _88 : [],
                });
            }
            return { success: true, caregivers, count: caregivers.length };
        }
        // ── block_user ──────────────────────────────────────────────────────────
        if (name === "block_user") {
            const { userId, targetUserId, reason } = input;
            if (!userId || !targetUserId)
                return toolError("INVALID_INPUT", "userId and targetUserId are required");
            if (userId === targetUserId)
                return toolError("INVALID_INPUT", "Cannot block yourself");
            await db.collection("users").doc(userId).set({
                blockedUsers: admin.firestore.FieldValue.arrayUnion(targetUserId),
                updatedAt: nowIso,
            }, { merge: true });
            // Surface to ops so abuse patterns become visible.
            db.collection("admin_alerts").add({
                type: "user_blocked",
                userId,
                targetUserId,
                reason: reason !== null && reason !== void 0 ? reason : null,
                severity: "medium",
                resolved: false,
                createdAt: nowIso,
            }).catch(() => { });
            (0, auditLog_1.logAudit)({ eventType: "user_blocked", userId: userId, data: { source: "mcp:block_user", targetUserId, reason } }).catch(() => { });
            return { success: true, blocked: true };
        }
        // ── unblock_user ────────────────────────────────────────────────────────
        if (name === "unblock_user") {
            const { userId, targetUserId } = input;
            if (!userId || !targetUserId)
                return toolError("INVALID_INPUT", "userId and targetUserId are required");
            await db.collection("users").doc(userId).set({
                blockedUsers: admin.firestore.FieldValue.arrayRemove(targetUserId),
                updatedAt: nowIso,
            }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "user_unblocked", userId: userId, data: { source: "mcp:unblock_user", targetUserId } }).catch(() => { });
            return { success: true, unblocked: true };
        }
        // ── report_user ─────────────────────────────────────────────────────────
        if (name === "report_user") {
            const { userId, targetUserId, category, description } = input;
            if (!userId || !targetUserId || !category || !description)
                return toolError("INVALID_INPUT", "userId, targetUserId, category, and description are required");
            const ALLOWED_CATEGORIES = new Set(["harassment", "scam", "safety_concern", "inappropriate_content", "other"]);
            if (!ALLOWED_CATEGORIES.has(category)) {
                return toolError("INVALID_INPUT", `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`);
            }
            const reportRef = await db.collection("reports").add({
                reporterId: userId,
                targetUserId,
                category,
                description: description.slice(0, 2000),
                source: "cara_sms",
                status: "open",
                createdAt: nowIso,
            });
            db.collection("admin_alerts").add({
                type: "user_reported",
                reporterId: userId,
                targetUserId,
                category,
                reportId: reportRef.id,
                severity: "medium",
                resolved: false,
                createdAt: nowIso,
            }).catch(() => { });
            (0, auditLog_1.logAudit)({ eventType: "user_reported", userId: userId, data: { source: "mcp:report_user", targetUserId, category, reportId: reportRef.id } }).catch(() => { });
            return { success: true, reported: true, reportId: reportRef.id, followUpWindow: "24h" };
        }
        // ── like_journal_entry ──────────────────────────────────────────────────
        if (name === "like_journal_entry") {
            const { userId, entryId } = input;
            if (!userId || !entryId)
                return toolError("INVALID_INPUT", "userId and entryId are required");
            const entryRef = db.collection("care_journal").doc(entryId);
            const entrySnap = await entryRef.get();
            if (!entrySnap.exists)
                return toolError("NOT_FOUND", "Care journal entry not found");
            await entryRef.set({
                likedBy: admin.firestore.FieldValue.arrayUnion(userId),
                likeCount: admin.firestore.FieldValue.increment(1),
            }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "journal_liked", userId: userId, data: { source: "mcp:like_journal_entry", entryId } }).catch(() => { });
            return { success: true, liked: true };
        }
        // ── unlike_journal_entry ────────────────────────────────────────────────
        if (name === "unlike_journal_entry") {
            const { userId, entryId } = input;
            if (!userId || !entryId)
                return toolError("INVALID_INPUT", "userId and entryId are required");
            const entryRef = db.collection("care_journal").doc(entryId);
            await entryRef.set({
                likedBy: admin.firestore.FieldValue.arrayRemove(userId),
                likeCount: admin.firestore.FieldValue.increment(-1),
            }, { merge: true });
            (0, auditLog_1.logAudit)({ eventType: "journal_unliked", userId: userId, data: { source: "mcp:unlike_journal_entry", entryId } }).catch(() => { });
            return { success: true, unliked: true };
        }
        // ── comment_on_journal_entry ────────────────────────────────────────────
        if (name === "comment_on_journal_entry") {
            const { userId, entryId, comment } = input;
            if (!userId || !entryId || !comment)
                return toolError("INVALID_INPUT", "userId, entryId, and comment are required");
            const entryRef = db.collection("care_journal").doc(entryId);
            const entrySnap = await entryRef.get();
            if (!entrySnap.exists)
                return toolError("NOT_FOUND", "Care journal entry not found");
            const commentRef = await entryRef.collection("comments").add({
                userId,
                comment: comment.slice(0, 2000),
                createdAt: nowIso,
            });
            await entryRef.set({ commentCount: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => { });
            // Best-effort notify caregiver so the comment actually reaches them.
            let notification = { sent: false, reason: "no_caregiver_phone" };
            const entry = entrySnap.data();
            if (entry.caregiverId) {
                const cgSnap = await db.collection("caregivers").doc(entry.caregiverId).get();
                const cgPhone = (_89 = cgSnap.data()) === null || _89 === void 0 ? void 0 : _89.phone;
                if (cgPhone) {
                    const { trySend } = await Promise.resolve().then(() => __importStar(require("../utils/toolNotify")));
                    notification = await trySend(cgPhone, `New comment on your care journal entry: "${comment.slice(0, 120)}"`, "mcp:comment_on_journal_entry");
                }
            }
            (0, auditLog_1.logAudit)({ eventType: "journal_comment_added", userId: userId, data: { source: "mcp:comment_on_journal_entry", entryId, commentId: commentRef.id, notificationSent: notification.sent } }).catch(() => { });
            return { success: true, commentId: commentRef.id, notification };
        }
        return toolError("INVALID_INPUT", `Unknown tool: ${name}`);
    }
    catch (err) {
        console.error(`handleToolCall [${name}] error:`, err);
        return toolError("UNAVAILABLE", `Tool ${name} is temporarily unavailable`);
    }
}
//# sourceMappingURL=server.js.map