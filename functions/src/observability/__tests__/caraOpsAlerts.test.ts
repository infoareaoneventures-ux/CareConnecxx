import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// providerFailureAlert imports firebase-admin (via caraOpsAlerts) and
// dynamically imports linq/client for the admin SMS. Stub both so this test
// stays a fast unit test with no real Firestore/Linq calls, mirroring the
// heavy-dependency stubbing qaAgent.test.ts already uses.
const addMock = vi.fn().mockResolvedValue(undefined);
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    apps: [],
    initializeApp: () => ({}),
    firestore: () => ({ collection: () => ({ add: addMock }) }),
  },
  apps: [],
  initializeApp: () => ({}),
  firestore: () => ({ collection: () => ({ add: addMock }) }),
}));

const sendToPhoneMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendToPhone: sendToPhoneMock }));

import { classifyProviderError, raiseProviderFailureAlert } from "../providerFailureAlert";
import { createCaraOpsAlert } from "../caraOpsAlerts";

describe("classifyProviderError (U5)", () => {
  it.each([
    [{ status: 402 }, "billing status 402"],
    [new Error("insufficient_quota: your account has run out of credit"), "billing message keywords"],
    [{ message: "Your billing details are past due" }, "billing keyword in message field"],
  ])("classifies %j as billing (%s)", (err) => {
    expect(classifyProviderError(err)).toBe("billing");
  });

  it.each([
    [{ status: 401 }, "auth status 401"],
    [new Error("Invalid API Key provided"), "invalid api key message"],
  ])("classifies %j as auth (%s)", (err) => {
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
