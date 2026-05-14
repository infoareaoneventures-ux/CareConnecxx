/**
 * Cara – Zep Memory Integration
 * Docs: https://help.getzep.com/quick-start-guide
 *
 * Zep userId = phone digits only (e.g. "14155551234").
 * This is stable, requires no Firebase Auth UID, and is consistent from
 * first contact through the entire lifecycle.
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

// ── Stable Zep userId derived from phone ──────────────────────────────────────
// Exported so all callers use the same derivation consistently

export function getZepUserId(phone: string): string {
  return phone.replace(/\D/g, "");
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

// ── Initialize Zep on first contact ───────────────────────────────────────────
// Call the moment a new user sends their first text — before we know name/role.
// Uses phone digits as userId so memory starts immediately.

export async function initializeZepOnFirstContact(phone: string): Promise<void> {
  const userId = getZepUserId(phone);

  try {
    await getZep().user.add({
      userId,
      email: `${userId}@cara-internal.local`,
    });
  } catch (err: any) {
    if (!err?.message?.includes("already exists")) {
      console.error("initializeZepOnFirstContact user.add error:", err);
    }
  }

  const threadId = uuidv4().replace(/-/g, "");
  try {
    await getZep().thread.create({ threadId, userId });
    await db.collection("agent_sessions").doc(phone).update({ zepThreadId: threadId });
  } catch (err: any) {
    if (!err?.message?.includes("already exists")) {
      console.error("initializeZepOnFirstContact thread.create error:", err);
    }
  }
}

// ── Add incoming user message to Zep ──────────────────────────────────────────
// Fire-and-forget before every Claude call AND before handleOnboardingStep

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
    await getZep().thread.addMessages(params.threadId, { messages: [message] });
  } catch (err) {
    console.error("addUserMessageToZep error:", err);
  }
}

// ── Add Cara's reply to Zep ────────────────────────────────────────────────────
// Fire-and-forget after Claude/QA agent sends a reply

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
    await getZep().thread.addMessages(params.threadId, { messages: [message] });
  } catch (err) {
    console.error("addAssistantMessageToZep error:", err);
  }
}

// ── Add business data to Zep knowledge graph ──────────────────────────────────
// Zep auto-extracts facts, entities, relationships from JSON

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
// Returns: user summary + relevant facts with valid_from/valid_to dates

export async function getZepContext(threadId: string): Promise<string> {
  try {
    const userContext = await getZep().thread.getUserContext(threadId, {
      templateId: "cara-eldercare",
    });
    return userContext.context ?? "";
  } catch {
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
    const results = await getZep().graph.search({ userId, query, limit: 5 });
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

// ── Push structured onboarding data to Zep graph ──────────────────────────────
// Call at payment completion — thread already exists from first contact.
// Zep uses this to build richer knowledge: senior name, conditions, care needs.

export async function pushOnboardingDataToZep(params: {
  phone: string;
  firstName: string;
  seniorName: string;
  seniorAge?: number;
  conditions?: string[];
  careNeeds?: string[];
  city?: string;
  relationship?: string;
  daysPerWeek?: number;
  timeOfDay?: string;
}): Promise<void> {
  const userId = getZepUserId(params.phone);

  // Update Zep user record with name now that we know it
  try {
    await getZep().user.update(userId, { firstName: params.firstName });
  } catch (err) {
    console.error("pushOnboardingDataToZep user.update error:", err);
  }

  await addBusinessDataToZep({
    userId,
    data: {
      user_name: params.firstName,
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
}

// ── Send care journal to Zep after each visit ──────────────────────────────────
// Zep extracts health facts and bi-temporally dates them

export async function sendCareJournalToZep(params: {
  phone: string;
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
    userId: getZepUserId(params.phone),
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
