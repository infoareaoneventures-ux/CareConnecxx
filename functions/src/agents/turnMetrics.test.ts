import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTurnMetrics, emitTurnMetrics, setTurnMetricMirrorForTest, setZepOutcomeRecorderForTest } from "./turnMetrics";

const firestoreMock = vi.hoisted(() => ({
  add: vi.fn(async (_record: unknown) => ({ id: "metric-1" })),
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

  it("mirrors quality issue turns for Admin Evia Control Room visibility", () => {
    const m = createTurnMetrics({ phone: "+15550002222", userId: "client-1", userType: "client", pathway: "qa" });
    m.supportDeflectionDetected = true;
    m.genericHelpAskDetected = true;
    m.conversationRepairApplied = true;
    m.recipeWithoutBackingTool = true;
    m.contextIgnoredWhenPresent = true;
    m.paymentAuthorityLeakDetected = true;
    m.frustrationDetected = true;
    m.rephraseLoopDetected = true;
    m.repeatedGreetingDetected = true;
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
      recipeWithoutBackingTool: true,
      contextIgnoredWhenPresent: true,
      paymentAuthorityLeakDetected: true,
      frustrationDetected: true,
      rephraseLoopDetected: true,
      repeatedGreetingDetected: true,
      toolErrors: 1,
      quickReplyUsed: false,
    });
    expect(mirrored.qualityFlags).toEqual([
      "context_ignored_when_present",
      "conversation_repair_applied",
      "frustration_detected",
      "generic_help_ask_detected",
      "payment_authority_leak_detected",
      "recipe_without_backing_tool",
      "repeated_greeting_detected",
      "rephrase_loop_detected",
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

  // U3 (memory expansion + truncation telemetry): historyRolledUp, zepContextEmpty,
  // and learnedFactsCount make memory degradation measurable instead of silent.
  describe("truncation telemetry fields", () => {
    it("accepts and serializes historyRolledUp, zepContextEmpty, and learnedFactsCount", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.historyRolledUp = true;
      m.zepContextEmpty = true;
      m.learnedFactsCount = 7;
      emitTurnMetrics(m, { reply: "ok" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.historyRolledUp).toBe(true);
      expect(payload.zepContextEmpty).toBe(true);
      expect(payload.learnedFactsCount).toBe(7);
    });

    it("defaults the three fields to undefined when never set", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      emitTurnMetrics(m, { reply: "ok" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.historyRolledUp).toBeUndefined();
      expect(payload.zepContextEmpty).toBeUndefined();
      expect(payload.learnedFactsCount).toBeUndefined();
    });

    it("mirrors the three fields to Firestore on quality/experiment turns, coerced to safe defaults", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.historyRolledUp = true;
      m.zepContextEmpty = false;
      m.learnedFactsCount = 3;
      m.frustrationDetected = true; // forces the Firestore mirror to fire
      emitTurnMetrics(m, { reply: "ok" });

      expect(firestoreMock.add).toHaveBeenCalledTimes(1);
      const mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.historyRolledUp).toBe(true);
      expect(mirrored.zepContextEmpty).toBe(false);
      expect(mirrored.learnedFactsCount).toBe(3);
    });

    it("mirrors safe defaults (false/0) when the fields were never set on a mirrored turn", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.frustrationDetected = true; // forces the Firestore mirror to fire
      emitTurnMetrics(m, { reply: "ok" });

      const mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.historyRolledUp).toBe(false);
      expect(mirrored.zepContextEmpty).toBe(false);
      expect(mirrored.learnedFactsCount).toBe(0);
    });
  });

  // U7 (memory grounding, R18/R19/R21): risk-tier grounding gate telemetry —
  // categories/verdict/action/latency counters, never raw draft or user text.
  describe("grounding risk-tier fields", () => {
    it("accepts and serializes the grounding counter fields", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.groundingClaimCategories = ["medical_condition", "money_payment"];
      m.groundingClaimRisk = "high";
      m.groundingVerdict = "indeterminate";
      m.groundingVerifierIndeterminate = true;
      m.groundingNeutralized = true;
      m.groundingVerifierLatencyMs = 812;
      emitTurnMetrics(m, { reply: "neutral copy" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.groundingClaimCategories).toEqual(["medical_condition", "money_payment"]);
      expect(payload.groundingClaimRisk).toBe("high");
      expect(payload.groundingVerdict).toBe("indeterminate");
      expect(payload.groundingVerifierIndeterminate).toBe(true);
      expect(payload.groundingNeutralized).toBe(true);
      expect(payload.groundingVerifierLatencyMs).toBe(812);
    });

    it("neutralized and verifier-indeterminate turns raise quality flags (and thus mirror)", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.groundingNeutralized = true;
      m.groundingVerifierIndeterminate = true;
      emitTurnMetrics(m, { reply: "ok" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.qualityFlags).toContain("grounding_neutralized");
      expect(payload.qualityFlags).toContain("grounding_verifier_indeterminate");
      expect(firestoreMock.add).toHaveBeenCalledTimes(1);
    });

    it("mirrors grounding fields with safe defaults on quality turns", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.groundingClaimCategories = ["allergy"];
      m.groundingClaimRisk = "high";
      m.groundingVerdict = "supported";
      m.humanHandoffSuppressed = true; // forces mirror
      emitTurnMetrics(m, { reply: "ok" });
      let mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.groundingClaimCategories).toEqual(["allergy"]);
      expect(mirrored.groundingClaimRisk).toBe("high");
      expect(mirrored.groundingVerdict).toBe("supported");
      expect(mirrored.groundingNeutralized).toBe(false);
      expect(mirrored.groundingVerifierIndeterminate).toBe(false);
      expect(mirrored.groundingVerifierLatencyMs).toBeNull();

      firestoreMock.add.mockClear();
      const bare = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      bare.frustrationDetected = true;
      emitTurnMetrics(bare, { reply: "ok" });
      mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.groundingClaimCategories).toEqual([]);
      expect(mirrored.groundingClaimRisk).toBeNull();
      expect(mirrored.groundingVerdict).toBeNull();
    });

    it("serialized metrics and mirror contain no raw input/output text (R21)", () => {
      const draft = "She has Parkinson's and your invoice was $340.";
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.groundingClaimCategories = ["medical_condition", "money_payment"];
      m.groundingClaimRisk = "high";
      m.groundingVerdict = "unsupported";
      m.humanHandoffTriggered = true; // forces mirror
      emitTurnMetrics(m, { reply: draft });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      const mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      for (const record of [payload, mirrored]) {
        const json = JSON.stringify(record);
        expect(json).not.toContain("Parkinson");
        expect(json).not.toContain("$340");
        expect(json).not.toContain(draft);
      }
      // Only length/enum derivatives of the reply survive.
      expect(payload.replyLength).toBe(draft.length);
    });
  });

  // U1 (memory grounding): typed Zep context outcome — loaded/empty/unavailable/
  // timeout plus fetch latency, recorded without any raw memory content.
  describe("zep context status fields", () => {
    it("accepts and serializes zepContextStatus and zepContextLatencyMs", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.zepContextStatus = "timeout";
      m.zepContextLatencyMs = 6003;
      emitTurnMetrics(m, { reply: "ok" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.zepContextStatus).toBe("timeout");
      expect(payload.zepContextLatencyMs).toBe(6003);
    });

    it("defaults both fields to undefined when no Zep thread was queried", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      emitTurnMetrics(m, { reply: "ok" });
      const payload = infoSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.zepContextStatus).toBeUndefined();
      expect(payload.zepContextLatencyMs).toBeUndefined();
    });

    it("mirrors status and latency (null when unset) on quality/experiment turns", () => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.zepContextStatus = "unavailable";
      m.zepContextLatencyMs = 42;
      m.frustrationDetected = true; // forces the Firestore mirror to fire
      emitTurnMetrics(m, { reply: "ok" });
      let mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.zepContextStatus).toBe("unavailable");
      expect(mirrored.zepContextLatencyMs).toBe(42);

      firestoreMock.add.mockClear();
      const bare = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      bare.frustrationDetected = true;
      emitTurnMetrics(bare, { reply: "ok" });
      mirrored = firestoreMock.add.mock.calls[0][0] as Record<string, unknown>;
      expect(mirrored.zepContextStatus).toBeNull();
      expect(mirrored.zepContextLatencyMs).toBeNull();
    });
  });
});

// ── U9: sustained-Zep-outage feed ─────────────────────────────────────────────
// emitTurnMetrics is the sanctioned seam that forwards each turn's typed Zep
// context outcome to the outage evaluator in observability/caraOpsAlerts
// (which alerts only on SUSTAINED unavailable/timeout rates — never "empty").
describe("Zep outcome forwarding (U9)", () => {
  const recorded: string[] = [];

  beforeEach(() => {
    recorded.length = 0;
    setZepOutcomeRecorderForTest((status) => recorded.push(status));
  });

  afterEach(() => {
    setZepOutcomeRecorderForTest(null);
  });

  it.each(["loaded", "empty", "unavailable", "timeout"] as const)(
    "forwards zepContextStatus %s exactly once per emitted turn",
    (status) => {
      const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "qa" });
      m.zepContextStatus = status;
      emitTurnMetrics(m, { reply: "ok" });
      expect(recorded).toEqual([status]);
    },
  );

  it("a turn that never queried Zep is not a sample", () => {
    const m = createTurnMetrics({ phone: "+15550001111", userType: "client", pathway: "quick" });
    emitTurnMetrics(m, { reply: "ok" });
    expect(recorded).toEqual([]);
  });
});
