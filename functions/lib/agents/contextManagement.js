"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_RESULT_OFFLOAD_THRESHOLD = exports.ROLLUP_TRIGGER = exports.HISTORY_WINDOW = void 0;
exports.maybeRollUpHistory = maybeRollUpHistory;
exports.buildToolResultContent = buildToolResultContent;
exports.patchDanglingToolCalls = patchDanglingToolCalls;
const admin = __importStar(require("firebase-admin"));
const openaiClient_1 = require("../utils/openaiClient");
const memoryFiles_1 = require("../memory/memoryFiles");
const db = admin.firestore();
// getConversationHistory loads only the most recent HISTORY_WINDOW messages, so
// anything older is lost unless folded into the summary row it reads back.
exports.HISTORY_WINDOW = 10; // recent messages kept verbatim
exports.ROLLUP_TRIGGER = 20; // start folding once live messages exceed this
// Fire this AFTER the user's reply is sent so it never adds latency, but still
// await it at the call site: Gen-1 functions throttle CPU once the HTTP response is
// sent, so un-awaited background work gets killed.
async function maybeRollUpHistory(phone) {
    var _a, _b, _c;
    try {
        const col = db.collection("agent_conversations").doc(phone).collection("messages");
        // Cheap aggregation gate — avoids reading every message on turns that don't need a rollup.
        const countSnap = await col.count().get();
        if (countSnap.data().count <= exports.ROLLUP_TRIGGER)
            return;
        const snap = await col.orderBy("timestamp", "asc").get();
        const nonSummary = snap.docs.filter((d) => d.data().role !== "summary");
        if (nonSummary.length <= exports.HISTORY_WINDOW)
            return;
        const summaryDocs = snap.docs.filter((d) => d.data().role === "summary");
        const existingSummary = (_a = summaryDocs[0]) === null || _a === void 0 ? void 0 : _a.data().content;
        // Fold everything except the most recent HISTORY_WINDOW messages.
        const toFold = nonSummary.slice(0, nonSummary.length - exports.HISTORY_WINDOW);
        if (toFold.length === 0)
            return;
        const transcript = toFold
            .map((d) => { var _a; return `${d.data().role === "user" ? "Family" : "Cara"}: ${String((_a = d.data().content) !== null && _a !== void 0 ? _a : "").slice(0, 500)}`; })
            .join("\n");
        const newSummary = await (0, openaiClient_1.quickComplete)("You maintain a running summary of an ongoing SMS conversation between a family and Cara, a " +
            "caregiving assistant. Merge the existing summary with the new messages into ONE concise summary " +
            "(max 200 words). Preserve durable facts, decisions, preferences, and open threads; drop " +
            "pleasantries. Write plain prose in the third person. Output only the summary.", `Existing summary:\n${existingSummary !== null && existingSummary !== void 0 ? existingSummary : "(none)"}\n\nNew messages:\n${transcript}`, { maxTokens: 350 });
        if (!newSummary || !newSummary.trim())
            return;
        // Upsert the single summary row and delete the folded messages so they are
        // neither double-counted nor re-summarized next time.
        const batch = db.batch();
        const summaryRef = (_c = (_b = summaryDocs[0]) === null || _b === void 0 ? void 0 : _b.ref) !== null && _c !== void 0 ? _c : col.doc();
        batch.set(summaryRef, { role: "summary", content: newSummary.trim(), timestamp: Date.now() });
        for (const d of toFold)
            batch.delete(d.ref);
        await batch.commit();
    }
    catch (err) {
        console.error("maybeRollUpHistory error:", err);
    }
}
// A few tools (invoice history, applicant lists, web fetches) return multi-KB
// payloads. Injecting the full blob into every subsequent loop iteration blows the
// token budget and slows the turn. Stash the full result in the user's memory VFS
// and hand Claude a preview + pointer it can read back on demand. Falls back to
// truncation if there's no userId or the write fails.
exports.TOOL_RESULT_OFFLOAD_THRESHOLD = 6000; // characters
async function buildToolResultContent(userId, toolName, result) {
    const full = JSON.stringify(result);
    if (full.length <= exports.TOOL_RESULT_OFFLOAD_THRESHOLD || !userId) {
        return full.length > exports.TOOL_RESULT_OFFLOAD_THRESHOLD ? full.slice(0, exports.TOOL_RESULT_OFFLOAD_THRESHOLD) : full;
    }
    const slug = `tool_${toolName}_${Date.now()}`.toLowerCase();
    try {
        await (0, memoryFiles_1.writeMemoryFile)(userId, slug, full);
        return JSON.stringify({
            _offloaded: true,
            file: slug,
            note: `Full result (${full.length} chars) saved to memory file "${slug}". ` +
                `Use read_memory_file with file="${slug}" or search_memory to retrieve specific details.`,
            preview: full.slice(0, 1200),
        });
    }
    catch (_a) {
        return full.slice(0, exports.TOOL_RESULT_OFFLOAD_THRESHOLD);
    }
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
function patchDanglingToolCalls(messages) {
    let patches = 0;
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role !== "assistant" || typeof msg.content === "string") {
            i++;
            continue;
        }
        // Collect tool_use blocks in this assistant message.
        const toolUses = [];
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
        const answered = new Set();
        if (next && next.role === "user" && Array.isArray(next.content)) {
            for (const block of next.content) {
                if (block.type === "tool_result")
                    answered.add(block.tool_use_id);
            }
        }
        const orphans = toolUses.filter((t) => !answered.has(t.id));
        if (orphans.length === 0) {
            i++;
            continue;
        }
        const placeholders = orphans.map(({ id, name }) => ({
            type: "tool_result",
            tool_use_id: id,
            content: `Tool call ${name} did not complete — likely a response-size or timeout cutoff. ` +
                "Tell the user briefly that you couldn't finish that step and offer to try again.",
            is_error: true,
        }));
        if (next && next.role === "user" && Array.isArray(next.content)) {
            next.content = [...next.content, ...placeholders];
        }
        else {
            messages.splice(i + 1, 0, { role: "user", content: placeholders });
        }
        patches += orphans.length;
        i++;
    }
    return patches;
}
//# sourceMappingURL=contextManagement.js.map