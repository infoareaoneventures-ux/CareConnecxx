import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const postMock = vi.fn();
  const getMock  = vi.fn();

  // In-memory Firestore docs keyed by `${collection}/${id}`
  const writes: Record<string, unknown> = {};
  const reads:  Record<string, { exists: boolean; data?: unknown }> = {};

  const docFn = (collection: string) => (id: string) => ({
    get:    vi.fn(async () => reads[`${collection}/${id}`] ?? { exists: false, data: () => undefined }),
    set:    vi.fn(async (data: unknown) => { writes[`${collection}/${id}`] = data; }),
    update: vi.fn(async (data: unknown) => { writes[`${collection}/${id}`] = data; }),
    delete: vi.fn(async () => { delete writes[`${collection}/${id}`]; }),
  });

  // Chainable query (runTransaction not needed for these paths)
  const collectionMock = vi.fn((name: string) => ({ doc: docFn(name) }));

  // Unique uuid per call so we can detect an idempotency_key being regenerated
  // across retries (a constant uuid would hide that bug).
  const uuidState = { n: 0 };
  const uuidV4 = () => `uuid-${uuidState.n++}`;

  return { postMock, getMock, collectionMock, writes, reads, uuidState, uuidV4 };
});

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

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    Timestamp: { fromMillis: vi.fn((n: number) => ({ __ts: n })) },
  }),
}));

vi.mock("uuid", () => ({ v4: () => hoisted.uuidV4() }));
vi.mock("../safety/supervisor", () => ({ supervise: vi.fn(async (m: string) => m) }));
vi.mock("../observability/auditLog", () => ({ logMessageSent: vi.fn(async () => {}) }));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Bodies of every POST to the per-chat /messages endpoint. */
function messageBodies(): any[] {
  return hoisted.postMock.mock.calls
    .filter(([url]) => typeof url === "string" && /\/chats\/.+\/messages$/.test(url))
    .map(([, body]) => body);
}

/** Body of the POST to the /chats (createChat) endpoint, if any. */
function createChatBody(): any | undefined {
  const call = hoisted.postMock.mock.calls.find(
    ([url]) => typeof url === "string" && /\/chats$/.test(url)
  );
  return call?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.uuidState.n = 0;
  for (const k of Object.keys(hoisted.writes)) delete hoisted.writes[k];
  for (const k of Object.keys(hoisted.reads)) delete hoisted.reads[k];

  // Default: message sends succeed, chat creation returns an SMS chat,
  // capability checks report neither iMessage nor RCS available.
  hoisted.postMock.mockImplementation(async (url: string) => {
    if (/\/chats\/.+\/messages$/.test(url)) return { data: { id: "msg-1" }, headers: {} };
    if (/\/chats$/.test(url))                return { data: { chat_id: "chat-new", service: "SMS" }, headers: {} };
    if (/capability\//.test(url))            return { data: { available: false }, headers: {} };
    return { data: {}, headers: {} };
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendMessage protocol selection", () => {
  it("propagates preferred_service to every part-message in the URL-split path", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "See your care plan at https://cara.app/plan", { preferredService: "SMS" });

    const bodies = messageBodies();
    // One text bubble + one link card = two sends, BOTH must carry preferred_service.
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.message.preferred_service).toBe("SMS");
    }
  });

  it("sets preferred_service on a plain (no-URL) send", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "hello", { preferredService: "RCS" });

    const bodies = messageBodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0].message.preferred_service).toBe("RCS");
  });

  it("omits preferred_service when no override is given (automatic fallback)", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "hello");

    expect(messageBodies()[0].message.preferred_service).toBeUndefined();
  });

  it("records a retry doc for forced-iMessage sends", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "hello", { preferredService: "iMessage" });

    const rec = hoisted.writes["agent_imessage_retry/msg-1"] as any;
    expect(rec).toBeTruthy();
    expect(rec.chatId).toBe("chat-1");
    expect(rec.retried).toBe(false);
    expect(rec.parts).toEqual([{ type: "text", value: "hello" }]);
  });

  it("does NOT record a retry doc for non-iMessage sends", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "hello", { preferredService: "SMS" });

    expect(hoisted.writes["agent_imessage_retry/msg-1"]).toBeUndefined();
  });
});

describe("sendToPhone protocol selection (new chat)", () => {
  it("forces the protocol at chat creation and stores the response service", async () => {
    // createChat reports the actual service used was SMS (per Linq's response).
    const { sendToPhone } = await import("./client");
    await sendToPhone("+15551234567", "welcome", { preferredService: "SMS" });

    expect(createChatBody().message.preferred_service).toBe("SMS");
    const session = hoisted.writes["agent_sessions/+15551234567"] as any;
    expect(session.service).toBe("SMS"); // from createChat response, not capability guess
  });
});

describe("link part normalization", () => {
  it("rewrites the legacy {url, value:label} link shape to the canonical {value:URL}", async () => {
    const { sendMessage } = await import("./client");
    // The bug that broke onboarding links: URL in `url`, a label in `value`.
    await sendMessage("chat-1", { parts: [{ type: "link", url: "https://pay.x/abc", value: "💳 Pay →" }] } as any);

    expect(messageBodies()[0].message.parts[0]).toEqual({ type: "link", value: "https://pay.x/abc" });
  });

  it("leaves a canonical link part unchanged", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", { parts: [{ type: "link", value: "https://x.com" }] });

    expect(messageBodies()[0].message.parts[0]).toEqual({ type: "link", value: "https://x.com" });
  });
});

describe("splitTextAndUrls — plain-string URL extraction", () => {
  // Asserts the regex-heavy split path: text becomes one bubble, each URL a
  // dedicated link card. parts[0] of each /messages body is the unit under test.
  const parts = (b: any) => b.message.parts;

  it("splits multiple URLs into one text bubble + one link card each, in order", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "Plan: https://cara.app/plan and docs https://cara.app/docs");

    const bodies = messageBodies();
    expect(bodies.length).toBe(3);
    expect(parts(bodies[0])).toEqual([{ type: "text", value: "Plan and docs" }]);
    expect(parts(bodies[1])[0]).toEqual({ type: "link", value: "https://cara.app/plan" });
    expect(parts(bodies[2])[0]).toEqual({ type: "link", value: "https://cara.app/docs" });
  });

  it("prepends https:// to a bare hostname URL", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "Browse caregivers at careconnex.com/find");

    const bodies = messageBodies();
    expect(bodies.length).toBe(2);
    expect(parts(bodies[0])).toEqual([{ type: "text", value: "Browse caregivers at" }]);
    expect(parts(bodies[1])[0]).toEqual({ type: "link", value: "https://careconnex.com/find" });
  });

  it("moves trailing sentence punctuation off the URL and back into the text", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "Pay now: https://pay.x/abc!");

    const bodies = messageBodies();
    expect(bodies.length).toBe(2);
    expect(parts(bodies[0])).toEqual([{ type: "text", value: "Pay now!" }]);
    expect(parts(bodies[1])[0]).toEqual({ type: "link", value: "https://pay.x/abc" });
  });

  it("strips a leading separator ('Name → URL') left behind after the URL is removed", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "Your plan → https://cara.app/plan");

    const bodies = messageBodies();
    expect(bodies.length).toBe(2);
    expect(parts(bodies[0])).toEqual([{ type: "text", value: "Your plan" }]);
    expect(parts(bodies[1])[0]).toEqual({ type: "link", value: "https://cara.app/plan" });
  });

  it("sends a URL-only string as a single link card, no empty text bubble", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "https://cara.app/plan");

    const bodies = messageBodies();
    expect(bodies.length).toBe(1);
    expect(parts(bodies[0])[0]).toEqual({ type: "link", value: "https://cara.app/plan" });
  });

  it("sends a no-URL string as a single text bubble, never a link part", async () => {
    const { sendMessage } = await import("./client");
    await sendMessage("chat-1", "hello world");

    const bodies = messageBodies();
    expect(bodies.length).toBe(1);
    expect(parts(bodies[0])).toEqual([{ type: "text", value: "hello world" }]);
  });
});

describe("createChat idempotency", () => {
  it("reuses the same idempotency_key across retries", async () => {
    // First POST /chats fails with a retryable 503, second succeeds.
    let chatCalls = 0;
    hoisted.postMock.mockImplementation(async (url: string) => {
      if (/\/chats$/.test(url)) {
        chatCalls++;
        if (chatCalls === 1) throw { response: { status: 503 } };
        return { data: { chat_id: "chat-new", service: "SMS" }, headers: {} };
      }
      if (/capability\//.test(url)) return { data: { available: false }, headers: {} };
      return { data: {}, headers: {} };
    });

    const { createChat } = await import("./client");
    await createChat("+15551112222", { parts: [{ type: "text", value: "hi" }] });

    const chatBodies = hoisted.postMock.mock.calls
      .filter(([u]) => typeof u === "string" && /\/chats$/.test(u))
      .map(([, b]: any[]) => b);
    expect(chatBodies.length).toBe(2); // failed attempt + retry
    expect(chatBodies[0].message.idempotency_key).toBeTruthy();
    expect(chatBodies[0].message.idempotency_key).toBe(chatBodies[1].message.idempotency_key);
  });
});
