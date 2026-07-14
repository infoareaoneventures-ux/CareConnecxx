/**
 * Evia – Zep Memory Integration
 * Docs: https://help.getzep.com/quick-start-guide
 *
 * Zep userId = phone digits only (e.g. "14155551234").
 * This is stable, requires no Firebase Auth UID, and is consistent from
 * first contact through the entire lifecycle.
 */

import { ZepClient } from "@getzep/zep-cloud";
import type { Zep } from "@getzep/zep-cloud";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";

const db = admin.firestore();

// ── Structured Zep failure logging ───────────────────────────────────────────
// Emits a JSON log entry that Cloud Monitoring can use for alerting.
// severity + zep_failure key are stable — set up a log-based metric on these.

function logZepFailure(operation: string, err: unknown, context?: Record<string, unknown>): void {
  const code    = (err as any)?.status ?? (err as any)?.code ?? "unknown";
  const message = (err as any)?.message ?? String(err);
  console.error(JSON.stringify({
    severity:  "ERROR",
    zep_failure: true,
    operation,
    error_code:  code,
    error_message: message,
    ...context,
    timestamp: new Date().toISOString(),
  }));
}

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

// ── Retry helper for transient Zep failures ───────────────────────────────────
// Retries on network errors (no status), 429 rate limit, and 5xx server errors.
// 400-level auth/bad-request errors are not retried — they won't self-heal.

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withZepRetry<T>(
  fn:       () => Promise<T>,
  opName:   string,
  context?: Record<string, unknown>
): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as any)?.status ?? (err as any)?.statusCode;
      const isRetryable =
        !status ||                          // network-level error (no HTTP status)
        status === 429 ||                   // rate limited
        (status >= 500 && status < 600);    // server error
      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
        logZepFailure(opName, err, context);
        throw err;
      }
      // Exponential back-off: 200 ms → 400 ms → 800 ms (+ jitter)
      await sleep(Math.min(200 * Math.pow(2, attempt), 4_000) + Math.random() * 100);
    }
  }
  throw lastErr;
}

// ── Stable Zep userId derived from phone ──────────────────────────────────────
// Exported so all callers use the same derivation consistently

export function getZepUserId(phone: string): string {
  return phone.replace(/\D/g, "");
}

// ── Context template definition ───────────────────────────────────────────────

const CARA_TEMPLATE_ID = "cara-eldercare";
const CARA_TEMPLATE_BODY = `# CARE CONTEXT

## About This Family
%{user_summary}

## Current Facts (with date ranges)
%{edges limit=15}

## Key People & Relationships
%{entities limit=8}`;

// Called once during deploy/setup — kept for backwards-compat.
export async function createCaraContextTemplate(): Promise<void> {
  await getZep().context.createContextTemplate({
    templateId: CARA_TEMPLATE_ID,
    template:   CARA_TEMPLATE_BODY,
  });
  console.log("Evia context template created in Zep.");
}

// Called automatically on Cloud Function cold-start. Checks whether the template
// exists; creates it if missing. Safe to call repeatedly — idempotent.
let _templateEnsured = false;

export async function ensureCaraContextTemplate(): Promise<void> {
  if (_templateEnsured) return;
  try {
    // Attempt to fetch the template — Zep returns 404 if it doesn't exist.
    await (getZep().context as any).getContextTemplate?.({ templateId: CARA_TEMPLATE_ID });
    _templateEnsured = true;
  } catch (err) {
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    if (status === 404 || (err as any)?.message?.includes("not found")) {
      // Template missing — create it now.
      try {
        await getZep().context.createContextTemplate({
          templateId: CARA_TEMPLATE_ID,
          template:   CARA_TEMPLATE_BODY,
        });
        console.log("[zepClient] cara-eldercare context template created.");
        _templateEnsured = true;
      } catch (createErr) {
        logZepFailure("ensureCaraContextTemplate.create", createErr);
      }
    } else {
      // Non-404 — log but don't crash; getContextTemplate may not exist on all SDK versions
      logZepFailure("ensureCaraContextTemplate.check", err);
    }
  }
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
      logZepFailure("initializeZepOnFirstContact.user.add", err, { userId });
    }
  }

  // Guard: if a threadId is already stored, don't create a second thread — that
  // would split this user's memory across two Zep threads permanently.
  const existingSession = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
  if (existingSession?.data()?.zepThreadId) return;

  const threadId = randomUUID().replace(/-/g, "");
  try {
    await getZep().thread.create({ threadId, userId });
    await db.collection("agent_sessions").doc(phone).set({ zepThreadId: threadId }, { merge: true });
  } catch (err: any) {
    if (!err?.message?.includes("already exists")) {
      logZepFailure("initializeZepOnFirstContact.thread.create", err, { userId, threadId });
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
  const message: Zep.Message = {
    createdAt: (params.sentAt ?? new Date()).toISOString(),
    name: params.userName,
    role: "user",
    content: params.content,
  };
  await withZepRetry(
    () => getZep().thread.addMessages(params.threadId, { messages: [message] }),
    "addUserMessageToZep",
    { threadId: params.threadId }
  ).catch(() => {}); // fire-and-forget: retry exhausted → logged, don't throw
}

// ── Add Evia's reply to Zep ────────────────────────────────────────────────────
// Fire-and-forget after Claude/QA agent sends a reply

export async function addAssistantMessageToZep(params: {
  threadId: string;
  content: string;
}): Promise<void> {
  const message: Zep.Message = {
    createdAt: new Date().toISOString(),
    name: "Evia",
    role: "assistant",
    content: params.content,
  };
  await withZepRetry(
    () => getZep().thread.addMessages(params.threadId, { messages: [message] }),
    "addAssistantMessageToZep",
    { threadId: params.threadId }
  ).catch(() => {}); // fire-and-forget
}

// ── Add business data to Zep knowledge graph ──────────────────────────────────
// Zep auto-extracts facts, entities, relationships from JSON

export async function addBusinessDataToZep(params: {
  userId: string;
  data: Record<string, unknown>;
}): Promise<void> {
  await withZepRetry(
    () => getZep().graph.add({
      userId: params.userId,
      type: "json",
      data: JSON.stringify(params.data),
    }),
    "addBusinessDataToZep",
    { userId: params.userId }
  );
  // Callers that want fire-and-forget must wrap with .catch() themselves
}

// ── Get assembled context for Claude ──────────────────────────────────────────
// Returns: user summary + relevant facts with valid_from/valid_to dates.
// Self-heals missing template on first call per cold-start.

export async function getZepContext(threadId: string): Promise<string> {
  // Ensure template exists — no-op after first successful check per instance.
  await ensureCaraContextTemplate().catch(() => {});

  try {
    const userContext = await getZep().thread.getUserContext(threadId, {
      templateId: CARA_TEMPLATE_ID,
    });
    return userContext.context ?? "";
  } catch {
    try {
      const userContext = await getZep().thread.getUserContext(threadId);
      return userContext.context ?? "";
    } catch (err) {
      logZepFailure("getZepContext", err, { threadId });
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
    logZepFailure("searchZepMemory", err, { userId, query: query.slice(0, 50) });
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
    logZepFailure("pushOnboardingDataToZep.user.update", err, { userId });
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
