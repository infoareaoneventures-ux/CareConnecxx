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
    expect(isSupportedMcpWriteAction("complete_shift")).toBe(true);
    expect(isSupportedMcpWriteAction("start_shift")).toBe(true);
    // create_caregiver_referral was removed 2026-10-11 (caregiver sweep A1).
    expect(isSupportedMcpWriteAction("create_caregiver_referral")).toBe(false);
    expect(isSupportedMcpWriteAction("get_shifts")).toBe(false);
  });

  it("validates required fields before executing legacy MCP logic", async () => {
    await expect(runMcpWriteCaraAction(
      "complete_shift",
      { shiftId: "sh1" },
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

    const execute = vi.fn(async () => ({ success: true, shiftId: "sh-1", completed: true }));
    const input = {
      caregiverId: "cg-1",
      shiftId: "sh-1",
    };

    await expect(runMcpWriteCaraAction("complete_shift", input, execute))
      .resolves.toEqual({ success: true, shiftId: "sh-1", completed: true });
    await expect(runMcpWriteCaraAction("complete_shift", input, execute))
      .resolves.toEqual({ success: true, shiftId: "sh-1", completed: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({
      actionType: "shift_completed",
      status: "confirmed",
      toolName: "complete_shift",
    });
    expect(logAgentAction.mock.calls.at(-1)?.[0]).toMatchObject({
      actionType: "shift_completed",
      status: "duplicate_blocked",
      toolName: "complete_shift",
    });
  });
});
