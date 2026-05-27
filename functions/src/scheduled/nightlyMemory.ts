import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import type Anthropic from "@anthropic-ai/sdk";
import { getSharedClient } from "../utils/claudeClient";
import { consolidateMemoryForUser } from "../memory/memoryFiles";
import { cleanupStaleExecutionAgents } from "../agents/executionAgent";

const db = admin.firestore();

// ── Conversation compression ──────────────────────────────────────────────────

async function compressConversationForPhone(phone: string): Promise<void> {
  const col = db.collection("agent_conversations").doc(phone).collection("messages");
  const allSnap = await col.orderBy("timestamp", "asc").get();

  const summaryDocs = allSnap.docs.filter(d => d.data().role === "summary");
  const realDocs    = allSnap.docs.filter(d => d.data().role !== "summary");

  // Compress earlier than the previous threshold (was 30) — qaAgent only loads
  // the 10 most-recent + 1 summary, so turns 11-30 had no fallback. Triggering
  // at 15 means active users get summary continuity within a couple of days.
  if (realDocs.length <= 15) return;

  const toCompress = realDocs.slice(0, realDocs.length - 10);
  if (toCompress.length < 5) return;

  const existingSummary = summaryDocs[0]?.data()?.content as string | undefined;
  const newMessages     = toCompress
    .map(d => `${d.data().role === "user" ? "User" : "Cara"}: ${d.data().content as string}`)
    .join("\n");

  const promptParts = existingSummary
    ? [`Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n${newMessages}`]
    : [`Conversation:\n${newMessages}`];

  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system:     "You are summarizing a caregiving conversation for an AI assistant named Cara. Write 3-5 sentences covering: care needs mentioned, decisions made, key facts about the senior, and emotional context. Be specific — include names, dates, and care details if present. Begin your response with \"<summary>\".",
    messages:   [{ role: "user", content: promptParts[0] }],
  });

  const summaryText = (response.content[0] as Anthropic.TextBlock).text;

  // Delete old summary and compressed messages, write new summary
  const firstRetained  = realDocs[realDocs.length - 10];
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
}

async function compressOldConversations(): Promise<void> {
  const convDocs = await db.collection("agent_conversations").listDocuments();
  for (const docRef of convDocs) {
    await compressConversationForPhone(docRef.id).catch(err =>
      console.error(`[compressOldConversations] ${docRef.id}:`, err)
    );
  }
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

// Runs nightly at 10 PM PT (06:00 UTC next day)
export const consolidateMemoryNightly = functions.pubsub
  .schedule("0 6 * * *")
  .onRun(async () => {
    // Find all active sessions updated in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db
      .collection("agent_sessions")
      .where("onboardingStep", "==", "complete")
      .where("optedOut", "==", false)
      .get();

    const users: Array<{ userId: string; phone: string }> = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.lastMessageAt && data.lastMessageAt >= sevenDaysAgo) {
        const userId = data.userId ?? doc.id;
        if (userId) users.push({ userId, phone: doc.id });
      }
    }

    console.log(`consolidateMemoryNightly: processing ${users.length} users`);

    for (const { userId, phone } of users) {
      await consolidateMemoryForUser(userId, phone).catch((err) =>
        console.error(`memory consolidation error for ${userId}:`, err)
      );
    }

    // Analyze booking patterns for proactive suggestions
    await analyzeBookingPatterns().catch(err =>
      console.error("[nightlyMemory] analyzeBookingPatterns error:", err)
    );

    // Compress conversations longer than 30 messages
    await compressOldConversations().catch(err =>
      console.error("[nightlyMemory] compressOldConversations error:", err)
    );

    // Auto-complete execution agents idle for >24 hours
    await cleanupStaleExecutionAgents().catch(err =>
      console.error("[nightlyMemory] cleanupStaleExecutionAgents error:", err)
    );
  });
