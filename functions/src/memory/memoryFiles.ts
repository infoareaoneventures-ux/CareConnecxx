import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { safeParseJson } from "../utils/jsonUtils";
import {
  embedText,
  embedMany,
  splitIntoBlocks,
  rankBySimilarity,
  EMBED_MODEL,
} from "./embeddings";

const storage = admin.storage();
const db = admin.firestore();

// ── Reconciliation suppression (memory-grounding U4a, KTD9) ──────────────────
// While a correction/forget operation is unresolved for a user AND its Storage/
// embeddings targets have not confirmed, this module's READERS return nothing
// for that user — enforced HERE, inside the shared readers, so qaAgent prompts,
// morning briefing, weekly digest, trigger engine, matching, and the MCP
// cara_knows/search_memory paths all inherit the suppression without
// per-call-site wiring. Paraphrased stale copies in memory files cannot bypass
// exact-string filters, so the whole store is conservatively omitted until the
// worker (U4b) confirms reconciliation — per-store: a confirmed Storage store
// unmasks even while Zep is still pending.
//
// The check is ONE point read on memory_reconciliation/{userId} in the common
// case (see memoryOperations.getMemoryReconciliationState). Check errors fail
// open with a sanitized log, matching every reader's existing posture.

async function storageMemoryMasked(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { getMemoryReconciliationState } = await import("./memoryOperations");
    return (await getMemoryReconciliationState(userId)).storageMasked;
  } catch {
    return false;
  }
}

/** Deterministic memory-query reply while reconciliation masks memory files (KTD10 — not an outage). */
export const MEMORY_QUERY_RECONCILIATION_COPY =
  "I'm in the middle of updating my memory after a recent correction, so I'm holding off on recalling stored details for a moment. Ask me again shortly and I'll have it sorted.";

// The five canonical files Evia initializes and consolidates into. Callers may also
// read/write arbitrary slugs (the `(string & {})` keeps autocomplete for the canonical
// names while still accepting any other string — e.g. offloaded tool results).
export type CanonicalMemoryFile =
  "profile" | "health" | "family" | "recent_episodes" | "procedural";
export type MemoryFile = CanonicalMemoryFile | (string & {});

const ALL_FILES: CanonicalMemoryFile[] = [
  "profile",
  "health",
  "family",
  "recent_episodes",
  "procedural",
];

// ── Transient tool-result files (memory-grounding U8, R20/KTD14) ─────────────
// Large tool results the agent loop offloads (contextManagement.ts) are
// TRANSIENT WORKING DATA, not durable family memory. They stay readable by
// exact pointer (readMemoryFile) for their 24-hour lifetime, but are excluded
// from every default retrieval surface: prompt concatenation
// (getMemoryContext), substring search, semantic candidates, consolidation
// context, and — because those all flow through listMemoryFiles /
// getMemoryContext — the MCP cara_knows/search_memory tools too. Nightly
// cleanup (cleanupExpiredTransientToolFiles) deletes expired objects plus
// their embedding rows.

export const TRANSIENT_TOOL_MEMORY_CLASS = "transient_tool";
export const TRANSIENT_TOOL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Classifies a memory file as a transient tool offload: Storage custom
 * metadata `memoryClass=transient_tool` (new writes) OR the legacy
 * `tool_` slug prefix (files written before metadata tagging existed).
 */
export function isTransientToolFile(
  file: string | { name: string; memoryClass?: string | null },
): boolean {
  const name = typeof file === "string" ? file : file.name;
  const memoryClass = typeof file === "string" ? undefined : file.memoryClass;
  if (memoryClass === TRANSIENT_TOOL_MEMORY_CLASS) return true;
  return sanitizeFileName(name).startsWith("tool_");
}

// Restrict slugs to a safe charset so a file name can never escape the user's prefix.
function sanitizeFileName(file: string): string {
  const slug = String(file)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 64);
  return slug || "untitled";
}

function filePath(userId: string, file: MemoryFile): string {
  return `memory/${userId}/${sanitizeFileName(file)}.md`;
}

// Enumerate the memory files that actually exist for a user (canonical + ad-hoc).
// R20 (U8): transient tool offloads are EXCLUDED by default — every default
// retrieval surface built on this listing (getMemoryContext, substring search,
// consolidation, MCP cara_knows) inherits the exclusion. Cleanup/maintenance
// callers opt in with { includeTransient: true }.
export async function listMemoryFiles(
  userId: string,
  options?: { includeTransient?: boolean },
): Promise<string[]> {
  try {
    const bucket = storage.bucket();
    const [files] = await bucket.getFiles({ prefix: `memory/${userId}/` });
    return files
      .map((f) => ({
        name: f.name.slice(`memory/${userId}/`.length).replace(/\.md$/, ""),
        memoryClass: (
          f.metadata?.metadata as Record<string, string> | null | undefined
        )?.memoryClass as string | undefined,
      }))
      .filter((f) => f.name)
      .filter(
        (f) => options?.includeTransient === true || !isTransientToolFile(f),
      )
      .map((f) => f.name);
  } catch {
    return [];
  }
}

export async function readMemoryFile(
  userId: string,
  file: MemoryFile,
): Promise<string> {
  try {
    const bucket = storage.bucket();
    const [contents] = await bucket.file(filePath(userId, file)).download();
    return contents.toString("utf-8");
  } catch {
    return "";
  }
}

export interface WriteMemoryFileOptions {
  /** `transient_tool` marks the object as a short-lived tool-result offload (R20/KTD14). */
  memoryClass?: typeof TRANSIENT_TOOL_MEMORY_CLASS;
  /** ISO timestamp after which nightly cleanup may delete the transient object. */
  expiresAt?: string;
}

export async function writeMemoryFile(
  userId: string,
  file: MemoryFile,
  content: string,
  options?: WriteMemoryFileOptions,
): Promise<void> {
  const bucket = storage.bucket();
  const custom: Record<string, string> = {};
  if (options?.memoryClass) custom.memoryClass = options.memoryClass;
  if (options?.expiresAt) custom.expiresAt = options.expiresAt;
  await bucket.file(filePath(userId, file)).save(content, {
    contentType: "text/markdown",
    metadata: {
      cacheControl: "no-cache",
      ...(Object.keys(custom).length > 0 ? { metadata: custom } : {}),
    },
  });

  // R20 (U8): transient tool offloads never get embedding rows — semantic
  // search must not be able to surface them. Prior rows for a reused slug are
  // still purged, defensively (the existing per-file delete path).
  if (
    options?.memoryClass === TRANSIENT_TOOL_MEMORY_CLASS ||
    isTransientToolFile(String(file))
  ) {
    deleteEmbeddingRowsForFile(userId, sanitizeFileName(String(file))).catch(
      (err) => {
        console.warn(
          "[memoryFiles] transient embedding purge failed:",
          err instanceof Error ? err.message : err,
        );
      },
    );
    return;
  }

  // Refresh block embeddings for this file. Failure is non-fatal — substring
  // search still works; we just lose semantic recall until the next write.
  reindexMemoryFileEmbeddings(userId, file, content).catch((err) => {
    console.warn(
      "[memoryFiles] reindex failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

// Delete every embedding row belonging to one file slug. Shared by the
// transient-write purge, the reindex pre-pass, and deleteMemoryFile.
async function deleteEmbeddingRowsForFile(
  userId: string,
  slug: string,
): Promise<void> {
  const col = db
    .collection("memory_embeddings")
    .doc(userId)
    .collection("blocks");
  const prior = await col.where("file", "==", slug).get();
  if (prior.empty) return;
  const batch = db.batch();
  prior.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// Replace all embeddings for a single memory file. Idempotent. Skipped silently
// when no blocks pass the size filter or when the OpenAI key is absent (embedMany
// returns nulls, which we filter out).
async function reindexMemoryFileEmbeddings(
  userId: string,
  file: MemoryFile,
  content: string,
): Promise<void> {
  const slug = sanitizeFileName(file);
  const blocks = splitIntoBlocks(content);

  const col = db
    .collection("memory_embeddings")
    .doc(userId)
    .collection("blocks");

  // Delete prior embeddings for this file (whole-file rewrite, so no diffing).
  await deleteEmbeddingRowsForFile(userId, slug);

  if (blocks.length === 0) return;

  const vectors = await embedMany(blocks);
  const batch = db.batch();
  const nowIso = new Date().toISOString();
  let wrote = 0;

  for (let i = 0; i < blocks.length; i++) {
    const vec = vectors[i];
    if (!vec) continue; // embedding API failed for this block — skip
    const ref = col.doc();
    batch.set(ref, {
      file: slug,
      block: blocks[i].slice(0, 800),
      embedding: vec,
      model: EMBED_MODEL,
      updatedAt: nowIso,
    });
    wrote++;
  }
  if (wrote > 0) await batch.commit();
}

export async function appendToMemoryFile(
  userId: string,
  file: MemoryFile,
  entry: string,
): Promise<void> {
  const existing = await readMemoryFile(userId, file);
  const updated = existing ? `${existing.trimEnd()}\n\n${entry}` : entry;
  await writeMemoryFile(userId, file, updated);
}

// Surgical find/replace within a single memory file — for correcting a stored fact
// ("Mom is 82 not 78") without rewriting the whole file or appending a duplicate.
// Returns the number of occurrences replaced (0 = no match, file left untouched).
export async function editMemoryFile(
  userId: string,
  file: MemoryFile,
  find: string,
  replace: string,
): Promise<number> {
  if (!find) return 0;
  const existing = await readMemoryFile(userId, file);
  if (!existing || !existing.includes(find)) return 0;
  const count = existing.split(find).length - 1;
  const updated = existing.split(find).join(replace);
  await writeMemoryFile(userId, file, updated);
  return count;
}

// Remove a memory file entirely — the storage object AND its block embeddings.
// Complements read/update/edit: used when a family asks Evia to forget a whole
// file or when an ad-hoc offloaded tool-result file is no longer needed.
// Returns true when a file existed and was deleted, false when nothing was there
// (idempotent — a second call is a safe no-op).
export async function deleteMemoryFile(
  userId: string,
  file: MemoryFile,
): Promise<boolean> {
  const slug = sanitizeFileName(file);
  const bucket = storage.bucket();
  const ref = bucket.file(filePath(userId, file));

  let existed = false;
  try {
    const [exists] = await ref.exists();
    existed = exists;
    if (exists) await ref.delete();
  } catch (err) {
    console.warn(
      "[memoryFiles] delete failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  // Drop this file's embeddings so semantic search can't resurface deleted
  // content. Failure is non-fatal — orphaned embeddings only affect recall.
  try {
    await deleteEmbeddingRowsForFile(userId, slug);
  } catch (err) {
    console.warn(
      "[memoryFiles] embedding cleanup on delete failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return existed;
}

// ── Transient tool-file cleanup (memory-grounding U8, R20/KTD14) ─────────────
// Deletes expired transient tool offloads (object + embedding rows via the
// existing per-file delete path). Expiry resolution order:
//   1. Storage custom metadata `expiresAt` (new writes);
//   2. Storage `timeCreated` + 24h TTL;
//   3. legacy `tool_<name>_<epochMs>` slug timestamp — LAST-resort fallback
//      for old objects whose creation metadata is unavailable.
// A transient file with a malformed slug and no usable metadata is RETAINED
// and counted. A hard guard never deletes an object younger than the 24-hour
// lifetime regardless of what any expiry field claims — an active loop may
// still hold its pointer. Idempotent: deleted objects vanish from the next
// scan. Returns aggregate counts only (R21) — no user IDs, no slugs.

export interface TransientCleanupCounts {
  scanned: number;
  retained: number;
  deleted: number;
  malformed: number;
  failed: number;
}

const MEMORY_OBJECT_RE = /^memory\/([^/]+)\/([^/]+)\.md$/;
const LEGACY_SLUG_TS_RE = /_(\d{10,})$/;
export const TRANSIENT_CLEANUP_PAGE_SIZE = 200;

export async function cleanupExpiredTransientToolFiles(
  now: number = Date.now(),
): Promise<TransientCleanupCounts> {
  const counts: TransientCleanupCounts = {
    scanned: 0,
    retained: 0,
    deleted: 0,
    malformed: 0,
    failed: 0,
  };

  type StorageFile = {
    name: string;
    metadata?: {
      timeCreated?: string;
      metadata?: Record<string, string> | null;
    };
  };
  type NextPage = { pageToken?: string } | null | undefined;

  const bucket = storage.bucket();
  let pageToken: string | undefined;
  do {
    let files: StorageFile[];
    let nextPage: NextPage;
    try {
      [files, nextPage] = (await bucket.getFiles({
        prefix: "memory/",
        maxResults: TRANSIENT_CLEANUP_PAGE_SIZE,
        pageToken,
        autoPaginate: false,
      })) as unknown as [StorageFile[], NextPage];
    } catch (err) {
      counts.failed++;
      console.warn("[memoryFiles] transient cleanup listing failed:", {
        errorClass: err instanceof Error ? err.name : "Error",
      });
      return counts;
    }

    for (const f of files) {
      const match = MEMORY_OBJECT_RE.exec(f.name);
      if (!match) continue;
      const [, userId, slug] = match;
      const custom = (f.metadata?.metadata ?? undefined) as
        Record<string, string> | undefined;
      if (
        !isTransientToolFile({ name: slug, memoryClass: custom?.memoryClass })
      )
        continue;

      counts.scanned++;

      const timeCreatedMs = Date.parse(String(f.metadata?.timeCreated ?? ""));
      // Hard guard: never delete an object younger than the 24h lifetime.
      if (
        Number.isFinite(timeCreatedMs) &&
        now - timeCreatedMs < TRANSIENT_TOOL_TTL_MS
      ) {
        counts.retained++;
        continue;
      }

      const expiresAtMs = Date.parse(String(custom?.expiresAt ?? ""));
      let expired: boolean;
      if (Number.isFinite(expiresAtMs)) {
        expired = now >= expiresAtMs;
      } else if (Number.isFinite(timeCreatedMs)) {
        expired = now - timeCreatedMs >= TRANSIENT_TOOL_TTL_MS;
      } else {
        // Legacy fallback: parse the epoch-ms suffix out of the slug.
        const legacy = LEGACY_SLUG_TS_RE.exec(slug);
        if (!legacy) {
          counts.malformed++; // retained — no trustworthy age signal at all
          continue;
        }
        expired = now - Number(legacy[1]) >= TRANSIENT_TOOL_TTL_MS;
      }

      if (!expired) {
        counts.retained++;
        continue;
      }

      try {
        // Existing per-file delete path: removes the object AND its embedding rows.
        const removed = await deleteMemoryFile(userId, slug);
        if (removed) counts.deleted++;
        else counts.failed++;
      } catch {
        counts.failed++;
      }
    }

    pageToken = nextPage?.pageToken;
  } while (pageToken);

  return counts;
}

// ── Cross-file fact reconciliation for the correction/forget worker (U4b) ────
// Locates EXACT (case-insensitive) substring matches of the retired fact text
// across every memory file the user has and rewrites them:
//   • correction → the occurrence is replaced with the corrected text;
//   • forget     → the occurrence is removed (leftover blank runs collapsed).
// Known limitation (accepted by KTD9): PARAPHRASED copies are not matched here
// — that is exactly why the whole Storage store is masked at the readers until
// this store's targets confirm, and why consolidation's reconcile pass owns
// long-term supersede. writeMemoryFile re-indexes the rewritten file's
// embeddings; deleteEmbeddingRowsMatching below covers rows whose file was NOT
// rewritten this run.

export interface FactReconcileResult {
  filesScanned: number;
  filesRewritten: number;
  occurrencesReplaced: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function reconcileFactAcrossMemoryFiles(
  userId: string,
  retiredText: string,
  replacement: string,
): Promise<FactReconcileResult> {
  const result: FactReconcileResult = {
    filesScanned: 0,
    filesRewritten: 0,
    occurrencesReplaced: 0,
  };
  const needle = (retiredText ?? "").trim();
  if (!userId || !needle) return result;

  const pattern = new RegExp(escapeRegExp(needle), "gi");
  const files = await listMemoryFiles(userId);
  for (const file of files) {
    const content = await readMemoryFile(userId, file);
    if (!content) continue;
    result.filesScanned++;
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (!matches || matches.length === 0) continue;
    let updated = content.replace(pattern, replacement ?? "");
    if (!replacement) {
      // Forget: collapse the holes the removal left behind.
      updated = updated
        .split("\n")
        .filter(
          (line, i, arr) =>
            !(line.trim() === "" && (arr[i - 1] ?? "").trim() === ""),
        )
        .filter((line) => !/^[-*•]\s*$/.test(line.trim()))
        .join("\n")
        .replace(/[ \t]+\n/g, "\n");
    }
    await writeMemoryFile(userId, file, updated);
    result.filesRewritten++;
    result.occurrencesReplaced += matches.length;
  }

  // Conversation summaries are trusted context but have no fact-level source
  // index. Once a correction/forget starts, any existing summary could contain
  // a paraphrase of the retired fact. Remove it before the worker can clear the
  // reconciliation flag; the next safe rollup rebuilds it from live rows.
  const sessions = await db
    .collection("agent_sessions")
    .where("userId", "==", userId)
    .get();
  for (const session of sessions.docs) {
    const summaries = await db
      .collection("agent_conversations")
      .doc(session.id)
      .collection("messages")
      .where("role", "==", "summary")
      .get();
    await Promise.all(summaries.docs.map((summary) => summary.ref.delete()));
  }

  return result;
}

/**
 * Deletes memory-embedding block rows whose text contains the retired fact
 * (exact case-insensitive substring — same limitation/mitigation as above).
 * Complements the per-file reindex `writeMemoryFile` fires: rows belonging to
 * files that were not rewritten this run are still purged, so semantic search
 * cannot resurface the retired assertion once the store unmasks.
 */
export async function deleteEmbeddingRowsMatching(
  userId: string,
  retiredText: string,
): Promise<number> {
  const needle = (retiredText ?? "").trim().toLowerCase();
  if (!userId || !needle) return 0;
  const col = db
    .collection("memory_embeddings")
    .doc(userId)
    .collection("blocks");
  const snap = await col.get();
  const doomed = snap.docs.filter((d) =>
    String(d.data()?.block ?? "")
      .toLowerCase()
      .includes(needle),
  );
  if (doomed.length === 0) return 0;
  const batch = db.batch();
  doomed.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return doomed.length;
}

export interface MemorySearchHit {
  file: string;
  section: string; // the matching block (paragraph or heading section)
  source?: "substring" | "semantic";
  score?: number; // cosine similarity for semantic hits, 1.0 for substring
}

// Substring search across all of a user's memory files. Returns the matching
// sections so the QA agent can retrieve a fact without injecting all ~12K chars.
export async function searchMemory(
  userId: string,
  query: string,
): Promise<MemorySearchHit[]> {
  if (await storageMemoryMasked(userId)) return []; // U4a: reconciliation pending
  return searchMemoryUnguarded(userId, query);
}

// Internal body — searchMemoryHybrid runs its own single mask check and then
// calls this, so one hybrid search never pays the point read twice.
async function searchMemoryUnguarded(
  userId: string,
  query: string,
): Promise<MemorySearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const files = await listMemoryFiles(userId);
  const hits: MemorySearchHit[] = [];

  for (const file of files) {
    const content = await readMemoryFile(userId, file);
    if (!content) continue;
    // Split into blocks on blank lines so a hit returns a coherent chunk of context.
    for (const block of content.split(/\n\s*\n/)) {
      if (block.toLowerCase().includes(q)) {
        hits.push({
          file,
          section: block.trim().slice(0, 800),
          source: "substring",
          score: 1,
        });
      }
    }
  }
  return hits;
}

/**
 * Hybrid memory search — substring (exact) ∪ semantic (cosine over embeddings).
 *
 * Substring is run unconditionally so we never regress on exact-match recall.
 * Semantic recall pulls in synonym / paraphrase matches that substring would miss
 * ("T2DM" → "diabetes", "tripped Tuesday" → "fall"). If the embedding API fails
 * or the key is missing, this collapses cleanly to substring-only.
 */
export async function searchMemoryHybrid(
  userId: string,
  query: string,
  topK = 8,
): Promise<MemorySearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  if (await storageMemoryMasked(userId)) return []; // U4a: reconciliation pending

  // Run substring + query embedding in parallel — substring is local-ish (Storage
  // reads), embedding is one OpenAI call; we don't want to serialize them.
  const [substringHits, queryEmbed] = await Promise.all([
    searchMemoryUnguarded(userId, q),
    embedText(q),
  ]);

  let semanticHits: MemorySearchHit[] = [];
  if (queryEmbed) {
    try {
      const snap = await db
        .collection("memory_embeddings")
        .doc(userId)
        .collection("blocks")
        .get();
      const candidates = snap.docs
        .map(
          (d) =>
            d.data() as {
              file: string;
              block: string;
              embedding: number[];
              memoryClass?: string;
            },
        )
        // R20 (U8): transient tool-file rows (legacy `tool_` slugs — new
        // transient writes create no rows at all) never become semantic
        // candidates.
        .filter(
          (data) =>
            !isTransientToolFile({
              name: data.file,
              memoryClass: data.memoryClass,
            }),
        )
        .map((data) => ({
          file: data.file,
          block: data.block,
          embedding: data.embedding,
        }));
      const ranked = rankBySimilarity(candidates, queryEmbed, topK);
      semanticHits = ranked.map((r) => ({
        file: r.file,
        section: r.block,
        source: "semantic" as const,
        score: r._sim,
      }));
    } catch (err) {
      console.warn(
        "[memoryFiles] semantic search failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Dedup on (file, section) — prefer substring hits (score=1) over semantic.
  const seen = new Map<string, MemorySearchHit>();
  for (const hit of [...substringHits, ...semanticHits]) {
    const key = `${hit.file}::${hit.section.slice(0, 200)}`;
    const existing = seen.get(key);
    if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, hit);
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);
}

// Returns existing files concatenated, trimmed to ~3000 tokens (~12 000 chars).
// Enumerates the user's bucket prefix so ad-hoc files are included, with the five
// canonical files ordered first. Transient tool offloads never appear here —
// listMemoryFiles excludes them by default (R20/U8) — so every prompt built on
// this context (qaAgent, briefing, digest, trigger engine, consolidation,
// MCP cara_knows) inherits the exclusion.
export async function getMemoryContext(userId: string): Promise<string> {
  if (await storageMemoryMasked(userId)) return ""; // U4a: reconciliation pending
  const present = await listMemoryFiles(userId);
  const ordered = [
    ...ALL_FILES.filter((f) => present.includes(f)),
    ...present
      .filter((f) => !ALL_FILES.includes(f as CanonicalMemoryFile))
      .sort(),
  ];

  const parts = await Promise.all(
    ordered.map(async (file) => {
      const content = await readMemoryFile(userId, file);
      return content ? `## ${file}\n${content}` : "";
    }),
  );

  const combined = parts.filter(Boolean).join("\n\n");
  if (combined.length <= 12000) return combined;
  return combined.slice(0, 12000) + "\n\n[Memory truncated for length]";
}

export interface InitialMemoryData {
  seniorName?: string;
  seniorAge?: string | number;
  conditions?: string | string[];
  careNeeds?: string | string[];
  city?: string;
  clientName?: string;
  relationship?: string;
}

export async function initializeMemoryFiles(
  userId: string,
  data: InitialMemoryData,
): Promise<void> {
  const seniorName = data.seniorName ?? "your loved one";
  const clientName = data.clientName ?? "";
  const relationship = data.relationship ?? "family member";
  const conditions = Array.isArray(data.conditions)
    ? data.conditions.join(", ")
    : (data.conditions ?? "none noted");
  const careNeeds = Array.isArray(data.careNeeds)
    ? data.careNeeds.join(", ")
    : (data.careNeeds ?? "general support");

  const profileMd =
    `# Profile\n\n` +
    `**Senior:** ${seniorName}${data.seniorAge ? `, age ${data.seniorAge}` : ""}\n` +
    `**Primary contact:** ${clientName} (${relationship})\n` +
    `**Location:** ${data.city ?? "unknown"}\n` +
    `**Care needs:** ${careNeeds}\n`;

  const healthMd =
    `# Health\n\n` +
    `**Conditions:** ${conditions}\n` +
    `**Medications:** unknown\n` +
    `**Allergies:** unknown\n`;

  await Promise.all([
    writeMemoryFile(userId, "profile", profileMd),
    writeMemoryFile(userId, "health", healthMd),
  ]);
}

// Triggered when user asks what Evia knows/remembers ("what do you know about
// mom?", "do you know my name?", "what's my mom's name?").
// `question`: the user's actual message — the answer must address THIS, not just
//   dump the whole profile (asking "what's my mom's name" should get the name,
//   not a warm recap of the entire care situation).
// zepContext: recent conversational memory from Zep (optional, injected by caller)
export async function handleMemoryQuery(
  userId: string,
  chatId: string,
  sendMessage: (id: string, msg: string) => Promise<unknown>,
  question: string,
  zepContext?: string,
  // 2026-07-22 incident: recall answers for CAREGIVERS were framed as family
  // members and grounded on memory alone — a cleared background check was
  // described as "awaiting" from a two-week-old Zep fact, and a saved name was
  // denied. Callers now pass the role; caregiver queries get the live account
  // briefing (source of truth) prepended and role-correct framing.
  opts?: { userType?: string; caregiverId?: string },
): Promise<string | null> {
  // U4a/KTD10: a memory query while reconciliation is pending gets the honest
  // deterministic "updating my memory" copy — never a stale recall and never
  // an outage claim. Deliberately checked BEFORE reading files/Zep context.
  if (await storageMemoryMasked(userId)) {
    await sendMessage(chatId, MEMORY_QUERY_RECONCILIATION_COPY);
    return MEMORY_QUERY_RECONCILIATION_COPY;
  }
  const isCaregiver = opts?.userType === "caregiver";
  const [fileContext, liveFacts] = await Promise.all([
    getMemoryContext(userId),
    isCaregiver
      ? import("../agents/caregiverBriefing").then((m) =>
          m.describeCaregiverAccountStatus(opts?.caregiverId ?? userId))
      : Promise.resolve(""),
  ]);
  const combined = [
    liveFacts,
    fileContext,
    zepContext ? `## Recent context (may be stale — live account facts above win on any conflict)\n${zepContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    const fallback = "I'm still building up my picture of your situation. The more we talk, the more I'll know.";
    await sendMessage(chatId, fallback);
    return fallback;
  }

  const persona = isCaregiver
    ? "You are Evia, a warm care-team coordinator texting a professional CAREGIVER who works on your platform. " +
      "They are NOT a family member and have no \"loved one\" receiving care — never use family framing. "
    : "You are Evia, a warm care assistant texting a family member. Below is what you know about " +
      "their care situation. ";

  const result = await getSharedClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system:
      persona +
      "Answer THEIR QUESTION directly and specifically using that context. " +
      "If they ask for one fact (a name, an age, a city), lead with that fact in one short sentence — " +
      'do NOT recap the whole profile. If the question is open-ended (e.g. "what do you know about my mom"), ' +
      "give a warm 2–3 sentence summary. Use ONLY facts present in what you know below — never infer or invent. " +
      "When a LIVE ACCOUNT FACTS section is present, those facts are the current truth and OVERRIDE anything " +
      "older memory says on the same topic (e.g. a background check listed as CLEARED is cleared, even if an " +
      "old conversation said it was processing). " +
      "If the answer isn't in what you know, say so briefly and offer to " +
      "note it. Plain conversational text — no bullet points, no headers.",
    messages: [
      {
        role: "user",
        content: `What I know:\n${combined}\n\nTheir question: ${question}`,
      },
    ],
  });

  const summary = ((result.content[0] as { text: string }).text ?? "").trim();
  const reply = summary || "I remember quite a bit — just ask me something specific.";
  await sendMessage(chatId, reply);
  return reply;
}

// Consolidate last 7 days of actual conversation messages into memory files.
// `phone` is optional — if omitted, we look it up from agent_sessions using userId.
// Memory consolidation only ever APPENDS, so over time a file accumulates
// duplicates and stale facts (an old medication sitting next to its replacement).
// In eldercare a contradictory health fact is a safety + trust risk. This pass
// dedupes and supersedes: a newer fact wins over the older one it replaces, every
// distinct still-true fact is preserved, and the file is capped. Idempotent — a
// second run on an already-clean file returns the same content and writes nothing.
const RECONCILE_MIN_CHARS = 800;

export async function reconcileMemoryFile(
  userId: string,
  file: CanonicalMemoryFile,
): Promise<boolean> {
  const content = await readMemoryFile(userId, file);
  // Below the threshold there's nothing worth spending an LLM call to reconcile.
  if (content.trim().length < RECONCILE_MIN_CHARS) return false;
  try {
    const result = await getSharedClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system:
        `You are reconciling a memory file of type "${file}" for one care recipient. ` +
        "Remove duplicate facts. When a newer fact supersedes an older one (a changed " +
        "medication, dose, address, phone, or age), keep ONLY the current fact and drop the " +
        "stale one. Preserve every distinct fact that is still true — do not drop or invent " +
        "anything else. Record ONLY facts present in the file — never infer or invent. " +
        "Preserve verbatim: people's names, dollar amounts, and any commitments or promises made. " +
        "Keep it concise. Reply with ONLY the revised markdown content.",
      messages: [{ role: "user", content }],
    });
    const block = result.content[0];
    // Anthropic content blocks are a discriminated union — only a "text" block
    // carries `.text`. A non-text block (e.g. tool_use) would otherwise read as
    // undefined and throw; treat anything else as nothing to reconcile.
    const revised = (block?.type === "text" ? block.text : "").trim();
    // No-op when the model returns nothing or the file is already clean.
    if (!revised || revised === content.trim()) return false;
    await writeMemoryFile(userId, file, revised);
    return true;
  } catch {
    return false;
  }
}

// Files worth reconciling — the long-lived fact stores. recent_episodes has its
// own time-based trim; procedural rarely accumulates contradictions.
const RECONCILABLE_FILES: CanonicalMemoryFile[] = [
  "profile",
  "health",
  "family",
];

export async function consolidateMemoryForUser(
  userId: string,
  phone?: string,
): Promise<void> {
  // U4a/R23: never consolidate while a correction/forget is reconciling — a
  // nightly pass over old conversation rows could re-write the very fact being
  // removed. The user is simply skipped this run; the worker (U4b) marks source
  // rows excluded before the flag clears.
  try {
    const { hasUnresolvedReconciliation } = await import("./memoryOperations");
    if (await hasUnresolvedReconciliation(userId)) return;
  } catch {
    /* fail-open — matches this module's reader posture */
  }

  // Resolve phone → agent_conversations doc key
  let conversationKey = phone ?? userId;
  if (!phone) {
    const sessionSnap = await db
      .collection("agent_sessions")
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (!sessionSnap.empty) conversationKey = sessionSnap.docs[0].id;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime();

  const msgSnap = await db
    .collection("agent_conversations")
    .doc(conversationKey)
    .collection("messages")
    .where("timestamp", ">=", sevenDaysAgo)
    .orderBy("timestamp", "asc")
    .limit(60)
    .get();

  if (msgSnap.empty) return;

  const events = msgSnap.docs
    .filter((d) => d.data().role === "user" || d.data().role === "assistant")
    // R23/KTD16 (U4b): rows the correction/forget worker marked as containing a
    // corrected/forgotten fact never enter the consolidation prompt — nightly
    // consolidation must not recreate the retired fact from old conversation.
    .filter((d) => !d.data().excludeFromMemoryConsolidationAt)
    .map((d) => {
      const label = d.data().role === "user" ? "Family" : "Evia";
      const content = (d.data().content as string | undefined) ?? "";
      return `[${label}]: ${content.slice(0, 600)}`;
    })
    .join("\n");

  if (!events) return;

  const existingContext = await getMemoryContext(userId);

  const result = await getSharedClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system:
      "You maintain memory files for a caregiving AI assistant named Evia. " +
      "Based on recent conversation events, extract new facts and decide which memory files to update. " +
      "Record ONLY facts present in the recent conversation events — never infer or invent. " +
      "Preserve verbatim: people's names, dollar amounts, and any commitments or promises made. " +
      "Memory files: profile (identity/contact prefs), health (diagnoses/meds/allergies), " +
      "family (relationships/dynamics), recent_episodes (last 30 days events), procedural (routines). " +
      'Reply with JSON: [{"file": "<type>", "append": "<markdown to append>"}]. ' +
      "Only include files that need updating. Keep appended content concise (1–3 lines each).",
    messages: [
      {
        role: "user",
        content: `Existing memory:\n${existingContext}\n\nRecent events:\n${events}`,
      },
    ],
  });

  const raw = ((result.content[0] as { text: string }).text ?? "").trim();
  const updates =
    safeParseJson<Array<{ file: MemoryFile; append: string }>>(
      raw,
      "memoryFiles.consolidate",
      [],
      "array",
    ) ?? [];
  if (updates.length === 0) return;

  const appliedUpdates: Array<{ file: MemoryFile; append: string }> = [];
  for (const { file, append } of updates) {
    if ((ALL_FILES as readonly string[]).includes(file) && append) {
      await appendToMemoryFile(userId, file, append).catch(() => {});
      appliedUpdates.push({ file, append });
    }
  }

  // Sync applied updates to Zep knowledge graph (fire-and-forget)
  if (appliedUpdates.length > 0 && phone) {
    const zepUserId = phone.replace(/\D/g, "");
    const { addBusinessDataToZep } = await import("./zepClient");
    addBusinessDataToZep({
      userId: zepUserId,
      data: {
        event_type: "memory_files_consolidated",
        updates: appliedUpdates.map((u) => ({
          file: u.file,
          content: u.append.slice(0, 400),
        })),
        timestamp: new Date().toISOString(),
        data_source: "cara_memory_consolidation",
      },
    }).catch(() => {});
  }

  // Reconcile the long-lived fact files that received updates this run, so the
  // append above can't leave a stale fact sitting next to its replacement.
  const touched = new Set(appliedUpdates.map((u) => String(u.file)));
  for (const file of RECONCILABLE_FILES) {
    if (touched.has(file))
      await reconcileMemoryFile(userId, file).catch(() => {});
  }

  // Trim recent_episodes.md if it exceeds 8000 chars
  const episodes = await readMemoryFile(userId, "recent_episodes");
  if (episodes.length > 8000) {
    const trimResult = await getSharedClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "Summarize the oldest entries in this care episode log into a brief paragraph. " +
        "Keep the most recent entries verbatim. Record ONLY facts present in the log — never infer or invent. " +
        "Preserve verbatim: people's names, dollar amounts, and any commitments or promises made. " +
        "Reply with only the revised markdown content.",
      messages: [{ role: "user", content: episodes }],
    });
    const trimmed = (
      (trimResult.content[0] as { text: string }).text ?? ""
    ).trim();
    if (trimmed) {
      await writeMemoryFile(userId, "recent_episodes", trimmed);

      // Keep Zep in sync with the trimmed version so context injection stays consistent.
      if (phone) {
        const zepUserId = phone.replace(/\D/g, "");
        const { addBusinessDataToZep } = await import("./zepClient");
        addBusinessDataToZep({
          userId: zepUserId,
          data: {
            event_type: "recent_episodes_trimmed",
            content: trimmed.slice(0, 800),
            timestamp: new Date().toISOString(),
            data_source: "cara_memory_trim",
          },
        }).catch(() => {});
      }
    }
  }
}
