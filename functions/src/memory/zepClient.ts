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
import { createHash, randomUUID } from "crypto";

const db = admin.firestore();

// ── Structured Zep failure logging ───────────────────────────────────────────
// Emits a JSON log entry that Cloud Monitoring can use for alerting.
// severity + zep_failure key are stable — set up a log-based metric on these.
//
// Privacy (R21): log lines carry operation + sanitized error class + an opaque
// correlation hash only. Never raw thread IDs, Zep user IDs, query text, or
// provider error messages (SDK messages can embed the request URL, which
// contains the thread ID).

// Opaque, deterministic reference for correlating failure lines about the same
// thread/user without exposing the identifier itself.
function correlationHash(source?: string): string | undefined {
  if (!source) return undefined;
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function logZepFailure(operation: string, err: unknown, correlationSource?: string): void {
  const rawCode = (err as any)?.status ?? (err as any)?.code;
  const code =
    typeof rawCode === "number" || (typeof rawCode === "string" && /^[A-Za-z0-9_]{1,32}$/.test(rawCode))
      ? rawCode
      : "unknown";
  console.error(JSON.stringify({
    severity:  "ERROR",
    zep_failure: true,
    operation,
    error_code:  code,
    error_class: errorClassOf(err),
    correlation: correlationHash(correlationSource),
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
  fn:                 () => Promise<T>,
  opName:             string,
  correlationSource?: string
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
        logZepFailure(opName, err, correlationSource);
        throw err;
      }
      // Exponential back-off: 200 ms → 400 ms → 800 ms (+ jitter)
      await sleep(Math.min(200 * Math.pow(2, attempt), 4_000) + Math.random() * 100);
    }
  }
  throw lastErr;
}

// ── Timeout helper ─────────────────────────────────────────────────────────────
// Races a Zep call against a hard cap. The timer is ALWAYS cleared in finally,
// so a fast success can never emit a delayed timeout signal, and the SDK's
// RequestOptions abortSignal is aborted on timeout so the losing request is
// actually cancelled instead of hanging in the background. A late rejection
// from the aborted call resolves the already-lost branch — never an unhandled
// rejection.

type TimedOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function raceZepTimeout<T>(
  run:       (requestOptions: { abortSignal: AbortSignal }) => Promise<T>,
  timeoutMs: number,
): Promise<TimedOutcome<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TimedOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      run({ abortSignal: controller.signal }).then(
        (value) => ({ kind: "value" as const, value }),
        (error) => ({ kind: "error" as const, error }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
      logZepFailure("initializeZepOnFirstContact.user.add", err, userId);
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
      logZepFailure("initializeZepOnFirstContact.thread.create", err, userId);
    }
  }
}

// ── Transcript write adapters ──────────────────────────────────────────────────
// Two tiers, split so error handling is explicit at the call site:
//   *Strict     — throws after retry exhaustion and returns the provider's
//                 messageUuids. This is the ONLY tier the memory-operation
//                 retry worker may call: a swallowed failure there would mark
//                 an operation complete that never reached Zep.
//   *BestEffort — legacy fire-and-forget for paths where a Zep miss must not
//                 block the user turn (failure is logged, never thrown).
// The optional `uuid` lets the worker send a deterministic per-source-turn
// message UUID for idempotent retries (KTD5).

export interface ZepMessageWriteResult {
  messageUuids: string[];
}

export async function addUserMessageToZepStrict(params: {
  threadId: string;
  content: string;
  userName: string;
  sentAt?: Date;
  uuid?: string;
}): Promise<ZepMessageWriteResult> {
  const message: Zep.Message = {
    uuid: params.uuid,
    createdAt: (params.sentAt ?? new Date()).toISOString(),
    name: params.userName,
    role: "user",
    content: params.content,
  };
  const res = await withZepRetry(
    () => getZep().thread.addMessages(params.threadId, { messages: [message] }),
    "addUserMessageToZep",
    params.threadId
  );
  return { messageUuids: res.messageUuids ?? [] };
}

export async function addAssistantMessageToZepStrict(params: {
  threadId: string;
  content: string;
  sentAt?: Date;
  uuid?: string;
}): Promise<ZepMessageWriteResult> {
  const message: Zep.Message = {
    uuid: params.uuid,
    createdAt: (params.sentAt ?? new Date()).toISOString(),
    name: "Evia",
    role: "assistant",
    content: params.content,
  };
  const res = await withZepRetry(
    () => getZep().thread.addMessages(params.threadId, { messages: [message] }),
    "addAssistantMessageToZep",
    params.threadId
  );
  return { messageUuids: res.messageUuids ?? [] };
}

// Best-effort: retry exhausted → already logged by withZepRetry, don't throw.

export async function addUserMessageToZepBestEffort(params: {
  threadId: string;
  content: string;
  userName: string;
  sentAt?: Date;
}): Promise<void> {
  await addUserMessageToZepStrict(params).catch(() => {});
}

export async function addAssistantMessageToZepBestEffort(params: {
  threadId: string;
  content: string;
}): Promise<void> {
  await addAssistantMessageToZepStrict(params).catch(() => {});
}

// Legacy aliases — existing call sites keep working; U3 migrates them to the
// explicit *BestEffort names (or to the worker's strict tier).
export const addUserMessageToZep = addUserMessageToZepBestEffort;
export const addAssistantMessageToZep = addAssistantMessageToZepBestEffort;

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
    params.userId
  );
  // Callers that want fire-and-forget must wrap with .catch() themselves
}

// ── Get assembled context for Claude ──────────────────────────────────────────
// Returns: user summary + relevant facts with valid_from/valid_to dates.
// Self-heals missing template on first call per cold-start.
//
// Discriminated outcome (R5): callers must branch on `status`, never on the
// context string — "empty" is Zep answering with nothing durable yet, while
// "unavailable"/"timeout" mean the memory layer is missing this turn and the
// prompt needs the memory_unavailable marker.

export type ZepContextStatus = "loaded" | "empty" | "unavailable" | "timeout";

export interface ZepContextResult {
  status:      ZepContextStatus;
  /** Non-empty only when status === "loaded". */
  context:     string;
  latencyMs:   number;
  /** Sanitized error class, set only when status === "unavailable". */
  errorClass?: string;
}

export const ZEP_CONTEXT_TIMEOUT_MS = 6_000; // past calls have hung 30s+ when Zep is unhealthy

// Never rejects — every failure mode is folded into the result's status, so
// callers can safely include this in a Promise.all without a .catch shim.
export async function getZepContextResult(
  threadId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ZepContextResult> {
  const timeoutMs = opts.timeoutMs ?? ZEP_CONTEXT_TIMEOUT_MS;
  const startedAt = Date.now();

  const outcome = await raceZepTimeout(async (requestOptions) => {
    // Template self-heal shares the cap — it is a Zep call and can hang too.
    await ensureCaraContextTemplate().catch(() => {});
    try {
      const userContext = await getZep().thread.getUserContext(
        threadId, { templateId: CARA_TEMPLATE_ID }, requestOptions,
      );
      return userContext.context ?? "";
    } catch {
      // Template lookup failed (e.g. template missing on this project) —
      // fall back to the default context assembly before declaring an outage.
      const userContext = await getZep().thread.getUserContext(threadId, undefined, requestOptions);
      return userContext.context ?? "";
    }
  }, timeoutMs);

  const latencyMs = Date.now() - startedAt;

  if (outcome.kind === "timeout") {
    console.warn(JSON.stringify({
      severity:    "WARNING",
      zep_timeout: true,
      operation:   "getZepContext",
      timeout_ms:  timeoutMs,
      correlation: correlationHash(threadId),
      timestamp:   new Date().toISOString(),
    }));
    return { status: "timeout", context: "", latencyMs };
  }
  if (outcome.kind === "error") {
    logZepFailure("getZepContext", outcome.error, threadId);
    return { status: "unavailable", context: "", latencyMs, errorClass: errorClassOf(outcome.error) };
  }
  const context = outcome.value.trim() ? outcome.value : "";
  return { status: context ? "loaded" : "empty", context, latencyMs };
}

// Legacy string read — kept for callers that predate the typed result. Returns
// "" for empty AND unavailable AND timeout, so it cannot be used to infer Zep
// health. New code must call getZepContextResult instead.
export async function getZepContext(threadId: string): Promise<string> {
  const result = await getZepContextResult(threadId);
  return result.status === "loaded" ? result.context : "";
}

// ── Search memory ──────────────────────────────────────────────────────────────
// Used when family texts "what do you know about mom?"
//
// U4a (KTD9): while a correction/forget operation's Zep targets are unresolved
// for a user, graph search is suppressed AT THE READER — a stale or paraphrased
// Zep edge must never reach a prompt or tool result mid-reconciliation. Callers
// that know the APP userId pass it via `appUserId` (the first arg is the ZEP
// userId — phone digits — which cannot key the reconciliation flag).

export type ZepMemorySearchStatus = "loaded" | "empty" | "reconciliation_pending" | "unavailable";

export interface ZepMemorySearchResult {
  status: ZepMemorySearchStatus;
  /** Non-empty only when status === "loaded". */
  facts:  string;
}

export async function searchZepMemoryResult(
  userId: string,
  query: string,
  opts: { appUserId?: string } = {},
): Promise<ZepMemorySearchResult> {
  if (opts.appUserId) {
    try {
      const { getMemoryReconciliationState } = await import("./memoryOperations");
      const state = await getMemoryReconciliationState(opts.appUserId);
      if (state.zepMasked) return { status: "reconciliation_pending", facts: "" };
    } catch {
      /* fail-open — matches the reader posture; check errors are logged inside */
    }
  }
  try {
    const results = await getZep().graph.search({ userId, query, limit: 5 });
    if (!results?.edges?.length) return { status: "empty", facts: "" };
    const facts = results.edges
      .map((e: any) => `- ${e.fact ?? e.name}`)
      .filter(Boolean)
      .join("\n");
    return facts ? { status: "loaded", facts } : { status: "empty", facts: "" };
  } catch (err) {
    logZepFailure("searchZepMemory", err, userId);
    return { status: "unavailable", facts: "" };
  }
}

// Legacy string read — "" for empty AND unavailable AND reconciliation-pending,
// so callers cannot distinguish (or leak) suppressed state. New code should use
// searchZepMemoryResult. `appUserId` gates reconciliation suppression.
export async function searchZepMemory(
  userId: string,
  query: string,
  appUserId?: string,
): Promise<string> {
  const result = await searchZepMemoryResult(userId, query, { appUserId });
  return result.status === "loaded" ? result.facts : "";
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
    logZepFailure("pushOnboardingDataToZep.user.update", err, userId);
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
