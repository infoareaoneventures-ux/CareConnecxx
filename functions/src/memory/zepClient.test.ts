import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// U1: typed Zep context outcomes + strict/best-effort write adapters +
// privacy-safe failure logging. The Zep SDK and firebase-admin are mocked at
// the module boundary; every test drives the adapters through the public API.

process.env.ZEP_API_KEY = "test-key";

const h = vi.hoisted(() => ({
  getUserContext:     vi.fn(),
  getThread:          vi.fn(),
  addMessages:        vi.fn(),
  graphSearch:        vi.fn(),
  graphAdd:           vi.fn(),
  edgeGetByUserId:    vi.fn(),
  edgeUpdate:         vi.fn(),
  edgeDelete:         vi.fn(),
  episodeDelete:      vi.fn(),
  getContextTemplate: vi.fn(async () => ({})),
  updateContextTemplate: vi.fn(async () => ({})),
  // U4a: controllable per-user reconciliation state (KTD9 reader suppression).
  reconciliation: { pending: false, storageMasked: false, zepMasked: false, pendingOperationIds: [] as string[] },
}));

// U4a: the graph-search reader imports the suppression check from
// memoryOperations — mock with controllable state.
vi.mock("./memoryOperations", () => ({
  getMemoryReconciliationState: vi.fn(async () => ({ ...h.reconciliation })),
  hasUnresolvedReconciliation: vi.fn(async () => h.reconciliation.pending),
}));

vi.mock("@getzep/zep-cloud", () => ({
  ZepClient: class {
    thread = { get: h.getThread, getUserContext: h.getUserContext, addMessages: h.addMessages };
    graph = {
      search: h.graphSearch,
      add: h.graphAdd,
      edge: { getByUserId: h.edgeGetByUserId, update: h.edgeUpdate, delete: h.edgeDelete },
      episode: { delete: h.episodeDelete },
    };
    context = {
      getContextTemplate: h.getContextTemplate,
      createContextTemplate: vi.fn(async () => ({})),
      updateContextTemplate: h.updateContextTemplate,
    };
    user = { add: vi.fn(async () => ({})), update: vi.fn(async () => ({})) };
  },
}));

vi.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: () => ({}) }),
        set: async () => ({}),
      }),
    }),
  });
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  getZepContextResult,
  getZepContext,
  addUserMessageToZep,
  addUserMessageToZepStrict,
  addUserMessageToZepBestEffort,
  addAssistantMessageToZep,
  addAssistantMessageToZepStrict,
  addAssistantMessageToZepBestEffort,
  searchZepMemory,
  searchZepMemoryResult,
  zepEdgeFactMatches,
  findZepEdgesMatchingFact,
  verifyZepForgottenFactAbsent,
  invalidateZepEdgeStrict,
  deleteZepEdgeStrict,
  deleteZepEpisodeStrict,
  ZEP_EDGE_PAGE_SIZE,
} from "./zepClient";

const THREAD_ID = "thread-abc-123";

// 400-level errors are non-retryable, so tests never sit through the retry
// helper's real-clock backoff sleeps.
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy:  ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.getUserContext.mockReset();
  h.getThread.mockReset().mockResolvedValue({ messages: [] });
  h.addMessages.mockReset();
  h.graphSearch.mockReset();
  h.edgeGetByUserId.mockReset();
  h.edgeUpdate.mockReset().mockResolvedValue({});
  h.edgeDelete.mockReset().mockResolvedValue({});
  h.episodeDelete.mockReset().mockResolvedValue({});
  h.reconciliation = { pending: false, storageMasked: false, zepMasked: false, pendingOperationIds: [] };
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy  = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  vi.useRealTimers();
});

function loggedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => c.map(String).join(" "));
}

describe("getZepContextResult", () => {
  it("returns loaded with the context when Zep has content", async () => {
    h.getUserContext.mockResolvedValueOnce({ context: "## CARE CONTEXT\nMom is allergic to shellfish" });
    const result = await getZepContextResult(THREAD_ID);
    expect(result.status).toBe("loaded");
    expect(result.context).toBe("## CARE CONTEXT\nMom is allergic to shellfish");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.errorClass).toBeUndefined();
  });

  it("returns empty (not unavailable) when Zep answers successfully with no content", async () => {
    h.getUserContext.mockResolvedValueOnce({ context: "" });
    const result = await getZepContextResult(THREAD_ID);
    expect(result.status).toBe("empty");
    expect(result.context).toBe("");
    // A legitimate empty is not a failure — nothing is logged.
    expect(loggedLines(errorSpy).join("")).toBe("");
    expect(loggedLines(warnSpy).join("")).toBe("");
  });

  it("treats a whitespace-only or missing context as empty", async () => {
    h.getUserContext.mockResolvedValueOnce({ context: "  \n " });
    expect((await getZepContextResult(THREAD_ID)).status).toBe("empty");
    h.getUserContext.mockResolvedValueOnce({ context: undefined });
    expect((await getZepContextResult(THREAD_ID)).status).toBe("empty");
  });

  it("fails closed when the facts-only template lookup fails", async () => {
    h.getUserContext.mockRejectedValueOnce(badRequest("template not found"));
    const result = await getZepContextResult(THREAD_ID);
    expect(result.status).toBe("unavailable");
    expect(result.context).toBe("");
    expect(h.getUserContext).toHaveBeenCalledTimes(1);
    expect(h.getUserContext.mock.calls[0][1]).toEqual({ templateId: "cara-eldercare" });
    expect(h.getUserContext.mock.calls[0][2]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("returns unavailable with a sanitized error class when both lookups fail", async () => {
    h.getUserContext
      .mockRejectedValueOnce(new TypeError(`fetch failed https://api.getzep.com/threads/${THREAD_ID}/context`))
      .mockRejectedValueOnce(new TypeError(`fetch failed https://api.getzep.com/threads/${THREAD_ID}/context`));
    const result = await getZepContextResult(THREAD_ID);
    expect(result.status).toBe("unavailable");
    expect(result.context).toBe("");
    expect(result.errorClass).toBe("TypeError");
  });

  it("returns timeout and aborts the request when Zep hangs past the cap", async () => {
    vi.useFakeTimers();
    h.getUserContext.mockImplementation(() => new Promise(() => {})); // hangs forever
    const pending = getZepContextResult(THREAD_ID, { timeoutMs: 6_000 });
    await vi.advanceTimersByTimeAsync(6_001);
    const result = await pending;
    expect(result.status).toBe("timeout");
    expect(result.context).toBe("");
    // The losing request was actually cancelled via the abortSignal.
    expect(h.getUserContext.mock.calls[0][2]?.abortSignal?.aborted).toBe(true);
    // The timeout log is privacy-safe: correlation hash, never the thread ID.
    const warned = loggedLines(warnSpy).join("\n");
    expect(warned).toContain("zep_timeout");
    expect(warned).not.toContain(THREAD_ID);
  });

  it("never emits a delayed timeout log after a fast success", async () => {
    vi.useFakeTimers();
    h.getUserContext.mockResolvedValueOnce({ context: "fast" });
    const result = await getZepContextResult(THREAD_ID, { timeoutMs: 6_000 });
    expect(result.status).toBe("loaded");
    // A fast success used to leave the losing Promise.race timer armed —
    // advance well past the cap and prove the timer was cleared.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loggedLines(warnSpy).join("")).toBe("");
    expect(loggedLines(errorSpy).join("")).toBe("");
  });

  it("failure logs carry operation + error class + correlation hash, never the thread ID or message", async () => {
    h.getUserContext.mockRejectedValue(new TypeError(`connect ECONNREFUSED for ${THREAD_ID}`));
    await getZepContextResult(THREAD_ID);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.zep_failure).toBe(true);
    expect(entry.operation).toBe("getZepContext");
    expect(entry.error_class).toBe("TypeError");
    expect(entry.correlation).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.error_message).toBeUndefined();
    expect(line).not.toContain(THREAD_ID);
    expect(line).not.toContain("ECONNREFUSED for");
  });
});

describe("getZepContext (legacy string read)", () => {
  it("returns the context only when loaded", async () => {
    h.getUserContext.mockResolvedValueOnce({ context: "hello" });
    await expect(getZepContext(THREAD_ID)).resolves.toBe("hello");
  });

  it("flattens unavailable to '' — health inference from this string is impossible by design", async () => {
    h.getUserContext.mockRejectedValue(badRequest("down"));
    await expect(getZepContext(THREAD_ID)).resolves.toBe("");
  });
});

describe("strict write adapters", () => {
  it("addUserMessageToZepStrict returns the provider messageUuids and forwards the deterministic uuid", async () => {
    h.addMessages.mockResolvedValueOnce({ messageUuids: ["provider-uuid-1"] });
    const result = await addUserMessageToZepStrict({
      threadId: THREAD_ID,
      content:  "Mom prefers morning visits",
      userName: "Anahi",
      sentAt:   new Date("2026-07-17T10:00:00.000Z"),
      uuid:     "det-uuid-user-1",
    });
    expect(result).toEqual({ messageUuids: ["provider-uuid-1"] });
    expect(h.addMessages).toHaveBeenCalledWith(THREAD_ID, {
      messages: [expect.objectContaining({
        uuid:      "det-uuid-user-1",
        role:      "user",
        name:      "Anahi",
        content:   "Mom prefers morning visits",
        createdAt: "2026-07-17T10:00:00.000Z",
        metadata: { careconnecxxMessageKey: "det-uuid-user-1" },
      })],
    });
  });

  it("addAssistantMessageToZepStrict carries the original turn timestamp, not dispatch time", async () => {
    h.addMessages.mockResolvedValueOnce({ messageUuids: ["provider-uuid-2"] });
    const result = await addAssistantMessageToZepStrict({
      threadId: THREAD_ID,
      content:  "Got it — I'll note that.",
      sentAt:   new Date("2026-07-17T10:00:05.000Z"),
      uuid:     "det-uuid-assistant-1",
    });
    expect(result).toEqual({ messageUuids: ["provider-uuid-2"] });
    expect(h.addMessages.mock.calls[0][1].messages[0]).toMatchObject({
      uuid:      "det-uuid-assistant-1",
      role:      "assistant",
      name:      "Evia",
      createdAt: "2026-07-17T10:00:05.000Z",
      metadata: { careconnecxxMessageKey: "det-uuid-assistant-1" },
    });
  });

  it("reconciles a provider-assigned UUID by the durable metadata key before retrying", async () => {
    h.getThread.mockResolvedValueOnce({
      messages: [{
        uuid: "provider-assigned-uuid",
        role: "user",
        content: "stored",
        metadata: { careconnecxxMessageKey: "det-uuid-user-1" },
      }],
    });

    await expect(addUserMessageToZepStrict({
      threadId: THREAD_ID,
      content: "Mom prefers morning visits",
      userName: "Anahi",
      uuid: "det-uuid-user-1",
    })).resolves.toEqual({
      messageUuids: ["provider-assigned-uuid"],
      deduplicated: true,
    });
    expect(h.addMessages).not.toHaveBeenCalled();
  });

  it("fails closed when the reconciliation read fails instead of risking a duplicate", async () => {
    h.getThread.mockRejectedValueOnce(badRequest("thread read failed"));

    await expect(addAssistantMessageToZepStrict({
      threadId: THREAD_ID,
      content: "Stored reply",
      uuid: "det-uuid-assistant-1",
    })).rejects.toThrow("thread read failed");
    expect(h.addMessages).not.toHaveBeenCalled();
  });

  it("throws to the caller when the write fails — the retry worker must see the failure", async () => {
    h.addMessages.mockRejectedValueOnce(badRequest("invalid thread"));
    await expect(addUserMessageToZepStrict({
      threadId: THREAD_ID, content: "hi", userName: "Anahi",
    })).rejects.toThrow("invalid thread");

    h.addMessages.mockRejectedValueOnce(badRequest("invalid thread"));
    await expect(addAssistantMessageToZepStrict({
      threadId: THREAD_ID, content: "hi",
    })).rejects.toThrow("invalid thread");
  });

  it("returns an empty uuid list when the provider response omits messageUuids", async () => {
    h.addMessages.mockResolvedValueOnce({});
    const result = await addUserMessageToZepStrict({ threadId: THREAD_ID, content: "hi", userName: "Anahi" });
    expect(result.messageUuids).toEqual([]);
  });
});

describe("best-effort wrappers", () => {
  it("swallow write failures without throwing", async () => {
    h.addMessages.mockRejectedValue(badRequest("down"));
    await expect(addUserMessageToZepBestEffort({
      threadId: THREAD_ID, content: "hi", userName: "Anahi",
    })).resolves.toBeUndefined();
    await expect(addAssistantMessageToZepBestEffort({
      threadId: THREAD_ID, content: "hi",
    })).resolves.toBeUndefined();
    // Failure is still observable in logs (sanitized), just never thrown.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("legacy names are aliases of the explicitly-named best-effort wrappers", () => {
    expect(addUserMessageToZep).toBe(addUserMessageToZepBestEffort);
    expect(addAssistantMessageToZep).toBe(addAssistantMessageToZepBestEffort);
  });

  it("write-failure logs contain no thread ID", async () => {
    h.addMessages.mockRejectedValueOnce(badRequest("down"));
    await addUserMessageToZepBestEffort({ threadId: THREAD_ID, content: "hi", userName: "Anahi" });
    const line = String(errorSpy.mock.calls[0][0]);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.operation).toBe("addUserMessageToZep");
    expect(entry.correlation).toMatch(/^[0-9a-f]{12}$/);
    expect(line).not.toContain(THREAD_ID);
  });
});

describe("searchZepMemory logging privacy", () => {
  it("logs neither the Zep user ID nor the query text on failure", async () => {
    h.graphSearch.mockRejectedValueOnce(badRequest("search down"));
    const result = await searchZepMemory("14155551234", "what medications does mom take");
    expect(result).toBe("");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).not.toContain("14155551234");
    expect(line).not.toContain("medications");
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.operation).toBe("searchZepMemory");
    expect(entry.correlation).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ── U4a: reconciliation suppression at the graph-search reader (KTD9) ────────

describe("searchZepMemoryResult — reconciliation suppression (U4a)", () => {
  const ZEP_USER = "14155551234";
  const APP_USER = "app-user-1";

  it("returns a typed reconciliation_pending marker WITHOUT calling Zep while the user's Zep targets are unresolved", async () => {
    h.reconciliation = { pending: true, storageMasked: true, zepMasked: true, pendingOperationIds: ["forget_x"] };
    const result = await searchZepMemoryResult(ZEP_USER, "shellfish allergy", { appUserId: APP_USER });
    expect(result).toEqual({ status: "reconciliation_pending", facts: "" });
    expect(h.graphSearch).not.toHaveBeenCalled();
  });

  it("legacy string searchZepMemory flattens the suppressed state to '' — stale edges cannot leak", async () => {
    h.reconciliation = { pending: true, storageMasked: false, zepMasked: true, pendingOperationIds: ["forget_x"] };
    h.graphSearch.mockResolvedValueOnce({ edges: [{ fact: "Mom is allergic to shellfish" }] });
    const result = await searchZepMemory(ZEP_USER, "allergies", APP_USER);
    expect(result).toBe("");
    expect(h.graphSearch).not.toHaveBeenCalled();
  });

  it("per-store: a user whose Zep targets confirmed searches normally even while Storage is still masked", async () => {
    h.reconciliation = { pending: true, storageMasked: true, zepMasked: false, pendingOperationIds: ["forget_x"] };
    h.graphSearch.mockResolvedValueOnce({ edges: [{ fact: "Mom prefers morning visits" }] });
    const result = await searchZepMemoryResult(ZEP_USER, "visits", { appUserId: APP_USER });
    expect(result).toEqual({ status: "loaded", facts: "- Mom prefers morning visits" });
  });

  it("all-clear users get loaded/empty statuses as before", async () => {
    h.graphSearch.mockResolvedValueOnce({ edges: [] });
    expect(await searchZepMemoryResult(ZEP_USER, "anything", { appUserId: APP_USER }))
      .toEqual({ status: "empty", facts: "" });
  });

  it("provider failure is a typed unavailable — distinct from reconciliation_pending", async () => {
    h.graphSearch.mockRejectedValueOnce(badRequest("down"));
    expect(await searchZepMemoryResult(ZEP_USER, "anything", { appUserId: APP_USER }))
      .toEqual({ status: "unavailable", facts: "" });
  });

  it("callers without an appUserId (no verified app identity) still search — suppression requires the app key", async () => {
    h.reconciliation = { pending: true, storageMasked: true, zepMasked: true, pendingOperationIds: ["forget_x"] };
    h.graphSearch.mockResolvedValueOnce({ edges: [] });
    const result = await searchZepMemoryResult(ZEP_USER, "anything");
    expect(result.status).toBe("empty");
    expect(h.graphSearch).toHaveBeenCalledTimes(1);
  });
});

// ── U4b: graph edge/episode adapters for correction/forget propagation ───────
// Strict tier: provider failure throws (the worker's lease/backoff owns
// retries); already-deleted/not-found is SUCCESS; scope is single UUIDs — no
// whole-graph/user/thread deletion exists in this surface.

function notFound(message = "edge not found"): Error {
  return Object.assign(new Error(message), { status: 404 });
}

describe("zepEdgeFactMatches (pure matcher)", () => {
  const TARGET = "Mom is allergic to penicillin";

  it("matches normalized containment in either direction", () => {
    expect(zepEdgeFactMatches("mom is ALLERGIC to Penicillin.", TARGET)).toBe(true);
    expect(zepEdgeFactMatches("allergic to penicillin", TARGET)).toBe(true);
    expect(zepEdgeFactMatches(TARGET, "penicillin")).toBe(true);
  });

  it("matches a rephrased edge fact through content-word overlap", () => {
    // Zep rephrases: same content words (mom, allergic, penicillin) survive.
    expect(zepEdgeFactMatches("User's mom Margaret is allergic to penicillin", TARGET)).toBe(true);
  });

  it("does not match unrelated facts", () => {
    expect(zepEdgeFactMatches("Mom prefers morning visits", TARGET)).toBe(false);
    expect(zepEdgeFactMatches("Daughter Jane lives in Austin", TARGET)).toBe(false);
  });

  it("never matches empty inputs", () => {
    expect(zepEdgeFactMatches("", TARGET)).toBe(false);
    expect(zepEdgeFactMatches("anything", "")).toBe(false);
  });
});

describe("findZepEdgesMatchingFact", () => {
  const ZEP_USER = "14155551234";

  it("searches the user's edges and returns ONLY matching uuids + episode refs", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([
        { uuid: "edge-1", fact: "mom is allergic to penicillin", episodes: ["ep-1", "ep-2"] },
        { uuid: "edge-2", fact: "mom prefers morning visits", episodes: ["ep-3"] },
        { uuid: "edge-3", fact: "User's mom is allergic to penicillin medication" },
    ]);
    const matches = await findZepEdgesMatchingFact({ zepUserId: ZEP_USER, factText: "Mom is allergic to penicillin" });
    expect(matches).toEqual([
      { uuid: "edge-1", episodes: ["ep-1", "ep-2"] },
      { uuid: "edge-3", episodes: [] },
    ]);
    expect(h.edgeGetByUserId).toHaveBeenCalledWith(ZEP_USER, { limit: ZEP_EDGE_PAGE_SIZE });
    expect(h.graphSearch).not.toHaveBeenCalled();
  });

  it("paginates the provider edge cursor so a matching fact after the first page is not skipped", async () => {
    const firstPage = Array.from({ length: ZEP_EDGE_PAGE_SIZE }, (_, index) => ({
      uuid: `edge-${index}`,
      fact: "unrelated preference",
      episodes: [],
    }));
    h.edgeGetByUserId
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ uuid: "edge-later", fact: "mom is allergic to penicillin", episodes: ["ep-later"] }]);

    await expect(findZepEdgesMatchingFact({ zepUserId: ZEP_USER, factText: "Mom is allergic to penicillin" }))
      .resolves.toEqual([{ uuid: "edge-later", episodes: ["ep-later"] }]);

    expect(h.edgeGetByUserId).toHaveBeenNthCalledWith(1, ZEP_USER, { limit: ZEP_EDGE_PAGE_SIZE });
    expect(h.edgeGetByUserId).toHaveBeenNthCalledWith(2, ZEP_USER, {
      limit: ZEP_EDGE_PAGE_SIZE,
      uuidCursor: `edge-${ZEP_EDGE_PAGE_SIZE - 1}`,
    });
  });

  it("returns [] without calling Zep for empty inputs", async () => {
    expect(await findZepEdgesMatchingFact({ zepUserId: "", factText: "x" })).toEqual([]);
    expect(await findZepEdgesMatchingFact({ zepUserId: ZEP_USER, factText: "  " })).toEqual([]);
    expect(h.edgeGetByUserId).not.toHaveBeenCalled();
  });

  it("THROWS on provider failure — the retry worker must see it", async () => {
    h.edgeGetByUserId.mockRejectedValueOnce(badRequest("search down"));
    await expect(findZepEdgesMatchingFact({ zepUserId: ZEP_USER, factText: "anything at all" }))
      .rejects.toThrow("search down");
  });
});

describe("verifyZepForgottenFactAbsent", () => {
  const ZEP_USER = "14155551234";
  const FACT = "Mom is allergic to penicillin";

  it("requires both the paginated graph scan and the rendered thread context to be clear", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([]);
    h.getUserContext.mockResolvedValueOnce({ context: "No matching memory remains." });

    await expect(verifyZepForgottenFactAbsent({
      zepUserId: ZEP_USER,
      factText: FACT,
      threadId: THREAD_ID,
    })).resolves.toBeUndefined();
    expect(h.getUserContext).toHaveBeenCalledWith(
      THREAD_ID,
      { templateId: "cara-eldercare" },
    );
  });

  it("throws when the post-delete graph scan or rendered context still exposes the retired fact", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([{ uuid: "edge-stale", fact: FACT, episodes: [] }]);
    await expect(verifyZepForgottenFactAbsent({ zepUserId: ZEP_USER, factText: FACT, threadId: THREAD_ID }))
      .rejects.toThrow("zep_fact_still_present_in_graph");

    h.edgeGetByUserId.mockResolvedValueOnce([]);
    h.getUserContext.mockResolvedValueOnce({ context: "Care context: Mom has an allergic reaction to penicillin." });
    await expect(verifyZepForgottenFactAbsent({ zepUserId: ZEP_USER, factText: FACT, threadId: THREAD_ID }))
      .rejects.toThrow("zep_fact_still_present_in_context");
  });

  it("OTHER facts covering ≥80% of the target's content words across the blob do NOT fail verification (bag-of-words false positive)", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([]);
    // No single line matches the target ("Mom is allergic to penicillin"),
    // but the blob's pooled words (mom + allergic + penicillin) previously
    // tripped the whole-context ≥80% overlap and terminal-failed the forget,
    // masking the user's memory forever.
    h.getUserContext.mockResolvedValueOnce({
      context: [
        "## CARE CONTEXT",
        "Mom prefers morning visits.",
        "Dad is allergic to shellfish.",
        "The pharmacy mentioned a penicillin shortage in the area.",
      ].join("\n"),
    });

    await expect(verifyZepForgottenFactAbsent({
      zepUserId: ZEP_USER,
      factText: FACT,
      threadId: THREAD_ID,
    })).resolves.toBeUndefined();
  });

  it("a genuine leftover rendered on a single line still fails verification", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([]);
    h.getUserContext.mockResolvedValueOnce({
      context: [
        "## CARE CONTEXT",
        "Dad is allergic to shellfish.",
        "User's mom Margaret is allergic to penicillin.", // one line accounts for the match
      ].join("\n"),
    });

    await expect(verifyZepForgottenFactAbsent({
      zepUserId: ZEP_USER,
      factText: FACT,
      threadId: THREAD_ID,
    })).rejects.toThrow("zep_fact_still_present_in_context");
  });

  it("exact normalized containment anywhere in the blob still fails verification", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([]);
    h.getUserContext.mockResolvedValueOnce({
      context: "Notes: MOM IS ALLERGIC TO PENICILLIN, plus unrelated details.",
    });
    await expect(verifyZepForgottenFactAbsent({
      zepUserId: ZEP_USER,
      factText: FACT,
      threadId: THREAD_ID,
    })).rejects.toThrow("zep_fact_still_present_in_context");
  });

  it("a threadless session verifies via the edge inventory ONLY — no context read, no throw (U-threadless)", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([]);

    await expect(verifyZepForgottenFactAbsent({
      zepUserId: ZEP_USER,
      factText: FACT,
      // no threadId: the session never acquired a Zep thread
    })).resolves.toBeUndefined();
    expect(h.edgeGetByUserId).toHaveBeenCalledTimes(1);
    expect(h.getUserContext).not.toHaveBeenCalled();
  });

  it("a threadless session still fails when the edge inventory holds the fact", async () => {
    h.edgeGetByUserId.mockResolvedValueOnce([{ uuid: "edge-stale", fact: FACT, episodes: [] }]);
    await expect(verifyZepForgottenFactAbsent({ zepUserId: ZEP_USER, factText: FACT }))
      .rejects.toThrow("zep_fact_still_present_in_graph");
    expect(h.getUserContext).not.toHaveBeenCalled();
  });

  it("still requires the zepUserId and fact text", async () => {
    await expect(verifyZepForgottenFactAbsent({ zepUserId: "", factText: FACT }))
      .rejects.toThrow("identifiers required");
    await expect(verifyZepForgottenFactAbsent({ zepUserId: ZEP_USER, factText: "  " }))
      .rejects.toThrow("identifiers required");
    expect(h.edgeGetByUserId).not.toHaveBeenCalled();
  });
});

describe("edge invalidation / deletion adapters (R13/R14)", () => {
  it("invalidateZepEdgeStrict updates the edge with invalidAt", async () => {
    const result = await invalidateZepEdgeStrict({ edgeUuid: "edge-1", invalidAt: "2026-07-19T00:00:00.000Z" });
    expect(result).toEqual({ alreadyGone: false });
    expect(h.edgeUpdate).toHaveBeenCalledWith("edge-1", { invalidAt: "2026-07-19T00:00:00.000Z" });
  });

  it("deleteZepEdgeStrict deletes exactly the given edge", async () => {
    const result = await deleteZepEdgeStrict("edge-1");
    expect(result).toEqual({ alreadyGone: false });
    expect(h.edgeDelete).toHaveBeenCalledWith("edge-1");
    expect(h.edgeDelete).toHaveBeenCalledTimes(1);
  });

  it("deleteZepEpisodeStrict deletes exactly the given episode", async () => {
    const result = await deleteZepEpisodeStrict("ep-1");
    expect(result).toEqual({ alreadyGone: false });
    expect(h.episodeDelete).toHaveBeenCalledWith("ep-1");
  });

  it("already-deleted / not-found targets are SUCCESS, not errors (404 status)", async () => {
    h.edgeUpdate.mockRejectedValueOnce(notFound());
    h.edgeDelete.mockRejectedValueOnce(notFound());
    h.episodeDelete.mockRejectedValueOnce(notFound("episode not_found"));
    await expect(invalidateZepEdgeStrict({ edgeUuid: "edge-x", invalidAt: "2026-01-01" }))
      .resolves.toEqual({ alreadyGone: true });
    await expect(deleteZepEdgeStrict("edge-x")).resolves.toEqual({ alreadyGone: true });
    await expect(deleteZepEpisodeStrict("ep-x")).resolves.toEqual({ alreadyGone: true });
    // Reconciled-as-success is not a failure: nothing logged as an error.
    expect(loggedLines(errorSpy).join("")).toBe("");
  });

  it("non-404 failures THROW after retry — never swallowed", async () => {
    h.edgeDelete.mockRejectedValue(badRequest("forbidden"));
    await expect(deleteZepEdgeStrict("edge-x")).rejects.toThrow("forbidden");
    h.episodeDelete.mockRejectedValue(badRequest("forbidden"));
    await expect(deleteZepEpisodeStrict("ep-x")).rejects.toThrow("forbidden");
  });

  it("refuses an empty uuid — a blank target must never widen the call", async () => {
    await expect(deleteZepEdgeStrict("")).rejects.toThrow();
    await expect(deleteZepEpisodeStrict("")).rejects.toThrow();
    await expect(invalidateZepEdgeStrict({ edgeUuid: "", invalidAt: "2026-01-01" })).rejects.toThrow();
    expect(h.edgeDelete).not.toHaveBeenCalled();
    expect(h.episodeDelete).not.toHaveBeenCalled();
    expect(h.edgeUpdate).not.toHaveBeenCalled();
  });

  it("failure logs carry operation + error class + correlation hash — never the raw UUID (R21)", async () => {
    h.edgeDelete.mockRejectedValue(badRequest("boom"));
    await deleteZepEdgeStrict("edge-secret-uuid").catch(() => {});
    expect(errorSpy).toHaveBeenCalled();
    const line = String(errorSpy.mock.calls[0][0]);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.operation).toBe("deleteZepEdge");
    expect(entry.correlation).toMatch(/^[0-9a-f]{12}$/);
    expect(line).not.toContain("edge-secret-uuid");
  });
});
