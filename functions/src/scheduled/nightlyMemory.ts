import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import type Anthropic from "@anthropic-ai/sdk";
import { getSharedClient } from "../utils/claudeClient";
import { consolidateMemoryForUser, cleanupExpiredTransientToolFiles } from "../memory/memoryFiles";
import { cleanupStaleExecutionAgents } from "../agents/executionAgent";

const db = admin.firestore();

// ── Conversation compression ──────────────────────────────────────────────────

// R9 (memory-grounding U3): a source row whose memory sync is unresolved
// (memorySyncStatus still set — the retry worker has not confirmed Zep/fact
// writes) must NOT be summarized or deleted; the worker reads canonical
// content from that row. Pending rows older than this bound are surfaced in
// the job's aggregate counts so a wedged worker is visible.
export const AGED_PENDING_SYNC_MS = 24 * 60 * 60 * 1000;

interface PhoneCompressionResult {
  compressed: number;
  /** Compress-eligible rows left in place because their memory sync is unresolved. */
  pendingBlocked: number;
  /** Unresolved rows older than AGED_PENDING_SYNC_MS (worker health signal). */
  agedPending: number;
}

async function compressConversationForPhone(phone: string): Promise<PhoneCompressionResult> {
  const col = db.collection("agent_conversations").doc(phone).collection("messages");
  const allSnap = await col.orderBy("timestamp", "asc").get();

  const summaryDocs = allSnap.docs.filter(d => d.data().role === "summary");
  const realDocs    = allSnap.docs.filter(d => d.data().role !== "summary");

  // R9 guard: compression stops at the FIRST row with unresolved sync — that
  // row and everything younger stay verbatim until the worker clears it.
  const hasPendingSync = (d: (typeof realDocs)[number]) => typeof d.data().memorySyncStatus === "string";
  const firstPendingIdx = realDocs.findIndex(hasPendingSync);
  const agedCutoff = Date.now() - AGED_PENDING_SYNC_MS;
  const agedPending = realDocs.filter(
    d => hasPendingSync(d) && Number(d.data().timestamp ?? Date.now()) < agedCutoff,
  ).length;

  // Compress earlier than the previous threshold (was 30) — qaAgent only loads
  // the 10 most-recent + 1 summary, so turns 11-30 had no fallback. Triggering
  // at 15 means active users get summary continuity within a couple of days.
  if (realDocs.length <= 15) return { compressed: 0, pendingBlocked: 0, agedPending };

  let toCompress = realDocs.slice(0, realDocs.length - 10);
  let pendingBlocked = 0;
  if (firstPendingIdx >= 0 && firstPendingIdx < toCompress.length) {
    pendingBlocked = toCompress.length - firstPendingIdx;
    toCompress = toCompress.slice(0, firstPendingIdx);
  }
  if (toCompress.length < 5) return { compressed: 0, pendingBlocked, agedPending };

  const existingSummary = summaryDocs[0]?.data()?.content as string | undefined;
  // R23/KTD16 (U4b): rows the correction/forget worker marked as containing a
  // corrected/forgotten fact are still deleted with the compressed window, but
  // their content NEVER enters the summary prompt — a compression summary must
  // not preserve a retired assertion in paraphrased form.
  const summarizable = toCompress.filter(d => !d.data().excludeFromMemoryConsolidationAt);
  const newMessages  = summarizable
    .map(d => `${d.data().role === "user" ? "User" : "Evia"}: ${d.data().content as string}`)
    .join("\n");

  let summaryText: string;
  if (!newMessages && existingSummary) {
    // Every compressible row was excluded — carry the prior summary forward
    // verbatim; there is nothing new the summarizer is allowed to see.
    summaryText = existingSummary;
  } else if (!newMessages) {
    // Nothing summarizable and no prior summary: leave the rows in place this
    // run rather than deleting content without any summary continuity.
    return { compressed: 0, pendingBlocked, agedPending };
  } else {
    const promptParts = existingSummary
      ? [`Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n${newMessages}`]
      : [`Conversation:\n${newMessages}`];

    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:     "You are summarizing a caregiving conversation for an AI assistant named Evia. Write 3-5 sentences covering: care needs mentioned, decisions made, key facts about the senior, and emotional context. Be specific — include names, dates, and care details if present. Record ONLY facts present in the conversation — never infer or invent. Preserve verbatim: people's names, dollar amounts, and any commitments or promises made. Begin your response with \"<summary>\".",
      messages:   [{ role: "user", content: promptParts[0] }],
    });

    summaryText = (response.content[0] as Anthropic.TextBlock).text;
  }

  // Delete old summary and compressed messages, write new summary. The summary
  // slots immediately before the first RETAINED row (which, when the pending
  // guard truncated the window, is the first still-unsynced row).
  const firstRetained  = realDocs[toCompress.length];
  const summaryTimestamp = (firstRetained.data().timestamp as number) - 1;

  // Firebase batches are capped at 500 ops — chunk deletes if needed
  const toDelete = [...summaryDocs, ...toCompress];
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db.batch();
    for (const doc of toDelete.slice(i, i + 400)) batch.delete(doc.ref);
    if (i === 0) batch.set(col.doc(), { role: "summary", content: summaryText, timestamp: summaryTimestamp });
    await batch.commit();
  }

  console.log(`[compressConversation] Compressed ${toCompress.length} messages for ${phone}`);
  return { compressed: toCompress.length, pendingBlocked, agedPending };
}

export interface CompressionCounts {
  conversations: number;
  compressedMessages: number;
  skippedPendingSync: number;
  agedPendingRows: number;
  failed: number;
}

export async function compressOldConversations(): Promise<CompressionCounts> {
  const counts: CompressionCounts = {
    conversations: 0, compressedMessages: 0, skippedPendingSync: 0, agedPendingRows: 0, failed: 0,
  };
  const convDocs = await db.collection("agent_conversations").listDocuments();
  for (const docRef of convDocs) {
    counts.conversations++;
    try {
      const r = await compressConversationForPhone(docRef.id);
      counts.compressedMessages += r.compressed;
      counts.skippedPendingSync += r.pendingBlocked;
      counts.agedPendingRows += r.agedPending;
    } catch (err) {
      counts.failed++;
      console.error(`[compressOldConversations] ${docRef.id}:`, err);
    }
  }
  return counts;
}

// ── Booking pattern analysis ──────────────────────────────────────────────────

export async function analyzeBookingPatterns(): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Get all clients with completed appointments in the last 30 days
  const apptSnap = await db.collection("appointments")
    .where("status", "==", "completed")
    .where("date",   ">=", thirtyDaysAgo)
    .get();

  if (apptSnap.empty) return;

  // Group by clientId
  const byClient: Record<string, { day: number; status: string }[]> = {};
  for (const doc of apptSnap.docs) {
    const d = doc.data();
    const clientId = d.clientId as string;
    if (!clientId || !d.date) continue;
    const dayOfWeek = new Date(d.date).getUTCDay();
    if (!byClient[clientId]) byClient[clientId] = [];
    byClient[clientId].push({ day: dayOfWeek, status: d.status });
  }

  // Also get cancelled appointments in the same window
  const cancelSnap = await db.collection("appointments")
    .where("status", "in", ["cancelled_by_client", "cancelled"])
    .where("date",   ">=", thirtyDaysAgo)
    .get();

  for (const doc of cancelSnap.docs) {
    const d = doc.data();
    const clientId = d.clientId as string;
    if (!clientId || !d.date) continue;
    const dayOfWeek = new Date(d.date).getUTCDay();
    if (!byClient[clientId]) byClient[clientId] = [];
    byClient[clientId].push({ day: dayOfWeek, status: "cancelled" });
  }

  const db2 = admin.firestore();
  const batch = db2.batch();

  for (const [clientId, events] of Object.entries(byClient)) {
    // Count by day
    const dayStats: Record<number, { completed: number; cancelled: number }> = {};
    for (const e of events) {
      if (!dayStats[e.day]) dayStats[e.day] = { completed: 0, cancelled: 0 };
      if (e.status === "completed") dayStats[e.day].completed++;
      else dayStats[e.day].cancelled++;
    }

    for (const [dayStr, stats] of Object.entries(dayStats)) {
      const day = parseInt(dayStr);
      const total = stats.completed + stats.cancelled;
      const cancelRate = total > 0 ? stats.cancelled / total : 0;
      const ref = db2.collection("booking_patterns").doc(clientId).collection("day_patterns").doc(String(day));
      batch.set(ref, { day, completedCount: stats.completed, cancelledCount: stats.cancelled, cancelRate, updatedAt: new Date().toISOString() }, { merge: true });
    }
  }

  await batch.commit().catch(err => console.error("[analyzeBookingPatterns] batch error:", err));
  console.log(`[analyzeBookingPatterns] Updated patterns for ${Object.keys(byClient).length} clients`);
}

// ── Nightly family-memory consolidation (memory-grounding U2, R2/R4/KTD3) ────
//
// Selection is a server-side indexed query (agent_sessions composite index:
// onboardingStep ASC, optedOut ASC, userType ASC, lastMessageAt DESC — see
// firestore.indexes.json). Client-only by construction: caregiver sessions can
// never enter the family-memory prompt because userType == "client" is an
// equality filter, not a post-hoc JS check. The lastMessageAt cutoff is a
// Firestore Timestamp compared to the Timestamp the ingress seams write
// (conversationMemory.sessionActivityFields) — never an ISO string.

export const NIGHTLY_MEMORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_PAGE_SIZE = 100;
const CONSOLIDATION_CONCURRENCY = 4;

export interface NightlyMemoryCounts {
  eligible: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Paginated (document cursor), bounded-concurrency consolidation over recently
 * active completed opted-in CLIENT sessions. Per-user failures never abort the
 * batch (R4). Returns aggregate counts only — logs carry no IDs and no content
 * (R21).
 */
export async function runNightlyMemoryConsolidation(): Promise<NightlyMemoryCounts> {
  const counts: NightlyMemoryCounts = { eligible: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - NIGHTLY_MEMORY_WINDOW_MS);
  const processed = new Set<string>(); // paging-duplicate guard: one attempt per session doc

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = db
      .collection("agent_sessions")
      .where("onboardingStep", "==", "complete")
      .where("optedOut", "==", false)
      .where("userType", "==", "client")
      .where("lastMessageAt", ">=", cutoff)
      .orderBy("lastMessageAt", "desc")
      .limit(SESSION_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;
    counts.eligible += page.docs.length;

    const targets: Array<{ userId: string; phone: string }> = [];
    for (const doc of page.docs) {
      const userId = (doc.data().userId as string | undefined) ?? doc.id;
      if (!userId || processed.has(doc.id)) {
        counts.skipped++;
        continue;
      }
      processed.add(doc.id);
      targets.push({ userId, phone: doc.id });
    }

    for (let i = 0; i < targets.length; i += CONSOLIDATION_CONCURRENCY) {
      const chunk = targets.slice(i, i + CONSOLIDATION_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ userId, phone }) => {
          counts.attempted++;
          try {
            await consolidateMemoryForUser(userId, phone);
            counts.succeeded++;
          } catch (err) {
            // R21: sanitized error class only — no userId/phone, no message
            // text (provider errors can echo prompt content).
            counts.failed++;
            console.error("[consolidateMemoryNightly] consolidation failure", {
              errorClass: (err as Error)?.name ?? "Error",
            });
          }
        }),
      );
    }

    if (page.docs.length < SESSION_PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }

  return counts;
}

/**
 * Full nightly job body, exported for tests. The memory batch is isolated so a
 * total selection/consolidation failure still runs the existing housekeeping
 * tasks (booking patterns, conversation compression, execution-agent cleanup).
 */
export async function runNightlyMemoryJob(): Promise<void> {
  try {
    const counts = await runNightlyMemoryConsolidation();
    // Aggregate-only scheduler log (R21): counts and nothing else.
    console.log("[consolidateMemoryNightly] memory batch", counts);
  } catch (err) {
    console.error("[consolidateMemoryNightly] memory batch aborted", {
      errorClass: (err as Error)?.name ?? "Error",
    });
  }

  // Analyze booking patterns for proactive suggestions
  await analyzeBookingPatterns().catch(err =>
    console.error("[nightlyMemory] analyzeBookingPatterns error:", err)
  );

  // Compress conversations longer than 15 messages. Aggregate-only log (R21):
  // counts, no phones — agedPendingRows > 0 means the memory-operation worker
  // is leaving source rows unresolved past its expected horizon (R9).
  const compression = await compressOldConversations().catch(err => {
    console.error("[nightlyMemory] compressOldConversations error:", err);
    return null;
  });
  if (compression) console.log("[nightlyMemory] compression", compression);

  // R20/KTD14 (U8): delete expired transient tool-result offloads and their
  // embeddings. Aggregate-only log (R21): scanned/retained/deleted/malformed/
  // failed counts — no user IDs, no slugs. Isolated so a Storage failure never
  // blocks the remaining housekeeping.
  const transientCleanup = await cleanupExpiredTransientToolFiles().catch(err => {
    console.error("[nightlyMemory] cleanupExpiredTransientToolFiles error:", {
      errorClass: (err as Error)?.name ?? "Error",
    });
    return null;
  });
  if (transientCleanup) console.log("[nightlyMemory] transient tool-file cleanup", transientCleanup);

  // Auto-complete execution agents idle for >24 hours
  await cleanupStaleExecutionAgents().catch(err =>
    console.error("[nightlyMemory] cleanupStaleExecutionAgents error:", err)
  );
}

// Runs nightly at 10 PM PT (06:00 UTC next day)
export const consolidateMemoryNightly = functions.pubsub
  .schedule("0 6 * * *")
  .onRun(async () => {
    await runNightlyMemoryJob();
  });
