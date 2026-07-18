import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Hallucination hardening U3 (R4, R18): every user-visible outbound SMS is
 * recorded as an assistant turn in agent_conversations/{phone}/messages at the
 * transport choke point (sendMessageDeliver), so the QA agent can no longer
 * deny its own messages ("who is Marcus"). These tests drive the REAL
 * linq/client.ts + threadMirror.ts against an in-memory Firestore and a mocked
 * Linq transport.
 */

// ── In-memory Firestore ───────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const state = {
    // agent_sessions rows; __id is the doc id (== phone).
    sessions: [] as Array<Record<string, unknown> & { __id: string }>,
    // agent_conversations/{phone}/messages adds — the recorder's output.
    convAdds: [] as Array<{ phone: string; data: Record<string, unknown> }>,
    // linq_outbound_queue adds — the dead-letter path.
    queueAdds: [] as Array<{ id: string; data: Record<string, unknown> }>,
    // Every other .add (threads mirror, admin_alerts, …) — must never throw.
    otherAdds: [] as Array<{ path: string; data: Record<string, unknown> }>,
    convAddThrows: false,
    qid: 0,
  };

  const makeChain = (name: string) => {
    const filters: Array<[string, unknown]> = [];
    let lim = Infinity;
    const chain: Record<string, unknown> = {};
    chain.where = (f: string, _o: string, v: unknown) => { filters.push([f, v]); return chain; };
    chain.limit = (n: number) => { lim = n; return chain; };
    chain.orderBy = () => chain;
    chain.get = async () => {
      const rows = name === "agent_sessions" ? state.sessions : [];
      const items = rows
        .filter((r) => filters.every(([f, v]) => (r as Record<string, unknown>)[f] === v))
        .slice(0, lim);
      return {
        empty: items.length === 0,
        docs: items.map((r) => ({ id: r.__id, data: () => r })),
      };
    };
    return chain;
  };

  const collection = (name: string): Record<string, unknown> => ({
    add: async (data: Record<string, unknown>) => {
      if (name === "linq_outbound_queue") {
        const id = `q${++state.qid}`;
        state.queueAdds.push({ id, data });
        return { id };
      }
      state.otherAdds.push({ path: name, data });
      return { id: "x" };
    },
    where: (f: string, o: string, v: unknown) =>
      (makeChain(name).where as (f: string, o: string, v: unknown) => unknown)(f, o, v),
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: false, data: () => undefined }),
      set: async () => {},
      update: async () => {},
      delete: async () => {},
      collection: (sub: string) => ({
        add: async (data: Record<string, unknown>) => {
          if (name === "agent_conversations" && sub === "messages") {
            if (state.convAddThrows) throw new Error("firestore unavailable");
            state.convAdds.push({ phone: id, data });
            return { id: `row-${state.convAdds.length}` };
          }
          state.otherAdds.push({ path: `${name}/${id}/${sub}`, data });
          return { id: "y" };
        },
      }),
    }),
  });

  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: {
      increment: (n: number) => ({ __inc: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({}),
    },
    Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
  });

  const postMock = vi.fn();
  const getMock = vi.fn();

  return {
    state,
    firestore,
    postMock,
    getMock,
    reset: () => {
      state.sessions = [];
      state.convAdds.length = 0;
      state.queueAdds.length = 0;
      state.otherAdds.length = 0;
      state.convAddThrows = false;
      state.qid = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

vi.mock("axios", () => ({
  __esModule: true,
  default: {
    post:   (...a: unknown[]) => hoisted.postMock(...a),
    get:    (...a: unknown[]) => hoisted.getMock(...a),
    delete: vi.fn(async () => ({ data: {}, headers: {} })),
    patch:  vi.fn(async () => ({ data: {}, headers: {} })),
    put:    vi.fn(async () => ({ data: {}, headers: {} })),
  },
}));

// client.ts → supervisor → claudeClient chain is heavy/hangs in tests.
vi.mock("../../safety/supervisor", () => ({
  supervise: vi.fn(async (m: string) => m),
}));
vi.mock("../../observability/auditLog", () => ({ logMessageSent: vi.fn(async () => {}) }));

import { sendMessage, signalThinking } from "../client";
import { resolvePhones, recordOutboundHistory, neutralizeUrlsForHistory } from "../threadMirror";

// Recording is awaited on the send path (Gen-1 teardown safety), but give the
// microtask/macrotask queue a beat to settle before asserting ABSENCE so a
// regression back to fire-and-forget can't sneak a late row past the check.
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  // Default: transport succeeds.
  hoisted.postMock.mockImplementation(async (url: string) => {
    if (/\/chats\/.+\/messages$/.test(url)) return { data: { id: "msg-1" }, headers: {} };
    if (/\/chats$/.test(url)) return { data: { chat_id: "chat-new", service: "SMS" }, headers: {} };
    return { data: {}, headers: {} };
  });
});

afterEach(() => {
  delete process.env.OUTBOUND_HISTORY_RECORD_ENABLED;
});

// Bodies of every POST to the per-chat /messages endpoint.
function messagePosts(): unknown[] {
  return hoisted.postMock.mock.calls.filter(
    ([url]) => typeof url === "string" && /\/chats\/.+\/messages$/.test(url as string));
}

describe("resolvePhones", () => {
  it("returns the agent_sessions DOC ID (phone), never the userId field", async () => {
    hoisted.state.sessions = [
      { __id: "+15551230001", chatId: "rp-direct", userId: "uid-42" },
    ];
    const phones = await resolvePhones("rp-direct");
    expect(phones).toEqual(["+15551230001"]);
    expect(phones).not.toContain("uid-42");
  });

  it("fans out to every member phone when matched via groupChatId", async () => {
    hoisted.state.sessions = [
      { __id: "+15551230002", chatId: "member-a", groupChatId: "rp-group", userId: "uidA" },
      { __id: "+15551230003", chatId: "member-b", groupChatId: "rp-group", userId: "uidB" },
    ];
    const phones = await resolvePhones("rp-group");
    expect(phones.sort()).toEqual(["+15551230002", "+15551230003"]);
  });

  it("returns [] for an unknown chatId and for a blank chatId", async () => {
    expect(await resolvePhones("rp-nothing")).toEqual([]);
    expect(await resolvePhones("")).toEqual([]);
  });
});

describe("recordOutboundHistory (direct)", () => {
  it("writes a row matching saveConversationTurn's schema plus the source tag", async () => {
    hoisted.state.sessions = [{ __id: "+15551230010", chatId: "roh-schema", userId: "u" }];
    const before = Date.now();
    await recordOutboundHistory({ chatId: "roh-schema", text: "Your visit is confirmed." });
    expect(hoisted.state.convAdds).toHaveLength(1);
    const { phone, data } = hoisted.state.convAdds[0];
    expect(phone).toBe("+15551230010");
    expect(data.role).toBe("assistant");
    expect(data.content).toBe("Your visit is confirmed.");
    expect(typeof data.timestamp).toBe("number");
    expect(data.timestamp as number).toBeGreaterThanOrEqual(before);
    expect(data.source).toBe("outbound_transport");
  });

  it("no-ops on empty/whitespace and attachment-only text", async () => {
    hoisted.state.sessions = [{ __id: "+15551230011", chatId: "roh-empty", userId: "u" }];
    await recordOutboundHistory({ chatId: "roh-empty", text: "   " });
    await recordOutboundHistory({ chatId: "roh-empty", text: "[attachment]" });
    await recordOutboundHistory({ chatId: "roh-empty", text: "[attachment]\n[attachment]" });
    expect(hoisted.state.convAdds).toHaveLength(0);
  });

  it("never throws when the write fails (fire-and-forget-safe)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.state.sessions = [{ __id: "+15551230012", chatId: "roh-throw", userId: "u" }];
    hoisted.state.convAddThrows = true;
    await expect(recordOutboundHistory({ chatId: "roh-throw", text: "hello" })).resolves.toBeUndefined();
    // Warn log carries keys only, never the message text.
    const warned = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).not.toContain("hello");
    warnSpy.mockRestore();
  });

  it("is disabled by OUTBOUND_HISTORY_RECORD_ENABLED=false (KILL switch)", async () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "false";
    hoisted.state.sessions = [{ __id: "+15551230013", chatId: "roh-flag", userId: "u" }];
    await recordOutboundHistory({ chatId: "roh-flag", text: "hello" });
    expect(hoisted.state.convAdds).toHaveLength(0);
  });
});

describe("URL neutralization — history never stores tokenized/bearer URLs", () => {
  it("neutralizeUrlsForHistory replaces http(s) and www URLs with [link]; plain text untouched", () => {
    expect(neutralizeUrlsForHistory("Pay here: https://checkout.stripe.com/pay/cs_a1B2 today"))
      .toBe("Pay here: [link] today");
    expect(neutralizeUrlsForHistory("Upload at www.eviacares.com/upload/photo?t=tok_9 please"))
      .toBe("Upload at [link] please");
    expect(neutralizeUrlsForHistory("http://example.com/bgcheck?token=abc\nSecond line"))
      .toBe("[link]\nSecond line");
    expect(neutralizeUrlsForHistory("No links in this message.")).toBe("No links in this message.");
  });

  it("records [link] (never the URL or token) for a tokenized checkout send", async () => {
    hoisted.state.sessions = [{ __id: "+15551250001", chatId: "nu-token", userId: "u" }];
    await sendMessage("nu-token", "Tap here to pay: https://checkout.stripe.com/pay/cs_test_SECRETTOKEN");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    const content = String(hoisted.state.convAdds[0].data.content);
    expect(content).toContain("Tap here to pay");
    expect(content).toContain("[link]");
    expect(content).not.toContain("http");
    expect(content).not.toContain("cs_test_SECRETTOKEN");
  });

  it("neutralizes a structured link-part send (extractMirrorText yields the URL as text)", async () => {
    hoisted.state.sessions = [{ __id: "+15551250002", chatId: "nu-struct", userId: "u" }];
    await sendMessage("nu-struct", {
      parts: [{ type: "link", value: "https://checkout.stripe.com/pay/cs_456" }],
    });
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    const content = String(hoisted.state.convAdds[0].data.content);
    expect(content).toBe("[link]");
    expect(content).not.toContain("http");
  });

  it("leaves the web-inbox mirror text untouched (URLs neutralized in HISTORY only)", async () => {
    hoisted.state.sessions = [{ __id: "+15551250003", chatId: "nu-mirror", userId: "uid-m" }];
    await sendMessage("nu-mirror", "Tap here to pay: https://checkout.stripe.com/pay/cs_777");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    await settle(); // mirror is still fire-and-forget
    const mirrored = hoisted.state.otherAdds.filter((a) => a.path === "threads/cara_uid-m/messages");
    expect(mirrored.length).toBeGreaterThan(0);
    expect(String(mirrored[0].data.text)).toContain("https://checkout.stripe.com/pay/cs_777");
  });

  it("records plain no-URL text verbatim", async () => {
    hoisted.state.sessions = [{ __id: "+15551250004", chatId: "nu-plain", userId: "u" }];
    await sendMessage("nu-plain", "Maria confirmed for Friday at 10am.");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    expect(hoisted.state.convAdds[0].data.content).toBe("Maria confirmed for Friday at 10am.");
  });
});

describe("sendMessage → outbound history recording", () => {
  it("records ONE assistant row keyed by PHONE for a scripted send", async () => {
    hoisted.state.sessions = [
      { __id: "+15551240001", chatId: "sm-scripted", userId: "uid-99" },
    ];
    await sendMessage("sm-scripted", "Maria is confirmed for Friday at 10am.");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));

    const { phone, data } = hoisted.state.convAdds[0];
    expect(phone).toBe("+15551240001"); // session DOC id, not userId
    expect(data).toMatchObject({
      role:    "assistant",
      content: expect.stringContaining("Maria is confirmed"),
      source:  "outbound_transport",
    });
    expect(hoisted.state.convAdds.some((a) => a.phone === "uid-99")).toBe(false);
  });

  it("records one row per member phone for a group-chat send", async () => {
    hoisted.state.sessions = [
      { __id: "+15551240002", chatId: "m-a", groupChatId: "sm-group", userId: "uA" },
      { __id: "+15551240003", chatId: "m-b", groupChatId: "sm-group", userId: "uB" },
    ];
    await sendMessage("sm-group", "Family update: the visit went well.");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(2));
    expect(hoisted.state.convAdds.map((a) => a.phone).sort())
      .toEqual(["+15551240002", "+15551240003"]);
  });

  it("records exactly ONE row for a multi-bubble (URL-split) send, with the full text", async () => {
    hoisted.state.sessions = [{ __id: "+15551240004", chatId: "sm-split", userId: "u" }];
    await sendMessage("sm-split", "Tap here to pay: https://checkout.stripe.com/pay/cs_123");
    // Two transport bubbles (text + link card) went out…
    expect(messagePosts().length).toBe(2);
    // …but exactly one history row, carrying the full extracted text.
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(1);
    expect(String(hoisted.state.convAdds[0].data.content)).toContain("Tap here to pay");
  });

  it("skips recording when opts.skipHistoryRecord is set (QA double-write prevention)", async () => {
    hoisted.state.sessions = [{ __id: "+15551240005", chatId: "sm-skip", userId: "u" }];
    await sendMessage("sm-skip", "Already persisted by saveConversationTurn.", { skipHistoryRecord: true });
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0);
    expect(messagePosts().length).toBe(1); // send still went out
  });

  it("records a plain send with NO flag (commitmentTracker-style sendSplit delivery path)", async () => {
    // commitmentTracker.ts:389 delivers via sendSplit → sendMessage with no
    // opts — that path MUST keep recording.
    hoisted.state.sessions = [{ __id: "+15551240006", chatId: "sm-commit", userId: "u" }];
    await sendMessage("sm-commit", "Circling back: Maria confirmed Thursday.");
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
  });

  it("does not record signalThinking's filler", async () => {
    hoisted.state.sessions = [{ __id: "+15551240007", chatId: "sm-filler", userId: "u" }];
    await signalThinking("sm-filler", "SMS");
    await settle();
    expect(messagePosts().length).toBe(1); // filler still delivered
    expect(hoisted.state.convAdds).toHaveLength(0);
  });

  it("does not record an attachment-only message", async () => {
    hoisted.state.sessions = [{ __id: "+15551240008", chatId: "sm-media", userId: "u" }];
    await sendMessage("sm-media", { parts: [{ type: "media", attachment_id: "att-1" }] });
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0);
  });

  it("writes nothing and does not throw for an unresolvable chatId — send still returns", async () => {
    const res = await sendMessage("sm-nosession", "Hello, whoever you are.");
    expect(res.message_id).toBe("msg-1");
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0);
  });

  it("records ZERO rows on transport failure; the drained redelivery records exactly once", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.state.sessions = [{ __id: "+15551240009", chatId: "sm-fail", userId: "u" }];

    // Non-transient transport failure (no response.status → withRetry throws
    // immediately) — sendMessage dead-letters it into linq_outbound_queue.
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats\/.+\/messages$/.test(url)) throw new Error("network down");
      return { data: {}, headers: {} };
    });
    const res = await sendMessage("sm-fail", "Your background check cleared!");
    expect(res.message_id).toBe(""); // dead-lettered, not thrown
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0); // no phantom row
    expect(hoisted.state.queueAdds).toHaveLength(1);

    // Drain redelivery: the sweep re-enters sendMessage with _noQueue.
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats\/.+\/messages$/.test(url)) return { data: { id: "msg-2" }, headers: {} };
      return { data: {}, headers: {} };
    });
    const payload = hoisted.state.queueAdds[0].data.payloadText as string;
    await sendMessage("sm-fail", payload, { _noQueue: true });
    await vi.waitFor(() => expect(hoisted.state.convAdds).toHaveLength(1));
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(1); // exactly once
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("dead-letters preserve skipHistoryRecord so a redelivered QA reply stays skipped", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.state.sessions = [{ __id: "+15551240010", chatId: "sm-fail-skip", userId: "u" }];
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats\/.+\/messages$/.test(url)) throw new Error("network down");
      return { data: {}, headers: {} };
    });
    await sendMessage("sm-fail-skip", "QA reply already saved.", { skipHistoryRecord: true });
    expect(hoisted.state.queueAdds).toHaveLength(1);
    expect(hoisted.state.queueAdds[0].data.skipHistoryRecord).toBe(true);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("partial-bubble failure (text ok, link throws): dead-letter carries skipHistoryRecord and drain redelivery records nothing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.state.sessions = [{ __id: "+15551240013", chatId: "sm-partial", userId: "u" }];

    // Text bubble delivers; the follow-up link bubble hard-fails (non-transient
    // — no response.status, so withRetry throws immediately).
    let messageCalls = 0;
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats\/.+\/messages$/.test(url)) {
        messageCalls++;
        if (messageCalls === 1) return { data: { id: "msg-1" }, headers: {} };
        throw new Error("network down");
      }
      return { data: {}, headers: {} };
    });

    const res = await sendMessage("sm-partial", "Tap here to pay: https://checkout.stripe.com/pay/cs_789");
    expect(res.message_id).toBe(""); // dead-lettered, not thrown
    // The successful text bubble already recorded exactly one history row…
    expect(hoisted.state.convAdds).toHaveLength(1);
    // …so the dead-letter must be flagged: redelivery re-sends the SMS but
    // records nothing (no double row).
    expect(hoisted.state.queueAdds).toHaveLength(1);
    expect(hoisted.state.queueAdds[0].data.skipHistoryRecord).toBe(true);

    // Drain redelivery: the sweep replays skipHistoryRecord + _noQueue.
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats\/.+\/messages$/.test(url)) return { data: { id: "msg-2" }, headers: {} };
      return { data: {}, headers: {} };
    });
    const payload = hoisted.state.queueAdds[0].data.payloadText as string;
    await sendMessage("sm-partial", payload, { _noQueue: true, skipHistoryRecord: true });
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(1); // exactly ONE row total
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("send still succeeds when the recording write throws (fire-and-forget isolation)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.state.sessions = [{ __id: "+15551240011", chatId: "sm-recfail", userId: "u" }];
    hoisted.state.convAddThrows = true;
    const res = await sendMessage("sm-recfail", "Message that fails to record.");
    expect(res.message_id).toBe("msg-1");
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("writes no rows when OUTBOUND_HISTORY_RECORD_ENABLED=false", async () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "false";
    hoisted.state.sessions = [{ __id: "+15551240012", chatId: "sm-killed", userId: "u" }];
    await sendMessage("sm-killed", "Flag is off.");
    await settle();
    expect(hoisted.state.convAdds).toHaveLength(0);
    expect(messagePosts().length).toBe(1); // delivery unaffected
  });
});
