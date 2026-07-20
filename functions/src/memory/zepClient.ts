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
import { errorClassOf } from "../utils/errorClass";

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

## Current Facts (with date ranges)
%{edges limit=15}`;

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
    const existing = await getZep().context.getContextTemplate(CARA_TEMPLATE_ID);
    if (existing.template !== CARA_TEMPLATE_BODY) {
      await getZep().context.updateContextTemplate(CARA_TEMPLATE_ID, {
        template: CARA_TEMPLATE_BODY,
      });
    }
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
        throw createErr;
      }
    } else {
      // Any non-404 read/update failure makes this turn unavailable.
      logZepFailure("ensureCaraContextTemplate.check", err);
      throw err;
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
  deduplicated?: boolean;
}

const CARECONNECXX_MESSAGE_KEY = "careconnecxxMessageKey";

async function findExistingZepMessage(
  threadId: string,
  idempotencyKey: string | undefined,
): Promise<string[] | null> {
  if (!idempotencyKey) return null;

  const thread = await withZepRetry(
    () => getZep().thread.get(threadId),
    "getThreadForMessageReconciliation",
    threadId,
  );
  const existing = (thread.messages ?? []).find((message) =>
    message.uuid === idempotencyKey ||
    message.metadata?.[CARECONNECXX_MESSAGE_KEY] === idempotencyKey
  );
  if (!existing) return null;
  return existing.uuid ? [existing.uuid] : [];
}

export async function addUserMessageToZepStrict(params: {
  threadId: string;
  content: string;
  userName: string;
  sentAt?: Date;
  uuid?: string;
}): Promise<ZepMessageWriteResult> {
  const existingMessageUuids = await findExistingZepMessage(
    params.threadId,
    params.uuid,
  );
  if (existingMessageUuids) {
    return { messageUuids: existingMessageUuids, deduplicated: true };
  }
  const message: Zep.Message = {
    uuid: params.uuid,
    metadata: params.uuid
      ? { [CARECONNECXX_MESSAGE_KEY]: params.uuid }
      : undefined,
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
  const existingMessageUuids = await findExistingZepMessage(
    params.threadId,
    params.uuid,
  );
  if (existingMessageUuids) {
    return { messageUuids: existingMessageUuids, deduplicated: true };
  }
  const message: Zep.Message = {
    uuid: params.uuid,
    metadata: params.uuid
      ? { [CARECONNECXX_MESSAGE_KEY]: params.uuid }
      : undefined,
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
/**
 * @deprecated Retained for older callers that intentionally want best-effort
 * transcript writes. New durable turn_sync code must use the strict adapter.
 */
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
    await ensureCaraContextTemplate();
    const userContext = await getZep().thread.getUserContext(
      threadId, { templateId: CARA_TEMPLATE_ID }, requestOptions,
    );
    return userContext.context ?? "";
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

// ── Graph edge/episode adapters for correction/forget propagation (U4b) ──────
// Strict tier ONLY — these exist for the memory-operation worker (R13/R14).
// Contract:
//   • provider/network failures THROW after retry exhaustion (the worker's
//     lease/backoff owns retries; a swallowed failure would mark a forget
//     complete that never reached Zep);
//   • already-deleted / not-found targets are SUCCESS (`alreadyGone`) — a
//     retried delete must reconcile, not fail forever;
//   • scope is a single edge/episode UUID. Nothing here can delete a whole
//     graph, user, or thread (Stop conditions / Scope Boundaries).
// Logs carry operation + error class + correlation hash only (R21) — never an
// edge UUID, fact text, or query text.

function isZepNotFoundError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown });
  if (status?.status === 404 || status?.statusCode === 404) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /not[\s_-]?found/i.test(msg);
}

function normalizeForEdgeMatch(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const EDGE_MATCH_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "and",
  "or", "in", "on", "at", "for", "with", "has", "have", "had", "her", "his",
  "their", "my", "that", "this", "it", "she", "he", "they",
]);

/**
 * Pure matcher deciding whether a Zep edge's extracted fact refers to the
 * target learned-fact text. Zep rephrases facts, so exact equality would find
 * nothing: match on normalized containment (either direction) or on ≥80%
 * content-word overlap of the target inside the edge fact. Deterministic and
 * conservative — a non-match leaves the edge alone (higher-authority stores
 * are already corrected; KTD9 masking covers the gap until then).
 */
export function zepEdgeFactMatches(edgeFact: string, targetFact: string): boolean {
  const edge = normalizeForEdgeMatch(edgeFact);
  const target = normalizeForEdgeMatch(targetFact);
  if (!edge || !target) return false;
  if (edge.includes(target) || target.includes(edge)) return true;
  const targetWords = target.split(" ").filter((w) => w.length > 2 && !EDGE_MATCH_STOPWORDS.has(w));
  if (targetWords.length === 0) return false;
  const edgeWords = new Set(edge.split(" "));
  const present = targetWords.filter((w) => edgeWords.has(w)).length;
  return present / targetWords.length >= 0.8;
}

export interface ZepEdgeMatch {
  uuid: string;
  /** Source-episode UUIDs referencing this edge (forget deletes them). */
  episodes: string[];
}

/** Maximum page size accepted by Zep graph search/list endpoints. */
export const ZEP_EDGE_PAGE_SIZE = 50;
/** @deprecated Use ZEP_EDGE_PAGE_SIZE; retained for existing operational scripts. */
export const ZEP_EDGE_SEARCH_LIMIT = ZEP_EDGE_PAGE_SIZE;

async function listZepUserEdges(zepUserId: string): Promise<Array<{ uuid: string; fact?: string; episodes?: string[] }>> {
  const edges: Array<{ uuid: string; fact?: string; episodes?: string[] }> = [];
  const seenCursors = new Set<string>();
  let uuidCursor: string | undefined;

  // The installed SDK exposes uuidCursor pagination on graph.edge.getByUserId
  // (unlike graph.search, whose results have no continuation). Walk every page
  // so a forgotten fact cannot survive beyond a relevance-limited search page.
  for (;;) {
    const page = await withZepRetry(
      () => getZep().graph.edge.getByUserId(
        zepUserId,
        uuidCursor ? { limit: ZEP_EDGE_PAGE_SIZE, uuidCursor } : { limit: ZEP_EDGE_PAGE_SIZE },
      ),
      "listZepUserEdges",
      zepUserId,
    );
    edges.push(...page);
    if (page.length < ZEP_EDGE_PAGE_SIZE) return edges;

    const nextCursor = page[page.length - 1]?.uuid;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      // An incomplete pagination walk is never a successful forget. The worker
      // leaves reconciliation pending and retries instead of finalizing stale data.
      throw new Error("zep_edge_pagination_incomplete");
    }
    seenCursors.add(nextCursor);
    uuidCursor = nextCursor;
  }
}

/**
 * Strict: search the user's graph for edges whose extracted fact matches the
 * target fact text. Throws on provider failure. Returns matched UUIDs +
 * episode refs only — never returned fact text.
 */
export async function findZepEdgesMatchingFact(params: {
  zepUserId: string;
  factText: string;
}): Promise<ZepEdgeMatch[]> {
  if (!params.zepUserId || !params.factText?.trim()) return [];
  const edges = await listZepUserEdges(params.zepUserId);
  const matches = edges
    .filter((e) => e?.uuid && zepEdgeFactMatches(String(e.fact ?? ""), params.factText))
    .map((e) => ({ uuid: e.uuid, episodes: Array.isArray(e.episodes) ? e.episodes : [] }));
  // Defensive dedupe protects a provider cursor retry from issuing duplicate
  // delete calls; it never broadens the fact-match predicate.
  return [...new Map(matches.map((match) => [match.uuid, match])).values()];
}

/**
 * Confirms a forget has cleared both the complete user edge inventory and the
 * thread's rendered context. A failed confirmation throws so the worker keeps
 * the reconciliation record pending instead of finalizing a partial deletion.
 */
export async function verifyZepForgottenFactAbsent(params: {
  zepUserId: string;
  factText: string;
  threadId: string;
}): Promise<void> {
  if (!params.zepUserId || !params.factText?.trim() || !params.threadId) {
    throw new Error("verifyZepForgottenFactAbsent: identifiers required");
  }
  const remainingEdges = await findZepEdgesMatchingFact(params);
  if (remainingEdges.length) throw new Error("zep_fact_still_present_in_graph");

  await ensureCaraContextTemplate();
  const response = await withZepRetry(
    () => getZep().thread.getUserContext(
      params.threadId,
      { templateId: CARA_TEMPLATE_ID },
    ),
    "verifyZepForgetContext",
    params.threadId,
  );
  const context = normalizeForEdgeMatch(String(response?.context ?? ""));
  const target = normalizeForEdgeMatch(params.factText);
  if (context && target && (context.includes(target) || zepEdgeFactMatches(context, params.factText))) {
    throw new Error("zep_fact_still_present_in_context");
  }
}

export interface ZepDeleteOutcome {
  /** True when the target was already gone — treated as success (R14). */
  alreadyGone: boolean;
}

/**
 * Strict: mark one edge's fact as no longer true (correction, R13) by setting
 * `invalidAt`. Not-found is success — the edge is already out of the graph.
 */
export async function invalidateZepEdgeStrict(params: {
  edgeUuid: string;
  invalidAt: string;
}): Promise<ZepDeleteOutcome> {
  if (!params.edgeUuid) throw new Error("invalidateZepEdgeStrict: edgeUuid required");
  const outcome = await withZepRetry(async () => {
    try {
      await getZep().graph.edge.update(params.edgeUuid, { invalidAt: params.invalidAt });
      return "updated" as const;
    } catch (err) {
      if (isZepNotFoundError(err)) return "already_gone" as const;
      throw err;
    }
  }, "invalidateZepEdge", params.edgeUuid);
  return { alreadyGone: outcome === "already_gone" };
}

/** Strict: delete ONE edge by UUID (forget, R14). Not-found is success. */
export async function deleteZepEdgeStrict(edgeUuid: string): Promise<ZepDeleteOutcome> {
  if (!edgeUuid) throw new Error("deleteZepEdgeStrict: edgeUuid required");
  const outcome = await withZepRetry(async () => {
    try {
      await getZep().graph.edge.delete(edgeUuid);
      return "deleted" as const;
    } catch (err) {
      if (isZepNotFoundError(err)) return "already_gone" as const;
      throw err;
    }
  }, "deleteZepEdge", edgeUuid);
  return { alreadyGone: outcome === "already_gone" };
}

/**
 * Strict: delete ONE source episode by UUID (forget, R14). Not-found is
 * success. Mixed episodes: privacy wins — the caller deletes the episode even
 * when it carries unrelated facts; those remain retrievable through learned
 * facts and Storage memory (higher-authority layers) and are NOT re-ingested.
 */
export async function deleteZepEpisodeStrict(episodeUuid: string): Promise<ZepDeleteOutcome> {
  if (!episodeUuid) throw new Error("deleteZepEpisodeStrict: episodeUuid required");
  const outcome = await withZepRetry(async () => {
    try {
      await getZep().graph.episode.delete(episodeUuid);
      return "deleted" as const;
    } catch (err) {
      if (isZepNotFoundError(err)) return "already_gone" as const;
      throw err;
    }
  }, "deleteZepEpisode", episodeUuid);
  return { alreadyGone: outcome === "already_gone" };
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
