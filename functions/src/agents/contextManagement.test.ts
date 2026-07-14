import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Firestore stand-in for one conversation's messages subcollection ────────────
const hoisted = vi.hoisted(() => {
  // Each message: { id, role, content, timestamp }
  let docs: Array<{ id: string; role: string; content: string; timestamp: number }> = [];
  let autoId = 0;
  const committed: Array<{ type: "set" | "delete"; id: string; data?: any }> = [];

  const makeDocRef = (id: string) => ({
    id,
    set: vi.fn(),
    delete: vi.fn(),
  });

  const col = {
    doc: vi.fn(() => makeDocRef(`auto-${autoId++}`)),
    count: vi.fn(() => ({ get: async () => ({ data: () => ({ count: docs.length }) }) })),
    orderBy: vi.fn(() => ({
      get: async () => ({
        docs: [...docs]
          .sort((a, b) => a.timestamp - b.timestamp)
          .map((d) => ({
            id: d.id,
            ref: makeDocRef(d.id),
            data: () => ({ role: d.role, content: d.content, timestamp: d.timestamp }),
          })),
      }),
    })),
  };

  const batch = {
    set: vi.fn((ref: any, data: any) => committed.push({ type: "set", id: ref.id, data })),
    delete: vi.fn((ref: any) => committed.push({ type: "delete", id: ref.id })),
    commit: vi.fn(async () => {
      // Apply deletes + summary upsert to the in-memory store so assertions can inspect state.
      for (const op of committed) {
        if (op.type === "delete") docs = docs.filter((d) => d.id !== op.id);
        if (op.type === "set") {
          docs = docs.filter((d) => d.id !== op.id);
          docs.push({ id: op.id, ...op.data });
        }
      }
    }),
  };

  const firestore = () => ({
    collection: () => ({ doc: () => ({ collection: () => col }) }),
    batch: () => batch,
  });

  const quickCompleteMock = vi.fn(async () => "Family discussed Mom's medication schedule and prefers morning visits.");
  const writeMemoryFileMock = vi.fn(async () => {});

  return {
    firestore,
    committed,
    quickCompleteMock,
    writeMemoryFileMock,
    seed: (msgs: Array<{ role: string; content: string; timestamp: number }>) => {
      docs = msgs.map((m, i) => ({ id: `m${i}`, ...m }));
      autoId = 0;
      committed.length = 0;
    },
    snapshot: () => docs,
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

vi.mock("../utils/openaiClient", () => ({ quickComplete: hoisted.quickCompleteMock }));
vi.mock("../memory/memoryFiles", () => ({ writeMemoryFile: hoisted.writeMemoryFileMock }));

const quickCompleteMock = hoisted.quickCompleteMock;
const writeMemoryFileMock = hoisted.writeMemoryFileMock;

import {
  maybeRollUpHistory,
  buildToolResultContent,
  patchDanglingToolCalls,
  truncateOldToolCallArgs,
  HISTORY_WINDOW,
  ROLLUP_TRIGGER,
  TOOL_RESULT_OFFLOAD_THRESHOLD,
} from "./contextManagement";
import type Anthropic from "@anthropic-ai/sdk";

const makeMsgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: 1000 + i,
  }));

beforeEach(() => {
  quickCompleteMock.mockClear();
  writeMemoryFileMock.mockClear();
});

describe("maybeRollUpHistory", () => {
  it("does nothing when message count is at or below the trigger", async () => {
    hoisted.seed(makeMsgs(ROLLUP_TRIGGER));
    await maybeRollUpHistory("+15550001111");
    expect(quickCompleteMock).not.toHaveBeenCalled();
    expect(hoisted.snapshot()).toHaveLength(ROLLUP_TRIGGER);
  });

  it("folds old messages into a summary row and keeps the recent window", async () => {
    hoisted.seed(makeMsgs(ROLLUP_TRIGGER + 6)); // 26 messages
    await maybeRollUpHistory("+15550001111");

    expect(quickCompleteMock).toHaveBeenCalledTimes(1);
    const after = hoisted.snapshot();
    const summaries = after.filter((d) => d.role === "summary");
    const live = after.filter((d) => d.role !== "summary");

    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain("medication");
    expect(live).toHaveLength(HISTORY_WINDOW); // only the recent window survives
  });

  it("merges an existing summary instead of creating a second one", async () => {
    const msgs = makeMsgs(ROLLUP_TRIGGER + 4);
    msgs.unshift({ role: "summary", content: "Earlier: family onboarded.", timestamp: 1 });
    hoisted.seed(msgs);
    await maybeRollUpHistory("+15550001111");

    const call = quickCompleteMock.mock.calls[0] as unknown as [string, string];
    expect(call[1]).toContain("Earlier: family onboarded."); // existing summary passed in
    expect(hoisted.snapshot().filter((d) => d.role === "summary")).toHaveLength(1);
  });

  // U3 (memory expansion): pins the widened window/trigger explicitly, on top
  // of the symbolic ROLLUP_TRIGGER/HISTORY_WINDOW assertions above, so a future
  // accidental revert of either constant fails loudly with the literal values.
  it("keeps 24 verbatim messages and fires the rollup once the count exceeds 30", async () => {
    expect(HISTORY_WINDOW).toBe(24);
    expect(ROLLUP_TRIGGER).toBe(30);

    // ROLLUP_TRIGGER (30) is an exclusive floor — the gate is count > TRIGGER —
    // so 31 messages is the smallest pool that actually fires the rollup.
    hoisted.seed(makeMsgs(31));
    await maybeRollUpHistory("+15550001111");

    expect(quickCompleteMock).toHaveBeenCalledTimes(1);
    const live = hoisted.snapshot().filter((d) => d.role !== "summary");
    expect(live).toHaveLength(24);
  });

  it("does not fire the rollup at exactly 30 messages (trigger is exclusive)", async () => {
    hoisted.seed(makeMsgs(ROLLUP_TRIGGER)); // 30 — at, not above, the trigger
    await maybeRollUpHistory("+15550001111");
    expect(quickCompleteMock).not.toHaveBeenCalled();
  });

  it("returns true when a rollup actually folds messages, false otherwise", async () => {
    hoisted.seed(makeMsgs(ROLLUP_TRIGGER)); // at trigger — no-op
    await expect(maybeRollUpHistory("+15550001111")).resolves.toBe(false);

    hoisted.seed(makeMsgs(ROLLUP_TRIGGER + 6)); // above trigger — folds
    await expect(maybeRollUpHistory("+15550001111")).resolves.toBe(true);
  });

  it("returns false (not throw) when the summarizer produces empty output", async () => {
    quickCompleteMock.mockResolvedValueOnce("   "); // blank/whitespace-only summary
    hoisted.seed(makeMsgs(ROLLUP_TRIGGER + 6));
    await expect(maybeRollUpHistory("+15550001111")).resolves.toBe(false);
    // Nothing was folded — original messages remain untouched.
    expect(hoisted.snapshot().filter((d) => d.role !== "summary")).toHaveLength(ROLLUP_TRIGGER + 6);
  });

  it("still sanitizes/folds a conversation containing an empty-content message (2026-06-29 regression)", async () => {
    // Regression guard: an empty-content message (e.g. a dropped/blank turn)
    // must not break the transcript join or the fold — String(content ?? "")
    // at the transcript-building step must handle it gracefully.
    const msgs = makeMsgs(ROLLUP_TRIGGER + 6);
    msgs[3] = { ...msgs[3], content: "" };
    (msgs[7] as any).content = undefined;
    hoisted.seed(msgs);

    await expect(maybeRollUpHistory("+15550001111")).resolves.toBe(true);
    expect(quickCompleteMock).toHaveBeenCalledTimes(1);
    const live = hoisted.snapshot().filter((d) => d.role !== "summary");
    expect(live).toHaveLength(HISTORY_WINDOW);
  });

  it("preserves summary content beyond 1200 chars, up to the new 3000-char clamp", async () => {
    // maybeRollUpHistory itself doesn't clamp (that's qaAgent's
    // sanitizePromptContext read-back clamp, raised 1200→3000) — this pins that
    // a long summarizer response survives the rollup write path untruncated,
    // so the larger downstream clamp actually has something to preserve.
    const longSummary = "Family discussed Mom's care plan in detail. ".repeat(60); // ~2700 chars
    expect(longSummary.length).toBeGreaterThan(1200);
    expect(longSummary.length).toBeLessThanOrEqual(3000);
    quickCompleteMock.mockResolvedValueOnce(longSummary);

    hoisted.seed(makeMsgs(ROLLUP_TRIGGER + 6));
    await maybeRollUpHistory("+15550001111");

    const summaries = hoisted.snapshot().filter((d) => d.role === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content.length).toBeGreaterThan(1200);
    expect(summaries[0].content).toBe(longSummary.trim());
  });
});

describe("buildToolResultContent", () => {
  it("passes small results through untouched", async () => {
    const result = { ok: true, items: [1, 2, 3] };
    const out = await buildToolResultContent("user1", "get_x", result);
    expect(out).toBe(JSON.stringify(result));
    expect(writeMemoryFileMock).not.toHaveBeenCalled();
  });

  it("offloads large results to the VFS and returns a preview + pointer", async () => {
    const big = { rows: "x".repeat(TOOL_RESULT_OFFLOAD_THRESHOLD + 100) };
    const out = await buildToolResultContent("user1", "get_invoice_history", big);
    const parsed = JSON.parse(out);

    expect(writeMemoryFileMock).toHaveBeenCalledTimes(1);
    expect(parsed._offloaded).toBe(true);
    expect(parsed.file).toMatch(/^tool_get_invoice_history_/);
    expect(parsed.preview.length).toBeLessThanOrEqual(1200);
    expect(parsed.note).toContain("read_memory_file");
  });

  it("truncates instead of offloading when there is no userId", async () => {
    const big = { rows: "y".repeat(TOOL_RESULT_OFFLOAD_THRESHOLD + 100) };
    const out = await buildToolResultContent(undefined, "get_x", big);
    expect(writeMemoryFileMock).not.toHaveBeenCalled();
    expect(out.length).toBe(TOOL_RESULT_OFFLOAD_THRESHOLD);
  });

  it("falls back to truncation if the VFS write fails", async () => {
    writeMemoryFileMock.mockRejectedValueOnce(new Error("storage down"));
    const big = { rows: "z".repeat(TOOL_RESULT_OFFLOAD_THRESHOLD + 100) };
    const out = await buildToolResultContent("user1", "get_x", big);
    // Fallback hard-truncates the raw JSON to the budget; Claude reads tool results as
    // text, so a truncated (non-parseable) blob is acceptable for this rare failure path.
    expect(out.length).toBe(TOOL_RESULT_OFFLOAD_THRESHOLD);
    expect(out).toContain("zzzz");
  });
});

describe("patchDanglingToolCalls", () => {
  const toolUse = (id: string, name: string): Anthropic.ToolUseBlockParam => ({
    type: "tool_use",
    id,
    name,
    input: {},
  });
  const toolResult = (id: string, content = "ok"): Anthropic.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: id,
    content,
  });
  const text = (s: string): Anthropic.TextBlockParam => ({ type: "text", text: s });

  it("is a no-op when every tool_use is answered", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [text("looking"), toolUse("call_1", "get_x")] },
      { role: "user", content: [toolResult("call_1", "found it")] },
      { role: "assistant", content: "done" },
    ];
    const before = JSON.stringify(messages);
    const patches = patchDanglingToolCalls(messages);
    expect(patches).toBe(0);
    expect(JSON.stringify(messages)).toBe(before); // unchanged
  });

  it("is a no-op when messages contain no tool_use blocks", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: [text("more")] },
    ];
    expect(patchDanglingToolCalls(messages)).toBe(0);
  });

  it("inserts a placeholder when the assistant tool_use has no following user message", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "find caregivers" },
      { role: "assistant", content: [toolUse("call_1", "find_replacement_caregivers")] },
    ];
    const patches = patchDanglingToolCalls(messages);
    expect(patches).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("user");
    const blocks = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_1");
    expect((blocks[0] as any).is_error).toBe(true);
    expect(String(blocks[0].content)).toContain("find_replacement_caregivers");
  });

  it("appends placeholders to an existing user-message array when some tool_uses are unanswered", () => {
    // Realistic max_tokens-mid-tool-call scenario: the assistant emitted two
    // tool_use blocks but only one was paired with a tool_result before the
    // cutoff. The unanswered one needs a placeholder; the answered one is left alone.
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "do two things" },
      { role: "assistant", content: [toolUse("call_1", "get_x"), toolUse("call_2", "get_y")] },
      { role: "user", content: [toolResult("call_1", "x done")] },
    ];
    const patches = patchDanglingToolCalls(messages);
    expect(patches).toBe(1);
    expect(messages).toHaveLength(3); // still 3 — appended into existing user message
    const blocks = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tool_use_id).toBe("call_1");
    expect(blocks[0].content).toBe("x done");
    expect(blocks[1].tool_use_id).toBe("call_2");
    expect((blocks[1] as any).is_error).toBe(true);
  });

  it("inserts a fresh user message when the next message is a string-content user message", () => {
    // Edge case: next message is user but not array-typed (e.g., a follow-up
    // user reply persisted as plain text). Can't append; must insert a new one.
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [toolUse("call_1", "get_x")] },
      { role: "user", content: "follow up question" },
    ];
    const patches = patchDanglingToolCalls(messages);
    expect(patches).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("user");
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(messages[2].content).toBe("follow up question"); // original preserved, just shifted
  });

  it("patches multiple separate assistant turns in one pass", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [toolUse("call_1", "get_x")] },
      // gap — call_1 never answered
      { role: "assistant", content: [toolUse("call_2", "get_y")] },
      // gap — call_2 never answered
    ];
    const patches = patchDanglingToolCalls(messages);
    expect(patches).toBe(2);
    // Each orphan assistant should now be followed by a placeholder user message.
    expect(messages).toHaveLength(5);
    expect((messages[2].content as any[])[0].tool_use_id).toBe("call_1");
    expect((messages[4].content as any[])[0].tool_use_id).toBe("call_2");
  });

  it("does not double-patch when called twice", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [toolUse("call_1", "get_x")] },
    ];
    const first = patchDanglingToolCalls(messages);
    const second = patchDanglingToolCalls(messages);
    expect(first).toBe(1);
    expect(second).toBe(0); // idempotent: second pass finds the placeholder
    expect(messages).toHaveLength(2);
  });
});

describe("truncateOldToolCallArgs", () => {
  const bigInput = (tag: string) => ({
    note:    `${tag}-` + "x".repeat(400),
    payload: { rows: Array.from({ length: 30 }, (_, i) => ({ i, v: `row-${tag}-${i}` })) },
  });
  const smallInput = (tag: string) => ({ tag });

  const tu = (id: string, name: string, input: unknown): Anthropic.ToolUseBlockParam => ({
    type: "tool_use",
    id,
    name,
    input: input as any,
  });
  const tr = (id: string, content = "ok"): Anthropic.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: id,
    content,
  });

  it("leaves all messages untouched when none have oversized tool_use args", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [tu("c1", "get_x", smallInput("a"))] },
      { role: "user", content: [tr("c1")] },
    ];
    const before = JSON.stringify(messages);
    const count  = truncateOldToolCallArgs(messages);
    expect(count).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("truncates oversized args in older messages and preserves the last keepLast", () => {
    // 16 messages — keepLast default 8 — so the first 8 are clip candidates.
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: [tu(`old-${i}`, "get_x", bigInput(`old${i}`))] });
    }
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: [tu(`new-${i}`, "get_y", bigInput(`new${i}`))] });
    }

    const count = truncateOldToolCallArgs(messages);
    expect(count).toBe(8); // exactly the 8 older tool_use blocks

    // Older messages: input replaced with {_truncated:true, preview}
    for (let i = 0; i < 8; i++) {
      const block = (messages[i].content as Anthropic.ToolUseBlockParam[])[0];
      expect((block.input as any)._truncated).toBe(true);
      expect((block.input as any).preview).toMatch(/\.\.\.$/);
      expect((block.input as any).preview.length).toBeLessThanOrEqual(510);
    }

    // Newer messages: original input intact
    for (let i = 8; i < 16; i++) {
      const block = (messages[i].content as Anthropic.ToolUseBlockParam[])[0];
      expect((block.input as any)._truncated).toBeUndefined();
      expect((block.input as any).note).toContain("x".repeat(300));
    }
  });

  it("does not touch tool_result blocks or assistant text", () => {
    // Mix of tool_use + tool_result + text in older messages. Only tool_use input gets clipped.
    // keepLast default is 8, so 8 padding messages after this one keep it out of the protected window.
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [
        { type: "text", text: "looking that up — " + "y".repeat(400) },
        tu("c1", "get_x", bigInput("c1")),
      ] },
      { role: "user", content: [tr("c1", "z".repeat(500))] },
      ...Array.from({ length: 8 }, (_, i) => (
        { role: "user", content: `pad ${i}` } as Anthropic.MessageParam
      )),
    ];

    const count = truncateOldToolCallArgs(messages);
    expect(count).toBe(1); // only the tool_use block

    // Text untouched
    const blocks = messages[0].content as any[];
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text.length).toBeGreaterThan(400);

    // tool_result untouched
    const tr_blocks = messages[1].content as Anthropic.ToolResultBlockParam[];
    expect(String(tr_blocks[0].content)).toContain("zzz");
  });

  it("is idempotent — re-running does not double-clip already-truncated args", () => {
    // keepLast default is 8, so 8 padding messages after this one keep it out of the protected window.
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [tu("c1", "get_x", bigInput("a"))] },
      ...Array.from({ length: 8 }, (_, i) => (
        { role: "user", content: `pad ${i}` } as Anthropic.MessageParam
      )),
    ];

    const first  = truncateOldToolCallArgs(messages);
    const second = truncateOldToolCallArgs(messages);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("respects custom keepLast and maxArgLen", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: [tu("c1", "get_x", { note: "short" })] }, // 16 chars — should clip at maxArgLen=10
      { role: "assistant", content: [tu("c2", "get_x", { note: "short" })] }, // protected by keepLast=1
    ];
    const count = truncateOldToolCallArgs(messages, 1, 10);
    expect(count).toBe(1);
    const clipped = (messages[0].content as Anthropic.ToolUseBlockParam[])[0].input as any;
    expect(clipped._truncated).toBe(true);
    const untouched = (messages[1].content as Anthropic.ToolUseBlockParam[])[0].input as any;
    expect(untouched.note).toBe("short");
  });

  it("ignores string-content assistant messages (no blocks to inspect)", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: "plain text reply — nothing to clip here" + "x".repeat(400) },
      ...Array.from({ length: 5 }, (_, i) => (
        { role: "user", content: `pad ${i}` } as Anthropic.MessageParam
      )),
    ];
    expect(truncateOldToolCallArgs(messages)).toBe(0);
  });
});
