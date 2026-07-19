import { describe, it, expect, vi, beforeEach } from "vitest";

// U2 unified send pipeline (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md):
// rate check → session resolve → onboarding guard → opt-out → lock → awaited
// inbound mirror → agent → manual reply mirror only on the skipSend branch.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();            // doc path -> data
  const queryItems = new Map<string, any[]>();    // collection path -> items for where() queries
  const writes: Array<{ op: string; path: string; data?: any }> = [];
  const getCallCounts = new Map<string, number>();      // doc path -> get() calls so far
  const failGetOnCall = new Map<string, number>();      // doc path -> 1-based call index to reject

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => {
      const n = (getCallCounts.get(path) ?? 0) + 1;
      getCallCounts.set(path, n);
      if (failGetOnCall.get(path) === n) throw new Error(`simulated get() failure on call ${n} for ${path}`);
      return {
        exists: docs.has(path),
        data: () => docs.get(path),
      };
    }),
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
    getCallCounts,
    failGetOnCall,
    collectionMock: vi.fn((path: string) => makeCollRef(path)),
    claimMock: vi.fn(async (..._args: any[]) => true),
    releaseMock: vi.fn(async (..._args: any[]) => {}),
    mirrorMock: vi.fn(async (..._args: any[]) => {}),
    qaMock: vi.fn(async (..._args: any[]) => "Here's what I found!"),
    helpMock: vi.fn((role: string) => `capability help for ${role}`),
    sendLinqMock: vi.fn(async (..._args: any[]) => {}),
    // U2 active-SMS-flow guard (defaults: no active flow).
    activeFlowMock: vi.fn((..._args: any[]) => false),
    describeFlowMock: vi.fn((..._args: any[]) => null as string | null),
    // U3 turn-idempotency ledger (defaults: fresh claim, settle noop).
    claimLedgerMock: vi.fn(async (..._args: any[]) => "claimed" as "claimed" | "duplicate"),
    settleLedgerMock: vi.fn(async (..._args: any[]) => {}),
    // U3b completed-turn memory boundary (default: success outcome).
    persistTurnMock: vi.fn(async (..._args: any[]): Promise<any> =>
      ({ ok: true, operationId: "op-1", sourceTurnKeyHash: "hash-1", deduplicated: false })),
    reset() {
      docs.clear();
      queryItems.clear();
      writes.length = 0;
      getCallCounts.clear();
      failGetOnCall.clear();
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
  hasActiveSmsFlow: hoisted.activeFlowMock,
  describeInterruptedFlow: hoisted.describeFlowMock,
}));

vi.mock("../utils/webhookLedger", () => ({
  claimWebhookEvent: hoisted.claimLedgerMock,
  settleWebhookEvent: hoisted.settleLedgerMock,
  WEB_TURN_CLAIMS_COLLECTION: "web_turn_claims",
}));

vi.mock("./threadMirror", () => ({
  mirrorToWebThread: hoisted.mirrorMock,
}));

// U3b: stub ONLY persistCompletedTurn — markSessionActivity stays real so the
// U2 activity-write tests keep exercising the shipping write path.
vi.mock("../memory/conversationMemory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/conversationMemory")>();
  return { ...actual, persistCompletedTurn: hoisted.persistTurnMock };
});

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
  // Production sessions ALWAYS carry onboardingStep; a completed one is
  // "complete" permanently. The old fixture omitted it — a state that doesn't
  // exist in prod and masked the U1 block regression. Override per-test.
  hoisted.docs.set(`agent_sessions/${PHONE}`, {
    chatId: "chat-1", userId: UID, seniorId: "senior-1", onboardingStep: "complete", ...extra,
  });
}

describe("handleWebChatTurn", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
    hoisted.claimMock.mockResolvedValue(true);
    hoisted.qaMock.mockResolvedValue("Here's what I found!");
    hoisted.activeFlowMock.mockReturnValue(false);
    hoisted.describeFlowMock.mockReturnValue(null);
    hoisted.claimLedgerMock.mockResolvedValue("claimed");
    hoisted.persistTurnMock.mockResolvedValue({ ok: true, operationId: "op-1", sourceTurnKeyHash: "hash-1", deduplicated: false });
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

  // ── U1: unblock completed sessions; keep mid-onboarding blocked ────────────
  describe("U1 onboarding guard", () => {
    it("completed session (onboardingStep 'complete') runs the agent and returns ok", async () => {
      seedUser();
      seedSession({ onboardingStep: "complete" });

      const res = await handleWebChatTurn({ uid: UID, message: "book maria for friday" });

      expect(res.status).toBe("ok");
      expect(res.available).toBe(true);
      expect(hoisted.qaMock).toHaveBeenCalledOnce();
    });

    it("legacy session with no onboardingStep field runs the agent (ok)", async () => {
      seedUser();
      seedSession({ onboardingStep: undefined });

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("ok");
      expect(hoisted.qaMock).toHaveBeenCalledOnce();
    });

    it("opted-out completed session: reply generated, Linq send skipped", async () => {
      seedUser();
      seedSession({ onboardingStep: "complete", optedOut: true });

      const res = await handleWebChatTurn({ uid: UID, message: "hello?" });

      expect(res.status).toBe("ok");
      expect(res.optedOut).toBe(true);
      expect(hoisted.qaMock).toHaveBeenCalledWith(expect.objectContaining({ skipSend: true }));
      expect(hoisted.sendLinqMock).not.toHaveBeenCalled();
    });
  });

  // ── U2: defer to a fresh in-flight SMS flow ────────────────────────────────
  describe("U2 active-SMS-flow guard", () => {
    it("active flow defers via smsFlowActive: no agent run, lock + claim released, flags untouched", async () => {
      seedUser();
      seedSession({ pendingCancelConfirm: { appointmentId: "a1" } });
      hoisted.activeFlowMock.mockReturnValue(true);
      hoisted.describeFlowMock.mockReturnValue("cancelling that shift");

      const res = await handleWebChatTurn({ uid: UID, message: "who is on friday?", clientMessageId: "c-flow" });

      expect(res.status).toBe("smsFlowActive");
      expect(res.available).toBe(true);
      expect(res.reply).toContain("cancelling that shift");
      expect(res.clientMessageId).toBe("c-flow");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      // Lock released and the turn claim released so a same-id retry isn't wedged.
      expect(hoisted.releaseMock).toHaveBeenCalledOnce();
      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_c-flow`, "failed");
      // Claim released BEFORE the lock: the claim's stale window (10 min) dwarfs
      // the lock TTL (90s), so the expensive resource must go first.
      expect(hoisted.settleLedgerMock.mock.invocationCallOrder[0])
        .toBeLessThan(hoisted.releaseMock.mock.invocationCallOrder[0]);
      // Read-only: the session flag was never cleared/stamped by the web path.
      expect(hoisted.docs.get(`agent_sessions/${PHONE}`)).toMatchObject({
        pendingCancelConfirm: { appointmentId: "a1" },
      });
    });

    it("no active flow: agent runs normally", async () => {
      seedUser();
      seedSession();
      hoisted.activeFlowMock.mockReturnValue(false);

      const res = await handleWebChatTurn({ uid: UID, message: "book maria" });

      expect(res.status).toBe("ok");
      expect(hoisted.qaMock).toHaveBeenCalledOnce();
    });

    it("flag set between the pre-lock snapshot and the lock still defers (guard reads the fresh re-read)", async () => {
      seedUser();
      seedSession(); // clean snapshot at first read
      // Guard is evaluated on the post-lock re-read; simulate the SMS turn having
      // set a flag in the TOCTOU window by having hasActiveSmsFlow report active.
      hoisted.activeFlowMock.mockReturnValue(true);

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("smsFlowActive");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
    });

    it("deferral with no resumable description falls back to a generic grounded notice (no URL)", async () => {
      seedUser();
      seedSession({ pendingInstantPayoutConfirm: true });
      hoisted.activeFlowMock.mockReturnValue(true);
      hoisted.describeFlowMock.mockReturnValue(null);

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("smsFlowActive");
      expect(res.reply).toMatch(/over text/i);
      expect(res.reply).not.toMatch(/https?:\/\//);
    });
  });

  // ── U3: idempotent turns keyed on clientMessageId ──────────────────────────
  describe("U3 turn idempotency", () => {
    it("duplicate claim: status 'duplicate' (NOT 'ok' — the UI must not wait for a mirrored doc), no agent run, no send", async () => {
      seedUser();
      seedSession();
      hoisted.claimLedgerMock.mockResolvedValue("duplicate");

      const res = await handleWebChatTurn({ uid: UID, message: "book maria", clientMessageId: "dup-1" });

      expect(res.status).toBe("duplicate");
      expect(res.reply).toBeTruthy();
      expect(res.clientMessageId).toBe("dup-1");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      expect(hoisted.sendLinqMock).not.toHaveBeenCalled();
      expect(hoisted.mirrorMock).not.toHaveBeenCalled();
      // Never acquired the lock for a duplicate.
      expect(hoisted.claimMock).not.toHaveBeenCalled();
    });

    it("success settles the claim processed", async () => {
      seedUser();
      seedSession();

      await handleWebChatTurn({ uid: UID, message: "book maria", clientMessageId: "ok-1" });

      expect(hoisted.claimLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_ok-1`);
      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_ok-1`, "processed");
    });

    it("agent failure with ZERO tools executed deletes the claim (retry may reprocess)", async () => {
      seedUser();
      seedSession();
      hoisted.qaMock.mockRejectedValue(new Error("model down"));

      await expect(handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "z-1" }))
        .rejects.toBeInstanceOf(AgentUnavailableError);

      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_z-1`, "failed");
    });

    it("agent failure AFTER a tool executed settles processed (retry returns the duplicate reply, not a re-fire)", async () => {
      seedUser();
      seedSession();
      hoisted.qaMock.mockImplementation(async (params: any) => {
        params._toolCallsOut?.push("request_booking"); // a tool committed before the throw
        throw new Error("crash after booking");
      });

      await expect(handleWebChatTurn({ uid: UID, message: "book maria", clientMessageId: "t-1" }))
        .rejects.toBeInstanceOf(AgentUnavailableError);

      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_t-1`, "processed");
    });

    it("lock-unavailable caraBusy after a claim releases the claim (same-id retry not wedged)", async () => {
      vi.useFakeTimers();
      try {
        seedUser();
        seedSession();
        hoisted.claimMock.mockResolvedValue(false);

        const promise = handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "busy-1" });
        await vi.runAllTimersAsync();
        const res = await promise;

        expect(res.status).toBe("caraBusy");
        expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_busy-1`, "failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("malformed clientMessageId (contains '/') bypasses the ledger and still processes", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "bad/id" });

      expect(res.status).toBe("ok");
      expect(hoisted.claimLedgerMock).not.toHaveBeenCalled();
      expect(hoisted.settleLedgerMock).not.toHaveBeenCalled();
      expect(hoisted.qaMock).toHaveBeenCalledOnce();
    });

    it("missing clientMessageId bypasses the ledger entirely", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("ok");
      expect(hoisted.claimLedgerMock).not.toHaveBeenCalled();
      expect(hoisted.settleLedgerMock).not.toHaveBeenCalled();
    });

    it("agent failure after ONLY read-only (get_*/list_*) tools deletes the claim — a retry can reprocess", async () => {
      seedUser();
      seedSession();
      hoisted.qaMock.mockImplementation(async (params: any) => {
        params._toolCallsOut?.push("get_payout_status", "list_upcoming_shifts");
        throw new Error("crash after reads only");
      });

      await expect(handleWebChatTurn({ uid: UID, message: "payout status?", clientMessageId: "r-1" }))
        .rejects.toBeInstanceOf(AgentUnavailableError);

      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_r-1`, "failed");
    });
  });

  // ── U3b memory-grounding (R8/R9): completed-turn persistence parity ────────
  describe("U3b completed-turn memory (persistCompletedTurn)", () => {
    it("successful agent turn persists ONE completed turn: channel web, validated clientMessageId as source key, extraction ON for clients", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "mom prefers mornings", clientMessageId: "c-77" });

      expect(res.status).toBe("ok");
      expect(hoisted.persistTurnMock).toHaveBeenCalledTimes(1);
      expect(hoisted.persistTurnMock).toHaveBeenCalledWith(expect.objectContaining({
        channel:       "web",
        sourceKey:     "c-77",
        phone:         PHONE,
        userId:        UID,
        userText:      "mom prefers mornings",
        assistantText: "Here's what I found!",
        extractFacts:  true,
        adoptExistingRows: true,
      }));
      // Persistence runs AFTER the agent produced the reply.
      expect(hoisted.qaMock.mock.invocationCallOrder[0])
        .toBeLessThan(hoisted.persistTurnMock.mock.invocationCallOrder[0]);
    });

    it("caregiver session: turn persists but family-fact extraction is OFF (R8)", async () => {
      seedUser();
      seedSession({ userType: "caregiver", caregiverId: "cg-9" });

      const res = await handleWebChatTurn({ uid: UID, message: "any shifts?", clientMessageId: "c-cg" });

      expect(res.status).toBe("ok");
      expect(hoisted.persistTurnMock).toHaveBeenCalledWith(expect.objectContaining({
        sourceKey: "c-cg", extractFacts: false,
      }));
    });

    it("a typed persistence failure does not fail the reply and the claim still settles processed (R8)", async () => {
      seedUser();
      seedSession();
      hoisted.persistTurnMock.mockResolvedValue({ ok: false, errorClass: "FirebaseError" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await handleWebChatTurn({ uid: UID, message: "hello mom question", clientMessageId: "c-f1" });

        expect(res.status).toBe("ok");
        expect(res.reply).toBe("Here's what I found!");
        expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_c-f1`, "processed");
        // R21: aggregate fields only — no phone, no message, no reply.
        const serialized = JSON.stringify(warnSpy.mock.calls);
        expect(serialized).toContain("memory_turn_persistence_skipped");
        expect(serialized).not.toContain(PHONE);
        expect(serialized).not.toContain("hello mom question");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("even a throwing persistence boundary cannot fail the reply (belt-and-suspenders)", async () => {
      seedUser();
      seedSession();
      hoisted.persistTurnMock.mockRejectedValue(new Error("unexpected"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "c-f2" });
        expect(res.status).toBe("ok");
        expect(res.reply).toBe("Here's what I found!");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("missing clientMessageId: turn persists with an empty source key (no idempotency promise)", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("ok");
      expect(hoisted.persistTurnMock).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: "" }));
    });

    it("malformed clientMessageId is not used as a source key (same judgment as the claim ledger)", async () => {
      seedUser();
      seedSession();

      await handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "bad/id" });

      expect(hoisted.persistTurnMock).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: "" }));
    });

    it("duplicate clientMessageId retry: NO second persistence and no agent re-run (no double side effects)", async () => {
      seedUser();
      seedSession();
      hoisted.claimLedgerMock.mockResolvedValue("duplicate");

      const res = await handleWebChatTurn({ uid: UID, message: "book maria", clientMessageId: "dup-9" });

      expect(res.status).toBe("duplicate");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
      expect(hoisted.persistTurnMock).not.toHaveBeenCalled();
    });

    it("agent failure: nothing to persist (no completed turn)", async () => {
      seedUser();
      seedSession();
      hoisted.qaMock.mockRejectedValue(new Error("model down"));

      await expect(handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "c-err" }))
        .rejects.toBeInstanceOf(AgentUnavailableError);

      expect(hoisted.persistTurnMock).not.toHaveBeenCalled();
    });

    it("HELP command: static capability reply is not an agent turn — never persisted", async () => {
      seedUser();
      seedSession();

      const res = await handleWebChatTurn({ uid: UID, message: "HELP", clientMessageId: "c-help" });

      expect(res.status).toBe("ok");
      expect(hoisted.persistTurnMock).not.toHaveBeenCalled();
    });
  });

  // ── U2 memory-grounding (R1): activity marking at verified ingress ─────────
  describe("U2 activity marking (lastMessageAt)", () => {
    const activityWrites = () =>
      hoisted.writes.filter(
        (w) => w.path === `agent_sessions/${PHONE}` && w.op === "update" && w.data && "lastMessageAt" in w.data,
      );

    it("accepted turn writes lastMessageAt as a server timestamp BEFORE the agent runs", async () => {
      seedUser();
      seedSession();
      let sessionAtAgentTime: any;
      hoisted.qaMock.mockImplementation(async () => {
        sessionAtAgentTime = { ...hoisted.docs.get(`agent_sessions/${PHONE}`) };
        return "ok!";
      });

      const res = await handleWebChatTurn({ uid: UID, message: "book maria" });

      expect(res.status).toBe("ok");
      expect(activityWrites()).toHaveLength(1);
      expect(activityWrites()[0].data.lastMessageAt).toEqual({ __serverTimestamp: true });
      // Written before model execution (KTD2).
      expect(sessionAtAgentTime.lastMessageAt).toEqual({ __serverTimestamp: true });
    });

    it("model failure still leaves the activity written", async () => {
      seedUser();
      seedSession();
      hoisted.qaMock.mockRejectedValue(new Error("model down"));

      await expect(handleWebChatTurn({ uid: UID, message: "hi" }))
        .rejects.toBeInstanceOf(AgentUnavailableError);

      expect(activityWrites()).toHaveLength(1);
      expect(hoisted.docs.get(`agent_sessions/${PHONE}`).lastMessageAt).toEqual({ __serverTimestamp: true });
    });

    it("rate-limited request does not write activity", async () => {
      seedUser();
      seedSession();
      hoisted.docs.set(`rate_limits/web_${UID}`, { count: 10, windowStart: Date.now() });

      const res = await handleWebChatTurn({ uid: UID, message: "spam" });

      expect(res.status).toBe("rateLimited");
      expect(activityWrites()).toHaveLength(0);
    });

    it("missing session (notSetUp) does not write activity", async () => {
      seedUser();

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("notSetUp");
      expect(activityWrites()).toHaveLength(0);
    });

    it("unbound identity (session bound to another uid, no verified token phone) does not write activity", async () => {
      seedUser();
      seedSession({ userId: "someone-else" });

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("notSetUp");
      expect(activityWrites()).toHaveLength(0);
      expect(hoisted.qaMock).not.toHaveBeenCalled();
    });

    it("mid-onboarding session (finishSetup) does not write activity", async () => {
      seedUser();
      seedSession({ onboardingStep: "caregiver_credentials" });

      const res = await handleWebChatTurn({ uid: UID, message: "hi" });

      expect(res.status).toBe("finishSetup");
      expect(activityWrites()).toHaveLength(0);
    });
  });

  // ── Post-lock lifecycle (launch-readiness review fixes) ────────────────────
  describe("post-lock re-read lifecycle", () => {
    it("a throw in the post-lock re-read releases the lock AND deletes the claim (no leak)", async () => {
      seedUser();
      seedSession();
      // Call 1 = pre-lock read, call 2 = post-lock fresh re-read → reject.
      hoisted.failGetOnCall.set(`agent_sessions/${PHONE}`, 2);

      await expect(handleWebChatTurn({ uid: UID, message: "hi", clientMessageId: "leak-1" }))
        .rejects.toThrow(/simulated get\(\) failure/);

      // Lock released exactly once (finally), claim deleted (zero tools ran).
      expect(hoisted.releaseMock).toHaveBeenCalledOnce();
      expect(hoisted.settleLedgerMock).toHaveBeenCalledWith("web_turn_claims", `${PHONE}_leak-1`, "failed");
      expect(hoisted.qaMock).not.toHaveBeenCalled();
    });

    it("a STOP processed while waiting on the lock kills the Linq send (optedOut recomputed post-lock — TCPA)", async () => {
      seedUser();
      seedSession(); // chatId present, not opted out at the pre-lock read
      // The SMS router processes STOP while this turn contends for the lock:
      // mutate the session doc during claimInboundProcessing, before the re-read.
      hoisted.claimMock.mockImplementation(async () => {
        hoisted.docs.set(`agent_sessions/${PHONE}`, {
          ...hoisted.docs.get(`agent_sessions/${PHONE}`),
          optedOut: true,
        });
        return true;
      });

      const res = await handleWebChatTurn({ uid: UID, message: "hello?" });

      expect(res.status).toBe("ok");
      expect(res.optedOut).toBe(true);
      // Fresh optedOut → skipSend branch even though a chatId exists.
      expect(hoisted.qaMock).toHaveBeenCalledWith(expect.objectContaining({ skipSend: true, chatId: "" }));
      expect(hoisted.sendLinqMock).not.toHaveBeenCalled();
    });
  });
});
