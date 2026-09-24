import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCaraActionExecutionStoreForTest } from "../actionNative/actionExecutionLedger";
import { CaraActionValidationError } from "../actionNative/runCaraAction";

const logAgentAction = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../../observability/actionLedger", () => ({
  logAgentAction: (...args: unknown[]) => logAgentAction(...args),
}));

import { isSupportedMcpWriteAction, runMcpWriteCaraAction } from "./mcpWriteActionAdapter";

beforeEach(() => {
  logAgentAction.mockClear();
  setCaraActionExecutionStoreForTest(null);
});

describe("mcpWriteActionAdapter", () => {
  it("recognizes migrated consequential MCP write actions", () => {
    expect(isSupportedMcpWriteAction("create_caregiver_referral")).toBe(true);
    expect(isSupportedMcpWriteAction("complete_shift")).toBe(true);
    expect(isSupportedMcpWriteAction("get_shifts")).toBe(false);
  });

  it("validates required fields before executing legacy MCP logic", async () => {
    await expect(runMcpWriteCaraAction(
      "create_caregiver_referral",
      { caregiverId: "cg1" },
      async () => ({ success: true }),
    )).rejects.toBeInstanceOf(CaraActionValidationError);
  });

  it("audits and blocks duplicate target-specific write execution by idempotency key", async () => {
    const stored = new Map<string, unknown>();
    setCaraActionExecutionStoreForTest({
      claim: async key => stored.has(key)
        ? { cached: true, result: stored.get(key) }
        : { cached: false },
      settle: async (key, outcome) => {
        if (outcome.ok) stored.set(key, outcome.result);
      },
    });

    const execute = vi.fn(async () => ({ success: true, invited: true, referredPhone: "+15550001111" }));
    const input = {
      caregiverId: "cg-1",
      phone: "+15550002222",
      referredName: "Maria",
      referredPhone: "+15550001111",
    };

    await expect(runMcpWriteCaraAction("create_caregiver_referral", input, execute))
      .resolves.toEqual({ success: true, invited: true, referredPhone: "+15550001111" });
    await expect(runMcpWriteCaraAction("create_caregiver_referral", input, execute))
      .resolves.toEqual({ success: true, invited: true, referredPhone: "+15550001111" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({
      actionType: "caregiver_referral_invited",
      status: "confirmed",
      toolName: "create_caregiver_referral",
    });
    expect(logAgentAction.mock.calls.at(-1)?.[0]).toMatchObject({
      actionType: "caregiver_referral_invited",
      status: "duplicate_blocked",
      toolName: "create_caregiver_referral",
    });
  });
});
