import { describe, it, expect, vi, beforeEach } from "vitest";

// providerFailureAlert: a billing/auth failure on the ONLY provider flips
// system-wide degraded mode; the same failure with a fallback provider carrying
// the call pages the founder but leaves the system un-degraded (2026-10-01:
// four days of held interview reminders were released at once because OpenAI's
// credit exhaustion flagged degraded even though Anthropic answered every turn).

const hoisted = vi.hoisted(() => ({ degraded: [] as string[], ops: [] as any[], adds: [] as any[] }));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ add: vi.fn(async (d: any) => { hoisted.adds.push(d); }) }) }), { FieldValue: { serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../caraOpsAlerts", () => ({ createCaraOpsAlert: vi.fn(async (a: any) => { hoisted.ops.push(a); return true; }) }));
vi.mock("../systemStatus", () => ({ setSystemDegraded: vi.fn(async (reason: string) => { hoisted.degraded.push(reason); }) }));

import { raiseProviderFailureAlert } from "../providerFailureAlert";

const NO_CREDITS = new Error("429 You have no credits remaining. Add credits to continue using the API");

beforeEach(() => { hoisted.degraded.length = 0; hoisted.ops.length = 0; hoisted.adds.length = 0; delete process.env.ADMIN_PHONE; });

describe("raiseProviderFailureAlert", () => {
  it("billing failure with no fallback → critical alert AND degraded mode", async () => {
    await raiseProviderFailureAlert({ provider: "openai", model: "gpt-5.4", error: NO_CREDITS });
    expect(hoisted.ops[0]).toMatchObject({ type: "provider_failure", severity: "critical" });
    expect(hoisted.degraded).toHaveLength(1);
    expect(hoisted.degraded[0]).toMatch(/^provider billing: /);
  });
  it("the same failure while a fallback provider carries the call → alert, but NOT degraded", async () => {
    await raiseProviderFailureAlert({ provider: "openai", model: "fast-path", error: NO_CREDITS, hasFallback: true });
    expect(hoisted.ops[0]).toMatchObject({ type: "provider_failure", severity: "critical" });
    expect(hoisted.degraded).toHaveLength(0);
  });
  it("a non-billing failure never degrades the system", async () => {
    await raiseProviderFailureAlert({ provider: "openai", model: "gpt-5.4", error: new Error("timeout after 30s") });
    expect(hoisted.ops[0]).toMatchObject({ severity: "medium" });
    expect(hoisted.degraded).toHaveLength(0);
  });
});
