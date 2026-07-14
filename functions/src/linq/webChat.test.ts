import { describe, it, expect, vi, beforeEach } from "vitest";

// U2 unified send pipeline (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md):
// rate check → session resolve → onboarding guard → opt-out → lock → awaited
// inbound mirror → agent → manual reply mirror only on the skipSend branch.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();            // doc path -> data
  const queryItems = new Map<string, any[]>();    // collection path -> items for where() queries
  const writes: Array<{ op: string; path: string; data?: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      writes.push({ op: "set", path, data });
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND: no document at ${path}`);
      writes.push({ op: "update", path, data });
      docs.set(path, { ...docs.get(path), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const filters: Array<[string, string, any]> = [];
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (field: string, op: string, value: any) => {
      filters.push([field, op, value]);
      return ref;
    };
    ref.limit = () => ref;
    ref.get = vi.fn(async () => {
      const items = (queryItems.get(path) ?? []).filter((item) =>
        filters.every(([field, op, value]) => (op === "==" ? item[field] === value : true)),
      );
      return { empty: items.length === 0, docs: items.map((d, i) => ({ id: d.id ?? `doc-${i}`, data: () => d })) };
    });
    return ref;
  };

  return {
    docs,
    queryItems,
    writes,
    collectionMock: vi.fn((path: string) => makeCollRef(path)),
    claimMock: vi.fn(async (..._args: any[]) => true),
    releaseMock: vi.fn(async (..._args: any[]) => {}),
    mirrorMock: vi.fn(async (..._args: any[]) => {}),
    qaMock: vi.fn(async (..._args: any[]) => "Here's what I found!"),
    helpMock: vi.fn((role: string) => `capability help for ${role}`),
    sendLinqMock: vi.fn(async (..._args: any[]) => {}),
    reset() {
      docs.clear();
      queryItems.clear();
      writes.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  }),
}));

vi.mock("../utils/sessionState", () => ({
  claimInboundProcessing: hoisted.claimMock,
  releaseInboundProcessing: hoisted.releaseMock,
}));

vi.mock("./threadMirror", () => ({
  mirrorToWebThread: hoisted.mirrorMock,
}));

vi.mock("../agents/qaAgent", () => ({
  runQaAgent: hoisted.qaMock,
}));

// /help command path: capability reply + optional ops lead + Linq send.
vi.mock("../agents/capabilityDiscovery", () => ({
  buildHelpSmsReply: hoisted.helpMock,
}));
vi.mock("../agents/operationalContext", () => ({
  loadCaraOperationalContext: vi.fn(async () => null),
  buildOperationalRecipeLead: vi.fn(() => undefined),
}));
vi.mock("./client", () => ({
  sendMessage: hoisted.sendLinqMock,
}));

import { handleWebChatTurn, AgentUnavailableError } from "./webChat";

const UID = "uid-1";
const PHONE = "+14085551234";

function seedUser(extra: Record<string, unknown> = {}) {
  hoisted.docs.set(`users/${UID}`, { phone: PHONE, ...extra });
}

function seedSession(extra: Record<string, unknown> = {}) {
  hoisted.docs.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", userId: UID, seniorId: "senior-1", ...extra });
}

describe("handleWebChatTurn", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
    hoisted.claimMock.mockResolvedValue(true);
    hoisted.qaMock.mockResolvedValue("Here's what I found!");
  });

  it("happy path with a Linq chat: mirrors inbound once, runs agent without skipSend, never mirrors the reply manually", async () => {
    seedUser();
    seedSession();

    const res = await handleWebChatTurn({ uid: UID, message: "book maria for friday" });

    expect(res.status).toBe("ok");
    expect(res.available).toBe(true);
    expect(res.reply).toBe("Here's what I found!");

    // Inbound mirror happened exactly once, before the agent ran
    expect(hoisted.mirrorMock).toHaveBeenCalledTimes(1);
    expect(hoisted.mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: UID, direction: "inbound", source: "cara_web" }),
    );
    expect(hoisted.mirrorMock.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.qaMock.mock.invocationCallOrder[0]);

    // Agent ran on the Linq path (sendSplit auto-mirrors the reply)
    expect(hoisted.qaMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", skipSend: false }),
    );

    // Lock claimed and released
    expect(hoisted.claimMock).toHaveBeenCalledOnce();
    expect(hoisted.releaseMock).toHaveBeenCalledOnce();
  });

  it("no Linq chat: agent runs with skipSend and the reply is mirrored manually exactly once", async () => {
    seedUser();
    seedSession({ chatId: undefined });

    const res = await handleWebChatTurn({ uid: UID, message: "hi cara" });

    expect(res.status).toBe("ok");
    expect(hoisted.qaMock).toHaveBeenCalledWith(expect.objectContaining({ chatId: "", skipSend: true }));

    const outbound = hoisted.mirrorMock.mock.calls.filter(([p]: any[]) => p.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0][0]).toMatchObject({ userId: UID, text: "Here's what I found!", source: "cara_web" });
  });

  it("opted-out user: skipSend branch even with a chatId, response carries optedOut", async () => {
    seedUser();
    seedSession({ optedOut: true });

    const res = await handleWebChatTurn({ uid: UID, message: "hello?" });

    expect(res.status).toBe("ok");
    expect(res.optedOut).toBe(true);
    expect(hoisted.qaMock).toHaveBeenCalledWith(expect.objectContaining({ skipSend: true }));
  });

  it("rate limit exceeded: rateLimited status, agent never runs, zero thread writes", async () => {
    seedUser();
    seedSession();
    hoisted.docs.set(`rate_limits/web_${UID}`, { count: 10, windowStart: Date.now() });

    const res = await handleWebChatTurn({ uid: UID, message: "spam" });

    expect(res.status).toBe("rateLimited");
    expect(res.rateLimited).toBe(true);
    expect(hoisted.qaMock).not.toHaveBeenCalled();
    expect(hoisted.mirrorMock).not.toHaveBeenCalled();
  });

  it("first-ever call survives the missing rate doc (set, not update)", async () => {
    seedUser();
    seedSession();

    const res = await handleWebChatTurn({ uid: UID, message: "first message" });

    expect(res.status).toBe("ok");
    expect(hoisted.docs.get(`rate_limits/web_${UID}`)).toMatchObject({ count: 1 });
  });

  it("mid-onboarding session: finishSetup, agent never runs, zero thread writes", async () => {
    seedUser();
    seedSession({ onboardingStep: "caregiver_credentials" });

    const res = await handleWebChatTurn({ uid: UID, message: "am i done?" });

    expect(res.status).toBe("finishSetup");
    expect(res.available).toBe(false);
    expect(hoisted.qaMock).not.toHaveBeenCalled();
    expect(hoisted.mirrorMock).not.toHaveBeenCalled();
  });

  it("no phone on file: notSetUp with zero thread writes", async () => {
    hoisted.docs.set(`users/${UID}`, {});

    const res = await handleWebChatTurn({ uid: UID, message: "hi" });

    expect(res.status).toBe("notSetUp");
    expect(hoisted.mirrorMock).not.toHaveBeenCalled();
  });

  it("no agent session: notSetUp", async () => {
    seedUser();

    const res = await handleWebChatTurn({ uid: UID, message: "hi" });

    expect(res.status).toBe("notSetUp");
    expect(hoisted.qaMock).not.toHaveBeenCalled();
  });

  it("token phone wins over the users-doc phone", async () => {
    hoisted.docs.set(`users/${UID}`, { phone: "(408) 555-9999" });
    hoisted.docs.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", userId: UID, seniorId: "s1" });

    const res = await handleWebChatTurn({ uid: UID, message: "hi", tokenPhone: PHONE });

    expect(res.status).toBe("ok");
    expect(hoisted.qaMock).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE }));
  });

  it("lock never acquired: caraBusy after retries, agent never runs", async () => {
    vi.useFakeTimers();
    try {
      seedUser();
      seedSession();
      hoisted.claimMock.mockResolvedValue(false);

      const promise = handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "c-1" });
      await vi.runAllTimersAsync();
      const res = await promise;

      expect(res.status).toBe("caraBusy");
      expect(res.clientMessageId).toBe("c-1");
      expect(hoisted.claimMock).toHaveBeenCalledTimes(6);
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      expect(hoisted.mirrorMock).not.toHaveBeenCalled();
      expect(hoisted.releaseMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caregiver session: agent gets caregiver persona and missing userId self-heals to the auth uid", async () => {
    seedUser();
    seedSession({ userId: undefined, userType: "caregiver", caregiverId: "cg-9" });

    const res = await handleWebChatTurn({ uid: UID, tokenPhone: PHONE, message: "any shifts?" });

    expect(res.status).toBe("ok");
    expect(hoisted.qaMock).toHaveBeenCalledWith(
      expect.objectContaining({ userType: "caregiver", caregiverId: "cg-9", userId: UID }),
    );
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`)).toMatchObject({ userId: UID });
  });

  it("agent failure: throws AgentUnavailableError and still releases the lock", async () => {
    seedUser();
    seedSession();
    hoisted.qaMock.mockRejectedValue(new Error("model down"));

    await expect(handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "c-2" }))
      .rejects.toBeInstanceOf(AgentUnavailableError);

    expect(hoisted.releaseMock).toHaveBeenCalledOnce();
    // The user message was already mirrored — documented behavior; UI offers retry
    expect(hoisted.mirrorMock).toHaveBeenCalledTimes(1);
  });

  it("retry with the same clientMessageId does not duplicate the inbound mirror", async () => {
    seedUser();
    seedSession();
    hoisted.queryItems.set(`threads/cara_${UID}/messages`, [
      { clientMessageId: "c-3", text: "book maria" },
    ]);

    const res = await handleWebChatTurn({ uid: UID, message: "book maria", clientMessageId: "c-3" });

    expect(res.status).toBe("ok");
    expect(res.clientMessageId).toBe("c-3");
    const inbound = hoisted.mirrorMock.mock.calls.filter(([p]: any[]) => p.direction === "inbound");
    expect(inbound).toHaveLength(0);
    expect(hoisted.qaMock).toHaveBeenCalledOnce();
  });

  // ── /help: exact-string capability commands (web parity with routeIntent) ──
  describe("HELP / CAPABILITIES commands", () => {
    it("HELP answers with the capability reply and never runs the agent (Linq branch sends via sendMessage)", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "HELP" });

      expect(res.status).toBe("ok");
      expect(res.reply).toBe("capability help for client");
      expect(res.showMatches).toBe(false);
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      // Linq branch: sendMessage delivers + auto-mirrors; no manual outbound mirror.
      expect(hoisted.sendLinqMock).toHaveBeenCalledWith("chat-1", "capability help for client");
      const outbound = hoisted.mirrorMock.mock.calls.filter(([p]: any[]) => p.direction === "outbound");
      expect(outbound).toHaveLength(0);
      // Inbound was still mirrored before the reply.
      const inbound = hoisted.mirrorMock.mock.calls.filter(([p]: any[]) => p.direction === "inbound");
      expect(inbound).toHaveLength(1);
    });

    it("matches case-insensitively with surrounding whitespace and slash variants", async () => {
      seedUser();
      seedSession({ chatId: undefined });

      const res = await handleWebChatTurn({ uid: UID, message: "  /capabilities  " });

      expect(res.status).toBe("ok");
      expect(res.reply).toBe("capability help for client");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      // No Linq chat: the reply is mirrored manually exactly once.
      expect(hoisted.sendLinqMock).not.toHaveBeenCalled();
      const outbound = hoisted.mirrorMock.mock.calls.filter(([p]: any[]) => p.direction === "outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0][0]).toMatchObject({ userId: UID, text: "capability help for client", source: "cara_web" });
    });

    it("is role-aware: caregiver sessions get the caregiver reply", async () => {
      seedUser();
      seedSession({ userType: "caregiver", caregiverId: "cg-9" });

      const res = await handleWebChatTurn({ uid: UID, message: "help" });

      expect(res.reply).toBe("capability help for caregiver");
      expect(hoisted.helpMock).toHaveBeenCalledWith("caregiver", undefined, "en");
    });

    it("is role-aware: secondary family members get the family-secondary reply", async () => {
      seedUser();
      seedSession({ isSecondaryMember: true });

      const res = await handleWebChatTurn({ uid: UID, message: "CAPABILITIES" });

      expect(res.reply).toBe("capability help for family-secondary");
      expect(hoisted.helpMock).toHaveBeenCalledWith("family-secondary", undefined, "en");
    });

    it("only an exact command triggers - 'help me find a caregiver' still goes to the agent", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "help me find a caregiver" });

      expect(res.reply).toBe("Here's what I found!");
      expect(hoisted.qaMock).toHaveBeenCalledOnce();
      expect(hoisted.helpMock).not.toHaveBeenCalled();
    });
  });
});
