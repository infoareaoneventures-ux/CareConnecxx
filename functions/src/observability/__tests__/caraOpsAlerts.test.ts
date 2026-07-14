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
