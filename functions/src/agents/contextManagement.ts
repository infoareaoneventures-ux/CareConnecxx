// Automatic context management for the QA agent.
//
// Three concerns:
//   1. maybeRollUpHistory  — fold turns older than the recent window into one
//      evolving "summary" row so long conversations stay coherent.
//   2. buildToolResultContent — offload oversized tool payloads to the memory VFS
//      and hand Claude a preview + pointer instead of the full blob.
//   3. patchDanglingToolCalls — defensive safety net that injects placeholder
//      tool_result blocks for any unanswered tool_use blocks in the message
//      array. Ported from LangChain deepagents' PatchToolCallsMiddleware.
//
// LLM-backed work uses gpt-4o-mini (quickComplete) per the fast-path rule in
// CLAUDE.md — the Claude QA client is reserved for the multi-turn tool loop.

import type Anthropic from "@anthropic-ai/sdk";
import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { writeMemoryFile } from "../memory/memoryFiles";

const db = admin.firestore();

// getConversationHistory loads only the most recent HISTORY_WINDOW messages, so
// anything older is lost unless folded into the summary row it reads back.
export const HISTORY_WINDOW = 24;  // recent messages kept verbatim
export const ROLLUP_TRIGGER = 30;  // start folding once live messages exceed this

// Fire this AFTER the user's reply is sent so it never adds latency, but still
// await it at the call site: Gen-1 functions throttle CPU once the HTTP response is
// sent, so un-awaited background work gets killed.
//
// Returns whether a rollup actually happened (messages were folded into the
// summary row) so callers can record `historyRolledUp` telemetry — false for
// every early-return (below trigger, nothing to fold, empty/failed summary).
export async function maybeRollUpHistory(phone: string): Promise<boolean> {
  try {
    const col = db.collection("agent_conversations").doc(phone).collection("messages");

    // Cheap aggregation gate — avoids reading every message on turns that don't need a rollup.
    const countSnap = await col.count().get();
    if (countSnap.data().count <= ROLLUP_TRIGGER) return false;

    const snap       = await col.orderBy("timestamp", "asc").get();
    const nonSummary = snap.docs.filter((d) => d.data().role !== "summary");
    if (nonSummary.length <= HISTORY_WINDOW) return false;

    const summaryDocs     = snap.docs.filter((d) => d.data().role === "summary");
    const existingSummary = summaryDocs[0]?.data().content as string | undefined;

    // Fold everything except the most recent HISTORY_WINDOW messages.
    const toFold = nonSummary.slice(0, nonSummary.length - HISTORY_WINDOW);
    if (toFold.length === 0) return false;

    const transcript = toFold
      .map((d) => `${d.data().role === "user" ? "Family" : "Cara"}: ${String(d.data().content ?? "").slice(0, 500)}`)
      .join("\n");

    const newSummary = await quickComplete(
      "You maintain a running summary of an ongoing SMS conversation between a family and Cara, a " +
        "caregiving assistant. Merge the existing summary with the new messages into ONE concise summary " +
        "(max 200 words). Preserve durable facts, decisions, preferences, and open threads; drop " +
        "pleasantries. Write plain prose in the third person. Output only the summary.",
      `Existing summary:\n${existingSummary ?? "(none)"}\n\nNew messages:\n${transcript}`,
      { maxTokens: 350 },
    );
    if (!newSummary || !newSummary.trim()) return false;

    // Upsert the single summary row and delete the folded messages so they are
    // neither double-counted nor re-summarized next time.
    const batch      = db.batch();
    const summaryRef = summaryDocs[0]?.ref ?? col.doc();
    batch.set(summaryRef, { role: "summary", content: newSummary.trim(), timestamp: Date.now() });
    for (const d of toFold) batch.delete(d.ref);
    await batch.commit();
    return true;
  } catch (err) {
    console.error("maybeRollUpHistory error:", err);
    return false;
  }
}

// A few tools (invoice history, applicant lists, web fetches) return multi-KB
// payloads. Injecting the full blob into every subsequent loop iteration blows the
// token budget and slows the turn. Stash the full result in the user's memory VFS
// and hand Claude a preview + pointer it can read back on demand. Falls back to
// truncation if there's no userId or the write fails.
export const TOOL_RESULT_OFFLOAD_THRESHOLD = 6000; // characters

export async function buildToolResultContent(
  userId: string | undefined,
  toolName: string,
  result: unknown,
): Promise<string> {
  const full = JSON.stringify(result);
  if (full.length <= TOOL_RESULT_OFFLOAD_THRESHOLD || !userId) {
    return full.length > TOOL_RESULT_OFFLOAD_THRESHOLD ? full.slice(0, TOOL_RESULT_OFFLOAD_THRESHOLD) : full;
  }

  const slug = `tool_${toolName}_${Date.now()}`.toLowerCase();
  try {
    await writeMemoryFile(userId, slug, full);
    return JSON.stringify({
      _offloaded: true,
      file:    slug,
      note:    `Full result (${full.length} chars) saved to memory file "${slug}". ` +
               `Use read_memory_file with file="${slug}" or search_memory to retrieve specific details.`,
      preview: full.slice(0, 1200),
    });
  } catch {
    return full.slice(0, TOOL_RESULT_OFFLOAD_THRESHOLD);
  }
}

// Truncate `input` payloads on tool_use blocks in older assistant messages.
//
// During long tool-use loops Claude's `input` arguments (e.g. care plan diffs,
// booking JSON, web action descriptions) stay in the prompt forever. Once the
// turn has moved on, the tool's RESULT is what matters; the original args
// just inflate the prompt and slow every subsequent iteration.
//
// This mirrors deepagents' `TruncateArgsSettings` pre-pass — a cheap step
// before the full summarization rollup that often defers a rollup entirely.
//
// We only touch messages older than `keepLast` (default 8) so the most recent
// tool calls — where Claude may still be reasoning about its own args — stay
// intact. The matching `tool_result` blocks are untouched; result content is
// already capped by `buildToolResultContent`.
//
// Mutates `messages` in place. Returns the number of tool_use args truncated.
//
// Pattern source: third_party/deepagents/libs/deepagents/deepagents/middleware/summarization.py
export function truncateOldToolCallArgs(
  messages: Anthropic.MessageParam[],
  keepLast = 8,
  maxArgLen = 500,
): number {
  let truncated = 0;
  const cutoff  = Math.max(0, messages.length - keepLast);

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;

    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;

      // Already truncated on a prior pass — skip so the count doesn't grow.
      const existing = block.input as { _truncated?: boolean } | null;
      if (existing && existing._truncated === true) continue;

      const argsStr = JSON.stringify(block.input ?? {});
      if (argsStr.length <= maxArgLen) continue;

      block.input = {
        _truncated: true,
        preview:    argsStr.slice(0, maxArgLen) + "...",
      };
      truncated++;
    }
  }
  return truncated;
}

// Defensive safety net for orphan tool_use blocks.
//
// Anthropic's API rejects a request when an assistant message contains a
// tool_use block that isn't answered by a matching tool_result in the next
// user message. Our happy path always pushes both atomically, so this is
// usually a no-op — but it catches two real scenarios:
//   1. `stop_reason: "max_tokens"` mid-tool-call: Claude emitted a partial
//      tool_use block whose `input` JSON is truncated. We can't safely execute
//      it; pushing a placeholder tool_result lets the next turn recover with
//      a text-only reply.
//   2. Future history-persistence changes: if we ever start storing assistant
//      tool_use / tool_result blocks across turns (today our history is
//      text-only), an interrupted Cloud Functions execution could leave a
//      dangling tool_use in persisted state. This function makes that safe.
//
// Mutates `messages` in place. Returns the number of placeholders inserted —
// non-zero values are worth logging so we can spot the bug or condition that
// produced them.
//
// Pattern source: third_party/deepagents/libs/deepagents/deepagents/middleware/patch_tool_calls.py
export function patchDanglingToolCalls(messages: Anthropic.MessageParam[]): number {
  let patches = 0;
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== "assistant" || typeof msg.content === "string") {
      i++;
      continue;
    }

    // Collect tool_use blocks in this assistant message.
    const toolUses: Array<{ id: string; name: string }> = [];
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolUses.push({ id: block.id, name: block.name });
      }
    }
    if (toolUses.length === 0) {
      i++;
      continue;
    }

    // Look at the immediately following message for tool_result blocks.
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block.type === "tool_result") answered.add(block.tool_use_id);
      }
    }

    const orphans = toolUses.filter((t) => !answered.has(t.id));
    if (orphans.length === 0) {
      i++;
      continue;
    }

    const placeholders: Anthropic.ToolResultBlockParam[] = orphans.map(({ id, name }) => ({
      type: "tool_result",
      tool_use_id: id,
      content:
        `Tool call ${name} did not complete — likely a response-size or timeout cutoff. ` +
        "Tell the user briefly that you couldn't finish that step and offer to try again.",
      is_error: true,
    }));

    if (next && next.role === "user" && Array.isArray(next.content)) {
      next.content = [...next.content, ...placeholders];
    } else {
      messages.splice(i + 1, 0, { role: "user", content: placeholders });
    }

    patches += orphans.length;
    i++;
  }
  return patches;
}
