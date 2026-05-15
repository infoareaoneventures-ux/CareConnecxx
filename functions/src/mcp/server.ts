import * as admin from "firebase-admin";
import { runMatchingForClient } from "../agents/matchingAgent";
import { logHealthDataAccessed, logBookingCreated } from "../observability/auditLog";
import { readMemoryFile, writeMemoryFile, MemoryFile } from "../memory/memoryFiles";

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
    description: "Search for available caregivers matching the client's care needs.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The client's user ID" },
        phone:    { type: "string", description: "The client's phone number" },
        chatId:   { type: "string", description: "The client's chat ID for sending results" },
      },
      required: ["clientId", "phone", "chatId"],
    },
  },
  {
    name: "request_booking",
    description: "Create a booking request for a caregiver. Returns the booking task ID.",
    input_schema: {
      type: "object",
      properties: {
        clientId:    { type: "string" },
        caregiverId: { type: "string" },
        dates:       { type: "array", items: { type: "string" }, description: "ISO date strings (YYYY-MM-DD)" },
        startTime:   { type: "string", description: "e.g. '09:00'" },
        endTime:     { type: "string", description: "e.g. '17:00'" },
      },
      required: ["clientId", "caregiverId", "dates", "startTime", "endTime"],
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
    description: "Read one of Cara's long-term memory files for a user (profile, health, family, recent_episodes, procedural).",
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
];

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const nowIso = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  switch (name) {
    case "get_senior_profile": {
      logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_senior_profile").catch(() => {});
      const snap = await db.collection("seniors").doc(input.seniorId as string).get();
      return snap.data() ?? { error: "Senior not found" };
    }

    case "get_care_journal": {
      logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_care_journal").catch(() => {});
      const limit = (input.limit as number) ?? 5;
      const snap = await db
        .collection("care_journal")
        .where("seniorId", "==", input.seniorId)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.data());
    }

    case "get_upcoming_appointments": {
      const today = new Date().toISOString().slice(0, 10);
      const snap = await db
        .collection("appointments")
        .where("clientId", "==", input.clientId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date", ">=", today)
        .orderBy("date", "asc")
        .limit(5)
        .get();
      return snap.docs.map((d) => d.data());
    }

    case "get_caregiver_info": {
      const snap = await db.collection("caregivers").doc(input.caregiverId as string).get();
      return snap.data() ?? { error: "Caregiver not found" };
    }

    case "get_caregiver_reviews": {
      const limit = (input.limit as number) ?? 5;
      const snap = await db
        .collection("reviews")
        .where("caregiverId", "==", input.caregiverId as string)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.data());
    }

    case "get_health_signals": {
      logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:get_health_signals").catch(() => {});
      const snap = await db
        .collection("health_signals")
        .where("seniorId", "==", input.seniorId)
        .where("detectedAt", ">=", thirtyDaysAgo)
        .orderBy("detectedAt", "desc")
        .limit(20)
        .get();
      return snap.docs.map((d) => d.data());
    }

    case "get_billing_summary": {
      const [subSnap, invoiceSnap] = await Promise.all([
        db.collection("subscriptions").doc(input.userId as string).get(),
        db.collection("invoices")
          .where("userId", "==", input.userId)
          .orderBy("createdAt", "desc")
          .limit(3)
          .get(),
      ]);
      return {
        subscription: subSnap.data() ?? null,
        recentInvoices: invoiceSnap.docs.map((d) => d.data()),
      };
    }

    case "find_replacement_caregivers": {
      const sessionSnap = await db.collection("agent_sessions").doc(input.phone as string).get();
      const session = sessionSnap.data() ?? {};
      const clientSnap = await db.collection("users").doc(input.clientId as string).get();
      const clientProfile = clientSnap.data() ?? {};
      await runMatchingForClient(
        input.phone as string,
        input.chatId as string,
        session,
        clientProfile
      );
      return { triggered: true };
    }

    case "request_booking": {
      const ref = await db.collection("booking_tasks").add({
        clientId:    input.clientId,
        caregiverId: input.caregiverId,
        dates:       input.dates,
        startTime:   input.startTime,
        endTime:     input.endTime,
        status:      "pending",
        source:      "qa_agent",
        createdAt:   nowIso,
      });
      logBookingCreated(input.clientId as string, input.caregiverId as string, input.dates as string[]).catch(() => {});
      return { taskId: ref.id };
    }

    case "update_preferences": {
      const { userId, ...patch } = input;
      await db.collection("user_preferences").doc(userId as string).set(patch, { merge: true });
      return { updated: true };
    }

    case "log_health_flag": {
      logHealthDataAccessed(input.seniorId as string, input.seniorId as string, "mcp:log_health_flag").catch(() => {});
      await db.collection("health_signals").add({
        seniorId:    input.seniorId,
        signalType:  input.signalType,
        description: input.description,
        severity:    "flag",
        source:      "family_report",
        detectedAt:  nowIso,
      });
      return { logged: true };
    }

    case "read_memory_file": {
      logHealthDataAccessed(input.userId as string, input.userId as string, "mcp:read_memory_file").catch(() => {});
      const content = await readMemoryFile(input.userId as string, input.file as MemoryFile);
      return { content: content || "" };
    }

    case "update_memory_file": {
      const existing = await readMemoryFile(input.userId as string, input.file as MemoryFile);
      const updated  = existing
        ? `${existing.trimEnd()}\n\n${input.content}`
        : input.content as string;
      await writeMemoryFile(input.userId as string, input.file as MemoryFile, updated);
      return { updated: true };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
