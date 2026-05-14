/**
 * Cara – Zep Memory Integration
 * Docs: https://help.getzep.com/quick-start-guide
 */

import { ZepClient } from "@getzep/zep-cloud";
import type { Zep } from "@getzep/zep-cloud";
import * as admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";

const db = admin.firestore();

// ── Singleton client ───────────────────────────────────────────────────────────

let _zep: ZepClient | null = null;

function getZep(): ZepClient {
  if (!_zep) {
    const apiKey = process.env.ZEP_API_KEY;
    if (!apiKey) throw new Error("ZEP_API_KEY not set");
    _zep = new ZepClient({ apiKey });
  }
  return _zep;
}

// ── Create context template (run ONCE during setup) ────────────────────────────

export async function createCaraContextTemplate(): Promise<void> {
  await getZep().context.createContextTemplate({
    templateId: "cara-eldercare",
    template: `# CARE CONTEXT

## About This Family
%{user_summary}

## Current Facts (with date ranges)
%{edges limit=15}

## Key People & Relationships
%{entities limit=8}`,
  });
  console.log("Cara context template created in Zep.");
}

// ── Create Zep user (once per family, at onboarding completion) ────────────────

export async function createZepUser(params: {
  userId: string;
  firstName: string;
  lastName?: string;
  phone: string;
}): Promise<void> {
  try {
    await getZep().user.add({
      userId: params.userId,
      firstName: params.firstName,
      lastName: params.lastName ?? "",
      email: `${params.phone.replace(/\D/g, "")}@cara-internal.local`,
    });
  } catch (err: any) {
    if (!err?.message?.includes("already exists")) {
      console.error("createZepUser error:", err);
    }
  }
}

// ── Create Zep thread (once per family, stored in agent_sessions) ──────────────
// thread_id must be a UUID – stored in agent_sessions.zepThreadId

export async function createZepThread(params: {
  userId: string;
  phone: string;
}): Promise<string> {
  const threadId = uuidv4().replace(/-/g, "");

  try {
    await getZep().thread.create({
      threadId,
      userId: params.userId,
    });

    await db.collection("agent_sessions").doc(params.phone).update({
      zepThreadId: threadId,
    });
  } catch (err: any) {
    if (!err?.message?.includes("already exists")) {
      console.error("createZepThread error:", err);
    }
  }

  return threadId;
}

// ── Add incoming user message to Zep ──────────────────────────────────────────
// Call BEFORE calling Claude – when inbound message arrives in webhooks.ts

export async function addUserMessageToZep(params: {
  threadId: string;
  content: string;
  userName: string;
  sentAt?: Date;
}): Promise<void> {
  try {
    const message: Zep.Message = {
      createdAt: (params.sentAt ?? new Date()).toISOString(),
      name: params.userName,
      role: "user",
      content: params.content,
    };
    await getZep().thread.addMessages(params.threadId, {
      messages: [message],
    });
  } catch (err) {
    console.error("addUserMessageToZep error:", err);
  }
}

// ── Add Cara's reply to Zep ────────────────────────────────────────────────────
// Call AFTER Claude generates a reply – in webhooks.ts after sendMessage()

export async function addAssistantMessageToZep(params: {
  threadId: string;
  content: string;
}): Promise<void> {
  try {
    const message: Zep.Message = {
      createdAt: new Date().toISOString(),
      name: "Cara",
      role: "assistant",
      content: params.content,
    };
    await getZep().thread.addMessages(params.threadId, {
      messages: [message],
    });
  } catch (err) {
    console.error("addAssistantMessageToZep error:", err);
  }
}

// ── Add business data (care events, onboarding data) to Zep graph ─────────────
// Zep auto-extracts facts, entities, relationships from any JSON
// Include user name so Zep associates data with the right person

export async function addBusinessDataToZep(params: {
  userId: string;
  data: Record<string, unknown>;
}): Promise<void> {
  try {
    await getZep().graph.add({
      userId: params.userId,
      type: "json",
      data: JSON.stringify(params.data),
    });
  } catch (err) {
    console.error("addBusinessDataToZep error:", err);
  }
}

// ── Get assembled context for Claude ──────────────────────────────────────────
// Call AFTER adding user message to Zep, BEFORE calling Claude
// Returns: user summary + relevant facts with valid_from/valid_to dates
// P95 latency < 200ms

export async function getZepContext(threadId: string): Promise<string> {
  try {
    // Try custom eldercare template first
    const userContext = await getZep().thread.getUserContext(threadId, {
      templateId: "cara-eldercare",
    });
    return userContext.context ?? "";
  } catch {
    // Fall back to default if template not created yet
    try {
      const userContext = await getZep().thread.getUserContext(threadId);
      return userContext.context ?? "";
    } catch (err) {
      console.error("getZepContext error:", err);
      return "";
    }
  }
}

// ── Search memory ──────────────────────────────────────────────────────────────
// Used when family texts "what do you know about mom?"

export async function searchZepMemory(
  userId: string,
  query: string
): Promise<string> {
  try {
    const results = await getZep().graph.search({
      userId,
      query,
      limit: 5,
    });
    if (!results?.edges?.length) return "";
    return results.edges
      .map((e: any) => `- ${e.fact ?? e.name}`)
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    console.error("searchZepMemory error:", err);
    return "";
  }
}

// ── Full onboarding initialization ────────────────────────────────────────────
// Call when client onboarding completes – creates user, thread, sends all data

export async function initializeZepForClient(params: {
  userId: string;
  phone: string;
  firstName: string;
  lastName?: string;
  seniorName: string;
  seniorAge?: number;
  conditions?: string[];
  careNeeds?: string[];
  city?: string;
  relationship?: string;
  daysPerWeek?: number;
  timeOfDay?: string;
}): Promise<string> {
  await createZepUser({
    userId: params.userId,
    firstName: params.firstName,
    lastName: params.lastName,
    phone: params.phone,
  });

  const threadId = await createZepThread({
    userId: params.userId,
    phone: params.phone,
  });

  await addBusinessDataToZep({
    userId: params.userId,
    data: {
      user_name: params.firstName,
      user_id: params.userId,
      relationship_to_senior: params.relationship ?? "family member",
      senior_name: params.seniorName,
      senior_age: params.seniorAge,
      senior_conditions: params.conditions ?? [],
      senior_care_needs: params.careNeeds ?? [],
      senior_location_city: params.city,
      care_schedule_days_per_week: params.daysPerWeek,
      care_schedule_time_of_day: params.timeOfDay,
      data_source: "cara_onboarding",
      timestamp: new Date().toISOString(),
    },
  });

  return threadId;
}

// ── Send care journal to Zep after each visit ──────────────────────────────────
// Call from journalCreated.ts – Zep extracts health facts and
// invalidates old facts automatically when conditions change

export async function sendCareJournalToZep(params: {
  userId: string;
  seniorName: string;
  caregiverName: string;
  date: string;
  mood?: string;
  ateWell?: boolean;
  medicationsTaken?: boolean;
  healthObservations?: string[];
  notes?: string;
}): Promise<void> {
  await addBusinessDataToZep({
    userId: params.userId,
    data: {
      event_type: "care_visit_completed",
      user_name: params.seniorName,
      caregiver_name: params.caregiverName,
      visit_date: params.date,
      mood: params.mood,
      ate_well: params.ateWell,
      medications_taken: params.medicationsTaken,
      health_observations: params.healthObservations ?? [],
      care_notes: params.notes,
    },
  });
}
