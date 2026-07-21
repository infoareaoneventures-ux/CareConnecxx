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
    expect(isSupportedMcpWriteAction("create_support_ticket")).toBe(true);
    expect(isSupportedMcpWriteAction("complete_shift")).toBe(true);
    expect(isSupportedMcpWriteAction("get_shifts")).toBe(false);
  });

  it("validates required fields before executing legacy MCP logic", async () => {
    await expect(runMcpWriteCaraAction(
      "create_support_ticket",
      { userId: "u1", userType: "client", subject: "Billing" },
      async () => ({ success: true, ticketId: "t1" }),
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

    const execute = vi.fn(async () => ({ success: true, added: true, phone: "+15550001111" }));
    const input = {
      clientId: "client-1",
      seniorId: "senior-1",
      name: "Maria",
      memberPhone: "+15550001111",
    };

    await expect(runMcpWriteCaraAction("add_family_member", input, execute))
      .resolves.toEqual({ success: true, added: true, phone: "+15550001111" });
    await expect(runMcpWriteCaraAction("add_family_member", input, execute))
      .resolves.toEqual({ success: true, added: true, phone: "+15550001111" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({
      actionType: "family_member_add",
      status: "confirmed",
      toolName: "add_family_member",
    });
    expect(logAgentAction.mock.calls.at(-1)?.[0]).toMatchObject({
      actionType: "family_member_add",
      status: "duplicate_blocked",
      toolName: "add_family_member",
    });
  });
});
