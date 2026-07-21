import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// providerFailureAlert imports firebase-admin (via caraOpsAlerts) and
// dynamically imports linq/client for the admin SMS. Stub both so this test
// stays a fast unit test with no real Firestore/Linq calls, mirroring the
// heavy-dependency stubbing qaAgent.test.ts already uses.
// vi.hoisted: caraOpsAlerts calls admin.firestore() at MODULE LOAD, which runs
// before this file's const initializers — plain consts would hit the TDZ.
// U9: the sustained-outage and aged-operation alerts dedupe via deterministic
// doc IDs (doc(id).set(..., { merge: true })) — capture (id, data, opts).
const { addMock, setMock, createMock, bucketDocs, alertDocs, makeCollection } = vi.hoisted(() => {
  const addMock = vi.fn(async (_doc: any) => undefined);
  const setMock = vi.fn(async (..._args: unknown[]) => undefined);
  const createMock = vi.fn(async (_id: string, _data: any) => undefined);
  const bucketDocs = new Map<string, Record<string, unknown>>();
  const alertDocs = new Map<string, Record<string, unknown>>();
  const makeCollection = (collection: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let max = Infinity;
    const query: any = {
      where: (field: string, operator: string, value: unknown) => {
        filters.push([field, operator, value]);
        return query;
      },
      orderBy: () => query,
      limit: (limit: number) => { max = limit; return query; },
      get: async () => {
        const docs = [...bucketDocs.entries()]
          .map(([id, data]) => ({ id, data: () => ({ ...data }) }))
          .filter((doc) => filters.every(([field, operator, value]) => {
            const actual = doc.data()[field];
            return (operator === ">=" && typeof actual === "number" && actual >= (value as number))
              || (operator === "<=" && typeof actual === "number" && actual <= (value as number));
          }))
          .sort((a, b) => Number(a.data().minuteStartMs) - Number(b.data().minuteStartMs))
          .slice(0, max);
        return { docs };
      },
      add: addMock,
      doc: (id: string) => ({
        id,
        set: async (data: Record<string, unknown>, opts?: unknown) => {
          await setMock(id, data, opts);
          if (collection === "cara_ops_zep_outage_buckets") {
            const existing = bucketDocs.get(id) ?? {};
            const merged = { ...existing };
            for (const [key, value] of Object.entries(data)) {
              if (typeof value === "object" && value && "__increment" in value) {
                merged[key] = Number(merged[key] ?? 0) + Number((value as { __increment: number }).__increment);
              } else {
                merged[key] = value;
              }
            }
            bucketDocs.set(id, merged);
          }
        },
        create: async (data: Record<string, unknown>) => {
          if (alertDocs.has(id)) throw Object.assign(new Error("already exists"), { code: 6 });
          await createMock(id, data);
          alertDocs.set(id, { ...data });
        },
      }),
    };
    return query;
  };
  return { addMock, setMock, createMock, bucketDocs, alertDocs, makeCollection };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    apps: [],
    initializeApp: () => ({}),
    firestore: Object.assign(() => ({ collection: makeCollection }), {
      FieldValue: { increment: (by: number) => ({ __increment: by }) },
    }),
  },
  apps: [],
  initializeApp: () => ({}),
  firestore: Object.assign(() => ({ collection: makeCollection }), {
    FieldValue: { increment: (by: number) => ({ __increment: by }) },
  }),
}));

const sendToPhoneMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendToPhone: sendToPhoneMock }));

import { classifyProviderError, raiseProviderFailureAlert } from "../providerFailureAlert";
import {
  createCaraOpsAlert,
  recordZepContextOutcome,
  raiseAgedMemoryOperationAlert,
  __resetZepOutageWindowForTests,
  ZEP_OUTAGE_WINDOW_MS,
  ZEP_OUTAGE_MIN_SAMPLES,
  ZEP_OUTAGE_ALERT_DEDUPE_MS,
  AGED_MEMORY_OPERATION_ALERT_MS,
} from "../caraOpsAlerts";

describe("classifyProviderError (U5)", () => {
  it.each([
    [{ status: 402 }, "billing status 402"],
    [new Error("insufficient_quota: your account has run out of credit"), "billing message keywords"],
    [{ message: "Your billing details are past due" }, "billing keyword in message field"],
  ])("classifies %j as billing (%s)", (err, _desc) => {
    expect(classifyProviderError(err)).toBe("billing");
  });

  it.each([
    [{ status: 401 }, "auth status 401"],
    [new Error("Invalid API Key provided"), "invalid api key message"],
  ])("classifies %j as auth (%s)", (err, _desc) => {
    expect(classifyProviderError(err)).toBe("auth");
  });

  it("classifies status 429 as rate_limit", () => {
    expect(classifyProviderError({ status: 429 })).toBe("rate_limit");
  });

  it.each([
    [new Error("request timed out"), "timed out message"],
    [new Error("The operation was aborted"), "aborted message"],
  ])("classifies %j as timeout (%s)", (err) => {
    expect(classifyProviderError(err)).toBe("timeout");
  });

  it("classifies an unrecognized error as other", () => {
    expect(classifyProviderError(new Error("something weird happened"))).toBe("other");
  });

  it("classifies a non-Error, non-object value as other", () => {
    expect(classifyProviderError("plain string error")).toBe("other");
    expect(classifyProviderError(undefined)).toBe("other");
  });
});

describe("raiseProviderFailureAlert (U5)", () => {
  const ORIGINAL_ADMIN_PHONE = process.env.ADMIN_PHONE;

  beforeEach(() => {
    addMock.mockClear();
    sendToPhoneMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_PHONE === undefined) delete process.env.ADMIN_PHONE;
    else process.env.ADMIN_PHONE = ORIGINAL_ADMIN_PHONE;
  });

  it("writes an admin_alerts doc with severity critical for a billing error", async () => {
    delete process.env.ADMIN_PHONE;
    await raiseProviderFailureAlert({
      phone: "+15551234567",
      provider: "openai",
      model: "gpt-5.4",
      error: new Error("insufficient_quota: credit exhausted"),
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const doc = addMock.mock.calls[0][0];
    expect(doc.type).toBe("provider_failure");
    expect(doc.severity).toBe("critical");
    expect(doc.phone).toBe("+15551234567");
    expect(doc.context.providerErrorClass).toBe("billing");
    expect(doc.context.provider).toBe("openai");
    expect(doc.context.model).toBe("gpt-5.4");
    expect(doc.error).toContain("insufficient_quota");
  });

  it("writes an admin_alerts doc with severity medium for a rate_limit error", async () => {
    delete process.env.ADMIN_PHONE;
    await raiseProviderFailureAlert({ provider: "anthropic", error: { status: 429 } });

    expect(addMock).toHaveBeenCalledTimes(1);
    const doc = addMock.mock.calls[0][0];
    expect(doc.severity).toBe("medium");
    expect(doc.context.providerErrorClass).toBe("rate_limit");
  });

  it("attempts an admin SMS for a billing-class failure when ADMIN_PHONE is set", async () => {
    process.env.ADMIN_PHONE = "+15559990000";
    await raiseProviderFailureAlert({
      provider: "openai",
      error: new Error("insufficient_quota"),
    });

    expect(sendToPhoneMock).toHaveBeenCalledTimes(1);
    expect(sendToPhoneMock.mock.calls[0][0]).toBe("+15559990000");
    expect(sendToPhoneMock.mock.calls[0][1]).toMatch(/billing\/auth/);
  });

  it("attempts an admin SMS for an auth-class failure when ADMIN_PHONE is set", async () => {
    process.env.ADMIN_PHONE = "+15559990000";
    await raiseProviderFailureAlert({ provider: "anthropic", error: { status: 401 } });

    expect(sendToPhoneMock).toHaveBeenCalledTimes(1);
  });

  it("skips SMS silently when ADMIN_PHONE is unset, even for billing/auth", async () => {
    delete process.env.ADMIN_PHONE;
    await raiseProviderFailureAlert({ provider: "openai", error: new Error("invalid api key") });

    expect(sendToPhoneMock).not.toHaveBeenCalled();
  });

  it("does not SMS for non-billing/auth classes even when ADMIN_PHONE is set", async () => {
    process.env.ADMIN_PHONE = "+15559990000";
    await raiseProviderFailureAlert({ provider: "openai", error: new Error("request timed out") });

    expect(sendToPhoneMock).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it("never throws even when the Firestore write and the SMS both fail", async () => {
    process.env.ADMIN_PHONE = "+15559990000";
    addMock.mockRejectedValueOnce(new Error("firestore down"));
    sendToPhoneMock.mockRejectedValueOnce(new Error("linq down"));

    await expect(
      raiseProviderFailureAlert({ provider: "openai", error: new Error("insufficient_quota") })
    ).resolves.toBeUndefined();
  });
});

// ── U7 (R21): grounding/handoff alert redaction ──────────────────────────────
// Alerts about the grounding gate describe a draft that may contain invented
// medical/identity/payment claims — they must reference the turn by hash/enum,
// never quote the user's question, the draft reply, or a prior reply. The sink
// enforces this so no call site can regress it.
describe("createCaraOpsAlert grounding/handoff redaction (U7, R21)", () => {
  beforeEach(() => {
    addMock.mockClear();
    addMock.mockResolvedValue(undefined);
  });

  it("strips raw input/output keys from a handoff alert's context, keeping hash/enum keys", async () => {
    const ok = await createCaraOpsAlert({
      type: "human_handoff_low_confidence",
      severity: "high",
      phone: "+15551234567",
      userId: "user-1",
      source: "qaAgent",
      message: "Evia handed a thread to a teammate: an unbacked confident claim fell below the confidence bar.",
      context: {
        // R21-forbidden raw content a (future) call site might try to pass:
        question: "does my mom have Parkinson's?",
        suppressedReply: "Yes — she has Parkinson's and her invoice was $340.",
        priorReply: "I already told you she has Parkinson's.",
        // allowed telemetry:
        turnHash: "ab12cd34",
        draftHash: "ef56ab78",
        claimCategories: ["medical_condition", "money_payment"],
        claimRisk: "high",
        verdict: "unsupported",
        action: "handoff",
        verifierLatencyMs: 640,
        pathway: "qa",
      },
    });

    expect(ok).toBe(true);
    expect(addMock).toHaveBeenCalledTimes(1);
    const doc = addMock.mock.calls[0][0] as Record<string, unknown>;
    const json = JSON.stringify(doc);
    expect(json).not.toContain("Parkinson");
    expect(json).not.toContain("$340");
    expect(json).not.toContain("does my mom have");
    expect(json).not.toContain("I already told you");
    const context = doc.context as Record<string, unknown>;
    expect(context).toEqual({
      turnHash: "ab12cd34",
      draftHash: "ef56ab78",
      claimCategories: ["medical_condition", "money_payment"],
      claimRisk: "high",
      verdict: "unsupported",
      action: "handoff",
      verifierLatencyMs: 640,
      pathway: "qa",
    });
  });

  it("applies the same redaction to any grounding-typed alert", async () => {
    await createCaraOpsAlert({
      type: "grounding_neutralized_high_risk",
      context: { draftPreview: "She is allergic to penicillin.", turnHash: "0011aabb", action: "neutralize" },
    });
    const doc = addMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(doc)).not.toContain("penicillin");
    expect(doc.context).toEqual({ turnHash: "0011aabb", action: "neutralize" });
  });

  it("drops an allowed key whose value is suspiciously long (could smuggle raw text)", async () => {
    await createCaraOpsAlert({
      type: "human_handoff_low_confidence",
      context: {
        turnHash: "deadbeef",
        verdict: "the draft says: 'she has Parkinson's and lives in Sacramento with her daughter Maria'…",
      },
    });
    const doc = addMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(doc)).not.toContain("Parkinson");
    expect(doc.context).toEqual({ turnHash: "deadbeef" });
  });

  it("omits context entirely when nothing survives the allowlist", async () => {
    await createCaraOpsAlert({
      type: "human_handoff_low_confidence",
      context: { question: "raw question", suppressedReply: "raw reply" },
    });
    const doc = addMock.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.context).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain("raw question");
  });

  it("leaves non-grounding alert types untouched (unrelated alerts keep free-form context)", async () => {
    await createCaraOpsAlert({
      type: "provider_failure",
      context: { providerErrorClass: "billing", provider: "openai", detail: "insufficient_quota on account" },
    });
    const doc = addMock.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.context).toEqual({
      providerErrorClass: "billing",
      provider: "openai",
      detail: "insufficient_quota on account",
    });
  });
});

// ── U9 (R21/R22): sustained-Zep-outage alert ──────────────────────────────────
// Alert only on a SUSTAINED unavailable/timeout rate: a single failure never
// pages, a legitimately empty Zep response NEVER pages, and a real outage
// produces exactly one deduplicated admin_alerts doc per time bucket.
describe("recordZepContextOutcome sustained-outage alert (U9)", () => {
  const T0 = Date.parse("2026-07-19T12:00:00Z");

  beforeEach(() => {
    setMock.mockClear();
    setMock.mockResolvedValue(undefined);
    createMock.mockClear();
    createMock.mockResolvedValue(undefined);
    bucketDocs.clear();
    alertDocs.clear();
    __resetZepOutageWindowForTests();
  });

  it("empty Zep results never alert, no matter how many accumulate", async () => {
    for (let i = 0; i < 25; i++) {
      expect(await recordZepContextOutcome("empty", T0 + i * 1000)).toBe(false);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a single unavailable event never alerts (below the minimum sample count)", async () => {
    expect(await recordZepContextOutcome("unavailable", T0)).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a sustained outage alerts once per dedupe bucket with counts-only content", async () => {
    // Align inside one dedupe bucket so the in-process latch is what dedupes.
    const base = Math.floor(T0 / ZEP_OUTAGE_ALERT_DEDUPE_MS) * ZEP_OUTAGE_ALERT_DEDUPE_MS;
    const results: boolean[] = [];
    for (let i = 0; i < ZEP_OUTAGE_MIN_SAMPLES + 3; i++) {
      results.push(await recordZepContextOutcome(i % 2 ? "timeout" : "unavailable", base + i * 1000));
    }
    // Below MIN_SAMPLES: never; at MIN_SAMPLES: one alert; afterwards: latched.
    expect(results.slice(0, ZEP_OUTAGE_MIN_SAMPLES - 1)).toEqual(
      new Array(ZEP_OUTAGE_MIN_SAMPLES - 1).fill(false),
    );
    expect(results[ZEP_OUTAGE_MIN_SAMPLES - 1]).toBe(true);
    expect(results.slice(ZEP_OUTAGE_MIN_SAMPLES)).toEqual([false, false, false]);
    expect(createMock).toHaveBeenCalledTimes(1);

    const [docId, doc] = createMock.mock.calls[0];
    expect(docId).toBe(`zep-sustained-outage:${Math.floor(base / ZEP_OUTAGE_ALERT_DEDUPE_MS)}`);
    expect(doc.type).toBe("zep_sustained_outage");
    expect(doc.severity).toBe("high");
    // R21: aggregate counts only — no thread/user IDs, no query text, no phone.
    expect(Object.keys(doc.context).sort()).toEqual(["failureRate", "failures", "samples", "windowMs"]);
    expect(doc.context.samples).toBe(ZEP_OUTAGE_MIN_SAMPLES);
    expect(doc.context.failures).toBe(ZEP_OUTAGE_MIN_SAMPLES);
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(/thread|zepUser|query|phone|\+1\d{10}/i);
  });

  it("healthy samples dilute the rate below the threshold — no alert", async () => {
    for (let i = 0; i < 8; i++) await recordZepContextOutcome("loaded", T0 + i * 1000);
    for (let i = 0; i < 4; i++) await recordZepContextOutcome("unavailable", T0 + 9000 + i * 1000);
    // 4 failures / 12 samples = 0.33 < 0.5
    expect(createMock).not.toHaveBeenCalled();
  });

  it("failures older than the rolling window no longer count", async () => {
    for (let i = 0; i < ZEP_OUTAGE_MIN_SAMPLES; i++) {
      // Stay one sample short of alerting inside the old window.
      if (i < ZEP_OUTAGE_MIN_SAMPLES - 1) await recordZepContextOutcome("unavailable", T0 + i * 1000);
    }
    // Past the window: the old failures are pruned, one fresh success is all
    // that remains — far below the minimum sample count.
    const later = T0 + ZEP_OUTAGE_WINDOW_MS + 60_000;
    expect(await recordZepContextOutcome("loaded", later)).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("never throws and reports false when the alert write fails", async () => {
    createMock.mockRejectedValue(new Error("firestore down"));
    let last = false;
    for (let i = 0; i < ZEP_OUTAGE_MIN_SAMPLES; i++) {
      last = await recordZepContextOutcome("timeout", T0 + i * 1000);
    }
    expect(last).toBe(false);
  });

  it("aggregates through a simulated cold start and lets only one instance create the alert", async () => {
    const base = Math.floor(T0 / ZEP_OUTAGE_ALERT_DEDUPE_MS) * ZEP_OUTAGE_ALERT_DEDUPE_MS;
    for (let i = 0; i < ZEP_OUTAGE_MIN_SAMPLES - 1; i++) {
      await recordZepContextOutcome("unavailable", base + i * 1000);
    }
    __resetZepOutageWindowForTests();

    expect(await recordZepContextOutcome("timeout", base + ZEP_OUTAGE_MIN_SAMPLES * 1000)).toBe(true);
    __resetZepOutageWindowForTests();
    expect(await recordZepContextOutcome("unavailable", base + (ZEP_OUTAGE_MIN_SAMPLES + 1) * 1000)).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ── U9 (R21/R22): aged-memory-operation alert ─────────────────────────────────
describe("raiseAgedMemoryOperationAlert (U9)", () => {
  beforeEach(() => {
    setMock.mockClear();
    setMock.mockResolvedValue(undefined);
  });

  it("writes one deterministic-ID doc per operation (set+merge dedupe)", async () => {
    const input = {
      operationId: "turn_sync_abc123",
      kind: "turn_sync",
      status: "pending",
      ageMs: AGED_MEMORY_OPERATION_ALERT_MS + 5_000,
      attempts: 0,
    };
    expect(await raiseAgedMemoryOperationAlert(input)).toBe(true);
    expect(await raiseAgedMemoryOperationAlert(input)).toBe(true);

    // Both calls target the SAME document — dedupe is the deterministic ID.
    expect(setMock).toHaveBeenCalledTimes(2);
    const ids = setMock.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("memory-operation-aged:turn_sync_abc123");
    expect(setMock.mock.calls[0][2]).toEqual({ merge: true });

    const doc = setMock.mock.calls[0][1] as Record<string, unknown>;
    expect(doc.type).toBe("memory_operation_aged");
    expect(doc.severity).toBe("high");
    expect(doc.operationId).toBe("turn_sync_abc123");
    const context = doc.context as Record<string, unknown>;
    expect(context.kind).toBe("turn_sync");
    expect(context.status).toBe("pending");
    expect(context.attempts).toBe(0);
    expect(context.thresholdMs).toBe(AGED_MEMORY_OPERATION_ALERT_MS);
  });

  it("carries no refs, paths, phones, or content — enum/count allowlist only", async () => {
    await raiseAgedMemoryOperationAlert({
      operationId: "forget_deadbeef",
      kind: "she is allergic to penicillin", // hostile kind value → sanitized
      status: "agent_conversations/+14085550001/messages/m1", // hostile status
      ageMs: 2 * AGED_MEMORY_OPERATION_ALERT_MS,
      attempts: 3,
    });
    const doc = setMock.mock.calls[0][1] as Record<string, unknown>;
    const json = JSON.stringify(doc);
    expect(json).not.toContain("penicillin");
    expect(json).not.toContain("+14085550001");
    expect(json).not.toContain("agent_conversations");
    const context = doc.context as Record<string, unknown>;
    expect(context.kind).toBe("other");
    expect(context.status).toBe("other");
  });

  it("never throws and returns false when the write fails", async () => {
    setMock.mockRejectedValueOnce(new Error("firestore down"));
    await expect(
      raiseAgedMemoryOperationAlert({
        operationId: "op-x", kind: "forget", status: "retryable_failed",
        ageMs: AGED_MEMORY_OPERATION_ALERT_MS, attempts: 2,
      }),
    ).resolves.toBe(false);
  });
});
