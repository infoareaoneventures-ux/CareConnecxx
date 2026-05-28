import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTurnMetrics, emitTurnMetrics } from "./turnMetrics";

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Mute and capture — every test inspects the emitted payload directly.
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
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
});
