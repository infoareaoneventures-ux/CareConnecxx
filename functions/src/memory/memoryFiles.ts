import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { safeParseJson } from "../utils/jsonUtils";
import { embedText, embedMany, splitIntoBlocks, rankBySimilarity, EMBED_MODEL } from "./embeddings";

const storage = admin.storage();
const db      = admin.firestore();

// The five canonical files Cara initializes and consolidates into. Callers may also
// read/write arbitrary slugs (the `(string & {})` keeps autocomplete for the canonical
// names while still accepting any other string — e.g. offloaded tool results).
export type CanonicalMemoryFile = "profile" | "health" | "family" | "recent_episodes" | "procedural";
export type MemoryFile = CanonicalMemoryFile | (string & {});

const ALL_FILES: CanonicalMemoryFile[] = ["profile", "health", "family", "recent_episodes", "procedural"];

// Restrict slugs to a safe charset so a file name can never escape the user's prefix.
function sanitizeFileName(file: string): string {
  const slug = String(file).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return slug || "untitled";
}

function filePath(userId: string, file: MemoryFile): string {
  return `memory/${userId}/${sanitizeFileName(file)}.md`;
}

// Enumerate the memory files that actually exist for a user (canonical + ad-hoc).
export async function listMemoryFiles(userId: string): Promise<string[]> {
  try {
    const bucket = storage.bucket();
    const [files] = await bucket.getFiles({ prefix: `memory/${userId}/` });
    return files
      .map((f) => f.name.slice(`memory/${userId}/`.length).replace(/\.md$/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function readMemoryFile(userId: string, file: MemoryFile): Promise<string> {
  try {
    const bucket = storage.bucket();
    const [contents] = await bucket.file(filePath(userId, file)).download();
    return contents.toString("utf-8");
  } catch {
    return "";
  }
}

export async function writeMemoryFile(
  userId: string,
  file: MemoryFile,
  content: string
): Promise<void> {
  const bucket = storage.bucket();
  await bucket.file(filePath(userId, file)).save(content, {
    contentType: "text/markdown",
    metadata:    { cacheControl: "no-cache" },
  });

  // Refresh block embeddings for this file. Failure is non-fatal — substring
  // search still works; we just lose semantic recall until the next write.
  reindexMemoryFileEmbeddings(userId, file, content).catch((err) => {
    console.warn("[memoryFiles] reindex failed:", err instanceof Error ? err.message : err);
  });
}

// Replace all embeddings for a single memory file. Idempotent. Skipped silently
// when no blocks pass the size filter or when the OpenAI key is absent (embedMany
// returns nulls, which we filter out).
async function reindexMemoryFileEmbeddings(
  userId: string,
  file:   MemoryFile,
  content:string,
): Promise<void> {
  const slug   = sanitizeFileName(file);
  const blocks = splitIntoBlocks(content);

  const col = db.collection("memory_embeddings").doc(userId).collection("blocks");

  // Delete prior embeddings for this file (whole-file rewrite, so no diffing).
  const prior = await col.where("file", "==", slug).get();
  if (!prior.empty) {
    const batch = db.batch();
    prior.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  if (blocks.length === 0) return;

  const vectors = await embedMany(blocks);
  const batch   = db.batch();
  const nowIso  = new Date().toISOString();
  let wrote     = 0;

  for (let i = 0; i < blocks.length; i++) {
    const vec = vectors[i];
    if (!vec) continue; // embedding API failed for this block — skip
    const ref = col.doc();
    batch.set(ref, {
      file:        slug,
      block:       blocks[i].slice(0, 800),
      embedding:   vec,
      model:       EMBED_MODEL,
      updatedAt:   nowIso,
    });
    wrote++;
  }
  if (wrote > 0) await batch.commit();
}

export async function appendToMemoryFile(
  userId: string,
  file: MemoryFile,
  entry: string
): Promise<void> {
  const existing = await readMemoryFile(userId, file);
  const updated  = existing
    ? `${existing.trimEnd()}\n\n${entry}`
    : entry;
  await writeMemoryFile(userId, file, updated);
}

// Surgical find/replace within a single memory file — for correcting a stored fact
// ("Mom is 82 not 78") without rewriting the whole file or appending a duplicate.
// Returns the number of occurrences replaced (0 = no match, file left untouched).
export async function editMemoryFile(
  userId: string,
  file: MemoryFile,
  find: string,
  replace: string
): Promise<number> {
  if (!find) return 0;
  const existing = await readMemoryFile(userId, file);
  if (!existing || !existing.includes(find)) return 0;
  const count   = existing.split(find).length - 1;
  const updated = existing.split(find).join(replace);
  await writeMemoryFile(userId, file, updated);
  return count;
}

export interface MemorySearchHit {
  file:    string;
  section: string; // the matching block (paragraph or heading section)
  source?: "substring" | "semantic";
  score?:  number; // cosine similarity for semantic hits, 1.0 for substring
}

// Substring search across all of a user's memory files. Returns the matching
// sections so the QA agent can retrieve a fact without injecting all ~12K chars.
export async function searchMemory(userId: string, query: string): Promise<MemorySearchHit[]> {
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
        hits.push({ file, section: block.trim().slice(0, 800), source: "substring", score: 1 });
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
  query:  string,
  topK = 8,
): Promise<MemorySearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];

  // Run substring + query embedding in parallel — substring is local-ish (Storage
  // reads), embedding is one OpenAI call; we don't want to serialize them.
  const [substringHits, queryEmbed] = await Promise.all([
    searchMemory(userId, q),
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
      const candidates = snap.docs.map((d) => {
        const data = d.data() as { file: string; block: string; embedding: number[] };
        return { file: data.file, block: data.block, embedding: data.embedding };
      });
      const ranked = rankBySimilarity(candidates, queryEmbed, topK);
      semanticHits = ranked.map((r) => ({
        file:    r.file,
        section: r.block,
        source:  "semantic" as const,
        score:   r._sim,
      }));
    } catch (err) {
      console.warn("[memoryFiles] semantic search failed:", err instanceof Error ? err.message : err);
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
// canonical files ordered first.
export async function getMemoryContext(userId: string): Promise<string> {
  const present = await listMemoryFiles(userId);
  const ordered = [
    ...ALL_FILES.filter((f) => present.includes(f)),
    ...present.filter((f) => !ALL_FILES.includes(f as CanonicalMemoryFile)).sort(),
  ];

  const parts = await Promise.all(
    ordered.map(async (file) => {
      const content = await readMemoryFile(userId, file);
      return content ? `## ${file}\n${content}` : "";
    })
  );

  const combined = parts.filter(Boolean).join("\n\n");
  if (combined.length <= 12000) return combined;
  return combined.slice(0, 12000) + "\n\n[Memory truncated for length]";
}

export interface InitialMemoryData {
  seniorName?:   string;
  seniorAge?:    string | number;
  conditions?:   string | string[];
  careNeeds?:    string | string[];
  city?:         string;
  clientName?:   string;
  relationship?: string;
}

export async function initializeMemoryFiles(
  userId: string,
  data:   InitialMemoryData
): Promise<void> {
  const seniorName   = data.seniorName   ?? "your loved one";
  const clientName   = data.clientName   ?? "";
  const relationship = data.relationship ?? "family member";
  const conditions   = Array.isArray(data.conditions)
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

// Triggered when user asks "what do you know about mom?" (or similar)
// zepContext: recent conversational memory from Zep (optional, injected by caller)
export async function handleMemoryQuery(
  userId: string,
  chatId: string,
  sendMessage: (id: string, msg: string) => Promise<unknown>,
  zepContext?: string
): Promise<void> {
  const fileContext = await getMemoryContext(userId);
  const combined    = [fileContext, zepContext ? `## Recent context\n${zepContext}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    await sendMessage(chatId, "I'm still building up my picture of your situation. The more we talk, the more I'll know.");
    return;
  }

  const result = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system:
      "You are Cara, a care assistant. Summarize what you know about this family's care situation " +
      "in 2–3 warm, conversational sentences. No bullet points. No headers. Speak as if recounting " +
      "what a trusted friend would remember.",
    messages: [{ role: "user", content: combined }],
  });

  const summary = ((result.content[0] as { text: string }).text ?? "").trim();
  await sendMessage(chatId, summary || "I remember quite a bit — just ask me something specific.");
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
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system:
        `You are reconciling a memory file of type "${file}" for one care recipient. ` +
        "Remove duplicate facts. When a newer fact supersedes an older one (a changed " +
        "medication, dose, address, phone, or age), keep ONLY the current fact and drop the " +
        "stale one. Preserve every distinct fact that is still true — do not drop or invent " +
        "anything else. Keep it concise. Reply with ONLY the revised markdown content.",
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
const RECONCILABLE_FILES: CanonicalMemoryFile[] = ["profile", "health", "family"];

export async function consolidateMemoryForUser(userId: string, phone?: string): Promise<void> {
  // Resolve phone → agent_conversations doc key
  let conversationKey = phone ?? userId;
  if (!phone) {
    const sessionSnap = await db.collection("agent_sessions")
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
    .map((d) => {
      const label   = d.data().role === "user" ? "Family" : "Cara";
      const content = (d.data().content as string | undefined) ?? "";
      return `[${label}]: ${content.slice(0, 600)}`;
    })
    .join("\n");

  if (!events) return;

  const existingContext = await getMemoryContext(userId);

  const result = await getSharedClient().messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 600,
    system:
      "You maintain memory files for a caregiving AI assistant named Cara. " +
      "Based on recent conversation events, extract new facts and decide which memory files to update. " +
      "Memory files: profile (identity/contact prefs), health (diagnoses/meds/allergies), " +
      "family (relationships/dynamics), recent_episodes (last 30 days events), procedural (routines). " +
      "Reply with JSON: [{\"file\": \"<type>\", \"append\": \"<markdown to append>\"}]. " +
      "Only include files that need updating. Keep appended content concise (1–3 lines each).",
    messages: [{
      role: "user",
      content: `Existing memory:\n${existingContext}\n\nRecent events:\n${events}`,
    }],
  });

  const raw = ((result.content[0] as { text: string }).text ?? "").trim();
  const updates = safeParseJson<Array<{ file: MemoryFile; append: string }>>(
    raw, "memoryFiles.consolidate", [], "array",
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
        event_type:  "memory_files_consolidated",
        updates:     appliedUpdates.map((u) => ({ file: u.file, content: u.append.slice(0, 400) })),
        timestamp:   new Date().toISOString(),
        data_source: "cara_memory_consolidation",
      },
    }).catch(() => {});
  }

  // Reconcile the long-lived fact files that received updates this run, so the
  // append above can't leave a stale fact sitting next to its replacement.
  const touched = new Set(appliedUpdates.map((u) => String(u.file)));
  for (const file of RECONCILABLE_FILES) {
    if (touched.has(file)) await reconcileMemoryFile(userId, file).catch(() => {});
  }

  // Trim recent_episodes.md if it exceeds 8000 chars
  const episodes = await readMemoryFile(userId, "recent_episodes");
  if (episodes.length > 8000) {
    const trimResult = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "Summarize the oldest entries in this care episode log into a brief paragraph. " +
        "Keep the most recent entries verbatim. Reply with only the revised markdown content.",
      messages: [{ role: "user", content: episodes }],
    });
    const trimmed = ((trimResult.content[0] as { text: string }).text ?? "").trim();
    if (trimmed) {
      await writeMemoryFile(userId, "recent_episodes", trimmed);

      // Keep Zep in sync with the trimmed version so context injection stays consistent.
      if (phone) {
        const zepUserId = phone.replace(/\D/g, "");
        const { addBusinessDataToZep } = await import("./zepClient");
        addBusinessDataToZep({
          userId: zepUserId,
          data: {
            event_type:   "recent_episodes_trimmed",
            content:      trimmed.slice(0, 800),
            timestamp:    new Date().toISOString(),
            data_source:  "cara_memory_trim",
          },
        }).catch(() => {});
      }
    }
  }
}
