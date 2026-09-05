import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Hallucination hardening U3 — qaAgent side:
 *  - getConversationHistory's window guardrail (transport-recorded rows are
 *    shed before the last user turns are displaced);
 *  - the "who is Marcus" integration shape (a transport-recorded scripted send
 *    is visible in the history the agent reads);
 *  - sendSplit threads SendOptions through WITHOUT setting skipHistoryRecord
 *    itself (commitmentTracker + DND ack must keep recording);
 *  - source-level guarantees that exactly the three saveConversationTurn-backed
 *    call sites (plus the filler) pass the skip flag.
 */

// ── In-memory agent_conversations store ──────────────────────────────────────
const hoisted = vi.hoisted(() => {
  // phone -> rows ({ role, content, timestamp, source? })
  const conversations = new Map<string, Array<Record<string, unknown>>>();

  const messagesQuery = (phone: string) => {
    const filters: Array<[string, unknown]> = [];
    let lim = Infinity;
    let desc = false;
    const q: Record<string, unknown> = {};
    q.where = (f: string, _o: string, v: unknown) => { filters.push([f, v]); return q; };
    q.orderBy = (_f: string, dir?: string) => { desc = dir === "desc"; return q; };
    q.limit = (n: number) => { lim = n; return q; };
    q.get = async () => {
      let rows = [...(conversations.get(phone) ?? [])]
        .filter((r) => filters.every(([f, v]) => r[f] === v))
        .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
      if (desc) rows.reverse();
      rows = rows.slice(0, lim);
      return {
        empty: rows.length === 0,
        // Stable per-row doc ids (assigned at seed time): getConversationHistory
        // merges two queries and dedupes by doc id, so the same row must carry
        // the same id in both result sets — positional ids would break that.
        docs: rows.map((r, i) => ({ id: (r.__id as string) ?? `d${i}`, data: () => r })),
      };
    };
    return q;
  };

  const genericDoc = (): Record<string, unknown> => ({
    get: async () => ({ exists: false, data: () => undefined }),
    set: async () => {},
    update: async () => {},
    delete: async () => {},
    collection: () => ({ add: async () => ({ id: "x" }) }),
  });

  const collection = (name: string): Record<string, unknown> => ({
    add: async () => ({ id: "x" }),
    where: () => messagesQuery("__none__"),
    doc: (id: string) => {
      if (name === "agent_conversations") {
        return {
          ...genericDoc(),
          collection: (sub: string) =>
            sub === "messages"
              ? messagesQuery(id)
              : { add: async () => ({ id: "x" }) },
        };
      }
      return genericDoc();
    },
  });

  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: {
      increment: (n: number) => ({ __inc: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({}),
    },
    Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
  });

  const sendMessageMock = vi.fn(async (..._args: unknown[]) => ({ message_id: "m1" }));

  return { conversations, firestore, sendMessageMock };
});

// qaAgent imports a wide graph — stub the heavy dependencies aggressively
// (same set as qaAgent.test.ts), but keep contextManagement REAL so the
// window-composition guardrail under test is the shipping code.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    apps: [],
    initializeApp: () => ({}),
    firestore: hoisted.firestore,
  },
  apps: [],
  initializeApp: () => ({}),
  firestore: hoisted.firestore,
}));
vi.mock("../utils/claudeClient",   () => ({ getSharedClient: () => ({}) }));
vi.mock("../utils/openaiClient",   () => ({ quickComplete: vi.fn(), getOpenAIClient: () => ({}), openAiTokenLimitParam: vi.fn(() => ({})) }));
vi.mock("../utils/claudeRetry",    () => ({ callClaudeWithRetry: vi.fn() }));
vi.mock("../safety/supervisor",    () => ({ supervise: (msg: string) => Promise.resolve(msg) }));
vi.mock("../safety/linter",        () => ({ lintMessage: (msg: string) => msg, lintPreservingLayout: (msg: string) => msg }));
vi.mock("../mcp/server",           () => ({ MCP_TOOLS: [], CAREGIVER_TOOLS: [], CLIENT_TOOLS: [], handleToolCall: vi.fn(), handleToolCallForCaregiver: vi.fn() }));
vi.mock("../memory/zepClient",     () => ({ getZepContext: vi.fn(), addUserMessageToZep: vi.fn(), addAssistantMessageToZep: vi.fn() }));
vi.mock("../memory/memoryFiles",   () => ({ getMemoryContext: vi.fn(), writeMemoryFile: vi.fn() }));
vi.mock("../memory/learnedFacts",  () => ({
  getRelevantFacts: vi.fn(),
  detectAndStageFactChange: vi.fn(async () => ({ kind: "not_correction" })),
  factChangeAckCopy: vi.fn(() => null),
  findTombstonedRestatement: vi.fn(async () => null),
  classifyReRememberReply: vi.fn(async () => "other"),
  confirmReRemember: vi.fn(async () => ({ ok: false, reason: "not_found" })),
}));
vi.mock("../memory/preferences",   () => ({ getPreferences: vi.fn(), isInDND: () => false }));
vi.mock("../linq/client",          () => ({ sendMessage: hoisted.sendMessageMock, startTyping: vi.fn(), stopTyping: vi.fn() }));
vi.mock("./executionAgent",        () => ({ getActiveAgentForUser: vi.fn() }));

import { getConversationHistory, sendSplit } from "./qaAgent";
import {
  HISTORY_WINDOW,
  HISTORY_OVERFETCH_LIMIT,
  MIN_USER_ROWS_KEPT,
  composeHistoryWindow,
} from "./contextManagement";

const PHONE = "+15559990000";

function seed(rows: Array<{ role: string; content: string; timestamp: number; source?: string }>) {
  hoisted.conversations.set(
    PHONE,
    rows.map((r, i) => ({ ...r, __id: `m${i}` })) as Array<Record<string, unknown>>,
  );
}

beforeEach(() => {
  hoisted.conversations.clear();
  hoisted.sendMessageMock.mockClear();
});

describe("getConversationHistory — U3 window guardrail", () => {
  it("keeps the last 6 user rows even when 30 newer outbound_transport rows crowd the window", async () => {
    const rows: Array<{ role: string; content: string; timestamp: number; source?: string }> = [];
    // 6 user rows, all OLDER than the flood of scheduled/transport sends.
    for (let i = 0; i < 6; i++) {
      rows.push({ role: "user", content: `user-msg-${i}`, timestamp: 1000 + i });
    }
    // 30 transport-recorded assistant rows, all newer.
    for (let i = 0; i < 30; i++) {
      rows.push({ role: "assistant", content: `nudge-${i}`, timestamp: 2000 + i, source: "outbound_transport" });
    }
    seed(rows);

    const history = await getConversationHistory(PHONE);

    expect(history).toHaveLength(HISTORY_WINDOW);
    for (let i = 0; i < 6; i++) {
      expect(history.some((m) => m.role === "user" && m.content === `user-msg-${i}`)).toBe(true);
    }
    // Chronological order preserved.
    const idxUser5 = history.findIndex((m) => m.content === "user-msg-5");
    const idxFirstNudge = history.findIndex((m) => m.content.startsWith("nudge-"));
    expect(idxUser5).toBeGreaterThanOrEqual(0);
    expect(idxUser5).toBeLessThan(idxFirstNudge);
  });

  it("keeps user rows buried behind 70 transport rows — beyond the over-fetch horizon", async () => {
    // A user silent behind 60+ CONSECUTIVE transport rows falls off the
    // over-fetch entirely; the dedicated role=="user" query must still feed
    // their turns to the window composer.
    const rows: Array<{ role: string; content: string; timestamp: number; source?: string }> = [];
    for (let i = 0; i < 3; i++) {
      rows.push({ role: "user", content: `buried-user-${i}`, timestamp: 1000 + i });
    }
    const floodSize = HISTORY_OVERFETCH_LIMIT + 10; // 70 — strictly beyond the over-fetch
    for (let i = 0; i < floodSize; i++) {
      rows.push({ role: "assistant", content: `nudge-${i}`, timestamp: 2000 + i, source: "outbound_transport" });
    }
    seed(rows);

    const history = await getConversationHistory(PHONE);

    expect(history).toHaveLength(HISTORY_WINDOW);
    for (let i = 0; i < 3; i++) {
      expect(history.some((m) => m.role === "user" && m.content === `buried-user-${i}`)).toBe(true);
    }
    // Chronological: the buried user turns precede every surviving nudge.
    const lastUserIdx = history.findIndex((m) => m.content === "buried-user-2");
    const firstNudgeIdx = history.findIndex((m) => m.content.startsWith("nudge-"));
    expect(lastUserIdx).toBeGreaterThanOrEqual(0);
    expect(lastUserIdx).toBeLessThan(firstNudgeIdx);
    // No duplicates from the two-query merge.
    expect(new Set(history.map((m) => m.content)).size).toBe(history.length);
  });

  it("does not duplicate user rows that appear in BOTH queries (dedupe by doc id)", async () => {
    // All rows fit inside the over-fetch, so every user row is returned by both
    // the recent query and the dedicated user query.
    const rows: Array<{ role: string; content: string; timestamp: number }> = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ role: "user", content: `u${i}`, timestamp: 1000 + i * 2 });
      rows.push({ role: "assistant", content: `a${i}`, timestamp: 1001 + i * 2 });
    }
    seed(rows);

    const history = await getConversationHistory(PHONE);
    expect(history).toHaveLength(20);
    expect(new Set(history.map((m) => m.content)).size).toBe(20);
  });

  it("never sheds regular (untagged) assistant rows to make room", async () => {
    const rows: Array<{ role: string; content: string; timestamp: number; source?: string }> = [];
    for (let i = 0; i < 6; i++) rows.push({ role: "user", content: `u${i}`, timestamp: 1000 + i });
    // 30 REGULAR assistant rows (no source): nothing safe to shed, so the
    // window stays the plain most-recent slice.
    for (let i = 0; i < 30; i++) rows.push({ role: "assistant", content: `a${i}`, timestamp: 2000 + i });
    seed(rows);

    const history = await getConversationHistory(PHONE);
    expect(history).toHaveLength(HISTORY_WINDOW);
    expect(history.every((m) => m.role === "assistant")).toBe(true);
  });

  it("integration: a transport-recorded scripted send is visible to the agent (the 'who is Marcus' shape)", async () => {
    // Exactly the row shape recordOutboundHistory writes (proven in
    // linq/__tests__/outboundHistory.test.ts).
    seed([
      { role: "user", content: "hi", timestamp: 1000 },
      {
        role: "assistant",
        content: "Quick heads up, it looks like we need to add that driving record check to Marcus's intake.",
        timestamp: 2000,
        source: "outbound_transport",
      },
      { role: "user", content: "who is Marcus?", timestamp: 3000 },
    ]);

    const history = await getConversationHistory(PHONE);
    expect(history.some((m) => m.role === "assistant" && m.content.includes("Marcus"))).toBe(true);
    expect(history[history.length - 1].content).toBe("who is Marcus?");
  });

  it("keeps the summary-doc handling exactly as before", async () => {
    seed([
      { role: "summary", content: "Earlier facts about Mom's care.", timestamp: 500 },
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: "hi there", timestamp: 1001 },
    ]);
    const history = await getConversationHistory(PHONE);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("Earlier conversation summary");
    expect(history[0].content).toContain("Earlier facts about Mom's care.");
    expect(history[1].content).toBe("Got it - I have context from our earlier conversations.");
    expect(history).toHaveLength(4);
    expect(history.some((m) => m.content === "hello")).toBe(true);
  });

  it("short histories come back complete and untouched", async () => {
    seed([
      { role: "user", content: "a", timestamp: 1 },
      { role: "assistant", content: "b", timestamp: 2 },
    ]);
    expect(await getConversationHistory(PHONE)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });
});

describe("composeHistoryWindow (pure)", () => {
  it("is a no-op at or under the window size", () => {
    const rows = Array.from({ length: HISTORY_WINDOW }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    expect(composeHistoryWindow(rows)).toEqual(rows);
  });

  it("drops the OLDEST outbound_transport rows first", () => {
    const rows: Array<{ role: "user" | "assistant"; content: string; source?: string }> = [];
    for (let i = 0; i < MIN_USER_ROWS_KEPT; i++) rows.push({ role: "user", content: `u${i}` });
    for (let i = 0; i < HISTORY_WINDOW + 2; i++) {
      rows.push({ role: "assistant", content: `t${i}`, source: "outbound_transport" });
    }
    const out = composeHistoryWindow(rows);
    expect(out).toHaveLength(HISTORY_WINDOW);
    // All user rows survive; the shed rows are the oldest transport rows.
    for (let i = 0; i < MIN_USER_ROWS_KEPT; i++) {
      expect(out.some((r) => r.content === `u${i}`)).toBe(true);
    }
    expect(out.some((r) => r.content === "t0")).toBe(false);
    expect(out.some((r) => r.content === `t${HISTORY_WINDOW + 1}`)).toBe(true);
  });
});

describe("sendSplit — SendOptions thread-through (U3)", () => {
  it("passes NO skipHistoryRecord by default (commitmentTracker/DND-ack path keeps recording)", async () => {
    await sendSplit("chat-1", "A short follow-up.");
    expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    const opts = hoisted.sendMessageMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts?.skipHistoryRecord).toBeUndefined();
  });

  it("threads caller opts through to every chunk", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} adds length. `).join("");
    await sendSplit("chat-1", long, { skipHistoryRecord: true });
    expect(hoisted.sendMessageMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of hoisted.sendMessageMock.mock.calls) {
      expect((call[2] as Record<string, unknown>).skipHistoryRecord).toBe(true);
    }
  }, 20_000);
});

describe("skip-flag call sites — source-level guarantees", () => {
  const qaSrc = fs.readFileSync(path.resolve(__dirname, "qaAgent.ts"), "utf8");
  const trackerSrc = fs.readFileSync(path.resolve(__dirname, "commitmentTracker.ts"), "utf8");

  it("the three saveConversationTurn-backed sends pass skipHistoryRecord", () => {
    // The mid-loop browse-action filler ("On it — give me a moment.") was
    // removed 2026-09-05 along with perform_web_action itself (no site
    // equivalent) — only these three call sites remain.
    expect(qaSrc).toContain("await sendSplit(chatId, reply, { skipHistoryRecord: true });");          // main reply
    expect(qaSrc).toContain("await sendSplit(chatId, resumedReply, { skipHistoryRecord: true });");   // checkpoint resume
    expect(qaSrc).toContain("buildClickableMessage(reply), { skipHistoryRecord: true })");            // runQuickReply
  });

  it("sendSplit itself never sets the flag — it only forwards caller opts", () => {
    const body = qaSrc.slice(qaSrc.indexOf("export async function sendSplit"),
                             qaSrc.indexOf("// ── Low-confidence"));
    expect(body).toContain("opts ?? {}");
    expect(body).not.toContain("skipHistoryRecord: true");
  });

  it("the DND quiet-hours ack and commitmentTracker's follow-up do NOT skip recording", () => {
    const dnd = qaSrc.slice(qaSrc.indexOf("quiet hours") - 400, qaSrc.indexOf("quiet hours") + 400);
    expect(dnd).not.toContain("skipHistoryRecord");
    expect(trackerSrc).toContain("await sendSplit(c.chatId, trimmed);");
    expect(trackerSrc).not.toContain("skipHistoryRecord");
  });

  it("fulfillNarratedLinkPromise's link bubble is NOT skipped (it should finally be recorded)", () => {
    const idx = qaSrc.indexOf("fulfillNarratedLinkPromise({");
    expect(idx).toBeGreaterThan(-1);
    expect(qaSrc.slice(idx, idx + 200)).not.toContain("skipHistoryRecord");
  });
});

// ── U3b (memory-grounding plan, R8/R9) — durable turn-pair contract ──────────
// The shared completed-turn boundary (conversationMemory.persistCompletedTurn,
// called by routeIntent's default tail and webChat) ADOPTS the history pair
// qaAgent writes, instead of writing a second pair. These pins keep that
// dependency honest: qaAgent must keep writing the pair, and must never call
// the boundary itself — the ingress callers (SMS route / web callable) own it,
// so web and SMS turns get EQUIVALENT persistence through one seam.
describe("U3b — durable turn pair contract (adoption dependency)", () => {
  const qaSrc = fs.readFileSync(path.resolve(__dirname, "qaAgent.ts"), "utf8");

  it("qaAgent still writes the durable pair on the resume, main, and quick paths", () => {
    // Exactly the three awaited saveConversationTurn call sites the adoption
    // scan depends on (checkpoint resume, main reply, quick reply).
    expect([...qaSrc.matchAll(/await saveConversationTurn\(/g)]).toHaveLength(3);
  });

  it("saveConversationTurn writes plain rows (no source tag) so they stay adoptable", () => {
    const body = qaSrc.slice(
      qaSrc.indexOf("async function saveConversationTurn"),
      qaSrc.indexOf("// ── System prompt builders"),
    );
    expect(body).toContain('{ role: "user",      content: userText,       timestamp: now }');
    expect(body).toContain('{ role: "assistant", content: assistantReply, timestamp: now + 1 }');
    expect(body).not.toContain("source:");
  });

  it("qaAgent never calls the completed-turn boundary itself — ingress callers own it", () => {
    expect(qaSrc).not.toContain("persistCompletedTurn");
  });
});
