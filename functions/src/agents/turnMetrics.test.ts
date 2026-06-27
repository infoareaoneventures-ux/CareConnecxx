import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTurnMetrics, emitTurnMetrics, setTurnMetricMirrorForTest } from "./turnMetrics";

const firestoreMock = vi.hoisted(() => ({
  add: vi.fn(async () => ({ id: "metric-1" })),
}));

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Mute and capture — every test inspects the emitted payload directly.
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  firestoreMock.add.mockClear();
  setTurnMetricMirrorForTest((record) => {
    firestoreMock.add(record);
  });
});

afterEach(() => {
  infoSpy.mockRestore();
  setTurnMetricMirrorForTest(null);
});

describe("createTurnMetrics", () => {
  it("captures identity, pathway, and a startedAt timestamp", () => {
    const before = Date.now();
    const m = createTurnMetrics({
      phone:    "+15550001111",
      userId:   "user-abc",
      userType: "client",
      pathway:  "qa",
      isRetry:  false,
      inputChannel: "USER",
    });
    expect(m.phone).toBe("+15550001111");
    expect(m.userId).toBe("user-abc");
    expect(m.userType).toBe("client");
    expect(m.pathway).toBe("qa");
    expect(m.isRetry).toBe(false);
    expect(m.inputChannel).toBe("USER");
    expect(m.startedAt).toBeGreaterThanOrEqual(before);
    expect(m.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("supports the quick pathway without an inputChannel override", () => {
    const m = createTurnMetrics({
      phone:    "+15550001111",
      userType: "client",
      pathway:  "quick",
    });
    expect(m.pathway).toBe("quick");
    expect(m.userId).toBeUndefined();
  });
});

describe("emitTurnMetrics", () => {
  it("emits a single console.info call labelled cara.turn", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    emitTurnMetrics(m, { reply: "hello" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toBe("cara.turn");
  });

  it("computes durationMs from startedAt and replyLength from reply text", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    m.startedAt = Date.now() - 1234; // simulate a 1.2s turn
    emitTurnMetrics(m, { reply: "Hello! Maria's coming Thursday." });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.durationMs).toBeGreaterThanOrEqual(1234);
    expect(payload.replyLength).toBe("Hello! Maria's coming Thursday.".length);
    expect(payload.replyEmpty).toBe(false);
  });

  it("flags an empty reply", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    emitTurnMetrics(m, { reply: "   " });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.replyEmpty).toBe(true);
    expect(payload.replyLength).toBe(3);
  });

  it("dedupes toolNames so repeated calls across iterations stay compact", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    m.toolNames = ["get_x", "get_x", "get_y", "get_x"];
    emitTurnMetrics(m, { reply: "ok" });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.toolNames).toEqual(["get_x", "get_y"]);
  });

  it("records error class without exposing the message", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    class APIError extends Error {}
    const err = new APIError("anthropic 500 — internal details that should never reach logs");
    emitTurnMetrics(m, { reply: "fallback message", error: err });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.errored).toBe(true);
    expect(payload.errorClass).toBe("APIError");
    // The message must NOT appear anywhere in the payload — we log error classes
    // only, never error messages (they can contain PII or upstream API details).
    expect(JSON.stringify(payload)).not.toContain("anthropic 500");
  });

  it("drops the internal startedAt field from the emitted payload", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    emitTurnMetrics(m, { reply: "ok" });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    // startedAt is used to compute durationMs; once derived, it's no longer
    // useful downstream. Excluded so log payloads stay tight.
    expect(payload.startedAt).toBeUndefined();
    expect(payload.durationMs).toBeDefined();
  });

  it("does NOT include message text or tool input as payload fields", () => {
    // Schema-safety regression: if a future contributor adds a `text` or
    // `toolInputs` field to TurnMetrics, this test should fail loudly.
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    emitTurnMetrics(m, { reply: "ok" });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.text).toBeUndefined();
    expect(payload.userMessage).toBeUndefined();
    expect(payload.toolInputs).toBeUndefined();
    expect(payload.toolResults).toBeUndefined();
    expect(payload.replyContent).toBeUndefined();
  });

  it("passes through optional quality fields when set", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    m.iterations = 3;
    m.toolCalls = 5;
    m.toolErrors = 1;
    m.truncations = 1;
    m.patchedOrphans = 1;
    m.groundingTriggered = true;
    m.formatRevisionTriggered = true;
    m.postProcessModified = true;
    m.prefetchHit = true;
    emitTurnMetrics(m, { reply: "ok" });
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.iterations).toBe(3);
    expect(payload.toolCalls).toBe(5);
    expect(payload.toolErrors).toBe(1);
    expect(payload.truncations).toBe(1);
    expect(payload.patchedOrphans).toBe(1);
    expect(payload.groundingTriggered).toBe(true);
    expect(payload.formatRevisionTriggered).toBe(true);
    expect(payload.postProcessModified).toBe(true);
    expect(payload.prefetchHit).toBe(true);
  });

  it("mirrors experiment turns to cara_turn_metrics", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
    m.experiments = { "tone-warmth-v1": "treatment" };
    m.warmthReflectionIncluded = true;
    emitTurnMetrics(m, { reply: "That makes sense. Maria is confirmed." });

    expect(firestoreMock.add).toHaveBeenCalledTimes(1);
    expect(firestoreMock.add.mock.calls[0][0]).toMatchObject({
      source: "turn_metrics",
      phone: "+15550001111",
      userType: "client",
      pathway: "qa",
      experiments: { "tone-warmth-v1": "treatment" },
      qualityFlags: [],
      warmthReflectionIncluded: true,
    });
  });

  it("mirrors quality issue turns for Admin Cara Control Room visibility", () => {
    const m = createTurnMetrics({ phone: "+15550002222", userId: "client-1", userType: "client", pathway: "qa" });
    m.supportDeflectionDetected = true;
    m.genericHelpAskDetected = true;
    m.conversationRepairApplied = true;
    m.toolErrors = 1;
    emitTurnMetrics(m, { reply: "I can help with that." });

    expect(firestoreMock.add).toHaveBeenCalledTimes(1);
    const mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
    expect(mirrored).toMatchObject({
      source: "turn_metrics",
      phone: "+15550002222",
      userId: "client-1",
      userType: "client",
      pathway: "qa",
      supportDeflectionDetected: true,
      genericHelpAskDetected: true,
      conversationRepairApplied: true,
      toolErrors: 1,
      quickReplyUsed: false,
    });
    expect(mirrored.qualityFlags).toEqual([
      "conversation_repair_applied",
      "generic_help_ask_detected",
      "support_deflection_detected",
      "tool_error",
    ]);
    expect(JSON.stringify(mirrored)).not.toContain("I can help with that.");
  });

  it("does not mirror ordinary clean non-experiment turns", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "quick" });
    emitTurnMetrics(m, { reply: "You're welcome." });
    expect(firestoreMock.add).not.toHaveBeenCalled();
    const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.quickReplyUsed).toBe(true);
    expect(payload.qualityFlags).toBeUndefined();
  });
});
